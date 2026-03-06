# TrapChat — Developer Guide

## Prerequisites

| Tool | Minimum Version | Check |
|------|----------------|-------|
| Go | 1.26+ | `go version` |
| Rust / Cargo | 1.90+ | `rustc --version && cargo --version` |
| Node.js | 20+ | `node --version` |
| npm | (bundled with Node) | `npm --version` |

## Setup

```bash
# Clone the repository
git clone <repo-url> trapchat
cd trapchat

# Install dependencies and build all services
bin/install.sh
```

`bin/install.sh` performs the following:
1. Checks that `go`, `cargo`, `node`, and `npm` are installed
2. Runs `npm install` at the root (installs `concurrently`)
3. Runs `npm install` in `apps/trapchat/` (installs React, Vite)
4. Runs `cargo build` (builds Rust workspace: relay + shared crates)
5. Runs `go build ./cmd/gateway` in `services/gateway/` (builds Go binary)

## Running

### All Services (Recommended)

```bash
# Using the helper script
bin/trapchat.sh

# Or using npm (runs concurrently)
npm run dev
```

Both start all four services:

| Service | URL | Color (npm run dev) |
|---------|-----|---------------------|
| Gateway | http://localhost:8080 | Blue |
| Relay | ws://localhost:9000 | Red |
| Worker | http://localhost:9100 | Yellow |
| Frontend | http://localhost:3000 | Green |

Open http://localhost:3000 in your browser.

### Individual Services

```bash
npm run dev:gateway     # Go gateway on :8080
npm run dev:relay       # Rust relay on :9000 (health on :9001)
npm run dev:worker      # Node worker on :9100
npm run dev:frontend    # Vite dev server on :3000
```

Or run directly:

```bash
cd services/gateway && go run ./cmd/gateway
cd services/relay && cargo run               # (from repo root works too)
node services/worker/src/index.js
cd apps/trapchat && npx vite --port 3000
```

## Building

```bash
npm run build             # Build all (relay release, gateway binary, frontend dist)
npm run build:relay       # cargo build --release -p trapchat-relay
npm run build:gateway     # go build -o ../../target/gateway ./cmd/gateway
npm run build:frontend    # Vite production build to apps/trapchat/dist/
```

Build artifacts:
- Relay binary: `target/release/trapchat-relay`
- Gateway binary: `target/gateway`
- Frontend: `apps/trapchat/dist/`

## Health Checks

```bash
npm run health

# Or manually:
curl http://localhost:8080/health    # {"status":"ok","service":"gateway"}
curl http://localhost:9001/health    # {"status":"ok","service":"relay"}
curl http://localhost:9100/health    # {"status":"ok","service":"worker","queued":0}
```

## Environment Variables

Copy `.env.example` to `.env` and modify as needed:

| Variable | Default | Service | Description |
|----------|---------|---------|-------------|
| `GATEWAY_PORT` | `8080` | Gateway | HTTP listen port |
| `CORS_ORIGINS` | `http://localhost:3000` | Gateway | Allowed CORS origins (not yet enforced) |
| `RELAY_ADDR` | `0.0.0.0:9000` | Relay | WebSocket listen address |
| `RELAY_HEALTH_ADDR` | `0.0.0.0:9001` | Relay | Health endpoint listen address |
| `RUST_LOG` | `info` | Relay | Tracing filter (`debug`, `info`, `warn`, `error`) |
| `WORKER_PORT` | `9100` | Worker | HTTP listen port |
| `VITE_WS_URL` | `ws://localhost:8080/ws` | Frontend | WebSocket URL (auto-detected in dev) |
| `KEY_ROTATION_INTERVAL` | `3600` | Crypto | Key rotation interval in seconds (not yet implemented) |

## Project Structure

```
trapchat/
├── apps/
│   └── trapchat/                    # React 19 frontend
│       ├── src/
│       │   ├── App.jsx              # Main component (JoinRoom + ChatRoom views)
│       │   ├── main.jsx             # React DOM entry point
│       │   ├── lib/crypto.js        # AES-256-GCM encrypt/decrypt/key management
│       │   └── socket/client.js     # TrapChatClient WebSocket class
│       ├── vite.config.js           # Vite config with proxy to gateway
│       └── package.json
├── bin/
│   ├── install.sh                   # Prerequisites check + full build
│   ├── trapchat.sh                  # Start all services
│   └── uninstall.sh                 # Stop services + clean artifacts
├── docs/                            # Documentation
├── extensions/                      # Extension modules
├── pkgs/
│   ├── go/                          # Shared Go packages
│   │   ├── main.go                  # Package root (crypto, protocol, storage)
│   │   └── go.mod
│   └── rust/
│       ├── io/                      # trapchat-io: Frame protocol + IoError
│       │   └── src/{lib,frame,error}.rs
│       └── protocol/                # trapchat-protocol: Message, MessageType, RoomEvent
│           └── src/{lib,message,room}.rs
├── services/
│   ├── gateway/                     # Go HTTP/WebSocket gateway
│   │   ├── cmd/gateway/main.go      # Entry point, routes, WebSocket handler
│   │   └── go.mod
│   ├── relay/                       # Rust async relay
│   │   ├── src/main.rs              # Tokio server, WebSocket handler, health
│   │   └── Cargo.toml
│   └── worker/                      # Node.js job queue
│       ├── src/
│       │   ├── index.js             # HTTP server
│       │   ├── queue.js             # FIFO Queue class
│       │   ├── manager.js           # WorkerManager (poll loop)
│       │   └── worker.js            # processJob (job type dispatch)
│       └── package.json
├── Cargo.toml                       # Rust workspace (relay, io, protocol)
├── go.work                          # Go workspace (gateway, pkgs/go)
├── package.json                     # Root npm scripts
└── .env.example                     # Environment variable reference
```

## Workspace Configurations

### Rust (`Cargo.toml`)

The root `Cargo.toml` defines a workspace with three members:
- `services/relay`
- `pkgs/rust/io`
- `pkgs/rust/protocol`

All members share workspace-level dependencies (`tokio`, `serde`, `uuid`, etc.) and use edition 2021.

### Go (`go.work`)

The `go.work` file links:
- `./services/gateway`
- `./pkgs/go`

The gateway's `go.mod` uses a `replace` directive to reference `trapchat/pkgs` locally.

### npm (`package.json`)

The root `package.json` holds npm scripts for the full project lifecycle. The frontend has its own `package.json` in `apps/trapchat/`. The worker has its own in `services/worker/`.

## Adding a New Rust Crate

1. Create the directory under `pkgs/rust/` or `services/`
2. Add a `Cargo.toml` with `[package]` metadata
3. Add the path to the `members` list in the root `Cargo.toml`
4. Use `[workspace.dependencies]` for shared deps:
   ```toml
   [dependencies]
   tokio = { workspace = true }
   serde = { workspace = true }
   ```

## Adding a New Go Package

1. Create a directory under `pkgs/go/`
2. The package is automatically available via the `trapchat/pkgs` module and `go.work`
3. Import it in the gateway (or any workspace member) as `trapchat/pkgs/<package>`

## Cleanup

```bash
npm run clean        # Removes target/, node_modules, dist
bin/uninstall.sh     # Stops running services, removes build artifacts, optionally removes node_modules
```

## Code Conventions

- **No TypeScript** — Plain JavaScript throughout (frontend and worker)
- **ES Modules** — The worker uses `"type": "module"` in its `package.json`
- **JSX** — React components use `.jsx` extensions
- **Minimal dependencies** — Prefer stdlib/built-in APIs. Justify any new dependency
- **No accounts/auth** — By design. Do not add user identity concepts
- **No server-side storage** — Messages are never persisted. The Store holds only transient room/peer state
