#!/usr/bin/env bash
# Local A/B: weaker left bower vs equal bowers, Hard-vs-Hard sim.
#
#   ./scripts/ab-bower.sh
#   ./scripts/ab-bower.sh --games 80 --seed 7
#   ./scripts/ab-bower.sh --right 0.95 --left 0.90 --equal 0.95
#   ./scripts/ab-bower.sh --strength-only
#   ./scripts/ab-bower.sh --memory-only
#
# Side A = split (right/left). Side B = equal. Each seed is mirrored so
# the first-bidder edge cancels. Prints an SPRT verdict (same gate as
# learn:tune). Does not write an overlay and does not touch Railway.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

exec pnpm --filter @five-hundred/bots ab-bower -- "$@"
