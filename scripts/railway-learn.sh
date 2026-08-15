#!/usr/bin/env bash
# Fire one Railway learner run (play-log calibrate against fh-play-logs).
#
#   ./scripts/railway-learn.sh
#
# Restores the calibrate start command (in case a sim left it pointed at
# railway-sim.sh), restarts the learner cron image, and prints recent logs.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PROJECT_ID="4c5c501b-5450-444f-81ea-f65588801a53"
ENVIRONMENT_ID="9f5a788a-052e-404e-8b7b-ef3c562ac297"
LEARNER="learner"
CALIBRATE_CMD='pnpm learn:calibrate -- --store --upload --confirm-games 80'

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  cat <<'EOF'
Usage: scripts/railway-learn.sh

Restarts the Railway learner service with:
  pnpm learn:calibrate -- --store --upload --confirm-games 80
and prints the latest runtime logs. Does not rebuild.
EOF
  exit 0
fi

if ! command -v railway >/dev/null 2>&1; then
  echo "railway CLI not found" >&2
  exit 1
fi

echo "ensuring ${LEARNER} start command is calibrate…"
railway environment edit \
  --project "$PROJECT_ID" \
  --environment "$ENVIRONMENT_ID" \
  --service-config "$LEARNER" deploy.startCommand "$CALIBRATE_CMD" \
  -m "restore learner calibrate start command"

echo "restarting ${LEARNER}…"
railway restart --project "$PROJECT_ID" --environment "$ENVIRONMENT_ID" \
  --service "$LEARNER" --yes

echo "waiting 8s for the container to start…"
sleep 8
echo "--- learner logs ---"
railway logs --project "$PROJECT_ID" --environment "$ENVIRONMENT_ID" \
  --service "$LEARNER" --lines 200 || true
echo "--- end logs ---"
echo "watch more: railway logs --service ${LEARNER}"
