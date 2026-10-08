import express from 'express';
import OpenAI from 'openai';
import { z } from 'zod';
import { requireAuth } from '../middleware/requireAuth.js';
import { rateLimitMiddleware } from '../middleware/rateLimit.js';
import { logger } from '../lib/logger.js';
import { AppError } from '../lib/errors.js';
import { config } from '../config/env.js';

const router = express.Router();

// OpenAI client singleton
const openai = new OpenAI({
  apiKey: config.OPENAI_API_KEY
});

// ==========================================
// 1. INPUT VALIDATION SCHEMA (ZOD)
// ==========================================
const MessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.string().min(1, 'Message content cannot be empty')
});

const ChatRequestSchema = z.object({
  model: z.string().default('gpt-4o-mini'),
  messages: z.array(MessageSchema).min(1, 'At least one message is required'),
  temperature: z.number().min(0).max(2).optional().default(0.7),
  max_tokens: z.number().int().positive().max(4096).optional()
});

// ==========================================
// 2. HELPER: SSE HEADER INITIALIZATION
// ==========================================
/**
 * Configures HTTP headers required for persistent, unbuffered Server-Sent Events (SSE).
 */
function initSSE(res: express.Response): void {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  // Critical for Nginx / Cloudflare reverse proxies to not buffer SSE streams
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
}

// ==========================================
// 3. STREAMING CHAT ROUTE
// ==========================================
/**
 * POST /api/ai/chat
 * 1. Authenticate user via JWT (requireAuth)
 * 2. Enforce tier-based rate limiting (rateLimitMiddleware: 10/min free, 100/min pro)
 * 3. Validate request body with Zod
 * 4. Open SSE stream and stream LLM completions token-by-token
 * 5. Handle client disconnects via AbortController to save token costs
 * 6. Record structured pipeline checkpoint metrics in Winston
 */
router.post('/chat', requireAuth, rateLimitMiddleware, async (req, res, next) => {
  const parseResult = ChatRequestSchema.safeParse(req.body);
  if (!parseResult.success) {
    const errorDetails = parseResult.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ');
    return next(new AppError(errorDetails, 400, 'VALIDATION_ERROR'));
  }

  const { model, messages, temperature, max_tokens } = parseResult.data;

  // Correlation-tagged child logger for this request lifecycle
  const log = logger.child({
    correlationId: req.correlationId,
    userId: req.user?._id?.toString(),
    userTier: req.user?.tier
  });

  // Setup abort controller to terminate upstream LLM generation if client disconnects
  const abortController = new AbortController();
  req.on('close', () => {
    if (!res.writableEnded) {
      log.warn('Client disconnected early. Aborting upstream LLM request.');
      abortController.abort();
    }
  });

  // Initialize SSE connection
  initSSE(res);

  const startMs = Date.now();
  let totalChunks = 0;
  let accumulatedOutput = '';

  try {
    log.info('Initiating LLM completion stream', {
      stage: 'llm_start',
      model,
      messageCount: messages.length
    });

    const stream = await openai.chat.completions.create(
      {
        model,
        messages,
        temperature,
        max_tokens,
        stream: true
      },
      {
        signal: abortController.signal
      }
    );

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) {
        totalChunks++;
        accumulatedOutput += delta;

        // Emit typed SSE chunk immediately
        res.write(`event: chunk\ndata: ${JSON.stringify({ text: delta })}\n\n`);
      }
    }

    const latencyMs = Date.now() - startMs;

    // Log structured pipeline stage checkpoint (matches M4 specification)
    log.info('Pipeline stage: llm_call', {
      stage: 'llm_call',
      model,
      totalTokens: totalChunks,
      outputLength: accumulatedOutput.length,
      latencyMs
    });

    // Send final typed completion event before closing stream
    if (!res.writableEnded) {
      res.write(
        `event: done\ndata: ${JSON.stringify({
          model,
          totalChunks,
          latencyMs,
          finishReason: 'stop'
        })}\n\n`
      );
    }
  } catch (err: any) {
    const isAborted = err.name === 'AbortError' || abortController.signal.aborted;

    if (isAborted) {
      log.info('Upstream LLM stream aborted due to client disconnect', {
        stage: 'llm_aborted',
        durationMs: Date.now() - startMs
      });
    } else {
      log.error('Error during LLM streaming generation', {
        stage: 'llm_error',
        error: err.message,
        stack: err.stack
      });

      // Send structured error event to client over SSE if stream is still open
      if (!res.writableEnded) {
        res.write(
          `event: stream_error\ndata: ${JSON.stringify({
            message: err.message || 'LLM generation failed',
            code: 'STREAM_ERROR'
          })}\n\n`
        );
      }
    }
  } finally {
    if (!res.writableEnded) {
      res.end();
    }
  }
});

export default router;
