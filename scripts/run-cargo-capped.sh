#!/usr/bin/env bash
# Cargo for this repo with caps: TS_CARGO_SLOTS Cargo runs at a time across all worktrees (2 on zbook), a memory
# limit, and each worktree's own target dir.
# usage: scripts/run-cargo-capped.sh <cargo command> [args...]   e.g. build --release -p ts_goport --bins
#        scripts/run-cargo-capped.sh help                       this text
# - Target: <worktree>/target, with sccache when installed. Do not set CARGO_TARGET_DIR (TS_CARGO_SEPARATE_TARGET=1
#   with its own CARGO_TARGET_DIR only for a deliberate fresh-target reproduction).
# - TS_CARGO_JOBS: build jobs (the core count, at most 16). TS_CARGO_MEMORY_LIMIT_KIB: the memory cap of the run.
# - TS_CARGO_SLOTS: Cargo runs at a time (2 on zbook, 1 elsewhere). A run takes the first free slot lock
#   (/tmp/ts-rust-cargo-<id>.lock, then <id>-1.lock, ...); slot 0 keeps the old single-lock name.
# - Edit-loop builds (build, check, test, run, bench without --profile goport) use nightly -Zthreads=8 and
#   incremental ts_goport. TS_CARGO_NIGHTLY=0 TS_CARGO_INCREMENTAL=0 gives a stable build (for timing, or after an
#   internal compiler error). Without the nightly installed they stop with the install command.
#   --profile goport (fat LTO, 7 to 20 minutes) keeps the default toolchain: timing and shipped bins.
set -euo pipefail
case "${1:-}" in help | -h | --help) sed -n '2,/^set -euo/p' "$0" | sed '$d'; exit 0 ;; esac

# One brace group: bash reads the whole script before it runs it, so a run that
# waits for the lock keeps its own text when this file changes on disk.
{
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "${script_dir}/.." && pwd)"

# Build jobs. TS_CARGO_JOBS overrides the default: the core count, at most 16
# (16 on zbook's 32 cores and alvin's 24). Until 2026-10-10 every host but zbook
# got 1 job. Tests keep one thread either way.
cores="$(nproc 2>/dev/null || echo 1)"
default_jobs=$((cores < 16 ? cores : 16))
jobs="${TS_CARGO_JOBS:-$default_jobs}"
if [[ ! "$jobs" =~ ^[1-9][0-9]*$ ]]; then
  echo "TS_CARGO_JOBS must be a positive integer" >&2
  exit 2
fi

# Edit-loop builds (build, check, test, run, bench) use a pinned nightly with the
# parallel frontend, and build ts_goport incrementally. On dbook-lan a ts_goport
# rebuild took 75 s on 1.93.0 and 43 s on the nightly with -Zthreads=8, and a
# one-line edit 32 s with incremental. Program output and the quick gate were
# equal (target/continuation-r97-goport/buildspeed/bench.md).
# - TS_CARGO_NIGHTLY=0 keeps the default toolchain. `--profile goport` (shipped
#   and timing bins: build-release.sh, build-pgo.sh), RUSTUP_TOOLCHAIN and a
#   `+toolchain` argument keep it too. -Zthreads is the job count, at most 8.
# - When the nightly is not installed, an edit-loop build stops here with the
#   install command: a quiet fallback to the default toolchain made builds
#   slower with no error.
# - TS_CARGO_INCREMENTAL unset: incremental ts_goport and its parts (goport_core,
#   goport_util, goport_lsproto) in edit-loop builds only.
#   Other crates stay non-incremental, so sccache still caches them. 0 turns it
#   off, 1 turns it on for every workspace crate.
goport_profile=0
previous_arg=""
for arg in "$@"; do
  [[ "$arg" != -- ]] || break
  if [[ "$arg" == --profile=goport || ("$previous_arg" == --profile && "$arg" == goport) ]]; then
    goport_profile=1
  fi
  previous_arg="$arg"
done
edit_loop=0
case "${1:-}" in
  build | b | check | c | test | t | run | r | bench) ((goport_profile)) || edit_loop=1 ;;
esac

nightly="${TS_CARGO_NIGHTLY:-1}"
nightly_toolchain="${TS_CARGO_NIGHTLY_TOOLCHAIN:-nightly-2026-06-17}"
if [[ "$nightly" != 0 && "$nightly" != 1 ]]; then
  echo "TS_CARGO_NIGHTLY must be 0 or 1" >&2
  exit 2
fi
use_nightly=0
if ((edit_loop && nightly)) && [[ -z "${RUSTUP_TOOLCHAIN:-}" ]]; then
  if ! rustup toolchain list 2>/dev/null | grep -q "^${nightly_toolchain}-"; then
    echo "run-cargo-capped.sh: edit-loop builds use ${nightly_toolchain}, and it is not installed." >&2
    echo "  Install it: rustup toolchain install ${nightly_toolchain} --profile minimal" >&2
    echo "  Or build with the default toolchain (slower): TS_CARGO_NIGHTLY=0 $0 $*" >&2
    exit 2
  fi
  use_nightly=1
fi

# A virtual-memory limit applies per process. The slot locks below keep separate
# rustc and test processes from multiplying that limit beyond TS_CARGO_SLOTS runs.
# Allow 8 GiB for one job and 4 GiB per job for more jobs, capped at three
# quarters of available memory.
default_memory_limit_kib=$((jobs == 1 ? 8388608 : jobs * 4194304))
if [[ -r /proc/meminfo ]]; then
  available_memory_kib="$(awk '$1 == "MemAvailable:" { print $2; exit }' /proc/meminfo)"
  if [[ "$available_memory_kib" =~ ^[1-9][0-9]*$ ]] &&
    ((available_memory_kib * 3 / 4 < default_memory_limit_kib)); then
    default_memory_limit_kib=$((available_memory_kib * 3 / 4))
  fi
fi

memory_limit_kib="${TS_CARGO_MEMORY_LIMIT_KIB:-$default_memory_limit_kib}"
if [[ ! "$memory_limit_kib" =~ ^[1-9][0-9]*$ ]]; then
  echo "TS_CARGO_MEMORY_LIMIT_KIB must be a positive integer" >&2
  exit 2
fi

# LLVM and rustfmt reserve more address space than their resident memory use.
# Keep that reservation proportional to the actual cgroup memory limit.
virtual_memory_limit_kib="${TS_CARGO_VIRTUAL_MEMORY_LIMIT_KIB:-$((memory_limit_kib * 4))}"
if [[ ! "$virtual_memory_limit_kib" =~ ^[1-9][0-9]*$ ]]; then
  echo "TS_CARGO_VIRTUAL_MEMORY_LIMIT_KIB must be a positive integer" >&2
  exit 2
fi

# Worktrees share object storage but have different repository roots. Derive the
# lock from their common Git directory so parallel agents cannot accidentally
# start one memory-limited Cargo scope per worktree. An explicit ID remains
# useful for non-Git copies that should join the same build queue.
if [[ -n "${TS_CARGO_LOCK_ID:-}" ]]; then
  lock_seed="$TS_CARGO_LOCK_ID"
elif git_common_dir="$(
  git -C "$repo_root" rev-parse --path-format=absolute --git-common-dir 2>/dev/null
)"; then
  lock_seed="$git_common_dir"
else
  lock_seed="$repo_root"
fi
lock_id="$(printf '%s' "$lock_seed" | cksum | awk '{print $1}')"

# Limit the aggregate memory of Cargo and every process it starts. The existing
# virtual-memory limit below remains as a second line of defense for individual
# rustc and test processes.
if [[ "${TS_CARGO_CGROUP_ACTIVE:-0}" != 1 ]]; then
  exec systemd-run --user --scope --quiet --collect \
    -p "MemoryMax=${memory_limit_kib}K" \
    -p MemorySwapMax=0 \
    env TS_CARGO_CGROUP_ACTIVE=1 TS_CARGO_MEMORY_LIMIT_KIB="$memory_limit_kib" \
    "$0" "$@"
fi

# One target directory per worktree. Separate cold targets per agent cost a
# full rebuild each. A deliberate fresh-target reproduction sets
# TS_CARGO_SEPARATE_TARGET=1 and its own CARGO_TARGET_DIR.
default_target_dir="${repo_root}/target"
if [[ -n "${CARGO_TARGET_DIR:-}" && "${TS_CARGO_SEPARATE_TARGET:-0}" != 1 &&
  "$(realpath -m -- "$CARGO_TARGET_DIR")" != "$default_target_dir" ]]; then
  echo "CARGO_TARGET_DIR=${CARGO_TARGET_DIR} is not this worktree's target (${default_target_dir})." >&2
  echo "Unset it to share the worktree build, or set TS_CARGO_SEPARATE_TARGET=1 for a deliberate fresh target." >&2
  exit 2
fi
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$default_target_dir}"

# TS_CARGO_SLOTS Cargo runs at a time across all worktrees (2 on zbook, 1
# elsewhere): one lock file per slot, and slot 0 keeps the old lock name. From
# 2026-10-01 to 10-03 one slot made builds wait 1.9 min on average (p90 6.4 min)
# behind 20-minute PGO builds, while the long ts_goport rustc step uses 8 of
# zbook's 32 threads and no Cargo scope peaked above 11.6 GB of its 94 GB.
case "$(hostname)" in
  zbook) default_slots=2 ;;
  *) default_slots=1 ;;
esac
slots="${TS_CARGO_SLOTS:-$default_slots}"
if [[ ! "$slots" =~ ^[1-9][0-9]*$ ]]; then
  echo "TS_CARGO_SLOTS must be a positive integer" >&2
  exit 2
fi
slot=0
while :; do
  slot_suffix=""
  ((slot == 0)) || slot_suffix="-$slot"
  exec 9>"${TMPDIR:-/tmp}/ts-rust-cargo-${lock_id}${slot_suffix}.lock"
  if ((slots == 1)); then
    flock 9
    break
  fi
  flock -n 9 && break
  exec 9>&-
  slot=$(((slot + 1) % slots))
  ((slot)) || sleep 2
done

ulimit -v "$virtual_memory_limit_kib"
ulimit -c 0
export CARGO_BUILD_JOBS="$jobs"
export RUST_TEST_THREADS=1
export CARGO_PROFILE_DEV_DEBUG=0
export CARGO_PROFILE_TEST_DEBUG=0
export CARGO_PROFILE_DEV_CODEGEN_UNITS="${CARGO_PROFILE_DEV_CODEGEN_UNITS:-256}"
export CARGO_PROFILE_TEST_CODEGEN_UNITS="${CARGO_PROFILE_TEST_CODEGEN_UNITS:-256}"
unset CARGO_ENCODED_RUSTFLAGS
thread_flags=""
if ((jobs == 1)); then
  thread_flags=" -C llvm-args=--threads=1 -C link-arg=-Wl,--threads=1"
fi

cargo_args=()
if ((use_nightly)); then
  cargo_args+=("+${nightly_toolchain}")
  if ((jobs > 1)); then
    thread_flags+=" -Zthreads=$((jobs < 8 ? jobs : 8))"
  fi
fi
export RUSTFLAGS="${RUSTFLAGS:+$RUSTFLAGS }-C debuginfo=0${thread_flags}"

incremental="${TS_CARGO_INCREMENTAL:-}"
if [[ -z "$incremental" ]]; then
  incremental=0
  if ((edit_loop)); then
    incremental=ts_goport
  fi
fi
case "$incremental" in
  0 | 1) export CARGO_INCREMENTAL="$incremental" ;;
  ts_goport)
    # CARGO_INCREMENTAL would beat the per-package setting, and dev builds
    # every workspace crate incrementally by default.
    unset CARGO_INCREMENTAL
    export CARGO_PROFILE_DEV_INCREMENTAL=false
    cargo_args+=(
      --config profile.dev.package.ts_goport.incremental=true
      --config profile.release.package.ts_goport.incremental=true
      --config profile.dev.package.goport_util.incremental=true
      --config profile.release.package.goport_util.incremental=true
      --config profile.dev.package.goport_lsproto.incremental=true
      --config profile.release.package.goport_lsproto.incremental=true
      --config profile.dev.package.goport_core.incremental=true
      --config profile.release.package.goport_core.incremental=true
    )
    ;;
  *)
    echo "TS_CARGO_INCREMENTAL must be 0 or 1" >&2
    exit 2
    ;;
esac

# sccache shares compiled crates across worktrees. Its server runs inside this
# capped scope on a private socket, without the lock descriptor, and stops with
# the build. TS_CARGO_SCCACHE=0 disables it.
if [[ "${TS_CARGO_SCCACHE:-1}" == 1 ]] && command -v sccache >/dev/null; then
  export RUSTC_WRAPPER=sccache
  export SCCACHE_SERVER_UDS="${TMPDIR:-/tmp}/ts-rust-sccache-${lock_id}${slot_suffix}.sock"
  export SCCACHE_IDLE_TIMEOUT=120
  sccache --start-server >/dev/null 9>&-
  trap 'sccache --stop-server >/dev/null 2>&1 || true' EXIT
  cargo "${cargo_args[@]}" "$@"
  exit
fi

exec cargo "${cargo_args[@]}" "$@"
}
