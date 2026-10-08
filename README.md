# Production AI REST API

[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue.svg)](https://www.typescriptlang.org/)
[![Express](https://img.shields.io/badge/Express-5.0-green.svg)](https://expressjs.com/)
[![Node.js](https://img.shields.io/badge/Node.js-20_LTS-green.svg)](https://nodejs.org/)
[![Redis](https://img.shields.io/badge/Redis-7.0-red.svg)](https://redis.io/)
[![MongoDB](https://img.shields.io/badge/MongoDB-8.0-brightgreen.svg)](https://www.mongodb.com/)
[![PM2](https://img.shields.io/badge/PM2-Cluster_Mode-purple.svg)](https://pm2.keymetrics.io/)

A production-grade Express + TypeScript REST API engineered for high-throughput AI operations. Built with asymmetric RS256 JWT authentication, atomic Redis rate limiting with bounded in-memory fallback, real-time Server-Sent Events (SSE) token streaming, structured Winston JSON logging with distributed correlation tracing, and PM2 multi-core zero-downtime cluster orchestration.

---

## 🏛️ System Architecture

```mermaid
flowchart TD
    Client["Client (Web / Mobile / API)"] --> ReverseProxy["Reverse Proxy (Nginx / Cloudflare)"]
    ReverseProxy -->|Port 3000| PM2Cluster["PM2 Cluster Master (OS Socket Sharing)"]
    
    subgraph Workers ["Multi-Core Node.js Workers (instances: max)"]
        W1["Worker 1 (Core 0)"]
        W2["Worker 2 (Core 1)"]
        W3["Worker 3 (Core 2)"]
    end
    
    PM2Cluster --> W1 & W2 & W3
    
    subgraph Pipeline ["Layered Middleware Pipeline"]
        MW1["1. correlationIdMiddleware (X-Correlation-ID)"]
        MW2["2. helmet() + cors() (Security Perimeter)"]
        MW3["3. morgan() -> Winston Stream"]
        MW4["4. requireAuth (RS256 JWT Verification)"]
        MW5["5. rateLimitMiddleware (Atomic Redis Lua)"]
        MW1 --> MW2 --> MW3 --> MW4 --> MW5
    end
    
    W1 & W2 & W3 --> Pipeline
    
    Pipeline --> Routes{"Route Selector"}
    Routes -->|/auth| AuthRoute["Auth Engine (Login / Register / Refresh)"]
    Routes -->|/api/ai/chat| AIRoute["AI SSE Streaming Pipeline"]
    Routes -->|/health/ready| HealthRoute["Readiness Probe (Promise.allSettled)"]
    
    AuthRoute -->|"Atomic getdel / setex"| RedisServer[("Redis 7: Sessions & Counters")]
    AuthRoute -->|"User Document via .lean()"| MongoDBServer[("MongoDB: User Store")]
    AIRoute -->|"Token-by-Token Stream"| OpenAICloud["OpenAI API: gpt-4o-mini"]
```

---

## ⚡ Key Engineering Decisions & Rationales

### 1. Asymmetric RS256 JWT vs Symmetric HS256
* **Decision:** We use `jose` with **RS256 asymmetric cryptography** (2048-bit RSA) pre-compiled at module boot via `importPKCS8` and `importSPKI`.
* **Rationale:**
  * *Zero-Trust Isolation:* The authentication service holds the `private.pem` (signing authority). Downstream microservices, AI inference workers, and edge gateways only receive `public.pem` (verification authority). They can cryptographically verify tokens without possessing the capability to forge tokens.
  * *Algorithm Confusion & `alg: none` Neutralization:* Verifications strictly whitelist `algorithms: ['RS256']`, mitigating historical JWT vulnerability classes (e.g., passing HMAC signatures against public keys).
  * *Module Boot Pre-Compilation:* Importing keys once with top-level await saves 5–15ms of CPU parsing overhead on every authenticated request.

---

### 2. Single-Use Refresh Token Rotation via `redis.getdel`
* **Decision:** Session refresh tokens are stored in Redis under `rt:<userId>:<refreshId>` and validated strictly via `redis.getdel`.
* **Rationale:**
  * *Atomic Read-and-Destroy:* Standard `redis.get()` followed by `redis.del()` creates a concurrency race window where rapid parallel requests (or network retries) can mint multiple valid access tokens. `GETDEL` (Redis 6.2+) executes in a single atomic Redis CPU cycle—exactly one request consumes the token; all duplicate or replay requests immediately receive `401 Unauthorized`.
  * *HttpOnly Scoped Cookies:* Refresh tokens are dispatched via `httpOnly`, `sameSite: 'strict'`, `secure`, and scoped strictly to `path: '/auth/refresh'`. The browser never transmits the refresh token when calling AI endpoints or static assets.

---

### 3. Distributed Atomic Rate Limiting with Bounded LRU Fallback
* **Decision:** Rate limit checks execute an atomic Redis Lua script combining `INCR` and conditional `EXPIRE`, backed by an in-memory `LRUCache(max: 10_000)`.
* **Rationale:**
  * *Eliminating Key Expiry Race Condition:* Naive `INCR` followed by `EXPIRE` risks leaving keys with no TTL (`TTL = -1`) if the process crashes between commands, permanently locking out users. Lua guarantees atomicity in a single cycle.
  * *OOM Prevention during Redis Outages:* In the event of a Redis outage or network partition, the server falls back to an in-memory counter bounded at `10,000` keys (~1.5MB heap). Unbounded JavaScript `Map` structures during outages cause process Out-Of-Memory (`OOM`) crashes.
  * *IP Normalization:* Strips `::ffff:` IPv6 prefixes to prevent IPv4-mapped address counter splitting.
  * *RFC Standard Headers:* Emits `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`, and `Retry-After` on all responses.

| Tier | Window | Limit | Keyed By | Target Scope |
| :--- | :--- | :--- | :--- | :--- |
| **`account_creation`** | 3600s (1 hr) | 5 requests | IP Address | `/auth/register`, `/auth/login` |
| **`api`** | 60s (1 min) | 200 requests | User ID / IP | Standard REST API Endpoints |
| **`ai_free`** | 60s (1 min) | 10 requests | User ID | Free Tier AI Streaming |
| **`ai_pro`** | 60s (1 min) | 100 requests | User ID | Pro Tier AI Streaming |

---

### 4. Real-Time AI SSE Token Streaming & AbortController
* **Decision:** Server-Sent Events (SSE) streaming over HTTP with `X-Accel-Buffering: no` and upstream request termination on client disconnect.
* **Rationale:**
  * *Defeating Reverse Proxy Buffering:* Nginx buffers HTTP responses by default until 4KB–16KB accumulates. Emitting `X-Accel-Buffering: no` instructs reverse proxies to flush chunks immediately, enabling real-time 60fps typewriter rendering in the browser.
  * *Phantom Token Cost Prevention:* If a user closes their browser or navigates away mid-stream, `req.on('close')` triggers `abortController.abort()`. This terminates the upstream HTTPS stream to OpenAI within 5ms, preventing wasted token billing on abandoned generations.
  * *Typed Wire Protocol:* Emits typed event frames (`event: chunk`, `event: done`, `event: stream_error`) so frontend parsers cleanly distinguish successful completions from network drops.

---

### 5. Multi-Core PM2 Cluster & Graceful 30s Drain
* **Decision:** Multi-core clustering (`instances: 'max'`) with `kill_timeout: 30000` and unreferenced fallback timers (`forceKillTimeout.unref()`).
* **Rationale:**
  * *Full CPU Utilization:* Spawns an isolated V8 worker process on every CPU core sharing port 3000 via OS kernel socket sharing (`SO_REUSEPORT`).
  * *In-Flight AI Stream Protection:* Zero-downtime rolling updates (`pm2 reload ai-backend --update-env`) send `SIGTERM`. Standard 1-second timeouts kill active 15–25s AI streams. A 30-second kill timeout allows in-flight streams to complete naturally while new workers take over incoming traffic.
  * *`unref()` Timer:* Allows the process to exit immediately if active connections drain in 200ms rather than hanging for 30s.

---

## 🛠️ Tech Stack

* **Runtime & Framework:** Node.js 20 LTS, Express 5.0, TypeScript 5.7
* **Authentication & Cryptography:** `jose` (RS256 asymmetric signing), `bcrypt` (12 rounds)
* **Databases & Cache:** MongoDB 8.0 (Mongoose), Redis 7.0 (`ioredis`)
* **AI Orchestration:** `openai` SDK (SSE streaming completions)
* **Validation & Security:** `zod` (runtime schema validation), `helmet`, `cors`, `cookie-parser`
* **Observability & Logging:** `winston` (NDJSON), `winston-daily-rotate-file`, `morgan`
* **Process Management:** `pm2` cluster mode

---

## 🚀 Quick Start

### 1. Prerequisites
* Node.js 20+ LTS
* Redis 7+ (`docker run -d -p 6379:6379 redis:7-alpine`)
* MongoDB 7+ (`docker run -d -p 27017:27017 mongo:7`)
* OpenAI API Key

### 2. Generate RS256 Asymmetric Key Pair
```bash
# Generate private key (PKCS#8)
openssl genrsa -out private.pem 2048

# Extract public key (SPKI)
openssl rsa -in private.pem -pubout -out public.pem
```

### 3. Environment Configuration
Create a `.env` file in the project root:

```env
NODE_ENV=development
PORT=3000
MONGODB_URL=mongodb://localhost:27017/production-ai-api
REDIS_URL=redis://localhost:6379
OPENAI_API_KEY=sk-your-openai-api-key
JWT_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"
JWT_PUBLIC_KEY="-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----"
LOG_LEVEL=debug
ALLOWED_ORIGINS=http://localhost:3000,http://localhost:3001
```

### 4. Installation & Build
```bash
# Install dependencies
npm install

# Typecheck and build TypeScript to dist/
npm run build

# Run in hot-reload development mode
npm run dev
```

---

## 🧪 Production Verification & API Reference

### Health Probes
```bash
# Liveness Check
curl.exe -i http://localhost:3000/health/live

# Readiness Check (Parallel MongoDB + Redis verification)
curl.exe -i http://localhost:3000/health/ready
```

### Authentication Lifecycle

#### 1. User Registration (`POST /auth/register`)
```bash
curl.exe -i -X POST http://localhost:3000/auth/register \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"developer@company.com\",\"password\":\"SecurePassword123!\"}" \
  -c cookies.txt
```

#### 2. User Login (`POST /auth/login`)
```bash
curl.exe -i -X POST http://localhost:3000/auth/login \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"developer@company.com\",\"password\":\"SecurePassword123!\"}" \
  -c cookies.txt
```

#### 3. Single-Use Refresh Token Rotation (`POST /auth/refresh`)
```bash
curl.exe -i -X POST http://localhost:3000/auth/refresh -b cookies.txt -c cookies.txt
```

---

### Real-Time AI Chat Streaming (`POST /api/ai/chat`)

```bash
curl.exe -N -X POST http://localhost:3000/api/ai/chat \
  -H "Authorization: Bearer <YOUR_ACCESS_TOKEN>" \
  -H "Content-Type: application/json" \
  -d "{\"model\":\"gpt-4o-mini\",\"messages\":[{\"role\":\"user\",\"content\":\"Explain why Redis Lua scripts are atomic in 2 sentences.\"}]}"
```

#### Expected Server-Sent Event (SSE) Stream:
```text
HTTP/1.1 200 OK
Content-Type: text/event-stream; charset=utf-8
Cache-Control: no-cache, no-transform
X-Accel-Buffering: no
X-RateLimit-Limit: 10
X-RateLimit-Remaining: 9
X-RateLimit-Reset: 1710000060

event: chunk
data: {"text":"Redis"}

event: chunk
data: {"text":" executes"}

event: done
data: {"model":"gpt-4o-mini","totalChunks":28,"latencyMs":742,"finishReason":"stop"}
```

---

## 🚢 PM2 Multi-Core Deployment & Zero-Downtime Reload

```bash
# Build the production bundle
npm run build

# Start the cluster in production mode
pm2 start ecosystem.config.cjs --env production

# Inspect running cluster workers
pm2 status
pm2 logs ai-backend

# Zero-downtime rolling reload with updated environment variables
pm2 reload ai-backend --update-env
```

---

## 📂 Project Structure

```
production-ai-rest-api/
├── src/
│   ├── config/
│   │   └── env.ts            # Zod startup environment schema & fail-fast validation
│   ├── lib/
│   │   ├── errors.ts         # AppError operational taxonomy & V8 stack capture
│   │   ├── logger.ts         # Winston JSON logger with DailyRotateFile
│   │   ├── mongoose.ts       # Mongoose connection pool singleton
│   │   └── redis.ts          # ioredis singleton with exponential backoff & fast-fail
│   ├── middleware/
│   │   ├── correlationId.ts  # UUID request tracing & header reflection
│   │   ├── rateLimit.ts      # Multi-tier route rate limiting & RFC headers
│   │   └── requireAuth.ts    # Dual-transport RS256 token verification
│   ├── models/
│   │   └── User.ts           # Mongoose schema with select:false passwordHash
│   ├── routes/
│   │   ├── ai.ts             # POST /api/ai/chat SSE streaming with AbortController
│   │   └── auth.ts           # POST /register, /login, /refresh (redis.getdel)
│   └── server.ts             # Express bootstrap, probes, middleware & graceful drain
├── ecosystem.config.cjs      # PM2 multi-core cluster & 30s kill timeout config
├── package.json
└── tsconfig.json
```

---

## 📜 License
MIT License. Created for Production AI Engineering Systems.
