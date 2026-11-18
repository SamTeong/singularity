import { writeSync } from 'node:fs';

const mode = process.argv[2];
const write = (fd, value) => writeSync(fd, value);
if (mode === 'args-env') {
  process.stdout.write(`${process.argv.slice(3).join('|')}|${process.env.GIT_TERMINAL_PROMPT}|${process.env.GCM_INTERACTIVE}|${process.env.GIT_ASKPASS}`);
} else if (mode === 'multiline-error') {
  process.stdout.write('partial stdout');
  process.stderr.write('first error line\nsecond error line\n');
  process.exitCode = 7;
} else if (mode === 'streams') {
  const chunk = Buffer.alloc(700 * 1024, 120);
  write(1, chunk);
  write(2, chunk);
} else if (mode === 'over-stdout' || mode === 'over-stderr') {
  const fd = mode === 'over-stdout' ? 1 : 2;
  write(fd, Buffer.alloc(1024 * 1024 + 128, 120));
} else if (mode === 'wait-stdin') {
  process.stdin.on('end', () => process.stdout.write('stdin closed'));
  process.stdin.resume();
} else if (mode === 'sleep') {
  setTimeout(() => process.stdout.write('late'), 10_000);
} else {
  process.stderr.write('unknown fixture mode');
  process.exitCode = 2;
}
