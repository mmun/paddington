#!/usr/bin/env bash
set -euo pipefail

PI_HOST="${PI_HOST:-pi@raspberrypi.local}"
PI_DIR="${PI_DIR:-/home/pi/walkingpad/ble-debugger}"
APP_HOST="${HOST:-0.0.0.0}"
APP_PORT="${PORT:-8787}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCAL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "==> Syncing $LOCAL_DIR -> $PI_HOST:$PI_DIR"
ssh "$PI_HOST" "mkdir -p '$PI_DIR'"
rsync -az --delete \
  --exclude node_modules \
  --exclude .DS_Store \
  "$LOCAL_DIR/" "$PI_HOST:$PI_DIR/"

echo "==> Installing dependencies and restarting server on $PI_HOST"
ssh "$PI_HOST" \
  "PI_DIR='$PI_DIR' APP_HOST='$APP_HOST' APP_PORT='$APP_PORT' bash -s" <<'REMOTE'
set -euo pipefail

cd "$PI_DIR"
LOG="$PI_DIR/server.log"
PIDFILE="$PI_DIR/server.pid"

npm install --omit=optional

if [ -f "$PIDFILE" ]; then
  OLD_PID="$(cat "$PIDFILE" 2>/dev/null || true)"
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "Stopping previous server pid=$OLD_PID"
    kill "$OLD_PID" 2>/dev/null || true
    for _ in 1 2 3 4 5; do
      kill -0 "$OLD_PID" 2>/dev/null || break
      sleep 0.2
    done
  fi
fi

pkill -f "$PI_DIR/src/server.js" 2>/dev/null || true

if command -v fuser >/dev/null 2>&1; then
  fuser -k "$APP_PORT/tcp" 2>/dev/null || true
elif command -v lsof >/dev/null 2>&1; then
  for LISTENER_PID in $(lsof -ti tcp:"$APP_PORT" -sTCP:LISTEN 2>/dev/null || true); do
    kill "$LISTENER_PID" 2>/dev/null || true
  done
fi

sleep 0.5

echo "Starting server on $APP_HOST:$APP_PORT"
HOST="$APP_HOST" PORT="$APP_PORT" NODE_ENV=production nohup node src/server.js > "$LOG" 2>&1 &
NEW_PID="$!"
echo "$NEW_PID" > "$PIDFILE"
sleep 1

if ! kill -0 "$NEW_PID" 2>/dev/null; then
  echo "Server failed to stay running. Last log lines:" >&2
  tail -80 "$LOG" >&2 || true
  exit 1
fi

echo "Server pid=$NEW_PID"
echo "Log: $LOG"
echo "URL: http://$(hostname -I | awk '{print $1}'):$APP_PORT"
REMOTE
