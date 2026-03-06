# TrapChat — MoSCoW Prioritization

## Must Have (Current Sprint / MVP)

- [x] Room creation by name — join and leave with participant count
- [x] Real-time text messaging via WebSocket
- [x] Client-side AES-256-GCM encryption — every message encrypted before send
- [x] Ephemeral messages — cleared on disconnect, zero server persistence
- [x] Health endpoints for all services (`/health` on gateway, relay, worker)
- [x] Service scaffolding — all four services build and run
- [x] Shared packages — Go (crypto, protocol, storage) and Rust (io, protocol)
- [ ] Gateway → Relay WebSocket forwarding — replace echo loops with room routing
- [ ] Presence broadcasts — peer count updates sent to all room participants

## Should Have (Next Sprint)

- [ ] Room-based message fan-out in relay — broadcast to all peers in a room
- [ ] Decrypt incoming messages on frontend — wire up the imported `decrypt` function
- [ ] Key sharing mechanism — share room key via URL fragment or QR code
- [ ] Gateway CORS configuration — enforce `CORS_ORIGINS` env var
- [ ] Worker: `room:cleanup` job implementation — purge stale rooms
- [ ] Worker: `media:chunk` job implementation — chunk large payloads for relay
- [ ] Connection reconnection logic in TrapChatClient — auto-reconnect on drop

## Could Have (Future)

- [ ] Media support — images, video, canvas, file transfers
- [ ] Peer-to-peer WebRTC fallback — reduce relay load for direct connections
- [ ] Key rotation — periodic re-key via `KEY_ROTATION_INTERVAL`
- [ ] Room expiration / TTL — auto-destroy rooms after inactivity
- [ ] Typing indicators
- [ ] Read receipts (opt-in)
- [ ] Rate limiting on gateway
- [ ] Docker / docker-compose for deployment
- [ ] Multiple relay instances — horizontal scaling with load balancing

## Won't Have (Out of Scope)

- User accounts or authentication
- Server-side message storage or logging
- Message history / scrollback
- Analytics or telemetry
- Admin dashboard (initial release)
- Mobile native apps
