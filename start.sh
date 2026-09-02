#!/bin/bash
cd "$(dirname "$0")"
. ../notion-less-venv/bin/activate
python app.py
