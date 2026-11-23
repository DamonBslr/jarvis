#!/bin/bash
# Render app + menu-bar icons from assets/*.svg (needs rsvg-convert: brew install librsvg).
set -euo pipefail
cd "$(dirname "$0")/.."
rsvg-convert -w 1024 -h 1024 assets/icon.svg -o build/icon.png
for name in trayTemplate trayActiveTemplate; do
  rsvg-convert -w 18 -h 18 "assets/$name.svg" -o "resources/$name.png"
  rsvg-convert -w 36 -h 36 "assets/$name.svg" -o "resources/$name@2x.png"
done
echo "icons written"
