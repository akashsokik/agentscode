#!/bin/sh
# Restart the installed AgentsCode (macOS) onto the newest build in release/mac-arm64: quit it,
# keep the old app at /tmp/AgentsCode.app.prev, copy the new one in, open it.
#
#   scripts/restart-desktop.sh              restart now
#   scripts/restart-desktop.sh --when-idle  wait until no agent is mid-turn and no build runs (two
#                                           checks in a row, 30s apart; up to 4 hours), then restart
#
# Run it detached from the app (an agent's own process ends with the app). One waiter at a time:
# the lock is /tmp/agentscode-restart-waiter.lock.
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
# For tests, AGENTSCODE_APP, AGENTSCODE_PREV, AGENTSCODE_NEW_BUILD, AGENTSCODE_PORT, AGENTSCODE_LOCK
# and AGENTSCODE_TICK (seconds per wait step, default 1) override the defaults.
ROOT=$(cd "$(dirname "$0")/.." && pwd)
BID=com.agentscode.app
APP=${AGENTSCODE_APP:-/Applications/AgentsCode.app}
PREV=${AGENTSCODE_PREV:-/tmp/AgentsCode.app.prev}
NEW=${AGENTSCODE_NEW_BUILD:-$ROOT/release/mac-arm64/AgentsCode.app}
PORT=${AGENTSCODE_PORT:-4320}
LOCK=${AGENTSCODE_LOCK:-/tmp/agentscode-restart-waiter.lock}
TICK=${AGENTSCODE_TICK:-1}

say() { echo "$(date '+%H:%M:%S') $*"; }
wait_ticks() { sleep "$(awk "BEGIN { print $1 * $TICK }")"; }
running() { [ "$(osascript -e "application id \"$BID\" is running" 2>/dev/null)" = "true" ]; }
app_pid() { lsappinfo info -only pid -app "$BID" 2>/dev/null | sed -n 's/.*"pid"=\([0-9][0-9]*\).*/\1/p'; }
server_answers() { curl -s --max-time 3 -o /dev/null "http://127.0.0.1:$PORT/api/state"; }
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
busy_agents() {
  curl -s --max-time 5 "http://127.0.0.1:$PORT/api/state" | node -e "
let raw = '';
process.stdin.on('data', d => { raw += d; }).on('end', () => {
  try { console.log((JSON.parse(raw).agents ?? []).filter(a => a.status === 'working' || a.status === 'waiting').length); }
  catch { console.log(-1); }
});
" 2>/dev/null || echo -1
}
building() { pgrep -f "electron-builder|vite build --outDir|tsconfig.desktop.json" >/dev/null; }
# Waits up to $1 steps for the app to be gone; true when it is.
gone_within() { i=0; while [ "$i" -lt "$1" ]; do running || return 0; wait_ticks 1; i=$((i + 1)); done; ! running; }

restart() {
  if [ ! -x "$NEW/Contents/MacOS/AgentsCode" ]; then say "No build at $NEW; left as is."; return 1; fi
  # A restart replaces an installed app; a first install is done by hand.
  if [ ! -d "$APP" ]; then say "No app at $APP to replace; install it by hand. Nothing changed."; return 1; fi
  # Only ask a running app to quit, so AppleScript never has to find or start it.
  running && osascript -e "tell application id \"$BID\" to quit" >/dev/null 2>&1
  if ! gone_within 30; then
    # Still stopping its agents (the server has up to 8s), or held by something: give it longer.
    server_answers && gone_within 30
    if running && ! server_gone; then say "AgentsCode is still running and its server still answers after 60s (a dialog may be open); left as is."; return 1; fi
    if running; then
      pid=$(app_pid)
      say "AgentsCode stopped its server but did not exit (the browser-holder quit hang); ending process ${pid:-?}."
      if [ -n "$pid" ]; then
        kill -TERM "$pid" 2>/dev/null
        gone_within 10 || { kill -KILL "$pid" 2>/dev/null; gone_within 5; }
      fi
      if running; then say "AgentsCode would not exit; left as is."; return 1; fi
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
  if ! ditto "$NEW" "$APP" || [ ! -x "$APP/Contents/MacOS/AgentsCode" ]; then
    say "Copying the new build failed; putting the previous one back."
    rm -rf "$APP"
    mv "$PREV" "$APP"
    open "$APP"
    return 1
  fi
  open "$APP"
  i=0; while [ "$i" -lt 30 ] && ! running; do wait_ticks 1; i=$((i + 1)); done
  if running; then say "Restarted onto $NEW."; else say "Opened $APP, but it is not running yet."; fi
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
