#!/usr/bin/env bash
# The T3 Code study copy with the API stability rules on and off (R190 reviewer item 7). For each workspace,
# with the workspace as cwd, `-p <config> --noEmit --pretty false`, build info removed before each run:
#   on   tsconfig.json as it is (unstableApiUsage and experimentalApiUsage at their default, warning)
#   off  tsconfig.rulesoff.json: extends tsconfig.json and sets the two rules off. The script writes it next to
#        tsconfig.json and removes it at the end. A workspace whose resolved config (ref --showConfig) lists no
#        Effect plugin (apps/mobile) gets no off run: there the entry would turn the other rules on.
# Sides: ours (tsc-rs) and ref (the tsc of effect-tsgo 0.51.1; its --version must end in +effect-tsgo.0.51.1).
# Checks: ours == ref (stdout and rc) on and off. It also counts the TS2790 lines: on T3 apps/server both tools
# print 14 with the rules on and none with them off (cause: crates/ts_goport/src/effect/PORTING.md, "TS2790
# with the stability rules").
# usage: scripts/effect/t3-rules-off.sh <t3 dir> <ours tsc> <ref tsc> <out dir> [workspace...]
#   default workspaces: apps/server apps/web apps/mobile packages/client-runtime packages/shared (int52 recipe)
# Output: <out>/<ws>.<on|off>.<ours|ref>.{out,err,rc} and <out>/summary.txt, whose last line is DONE (all
# SAME) or FAIL rc=1. Exit 0 only when all are SAME.
set -uo pipefail
[[ $# -ge 4 ]] || { sed -n '12,13p' "$0" >&2; exit 2; }
t3=$(cd "$1" && pwd) ours=$2 ref=$3 out=$4
shift 4
workspaces=("$@")
[[ ${#workspaces[@]} -gt 0 ]] || workspaces=(apps/server apps/web apps/mobile packages/client-runtime packages/shared)
version=$("$ref" --version)
[[ $version == *+effect-tsgo.0.51.1 ]] || { echo "$ref is '$version', not effect-tsgo 0.51.1" >&2; exit 2; }
mkdir -p "$out"
summary=$out/summary.txt
echo "ours $ours ($(sha256sum "$ours" | cut -c1-12)); ref $ref ($version); t3 $t3" > "$summary"
clean() { rm -f "$t3"/apps/*/tsconfig*.tsbuildinfo "$t3"/packages/*/tsconfig*.tsbuildinfo; }
off='{"extends":"./tsconfig.json","compilerOptions":{"plugins":[{"name":"@effect/language-service","diagnosticSeverity":{"unstableApiUsage":"off","experimentalApiUsage":"off"}}]}}'
fail=0
export GOPORT_LAUNCH=0
for ws in "${workspaces[@]}"; do
  dir=$t3/$ws n=${ws//\//-}
  modes=(on)
  if (cd "$dir" && "$ref" --showConfig -p tsconfig.json) | grep -q '"@effect/language-service"'; then
    modes+=(off)
    echo "$off" > "$dir/tsconfig.rulesoff.json"
  else
    echo "$n off: no Effect plugin in the resolved config, no off run" >> "$summary"
  fi
  for mode in "${modes[@]}"; do
    config=tsconfig.json
    [[ $mode == off ]] && config=tsconfig.rulesoff.json
    for side in ours ref; do
      bin=$ours
      [[ $side == ref ]] && bin=$ref
      clean
      (cd "$dir" && timeout 900 "$bin" -p $config --noEmit --pretty false > "$out/$n.$mode.$side.out" 2> "$out/$n.$mode.$side.err"
        echo $? > "$out/$n.$mode.$side.rc")
    done
    p=$out/$n.$mode
    same=SAME
    cmp -s "$p.ours.out" "$p.ref.out" && cmp -s "$p.ours.rc" "$p.ref.rc" || { same=DIFF; fail=1; }
    echo "$n $mode ours-vs-ref=$same lines=$(wc -l < "$p.ours.out")/$(wc -l < "$p.ref.out") rc=$(cat "$p.ours.rc")/$(cat "$p.ref.rc") TS2790=$(grep -c ' TS2790:' "$p.ours.out")/$(grep -c ' TS2790:' "$p.ref.out") TS377=$(grep -c ' TS377' "$p.ours.out")/$(grep -c ' TS377' "$p.ref.out")" >> "$summary"
  done
  rm -f "$dir/tsconfig.rulesoff.json"
done
clean
if [[ $fail == 0 ]]; then echo DONE >> "$summary"; else echo "FAIL rc=1" >> "$summary"; fi
cat "$summary"
exit $fail
