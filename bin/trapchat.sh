#!/usr/bin/env bash
set -euo pipefail

PIDS=()

cleanup() {
  echo ""
  echo "shutting down..."
  for pid in "${PIDS[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait
  echo "all services stopped"
}

trap cleanup EXIT INT TERM

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "=== starting trapchat services ==="

# Gateway
(cd "$ROOT/services/gateway" && go run ./cmd/gateway) &
PIDS+=($!)
echo "gateway started (pid ${PIDS[-1]})"

# Relay
(cd "$ROOT" && cargo run -p trapchat-relay) &
PIDS+=($!)
echo "relay started (pid ${PIDS[-1]})"

# Worker
node "$ROOT/services/worker/src/index.js" &
PIDS+=($!)
echo "worker started (pid ${PIDS[-1]})"

# Frontend
(cd "$ROOT/apps/trapchat" && npx vite --port 3000) &
PIDS+=($!)
echo "frontend started (pid ${PIDS[-1]})"

echo ""
echo "=== all services running ==="
echo "  gateway:  http://localhost:8080"
echo "  relay:    ws://localhost:9000"
echo "  worker:   http://localhost:9100"
echo "  frontend: http://localhost:3000"
echo ""
echo "press Ctrl+C to stop all services"

wait
