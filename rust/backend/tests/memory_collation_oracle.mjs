import process from 'node:process';

const names = ['Alpha', 'zeta', 'éclair', 'a', 'B', 'é', 'e', 'ä', 'ö', 'i', 'I'];
const locale = process.argv[2];
process.stdout.write(JSON.stringify([...names].sort((a, b) => a.localeCompare(b, locale))));
