#!/bin/sh
# Apply the runtime BASE_PATH to the build (the image was built with a placeholder base).
#
# The app was built with Vite base "/__BASE_PATH__/", so every reference is ABSOLUTE
# ("/__BASE_PATH__/assets/...", the manifest scope, the SW registration + scope, the SW's own
# precache base). We rewrite that placeholder to the real BASE_PATH — keeping the URLs absolute
# so deep links / refreshes (e.g. /quick-ui/timeline) still load "/quick-ui/assets/..." rather
# than resolving relative to the current path. Then we relocate the build under the subpath so
# nginx (root + try_files) serves it there.
set -eu

ROOT=/usr/share/nginx/html

# 1) Bake the requested base into the placeholder'd, absolute references. CSS matters too:
#    bundled @font-face rules reference url(/__BASE_PATH__/fonts/…), so a missing *.css here
#    500s every self-hosted font.
find "$ROOT" -type f \
  \( -name '*.html' -o -name '*.js' -o -name '*.css' -o -name '*.webmanifest' -o -name '*.json' \) \
  -exec sed -i "s#/__BASE_PATH__/#${BASE_PATH}#g" {} +

# 2) Relocate the build under the base subpath (no-op at "/"; idempotent across restarts).
if [ "$BASE_PATH" != "/" ] && [ -f "$ROOT/index.html" ]; then
  tmp="$(mktemp -d)"
  mv "$ROOT"/* "$tmp"/
  mkdir -p "$ROOT${BASE_PATH}"
  mv "$tmp"/* "$ROOT${BASE_PATH}"
  rmdir "$tmp"
fi
