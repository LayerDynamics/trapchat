# TrapChat — Overview

## What is TrapChat?

TrapChat is an anonymous, ephemeral, encrypted chat platform. There are no accounts, no message history, and no server-side storage. You pick a room name, join, and talk. The moment you leave, your messages are gone. Every message is encrypted client-side with AES-256-GCM before it ever touches the network.

## Core Principles

- **Zero-knowledge** — The server never sees plaintext messages. Encryption and decryption happen entirely in the browser using the Web Crypto API.
- **Ephemeral by default** — Messages exist only in the session memory of connected peers. There is no database, no logs, no scrollback.
- **Anonymous** — No accounts, no login, no tracking. You are identified only by your presence in a room.
- **Minimal dependencies** — Each service uses as few external libraries as possible. The Node.js worker has zero production dependencies. The Go gateway uses only `gorilla/websocket` beyond the standard library.

## Tech Stack

| Layer | Language | Role |
|-------|----------|------|
| **Gateway** | Go | HTTP server, WebSocket upgrade, room/peer routing |
| **Relay** | Rust | High-performance async WebSocket relay for message fan-out |
| **Worker** | Node.js | Background job queue for media processing and room cleanup |
| **Frontend** | React 19 | Browser UI with client-side encryption via Web Crypto API |

## How the Pieces Fit

```
 Browser (:3000)
    │
    │  HTTP + WebSocket (proxied via Vite in dev)
    ▼
 Gateway (:8080)          ──POST /jobs──▶  Worker (:9100)
    │
    │  WebSocket frames
    ▼
 Relay (:9000)
    │  health: :9001
```

- The **browser** connects to the **gateway** over WebSocket at `/ws`. API calls go to `/api/*`.
- The **gateway** manages rooms and peers. It upgrades HTTP connections to WebSocket and will forward messages to the **relay** for fan-out to all peers in a room.
- The **relay** is a Tokio-based async WebSocket server using a compact binary frame protocol (1-byte type + 4-byte length + payload).
- The **worker** runs a FIFO job queue polled every 500ms. It handles background tasks like media chunking and room cleanup.
- In development, Vite proxies `/api` and `/ws` from `:3000` to the gateway at `:8080`.

## Repository Layout

```
trapchat/
├── apps/trapchat/        # React 19 frontend (Vite)
├── bin/                  # install.sh, trapchat.sh, uninstall.sh
├── docs/                 # Project documentation (you are here)
├── extensions/           # Extension modules
├── pkgs/
│   ├── go/               # Shared Go packages: crypto, protocol, storage
│   └── rust/             # Shared Rust crates: trapchat-io, trapchat-protocol
├── services/
│   ├── gateway/          # Go HTTP/WebSocket gateway
│   ├── relay/            # Rust async WebSocket relay
│   └── worker/           # Node.js background job queue
├── Cargo.toml            # Rust workspace root
├── go.work               # Go workspace
├── package.json          # Root npm scripts + concurrently
└── .env.example          # Environment variable reference
```

## Quick Start

```bash
# 1. Install prerequisites and build everything
bin/install.sh

# 2. Start all services (gateway, relay, worker, frontend)
bin/trapchat.sh
# — or —
npm run dev

# 3. Open http://localhost:3000 in your browser
# 4. Enter a room name and start chatting
```

See [Development.md](./Development.md) for detailed setup instructions and [Architecture.md](./Architecture.md) for a deep technical dive.
