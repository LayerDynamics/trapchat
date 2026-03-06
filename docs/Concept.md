# TrapChat — Concept & Design Philosophy

## The Problem

Existing chat platforms store your data. They log your messages, track your metadata, build profiles, and sell your attention. Even "encrypted" platforms often require accounts, phone numbers, or email addresses — tying your identity to your communication. Server-side message storage means your conversations exist long after you intended them to.

## TrapChat's Answer

TrapChat is built on a simple premise: **if the server never has your data, it can never leak, sell, or be compelled to hand it over.**

- **Rooms are ephemeral.** There is no database. Messages exist only in the session memory of connected peers. When you leave a room, your messages are gone.
- **No accounts.** You don't sign up, log in, or provide any identifying information. You pick a room name and join. That's it.
- **No persistence.** The server is a relay, not a store. It forwards encrypted blobs it cannot read. Nothing is written to disk.
- **No tracking.** No analytics, no telemetry, no cookies, no fingerprinting.

## Core Tenets

### Anonymity
No authentication is required. There are no usernames, no profiles, no avatars. You are a participant count — nothing more. Anyone who knows the room name can join.

### Ephemerality
Messages exist only while you are present in the room. There is no scrollback, no history, no "catch up." If you weren't there when it was said, it doesn't exist for you. Leave the room and your local copy is discarded.

### Encryption
Every message is encrypted client-side with **AES-256-GCM** before it leaves the browser. The encryption key is generated per-room using the Web Crypto API. The server handles only opaque, base64-encoded ciphertext with a prepended nonce. It cannot decrypt anything.

### Scalability
The platform is built as polyglot microservices — each language chosen for its strengths at each layer. The relay is designed for high-throughput async I/O. The gateway handles HTTP and WebSocket lifecycle. The worker offloads background processing. This separation allows each component to scale independently.

## Why Three Languages?

TrapChat uses Go, Rust, and Node.js — not for novelty, but because each language is the best tool for its specific job:

| Service | Language | Why |
|---------|----------|-----|
| **Gateway** | Go | Fast HTTP server with excellent stdlib. `net/http` and `gorilla/websocket` handle routing and WebSocket upgrade with minimal code. Goroutines make concurrent connection handling natural. |
| **Relay** | Rust | Zero-cost async I/O via Tokio. Memory safety without garbage collection. Ideal for a high-throughput relay that must handle thousands of concurrent WebSocket streams without latency spikes. |
| **Worker** | Node.js | Rapid iteration for background job logic. The event loop is well-suited to I/O-bound task processing. Zero production dependencies keep it lean. |
| **Frontend** | React 19 | Component model for the chat UI. The Web Crypto API provides native browser encryption without any crypto library dependencies. |

## Minimal Dependency Philosophy

Each component uses as few external libraries as possible:

- **Go gateway** — Only `gorilla/websocket` beyond the standard library
- **Rust relay** — Tokio ecosystem (`tokio`, `tokio-tungstenite`, `futures-util`) plus `serde` for serialization
- **Node worker** — Zero production dependencies. Built entirely on Node.js built-ins (`node:http`, `node:crypto`)
- **React frontend** — React + Vite only. Encryption uses the native Web Crypto API, not a third-party crypto library

Fewer dependencies mean fewer supply chain risks, smaller binaries, faster builds, and less to audit.

## Room Model

1. A user enters a room name and joins
2. A room key is generated client-side (AES-256-GCM, 256-bit)
3. A WebSocket connection is established through the gateway
4. The participant counter increments
5. Messages are encrypted before send, transmitted as opaque blobs, and decrypted by receiving peers
6. When a user leaves, their local messages are discarded and the participant counter decrements
7. When the last participant leaves, the room ceases to exist

There is no room creation step separate from joining. The first person to join a room name creates it implicitly. The last person to leave destroys it.

## Future Vision

TrapChat's architecture is designed to expand beyond text chat:

- **Media support** — Images, video, canvas sharing, and file transfers, all encrypted and chunked through the relay
- **Peer-to-peer fallback** — WebRTC connections between peers to reduce relay load for direct communication
- **Key rotation** — Periodic re-keying to limit the window of exposure if a key is compromised
- **Room expiration** — TTL-based room cleanup to reclaim resources from abandoned sessions
- **Key sharing** — Distribute room keys via URL fragments or QR codes so new participants can decrypt messages

The guiding principle remains the same: **the server is a dumb pipe.** It never sees plaintext, never stores messages, and never knows who you are.
