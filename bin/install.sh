#!/usr/bin/env bash
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

check() {
  if command -v "$1" &>/dev/null; then
    echo -e "${GREEN}✓${NC} $1 ($($1 --version 2>&1 | head -1))"
  else
    echo -e "${RED}✗${NC} $1 not found"
    exit 1
  fi
}

echo "=== checking prerequisites ==="
check go
check cargo
check node
check npm

echo ""
echo "=== installing node dependencies ==="
npm install
(cd apps/trapchat && npm install)

echo ""
echo "=== building rust workspace ==="
cargo build

echo ""
echo "=== building go gateway ==="
(cd services/gateway && go build ./cmd/gateway)

echo ""
echo -e "${GREEN}=== install complete ===${NC}"
