#!/usr/bin/env bash
# NotionLess Cloud — run script.
# Uses only paths relative to this script's location. Always runs the app
# with the venv's python for a guaranteed-correct environment.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

VENV_PYTHON="$SCRIPT_DIR/../notion-less-venv/bin/python"
APP_FILE="$SCRIPT_DIR/app.py"

if [ ! -x "$VENV_PYTHON" ]; then
    echo "ERROR: venv python not found at $VENV_PYTHON"
    echo "Run ./setup_or_update.sh first."
    exit 1
fi

if [ ! -f "$APP_FILE" ]; then
    echo "ERROR: app entry point not found: $APP_FILE"
    exit 1
fi

# Per-project customization: ensure runtime data dirs exist (matches config.py).
mkdir -p "$SCRIPT_DIR/../notion-less-data/userdata" "$SCRIPT_DIR/../notion-less-data/uploads"

# "$@" passthrough lets callers add flask/python args if needed.
exec "$VENV_PYTHON" "$APP_FILE" "$@"
