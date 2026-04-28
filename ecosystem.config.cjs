module.exports = {
  apps: [
    {
      name: 'trade-copy',
      cwd: '/home/azureuser/trade-copy',
      script: 'src/server.js',
      interpreter: 'node',
      autorestart: true,
      watch: false,
      time: true,
      exp_backoff_restart_delay: 100,
      max_restarts: 50,
      env: {
        NODE_ENV: 'production'
      }
    },
    {
      name: 'ngrok',
      cwd: '/home/azureuser/trade-copy',
      script: 'ngrok',
      args: 'http 8787',
      autorestart: true,
      watch: false,
      time: true,
      exp_backoff_restart_delay: 100,
      max_restarts: 50
    }
  ]
};
