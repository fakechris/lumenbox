#!/usr/bin/env bash
#
# Rebuilds every raster form of the app icon from the two SVG sources.
#
# The SVGs in assets/icons/ are the truth; everything under assets/app-icon/ is generated
# and committed so the Electron shell (and any packager) can pick it up without needing
# these tools installed. Re-run after changing either SVG.
#
# Export spec (from the brand sheet):
#   macOS    .icns 16→1024 @1x/@2x — the tile ships as drawn, no extra padding
#   Windows  .ico 16/24/32/48/64/128/256
#   Linux    PNG 512/256/128/64/48 for hicolor, plus the SVG itself
#   Tray     monochrome template: 16/32 (mac template + @2x), 22 for Linux panels
#
# Needs: rsvg-convert (librsvg), iconutil (macOS), magick (ImageMagick).

set -euo pipefail
cd "$(dirname "$0")/.."

SRC=assets/icons/lumenbox.svg
TRAY=assets/icons/lumenbox-tray.svg
OUT=assets/app-icon

for tool in rsvg-convert magick; do
  command -v "$tool" >/dev/null || { echo "missing $tool — brew install librsvg imagemagick" >&2; exit 1; }
done

rm -rf "$OUT"
mkdir -p "$OUT/png" "$OUT/tray"

# One PNG per size, from the vector. rsvg-convert keeps the alpha corners.
for size in 16 24 32 48 64 128 256 512 1024; do
  rsvg-convert -w "$size" -h "$size" "$SRC" -o "$OUT/png/lumenbox-$size.png"
done

# macOS icon. iconutil wants the iconset naming convention exactly.
if command -v iconutil >/dev/null; then
  ICONSET=$(mktemp -d)/lumenbox.iconset
  mkdir -p "$ICONSET"
  cp "$OUT/png/lumenbox-16.png"   "$ICONSET/icon_16x16.png"
  cp "$OUT/png/lumenbox-32.png"   "$ICONSET/icon_16x16@2x.png"
  cp "$OUT/png/lumenbox-32.png"   "$ICONSET/icon_32x32.png"
  cp "$OUT/png/lumenbox-64.png"   "$ICONSET/icon_32x32@2x.png"
  cp "$OUT/png/lumenbox-128.png"  "$ICONSET/icon_128x128.png"
  cp "$OUT/png/lumenbox-256.png"  "$ICONSET/icon_128x128@2x.png"
  cp "$OUT/png/lumenbox-256.png"  "$ICONSET/icon_256x256.png"
  cp "$OUT/png/lumenbox-512.png"  "$ICONSET/icon_256x256@2x.png"
  cp "$OUT/png/lumenbox-512.png"  "$ICONSET/icon_512x512.png"
  cp "$OUT/png/lumenbox-1024.png" "$ICONSET/icon_512x512@2x.png"
  iconutil -c icns "$ICONSET" -o "$OUT/lumenbox.icns"
else
  echo "iconutil not found (not macOS?) — skipping .icns" >&2
fi

# Windows icon, all sizes in one file.
magick "$OUT/png/lumenbox-16.png" "$OUT/png/lumenbox-24.png" "$OUT/png/lumenbox-32.png" \
  "$OUT/png/lumenbox-48.png" "$OUT/png/lumenbox-64.png" "$OUT/png/lumenbox-128.png" \
  "$OUT/png/lumenbox-256.png" "$OUT/lumenbox.ico"

# Tray glyph. The SVG strokes in currentColor, which rsvg renders black — exactly what a
# macOS template image is (black + alpha, the system recolors it). Windows/Linux dark
# panels get a white copy made by substituting the stroke color.
for size in 16 22 32 44; do
  rsvg-convert -w "$size" -h "$size" "$TRAY" -o "$OUT/tray/trayTemplate-$size.png"
done
mv "$OUT/tray/trayTemplate-16.png" "$OUT/tray/trayTemplate.png"
mv "$OUT/tray/trayTemplate-32.png" "$OUT/tray/trayTemplate@2x.png"
mv "$OUT/tray/trayTemplate-22.png" "$OUT/tray/tray-linux-22.png"
mv "$OUT/tray/trayTemplate-44.png" "$OUT/tray/tray-linux-22@2x.png"

WHITE=$(mktemp -t tray-white.XXXXXX.svg)
sed 's/currentColor/#ffffff/g' "$TRAY" > "$WHITE"
for size in 16 32; do
  rsvg-convert -w "$size" -h "$size" "$WHITE" -o "$OUT/tray/tray-white-$size.png"
done
rm -f "$WHITE"

echo "done:"
find "$OUT" -type f | sort
