#!/bin/zsh
set -e
cd -- "${0:A:h}"
if ! command -v pnpm >/dev/null 2>&1; then
  print "Wanderpage needs pnpm once before it can open. Install it with: npm install -g pnpm"
  read "?Press Return to close."
  exit 1
fi
exec pnpm studio
