#!/bin/sh
# Cargo invokes this script as: sign-macos-dev-binary.sh <rustc> <rustc args...>
# It preserves normal compilation, then signs Siftlane's executable with a
# persistent Apple Development identity when one is available. A persistent
# identity gives Keychain a stable application requirement across rebuilds.

rustc="$1"
shift

output=""
previous=""
for argument in "$@"; do
  if [ "$previous" = "-o" ]; then
    output="$argument"
    break
  fi
  previous="$argument"
done

"$rustc" "$@"
status=$?
[ "$status" -eq 0 ] || exit "$status"

[ "$(uname)" = "Darwin" ] || exit 0
[ -n "$output" ] && [ -f "$output" ] || exit 0

identity="${SIFTLANE_DEV_SIGNING_IDENTITY:-}"
if [ -z "$identity" ] && command -v security >/dev/null 2>&1; then
  identity="$(security find-identity -v -p codesigning 2>/dev/null | sed -n 's/^[[:space:]]*[0-9][0-9]*) \([0-9A-F]*\) "Apple Development:.*"$/\1/p' | head -n 1)"
fi

# A paid Apple Developer account is not required for local development. If no
# Apple Development identity exists, use the explicitly named local identity
# created by the Keychain Access instructions in README.md.
if [ -z "$identity" ] && command -v security >/dev/null 2>&1; then
  identity="$(security find-identity -v -p codesigning 2>/dev/null | sed -n 's/^[[:space:]]*[0-9][0-9]*) \([0-9A-F]*\) "Siftlane Development".*$/\1/p' | head -n 1)"
fi

[ -n "$identity" ] || exit 0

case "$output" in
  */siftlane-app)
    codesign --force --sign "$identity" --identifier app.siftlane.desktop "$output"
    ;;
esac
