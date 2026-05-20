module.exports = {
  apps: [
    {
      name: 'webapp',
      script: 'npx',
      // D1バインディングは wrangler.jsonc から読み込まれるため --d1 は指定しない
      // (CLIの --d1 を指定すると wrangler.jsonc の database_name を上書きしてしまい、
      //  ローカルDBが分裂してテーブル無しの空DBを参照する問題が起きるため)
      args: 'wrangler pages dev dist --local --ip 0.0.0.0 --port 3000',
      cwd: '/home/user/webapp',
      env: {
        NODE_ENV: 'development',
        PORT: 3000,
      },
      watch: false,
      instances: 1,
      exec_mode: 'fork',
    },
  ],
}
