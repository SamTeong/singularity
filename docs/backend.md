# Backend runtime and Rust migration

The default runtime combines a Node HTTP host with Rust services. A native Rust
HTTP host is also available explicitly; the default launch commands have not
switched to it.

## Requirements and startup

Install Node and the pnpm version declared in `package.json`, Git, and stable
Rust with Cargo. Windows builds also require Visual Studio C++ Build Tools
with the MSVC toolchain. `pnpm bootstrap` generates machine-specific `.env`
settings; see [`.env.example`](../.env.example) for the available settings.

| Command | Runtime |
| --- | --- |
| `pnpm start` | Builds `web/dist` and Rust, then starts the Node/Fastify daemon |
| `pnpm dev` | Builds Rust and starts the Node daemon plus the Vite dev server |
| `pnpm server` | Builds Rust and starts Node; does not build the web UI |
| `pnpm start:rust` | Builds `web/dist` and Rust, then runs `singularity-backend --http` directly |
| `node scripts/build-rust-backend.mjs` | Builds the release Rust binary without starting a daemon |

The default Node daemon requires `SINGULARITY_HOME`, `DAEMON_PORT` and an
absolute `CLAUDE_BIN`. Native HTTP requires `SINGULARITY_HOME` and
`DAEMON_PORT`; provider binaries are optional at startup, but the corresponding
agent cannot spawn without its configured executable. Both modes load `.env`,
bind only to loopback and support optional `SING_TOKEN`. `VITE_PORT` controls the
dev-server integration. Use absolute paths in `.env`; Node's env-file loader
does not expand shell variables or `~`.

`SINGULARITY_HOME/state` holds durable state, and `cache` holds disposable data.
Tickets, reports and task worktrees live under the trusted root, which defaults
to the checkout and can be overridden with `SING_TRUSTED_ROOT`. These directories
are runtime data and must not be swept as arbitrary temporary files.

## Ownership and process boundaries

In the default mode, `server/index.mjs` hosts Fastify, WebSockets, routes,
security/static-shell delivery and application orchestration. It starts two
Rust subprocesses before listening:

| Rust mode | Bridge and responsibility |
| --- | --- |
| No flag | `server/rust-backend.mjs`: long-lived JSON-line request service for migrated backend operations |
| `--pty` | `server/rust-pty-backend.mjs`: PTY spawn, input/output, resize, termination and exit events |

The shared request service is injected into transcript/stats/identity, usage,
explorer, config, one-shot execution, usage reports, process management, skills,
roots, memory reads, model storage, tasks and keys. This describes the delegated
operations, not a claim that every endpoint in each area has moved out of Node.
Use the existing Rust owner when changing migrated behavior rather than adding
a second implementation in an adapter.

Native `--http` mode runs Axum directly, with its own routes, WebSockets,
shell delivery, lifecycle, PTYs and state services. It does not put the Node
gateway in front of Rust. Runtime entrypoints establish this boundary; they do
not establish complete feature parity between the two HTTP hosts.

The executable is `rust/backend/target/release/singularity-backend` (`.exe` on
Windows). The request bridge supports `SINGULARITY_RUST_BACKEND_BINARY` for an
explicit binary override. Native test tools use `SINGULARITY_NATIVE_BIN`;
these settings apply to different launch paths.

Rust PTYs replace the default registry's earlier `node-pty` path. Windows
ConPTY DLL selection, termination and startup cursor handling have explicit
compatibility limits; see [Rust PTY compatibility](rust-pty-compatibility.md).

## Verification and troubleshooting

See [Testing](testing.md) for the Node, Rust and browser suites. For an isolated
native HTTP check after building the binary:

```sh
node scripts/build-rust-backend.mjs
node scripts/native-daemon-e2e.mjs
```

The native check uses temporary roots, an ephemeral loopback port and fake
provider executables; it does not spawn a coding agent. It checks native daemon
lifecycle and protocol behavior and is separate from `pnpm test`. The browser
suite can also target native HTTP with `E2E_BACKEND=rust`; see the
[E2E guide](../e2e/README.md#backends).

Startup fails if Cargo/build prerequisites, required settings or a Rust
subprocess handshake are unavailable. Build the backend and check the startup
error before retrying. An occupied listen port is retried briefly, then reported
as an error; choose a separate port instead of restarting another checkout's
daemon. Rust integration tests that launch Node require an absolute
`NODE_BINARY`, as shown in the testing guide.
