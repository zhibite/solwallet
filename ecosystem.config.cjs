/**
 * PM2 进程管理配置
 * 用法：
 *   pm2 start ecosystem.config.cjs        # 启动
 *   pm2 restart solwallet                 # 重启
 *   pm2 logs solwallet                    # 查看日志
 *   pm2 save && pm2 startup               # 开机自启
 */

module.exports = {
  apps: [
    {
      name: 'solwallet',
      script: 'node_modules/next/dist/bin/next',
      args: 'start -p 3000 -H 0.0.0.0',
      cwd: __dirname,
      instances: 1,                 // 单实例（写 DB，多实例需要 sticky session）
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production',
      },
      error_file: './logs/err.log',
      out_file: './logs/out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      // 健康检查
      listen_timeout: 30000,
      kill_timeout: 10000,
    },
  ],
};
