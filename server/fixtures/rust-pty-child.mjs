import process from 'node:process';

if (process.argv.includes('--slow')) {
  setTimeout(() => process.stdout.write('SLOW_DONE'), 750);
} else if (process.argv.includes('--final-split')) {
  process.stdout.write(Buffer.from([0xe2]), () => {
    process.stdout.write(Buffer.from([0x82, 0xac]), () => process.exit(23));
  });
} else
if (process.argv.includes('--no-read')) {
  process.stdout.write('READY\n');
  setInterval(() => {}, 1000);
} else {
  process.stdout.write(`READY:${process.cwd()}:${process.env.PTY_TEST_ENV ?? ''}\n`);
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (data) => process.stdout.write(`GOT:${data}`));
}
