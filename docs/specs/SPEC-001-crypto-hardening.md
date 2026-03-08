# SPEC-001 — Crypto Layer Hardening

## Background

TrapChat is an ephemeral encrypted chat platform with E2E AES-256-GCM encryption. A code review (REVIEW.md) identified three crypto-layer issues:

1. **Deterministic PBKDF2 salt** — The salt for passphrase-derived room keys is `SHA-256(pepper + roomName)`. Since room names are public, an attacker who knows the room name can precompute password guesses offline. A random salt exchanged between peers would force per-room brute-force.

2. **Plaintext file metadata** — `fileName`, `mimeType`, and `fileSize` are sent unencrypted alongside encrypted file chunks, leaking metadata to the relay and undermining E2E guarantees.

3. **KeyRotator timer leak** — Calling `KeyRotator.start()` twice without `stop()` leaks the first `setInterval`, causing double-rotation and eventually memory pressure.

### Why now

These are the highest-impact security fixes identified in the review. The salt issue is the most critical — it reduces passphrase-room security from "must brute-force per-room" to "precompute once per room name." The file metadata leak undermines the core E2E promise. The KeyRotator bug is a correctness issue that compounds under key rotation.

### Assumptions

- Clean break: no backward compatibility with old passphrase rooms
- TrapChat rooms are ephemeral — salt lifetime matches room lifetime
- The gateway is trusted to store and relay the salt (it already handles room metadata, peer lists, and HMAC signing)
- Performance budget: key derivation up to 1-2s on mobile is acceptable

## Requirements

### Functional requirements

| ID | Requirement | Priority |
|----|-------------|----------|
| F1 | First joiner of a passphrase room generates a 32-byte random salt | Must |
| F2 | Gateway stores salt in room metadata and returns it in `join` response | Must |
| F3 | All joiners derive the room key using `PBKDF2(passphrase, randomSalt \|\| roomName, 600k, SHA-256)` | Must |
| F4 | File metadata (`fileName`, `mimeType`, `fileSize`) is encrypted inside the E2E payload | Must |
| F5 | `KeyRotator.start()` clears any existing timer before starting a new one | Must |
| F6 | Share links for passphrase rooms do not change format (room name only, no salt in URL) | Must |

### Non-functional requirements

| ID | Requirement | Priority |
|----|-------------|----------|
| NF1 | Key derivation completes in < 2s on low-end mobile (Snapdragon 4 Gen 1) | Should |
| NF2 | Salt exchange adds < 50ms to room join latency | Must |
| NF3 | No new network round-trips for the first joiner | Should |

### Security and compliance requirements

| ID | Requirement | Priority |
|----|-------------|----------|
| S1 | Salt is generated via `crypto.getRandomValues()` (CSPRNG) | Must |
| S2 | Salt is 32 bytes (256-bit) per NIST SP 800-132 | Must |
| S3 | PBKDF2 iterations remain at 600,000 (OWASP 2023 recommendation) | Must |
| S4 | File metadata is indistinguishable from message ciphertext on the wire | Must |
| S5 | Gateway never sees plaintext passphrase or derived key | Must |

### Data requirements

| ID | Requirement | Priority |
|----|-------------|----------|
| D1 | Salt is stored in-memory only, co-located with room metadata in `storage.Store` | Must |
| D2 | Salt is destroyed when the room is destroyed (last peer leaves or TTL expires) | Must |
| D3 | No salt persistence to disk, database, or logs | Must |

### Integration requirements

| ID | Requirement | Priority |
|----|-------------|----------|
| I1 | Gateway `join` response envelope includes `salt` field (base64) when present | Must |
| I2 | Client `join` request includes `salt` field (base64) when creating a passphrase room | Must |
| I3 | Relay is unaffected — salt exchange happens entirely between client and gateway | Must |

### Operational requirements

| ID | Requirement | Priority |
|----|-------------|----------|
| O1 | No new environment variables or configuration | Must |
| O2 | No new external dependencies | Must |

### Delivery constraints

- **Timeline:** Single sprint (1-2 weeks)
- **Team:** Solo developer
- **Hosting:** Docker Compose (development), unchanged

## Method

### 1. System architecture overview

No new services or components. Changes are localized to:
- **Frontend** (`apps/trapchat/src/lib/crypto.js`, `App.jsx`, `lib/media.js`)
- **Gateway** (`services/gateway/cmd/gateway/main.go`, `pkg/storage/`)

The relay, worker, and infrastructure are untouched.

### 2. Architectural style and rationale

Extension of existing request-response signaling. The salt piggybacks on the existing `join` message type — no new message types or protocol versions needed.

### 3. Component responsibilities

| Component | Change |
|-----------|--------|
| `crypto.js` | Accept external salt in `deriveRoomKey()`. Fix `KeyRotator.start()`. |
| `media.js` | Move metadata inside the encrypted payload envelope. |
| `App.jsx` | Generate salt on room creation, pass salt from join response to `deriveRoomKey()`. |
| `gateway/main.go` | Accept `salt` in join payload, store it, return it in join response. |
| `storage.Store` | Add `Salt []byte` field to room struct. |

### 4. Data design and schema model

**Room struct (Go, in-memory):**
```go
type Room struct {
    Peers       map[string]PeerInfo
    CreatedAt   time.Time
    TTLSeconds  int
    Salt        []byte   // NEW: 32 bytes, nil for non-passphrase rooms
}
```

**Join payload (JSON, client → gateway):**
```json
{
  "nickname": "alice",
  "ttlSeconds": 3600,
  "salt": "base64-encoded-32-bytes"   // NEW: only on first join of passphrase room
}
```

**Join response / presence (JSON, gateway → client):**
```json
{
  "type": "presence",
  "room": "my-room",
  "payload": {
    "peers": [...],
    "salt": "base64-encoded-32-bytes"  // NEW: included if room has a salt
  }
}
```

**Encrypted file metadata (inside E2E payload):**
```json
// Before (plaintext alongside encrypted chunks):
{ "type": "chunk", "fileName": "doc.pdf", "mimeType": "application/pdf", "fileSize": 12345, "data": "<encrypted>" }

// After (metadata inside encrypted envelope):
{ "type": "chunk", "data": "<encrypted blob containing {fileName, mimeType, fileSize, chunkData}>" }
```

### 5. API and interface design

**`deriveRoomKey(roomName, passphrase, salt)` — updated signature:**
```js
// salt: Uint8Array(32) — required, provided by caller
export async function deriveRoomKey(roomName, passphrase, salt) {
  const enc = new TextEncoder();
  const material = `${roomName}:${passphrase}`;
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(material), 'PBKDF2', false, ['deriveKey']);
  // Combine random salt with room-name hash for domain separation
  const roomHash = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(`${SALT_PEPPER}:${roomName}`)));
  const combinedSalt = new Uint8Array(64);
  combinedSalt.set(salt, 0);
  combinedSalt.set(roomHash, 32);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: combinedSalt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );
}
```

**`encryptMediaChunk(key, chunkData, metadata)` — new function:**
```js
export async function encryptMediaChunk(key, chunkData, metadata) {
  const envelope = JSON.stringify({ ...metadata, data: uint8ToBase64(chunkData) });
  return encrypt(key, envelope);
}

export async function decryptMediaChunk(key, ciphertext) {
  const json = await decrypt(key, ciphertext);
  const { data, ...metadata } = JSON.parse(json);
  return { chunkData: base64ToUint8(data), metadata };
}
```

### 6. Workflow and sequence logic

**Passphrase room creation (first joiner):**
```
Client A                        Gateway
   |                               |
   |  join {room, nickname,        |
   |        ttlSeconds, salt}      |
   |------------------------------>|
   |                               | store salt in Room struct
   |  presence {peers, salt}       |
   |<------------------------------|
   |                               |
   | deriveRoomKey(room, pass, salt)|
   |                               |
```

**Passphrase room join (subsequent joiner):**
```
Client B                        Gateway
   |                               |
   |  join {room, nickname,        |
   |        ttlSeconds}            |
   |------------------------------>|
   |                               | lookup salt from Room struct
   |  presence {peers, salt}       |
   |<------------------------------|
   |                               |
   | deriveRoomKey(room, pass, salt)|
   |                               |
```

### 7. Algorithms and business rules

- Salt generation: `crypto.getRandomValues(new Uint8Array(32))`
- Combined salt: `randomSalt(32 bytes) || SHA-256(pepper + roomName)(32 bytes)` = 64 bytes total
- PBKDF2 parameters: 600,000 iterations, SHA-256 PRF, 256-bit output
- If a room already has a salt and a new joiner sends a different salt, the gateway ignores the new salt (first-writer-wins)
- If a `join` has no `salt` field and the room has no salt, it's a non-passphrase room — no change

### 8. Consistency and transaction strategy

- Salt is set atomically with room creation under the existing `sync.RWMutex`
- First-writer-wins is enforced within the same lock acquisition as `JoinWithTTL`
- No distributed consistency concerns — single gateway instance per room (relay handles cross-gateway, but salt is gateway-local)

### 9. Security architecture

- **Threat: rainbow tables** — Mitigated by 32-byte random salt unique per room instance
- **Threat: relay metadata inspection** — Mitigated by encrypting file metadata inside the E2E envelope
- **Threat: gateway salt tampering** — The gateway could serve a wrong salt, but it already controls room membership and HMAC signing. This is within the existing trust model.
- **Threat: salt replay** — Each room instance gets a fresh salt. Room names can be reused, but the salt differs each time.

### 10. Reliability and resilience design

- If the gateway restarts, all rooms are destroyed (existing behavior). Peers reconnect and re-create rooms with fresh salts.
- No new failure modes — salt exchange piggybacks on existing join flow.

### 11. Performance and scalability approach

- Salt adds 44 bytes (base64 of 32 bytes) to join response. Negligible.
- File metadata encryption adds one `encrypt()` call per chunk. Chunks are already encrypted; this wraps metadata into the same call. Net overhead: ~0.
- PBKDF2 at 600k iterations: ~800ms on modern mobile, ~200ms on desktop. Acceptable per NF1.

### 12. Observability design

No new metrics or alerts. Existing gateway logging covers join/leave. Salt is not logged (D3).

### 13. Infrastructure and deployment topology

Unchanged. No new services, ports, or dependencies.

### 14. Tradeoffs and rejected alternatives

| Alternative | Rejected because |
|------------|-----------------|
| Salt in share link (URL fragment) | Would change link format and require out-of-band exchange for passphrase rooms, which defeats the purpose of passphrase mode |
| Server-generated salt | Moves trust to the server for a security-critical parameter. First-joiner generation is more aligned with E2E principles. |
| Backward compatibility layer | Adds complexity for detecting old vs new rooms. Clean break is acceptable since rooms are ephemeral (max 24h TTL). |
| SRP or PAKE protocol | Overkill for the threat model. PBKDF2 with random salt and high iterations is sufficient for passphrase-derived keys. |
| Reducing iterations for mobile perf | Trades security for speed. 1-2s derivation is acceptable per stakeholder decision. |

### 15. Architecture diagrams

```
┌──────────┐         join {salt}        ┌──────────┐
│ Client A │ ──────────────────────────> │ Gateway  │
│ (creator)│ <────────────────────────── │          │
│          │    presence {salt}          │  Store:  │
└──────────┘                            │  Room {  │
                                        │   Salt   │
┌──────────┐         join {}            │   Peers  │
│ Client B │ ──────────────────────────> │   TTL    │
│ (joiner) │ <────────────────────────── │  }       │
│          │    presence {salt}          └──────────┘
└──────────┘
```

## Implementation

### Build phases

**Phase 1 — Salt exchange (days 1-4):**
1. Update `storage.Store` to hold `Salt []byte` per room
2. Update gateway `TypeJoin` handler to accept and store salt, return salt in presence
3. Update `deriveRoomKey()` to accept external salt parameter
4. Update `App.jsx` `handleJoinRoom` to generate salt (creator) or receive salt (joiner)
5. Remove old deterministic salt code

**Phase 2 — File metadata encryption (days 5-7):**
1. Create `encryptMediaChunk` / `decryptMediaChunk` in `crypto.js`
2. Update `media.js` to encrypt metadata inside the payload
3. Update `useMediaTransfer.js` to decrypt metadata from payload
4. Remove plaintext metadata fields from wire format

**Phase 3 — KeyRotator fix + tests (days 8-10):**
1. Fix `KeyRotator.start()` to clear existing timer
2. Write unit tests for new `deriveRoomKey()` with salt
3. Write unit tests for `encryptMediaChunk` / `decryptMediaChunk`
4. Write unit test for `KeyRotator.start()` double-call
5. Write integration test for salt exchange via WebSocket
6. Write E2E browser test for passphrase room join flow

### Workstreams

Single developer, sequential phases. No parallelism needed at this scale.

### Dependencies

- Phase 2 depends on Phase 1 (needs working key derivation with salt)
- Phase 3 depends on Phases 1 and 2 (tests cover all changes)

### Testing strategy

| Level | Scope | Tool |
|-------|-------|------|
| Unit | `deriveRoomKey()` with salt, `encryptMediaChunk`, `decryptMediaChunk`, `KeyRotator.start()` double-call | Vitest |
| Integration | Salt exchange: connect two clients via WebSocket, verify same key derived | Vitest + WebSocket mock or live gateway |
| E2E | Full passphrase room flow: join, exchange salt, send/receive encrypted message with file | Playwright or Cypress against Docker Compose |

### Rollout strategy

Clean break — deploy all changes together. No feature flags needed since:
- Rooms are ephemeral (max 24h TTL)
- No persistent state to migrate
- All clients update together (single deployment)

### Operational readiness

- No new runbooks needed
- No new alerts needed
- Verify gateway memory usage does not increase meaningfully (32 bytes per room is negligible)

## Milestones

| # | Milestone | Exit criteria | Target |
|---|-----------|---------------|--------|
| M1 | Salt exchange working | Two clients can join a passphrase room, derive the same key, exchange encrypted messages | Day 4 |
| M2 | File metadata encrypted | File transfers work with metadata inside E2E envelope, no plaintext metadata on wire | Day 7 |
| M3 | All tests passing | Unit, integration, and E2E tests green. KeyRotator fix verified. | Day 10 |
| M4 | Merged to main | Code review passed, CI green | Day 10-14 |

## Gathering Results

### Success metrics

- Zero plaintext metadata visible in relay/gateway logs or network captures
- `deriveRoomKey()` produces different keys for same `(roomName, passphrase)` across room instances
- All existing crypto tests still pass
- New tests cover salt exchange, metadata encryption, and KeyRotator fix

### Validation methods

- **Crypto correctness:** Unit tests verify deterministic derivation given same salt, different derivation given different salt
- **Metadata privacy:** Network capture (Wireshark/browser DevTools) confirms no plaintext file metadata in WebSocket frames
- **KeyRotator:** Unit test calls `start()` twice, verifies only one interval is active
- **E2E:** Browser test joins passphrase room, sends file, verifies receipt

### Post-production review cadence

- Day 1 post-merge: verify no regressions in chat or file transfer
- Day 7: check for any bug reports related to passphrase rooms
- No ongoing cadence needed — this is a one-time security fix

### Remediation triggers

- Any decryption failure in passphrase rooms → investigate salt exchange
- Any plaintext metadata appearing in logs → investigate media encryption path

## Appendices

### A. Decision log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-03-08 | 32-byte random salt | Extra margin over 16-byte minimum, negligible overhead |
| 2026-03-08 | First-joiner generates salt | Aligns with E2E principles; server is passive relay |
| 2026-03-08 | Clean break, no backward compat | Rooms are ephemeral (max 24h). No migration needed. |
| 2026-03-08 | Gateway stores salt in-memory | Matches existing room metadata pattern. No new persistence. |
| 2026-03-08 | 600k PBKDF2 iterations | OWASP 2023 recommendation. 1-2s mobile derivation is acceptable. |

### B. Glossary

| Term | Definition |
|------|-----------|
| Salt | Random bytes mixed into key derivation to prevent precomputation attacks |
| Pepper | Application-specific constant mixed into salt for domain separation |
| PBKDF2 | Password-Based Key Derivation Function 2 (RFC 8018) |
| E2E | End-to-end encryption — keys never leave the client |
| TTL | Time-to-live — room expiry duration |
| CSPRNG | Cryptographically Secure Pseudo-Random Number Generator |
