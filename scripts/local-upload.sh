#!/usr/bin/env bash
# Upload a local sim JSONL into fh-play-logs, then run learn:calibrate with
# --store --upload so a promote writes overlay + calibration artifacts.
#
#   ./scripts/local-sim.sh --games 50
#   ./scripts/local-upload.sh
#   ./scripts/local-upload.sh --in logs/games/sim-local.jsonl --confirm-games 80
#
# Uses `railway run --service learner` so AWS store credentials stay on
# Railway. The games themselves already ran on this machine.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PROJECT_ID="4c5c501b-5450-444f-81ea-f65588801a53"
ENVIRONMENT_ID="9f5a788a-052e-404e-8b7b-ef3c562ac297"
LEARNER="learner"

IN_ENV=0
JSONL="logs/games/sim-local.jsonl"
CONFIRM_GAMES=80

usage() {
  cat <<'EOF'
Usage: scripts/local-upload.sh [--in PATH] [--confirm-games N]

Reads a local GameRecord JSONL (from scripts/local-sim.sh), putGames every
record into the Railway fh-play-logs bucket, then runs:

  pnpm learn:calibrate -- --in PATH --store --upload --confirm-games N

Store credentials come from `railway run --service learner`. A thin corpus
or SPRT reject still leaves the uploaded games in the bucket.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --in-env) IN_ENV=1; shift ;;
    --in)
      JSONL="${2:?--in needs a path}"
      shift 2
      ;;
    --confirm-games)
      CONFIRM_GAMES="${2:?--confirm-games needs a number}"
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

if [[ ! "$CONFIRM_GAMES" =~ ^[0-9]+$ ]] || [[ "$CONFIRM_GAMES" -lt 1 ]]; then
  echo "--confirm-games must be a positive integer" >&2
  exit 2
fi

# Relative --in paths are from the repo root; railway run keeps that cwd.
if [[ "$JSONL" != /* ]]; then
  JSONL="$ROOT/$JSONL"
fi
if [[ ! -f "$JSONL" ]]; then
  fallback="$ROOT/packages/bots/logs/games/$(basename "$JSONL")"
  if [[ -f "$fallback" ]]; then
    echo "using corpus at $fallback (sim cwd was packages/bots)"
    JSONL="$fallback"
  fi
fi

upload_and_calibrate() {
  if [[ ! -f "$JSONL" ]]; then
    echo "no corpus at $JSONL — run ./scripts/local-sim.sh first" >&2
    echo "if you already simmed, try: --in packages/bots/logs/games/$(basename "$JSONL")" >&2
    exit 1
  fi

  echo "uploading ${JSONL} into fh-play-logs…"
  # Repo-relative imports (same as summarize-corpus.mts). A /tmp scratch
  # file cannot resolve @five-hundred/learn.
  FH_UPLOAD_JSONL="$JSONL" "$ROOT/packages/bots/node_modules/.bin/tsx" \
    "$ROOT/scripts/upload-corpus.mts"

  echo "calibrate --in ${JSONL} --store --upload --confirm-games ${CONFIRM_GAMES}"
  pnpm learn:calibrate -- --in "$JSONL" --store --upload --confirm-games "$CONFIRM_GAMES"
}

if [[ "$IN_ENV" -eq 1 ]]; then
  upload_and_calibrate
  exit 0
fi

if ! command -v railway >/dev/null 2>&1; then
  echo "railway CLI not found" >&2
  exit 1
fi

exec railway run \
  --project "$PROJECT_ID" \
  --environment "$ENVIRONMENT_ID" \
  --service "$LEARNER" \
  -- "$0" --in-env --in "$JSONL" --confirm-games "$CONFIRM_GAMES"
