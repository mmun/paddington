#!/usr/bin/env bash
set -euo pipefail

TRACKER_SERVICE="${WALKINGPAD_TRACKER_SERVICE:-walkingpad.service}"
REMOTE_ADDRESS="${WALKINGPAD_REMOTE_ADDRESS:-C1:00:00:00:30:3F}"
REMOTE_NAME="${WALKINGPAD_REMOTE_NAME:-KS-REMOTE-01}"
WAKE_SECONDS="${WALKINGPAD_WAKE_SECONDS:-10}"
WAKE_ADV_DATA="${WALKINGPAD_WAKE_ADV_DATA:-0201060303F0FF07FFC1000000303F}"
WAKE_SCAN_RSP="${WALKINGPAD_WAKE_SCAN_RSP:-0D094B532D52454D4F54452D3031}"

log() {
  printf '%s %s\n' "$(date -Is)" "$*"
}

if [[ "${EUID}" -eq 0 ]]; then
  SUDO=()
else
  SUDO=(sudo)
fi

btmgmt_bounded() {
  "${SUDO[@]}" timeout 8s btmgmt "$@"
}

restore_remote_identity() {
  log "keeping remote identity ${REMOTE_ADDRESS} / ${REMOTE_NAME}"
  btmgmt_bounded rm-adv 1 >/dev/null 2>&1 || true
  btmgmt_bounded name "$REMOTE_NAME" >/dev/null 2>&1 || true
  bluetoothctl system-alias "$REMOTE_NAME" >/dev/null 2>&1 || true
}

trap 'restore_remote_identity; sudo systemctl start "$TRACKER_SERVICE" >/dev/null 2>&1 || true' EXIT

log "stopping ${TRACKER_SERVICE}"
"${SUDO[@]}" systemctl stop "$TRACKER_SERVICE" || true
bluetoothctl disconnect 54:50:A0:10:4E:84 >/dev/null 2>&1 || true

log "using remote identity ${REMOTE_ADDRESS} / ${REMOTE_NAME}"
btmgmt_bounded name "$REMOTE_NAME" >/dev/null 2>&1 || true
bluetoothctl system-alias "$REMOTE_NAME" >/dev/null 2>&1 || true

log "advertising captured remote wake payload for ${WAKE_SECONDS}s"
btmgmt_bounded rm-adv 1 >/dev/null 2>&1 || true
btmgmt_bounded add-adv -d "$WAKE_ADV_DATA" -s "$WAKE_SCAN_RSP" -t "$WAKE_SECONDS" 1
sleep "$WAKE_SECONDS"
btmgmt_bounded rm-adv 1 >/dev/null 2>&1 || true

log "wake advertisement complete"
