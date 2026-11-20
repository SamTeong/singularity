import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const localCargo = join(homedir(), '.cargo', 'bin', process.platform === 'win32' ? 'cargo.exe' : 'cargo');
const cargo = process.platform === 'win32' && existsSync(localCargo) ? localCargo : 'cargo';
const http = process.argv.includes('--http');
const args = [http ? 'run' : 'build', '--release', '--manifest-path', 'rust/backend/Cargo.toml'];
if (http) args.push('--', '--http');
const result = spawnSync(cargo, args, {
  // Repo root: server/rust-backend.mjs resolves a relative CARGO_TARGET_DIR against this cwd.
  cwd: root,
  stdio: 'inherit',
  windowsHide: true,
});

if (result.error?.code === 'ENOENT') {
  console.error('Singularity requires Cargo and stable Rust. Install Rust from https://rustup.rs with the stable toolchain, then rerun the build command (cargo build --release --manifest-path rust/backend/Cargo.toml). On Windows, install the MSVC toolchain and Visual Studio C++ Build Tools.');
  process.exit(1);
}
if (result.error) throw result.error;
process.exit(result.status ?? 1);
