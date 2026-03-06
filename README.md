# TrapChat

Anonymous. Ephemeral. Encrypted.

A zero-knowledge chat platform where messages exist only while you're in the room. Built with end-to-end encryption so the server never sees plaintext — it just forwards opaque blobs between peers.

## How It Works

1. **Create a room** — type a name and join. A random AES-256-GCM key is generated in your browser.
2. **Share the link** — the encryption key lives in the URL fragment (`#room/key`), which is never sent to the server.
3. **Chat** — messages are encrypted client-side before leaving your browser, and decrypted by peers who have the key.
4. **Leave** — messages are gone. There is no history, no database, no persistence.

If someone joins by typing the room name directly (without the share link), they get a different key and see `[encrypted message — key mismatch]` instead of plaintext.

## Architecture

```
Browser (:3000)           Gateway (:8080)         Relay (:9000)          Worker (:9100)
React + WebCrypto    ──▶  Go / gorilla/ws    ──▶  Rust / Tokio     ──▶  Node.js
AES-256-GCM encrypt       Room routing            Message fan-out        Background jobs
URL fragment keys          Peer tracking           Binary frames          Job queue
                           In-memory store         Health :9001
```

| Service | Language | Port | Role |
|---------|----------|------|------|
| **Frontend** | React 19 / Vite | 3000 | UI, encryption, WebSocket client |
| **Gateway** | Go | 8080 | WebSocket upgrade, room routing, peer management |
| **Relay** | Rust | 9000 | High-performance message distribution (Tokio async) |
| **Worker** | Node.js | 9100 | Background job processing (FIFO queue) |

See [`docs/Architecture.md`](docs/Architecture.md) for the full technical breakdown.

## Quick Start

### Prerequisites

- **Go** 1.26+
- **Rust** (2021 edition)
- **Node.js** 18+
- **npm**

### Install

```bash
npm run install:all
```

### Development

Start all services concurrently:

```bash
npm run dev
```

Or run individually:

```bash
npm run dev:gateway     # Go gateway on :8080
npm run dev:relay       # Rust relay on :9000
npm run dev:frontend    # Vite dev server on :3000
npm run dev:worker      # Node.js worker on :9100
```

### Build

```bash
npm run build
```

Outputs:
- `target/gateway` — Go binary
- `target/release/trapchat-relay` — Rust binary
- `apps/trapchat/dist/` — Static frontend bundle

### Health Check

```bash
npm run health
```

Checks gateway (:8080), relay (:9001), and worker (:9100) health endpoints.

## Encryption Model

- **Algorithm:** AES-256-GCM (authenticated encryption)
- **Key generation:** `crypto.subtle.generateKey()` — 256-bit random key per room
- **IV:** 12 random bytes per message
- **Wire format:** `base64(IV[12] || ciphertext)`
- **Key sharing:** URL fragment (`#room/base64key`) — never sent to the server
- **Zero-knowledge:** Gateway and relay forward opaque base64 blobs. They cannot decrypt messages.

## Project Structure

```
trapchat/
├── apps/trapchat/src/         # React frontend
│   ├── App.jsx                # Main component (join/chat views)
│   ├── lib/crypto.js          # WebCrypto AES-256-GCM wrapper
│   └── socket/client.js       # WebSocket client with reconnect
├── services/
│   ├── gateway/               # Go WebSocket gateway
│   ├── relay/                 # Rust message relay
│   └── worker/                # Node.js background worker
├── pkgs/
│   ├── go/                    # Shared Go packages (crypto, protocol, storage)
│   └── rust/                  # Shared Rust crates (io frames, protocol types)
├── docs/Architecture.md       # Detailed architecture docs
├── go.work                    # Go workspace
├── Cargo.toml                 # Rust workspace
└── package.json               # Root scripts (dev, build, health)
```

## Design Principles

- **Minimal dependencies** — each service uses as few external deps as possible
- **End-to-end encryption** — the server is untrusted by design
- **Ephemeral by default** — no message persistence, no user accounts
- **Built to scale** — async Rust relay, Go gateway with room-aware routing, worker queue for background tasks
- **Extensible** — designed to support images, video, files, and canvas sharing over the encrypted channel
