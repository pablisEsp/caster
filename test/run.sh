#!/bin/bash
# Runs the receiver's scenario tests against a page (default: the staging one).
#   test/run.sh [staging/index.html | index.html] [locale]
# Needs Node. The tests run the page's main inline script in a vm with fakes
# for the DOM, CAF and hls.js, and a manual clock.
set -euo pipefail
cd "$(dirname "$0")/.."
PAGE=${1:-staging/index.html}
LOCALE=${2:-es-ES}
DIR=$(mktemp -d)
trap 'rm -rf "$DIR"' EXIT
TMP="$DIR/receiver_inline.js"
python3 - "$PAGE" "$TMP" <<'PY'
import re, sys
html = open(sys.argv[1]).read()
scripts = re.findall(r'<script>(.*?)</script>', html, re.S)
open(sys.argv[2], 'w').write(max(scripts, key=len))
PY
node --check "$TMP"
# The page's copy in the app's languages, next to it; up to date with i18n/.
STRINGS="$(dirname "$PAGE")/strings.js"
if [ "$PAGE" = staging/index.html ]; then python3 tools/build_strings.py --check; fi
node test/receiver_harness.js "$TMP" "$LOCALE" "$STRINGS"
