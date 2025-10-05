const { spawn } = require('node:child_process');

const port = process.env.PORT || '3000';
const nextBin = require.resolve('next/dist/bin/next');

const child = spawn(process.argv0, [nextBin, 'start', '--hostname', '0.0.0.0', '--port', port], {
  stdio: 'inherit',
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
  } else {
    process.exit(code ?? 0);
  }
});

child.on('error', (error) => {
  console.error('Failed to launch Next.js:', error);
  process.exit(1);
});