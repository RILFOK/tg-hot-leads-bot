module.exports = {
  apps: [
    {
      name: "tg-hot-leads-bot",
      cwd: __dirname,
      script: "dist/index.js",
      interpreter: "node",
      node_args: "--enable-source-maps",

      exec_mode: "fork",
      instances: 1,

      autorestart: true,
      watch: false,

      max_memory_restart: "180M",
      restart_delay: 5000,
      min_uptime: "10s",
      max_restarts: 10,

      kill_timeout: 15000,
      time: true,
      merge_logs: true,

      env: {
        NODE_ENV: "production"
      },

      env_production: {
        NODE_ENV: "production"
      }
    }
  ]
};
