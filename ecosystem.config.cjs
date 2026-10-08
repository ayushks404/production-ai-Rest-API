/**
 * PM2 Ecosystem Configuration for Production AI Backend
 * 
 * Key Engineering Decisions:
 * 1. exec_mode: 'cluster' + instances: 'max'
 *    - Node.js is single-threaded. By running in cluster mode with 'max', PM2 spawns
 *      a worker process on EVERY CPU core, sharing the single listening port (3000)
 *      via OS-level kernel TCP connection sharing (SO_REUSEPORT) or internal round-robin.
 * 
 * 2. kill_timeout: 30000 (30 seconds)
 *    - When executing `pm2 reload` (zero-downtime rolling update), PM2 sends SIGTERM.
 *      Because AI endpoints stream tokens over SSE for long durations (up to 15-25 seconds),
 *      a short 1-2s kill timeout would abruptly cut off active client streams.
 *      30 seconds gives active generations sufficient time to complete gracefully.
 * 
 * 3. max_memory_restart: '500M'
 *    - Protects the host server against heap memory leaks in external libraries or
 *      unmanaged buffers by restarting workers before causing OS-wide OOM panics.
 */

module.exports = {
  apps: [
    {
      name: 'ai-backend',
      script: './dist/server.js',
      instances: 'max',
      exec_mode: 'cluster',
      kill_timeout: 30000,
      max_memory_restart: '500M',
      watch: false,
      autorestart: true,
      env: {
        NODE_ENV: 'development'
      },
      env_production: {
        NODE_ENV: 'production'
      }
    }
  ]
};
