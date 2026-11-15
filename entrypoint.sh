#!/bin/sh
# Seed /config/config.yml from the image default when the mount is empty.
set -eu

CONFIG_PATH="${CONFIG_PATH:-/config/config.yml}"
config_dir=$(dirname "$CONFIG_PATH")
mkdir -p "$config_dir"

if [ ! -f "$CONFIG_PATH" ]; then
  echo "pg-gateway-proxy: no config at $CONFIG_PATH, writing the default"
  cp /app/config.default.yml "$CONFIG_PATH"
fi

exec node /app/dist/index.js
