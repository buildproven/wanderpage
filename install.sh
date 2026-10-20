#!/bin/sh
# Wanderpage installer for macOS and Linux:
#   curl -fsSL https://raw.githubusercontent.com/buildproven/wanderpage/main/install.sh | sh
# Pass a project folder or flags after `sh -s --`:  ... | sh -s -- my-trips
#
# Uses the Node.js 24+ already on your PATH. If there is none, it downloads the official Node.js build, checks its SHA-256 against
# nodejs.org's published list, and keeps it in ~/.wanderpage (override with WANDERPAGE_HOME). It never edits your PATH, shell profile,
# or any system setting: the private Node is put in front of PATH for the one command it starts.
# Everything runs inside main() so a download that is cut short cannot run half a script.

set -eu

NODE_MAJOR=24
NODE_CHANNEL="latest-v${NODE_MAJOR}.x"

say() { printf '%s\n' "$*"; }
fail() {
  printf '\nWanderpage could not install: %s\n' "$*" >&2
  exit 1
}

# True when the node and npm in the given bin folder (empty = on PATH) are Node.js $NODE_MAJOR or newer.
node_is_suitable() {
  prefix=${1:+$1/}
  version=$("${prefix}node" --version 2>/dev/null) || return 1
  major=${version#v}
  major=${major%%.*}
  case $major in
    '' | *[!0-9]*) return 1 ;;
  esac
  [ "$major" -ge "$NODE_MAJOR" ] || return 1
  if [ -n "$prefix" ]; then [ -x "${prefix}npx" ]; else command -v npx >/dev/null 2>&1; fi
}

fetch() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --retry 3 -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$2" "$1"
  else
    fail "curl or wget is needed to download Node.js."
  fi
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d ' ' -f 1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d ' ' -f 1
  else
    fail "sha256sum or shasum is needed to check the Node.js download."
  fi
}

platform() {
  case $(uname -s) in
    Darwin) os=darwin ;;
    Linux)
      os=linux
      if [ -e /etc/alpine-release ]; then fail "Alpine Linux is not supported by this installer. Install Node.js $NODE_MAJOR or newer, then run: npx @buildproven/wanderpage"; fi
      ;;
    *) fail "this installer supports macOS and Linux. On Windows, use install.ps1 (see the README)." ;;
  esac
  case $(uname -m) in
    arm64 | aarch64) cpu=arm64 ;;
    x86_64 | amd64) cpu=x64 ;;
    *) fail "unsupported processor $(uname -m)." ;;
  esac
  printf '%s-%s' "$os" "$cpu"
}

# Downloads and checks Node.js, then prints the bin folder of the private copy.
download_node() {
  home=$1
  target=$(platform)
  base=${WANDERPAGE_NODE_BASE_URL:-https://nodejs.org/dist}/$NODE_CHANNEL
  work=$(mktemp -d "${TMPDIR:-/tmp}/wanderpage-install.XXXXXX") || fail "could not create a temporary folder."
  trap 'rm -f "$work/SHASUMS256.txt" "$work"/node-*.tar.gz; rmdir "$work" 2>/dev/null || true' EXIT

  say "No Node.js $NODE_MAJOR or newer found. Downloading a private copy into $home (nothing else on your computer changes)…" >&2
  fetch "$base/SHASUMS256.txt" "$work/SHASUMS256.txt" || fail "could not download the Node.js checksum list from $base. Check your internet connection."
  line=$(grep -E " node-v[0-9.]+-$target\.tar\.gz\$" "$work/SHASUMS256.txt" | head -n 1) || true
  [ -n "$line" ] || fail "nodejs.org lists no Node.js build for $target."
  expected=${line%% *}
  archive=${line##* }
  name=${archive%.tar.gz}

  fetch "$base/$archive" "$work/$archive" || fail "could not download $archive. Check your internet connection."
  actual=$(sha256_of "$work/$archive")
  if [ "$actual" != "$expected" ]; then fail "the downloaded Node.js did not match its published checksum, so it was not installed."; fi

  mkdir -p "$home"
  tar -xzf "$work/$archive" -C "$work" || fail "could not unpack $archive."
  [ ! -e "$home/$name" ] || fail "$home/$name already exists but is not a working Node.js. Delete that folder and run the installer again."
  mv "$work/$name" "$home/$name"
  printf '%s' "$home/$name/bin"
}

# Prints the bin folder of an already downloaded private Node.js that is still suitable, if there is one.
private_node() {
  for bin in "$1"/node-v*/bin; do
    if [ -d "$bin" ] && node_is_suitable "$bin"; then
      printf '%s' "$bin"
      return 0
    fi
  done
  return 1
}

main() {
  home=${WANDERPAGE_HOME:-$HOME/.wanderpage}

  if node_is_suitable ""; then
    # </dev/null: when piped from curl, stdin is this script and must not leak into the program we start.
    exec npx --yes @buildproven/wanderpage "$@" </dev/null
  fi

  bin=$(private_node "$home") || bin=$(download_node "$home")
  say "Starting Wanderpage with the Node.js in $bin"
  PATH="$bin:$PATH"
  export PATH
  # Keep npm's download cache with the private Node.js instead of the system-wide ~/.npm.
  npm_config_cache="$home/npm-cache"
  npm_config_update_notifier=false
  export npm_config_cache npm_config_update_notifier
  exec npx --yes @buildproven/wanderpage "$@" </dev/null
}

main "$@"
