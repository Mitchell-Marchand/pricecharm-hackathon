const path = require('node:path');
// Inside a release this file is <app root>/releases/<id>/apps/api/deploy/.
const releaseRoot = path.resolve(__dirname, '..', '..', '..');
const cwd = path.join(releaseRoot, 'apps', 'api');
const uploadDirectory = path.resolve(releaseRoot, '..', '..', 'shared', 'uploads');
const release = path.basename(releaseRoot);

module.exports = {
  apps: [
    {
      name: 'quotient-api',
      cwd,
      script: 'dist/server.js',
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
        PORT: '4100',
        TRUST_PROXY: '1',
        APP_RELEASE: release,
        UPLOAD_DIR: uploadDirectory,
      },
      max_memory_restart: '500M',
      kill_timeout: 40000,
      restart_delay: 2000,
      time: true,
      merge_logs: true,
    },
    {
      name: 'quotient-worker',
      cwd,
      script: 'dist/worker.js',
      instances: 1,
      exec_mode: 'fork',
      env: { NODE_ENV: 'production', APP_RELEASE: release, UPLOAD_DIR: uploadDirectory },
      max_memory_restart: '300M',
      // Let an in-flight three-photo job finish before a release stops this worker.
      kill_timeout: 600000,
      restart_delay: 5000,
      time: true,
      merge_logs: true,
    },
  ],
};
