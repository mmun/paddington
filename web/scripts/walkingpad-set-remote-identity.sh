#!/usr/bin/env bash
set -euo pipefail

REMOTE_ADDRESS="${WALKINGPAD_REMOTE_ADDRESS:-C1:00:00:00:30:3F}"
REMOTE_NAME="${WALKINGPAD_REMOTE_NAME:-KS-REMOTE-01}"

if [[ "${EUID}" -eq 0 ]]; then
  SUDO=()
else
  SUDO=(sudo)
fi

"${SUDO[@]}" timeout 5s btmgmt clr-adv >/dev/null 2>&1 || true
"${SUDO[@]}" timeout 5s btmgmt rm-adv 1 >/dev/null 2>&1 || true
"${SUDO[@]}" timeout 8s btmgmt power off || true
sleep 2
"${SUDO[@]}" timeout 8s btmgmt public-addr "$REMOTE_ADDRESS" || true
sleep 2
"${SUDO[@]}" timeout 8s btmgmt power on
sleep 1

"${SUDO[@]}" timeout 5s btmgmt name "$REMOTE_NAME" >/dev/null 2>&1 || true
bluetoothctl system-alias "$REMOTE_NAME" >/dev/null 2>&1 || true
