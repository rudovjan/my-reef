#!/bin/bash
cd "$(dirname "$0")" || exit 1
export PATH="$PATH:/usr/local/bin:/opt/homebrew/bin"
if ! command -v node >/dev/null 2>&1; then
  echo "Install Node.js 24 LTS from https://nodejs.org/en/download, then open this file again."
  read -r -p "Press Enter to close. "
  exit 1
fi
node start.mjs
result=$?
read -r -p "Press Enter to close this window. "
exit "$result"
