#!/bin/bash
# Auto-commit the file Claude just wrote/edited, with a detailed diff in the message.
set -euo pipefail

FILE=$(jq -r '.tool_input.file_path // empty' 2>/dev/null)
[ -z "$FILE" ] && exit 0

REPO=$(git -C "$(dirname "$FILE")" rev-parse --show-toplevel 2>/dev/null) || exit 0
cd "$REPO"

git add "$FILE" 2>/dev/null || exit 0

STAGED=$(git diff --cached --name-only 2>/dev/null)
[ -z "$STAGED" ] && exit 0

FILES_LINE=$(echo "$STAGED" | tr '\n' ' ' | sed 's/ $//')
STAT_LINE=$(git diff --cached --stat 2>/dev/null | tail -1)
DIFF_BODY=$(git diff --cached --unified=2 2>/dev/null | head -80 || true)

git commit -m "$(printf 'auto: %s\n\n%s\n\n%s' "$FILES_LINE" "$STAT_LINE" "$DIFF_BODY")" 2>/dev/null
