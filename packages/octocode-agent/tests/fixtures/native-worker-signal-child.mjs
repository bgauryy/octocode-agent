process.stdout.write(`${JSON.stringify({ type: 'ready', pid: process.pid })}\n`);
process.on('SIGTERM', () => {
  process.stdout.write(`${JSON.stringify({ type: 'term-ignored' })}\n`);
});
process.stdin.resume();
