#!/bin/sh
# Installs hello into the box's work volume, which survives an image update.
set -e
bin="${LUMENBOX_WORK:?LUMENBOX_WORK is not set}/.tools/bin"
mkdir -p "$bin"
cp "$(dirname "$0")/hello" "$bin/hello"
chmod u+wx "$bin/hello"
