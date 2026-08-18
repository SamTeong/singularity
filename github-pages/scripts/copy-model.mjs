// Copies the deck's heavy static assets into public/ so Vite can serve them.
// Both payloads are gitignored in this app — the single copy of each tracked
// in git lives under docs/one-shot/, and this script produces working copies
// on demand for `pnpm dev` / `pnpm build`.
//
//   scan-atrium.glb  (~11.5 MB)  docs/one-shot/3d/          -> public/
//   refs/            (~3.0 MB)   docs/one-shot/slides/refs/ -> public/refs/
//
// refs/ is what the PIPELINE chapter's gallery and lightbox actually open:
// ffmpeg stills off the Evangelion reference clips, Playwright screenshots of
// every experiment/layout page, the three reference clips themselves, and the
// real HTML of every artefact. Without it that chapter renders empty tiles.
import { copyFileSync, cpSync, mkdirSync, existsSync, statSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..');
const destDir = join(__dirname, '..', 'public');

let failed = false;

// ---- the scan ------------------------------------------------------------
const modelSrc = join(repoRoot, 'docs', 'one-shot', '3d', 'scan-atrium.glb');
const modelDest = join(destDir, 'scan-atrium.glb');

if (!existsSync(modelSrc)) {
  console.error(`copy-model: source model not found at ${modelSrc}`);
  failed = true;
} else {
  const srcSize = statSync(modelSrc).size;
  if (existsSync(modelDest) && statSync(modelDest).size === srcSize) {
    console.log(`copy-model: skipped — ${modelDest} already matches source (${srcSize} bytes)`);
  } else {
    mkdirSync(destDir, { recursive: true });
    copyFileSync(modelSrc, modelDest);
    console.log(`copy-model: copied ${modelSrc} -> ${modelDest} (${srcSize} bytes)`);
  }
}

// ---- the pipeline artefacts ---------------------------------------------
// Missing refs/ is NOT fatal: the chapter degrades to captioned placeholder
// tiles (see Pipeline.tsx), so a checkout without the assets still builds and
// still tours. A missing model, by contrast, is the whole world.
const refsSrc = join(repoRoot, 'docs', 'one-shot', 'slides', 'refs');
const refsDest = join(destDir, 'refs');

const countFiles = (dir) =>
  readdirSync(dir, { withFileTypes: true }).reduce(
    (n, e) => n + (e.isDirectory() ? countFiles(join(dir, e.name)) : 1),
    0,
  );

if (!existsSync(refsSrc)) {
  console.warn(`copy-model: refs not found at ${refsSrc} — pipeline gallery will show placeholders`);
} else if (existsSync(refsDest) && countFiles(refsDest) === countFiles(refsSrc)) {
  console.log(`copy-model: skipped — ${refsDest} already has ${countFiles(refsSrc)} files`);
} else {
  mkdirSync(destDir, { recursive: true });
  cpSync(refsSrc, refsDest, { recursive: true });
  console.log(`copy-model: copied ${refsSrc} -> ${refsDest} (${countFiles(refsSrc)} files)`);
}

if (failed) process.exit(1);
