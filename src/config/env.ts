import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config({ path: `.env.${process.env.NODE_ENV ?? 'development'}` });
dotenv.config(); // fallback to .env if present

const EnvSchema = z.object({
  NODE_ENV:          z.enum(['development', 'staging', 'production', 'test']).default('development'),
  PORT:              z.string().default('3000').transform(Number).pipe(z.number().int().positive()),
  MONGODB_URL:       z.string().url().default('mongodb://localhost:27017/ai-backend-dev'),
  REDIS_URL:         z.string().url().default('redis://localhost:6379'),
  OPENAI_API_KEY:    z.string().default('sk-mock-key-for-dev-environment-12345'),
  ANTHROPIC_API_KEY: z.string().default('sk-ant-mock-key-for-dev-environment-12345'),
  JWT_PRIVATE_KEY:   z.string().min(50),
  JWT_PUBLIC_KEY:    z.string().min(50),
  LOG_LEVEL:         z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  ALLOWED_ORIGINS:   z.string().default('*')
});

export type Config = z.infer<typeof EnvSchema>;

export const config: Config = (() => {
  const result = EnvSchema.safeParse(process.env);
  if (!result.success) {
    console.error('Config validation failed:');
    result.error.issues.forEach(i => console.error(`  ${i.path.join('.')}: ${i.message}`));
    process.exit(1);
  }
  return result.data;
})();
