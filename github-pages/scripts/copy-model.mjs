// Copies the scanned-atrium GLB into public/ so Vite can serve it as a
// static asset. The .glb (~11.5 MB) is gitignored in this app — the single
// copy tracked in git lives at docs/one-shot/3d/scan-atrium.glb, and this
// script produces a working copy on demand for `pnpm dev` / `pnpm build`.
import { copyFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = join(__dirname, '..', '..', 'docs', 'one-shot', '3d', 'scan-atrium.glb');
const destDir = join(__dirname, '..', 'public');
const dest = join(destDir, 'scan-atrium.glb');

if (!existsSync(src)) {
  console.error(`copy-model: source model not found at ${src}`);
  process.exit(1);
}

const srcSize = statSync(src).size;

if (existsSync(dest) && statSync(dest).size === srcSize) {
  console.log(`copy-model: skipped — ${dest} already matches source (${srcSize} bytes)`);
  process.exit(0);
}

mkdirSync(destDir, { recursive: true });
copyFileSync(src, dest);
console.log(`copy-model: copied ${src} -> ${dest} (${srcSize} bytes)`);
