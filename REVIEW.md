# Code Review: TrapChat

## Summary

TrapChat is a well-architected encrypted chat platform with a React frontend, Go gateway, Rust relay, and Node.js worker — all containerized via Docker Compose. The security posture is strong (E2E encryption, constant-time auth, SSRF protection, rate limiting), but several critical issues exist around crypto salt predictability, race conditions in the gateway, missing auth in production config, and relay payload amplification. The codebase demonstrates thoughtful engineering across all four languages with solid test coverage in the crypto and protocol layers, though the frontend `App.jsx` god component needs decomposition.

## Findings

### Critical

<!-- - **PBKDF2 salt is deterministic from room name** (`apps/trapchat/src/lib/crypto.js:73-75`) — The salt for `deriveRoomKey` is `SHA-256(roomName)`, which is public. An attacker who knows the room name can precompute rainbow tables for common passphrases. A proper salt should include random bytes exchanged out-of-band. -->

<!-- - **No auth token configured in docker-compose** (`docker-compose.yml:52-53`) — `WORKER_AUTH_TOKEN` is not set, so the worker skips all authentication. Any service on the network can submit arbitrary jobs, read results, and view dead-letter contents without credentials. -->

<!-- - **Race condition in TTL expiry peer disconnect** (`services/gateway/cmd/gateway/main.go:539-563`) — The lock is released at line 551 then re-acquired at line 556. Between unlock and RLock another goroutine can modify the map, making the "stillActive" check unreliable. Same pattern at lines 815-837. Can cause double-close or missed cleanup. -->

<!-- - **No payload size validation at protocol level** (`services/relay/src/main.rs:267-274`) — The 1MB raw frame check exists, but `Message.payload` has no protocol-level size limit. Many messages just under 1MB with large payloads all get cloned and fanned out to every peer in a room, amplifying memory pressure. -->

<!-- - **pruneLoop goroutine leak** (`services/gateway/cmd/gateway/main.go:125-142`) — `pruneLoop` runs forever with no cancellation mechanism. Each test leaks three goroutines. In production, pruneLoop goroutines can never be stopped during graceful shutdown. -->

<!-- - **Key rotation only applies to active room** (`apps/trapchat/src/App.jsx:184-185`) — `useKeyRotation` is initialized with `activeRoom`. When the user switches rooms, rotation messages from non-active rooms are handled with the wrong key context, causing decryption failures in background rooms. -->

### High

<!-- - **CSP connect-src only allows localhost** (`apps/trapchat/nginx.conf:10`) — `connect-src` restricts to `ws://localhost:* wss://localhost:*`. Any non-localhost deployment will have all WebSocket connections blocked by the browser. -->

- **SSRF callback bypass via localhost allowlist** (`services/worker/src/index.js:65-73`) — The private IP check is bypassed when `ALLOWED_CALLBACK_HOSTS` includes `localhost` (which it does by default). An attacker can use the worker as an SSRF proxy to internal services.

<!-- - **God component: App.jsx at 900+ lines** (`apps/trapchat/src/App.jsx:84-993`) — Manages multi-room state, WebRTC mesh, call state, encryption, message handling, P2P signaling. Extremely difficult to maintain and test. Should decompose into `useRoomManager`, `useWebRTCMesh`, `useCallManager`. -->

<!-- - **File metadata sent unencrypted** (`apps/trapchat/src/lib/media.js:89`) — fileName, mimeType, and fileSize are sent as plaintext alongside encrypted chunk data, leaking metadata to the relay and undermining the E2E encryption guarantee. -->

<!-- - **connectRelayInstance never exits** (`services/gateway/cmd/gateway/main.go:376-436`) — The reconnect loop runs `for { ... }` with no context or shutdown signal. During graceful shutdown, these goroutines keep running indefinitely. -->

<!-- - **Connection counter decremented with `Relaxed` ordering** (`services/relay/src/main.rs:209`) — Increment uses `AcqRel` but decrement uses `Relaxed`. Inconsistent ordering could cause counter drift on weakly-ordered architectures. -->

<!-- - **No max peers per room limit** (`services/relay/src/main.rs:334-337`) — All 10,000 connections can join a single room. A single message would be cloned 10,000 times in `fan_out_msg`. -->

<!-- - **Client-controlled timestamp unvalidated** (`pkgs/rust/protocol/src/message.rs:30`) — The relay blindly forwards client-supplied timestamps. Malicious clients can send arbitrary timestamps. -->

<!-- - **Stale closure in setupGlobalHandlers** (`apps/trapchat/src/App.jsx:593`) — `rooms` is captured once but `setupGlobalHandlers` is only called once at line 391. Subsequent room state changes mean incoming messages use stale room state. -->

<!-- - **`sendRaw` bypasses protocol** (`apps/trapchat/src/socket/client.js:161-167`) — Sends arbitrary strings with no validation, room association, or queuing. Can bypass protocol constraints. -->

<!-- - **`MAX_ROOMS` declared but never enforced** (`apps/trapchat/src/socket/client.js:4`) — Clients can join unlimited rooms with no check. -->

<!-- - **Worker and frontend containers run as root** (`services/worker/Dockerfile`, `apps/trapchat/Dockerfile`) — Neither specifies a `USER` directive. A container escape grants root-level access. -->

<!-- - **Null dereference in handleMediaChunk** (`apps/trapchat/src/hooks/useMediaTransfer.js:31`) — `assemblerRef.current.handleChunk()` called without null check. Throws if chunk arrives before init or after destroy. -->

### Medium

<!-- - **WebSocket WriteTimeout conflicts with long-lived connections** (`services/gateway/cmd/gateway/main.go:338`) — 15s `WriteTimeout` applies to entire response lifetime including WebSocket connections. May kill connections after 15s. -->

<!-- - **Silent message drops for slow peers** (`services/gateway/cmd/gateway/main.go:76-81`) — No logging or error feedback when messages are dropped. Peers silently miss messages. -->

<!-- - **Duplicate disconnect logic** (`services/gateway/cmd/gateway/main.go:538-563, 814-838`) — TTL expiry and room cleanup handlers contain nearly identical logic. Should extract a shared method. -->

<!-- - **Dynamic import on hot path** (`apps/trapchat/src/App.jsx:579`) — `await import('./lib/crypto.js')` called on every incoming chat message despite being statically imported at the top. -->

<!-- - **Duplicate chat decryption logic** (`apps/trapchat/src/App.jsx:571-603, 640-665`) — WebSocket and P2P chat handlers contain nearly identical decrypt-and-append logic. Should extract shared function. -->

<!-- - **FrameReader retains peak allocation** (`pkgs/rust/io/src/reader.rs:40`) — Buffer grows but never shrinks. One 1MB frame means 1MB retained for the reader's lifetime. -->

<!-- - **`read_all` unbounded** (`pkgs/rust/io/src/reader.rs:47-60`) — Reads frames in a loop with no count or size limit. Can consume unbounded memory. -->

<!-- - **`KeyRotator.start()` doesn't clear existing timer** (`apps/trapchat/src/lib/crypto.js:150-153`) — Calling `start()` twice leaks the first interval. -->

<!-- - **connect() rejects but also triggers reconnect** (`apps/trapchat/src/socket/client.js:40-48`) — Initial connect failure both rejects the promise and triggers auto-reconnect via `onclose`, creating parallel retry loops. -->

<!-- - **`validateMimeType` too strict** (`apps/trapchat/src/lib/media.js:63-64`) — Legitimate types without magic bytes (text, JSON, SVG) always downgraded to `application/octet-stream`. -->

<!-- - **No rate limiting on worker job submission** (`services/worker/src/index.js:101`) — 1MB body limit exists but no rate limiting. Queue can be flooded to 10,000 jobs quickly. -->

<!-- - **No `.dockerignore` for worker** (`services/worker/Dockerfile`) — Could accidentally include test files, `.env`, `node_modules` in build context. -->

<!-- - **Unused `ProtocolError` variants** (`pkgs/rust/protocol/src/error.rs:5-9`) — `InvalidMessageType` and `MissingField` defined but never constructed. Should be used for validation failures. -->

<!-- - **Unused `IoError::InvalidFrameType`** (`pkgs/rust/io/src/error.rs:9`) — Defined but never used. Frame type validation should use this. -->

<!-- - **IntersectionObserver re-observes on every render** (`apps/trapchat/src/components/ChatView.jsx:306-309`) — `observe(el)` called on every render for every non-own message. Causes duplicate observations. -->

<!-- - **Blob URL memory leak** (`apps/trapchat/src/hooks/useMediaTransfer.js:71`) — `URL.createObjectURL(file)` never revoked for own sent files. -->

<!-- - **Duplicate logger across three worker files** (`services/worker/src/index.js:6-10, manager.js:4-7, worker.js:1-5`) — Identical structured logger copy-pasted. Extract to shared module. -->

<!-- - **Relay Dockerfile runs as root** (`services/relay/Dockerfile:8-12`) — No `USER` directive. Should run as non-root. -->

<!-- - **Duplicate `onnegotiationneeded` setup** (`apps/trapchat/src/lib/webrtc.js:43-51, 69-77`) — Same handler duplicated in `createOffer` and `handleOffer`. -->

<!-- - **No error handling in `#flushPendingCandidates`** (`apps/trapchat/src/lib/webrtc.js:105-110`) — One `addIceCandidate` failure stops all remaining candidates. -->

<!-- - **No response body size limit on health checks** (`services/gateway/cmd/gateway/main.go:628-629`) — `json.Decode` reads relay/worker health responses without size limits. -->

<!-- - **Duplicate default room state** (`apps/trapchat/src/App.jsx:126-132, 138-144`) — Default room state shape duplicated. Extract to shared constant. -->

### Low

<!-- - **Only Google STUN configured, no TURN** (`apps/trapchat/src/lib/webrtc.js:2`) — WebRTC fails for users behind symmetric NATs or restrictive firewalls. -->
<!-- - **`Math.random()` for room names** (`apps/trapchat/src/App.jsx:67-70`) — Not cryptographically secure. Inconsistent with the security-focused design. -->
<!-- - **Token in query parameter** (`services/gateway/cmd/gateway/main.go:742`) — Visible in server logs, browser history, proxy logs. -->
<!-- - **No version pinning on Docker base images** (`apps/trapchat/Dockerfile:1,8`, `services/worker/Dockerfile:1`) — Builds not reproducible without SHA digest pinning. -->
<!-- - **Alpine 3.19 may be outdated** (`services/gateway/Dockerfile:9`) — Released Nov 2023. Consider updating for security patches. -->
<!-- - **Root package.json commonjs vs worker ESM** (`package.json:27`) — Could confuse developers and tooling. -->
<!-- - **Integration test depends on python3** (`tests/integration/pipeline_test.sh:53`) — Undocumented dependency; consider using `jq`. -->
<!-- - **`timingSafeEqual` length check leaks token length** (`services/worker/src/index.js:23`) — Minor info leak on token length. -->
<!-- - **Inconsistent error handling on JSON encoder writes** (`services/gateway/cmd/gateway/main.go:665,801,842,897`) — Some check errors, others don't. -->
<!-- - **No tests for `TrapChatClient`, WebRTC, or `sendMedia`/`sendCanvas`** — Core client infrastructure has zero test coverage. -->
<!-- - **No test for `KeyRotator` automatic rotation** (`apps/trapchat/src/lib/__tests__/crypto.test.js`) — Timer-driven rotation untested. -->
<!-- - **Canvas always in DOM** (`apps/trapchat/src/components/ChatView.jsx:345-346`) — Could be conditionally rendered. -->
<!-- - **Prune interval doesn't clean stale timestamps within retained IPs** (`services/relay/src/main.rs:112-114`) — Old timestamps in a vec are only cleaned on `allow()`, not by `prune()`. -->
<!-- - **`#[allow(clippy::result_large_err)]` applied broadly** (`services/relay/src/main.rs:19,41,48,214`) — Consider boxing the `WebSocket` variant instead. -->

## Strengths

- **Solid E2E encryption** — AES-256-GCM with random IVs, PBKDF2 with 100k iterations, key rotation with grace period for in-flight messages, keys that never leave the client. The core crypto implementation is textbook correct.
- **Defense-in-depth security** — Constant-time auth comparison, SSRF callback validation with DNS resolution and private IP blocking, per-IP rate limiting, HMAC length-prefixed to prevent delimiter injection, comprehensive input validation across all services.
- **Strong DoS mitigation in relay** — Per-IP rate limiting, global connection/room caps, oversized message rejection, bounded peer channels with slow-consumer eviction.
- **Clean multi-language architecture** — React frontend, Go gateway (HTTP/WebSocket routing, auth), Rust relay (high-performance message fan-out), Node.js worker (job processing). Each language plays to its strengths.
- **Robust reconnection logic** — Exponential backoff with jitter, room rejoin on reconnect, message queuing during disconnection in the socket client.
- **Thorough media transfer security** — Chunk bounds checking, max concurrent transfers, stale timeouts, file size limits, MIME type validation via magic bytes, path traversal sanitization.
- **Good accessibility** — Consistent `aria-label`, `aria-live`, `role` attributes, focus-visible styling, keyboard navigation support across both views.
- **Well-structured Rust crates** — `trapchat_io` (framing) and `trapchat_protocol` (message types) have clear responsibilities with minimal coupling and good test coverage.
- **Production-ready worker** — Job queue with retry, exponential backoff, dead-letter support, graceful shutdown, structured logging.
- **Network isolation** — Only the frontend exposes ports. All internal services use `expose` on a private bridge network.

## Recommendations

1. **Fix crypto salt** — Add random bytes to the PBKDF2 salt and exchange them during room setup. This is the most impactful security fix.
2. **Set `WORKER_AUTH_TOKEN`** in docker-compose.yml (even a placeholder with a comment to override).
3. **Add context/cancellation** to gateway goroutines (`pruneLoop`, `connectRelayInstance`) for clean shutdown.
4. **Fix gateway race condition** — Hold the lock across the TTL expiry check-and-disconnect or use a single write lock.
5. **Add per-room peer cap** in the relay to prevent fan-out amplification.
6. **Encrypt file metadata** (fileName, mimeType, fileSize) alongside chunk data.
7. **Parameterize CSP** `connect-src` for non-localhost deployments.
8. **Decompose `App.jsx`** — Extract `useRoomManager`, `useWebRTCMesh`, `useCallManager` hooks.
9. **Run all containers as non-root** — Add `USER` directives to all Dockerfiles.
10. **Implement `MAX_ROOMS` enforcement** in the socket client.
11. **Add tests** for `TrapChatClient`, WebRTC, `sendMedia`/`sendCanvas`, and `KeyRotator` timer rotation.
12. **Use the unused error variants** (`ProtocolError::InvalidMessageType`, `MissingField`, `IoError::InvalidFrameType`) for proper validation.
