#!/usr/bin/env bash
# Deploy boof to the Mac Mini production instance.
#
# Usage (from boof repo on dev desktop):
#   bash scripts/deploy-mac-mini.sh
#
# Preconditions:
#   - Your latest changes are committed and pushed to origin/main
#   - Tailscale SSH configured (`tailscale ssh bcbuilmac@bcbuils-mac-mini-2` works)
#   - Mac Mini has boof cloned at ~/projects/boof
#   - launchd service `com.nlaroche.boof` is installed at ~/Library/LaunchAgents/
#
# What it does:
#   1. SSH to Mac Mini
#   2. git pull origin main
#   3. npm install --ignore-scripts (new deps only)
#   4. Unload + load the launchd service to pick up new code
#   5. Tail a few log lines to verify it's alive
set -euo pipefail

MAC_HOST="bcbuilmac@bcbuils-mac-mini-2"
REPO_PATH="/Users/bcbuilmac/projects/boof"
PLIST="/Users/bcbuilmac/Library/LaunchAgents/com.nlaroche.boof.plist"
LABEL="com.nlaroche.boof"
LOG_PATH="$REPO_PATH/logs/boof.log"

echo "[deploy] Deploying boof to Mac Mini ($MAC_HOST)..."

# 1. Verify local state first — don't deploy uncommitted/unpushed changes
LOCAL_AHEAD=$(git log origin/main..HEAD --oneline 2>/dev/null | wc -l | tr -d ' ')
LOCAL_DIRTY=$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')
if [ "$LOCAL_AHEAD" != "0" ]; then
  echo "[deploy] ERROR: You have $LOCAL_AHEAD unpushed commit(s). Push first."
  exit 1
fi
if [ "$LOCAL_DIRTY" != "0" ]; then
  echo "[deploy] WARNING: You have uncommitted changes locally. These will NOT be deployed."
  git status --short
  echo ""
fi

LOCAL_SHA=$(git rev-parse origin/main)
echo "[deploy] Local origin/main: $LOCAL_SHA"

# 2. Remote deploy — one SSH round-trip for everything
tailscale ssh "$MAC_HOST" bash -s <<REMOTE
set -euo pipefail
cd "$REPO_PATH"

echo "[remote] Current HEAD: \$(git rev-parse HEAD)"
echo "[remote] Fetching..."
git fetch origin main

# Check for local dirty state on the Mac (shouldn't happen, but be safe)
if [ -n "\$(git status --porcelain)" ]; then
  echo "[remote] WARNING: dirty working tree on Mac Mini:"
  git status --short
  echo "[remote] Stashing before pull..."
  git stash push -m "deploy-mac-mini auto-stash \$(date +%s)"
fi

echo "[remote] Pulling..."
git pull --ff-only origin main
NEW_SHA=\$(git rev-parse HEAD)
echo "[remote] New HEAD: \$NEW_SHA"

if [ "\$NEW_SHA" = "$LOCAL_SHA" ]; then
  echo "[remote] ✓ HEAD matches local origin/main"
else
  echo "[remote] ⚠ HEAD mismatch — expected $LOCAL_SHA, got \$NEW_SHA"
fi

echo "[remote] Installing dependencies (ignore-scripts for sql.js compat)..."
# Use nvm's npm since launchd uses v22.22.2
export PATH="/Users/bcbuilmac/.nvm/versions/node/v22.22.2/bin:\$PATH"
npm install --ignore-scripts --no-audit --no-fund 2>&1 | tail -5

echo "[remote] Restarting launchd service $LABEL..."
launchctl unload "$PLIST" 2>/dev/null || true
sleep 1
launchctl load "$PLIST"
sleep 2

echo "[remote] Checking service status..."
if launchctl list | grep -q "$LABEL"; then
  PID=\$(launchctl list | grep "$LABEL" | awk '{print \$1}')
  echo "[remote] ✓ Service loaded (pid: \$PID)"
else
  echo "[remote] ✗ Service failed to load"
  exit 1
fi

# Check port 3456 is bound
sleep 2
if lsof -iTCP:3456 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "[remote] ✓ Listening on port 3456"
else
  echo "[remote] ⚠ Port 3456 not bound yet — check logs"
fi

echo ""
echo "[remote] Last 15 log lines:"
tail -15 "$LOG_PATH" 2>/dev/null || echo "(no log yet)"
REMOTE

echo ""
echo "[deploy] ✓ Deployment complete"
echo "[deploy] Tail logs:  tailscale ssh $MAC_HOST 'tail -f $LOG_PATH'"
echo "[deploy] Web UI:     http://bcbuils-mac-mini-2:3456  (via Tailscale)"
