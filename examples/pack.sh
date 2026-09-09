#!/usr/bin/env bash
#
# Packs the example apps into archives the dashboard's Source panel accepts.
#
# The exclusions are the point: node_modules, dist and src/generated are all
# things the pipeline is supposed to produce itself. Shipping them would both
# blow past the 50MB upload cap and hide the install/codegen stages the demo
# exists to show.
set -euo pipefail

cd "$(dirname "$0")"
out="${OUT_DIR:-/tmp}"
format="tgz"
[[ "${1:-}" == "--zip" ]] && format="zip"

apps=(forge-analytics hello-forge)
excludes=(node_modules dist src/generated .npm-cache)

for app in "${apps[@]}"; do
  if [[ "$format" == "zip" ]]; then
    target="$out/$app.zip"
    rm -f "$target"
    zip_excludes=()
    for e in "${excludes[@]}"; do zip_excludes+=("-x" "$app/$e/*"); done
    zip -qr "$target" "$app" "${zip_excludes[@]}"
  else
    target="$out/$app.tgz"
    tar_excludes=()
    for e in "${excludes[@]}"; do tar_excludes+=("--exclude=$e"); done
    tar -czf "$target" "${tar_excludes[@]}" "$app"
  fi
  printf '%-18s → %s (%s)\n' "$app" "$target" "$(du -h "$target" | cut -f1)"
done
