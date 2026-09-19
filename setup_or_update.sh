#!/usr/bin/env bash
# NotionLess Cloud — setup / update script.
# Uses only paths relative to this script's location. Safe to move the
# project folder elsewhere; no hardcoded absolute paths.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

VENV_DIR="$SCRIPT_DIR/../notion-less-venv"
VENV_PYTHON="$VENV_DIR/bin/python"
REQUIREMENTS_FILE="$SCRIPT_DIR/requirements.txt"
DATA_DIR="$SCRIPT_DIR/../notion-less-data/userdata"
UPLOADS_DIR="$SCRIPT_DIR/../notion-less-data/uploads"
DESKTOP_FILE="$SCRIPT_DIR/NotionLess.desktop"
APP_ICON="$SCRIPT_DIR/icons/icon-512.png"

echo "==> NotionLess Cloud setup (project: $SCRIPT_DIR)"

# --- 1. System requirements -------------------------------------------------
if ! command -v python3 >/dev/null 2>&1; then
    echo "ERROR: python3 not found. Install it first, e.g.:"
    echo "  sudo apt update && sudo apt install -y python3 python3-venv python3-pip"
    exit 1
fi
echo "  python3: $(python3 --version 2>&1)"

if ! python3 -c "import venv" >/dev/null 2>&1; then
    echo "ERROR: python3-venv module missing. Install it, e.g.:"
    echo "  sudo apt update && sudo apt install -y python3-venv"
    exit 1
fi

# --- 2. Create venv if it doesn't exist -------------------------------------
if [ ! -x "$VENV_PYTHON" ]; then
    echo "==> Creating virtualenv at $VENV_DIR ..."
    python3 -m venv "$VENV_DIR"
else
    echo "==> Virtualenv already exists, reusing it."
fi

# --- 3. Install / update Python deps with the venv's python -----------------
# NOTE: deliberately uses "$VENV_PYTHON -m pip" (not system pip, not
# `pip install`, not `source activate`) so packages always land in the venv.
if [ ! -f "$REQUIREMENTS_FILE" ]; then
    echo "ERROR: requirements file not found: $REQUIREMENTS_FILE"
    exit 1
fi
# Repair venvs whose pip went missing (e.g. venv created without pip).
if ! "$VENV_PYTHON" -m pip --version >/dev/null 2>&1; then
    echo "==> pip missing in venv, bootstrapping with ensurepip ..."
    "$VENV_PYTHON" -m ensurepip --upgrade
fi
echo "==> Upgrading pip in venv ..."
"$VENV_PYTHON" -m pip install --upgrade pip
echo "==> Installing/updating requirements ..."
"$VENV_PYTHON" -m pip install -r "$REQUIREMENTS_FILE"

# --- 4. Per-project customizations ------------------------------------------
echo "==> Creating data directories ..."
mkdir -p "$DATA_DIR" "$UPLOADS_DIR"
# Keep data dirs out of git even though they live outside the repo.
if [ ! -f "$SCRIPT_DIR/../notion-less-data/.gitignore" ]; then
    printf '*\n!.gitignore\n' > "$SCRIPT_DIR/../notion-less-data/.gitignore" 2>/dev/null || true
fi

chmod +x "$SCRIPT_DIR/run.sh" 2>/dev/null || true
chmod +x "$SCRIPT_DIR/setup_or_update.sh" 2>/dev/null || true

# --- 5. Desktop shortcut in the current (project) folder --------------------
echo "==> Writing desktop shortcut: $DESKTOP_FILE ..."
cat > "$DESKTOP_FILE" <<EOF
[Desktop Entry]
Type=Application
Name=NotionLess Cloud
Comment=Block-based note-taking workspace (Flask + BlockNote)
Exec=$SCRIPT_DIR/run.sh
Path=$SCRIPT_DIR
Icon=$APP_ICON
Terminal=true
Categories=Office;Utility;
StartupNotify=false
EOF
chmod +x "$DESKTOP_FILE"

echo ""
echo "Setup complete."
echo "  venv:    $VENV_DIR"
echo "  data:    $SCRIPT_DIR/../notion-less-data"
echo "  launcher: $DESKTOP_FILE"
echo "Start the app with: ./run.sh"
