#!/usr/bin/env bash
# Fork-only: keeps the rolling update release (docs/erik-updates.md) in step
# with index.json. Needs GH_REPO and a gh login with contents: write.
#
#   erik-updates-release.sh ensure  <channel>
#   erik-updates-release.sh fetch   <channel> <index.json>      (empty index if none)
#   erik-updates-release.sh upload  <channel> <file>...         (only names not there yet)
#   erik-updates-release.sh index   <channel> <index.json>      (replace index.json)
#   erik-updates-release.sh prune   <channel> <index.json>      (drop unreferenced files)
set -euo pipefail

command="$1"
channel="$2"
shift 2

release_id() {
  gh api "repos/$GH_REPO/releases/tags/$channel" --jq .id
}

assets() {
  gh api "repos/$GH_REPO/releases/$(release_id)/assets?per_page=100" --paginate \
    --jq '.[] | "\(.id) \(.name)"'
}

case "$command" in
  ensure)
    gh release view "$channel" > /dev/null 2>&1 ||
      gh release create "$channel" --prerelease --latest=false \
        --title "Android updates ($channel)" \
        --notes "Rolling release the T3 Code Android app updates itself from. Do not delete: index.json here is what installed apps follow. See docs/erik-updates.md."
    ;;
  fetch)
    dir="$(mktemp -d)"
    if gh release download "$channel" -p index.json -D "$dir" 2> /dev/null; then
      mv "$dir/index.json" "$1"
    else
      echo '{"apk":null,"runtimes":{}}' > "$1"
    fi
    rmdir "$dir" 2> /dev/null || true
    ;;
  upload)
    existing="$(assets | cut -d' ' -f2-)"
    missing=()
    for file in "$@"; do
      grep -qxF "$(basename "$file")" <<< "$existing" || missing+=("$file")
    done
    echo "uploading ${#missing[@]} of $# files"
    # In batches: one gh call per file is slow, one huge call is fragile.
    for ((i = 0; i < ${#missing[@]}; i += 20)); do
      gh release upload "$channel" "${missing[@]:i:20}"
    done
    ;;
  index)
    # Upload under a fresh name, then swap, so the old index stays readable
    # until the new one is complete.
    staged="index-${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-0}-$(date +%s).json"
    cp "$1" "${RUNNER_TEMP:-/tmp}/$staged"
    gh release upload "$channel" "${RUNNER_TEMP:-/tmp}/$staged"
    listing="$(assets)"
    old="$(awk '$2 == "index.json" { print $1 }' <<< "$listing")"
    new="$(awk -v name="$staged" '$2 == name { print $1 }' <<< "$listing")"
    if [ -n "$old" ]; then gh api -X DELETE "repos/$GH_REPO/releases/assets/$old"; fi
    gh api -X PATCH "repos/$GH_REPO/releases/assets/$new" -f name=index.json > /dev/null
    ;;
  prune)
    keep="$(node "$(dirname "$0")/erik-updates.mjs" keep --index "$1")"
    apk="$(jq -r '.apk.url // "" | split("/") | last' "$1")"
    assets | while read -r id name; do
      case "$name" in
        index.json | "$apk") continue ;;
      esac
      if ! grep -qxF "$name" <<< "$keep"; then
        echo "deleting $name"
        gh api -X DELETE "repos/$GH_REPO/releases/assets/$id"
      fi
    done
    ;;
  *)
    echo "unknown command $command" >&2
    exit 2
    ;;
esac
