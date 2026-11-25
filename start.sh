#!/usr/bin/env bash
# ===========================================================================
#  English Essay Grader - one-click launcher (macOS / Linux)
#  Run:  ./start.sh     (macOS: double-click works if it is executable, or
#                        right-click -> Open With -> Terminal)
# ===========================================================================
set -e
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "[x] Node.js not found. Install Node.js 18+ first: https://nodejs.org"
  exit 1
fi

echo
echo "  Starting English Essay Grader ..."
echo "  The browser will open automatically when the server is ready."
echo "  Press Ctrl+C to stop the server."
echo

EG_OPEN=1 exec node backend/server.js
