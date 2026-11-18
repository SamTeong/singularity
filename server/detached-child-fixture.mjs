import { writeFile } from 'node:fs/promises';

await new Promise((resolve) => setTimeout(resolve, 350));
await writeFile(
  process.env.SINGULARITY_DETACHED_MARKER,
  `${process.cwd()}|${process.argv[2]}|${process.env.SINGULARITY_DETACHED_VALUE}`,
);
