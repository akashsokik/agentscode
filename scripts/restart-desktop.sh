#!/bin/sh
# Restart the installed PodCode (macOS) onto the newest build in release/mac-arm64: quit it,
# keep the old app at /tmp/PodCode.app.prev, copy the new one in, open it.
#
#   scripts/restart-desktop.sh              restart now
#   scripts/restart-desktop.sh --when-idle  wait until no agent is mid-turn and no build runs (two
#                                           checks in a row, 30s apart; up to 4 hours), then restart
#
# Run it detached from the app (an agent's own process ends with the app). One waiter at a time:
# the lock is /tmp/podcode-restart-waiter.lock.
#
# Two ways it failed before, both handled here:
# - The app is found by its bundle id through LaunchServices, not a process pattern: pgrep never
#   sees the app's own process, but does match agent CLIs and comms MCP servers that run on its
#   binary and can outlive it a moment, so a quit looked like it had failed (2026-11-09 16:21).
# - Builds before the browser-holder fix hang on quit while an integrated-browser tab is open:
#   the server (so every agent) stops, then the window's close parks the tabs in a hidden window
#   that never closes, and the process ignores Cmd+Q (17:02). Up but with its server gone is that
#   hang: nothing is left to save, so the process is ended. If the server still answers,
#   something else holds the quit (a dialog, say) and the app is left running, untouched.
#
# For tests, PODCODE_APP, PODCODE_PREV, PODCODE_NEW_BUILD, PODCODE_PORT, PODCODE_LOCK and PODCODE_TICK
# (seconds per wait step, default 1) override the defaults; the AGENTSCODE_* names still work.
ROOT=$(cd "$(dirname "$0")/.." && pwd)
BID=com.agentscode.app
APP=${PODCODE_APP:-${AGENTSCODE_APP:-/Applications/PodCode.app}}
# Before 0.3.0 the app was AgentsCode.app, and an auto-update keeps that file name: restart that one
# when there is no PodCode.app.
if [ -z "${PODCODE_APP:-${AGENTSCODE_APP:-}}" ] && [ ! -e "$APP" ] && [ -e /Applications/AgentsCode.app ]; then APP=/Applications/AgentsCode.app; fi
PREV=${PODCODE_PREV:-${AGENTSCODE_PREV:-/tmp/PodCode.app.prev}}
NEW=${PODCODE_NEW_BUILD:-${AGENTSCODE_NEW_BUILD:-$ROOT/release/mac-arm64/PodCode.app}}
PORT=${PODCODE_PORT:-${AGENTSCODE_PORT:-4320}}
LOCK=${PODCODE_LOCK:-${AGENTSCODE_LOCK:-/tmp/podcode-restart-waiter.lock}}
# The lock an AgentsCode-era copy of this script takes; a live waiter holding it counts too.
LEGACY_LOCK=${PODCODE_LEGACY_LOCK:-/tmp/agentscode-restart-waiter.lock}
TICK=${PODCODE_TICK:-${AGENTSCODE_TICK:-1}}
# Read once above; nothing this script starts (the app it opens above all) may inherit them, or
# every agent and terminal in that app would carry these real paths (server/envHygiene.ts lists
# the same names).
unset PODCODE_APP AGENTSCODE_APP PODCODE_PREV AGENTSCODE_PREV PODCODE_NEW_BUILD \
   AGENTSCODE_NEW_BUILD PODCODE_PORT AGENTSCODE_PORT PODCODE_LOCK AGENTSCODE_LOCK \
   PODCODE_LEGACY_LOCK AGENTSCODE_LEGACY_LOCK PODCODE_TICK AGENTSCODE_TICK PODCODE_INSTALL_DIR \
   AGENTSCODE_INSTALL_DIR PODCODE_VERSION AGENTSCODE_VERSION PODCODE_NO_OPEN AGENTSCODE_NO_OPEN

say() { echo "$(date '+%H:%M:%S') $*"; }
wait_ticks() { sleep "$(awk "BEGIN { print $1 * $TICK }")"; }
running() { [ "$(osascript -e "application id \"$BID\" is running" 2>/dev/null)" = "true" ]; }
app_pid() { lsappinfo info -only pid -app "$BID" 2>/dev/null | sed -n 's/.*"pid"=\([0-9][0-9]*\).*/\1/p'; }
# Any answer counts (the health route needs no key; an older server answers it with 404).
server_answers() { curl -s --max-time 3 -o /dev/null "http://127.0.0.1:$PORT/api/health"; }
# The server is gone only when three probes, two steps apart, all go unanswered: one slow answer
# is not enough to end the app.
server_gone() {
  for _ in 1 2 3; do
    server_answers && return 1
    wait_ticks 2
  done
  return 0
}
# Agents working or waiting on the user, from the app's own state; -1 when it does not answer.
# Node, as this repo always has it (python3 can be a shim that asks to install developer tools).
# /api/health (no key needed) gives busyAgents. An app from before it answers that path with its
# page (HTML) or a 404, so only JSON with a numeric busyAgents counts; else ask /api/state, which
# such an app still answers without a key. Each is read on its own (Rhea M1).
busy_agents() {
  health=$(curl -s --max-time 5 "http://127.0.0.1:$PORT/api/health")
  count=$(printf '%s' "$health" | node -e "
let raw = '';
process.stdin.on('data', d => { raw += d; }).on('end', () => {
  try { const h = JSON.parse(raw); if (typeof h.busyAgents === 'number') { console.log(h.busyAgents); return; } } catch {}
  console.log('');
});
" 2>/dev/null)
  if [ -n "$count" ]; then echo "$count"; return; fi
  curl -s --max-time 5 "http://127.0.0.1:$PORT/api/state" | node -e "
let raw = '';
process.stdin.on('data', d => { raw += d; }).on('end', () => {
  try { console.log((JSON.parse(raw).agents ?? []).filter(a => a.status === 'working' || a.status === 'waiting').length); }
  catch { console.log(-1); }
});
" 2>/dev/null || echo -1
}
# The new app's window signed in to its server: /api/health says window:true (server/userAuth.ts).
window_signed_in() { curl -s --max-time 3 "http://127.0.0.1:$PORT/api/health" | grep -q '"window":true'; }
building() { pgrep -f "electron-builder|vite build --outDir|tsconfig.desktop.json" >/dev/null; }
# Waits up to $1 steps for the app to be gone; true when it is.
gone_within() { i=0; while [ "$i" -lt "$1" ]; do running || return 0; wait_ticks 1; i=$((i + 1)); done; ! running; }

restart() {
  if [ ! -x "$NEW/Contents/MacOS/PodCode" ]; then say "No build at $NEW; left as is."; return 1; fi
  # A restart replaces an installed app; a first install is done by hand.
  if [ ! -d "$APP" ]; then say "No app at $APP to replace; install it by hand. Nothing changed."; return 1; fi
  # Only ask a running app to quit, so AppleScript never has to find or start it.
  running && osascript -e "tell application id \"$BID\" to quit" >/dev/null 2>&1
  if ! gone_within 30; then
    # Still stopping its agents (the server has up to 8s), or held by something: give it longer.
    server_answers && gone_within 30
    if running && ! server_gone; then say "PodCode is still running and its server still answers after 60s (a dialog may be open); left as is."; return 1; fi
    if running; then
      pid=$(app_pid)
      say "PodCode stopped its server but did not exit (the browser-holder quit hang); ending process ${pid:-?}."
      if [ -n "$pid" ]; then
        kill -TERM "$pid" 2>/dev/null
        gone_within 10 || { kill -KILL "$pid" 2>/dev/null; gone_within 5; }
      fi
      if running; then say "PodCode would not exit; left as is."; return 1; fi
    fi
  fi
  wait_ticks 2 # its helpers finish exiting
  # The current app must be out of the way first: copying onto a bundle still there would nest
  # the new one inside it (and break its signature). If it cannot move, the old app reopens.
  if ! { rm -rf "$PREV" && mv "$APP" "$PREV"; }; then
    say "Could not move the current app to $PREV; reopening it as it is."
    open "$APP"
    return 1
  fi
  if ! ditto "$NEW" "$APP" || [ ! -x "$APP/Contents/MacOS/PodCode" ]; then
    say "Copying the new build failed; putting the previous one back."
    rm -rf "$APP"
    mv "$PREV" "$APP"
    open "$APP"
    return 1
  fi
  open "$APP"
  i=0; while [ "$i" -lt 30 ] && ! running; do wait_ticks 1; i=$((i + 1)); done
  if ! running; then say "Opened $APP, but it is not running yet."; return 0; fi
  # Its window must sign in to its server (the key hand-off). Without that it shows nothing, so the
  # previous app goes back (Rhea M2).
  i=0; while [ "$i" -lt 60 ] && ! window_signed_in; do wait_ticks 1; i=$((i + 1)); done
  if window_signed_in; then say "Restarted onto $NEW."; return 0; fi
  say "The new app's window never signed in to its server; putting the previous app back."
  osascript -e "tell application id \"$BID\" to quit" >/dev/null 2>&1
  if ! gone_within 30; then pid=$(app_pid); [ -n "$pid" ] && kill "$pid" 2>/dev/null; gone_within 10; fi
  rm -rf "$APP" && mv "$PREV" "$APP"
  open "$APP"
  return 1
}

# One waiter at a time. The lock holds its waiter's pid; a lock whose waiter is gone (killed with
# SIGKILL, say) is taken over. A lock with no pid (another script's) is taken over once 5 hours old.
take_lock() {
  mkdir "$LOCK" 2>/dev/null && return 0
  holder=$(cat "$LOCK/pid" 2>/dev/null)
  if [ -n "$holder" ]; then kill -0 "$holder" 2>/dev/null && return 1
  elif [ -z "$(find "$LOCK" -maxdepth 0 -mmin +300 2>/dev/null)" ]; then return 1
  fi
  say "Taking over a stale lock (${holder:-no pid})."
  rm -rf "$LOCK" && mkdir "$LOCK" 2>/dev/null
}
legacy_holder=$(cat "$LEGACY_LOCK/pid" 2>/dev/null)
if [ -n "$legacy_holder" ] && kill -0 "$legacy_holder" 2>/dev/null; then
  say "Another restart is waiting ($LEGACY_LOCK); leaving it to that one."; exit 0
fi
if ! take_lock; then say "Another restart is waiting ($LOCK); leaving it to that one."; exit 0; fi
echo $$ > "$LOCK/pid"
trap 'rm -rf "$LOCK"' EXIT
trap 'exit 1' INT TERM

if [ "$1" != "--when-idle" ]; then restart; exit $?; fi
idle=0
for _ in $(seq 1 480); do
  busy=$(busy_agents)
  if building; then build=1; else build=0; fi
  say "busy=$busy building=$build"
  if [ "$busy" = "0" ] && [ "$build" = "0" ]; then idle=$((idle + 1)); else idle=0; fi
  if [ "$idle" -ge 2 ]; then say "No agent mid-turn and no build running: restarting."; restart; exit $?; fi
  wait_ticks 30
done
say "Gave up after 4 hours: agents stayed busy. The new build is in $NEW; restart by hand."
