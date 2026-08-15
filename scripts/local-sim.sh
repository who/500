#!/usr/bin/env bash
# Play finished bot-vs-bot games on this machine and append a GameRecord JSONL.
#
#   ./scripts/local-sim.sh
#   ./scripts/local-sim.sh --games 50 --policies HHHH --seed 7
#   ./scripts/local-sim.sh --games 20 --log /tmp/sim.jsonl
#
# Then: ./scripts/local-upload.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

GAMES=20
POLICIES="HHHH"
SEED=1
MEMORY=""
LOG="logs/games/sim-local.jsonl"

usage() {
  cat <<'EOF'
Usage: scripts/local-sim.sh [--games N] [--policies E|M|H{4}] [--seed N] [--memory N] [--log PATH]

Plays N finished bot games on this laptop (not Railway) and appends one
GameRecord per game to a JSONL file.

  --games N       finished games (default 20)
  --policies XXXX E/M/H per seat (default HHHH)
  --seed N        sim seed (default 1; also used as --memory if omitted)
  --memory N      forgetting-curve seed (default: same as --seed)
  --log PATH      JSONL path (default logs/games/sim-local.jsonl)
                  A sibling .log gets the full play-by-play (who won each
                  trick and each game). Stdout prints one winner line per game.

Upload that file with: ./scripts/local-upload.sh [--in PATH]
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --games)
      GAMES="${2:?--games needs a number}"
      shift 2
      ;;
    --policies)
      POLICIES="${2:?--policies needs EMH letters}"
      shift 2
      ;;
    --seed)
      SEED="${2:?--seed needs a number}"
      shift 2
      ;;
    --memory)
      MEMORY="${2:?--memory needs a number}"
      shift 2
      ;;
    --log)
      LOG="${2:?--log needs a path}"
      shift 2
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "unknown arg: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ -z "$MEMORY" ]]; then
  MEMORY="$SEED"
fi
if [[ ! "$GAMES" =~ ^[0-9]+$ ]] || [[ "$GAMES" -lt 1 ]]; then
  echo "--games must be a positive integer" >&2
  exit 2
fi
if [[ ! "$POLICIES" =~ ^[EMH]{4}$ ]]; then
  echo "--policies must be 4 letters from E/M/H, got $POLICIES" >&2
  exit 2
fi

# pnpm --filter runs the sim with cwd packages/bots, so a relative --log
# would land under that package. Always pass an absolute path.
if [[ "$LOG" != /* ]]; then
  LOG="$ROOT/$LOG"
fi
mkdir -p "$(dirname "$LOG")"
echo "sim: ${GAMES} games policies=${POLICIES} seed=${SEED} memory=${MEMORY} -> ${LOG}"
pnpm --filter @five-hundred/bots sim -- \
  --games "$GAMES" \
  --policies "$POLICIES" \
  --seed "$SEED" \
  --memory "$MEMORY" \
  --log "$LOG"

if [[ "$LOG" == *.jsonl ]]; then
  PLAY_LOG="${LOG%.jsonl}.log"
else
  PLAY_LOG="${LOG}.log"
fi
echo "summarizing plays and winners…"
FH_PLAY_LOG="$(cd "$(dirname "$PLAY_LOG")" && pwd)/$(basename "$PLAY_LOG")"
JSONL_ABS="$(cd "$(dirname "$LOG")" && pwd)/$(basename "$LOG")"
FH_PLAY_LOG="$FH_PLAY_LOG" "$ROOT/packages/bots/node_modules/.bin/tsx" \
  "$ROOT/scripts/summarize-corpus.mts" "$JSONL_ABS"
echo "next: ./scripts/local-upload.sh --in ${LOG}"
