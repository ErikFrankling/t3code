#!/usr/bin/env bash
# Fork-only: refuses to publish a build that would roll Erik's phone back
# (docs/erik-updates.md). Installed apps take whatever the index offers, and
# a version code says when a build ran, not what it contains, so this checks
# content before anything is published:
#
# - the commit must still be the tip of erik/main (a newer push publishes
#   instead), and
# - every commit already shipped (the newest `android-v…` release and every
#   entry in index.json) must be in it: an ancestor, or, after the nightly
#   rebase rewrote history, present as an equivalent patch (`git cherry`) or
#   a commit with the same subject (a conflict resolved during the rebase).
#
#   erik-updates-guard.sh <index.json>    prints publish=true|false for $GITHUB_OUTPUT;
#                                         ALLOW_BEHIND_TIP=true (no Actions) lets a commit
#                                         that is still on erik/main publish;
#                                         fails when shipped work would be lost, unless
#                                         ACCEPT_DROPPED_COMMITS=true (removed on purpose)
# Needs full history (actions/checkout fetch-depth: 0), GH_REPO and gh.
set -euo pipefail

index="$1"
head="$(git rev-parse HEAD)"

# Commits of <from> whose work is not in <into>: not there as the same patch
# (git cherry), not as a commit with the same subject (a rebase that resolved
# a conflict), and their change not in <into>'s tree either (folded into
# another commit during a rebase).
missing_commits() { # <into> <from>
  local into="$1" from="$2" subjects tree
  subjects="$(git log --format=%s "$from..$into")"
  tree="$(mktemp)"
  GIT_INDEX_FILE="$tree" git read-tree "$into"
  git cherry "$into" "$from" | sed -n 's/^+ //p' | while read -r sha; do
    grep -qxF -- "$(git log -1 --format=%s "$sha")" <<< "$subjects" && continue
    git diff "$sha^" "$sha" | GIT_INDEX_FILE="$tree" git apply --cached --check -R 2> /dev/null && continue
    echo "$sha"
  done
  rm -f "$tree"
}

tip="$(git ls-remote origin refs/heads/erik/main | cut -f1)"
if [ "$head" != "$tip" ] && [ "${ALLOW_BEHIND_TIP:-false}" = true ]; then
  # Without Actions (t3-android-release) no newer run will publish, so a
  # commit still on erik/main may go out; the next release catches up.
  git cat-file -e "$tip^{commit}" 2> /dev/null || git fetch --quiet origin "$tip"
  if git merge-base --is-ancestor "$head" "$tip"; then
    echo "${head::7} is behind erik/main (${tip::7}); publishing it anyway." >&2
  else
    # erik/main was rewritten (a rebase) while this built. Its work may still
    # go out if every commit of it is on erik/main, as the same patch or the
    # same subject; work that was dropped from erik/main never does.
    gone="$(missing_commits "$tip" "$head")"
    if [ -n "$gone" ]; then
      echo "::error::${head::7} has work that is no longer on erik/main (${tip::7}):" >&2
      while read -r sha; do git log -1 --format='  %h %s' "$sha" >&2; done <<< "$gone"
      exit 1
    fi
    echo "erik/main was rewritten; all of ${head::7} is still on it (${tip::7}), publishing." >&2
  fi
elif [ "$head" != "$tip" ]; then
  echo "::notice::erik/main moved on to ${tip::7}; that run publishes instead of ${head::7}." >&2
  echo "publish=false"
  exit 0
fi

latest_tag="$(gh release list --limit 100 --json tagName,createdAt \
  --jq '[.[] | select(.tagName | startswith("android-v"))] | sort_by(.createdAt) | last | .tagName // ""')"
shipped=()
if [ -n "$latest_tag" ]; then
  shipped+=("$(gh api "repos/$GH_REPO/commits/$latest_tag" --jq .sha)")
fi
while read -r commit; do
  [ -n "$commit" ] && shipped+=("$commit")
done < <(jq -r '[.apk.commit // empty] + [.runtimes[]?.commit // empty] | unique | .[]' "$index")

lost=0
for commit in "${shipped[@]}"; do
  if ! git cat-file -e "$commit^{commit}" 2> /dev/null; then
    git fetch --quiet origin "$commit" || {
      echo "::error::cannot fetch shipped commit $commit" >&2
      lost=1
      continue
    }
  fi
  git merge-base --is-ancestor "$commit" "$head" && continue
  missing="$(missing_commits "$head" "$commit")"
  if [ -n "$missing" ]; then
    echo "::error::${head::7} lacks work already shipped in ${commit::7}:" >&2
    while read -r sha; do git log -1 --format='  %h %s' "$sha" >&2; done <<< "$missing"
    lost=1
  fi
done
if [ "$lost" -ne 0 ] && [ "${ACCEPT_DROPPED_COMMITS:-false}" = true ]; then
  echo "::warning::Publishing anyway: accept_dropped_commits is set." >&2
elif [ "$lost" -ne 0 ]; then
  echo "Refusing to publish: installed apps would lose shipped work." >&2
  exit 1
fi
echo "${head::7} contains everything shipped (${#shipped[@]} commits checked)." >&2
echo "publish=true"
