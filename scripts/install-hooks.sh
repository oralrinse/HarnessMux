#!/bin/sh
# Install this repository's git hooks into .git/hooks (idempotent).
#
# Hooks are not versioned by git, so every clone has to run this once:
#     sh scripts/install-hooks.sh
#
# The pre-commit hook blocks absolute developer paths and credentials from a
# repository that is published publicly.

set -e

root=$(git rev-parse --show-toplevel)
hooks="$root/.git/hooks"

if [ ! -d "$hooks" ]; then
  echo "install-hooks: $hooks does not exist — is this a git repository?" >&2
  exit 1
fi

cp "$root/scripts/pre-commit" "$hooks/pre-commit"
chmod +x "$hooks/pre-commit"
echo "install-hooks: installed pre-commit into $hooks"
