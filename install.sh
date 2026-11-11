#!/bin/bash
# Installs the AgentsCode desktop app on macOS from the GitHub release.
#
#   curl -fsSL https://raw.githubusercontent.com/akashsokik/agentscode/main/install.sh | bash
#
# Releases are signed with a Developer ID and notarized, so the DMG from the website works too; this
# script is the terminal route, and the way to update a version up to 0.2.2, which was not signed and
# cannot install a signed update itself. It also installs an ad-hoc signed build (from a fork without
# the signing secrets): curl does not quarantine what it downloads, so that app opens directly too.
# The script checks the download against the release's SHA256SUMS and the app's code signature
# before it replaces anything.
#
# Run it again to update. Quit AgentsCode first.
#
# Environment:
#   AGENTSCODE_VERSION      install this version (for example 0.1.0) instead of the latest release
#   AGENTSCODE_INSTALL_DIR  install into this folder instead of /Applications (or ~/Applications)
#   AGENTSCODE_NO_OPEN=1    do not open the app after installing

set -euo pipefail

REPO="akashsokik/agentscode"

fail() {
  printf 'AgentsCode install: %s\n' "$1" >&2
  exit 1
}

# Everything runs inside main, called on the last line, so a download cut short by the network
# runs nothing at all.
main() {
  [[ "$(uname -s)" == "Darwin" ]] ||
    fail "this script installs the macOS app. For Windows and Linux, download from https://github.com/$REPO/releases/latest"

  # uname -m says x86_64 in a terminal running under Rosetta, so ask the hardware instead.
  local arch=x64
  if [[ "$(sysctl -n hw.optional.arm64 2>/dev/null || true)" == "1" ]]; then
    arch=arm64
  fi

  local base="https://github.com/$REPO/releases/latest/download"
  if [[ -n "${AGENTSCODE_VERSION:-}" ]]; then
    base="https://github.com/$REPO/releases/download/v${AGENTSCODE_VERSION#v}"
  fi
  local asset="AgentsCode-mac-$arch.zip"

  local dir
  if [[ -n "${AGENTSCODE_INSTALL_DIR:-}" ]]; then
    dir="$AGENTSCODE_INSTALL_DIR"
  elif [[ -w /Applications ]]; then
    dir=/Applications
  else
    dir="$HOME/Applications"
  fi
  mkdir -p "$dir"
  # An absolute path with no trailing slash, as LaunchServices reports a running app's.
  dir="$(CDPATH='' cd -- "$dir" && pwd)"
  local app="$dir/AgentsCode.app"

  # Replacing the app under a running copy would break it. Quitting it stops its agents, so that
  # is left to the user. LaunchServices knows the app by its bundle id and where it runs from. A
  # process pattern (pgrep -f "$app/Contents/") also matches agent CLIs, whose arguments name the
  # app, and comms MCP servers, which run on its binary. Those can outlive the app, and then a quit
  # app read as running and the install refused (2026-11-11). lsappinfo prints nothing, and still
  # exits 0, when the app is not running.
  local running
  running="$(lsappinfo info -only bundlepath -app com.agentscode.app 2>/dev/null |
    sed -n 's/^"LSBundlePath"="\(.*\)"$/\1/p' || true)"
  if [[ "$running" == "$app" ]]; then
    fail "AgentsCode is running from $app. Quit it (Cmd+Q) and run this again."
  fi

  local tmp
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/agentscode-install.XXXXXX")"
  # shellcheck disable=SC2064
  trap "rm -rf '$tmp'" EXIT

  printf 'Downloading %s\n' "$asset"
  curl -fL --progress-bar -o "$tmp/$asset" "$base/$asset" ||
    fail "could not download $base/$asset"
  curl -fsSL -o "$tmp/SHA256SUMS" "$base/SHA256SUMS" ||
    fail "could not download $base/SHA256SUMS"

  local expected actual
  expected="$(awk -v name="$asset" '$2 == name { print $1 }' "$tmp/SHA256SUMS")"
  [[ -n "$expected" ]] || fail "SHA256SUMS has no entry for $asset"
  actual="$(shasum -a 256 "$tmp/$asset" | awk '{ print $1 }')"
  [[ "$actual" == "$expected" ]] ||
    fail "checksum mismatch for $asset (expected $expected, got $actual)"

  # tar (bsdtar) reads zips and keeps the Electron framework's symlinks, which the code signature
  # covers. ditto -x -k is the usual tool, but under $TMPDIR (/var/folders) it fails on those
  # symlinks with "Operation not permitted" (macOS 26, seen 2026-11-07).
  mkdir "$tmp/unpacked"
  tar -xf "$tmp/$asset" -C "$tmp/unpacked" || fail "could not unpack $asset"
  [[ -d "$tmp/unpacked/AgentsCode.app" ]] || fail "$asset does not contain AgentsCode.app"
  codesign --verify --deep --strict "$tmp/unpacked/AgentsCode.app" 2>/dev/null ||
    fail "the code signature of the downloaded app does not verify"

  # Move the old app aside, then move the new one in, so a failure leaves the old app in place.
  local old="$dir/.AgentsCode-replaced.app"
  rm -rf "$old"
  if [[ -e "$app" ]]; then
    mv "$app" "$old" || fail "could not move the existing $app aside"
  fi
  if ! mv "$tmp/unpacked/AgentsCode.app" "$app"; then
    # A move across volumes copies, and a failed copy can leave part of the app behind.
    rm -rf "$app"
    [[ -e "$old" ]] && mv "$old" "$app"
    fail "could not move the new app into $app"
  fi
  rm -rf "$old"

  local version
  version="$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$app/Contents/Info.plist" 2>/dev/null || echo '?')"
  printf 'Installed AgentsCode %s in %s\n' "$version" "$app"
  if [[ "$dir" == "$HOME/Applications" && -e /Applications/AgentsCode.app ]]; then
    printf 'An older copy is still in /Applications and may still be blocked. Move it to the Bin so Spotlight and the Dock open this one.\n'
  fi

  if [[ -z "${AGENTSCODE_NO_OPEN:-}" ]]; then
    open "$app"
  fi
}

main "$@"
