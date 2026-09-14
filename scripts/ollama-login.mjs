// Thin terminal entrypoint for the daemon's shared interactive connection flow.
import { connectOllamaUsage, OLLAMA_PROFILE_DIR } from '../server/usage.mjs';

console.log(`\nProfile: ${OLLAMA_PROFILE_DIR}`);
console.log('Sign in to Ollama in the Edge window, then press Enter here…\n');
const result = await connectOllamaUsage({
  waitForUser: () => new Promise((resolve) => process.stdin.once('data', resolve)),
});
console.log(result.ok
  ? '\n✓ Ollama usage verified and browser mode saved.'
  : `\n⚠ Ollama usage was not verified (${result.error}).`);
process.exit(result.ok ? 0 : 1);
