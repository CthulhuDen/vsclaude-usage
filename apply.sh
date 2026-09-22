#!/bin/sh
# Appends badge.js to the webview bundle of every installed Claude Code VS Code
# extension, or restores the originals with --uninstall. Safe to re-run.
set -eu

usage() {
  cat <<'EOF'
Usage: apply.sh [--debug] | --uninstall

Patches webview/index.js of every anthropic.claude-code-* extension in
$VSCODE_EXTENSIONS_DIR (default: ~/.vscode/extensions) with badge.js.

  --debug      also log relevant host messages to the webview console ("[usage-badge]")
  --uninstall  restore the original webview/index.js
EOF
}

mode=apply
debug=0
for arg in "$@"; do
  case $arg in
    --uninstall) mode=uninstall ;;
    --debug) debug=1 ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done

here=$(cd "$(dirname "$0")" && pwd)
badge="$here/badge.js"
ext_root=${VSCODE_EXTENSIONS_DIR:-$HOME/.vscode/extensions}
begin='/* BEGIN claude-usage-badge */'

[ -f "$badge" ] || { echo "error: $badge not found" >&2; exit 1; }
grep -qxF "$begin" "$badge" || { echo "error: begin marker missing in $badge" >&2; exit 1; }

work=$(mktemp -d "${TMPDIR:-/tmp}/usage-badge.XXXXXX")
trap 'rm -rf "$work"' EXIT

if [ "$debug" = 1 ]; then
  sed 's/var DEBUG = false;/var DEBUG = true;/' "$badge" > "$work/block.js"
  grep -q 'var DEBUG = true;' "$work/block.js" || { echo "error: could not enable DEBUG in $badge" >&2; exit 1; }
else
  cp "$badge" "$work/block.js"
fi

have_node=0
command -v node > /dev/null 2>&1 && have_node=1
if [ "$mode" = apply ] && [ "$have_node" = 0 ]; then
  echo "warning: node not found, skipping the syntax check of patched bundles" >&2
fi

# strip_block SRC DST: SRC without the marker block (always at the end), ending in a newline.
strip_block() {
  n=$(grep -n -xF "$begin" "$1" | head -n 1 | cut -d: -f1)
  if [ -n "$n" ]; then head -n $((n - 1)) "$1" > "$2"; else cp "$1" "$2"; fi
  if [ -s "$2" ] && [ -n "$(tail -c 1 "$2")" ]; then echo >> "$2"; fi
}

# replace SRC DST: atomically overwrite DST with SRC.
replace() {
  cp "$1" "$2.tmp.$$"
  mv -f "$2.tmp.$$" "$2"
}

found=0
failed=0
for dir in "$ext_root"/anthropic.claude-code-*/; do
  js="${dir}webview/index.js"
  [ -f "$js" ] || continue
  found=1
  name=$(basename "$dir")

  if [ "$mode" = uninstall ]; then
    if [ -f "$js.orig" ]; then
      mv -f "$js.orig" "$js"
      echo "$name: restored original index.js"
    elif grep -qxF "$begin" "$js"; then
      strip_block "$js" "$work/base.js"
      replace "$work/base.js" "$js"
      echo "$name: removed badge block (no index.js.orig backup found)"
    else
      echo "$name: not patched"
    fi
    continue
  fi

  if [ ! -f "$js.orig" ]; then
    if grep -qxF "$begin" "$js"; then
      strip_block "$js" "$js.orig"
    else
      cp "$js" "$js.orig"
    fi
    echo "$name: saved backup index.js.orig"
  fi

  strip_block "$js" "$work/base.js"
  cat "$work/base.js" "$work/block.js" > "$work/new.mjs"
  if [ "$have_node" = 1 ] && ! node --check "$work/new.mjs" 2> "$work/check.err"; then
    echo "$name: NOT patched, the result fails a syntax check:" >&2
    head -n 20 "$work/check.err" | sed 's/^/  /' >&2
    failed=1
    continue
  fi
  if cmp -s "$work/new.mjs" "$js"; then
    echo "$name: already up to date"
  else
    replace "$work/new.mjs" "$js"
    echo "$name: patched$([ "$debug" = 1 ] && echo ' (debug logging on)')"
  fi
done

if [ "$found" = 0 ]; then
  echo "error: no anthropic.claude-code-* extension found in $ext_root" >&2
  exit 1
fi
echo 'Next: run "Developer: Reload Window" in each open VS Code window.'
exit "$failed"
