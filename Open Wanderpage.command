#!/bin/zsh
set -e
cd -- "${0:A:h}"
if ! command -v node >/dev/null 2>&1; then
  print "Wanderpage needs Node.js 24 or newer. Install it from https://nodejs.org, then open this file again."
  read "?Press Return to close."
  exit 1
fi
if [ ! -d node_modules ]; then
  print "First run: installing Wanderpage (about a minute)…"
  npm install --no-audit --no-fund --loglevel=error
fi
exec node node_modules/tsx/dist/cli.mjs scripts/private.ts
