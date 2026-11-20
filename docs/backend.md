# Backend runtime and Rust migration

The default daemon serves HTTP and WebSockets through Rust/Axum. Fastify is
available through the explicit Node startup commands.

## Requirements and startup

Install Node and the pnpm version declared in `package.json`, Git, and stable
Rust with Cargo. Windows builds also require Visual Studio C++ Build Tools
with the MSVC toolchain. `pnpm bootstrap` generates machine-specific `.env`
settings; see [`.env.example`](../.env.example) for the available settings.

| Command | Runtime |
| --- | --- |
| `pnpm start` | Builds `web/dist` and Rust, then starts Axum |
| `pnpm dev` | Builds Rust, starts Axum, then starts Vite with HTTP and WebSocket proxies |
| `pnpm server` | Builds Rust and starts Axum using the existing `web/dist` |
| `pnpm start:rust` | Alias for `pnpm start` |
| `pnpm start:node` | Builds `web/dist` and Rust, then starts Fastify |
| `pnpm server:node` | Builds Rust and starts Fastify using the existing `web/dist` |
| `node scripts/build-rust-backend.mjs` | Builds the release Rust binary without starting a daemon |

Both hosts require `SINGULARITY_HOME`, `DAEMON_PORT` and an absolute
`CLAUDE_BIN`. Run the package commands from the checkout so the daemon can
read `.env` and serve `web/dist`. Both bind to loopback and support optional
`SING_TOKEN`. Set `VITE_PORT` to configure the dev-server port. Use absolute
paths in `.env`.

`SINGULARITY_HOME/state` holds durable state, and `cache` holds disposable data.
Tickets, reports and task worktrees live under the trusted root, which defaults
to the checkout and can be overridden with `SING_TRUSTED_ROOT`. These directories
are runtime data and must not be swept as arbitrary temporary files.

## Ownership and process boundaries

In Fastify mode, `server/index.mjs` hosts Fastify, WebSockets, routes,
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
shell delivery, lifecycle, PTYs and state services.

The default executable is `rust/backend/target/release/singularity-backend`
(`.exe` on Windows). When `CARGO_TARGET_DIR` is set, both hosts resolve the
binary under `<CARGO_TARGET_DIR>/release/`; a relative value is resolved against
the checkout, matching the build helper's working directory.
The Fastify request bridge supports `SINGULARITY_RUST_BACKEND_BINARY`.
Native test tools use `SINGULARITY_NATIVE_BIN`.

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
