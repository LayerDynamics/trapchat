# TrapChat — Development Roadmap

## Phase 1: Foundation ✅ DONE

- Workspace configurations: `Cargo.toml` workspace, `go.work`, root `package.json`
- Shared packages: `pkgs/go/` (crypto, protocol, storage) and `pkgs/rust/` (trapchat-io, trapchat-protocol)
- Service entry points: gateway (Go :8080), relay (Rust :9000), worker (Node :9100)
- Frontend scaffold: React 19 + Vite (:3000), TrapChatClient WebSocket class, AES-256-GCM crypto module
- All services build, run, and serve health endpoints
- Echo loops operational on gateway and relay WebSocket handlers
- Install/run/uninstall scripts in `bin/`

## Phase 2: Room Routing — Next

- Replace gateway echo loop with room-aware routing
- Store peer → room mappings in gateway's in-memory Store
- Forward messages to relay with room context (room ID in frame/message)
- Relay fan-out: broadcast incoming messages to all peers in the same room
- Presence events: `join`, `leave`, and `peer_count` broadcasts via `RoomEvent` types
- Gateway ↔ Relay WebSocket connection (gateway as relay client)

## Phase 3: End-to-End Encryption

- Wire up `decrypt()` on incoming messages in the frontend
- Key exchange: derive shared room key, distribute via URL fragment (`#key=<base64>`)
- Implement `exportKey()`/`importKey()` flow for room key sharing between tabs/devices
- Verify encryption works end-to-end between two browser tabs in separate windows
- Handle key mismatch gracefully (display error, prompt for correct key)

## Phase 4: Worker Pipeline

- Implement `room:cleanup` job — TTL-based room expiration, purge stale rooms from Store
- Implement `media:chunk` job — split large payloads into relay-sized frames
- Gateway → Worker job submission via HTTP POST to `:9100/jobs`
- Worker result callbacks to gateway (job completion notifications)
- Job retry logic for transient failures

## Phase 5: Media Support

- Image upload → chunk → encrypt → relay → reassemble → decrypt → display
- Video streaming via chunked relay frames
- File download support with progress indication
- Canvas sharing — serialize canvas state, chunk, and relay to peers
- Media type detection and preview rendering in frontend

## Phase 6: Resilience & Scale

- Connection reconnection with exponential backoff in TrapChatClient
- Gateway CORS enforcement using `CORS_ORIGINS` env var
- Rate limiting per peer on gateway
- Key rotation on timer using `KEY_ROTATION_INTERVAL`
- Multiple relay instances with peer-to-relay mapping
- Load balancing across relay instances
- Graceful shutdown handling across all services

## Phase 7: Production Readiness

- Docker / docker-compose for containerized deployment
- CI/CD pipeline (build, test, lint, deploy)
- Structured logging across all services (JSON format)
- Monitoring and alerting (health check aggregation, error rates)
- Security audit (encryption implementation, WebSocket handling, input validation)
- Documentation site (generated from these docs)
