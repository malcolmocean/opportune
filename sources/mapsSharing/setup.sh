#!/usr/bin/env sh
# Creates sources/mapsSharing/.venv with locationsharinglib. Run once; index.js finds the venv automatically.
set -e
cd "$(dirname "$0")"
PY="${PYTHON:-python3}"
"$PY" -m venv .venv
./.venv/bin/pip install --quiet -r requirements.txt
echo "mapsSharing: locationsharinglib $(./.venv/bin/python -c 'import locationsharinglib; print(locationsharinglib.__version__)') installed in $(pwd)/.venv"
