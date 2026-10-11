#!/usr/bin/env bash
# The lib blobs of crates/ts_goport: src/frontend/parser/lib_parse.bin and src/binder/lib_bind.bin.
# A blob goes stale when a source in its key changes: an include_bytes! file of lib_parse_snapshot.rs or
# lib_snapshot.rs (the parser, scanner, factory, store, binder, core.rs, flags, the snapshot files), or a bundled
# lib under crates/ts_goport/libs. A stale blob parses or binds the libs live (same output, slower) and fails the
# protected tests snapshot_matches_live_parse and snapshot_matches_live_bind.
#
# usage: lib-blobs.sh stale [<rev>]   git only, no build. At <rev> (default HEAD) of this repo: each blob whose key
#                                     sources changed after the last commit that wrote it. One line per stale blob;
#                                     exit 1 when one is stale. candidate.sh check runs it.
#        lib-blobs.sh write           in the current checkout: write lib_parse.bin, then lib_bind.bin, then check.
#        lib-blobs.sh check           in the current checkout: the two snapshot_matches_live_* tests (a release test
#                                     build). They also find a blob that a helper outside the key made stale.
# After merges, write once, after the last merge, not after each one. A merge keeps our side of a blob without a
# conflict (.gitattributes merge=lib-blob; the repo config has merge.lib-blob.driver=true), so write after it.
set -euo pipefail
C=crates/ts_goport
PARSE_TEST=frontend::parser::lib_parse_snapshot::tests
BIND_TEST=binder::lib_snapshot::tests
TOP=$(git rev-parse --show-toplevel)
cd "$TOP"

# stale_one <rev> <blob> <key file>: prints a line when <blob> at <rev> is older than a source of its key.
stale_one() {
  local rev=$1 blob=$C/$2 key=$C/$3 dir p c n
  local -a deps changed
  dir=$(dirname "$key")
  mapfile -t deps < <(git show "$rev:$key" | grep -oP 'include_bytes!\("\K[^"]+' | grep -v '\.bin$' |
    while read -r p; do realpath -m --relative-to="$TOP" "$TOP/$dir/$p"; done)
  c=$(git rev-list -1 "$rev" -- "$blob")
  [[ -n $c ]] || { echo "lib blob $blob: no commit at ${rev} wrote it"; return; }
  mapfile -t changed < <(git diff --name-only "$c" "$rev" -- "${deps[@]}" "$C/libs")
  n=${#changed[@]}
  ((n)) || return 0
  printf 'stale lib blob %s: %d key source(s) changed after %s wrote it (%s%s). Run scripts/goport/lib-blobs.sh write in the checkout, once, after the last merge.\n' \
    "$blob" "$n" "${c:0:9}" "$(printf '%s\n' "${changed[@]:0:3}" | xargs -n1 basename | paste -sd, -)" "$( ((n > 3)) && echo ", ...")"
}

# The snapshot tests are lib tests of goport_core (crate split step 2).
cargo_test() { scripts/run-cargo-capped.sh test --release -p goport_core --lib -- --exact --test-threads=1 "$@"; }

case ${1:-} in
  stale)
    rev=$(git rev-parse --verify "${2:-HEAD}^{commit}")
    out=$(stale_one "$rev" src/frontend/parser/lib_parse.bin src/frontend/parser/lib_parse_snapshot.rs
      stale_one "$rev" src/binder/lib_bind.bin src/binder/lib_snapshot.rs)
    [[ -z $out ]] || { echo "$out"; exit 1; }
    ;;
  check) cargo_test "$PARSE_TEST::snapshot_matches_live_parse" "$BIND_TEST::snapshot_matches_live_bind" ;;
  write)
    cargo_test --ignored "$PARSE_TEST::generate_lib_parse_snapshot"
    cargo_test --ignored "$BIND_TEST::generate_lib_bind_snapshot"
    cargo_test "$PARSE_TEST::snapshot_matches_live_parse" "$BIND_TEST::snapshot_matches_live_bind"
    git status --short -- "$C/src/frontend/parser/lib_parse.bin" "$C/src/binder/lib_bind.bin"
    ;;
  -h | --help | help) sed -n '2,/^set -euo/p' "$0" | sed '$d' ;;
  *) sed -n '2,/^set -euo/p' "$0" | sed '$d'; exit 2 ;;
esac
