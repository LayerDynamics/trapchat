#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "=== stopping services ==="
pkill -f "trapchat-relay" 2>/dev/null || true
pkill -f "cmd/gateway" 2>/dev/null || true
pkill -f "worker/src/index" 2>/dev/null || true

echo "=== removing build artifacts ==="
rm -rf "$ROOT/target"
rm -f "$ROOT/services/gateway/gateway"

read -p "remove node_modules? [y/N] " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
  rm -rf "$ROOT/node_modules"
  rm -rf "$ROOT/apps/trapchat/node_modules"
fi

echo "=== cleanup complete ==="
