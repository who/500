#!/usr/bin/env bash
# Run Hard-vs-Hard self-play ON Railway (learner service) and upload the
# GameRecords to the fh-play-logs bucket.
#
# Laptop:
#   ./scripts/railway-sim.sh                  # 20 HHHH games
#   ./scripts/railway-sim.sh --games 50 --up  # upload this checkout first
#
# Do not pass --play yourself — the trigger sets that as the learner start
# command so the games execute inside the Railway container.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PROJECT_ID="4c5c501b-5450-444f-81ea-f65588801a53"
ENVIRONMENT_ID="9f5a788a-052e-404e-8b7b-ef3c562ac297"
LEARNER="learner"
CALIBRATE_CMD='pnpm learn:calibrate -- --store --upload --confirm-games 80'

GAMES=20
POLICIES="HHHH"
SEED=1
MEMORY=""
PLAY=0
UP=0

usage() {
  cat <<'EOF'
Usage: scripts/railway-sim.sh [--up] [--games N] [--policies E|M|H{4}] [--seed N] [--memory N]

Starts N finished bot games on the Railway learner service (not on this
laptop) and putGame-uploads them to fh-play-logs.

  --games N       finished games (default 20)
  --policies XXXX E/M/H per seat (default HHHH)
  --seed N        sim seed (default 1; also used as --memory if omitted)
  --memory N      forgetting-curve seed (default: same as --seed)
  --up            railway up the learner so this script is on the image
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --play) PLAY=1; shift ;;
    --up) UP=1; shift ;;
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

upload_jsonl() {
  local path="$1"
  FH_UPLOAD_JSONL="$path" "$ROOT/packages/bots/node_modules/.bin/tsx" \
    "$ROOT/scripts/upload-corpus.mts"
}

play_here() {
  local log="/tmp/fh-sim-${GAMES}-${POLICIES}-${SEED}.jsonl"
  rm -f "$log"
  echo "sim: ${GAMES} games policies=${POLICIES} seed=${SEED} memory=${MEMORY} -> ${log}"
  pnpm --filter @five-hundred/bots sim -- \
    --games "$GAMES" \
    --policies "$POLICIES" \
    --seed "$SEED" \
    --memory "$MEMORY" \
    --log "$log"
  upload_jsonl "$log"
}

set_start() {
  local cmd="$1"
  local msg="$2"
  railway environment edit \
    --project "$PROJECT_ID" \
    --environment "$ENVIRONMENT_ID" \
    --service-config "$LEARNER" deploy.startCommand "$cmd" \
    -m "$msg"
}

restore_calibrate() {
  set_start "$CALIBRATE_CMD" "restore learner calibrate start command" || true
}

if [[ "$PLAY" -eq 1 ]]; then
  play_here
  exit 0
fi

if ! command -v railway >/dev/null 2>&1; then
  echo "railway CLI not found" >&2
  exit 1
fi

PLAY_CMD="bash scripts/railway-sim.sh --play --games ${GAMES} --policies ${POLICIES} --seed ${SEED} --memory ${MEMORY}"

trap restore_calibrate EXIT

echo "pointing ${LEARNER} start command at: ${PLAY_CMD}"
set_start "$PLAY_CMD" "one-off sim ${GAMES} ${POLICIES}"

if [[ "$UP" -eq 1 ]]; then
  echo "uploading this checkout to ${LEARNER}…"
  railway up --project "$PROJECT_ID" --environment "$ENVIRONMENT_ID" \
    --service "$LEARNER" --ci -m "sim ${GAMES} ${POLICIES} seed=${SEED}"
else
  echo "restarting ${LEARNER} (pass --up if this script is not on the image yet)…"
  railway restart --project "$PROJECT_ID" --environment "$ENVIRONMENT_ID" \
    --service "$LEARNER" --yes
fi

echo "waiting 8s for the container to start…"
sleep 8
echo "--- learner logs ---"
railway logs --project "$PROJECT_ID" --environment "$ENVIRONMENT_ID" \
  --service "$LEARNER" --lines 200 || true
echo "--- end logs ---"
echo "restore calibrate start command on exit."
echo "watch more: railway logs --service ${LEARNER}"
echo "then: ./scripts/railway-learn.sh"
