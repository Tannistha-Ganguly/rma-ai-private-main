// PM2 process config for rma-ai on EC2 + Plesk.
//
// Production secrets live in /etc/rma-ai/env (mode 0600, ubuntu-owned).
// PM2 6.x's `env_file` directive is NOT actually loaded — so the contract is:
//   1. scripts/deploy.sh sources /etc/rma-ai/env into the shell.
//   2. PM2 evaluates this file, reads from process.env, and passes each
//      secret through into the spawned Node process's env.
// Adding a new secret? Add it to /etc/rma-ai/env AND list it below.

const passthrough = (name) => {
  const v = process.env[name];
  return v === undefined ? undefined : v;
};

const sharedDbEnv = {
  ANTHROPIC_API_KEY: passthrough("ANTHROPIC_API_KEY"),
  RMA_DB_HOST: passthrough("RMA_DB_HOST"),
  RMA_DB_USER: passthrough("RMA_DB_USER"),
  RMA_DB_PASS: passthrough("RMA_DB_PASS"),
  RMA_DB_NAME: passthrough("RMA_DB_NAME"),
  RMA_AI_DB_HOST: passthrough("RMA_AI_DB_HOST"),
  RMA_AI_DB_USER: passthrough("RMA_AI_DB_USER"),
  RMA_AI_DB_PASS: passthrough("RMA_AI_DB_PASS"),
  RMA_AI_DB_NAME: passthrough("RMA_AI_DB_NAME"),
};

module.exports = {
  apps: [
    {
      name: "rma-ai",
      cwd: "/opt/rma-ai",
      script: ".next/standalone/server.js",
      interpreter: "/opt/plesk/node/22/bin/node",
      env: {
        ...sharedDbEnv,
        NODE_ENV: "production",
        PORT: 3011,
        HOSTNAME: "127.0.0.1",
        ADMIN_PASSWORD: passthrough("ADMIN_PASSWORD"),
      },
      autorestart: true,
      max_restarts: 10,
      min_uptime: "10s",
      max_memory_restart: "400M",
      out_file: "/var/log/rma-ai/out.log",
      error_file: "/var/log/rma-ai/err.log",
      merge_logs: true,
      time: true,
    },
    // Forward-mode shadow batches are advanced by this PM2 cron app. Every 5
    // minutes PM2 spawns the worker, it processes up to PER_TICK_CAP new ads
    // for the active forward batch (if any), then exits. autorestart:false
    // + cron_restart is the PM2 idiom for a scheduled one-shot task.
    {
      name: "rma-ai-shadow-cron",
      cwd: "/opt/rma-ai",
      // npx resolves tsx from the project's node_modules. deploy.sh runs
      // `npm ci --include=dev` so tsx is present in production.
      script: "npx",
      args: "tsx scripts/shadow_worker.ts",
      interpreter: "none", // exec npx directly, not via node
      env: {
        ...sharedDbEnv,
        NODE_ENV: "production",
        PATH: "/opt/plesk/node/22/bin:/usr/local/bin:/usr/bin:/bin",
      },
      cron_restart: "*/5 * * * *",
      autorestart: false,
      out_file: "/var/log/rma-ai/shadow-cron-out.log",
      error_file: "/var/log/rma-ai/shadow-cron-err.log",
      merge_logs: true,
      time: true,
    },
    {
      name: "rma-ai-daily-pending",
      cwd: "/opt/rma-ai",
      script: "npx",
      args: "tsx scripts/daily_pending_update.ts",
      interpreter: "none",
      env: {
        ...sharedDbEnv,
        NODE_ENV: "production",
        PATH: "/opt/plesk/node/22/bin:/usr/local/bin:/usr/bin:/bin",
      },
      cron_restart: "0 2 * * *", // Run at 2:00 AM every day
      autorestart: false,
      out_file: "/var/log/rma-ai/daily-pending-out.log",
      error_file: "/var/log/rma-ai/daily-pending-err.log",
      merge_logs: true,
      time: true,
    },
  ],
};
