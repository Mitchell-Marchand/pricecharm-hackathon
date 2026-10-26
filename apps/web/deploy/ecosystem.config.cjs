const path = require('node:path');

module.exports = {
  apps: [
    {
      name: 'quotient-web',
      cwd: path.resolve(__dirname, '..'),
      script: '.next/standalone/apps/web/server.js',
      instances: 1,
      exec_mode: 'fork',
      env: { NODE_ENV: 'production', PORT: '3100', HOSTNAME: '127.0.0.1' },
      max_memory_restart: '700M',
      kill_timeout: 40000,
      restart_delay: 2000,
      time: true,
      merge_logs: true,
    },
  ],
};
