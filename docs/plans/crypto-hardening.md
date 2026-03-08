# Implementation Plan: Crypto Layer Hardening

**Date:** 2026-03-08
**Author:** Ryan + Claude
**Status:** Draft

## Executive Summary

TrapChat's passphrase-derived room keys use a deterministic salt, file metadata leaks in plaintext, and KeyRotator has a timer leak. This plan addresses all three issues in a single sprint: adding random salt exchange via the gateway's in-memory store, encrypting file metadata inside E2E payloads, and fixing the KeyRotator double-start bug. The recommended approach piggybacks salt on the existing join/presence protocol with minimal changes to three files per layer (Go storage + gateway, JS crypto + media + App).

## Background & Context

See `docs/specs/SPEC-001-crypto-hardening.md` for full specification. Key points:

- `deriveRoomKey()` uses `SHA-256(pepper + roomName)` as salt — deterministic and precomputable
- `sendMedia()` sends `fileName`, `mimeType`, `fileSize` as plaintext JSON fields alongside encrypted chunk data
- `KeyRotator.start()` doesn't clear existing timer, causing leaked intervals on double-call

## Implementation Strategy

### Recommended Approach: Gateway-Mediated Salt Exchange

The first joiner generates a 32-byte random salt and sends it in the `join` payload. The gateway stores it in the `Room` struct. Subsequent joiners receive it in the `presence` response. Both sides combine the random salt with the existing peppered room-name hash to derive the key.

This approach was chosen because:
- **Zero new message types** — piggybacks on existing `join` and `presence`
- **Zero new round-trips** — salt travels in the join response that already exists
- **Matches trust model** — gateway already holds room metadata, HMAC keys, and peer lists
- **Ephemeral by design** — salt dies when room dies, matching TrapChat's no-persistence model

### Alternatives Considered

| Strategy | Pros | Cons | Verdict |
|----------|------|------|---------|
| Gateway-mediated salt | No new messages, no extra round-trips, simple | Gateway sees salt (but not passphrase) | **Recommended** |
| Salt in share link | No server involvement | Changes link format, defeats passphrase mode's purpose | Rejected — breaks UX model |
| Dedicated `room_salt` message | More explicit protocol | Requires ordering guarantees, late-joiner request/response, more complex | Rejected — unnecessary complexity |
| SRP/PAKE protocol | Strongest guarantees, mutual auth | Massive protocol change, multiple round-trips, overkill for threat model | Rejected — disproportionate effort |

### Trade-off Analysis

- **Gateway trust:** The gateway sees the random salt but never the passphrase or derived key. An attacker who compromises the gateway can substitute a salt they know, but they still can't derive the key without the passphrase. This is within the existing trust boundary (gateway already controls room membership).
- **Clean break:** Old clients can't join new passphrase rooms. Acceptable because rooms are ephemeral (max 24h TTL) and all clients deploy together.

## Requirements

### Functional Requirements

- **FR-1:** `deriveRoomKey(roomName, passphrase, salt)` MUST accept a 32-byte external salt parameter
- **FR-2:** Combined PBKDF2 salt MUST be `randomSalt(32) || SHA-256(pepper + roomName)(32)` = 64 bytes
- **FR-3:** First joiner MUST generate salt via `crypto.getRandomValues(new Uint8Array(32))`
- **FR-4:** Gateway MUST store salt in `Room` struct, return it in presence payload
- **FR-5:** Gateway MUST ignore salt from subsequent joiners (first-writer-wins)
- **FR-6:** File metadata (`fileName`, `mimeType`, `fileSize`) MUST be encrypted inside the chunk payload
- **FR-7:** `KeyRotator.start()` MUST clear any existing timer before starting a new one

### Non-Functional Requirements

- **NFR-1:** Key derivation SHOULD complete in < 2s on low-end mobile
- **NFR-2:** Salt exchange MUST add < 50ms to join latency
- **NFR-3:** No new external dependencies

### Constraints

- Languages: JavaScript (frontend), Go (gateway)
- Framework: React (frontend), stdlib (gateway)
- No backward compatibility required (clean break)
- Single-developer sprint

### Acceptance Criteria

- [ ] Two clients joining the same passphrase room derive identical keys
- [ ] Same room name + passphrase produces different keys across room instances (different salts)
- [ ] File metadata is not visible in plaintext in WebSocket frames
- [ ] `KeyRotator.start()` called twice results in exactly one active interval
- [ ] All existing crypto tests pass
- [ ] New unit tests for salt-based derivation, encrypted metadata, and KeyRotator fix
- [ ] Integration test: two clients exchange encrypted messages via passphrase room
- [ ] E2E test: full passphrase room join + file transfer flow in browser

## Language & Framework Caveats

### JavaScript (Frontend)

1. **Web Crypto API is async** — All `crypto.subtle.*` calls return Promises. The `deriveRoomKey` signature change is backward-incompatible (new required param) but callers already `await` it.

2. **`crypto.getRandomValues()` limit** — Max 65,536 bytes per call. 32 bytes is well within limits.

3. **Base64 encoding** — The codebase uses manual `btoa`/`atob` conversion (not `Buffer`). New salt encoding must use the same `uint8ToBase64`/`base64ToUint8` helpers.

4. **Vitest + jsdom** — Tests run in jsdom which provides `crypto.subtle` via Node's `webcrypto`. No special setup needed.

5. **Media payload size** — Encrypting metadata inside the chunk increases payload by ~100 bytes (JSON overhead for filename/mime). Well within the 1MB frame limit.

### Go (Gateway)

1. **`sync.RWMutex` discipline** — The `Room` struct is protected by `Store.mu`. Adding `Salt []byte` follows the same pattern — write under `Lock()`, read under `RLock()`.

2. **`json.Unmarshal` of `JoinPayload`** — Currently ignores unknown fields (default Go behavior). Adding `Salt string` to `JoinPayload` is backward-compatible for parsing.

3. **Base64 in JSON** — Go's `encoding/json` automatically base64-encodes `[]byte` fields. The `Salt []byte` field in `PresencePayload` will serialize as a base64 string.

4. **No logging of salt** — Ensure `slog` calls in the join handler don't log the salt value.

## Roadmap

### Overview

```
Milestone 1 (Salt Exchange) → Milestone 2 (File Metadata) → Milestone 3 (KeyRotator + Tests)
```

All sequential — M2 needs working key derivation from M1, M3 tests all changes.

---

### Milestone 1: Salt Exchange Protocol

**Goal:** Passphrase rooms use random 32-byte salt exchanged via gateway
**Entry criteria:** Current code, all tests passing
**Exit criteria:** Two clients can join a passphrase room, receive the same salt, derive the same key, and exchange encrypted messages

**Tasks:**

1. [ ] **Go: Add `Salt` field to `Room` struct** (`pkgs/go/storage/storage.go:9-15`)
   - Add `Salt []byte` to `Room`
   - No new methods needed — salt is set during `JoinWithTTL`

2. [ ] **Go: Add `Salt` to `JoinPayload` and `PresencePayload`** (`pkgs/go/protocol/protocol.go:46-52, 66-70`)
   - `JoinPayload`: add `Salt string \`json:"salt,omitempty"\``
   - `PresencePayload`: add `Salt string \`json:"salt,omitempty"\``

3. [ ] **Go: Update `JoinWithTTL` to accept and store salt** (`pkgs/go/storage/storage.go:36-54`)
   - New signature: `JoinWithTTL(room, peerID string, ttlSeconds int64, salt []byte) (int, bool)`
   - On new room: store salt if provided
   - On existing room: ignore incoming salt (first-writer-wins)
   - Return salt via a new method `RoomSalt(room string) []byte`

4. [ ] **Go: Update gateway join handler** (`services/gateway/cmd/gateway/main.go:1036-1091`)
   - Parse `jp.Salt` from join payload (base64-decode)
   - Pass to `JoinWithTTL`
   - Include salt in `broadcastPresence` payload

5. [ ] **Go: Update `broadcastPresence`** (`services/gateway/cmd/gateway/main.go:1356-1380`)
   - Read salt via `store.RoomSalt(room)`
   - Set `pp.Salt` if non-nil (base64-encode)

6. [ ] **JS: Update `deriveRoomKey` signature** (`apps/trapchat/src/lib/crypto.js:60-91`)
   - New signature: `deriveRoomKey(roomName, passphrase, salt)`
   - `salt` is `Uint8Array(32)`, required
   - Combined salt: `salt || SHA-256(pepper + roomName)` = 64 bytes

7. [ ] **JS: Update `handleJoinRoom` in App.jsx** (`apps/trapchat/src/App.jsx:340-364`)
   - If passphrase mode and creating room: generate salt, include in join payload
   - After receiving presence: extract salt, pass to `deriveRoomKey`
   - Store salt alongside key in room state for reconnection

8. [ ] **JS: Handle salt on reconnect** (`apps/trapchat/src/socket/client.js` reconnect logic)
   - On reconnect, re-join sends the stored salt (gateway will ignore it since room exists)
   - On presence response, re-derive key with received salt

9. [ ] **Go: Update storage tests** (`pkgs/go/storage/storage_test.go`)
   - Test salt storage and retrieval
   - Test first-writer-wins behavior

**Estimated scope:** Medium
**Key risks:** Breaking existing join flow if salt param handling is wrong
**Dependencies:** None (first milestone)

---

### Milestone 2: Encrypt File Metadata

**Goal:** `fileName`, `mimeType`, `fileSize` are encrypted inside the E2E chunk payload
**Entry criteria:** Milestone 1 complete
**Exit criteria:** Network capture shows no plaintext file metadata in WebSocket frames

**Tasks:**

1. [ ] **JS: Create `encryptMediaEnvelope` / `decryptMediaEnvelope`** (`apps/trapchat/src/lib/crypto.js`)
   - `encryptMediaEnvelope(key, chunkData, metadata)` — encrypts `{fileName, mimeType, fileSize, data}` as a single blob
   - `decryptMediaEnvelope(key, ciphertext)` — returns `{chunkData, metadata}`
   - Uses existing `encrypt`/`decrypt` internally

2. [ ] **JS: Update `sendMedia`** (`apps/trapchat/src/lib/media.js:67-107`)
   - Replace separate `encryptBytes(key, chunkData)` + plaintext metadata JSON with single `encryptMediaEnvelope`
   - Wire format becomes: `{ transferId, seq, total, chunk: "<encrypted envelope>" }`
   - `mimeType`, `fileName`, `fileSize` move inside the encrypted envelope

3. [ ] **JS: Update `MediaAssembler.handleChunk`** (`apps/trapchat/src/lib/media.js:138-233`)
   - After decrypting chunk, parse metadata from the decrypted envelope
   - Extract `fileName`, `mimeType`, `fileSize` from decrypted data instead of outer JSON

4. [ ] **JS: Update `sendCanvas`** (`apps/trapchat/src/lib/media.js:117-123`)
   - No change needed — delegates to `sendMedia` which handles encryption

**Estimated scope:** Small
**Key risks:** Breaking media transfer if envelope format is wrong
**Dependencies:** Milestone 1 (needs working key for testing)

---

### Milestone 3: KeyRotator Fix + All Tests

**Goal:** Fix timer leak, write comprehensive tests for all changes
**Entry criteria:** Milestones 1 and 2 complete
**Exit criteria:** All tests pass, no regressions

**Tasks:**

1. [ ] **JS: Fix `KeyRotator.start()` timer leak** (`apps/trapchat/src/lib/crypto.js:153-155`)
   - Add `this.stop()` at the top of `start()` to clear any existing timer

2. [ ] **JS: Unit test — `deriveRoomKey` with salt** (`apps/trapchat/src/lib/__tests__/crypto.test.js`)
   - Same salt + same passphrase → same key
   - Different salt + same passphrase → different key
   - Verify combined salt is 64 bytes (check via known test vector)

3. [ ] **JS: Unit test — `encryptMediaEnvelope` round-trip** (`apps/trapchat/src/lib/__tests__/crypto.test.js`)
   - Encrypt metadata + chunk data, decrypt, verify all fields preserved
   - Verify ciphertext does not contain plaintext metadata

4. [ ] **JS: Unit test — `KeyRotator.start()` double-call** (`apps/trapchat/src/lib/__tests__/crypto.test.js`)
   - Call `start()` twice, verify only one interval is active (use `vi.useFakeTimers`)

5. [ ] **Go: Unit test — salt in storage** (`pkgs/go/storage/storage_test.go`)
   - `JoinWithTTL` with salt stores it
   - Second `JoinWithTTL` with different salt preserves first salt
   - `RoomSalt` returns nil for rooms without salt
   - Salt is cleared when room is deleted

6. [ ] **JS: Integration test — salt exchange flow**
   - Mock or live WebSocket: client sends join with salt, receives presence with salt
   - Two clients derive same key and successfully encrypt/decrypt

7. [ ] **E2E: Passphrase room join + file transfer**
   - Playwright/Cypress test against Docker Compose
   - Client A creates passphrase room, Client B joins with same passphrase
   - Client A sends file, Client B receives it
   - Verify no plaintext metadata in network tab

8. [ ] **Verify all existing tests still pass**
   - `cd apps/trapchat && npx vitest run`
   - `cd pkgs/go/storage && go test ./...`
   - `cd services/gateway && go test ./...`

**Estimated scope:** Medium
**Key risks:** E2E test environment setup complexity
**Dependencies:** Milestones 1 and 2

## Risks & Mitigations

| Risk | Impact | Likelihood | Mitigation | Contingency |
|------|--------|-----------|------------|-------------|
| Salt not received before key derivation (race) | Blocks — can't decrypt | Medium | Derive key only after presence response confirms salt | Add explicit salt request message |
| Reconnect loses salt context | Messages undecryptable after reconnect | Medium | Store salt in room state map alongside key | Re-derive from presence on reconnect |
| `JoinWithTTL` signature change breaks gateway tests | Blocks CI | Low | Update all callers in same commit | Add salt as optional pointer param |
| Encrypted metadata increases chunk size beyond relay limit | Media transfer fails | Low | Metadata adds ~100 bytes, well under 1MB limit | Compress metadata JSON |
| PBKDF2 600k iterations too slow on very old devices | Poor UX | Low | Accept per stakeholder decision | Reduce to 300k with user toggle |
| E2E test environment flaky | Delays M3 | Medium | Start with unit + integration, add E2E last | Ship without E2E, add in follow-up |

## Open Questions

1. **Reconnect salt handling:** Should the client cache the salt locally and re-send on reconnect, or always rely on the presence response? (Recommendation: cache locally, presence is the source of truth on conflict)

2. **Multi-gateway salt consistency:** If running multiple gateway instances, the salt is only in one gateway's memory. The relay doesn't carry salt. Is this a problem? (Answer: No — rooms are hash-routed to a single relay, and in practice TrapChat runs a single gateway)

3. **`deriveRoomKey` backward compat in tests:** Existing tests call `deriveRoomKey('room', 'pass')` without salt. These must be updated to pass a salt. (Decision: update all call sites, clean break)

## References

- `docs/specs/SPEC-001-crypto-hardening.md` — Full specification
- `REVIEW.md` — Original code review findings
- NIST SP 800-132 — Recommendation for Password-Based Key Derivation
- OWASP Password Storage Cheat Sheet — PBKDF2 iteration recommendations

## File Change Summary

| File | Change Type | Description |
|------|-------------|-------------|
| `pkgs/go/storage/storage.go` | Edit | Add `Salt []byte` to `Room`, update `JoinWithTTL`, add `RoomSalt()` |
| `pkgs/go/storage/storage_test.go` | Edit | Add salt storage tests |
| `pkgs/go/protocol/protocol.go` | Edit | Add `Salt` to `JoinPayload` and `PresencePayload` |
| `services/gateway/cmd/gateway/main.go` | Edit | Parse/store/return salt in join handler and broadcastPresence |
| `apps/trapchat/src/lib/crypto.js` | Edit | Update `deriveRoomKey` signature, add media envelope helpers, fix KeyRotator |
| `apps/trapchat/src/lib/media.js` | Edit | Encrypt metadata inside chunk payload |
| `apps/trapchat/src/App.jsx` | Edit | Generate/receive salt in join flow |
| `apps/trapchat/src/lib/__tests__/crypto.test.js` | Edit | New tests for salt, metadata encryption, KeyRotator |
