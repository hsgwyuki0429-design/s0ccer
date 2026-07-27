import { spawn } from 'node:child_process';

/**
 * サーバーとクライアントを同時に起動する。
 * 依存を増やさないために concurrently 等は使わない。
 */

const procs = [
  { name: 'server', args: ['run', 'dev', '-w', '@s0ccer/server'] },
  { name: 'client', args: ['run', 'dev', '-w', '@s0ccer/client'] },
].map(({ name, args }) => {
  const child = spawn('npm', args, { stdio: 'inherit', shell: process.platform === 'win32' });
  child.on('exit', (code) => {
    console.log(`[${name}] exited with ${code}`);
    shutdown();
  });
  return child;
});

let closing = false;
function shutdown() {
  if (closing) return;
  closing = true;
  for (const p of procs) p.kill('SIGTERM');
  process.exitCode = 0;
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
