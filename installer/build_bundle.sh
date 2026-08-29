#!/usr/bin/env bash
set -euo pipefail

installer_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
cd "$installer_dir"
bundle="$installer_dir/Decky UI Restored Installer.zip"
rm -f -- "$bundle"

zip -q -9 -r -FS \
  "$bundle" \
  "Install Decky UI Restored.desktop" \
  DeckyUIRestoredInstaller \
  -x '*/__pycache__/*' '*.pyc'

printf 'Built %s\n' "$bundle"
