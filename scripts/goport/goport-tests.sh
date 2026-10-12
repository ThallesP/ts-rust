#!/usr/bin/env bash
# Runs every protected goport test suite from prebuilt test binaries and writes per-name results.
#
# usage: scripts/goport/goport-tests.sh <testbin-dir> <out-dir> [--pin PIN]
#
# <testbin-dir> is a dir from build-goport-tests.sh: the test binaries, SUITES, relbin/, COMMIT,
# BUILD_ROOT, BUILD_TARGET and bins.sha256 (checked first; it must cover SUITES). Every test binary
# of the dir must be in SUITES and each one runs, in its crate dir (as cargo test runs it). PIN
# (default: GOPORT_PIN, else the saved state's batch.upstreamPin.to, else UPSTREAM.json current)
# selects the Go checkout (TS_GO_REPO, `pin.py path goCheckout`) and runs every binary under
# `pin.py exec`. One test thread (RUST_TEST_THREADS=1) everywhere, as the project runs them.
#
# The pin's layout (`pin.py show`) picks the long compiler runner test, which runs in 4 shards
# (COMPILER_RUNNER_SHARD=<i>/4, COMPILER_RUNNER_JOBS=8):
#   typescript-go  (microsoft/typescript-go) TestSubmodule; TestLocal runs in the default go_baselines run.
#   typescript     (microsoft/TypeScript, tsc/) no TypeScript submodule: TestLocal runs every case (about
#                  12,700), so it runs in the shards and the default go_baselines run skips it.
#
# The script runs in a clean environment: it starts itself again under `env -i` with only PATH, HOME,
# USER, XDG_RUNTIME_DIR, DBUS_SESSION_BUS_ADDRESS and LANG=C.UTF-8. So no setting of the caller
# (GOPORT_*, TSCTEST_FILTER, TS_GOPORT_BASELINE_*, S2_*, COMPILER_RUNNER_*, NODE_OPTIONS, ...)
# changes what a test runs.
#
# The test binaries have their build paths compiled in (fixtures under BUILD_ROOT/crates, release
# bins under BUILD_TARGET/release). So each binary runs in a bwrap that binds a git archive of
# COMMIT's crates/ over BUILD_ROOT/crates and relbin/ over BUILD_TARGET/release. The checkout and the
# shared target do not change the run, and the run does not change them.
#
# Suites (results.json "suites" keys):
#   lib_snapshot                  goport_core_lib (ts_goport_lib before crate split step 2)
#                                 snapshot_matches_live (the 2 lib snapshot tests, first)
#   <suite>                       each test binary of SUITES, by name (ts_goport_lib, goport_util_lib,
#                                 go_baselines (the default set), multi_program, ts_scanner_lib, ...)
#   go_baselines_local            TestLocal subtests, "<kind> <key>" (COMPILER_RUNNER_RESULTS rows)
#   go_baselines_transpile        TestTranspile subtests, "<kind> <key>" (TRANSPILE_RUNNER_RESULTS rows;
#                                 only when go_baselines has compiler_runner::test_transpile, from bump B)
#   go_baselines_submodule_shards TestSubmodule in 4 shards (layout typescript-go), "<test> <i>/4"
#   go_baselines_submodule        TestSubmodule subtests, "<kind> <key>" (layout typescript-go)
#   go_baselines_local_shards     TestLocal in 4 shards (layout typescript), "<test> <i>/4"
#   go_baselines_reference        each file under the Go testdata/baselines/reference, by its path:
#                                 - compared by a compiler runner (a "baseline" row): the status of its
#                                   subtest (the path with submoduleAccepted/ and submoduleTriaged/ read
#                                   as submodule/, and .diff and the kind extension dropped);
#                                 - else compared by another go_baselines test (TS_GOPORT_BASELINE_TRACK
#                                   of the default run: tsc, tsbuild, tsoptions, config, astnav, ...) or
#                                   by a runner with no subtest of its kind: ok when no go_baselines
#                                   test and no shard failed or is unrun, else failed (the track file
#                                   does not say which test compared a file);
#                                 - else ignored (not compared).
#
# Output in <out-dir> (it must not have results.json or logs/):
#   results.json  {"source": {"commit", "tree", "testbinSha256"}, "pin",
#                  "suites": {"<suite>": {"<test name>": "ok" | "failed" | "ignored" | "unrun"}},
#                  "incomplete": ["<suite>", ...]}
#                 tree is COMMIT's crates tree, testbinSha256 the sha256 of bins.sha256. "unrun" is a
#                 name that `--list` shows but that has no result (a crash or a timeout). A suite is
#                 incomplete when a binary of it ended without all its results.
#   logs/         <suite>.log (stdout and stderr, then exit=<rc>), <suite>.list (--list),
#                 <suite>.results (libtest --logfile)
#   *.tsv         the compiler runner results (COMPILER_RUNNER_RESULTS, TRANSPILE_RUNNER_RESULTS) of
#                 TestLocal, TestTranspile and each shard (go_baselines_submodule-<i>.tsv or
#                 go_baselines_local-<i>.tsv)
#   go_baselines.track  the reference paths that the default go_baselines run compared
# Last stdout line: DONE (every suite ran and results.json is written; test failures are in
# results.json) or FAIL rc=<N>. Compare two results with compare-tests.py.
set -uo pipefail

# One brace group: bash reads the whole script before it runs it, so an edit of this file does not
# change a running check.
{
fail() { echo "goport-tests.sh: $2" >&2; echo "FAIL rc=$1"; exit "$1"; }
usage() { sed -n '2,/^set -uo/p' "$0" | sed '$d'; echo "FAIL rc=2"; exit 2; }

# The clean environment (see the header). GOPORT_PIN of the caller becomes --pin, before the
# arguments, so an explicit --pin wins.
allow='PATH|HOME|LANG|USER|XDG_RUNTIME_DIR|DBUS_SESSION_BUS_ADDRESS|GOPORT_TESTS_CLEAN|PWD|OLDPWD|SHLVL|_'
if compgen -e | grep -qvxE "$allow"; then
  [[ -z ${GOPORT_TESTS_CLEAN:-} ]] || fail 2 "GOPORT_TESTS_CLEAN is set, but the environment has $(compgen -e | grep -vxE "$allow" | tr '\n' ' ')"
  keep=(GOPORT_TESTS_CLEAN=1 PATH="$PATH" HOME="$HOME")
  for v in USER XDG_RUNTIME_DIR DBUS_SESSION_BUS_ADDRESS; do [[ -z ${!v:-} ]] || keep+=("$v=${!v}"); done
  exec env -i "${keep[@]}" "$BASH" "${BASH_SOURCE[0]}" ${GOPORT_PIN:+--pin "$GOPORT_PIN"} "$@"
fi
export LANG=C.UTF-8

here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
ROOT=$(dirname "$(git -C "$here" rev-parse --path-format=absolute --git-common-dir)")

pin=
args=()
while (($#)); do
  case $1 in
  --pin) (($# >= 2)) || usage; pin=$2; shift 2 ;;
  -h | --help) usage ;;
  *) args+=("$1"); shift ;;
  esac
done
((${#args[@]} == 2)) || usage
[[ -n $pin ]] || pin=$(jq -r '.batch.upstreamPin.to // empty' "$ROOT/docs/typechecker-state/current.json" 2> /dev/null)
[[ -n $pin ]] || pin=$(jq -r .current "$ROOT/UPSTREAM.json")
TB=$(realpath -- "${args[0]}") || fail 2 "no test bin dir ${args[0]}"
O=$(realpath -m -- "${args[1]}")
[[ ! -e $O/results.json && ! -e $O/logs ]] || fail 2 "$O has results.json or logs/ (results are never replaced)"

for f in COMMIT BUILD_ROOT BUILD_TARGET SUITES bins.sha256; do [[ -s $TB/$f ]] || fail 3 "$TB has no $f"; done
(cd "$TB" && sha256sum -c --quiet bins.sha256) || fail 3 "$TB/bins.sha256 does not match"
grep -q '  SUITES$' "$TB/bins.sha256" || fail 3 "$TB/bins.sha256 does not cover SUITES"
COMMIT=$(cat "$TB/COMMIT") BUILD_ROOT=$(cat "$TB/BUILD_ROOT") BUILD_TARGET=$(cat "$TB/BUILD_TARGET")
tree=$(git -C "$ROOT" rev-parse --verify --quiet "$COMMIT:crates") || fail 3 "no commit $COMMIT"
[[ -d $BUILD_ROOT/crates && -d $BUILD_TARGET/release && -d $TB/relbin ]] ||
  fail 3 "missing bind path: $BUILD_ROOT/crates, $BUILD_TARGET/release or $TB/relbin"
GO=$(python3 "$ROOT/scripts/upstream/pin.py" path goCheckout "$pin") || fail 3 "unknown pin $pin"
[[ -d $GO/testdata/baselines/reference ]] || fail 3 "no Go checkout at $GO"
layout=$(python3 "$ROOT/scripts/upstream/pin.py" show "$pin" | jq -r .layout) || fail 3 "no record for pin $pin"
# The sharded test (see the header): <suite prefix> <libtest name>.
case $layout in
typescript-go) shard_suite=go_baselines_submodule shard_test=compiler_runner::test_submodule ;;
typescript) shard_suite=go_baselines_local shard_test=compiler_runner::test_local ;;
*) fail 3 "pin $pin has layout '$layout', not typescript-go or typescript" ;;
esac

# SUITES: "<suite>\t<crate dir>". Each crate dir is under crates/ (the archived tree), each suite is
# a test binary of the dir, and each test binary of the dir is a suite.
declare -A crate_dir
suites=()
while IFS=$'\t' read -r s d; do
  case $s in
  lib_snapshot | go_baselines_local | go_baselines_transpile | go_baselines_submodule | \
    go_baselines_submodule_shards | go_baselines_submodule-* | go_baselines_local_shards | \
    go_baselines_local-* | go_baselines_reference)
    fail 3 "SUITES: $s is the name of a derived suite" ;;
  esac
  [[ -f $TB/$s && -x $TB/$s ]] || fail 3 "SUITES: no test binary $TB/$s"
  [[ $d == crates/* ]] || fail 3 "SUITES: $s runs in $d, which is not under crates/"
  crate_dir[$s]=$d
  suites+=("$s")
done < "$TB/SUITES"
for f in "$TB"/*; do
  [[ ! -f $f || ! -x $f || -n ${crate_dir[${f##*/}]+x} ]] || fail 3 "test binary ${f##*/} is not in SUITES"
done

mkdir -p "$O/logs" "$O/tmp" || fail 4 "cannot make $O"
rm -rf "$O/src" && mkdir -p "$O/src" || fail 4 "cannot make $O/src"
git -C "$ROOT" archive "$COMMIT" crates | tar -x -C "$O/src" || fail 4 "git archive of $COMMIT failed"

export GOPORT_PIN=$pin TS_GO_REPO=$GO RUST_TEST_THREADS=1
# Each suite runs in its own scope with a 24 GB cap. OOMPolicy=continue: when the kernel OOM killer kills
# one compiler runner child at the cap (a case whose memory grows without bound in a port that lacks
# an upstream fix, as new cases at 673a5f17d713 do), that child is a crash row and the suite goes on.
# With the default policy (stop) systemd stops the whole scope and the suite ends (exit 143).
cap=(systemd-run --user --scope --quiet --collect -p MemoryMax=24000000K -p MemorySwapMax=0 -p OOMPolicy=continue
  nice -n 10)
pinwrap=(python3 "$ROOT/scripts/upstream/pin.py" exec --)
state() { echo "$1 $(date -u +%FT%TZ) Go $(git -C "$GO" rev-parse --short=12 HEAD) Go-dirty $(git -C "$GO" status --porcelain | wc -l) load $(cut -d' ' -f1-3 /proc/loadavg)"; }

# suite <name> <binary> <timeout s> [test args...]: lists, then runs one test binary in its crate dir.
# The caller sets extra environment on the call.
suite() {
  local name=$1 bin=$TB/$2 dir=$BUILD_ROOT/${crate_dir[$2]} secs=$3 rc
  shift 3
  local box=(bwrap --dev-bind / / --bind "$O/src/crates" "$BUILD_ROOT/crates"
    --ro-bind "$TB/relbin" "$BUILD_TARGET/release" --chdir "$dir" --)
  rm -f "$O/logs/$name.results"
  CARGO_MANIFEST_DIR=$dir "${cap[@]}" "${pinwrap[@]}" "${box[@]}" "$bin" "$@" --list > "$O/logs/$name.list" 2>&1
  CARGO_MANIFEST_DIR=$dir timeout "$secs" "${cap[@]}" "${pinwrap[@]}" "${box[@]}" "$bin" "$@" \
    --logfile "$O/logs/$name.results" > "$O/logs/$name.log" 2>&1
  rc=$?
  echo "exit=$rc" >> "$O/logs/$name.log"
  echo "$name exit=$rc $(grep -m1 '^test result:' "$O/logs/$name.log") $(date -u +%FT%TZ)"
}

echo "== goport tests: $TB (${COMMIT:0:9}, crates tree ${tree:0:12}), pin $pin, Go $GO, out $O"
[[ $layout == typescript-go ]] || echo "layout $layout: $shard_test runs in 4 shards"
state before
# The 2 lib snapshot tests are in goport_core_lib from crate split step 2, in ts_goport_lib before.
snapshot_bin=ts_goport_lib
[[ -z ${crate_dir[goport_core_lib]+x} ]] || snapshot_bin=goport_core_lib
[[ -z ${crate_dir[$snapshot_bin]+x} ]] || suite lib_snapshot "$snapshot_bin" 1200 snapshot_matches_live
for s in "${suites[@]}"; do
  if [[ $s != go_baselines ]]; then
    suite "$s" "$s" 1800
    continue
  fi
  mkdir -p "$O/tmp/local"
  # At a typescript pin the shards run TestLocal, so the default run skips it (--exact: only that name).
  skip=()
  [[ $layout == typescript-go ]] || skip=(--exact --skip "$shard_test")
  COMPILER_RUNNER_TMP=$O/tmp/local COMPILER_RUNNER_RESULTS=$O/go_baselines_local.tsv \
    TRANSPILE_RUNNER_RESULTS=$O/go_baselines_transpile.tsv TS_GOPORT_BASELINE_TRACK=$O/go_baselines.track \
    suite go_baselines go_baselines 3600 "${skip[@]}"
  for i in 0 1 2 3; do
    mkdir -p "$O/tmp/sub$i"
    COMPILER_RUNNER_TMP=$O/tmp/sub$i COMPILER_RUNNER_SHARD=$i/4 COMPILER_RUNNER_JOBS=8 \
      COMPILER_RUNNER_RESULTS=$O/$shard_suite-$i.tsv \
      suite "$shard_suite-$i" go_baselines 3600 --exact "$shard_test" --include-ignored
  done
done
state after

# results.json from the --list, --logfile, compiler runner and track files.
python3 - "$O" "$TB" "$COMMIT" "$tree" "$pin" "$GO/testdata/baselines/reference" "$shard_suite" "$shard_test" \
  "${suites[@]}" << 'PY' || fail 5 "results.json not written"
import hashlib, json, os, sys
out, tb, commit, tree, pin, ref_root, shard_base, shard_test = sys.argv[1:9]
binaries = sys.argv[9:]
# go_baselines_local comes from the default run at a typescript-go pin, from the shards at a typescript pin.
local_in_shards = shard_base == 'go_baselines_local'
logs = os.path.join(out, 'logs')
LIBTEST = {'ok': 'ok', 'failed': 'failed', 'ignored': 'ignored'}
RUNNER = {'pass': 'ok', 'fail': 'failed', 'skip': 'ignored'}
WORST = ['ok', 'ignored', 'failed']
suites, incomplete = {}, set()

def libtest(name):
    """{test name: status} of one run, and whether every listed name has a result."""
    listed = [l[:-len(': test')] for l in open(os.path.join(logs, name + '.list'), errors='replace').read().splitlines()
              if l.endswith(': test')]
    res_path = os.path.join(logs, name + '.results')
    got = {}
    if os.path.exists(res_path):
        # "ok <name>", "failed <name>", "ignored <name>" or "ignored: <reason> <name>". Test names
        # have no spaces, so the name is the last word.
        for l in open(res_path, errors='replace').read().splitlines():
            words = l.split()
            if len(words) >= 2 and words[0].rstrip(':') in LIBTEST:
                got[words[-1]] = LIBTEST[words[0].rstrip(':')]
    names = {n: got.get(n, 'unrun') for n in listed}
    names.update(got)
    return names, bool(listed) and all(n in got for n in listed)

def ran(name):
    return os.path.exists(os.path.join(logs, name + '.list'))

for name in ['lib_snapshot'] + binaries:
    if ran(name):
        suites[name], complete = libtest(name)
        if not complete:
            incomplete.add(name)

def runner_rows(paths, subtests, compared):
    """Reads compiler runner results files into subtests {"<kind> <key>": status} and compared paths."""
    dups = 0
    for path in paths:
        if not os.path.exists(path):
            continue
        for line in open(path, encoding='utf-8', errors='surrogateescape'):
            f = line.rstrip('\n').split('\t')
            if f[0] == 'baseline' and len(f) >= 2:
                compared.add(f[1])
            elif f[0] in RUNNER and len(f) >= 3:
                n, st = f'{f[1]} {f[2]}', RUNNER[f[0]]
                if n in subtests:
                    dups += 1
                    st = max(st, subtests[n], key=WORST.index)
                subtests[n] = st
    return dups

compared = set()
status_of_parent = lambda suite, test: suites.get(suite, {}).get(test)
if ran('go_baselines'):
    if not local_in_shards:
        local = {}
        dups = runner_rows([os.path.join(out, 'go_baselines_local.tsv')], local, compared)
        suites['go_baselines_local'] = local
        if status_of_parent('go_baselines', 'compiler_runner::test_local') not in ('ok', 'failed'):
            incomplete.add('go_baselines_local')
        if dups:
            print(f'go_baselines_local: {dups} repeated subtests (the worst status is kept)')
    parent = status_of_parent('go_baselines', 'compiler_runner::test_transpile')
    if parent is not None:
        transpile = {}
        dups = runner_rows([os.path.join(out, 'go_baselines_transpile.tsv')], transpile, compared)
        suites['go_baselines_transpile'] = transpile
        if parent not in ('ok', 'failed'):
            incomplete.add('go_baselines_transpile')
        if dups:
            print(f'go_baselines_transpile: {dups} repeated subtests (the worst status is kept)')
shards = [i for i in range(4) if ran(f'{shard_base}-{i}')]
if shards:
    sub, shard_suite = {}, {}
    dups = runner_rows([os.path.join(out, f'{shard_base}-{i}.tsv') for i in shards], sub, compared)
    for i in shards:
        names, complete = libtest(f'{shard_base}-{i}')
        for test, st in names.items():
            shard_suite[f'{test} {i}/4'] = st
        if not complete or names.get(shard_test) not in ('ok', 'failed'):
            incomplete.update([f'{shard_base}_shards', shard_base])
    if len(shards) < 4:
        incomplete.update([f'{shard_base}_shards', shard_base])
    suites[f'{shard_base}_shards'] = shard_suite
    suites[shard_base] = sub
    if dups:
        print(f'{shard_base}: {dups} repeated subtests (the worst status is kept)')

# Reference files (see the header). The subtest of a runner file: as
# upstream/bumpB/wave3/r1/tools/coverage.py, with the .diff files and the submoduleAccepted/ and
# submoduleTriaged/ copies too.
KIND_OF_EXT = {'.errors.txt': 'error', '.js': 'output', '.js.map': 'sourcemap', '.sourcemap.txt': 'sourcemaprecord',
               '.types': 'types', '.symbols': 'symbols', '.trace.json': 'moduleresolution',
               '.contentmapper': 'contentmapper'}
EXTS = sorted(KIND_OF_EXT, key=len, reverse=True)
RUNNER_SUITES = ('go_baselines_local', 'go_baselines_submodule', 'go_baselines_transpile')
if ran('go_baselines'):
    by_stem = {}
    for s in RUNNER_SUITES:
        for n, st in suites.get(s, {}).items():
            kind, key = n.split(' ', 1)
            if key.count('/') < 2:
                continue
            where, suite, cname = key.split('/', 2)
            for ext in ('.tsx', '.ts'):
                if cname.endswith(ext):
                    cname = cname[:-len(ext)]
                    break
            by_stem[(('submodule/' if where == 'submodule' else '') + f'{suite}/{cname}', kind)] = st

    def subtest_of(rel):
        r = rel[:-len('.diff')] if rel.endswith('.diff') else rel
        for copy in ('submoduleAccepted/', 'submoduleTriaged/'):
            if r.startswith(copy):
                r = 'submodule/' + r[len(copy):]
        ext = next((e for e in EXTS if r.endswith(e)), None)
        return by_stem.get((r[:-len(ext)], KIND_OF_EXT[ext])) if ext else None

    track = os.path.join(out, 'go_baselines.track')
    tracked = set(open(track, encoding='utf-8', errors='surrogateescape').read().split('\n')) - {''} \
        if os.path.exists(track) else set()
    runs = [suites.get('go_baselines', {}), suites.get(f'{shard_base}_shards', {})]
    other = 'failed' if any(st in ('failed', 'unrun') for r in runs for st in r.values()) else 'ok'
    ref, files = {}, set()
    for d, dirs, names in os.walk(ref_root):
        dirs.sort()
        for f in sorted(names):
            rel = os.path.relpath(os.path.join(d, f), ref_root)
            files.add(rel)
            st = subtest_of(rel) if rel in compared else None
            if st is not None:
                ref[rel] = st if st in ('ok', 'failed') else 'ignored'
            else:
                ref[rel] = other if rel in compared or rel in tracked else 'ignored'
    suites['go_baselines_reference'] = ref
    if {'go_baselines', 'go_baselines_local', 'go_baselines_submodule', 'go_baselines_transpile'} & incomplete or \
            not {'go_baselines_local', shard_base} <= suites.keys():
        incomplete.add('go_baselines_reference')
    print(f'go_baselines_reference: {len(tracked)} tracked paths, {len(tracked - files)} of them not reference '
          'files (TS submodule paths, or a compare with no file)')

sha = hashlib.sha256(open(os.path.join(tb, 'bins.sha256'), 'rb').read()).hexdigest()
doc = {'source': {'commit': commit, 'tree': tree, 'testbinSha256': sha}, 'pin': pin,
       'suites': {s: dict(sorted(n.items())) for s, n in sorted(suites.items())},
       'incomplete': sorted(incomplete)}
tmp = os.path.join(out, 'results.json.tmp')
with open(tmp, 'w', encoding='utf-8', errors='surrogateescape') as f:
    json.dump(doc, f, indent=1, ensure_ascii=False)
    f.write('\n')
os.replace(tmp, os.path.join(out, 'results.json'))
for s, n in doc['suites'].items():
    c = {k: sum(v == k for v in n.values()) for k in ('ok', 'failed', 'ignored', 'unrun')}
    print(f'{s}: {len(n)} names, ' + ', '.join(f'{k} {v}' for k, v in c.items() if v or k == 'ok'))
print(f'incomplete: {", ".join(doc["incomplete"]) or "none"}')
PY
rm -rf "$O/src" "$O/tmp"
echo "results $O/results.json sha256 $(sha256sum < "$O/results.json" | cut -c1-64)"
echo DONE
exit 0
}
