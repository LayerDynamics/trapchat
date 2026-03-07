# Security Audit — Findings & Disposition

Audit date: 2026-03-07

## Findings

### HIGH — CSP allows unsafe-inline (Fixed)
- **File**: `apps/trapchat/nginx.conf`
- **Issue**: `script-src` and `style-src` included `'unsafe-inline'`, enabling potential XSS
- **Fix**: Removed `'unsafe-inline'` from both directives. Added `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`, `frame-ancestors 'none'`

### HIGH — Broadcast endpoint accepts arbitrary message types (Fixed)
- **File**: `services/gateway/cmd/gateway/main.go`
- **Issue**: `/api/rooms/{name}/broadcast` accepted any `type` field, allowing injection of fake chat/media messages via the worker API
- **Fix**: Added type allowlist — only `error` and `presence` types are permitted

### MEDIUM — Missing security headers (Fixed)
- **File**: `apps/trapchat/nginx.conf`
- **Issue**: No `Referrer-Policy` or `Permissions-Policy` headers
- **Fix**: Added `Referrer-Policy: no-referrer` and `Permissions-Policy: camera=(), microphone=(), geolocation=()`

### MEDIUM — No Rust/Go dependency scanning in CI (Fixed)
- **File**: `.github/workflows/ci.yml`
- **Issue**: Only npm audit was run; no `cargo audit` or `govulncheck`
- **Fix**: Added `cargo-audit` and `govulncheck` to the security CI job

### LOW — npm audit threshold too permissive (Fixed)
- **File**: `.github/workflows/ci.yml`
- **Issue**: `--audit-level=high` missed moderate-severity CVEs
- **Fix**: Lowered to `--audit-level=moderate`

## Verified Safe

- **Relay port**: Not host-exposed in docker-compose (internal network only)
- **No payload content logged**: Gateway and relay log metadata (room, peer_id, frame_type, length) but never log message payload content
- **CSP img-src/media-src**: Added `blob:` and `data:` to support QR codes and media previews
- **Rate limiting**: Per-peer token bucket on chat/media (10/s burst 20) and typing (1/2s burst 3)
- **Auth**: Constant-time token comparison, optional bearer token or query param

## Strengths

- End-to-end encryption with automatic key rotation
- Ephemeral rooms with automatic cleanup
- Server-side HMAC envelope signing for integrity
- Origin validation on both gateway and relay
- Read size limits (1MB) on both gateway and relay
- Per-IP connection rate limiting on relay
