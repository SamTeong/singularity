import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const localCargo = join(homedir(), '.cargo', 'bin', process.platform === 'win32' ? 'cargo.exe' : 'cargo');
const cargo = process.platform === 'win32' && existsSync(localCargo) ? localCargo : 'cargo';
const result = spawnSync(cargo, ['build', '--release', '--manifest-path', 'rust/backend/Cargo.toml'], {
  cwd: root,
  stdio: 'inherit',
  windowsHide: true,
});

if (result.error?.code === 'ENOENT') {
  console.error('Rust is required to run the migrated wiki graph backend. Install rustup with the stable MSVC toolchain and ensure cargo is available, then run: cargo build --release --manifest-path rust/backend/Cargo.toml');
  process.exit(1);
}
if (result.error) throw result.error;
process.exit(result.status ?? 1);
