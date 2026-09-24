#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Grove Mail contributors
# SPDX-License-Identifier: Apache-2.0
set -euo pipefail
project=$(cd -- "$(dirname -- "$0")/.." && pwd)
destination="${GROVE_MAIL_BIN_DIR:-$HOME/.local/bin}"
cd "$project"
npm run build
mkdir -p "$destination"
target="$destination/grove-mail"
if [[ -e "$target" || -L "$target" ]]; then
  if [[ ! -L "$target" || "$(readlink "$target")" != "$project/dist/cli.js" ]]; then
    echo "Another command already exists at $target; left unchanged." >&2
    exit 1
  fi
else
  ln -s "$project/dist/cli.js" "$target"
fi
chmod 755 "$project/dist/cli.js"
echo "Installed Grove Mail CLI: $target"
