#!/usr/bin/env bash
set -euo pipefail

# E2E pipeline integration test
# Starts gateway + worker, submits jobs, polls results, verifies dead-letters, cleans up
# Requires: curl, jq

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

GATEWAY_PORT=18080
WORKER_PORT=19100

# Verify jq is available
if ! command -v jq &>/dev/null; then
  echo "FAIL: jq is required but not installed"
  exit 1
fi

cleanup() {
  echo "cleaning up..."
  [ -n "${GATEWAY_PID:-}" ] && kill "$GATEWAY_PID" 2>/dev/null || true
  [ -n "${WORKER_PID:-}" ] && kill "$WORKER_PID" 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup EXIT

echo "=== Building gateway ==="
cd "$ROOT_DIR/services/gateway"
go build -o "$ROOT_DIR/target/gateway-test" ./cmd/gateway

GATEWAY_URL="http://localhost:$GATEWAY_PORT"
WORKER_URL="http://localhost:$WORKER_PORT"

wait_for_health() {
  local url="$1" name="$2"
  for i in $(seq 1 15); do
    if curl -sf --max-time 2 "$url/health" > /dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  echo "FAIL: $name did not become healthy within 15s"
  exit 1
}

echo "=== Starting gateway on :$GATEWAY_PORT ==="
GATEWAY_PORT=$GATEWAY_PORT "$ROOT_DIR/target/gateway-test" &
GATEWAY_PID=$!
wait_for_health "$GATEWAY_URL" "gateway"

echo "=== Starting worker on :$WORKER_PORT ==="
cd "$ROOT_DIR/services/worker"
WORKER_PORT=$WORKER_PORT node src/index.js &
WORKER_PID=$!
wait_for_health "$WORKER_URL" "worker"

# Test 1: Gateway health
echo "--- Test 1: Gateway health ---"
STATUS=$(curl -sf "$GATEWAY_URL/health" | jq -r '.status')
if [ "$STATUS" != "ok" ]; then
  echo "FAIL: gateway health check"
  exit 1
fi
echo "PASS: gateway health"

# Test 2: Worker health
echo "--- Test 2: Worker health ---"
STATUS=$(curl -sf "$WORKER_URL/health" | jq -r '.status')
if [ "$STATUS" != "ok" ]; then
  echo "FAIL: worker health check"
  exit 1
fi
echo "PASS: worker health"

# Test 3: Empty rooms list
echo "--- Test 3: Empty rooms list ---"
ROOM_COUNT=$(curl -sf "$GATEWAY_URL/api/rooms" | jq -r '.count')
if [ "$ROOM_COUNT" != "0" ]; then
  echo "FAIL: expected 0 rooms, got $ROOM_COUNT"
  exit 1
fi
echo "PASS: empty rooms"

# Test 4: Submit media:chunk job to worker
echo "--- Test 4: Submit media:chunk job ---"
PAYLOAD=$(echo -n "hello world test" | base64)
JOB_RESP=$(curl -sf -X POST "$WORKER_URL/jobs" \
  -H "Content-Type: application/json" \
  -d "{\"type\":\"media:chunk\",\"data\":{\"payload\":\"$PAYLOAD\",\"chunkSize\":5,\"roomId\":\"test\"}}")
JOB_ID=$(echo "$JOB_RESP" | jq -r '.id // empty')
if [ -z "$JOB_ID" ]; then
  echo "FAIL: no job ID returned"
  exit 1
fi
echo "PASS: job submitted ($JOB_ID)"

# Test 5: Poll for job completion — verify status is "completed"
echo "--- Test 5: Poll job result ---"
MAX_RETRIES=10
for i in $(seq 1 $MAX_RETRIES); do
  JOB_STATUS=$(curl -sf "$WORKER_URL/jobs/$JOB_ID" | jq -r '.status // empty' 2>/dev/null || echo "")
  if [ "$JOB_STATUS" = "completed" ]; then
    break
  fi
  sleep 1
done
if [ "$JOB_STATUS" != "completed" ]; then
  echo "FAIL: expected job status 'completed', got '$JOB_STATUS' after ${MAX_RETRIES}s"
  exit 1
fi
echo "PASS: job completed ($JOB_ID)"

# Test 6: Submit invalid job and verify it lands in dead-letter queue
echo "--- Test 6: Submit invalid job + verify dead-letter ---"
BOGUS_RESP=$(curl -sf -X POST "$WORKER_URL/jobs" \
  -H "Content-Type: application/json" \
  -d '{"type":"bogus","data":{}}')
BOGUS_ID=$(echo "$BOGUS_RESP" | jq -r '.id // empty')

# Wait for retries to exhaust (3 attempts with backoff)
for i in $(seq 1 10); do
  DL_COUNT=$(curl -sf "$WORKER_URL/dead-letters" | jq '.deadLetters | length' 2>/dev/null || echo 0)
  [ "$DL_COUNT" -gt 0 ] && break
  sleep 1
done

if [ "$DL_COUNT" -lt 1 ]; then
  echo "FAIL: expected at least 1 dead-letter entry, got $DL_COUNT"
  exit 1
fi

# Verify the bogus job is in dead letters
DL_HAS_BOGUS=$(curl -sf "$WORKER_URL/dead-letters" | jq -r 'if (.deadLetters // [] | map(select(.type == "bogus")) | length) > 0 then "yes" else "no" end')
if [ "$DL_HAS_BOGUS" != "yes" ]; then
  echo "FAIL: bogus job not found in dead-letter queue"
  exit 1
fi
echo "PASS: invalid job correctly dead-lettered"

echo ""
echo "=== All integration tests passed ==="
