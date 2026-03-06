# TrapChat — Architecture

## System Diagram

```
┌──────────────────────────────────────────────────────────┐
│  Browser (:3000)                                         │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────┐  │
│  │  React UI   │  │ TrapChatClient│  │ WebCrypto      │  │
│  │  App.jsx    │◄─┤ (WebSocket)  │  │ AES-256-GCM    │  │
│  └─────────────┘  └──────┬───────┘  └────────────────┘  │
└──────────────────────────┼───────────────────────────────┘
                           │ /ws (WebSocket)
                           │ /api/* (HTTP)
                           ▼
┌──────────────────────────────────────────────────────────┐
│  Gateway (:8080)  — Go                                   │
│  ┌───────────┐  ┌────────────┐  ┌──────────────────────┐│
│  │ HTTP Mux  │  │ WS Upgrader│  │ Store (sync.RWMutex) ││
│  │ /health   │  │ gorilla/ws │  │ Rooms, Peers         ││
│  │ /api/rooms│  └─────┬──────┘  └──────────────────────┘│
│  └───────────┘        │                                  │
└───────────────────────┼──────────────────────────────────┘
                        │ WebSocket frames          POST /jobs
                        ▼                           ──────────▶
┌──────────────────────────────┐  ┌────────────────────────────┐
│  Relay (:9000)  — Rust       │  │  Worker (:9100)  — Node.js │
│  ┌─────────────────────────┐ │  │  ┌──────────────────────┐  │
│  │ Tokio async runtime     │ │  │  │ FIFO Queue           │  │
│  │ tokio-tungstenite       │ │  │  │ WorkerManager (500ms) │  │
│  │ Frame protocol (binary) │ │  │  │ processJob()          │  │
│  └─────────────────────────┘ │  │  └──────────────────────┘  │
│  Health: :9001               │  │  GET /health               │
└──────────────────────────────┘  │  POST /jobs                │
                                  └────────────────────────────┘
```

---

## Gateway (Go — :8080)

**Source:** `services/gateway/cmd/gateway/main.go`

The gateway is the entry point for all client connections. It provides HTTP endpoints and upgrades WebSocket connections.

### Configuration

| Env Var | Default | Description |
|---------|---------|-------------|
| `GATEWAY_PORT` | `8080` | HTTP listen port |
| `CORS_ORIGINS` | `http://localhost:3000` | Allowed origins (declared in `.env.example`, not yet enforced in code) |

### Routes

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Returns `{"status":"ok","service":"gateway"}` |
| `GET` | `/api/rooms` | Returns `{"rooms":[...],"count":N}` from the in-memory Store |
| `GET` | `/ws` | Upgrades to WebSocket via `gorilla/websocket.Upgrader` |

### WebSocket Handling

The upgrader currently accepts all origins (`CheckOrigin` returns `true`). Once upgraded, the connection enters an echo loop — messages are read and written back to the same client. This will be replaced with room-aware routing that maps peers to rooms and forwards messages to the relay.

### In-Memory Store

The gateway uses `storage.NewStore()` from the shared `trapchat/pkgs/storage` package. The Store is protected by `sync.RWMutex` and holds room and peer state in memory. No data is persisted to disk.

---

## Relay (Rust — :9000/:9001)

**Source:** `services/relay/src/main.rs`

The relay is a high-performance async WebSocket server built on Tokio. It handles the actual message distribution between peers.

### Configuration

| Env Var | Default | Description |
|---------|---------|-------------|
| `RELAY_ADDR` | `0.0.0.0:9000` | WebSocket listen address |
| `RELAY_HEALTH_ADDR` | `0.0.0.0:9001` | Health HTTP listen address |
| `RUST_LOG` | `info` | Tracing filter level |

### Frame Protocol

The relay uses a compact binary frame protocol defined in `pkgs/rust/io`:

```
┌──────────┬───────────────────┬─────────────────────┐
│ type (1B)│ length (4B big-endian) │ payload (N bytes)  │
└──────────┴───────────────────┴─────────────────────┘
```

- **Max frame size:** 1 MB (1,048,576 bytes)
- Frame types map to `MessageType` variants: `Join`, `Leave`, `Chat`, `Media`, `Presence`, `Error`

### Connection Handling

Each incoming TCP connection is:
1. Accepted and handed to `tokio::spawn`
2. Upgraded to WebSocket via `tokio_tungstenite::accept_async`
3. Split into sink + source streams
4. Currently runs an echo loop using `Frame::new()` and `Message::new()` — will be replaced with room-based fan-out

### Health Server

A separate Tokio task binds to `:9001` and serves raw HTTP responses:
```
HTTP/1.1 200 OK
Content-Type: application/json

{"status":"ok","service":"relay"}
```

---

## Worker (Node.js — :9100)

**Source:** `services/worker/src/`

The worker is a zero-dependency Node.js HTTP server with a FIFO job queue. It handles background tasks that don't need to happen in the hot path.

### Configuration

| Env Var | Default | Description |
|---------|---------|-------------|
| `WORKER_PORT` | `9100` | HTTP listen port |

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Returns `{"status":"ok","service":"worker","queued":N}` |
| `POST` | `/jobs` | Accepts `{"type":"<string>","data":<any>}`, returns `{"id":"<uuid>"}` (201) |

### Queue (`src/queue.js`)

```
enqueue(type, data)  → uuid (job ID)
dequeue()            → {id, type, data, createdAt} | null
size()               → number
peek()               → item | null
```

Each job gets a `crypto.randomUUID()` identifier and a `Date.now()` timestamp.

### WorkerManager (`src/manager.js`)

- Polls the queue every **500ms**
- Drains all available jobs per poll cycle
- Calls `processJob(job)` for each job
- Idempotent `start()`/`stop()` lifecycle

### Job Types (`src/worker.js`)

| Type | Status | Description |
|------|--------|-------------|
| `media:chunk` | Planned | Chunk large media payloads for relay distribution |
| `room:cleanup` | Planned | Purge expired room data |

Unknown job types log a warning and are discarded.

---

## Frontend (React 19 — :3000)

**Source:** `apps/trapchat/src/`

The frontend is a Vite-powered React 19 application. It handles the UI, WebSocket communication, and all cryptographic operations.

### Vite Configuration

```js
server: {
  port: 3000,
  proxy: {
    '/api': { target: 'http://localhost:8080', changeOrigin: true },
    '/ws':  { target: 'ws://localhost:8080', ws: true },
  },
},
build: { target: 'es2022' },
```

### TrapChatClient (`src/socket/client.js`)

A WebSocket client class that manages the connection lifecycle:

- **`connect()`** — Opens WebSocket to `/ws` (auto-detects `ws://` or `wss://` from page protocol)
- **`disconnect()`** — Closes and nulls the WebSocket
- **`send(type, room, payload)`** — Sends JSON: `{type, room, payload, timestamp}`
- **`on(event, fn)`** — Subscribe to events; returns an unsubscribe function
- **`connected`** — Boolean getter (readyState === OPEN)

**Wire format:**
```json
{"type":"join|chat|leave","room":"<name>","payload":<any>,"timestamp":<ms>}
```

**Events emitted:** `open`, `close`, `error`, `message`, and dynamic events by message `type` field (e.g., `presence`, `chat`).

### Crypto Module (`src/lib/crypto.js`)

All encryption uses the **Web Crypto API** with **AES-256-GCM**.

| Function | Description |
|----------|-------------|
| `generateRoomKey()` | Creates an extractable AES-GCM CryptoKey (256-bit) |
| `encrypt(key, plaintext)` | Returns base64 string: `base64(IV[12] \|\| ciphertext)` |
| `decrypt(key, encoded)` | Decodes base64, splits IV, decrypts to plaintext string |
| `exportKey(key)` | Exports raw key bytes as base64 string |
| `importKey(base64)` | Imports base64 raw key back to CryptoKey |

**Encryption wire format:** The 12-byte IV is prepended to the ciphertext, then the whole buffer is base64-encoded for transport.

### App Component (`src/App.jsx`)

Two views controlled by state:

1. **JoinRoom** — Form with room name input. On submit:
   - If creating a room: generates a random AES-GCM key via `generateRoomKey()`, produces a shareable link with the key in the URL fragment (`#room/base64key`)
   - If joining via share link: parses the URL fragment and imports the key via `importKey()`
   - Connects WebSocket via `client.connect()`
   - Sends a `join` message with the room name
   - Transitions to chat view

2. **ChatRoom** — Header (room name, peer count, leave button), message list, input form. On send:
   - Encrypts input via `encrypt(key, text)`
   - Sends encrypted payload as a `chat` message
   - Appends own message to local list (unencrypted, for display)

**Presence:** Messages with `type: "presence"` update the peer count display.

---

## Shared Packages

### Go Packages (`pkgs/go/`)

**Module:** `trapchat/pkgs` (go 1.26.0)

| Package | Description |
|---------|-------------|
| `crypto` | Cryptographic utilities |
| `protocol` | Message and room protocol types |
| `storage` | In-memory Store with `sync.RWMutex` — used by gateway for room/peer state |

### Rust Crates (`pkgs/rust/`)

#### `trapchat-io`

Binary frame protocol for the relay:

- **`Frame`** — `{frame_type: u8, payload: Vec<u8>}` with `encode()`/`decode()` methods
- **`IoError`** — Error variants: `FrameTooLarge`, `IncompleteFrame`, `InvalidFrameType`, `Io`
- Wire format: `[type:1B][length:4B BE][payload:NB]`, max 1 MB

#### `trapchat-protocol`

Message and room types:

- **`MessageType`** — Enum: `Join`, `Leave`, `Chat`, `Media`, `Presence`, `Error` (serde snake_case)
- **`Message`** — `{id, msg_type, room, payload?, timestamp}` with UUID v4 IDs and Unix millisecond timestamps
- **`RoomEvent`** — Tagged enum: `Created`, `Joined{peer_count}`, `Left{peer_count}`, `Destroyed`

---

## Data Flow

```
1. Creator: generateRoomKey() → CryptoKey in ref → share link with key in URL fragment; Joiner: importKey() from URL fragment → CryptoKey in ref
2. client.connect() → WebSocket to /ws via gateway
3. client.send('join', room, null) → gateway receives join
4. User types message → encrypt(key, plaintext) → base64 ciphertext
5. client.send('chat', room, ciphertext) → gateway receives
6. Gateway echo (current) / relay fan-out (planned) → message reaches peers
7. Peers receive → decrypt(key, ciphertext) → plaintext displayed
```

## Encryption Model

- **Algorithm:** AES-256-GCM (authenticated encryption)
- **Key generation:** `crypto.subtle.generateKey()` — 256-bit, extractable
- **IV:** 12 random bytes per message via `crypto.getRandomValues()`
- **Wire format:** `base64(IV[12 bytes] || ciphertext[N bytes])`
- **Key transport:** Keys are generated per-room on join. Key sharing via URL fragment or QR is planned but not yet implemented.
- **Zero-knowledge:** The gateway and relay never see plaintext. They forward opaque base64 blobs.
