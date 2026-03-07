# TrapChat — Development Roadmap

## Phase 1: Foundation ✅ DONE

- Workspace configurations: `Cargo.toml` workspace, `go.work`, root `package.json`
- Shared packages: `pkgs/go/` (crypto, protocol, storage) and `pkgs/rust/` (trapchat-io, trapchat-protocol)
- Service entry points: gateway (Go :8080), relay (Rust :9000), worker (Node :9100)
- Frontend scaffold: React 19 + Vite (:3000), TrapChatClient WebSocket class, AES-256-GCM crypto module
- All services build, run, and serve health endpoints
- Echo loops operational on gateway and relay WebSocket handlers
- Install/run/uninstall scripts in `bin/`

## Phase 2: Room Routing ✅ DONE

- Replace gateway echo loop with room-aware routing
- Store peer → room mappings in gateway's in-memory Store
- Forward messages to relay with room context (room ID in frame/message)
- Relay fan-out: broadcast incoming messages to all peers in the same room
- Presence events: `join`, `leave`, and `peer_count` broadcasts via `RoomEvent` types
- Gateway ↔ Relay WebSocket connection (gateway as relay client)

## Phase 3: End-to-End Encryption ✅ DONE

- Wire up `decrypt()` on incoming messages in the frontend
- Key exchange: derive shared room key, distribute via URL fragment (`#key=<base64>`)
- Implement `exportKey()`/`importKey()` flow for room key sharing between tabs/devices
- Verify encryption works end-to-end between two browser tabs in separate windows
- Handle key mismatch gracefully (display error, prompt for correct key)

## Phase 4: Worker Pipeline ✅ DONE

- Implement `room:cleanup` job — TTL-based room expiration, purge stale rooms from Store
- Implement `media:chunk` job — split large payloads into relay-sized frames, forward to gateway broadcast endpoint
- Gateway → Worker job submission via HTTP POST to `:9100/jobs`
- Worker result callbacks to gateway (job completion notifications)
- Job retry logic with exponential backoff and dead-letter queue

## Phase 5: Media Support ✅ DONE

- Image upload → chunk → encrypt → relay → reassemble → decrypt → display
- Video streaming via chunked relay frames with send throttling
- File download support with progress indication (download progress bar)
- Canvas sharing — serialize canvas state, chunk, and relay to peers
- Media type detection (magic bytes) and preview rendering in frontend
- Security: bounds checks (MAX_CHUNKS, MAX_CONCURRENT_TRANSFERS), filename sanitization

## Phase 6: Resilience & Scale ✅ DONE

- Connection reconnection with exponential backoff + jitter in TrapChatClient
- Gateway CORS enforcement using `ALLOWED_ORIGINS` env var
- Rate limiting per peer on gateway (token bucket: 10 msg/s, burst 20)
- Key rotation on timer using `VITE_KEY_ROTATION_INTERVAL` (KeyRotator with grace period)
- Multiple relay instances with `RELAY_URLS` env var (comma-separated)
- Load balancing across relay instances (FNV-1a consistent hashing on room name)
- Graceful shutdown handling across all services (SIGINT/SIGTERM)

## Phase 7: Production Readiness ✅ DONE

- Docker / docker-compose with health checks, restart policies, and service networking
- Nginx reverse proxy with WebSocket upgrade, API proxy, and security headers (CSP, X-Frame-Options)
- CI/CD pipeline: build, test, lint (go vet, clippy, eslint), security audit (npm audit), docker build, integration tests, deploy template
- Dependency caching in CI (Go modules, Cargo registry, npm)
- Structured JSON logging across all services
- Monitoring: `/health`, `/health/all` (aggregated), `/metrics` (connections, rooms, relay status, uptime, rate limiter)
- Security audit: SSRF fixes, input validation, media bounds checks, filename sanitization, CSP headers, DNS rebinding protection
