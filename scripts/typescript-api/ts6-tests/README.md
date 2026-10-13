# TS 6.0.3 test harness for a `typescript` library

Runs TypeScript 6.0.3's own tests, unmodified, against a library directory: any package directory
with `lib/typescript.js`, such as `npm/typescript-api` (tsc-rs) or a stock `typescript@6.0.3`
install (the control). Background and the test inventory: `/work/scratch/research/R-tests.md`.

```sh
scripts/typescript-api/ts6-tests/run.sh help
scripts/typescript-api/ts6-tests/run.sh setup        # optional: run does it when needed
scripts/typescript-api/ts6-tests/run.sh run npm/typescript-api target/typescript-api/runs/pkg --suite all
scripts/typescript-api/ts6-tests/run.sh compare target/typescript-api/ts6-baselines/stock-6.0.3 target/typescript-api/runs/pkg
```

## Build (cached)

`setup` (and the first `run`) clones microsoft/TypeScript `v6.0.3` (commit `050880ce59e3`, checked)
into `target/typescript-api/ts60`, runs `npm ci --ignore-scripts`, then `hereby tests --no-typecheck`,
`hereby dts` and `hereby generate-types-map` (the inputs of TS 6.0's own `runtests`), then
`build-swapped.mjs`. Stamps in `ts60/.ts6-tests/` skip finished steps; the swapped bundle is rebuilt
when `build-swapped.mjs` changes. The whole setup takes about a minute.
`TS6_TESTS_CACHE` and `TS6_TESTS_GIT` override the cache directory and the clone source.

## How the swap works

- `build-swapped.mjs` bundles `src/testRunner` with esbuild exactly like `hereby tests` (cjs,
  node14.17, no tree shaking, packages external), except that every product namespace barrel
  (`src/{compiler,services,jsTyping,server,typingsInstallerCore,deprecatedCompat}/_namespaces/ts.js`
  and `ts.server.js`) becomes `shim.cjs` (or its `.server`). The harness and test sources are
  bundled from the checkout unchanged; no compiler source is in `built/local/run-swapped.js`.
- `shim.cjs` is `require(<TS6_TESTS_LIBRARY>/lib/typescript.js)`. The library is the whole TS 6.0.3
  bundle (internals included, plus hooks in our package), so the tests read internals from the same
  object as the public API; there is no second TypeScript copy.
- Lib files stay as TS 6.0 does them: the harness mounts the checkout's `built/local/lib.*.d.ts` at
  `/.ts/` for test programs. `built/local/typescript.d.ts` is the library's own `lib/typescript.d.ts`
  (read by the Public APIs test and the APISample compiler cases); `typescript.internal.d.ts` comes
  from the TS 6.0 build (APILibCheck).
- Each mocha process runs in its own workspace `<out-dir>/ws/<name>/`: symlinks into the cache plus
  its own `test.config`, `tests/baselines/local/` (baselines that did not match land here) and a
  hard link of the bundle in `built/local/`. TS 6.0 resolves `tests/` against the working directory and
  `built/local/` against the bundle's directory, so runs and shards never share mutable files.
- `reporter.cjs` writes one JSON line per test as it finishes (a crashed process keeps its finished
  results; a missing end record marks the crash). Tests skipped by a failed `before` hook are
  recorded as failed, not left out.
- Self-check done once (2026-10-13): a fake library without `transpileModule` and with a throwing
  `createProgram` failed 1,090 of the 2,578 tier1 tests (398 with the fake error), so the tests do
  reach the library.

## Suites

| Suite | What | Tests | Wall, typescript@6.0.3 (dev host) |
|---|---|---|---|
| `apisamples` | The 9 APISample programs of `tests/cases/compiler/APISample_*.ts` (emitted JS taken from `tests/baselines/reference`), run with `node_modules/typescript` linked to the library; normalized output and written files are diffed against `apisamples/expected/` (recorded from typescript@6.0.3 with this harness). | 9 | 14 s |
| `tier1` | First-adoption selection (R-tests.md §4 rows 1-11; mocha grep in `suites.json`): Public APIs, regExpScannerRecovery, evaluation, Printer/Factory/Transform APIs, customTransforms, config parsing, programApi, moduleResolution, services Transpile/PreProcessFile/Colorization/DocumentRegistry/languageService, transpile runner. | 2,578 | 9-14 s |
| `compiler` | compiler + conformance runners, only `Correct errors for` and `Correct JS output for` (every test case and configuration), sharded over `--jobs` mocha processes by TS 6.0's own `shards`/`shardId` test config. | 29,946 | 4 jobs: 119 s (load ~10), 200-250 s (load ~20), 5.6 GiB peak; 1 job: 595 s (load ~20), 1.9 GiB |
| `all` | The three above, in that order. | 32,533 | |

The watch samples wait for output markers ("Watching for file changes", "Emitting") instead of fixed
delays: edit after the first compile, stop with SIGINT one second after the next one
(`TS6_TESTS_WATCH_TIMEOUT`, default 60 s per wait; `TS6_TESTS_WATCH_SETTLE`, 1 s;
`TS6_TESTS_SAMPLE_TIMEOUT`, 120 s for the other samples).

Which suites exercise programs, the checker and emit (and therefore tsc-rs once the hooks land):

- `compiler`: every test builds a program, checks it and emits through the public `createProgram`
  path (`compilerImpl.ts`); "Correct errors" compares diagnostics with the TS 6.0 `.errors.txt`
  baseline, "Correct JS output" the emit with the `.js` baseline. This is the main tsc-rs suite.
- `tier1`: evaluation (compile and run), Transpile and the transpile runner (`transpileModule`,
  emit), programApi, moduleResolution, customTransforms/TransformAPI (custom transformers on
  `program.emit`), languageService and DocumentRegistry (programs through the LanguageService),
  builder (builder programs), and the Public APIs `getTypeAtLocation` and `createProgram` tests.
  The rest of Public APIs (d.ts check, tokens, JSDoc, modifiers), regExpScannerRecovery, config,
  Printer/Factory and PreProcessFile/Colorization are syntax or config level and stay TS 6.0's own JS.
- `apisamples`: compile (createProgram, getPreEmitDiagnostics, emit), jsdoc (checker symbols),
  transform (`ts.transpile`, through the `transpileWorker` hook), the watch samples (watch program
  and builder, emitted files), watcher (LanguageService emit). linter is syntax level; parseConfig
  stops on the sample's own TypeError before it builds a program (TS 6.0.3 does the same).

Expected failures once tsc-rs answers: TS 7 removed settings that many TS 6.0 tests use (ES5
target, AMD/System/UMD, Classic/Node10, `outFile`, `baseUrl`, `downlevelIteration`). R-tests.md
§4 lists them per suite; `ts7-removed.json` per tier1 test (see Compare).

## Outputs (`<out-dir>`)

- `results.json`: array, one entry per test: `suite`, `title` (mocha full title; APISamples are
  `APISample_<name>`), `top` (top-level describe), `state` (`pass`, `fail`, `pending`), `error`
  (first line).
- `summary.md`: counts per suite (with wall time, exit codes, crashes), per top-level describe, per
  compiler check, and the first failures.
- `meta.json`: library path and content fingerprint (`package.json`, `lib/typescript.{js,d.ts}`,
  `src/**`, `native/**`; checked again after the run), the `TSRS_*` environment, TS 6.0 commit, node,
  per-process exit code, time and local-baseline count, and the systemd unit's memory peak.
- `harness.log` (ends with `DONE` or `FAIL rc=N`), `raw/<process>.{jsonl,log}` (reporter lines and
  mocha output), `ws/<process>/tests/baselines/local/` (mismatched baselines),
  `apisamples/out/` (sample outputs) and `apisamples/work-*` (sample work dirs).

## Baselines on this host (2026-10-13, not committed)

- `target/typescript-api/ts6-baselines/stock-6.0.3`: typescript@6.0.3, `--suite all`: 32,533 of 32,533 pass.
- `target/typescript-api/ts6-baselines/pkg-nohooks`: `npm/typescript-api` without `TSRS_DEV_HOOKS`
  (no hooks installed): 32,533 of 32,533 pass; `compare` against the stock run: all retained, exit 0.

## Compare

`compare <base-out> <new-out>` prints per suite: base and new pass counts, retained, lost (base pass,
new fail or pending), gained, absent (in base, not run in new; base passes in parentheses),
still failing, and added tests, then up to `--limit` names per category with the new error line.
`--json FILE` writes every name. Exit 1 when any base pass is lost or absent. Only suites present in
both runs are compared; the others are listed as unrun. Tests that pass a setting TS 7 removed are
marked `[TS7-removed: ...]` and counted in the "Lost (TS7-removed)" column: `ts7-removed.json` holds
the 689 tier1 tests that the R-tests.md probe (a typescript@6.0.3 wrapper that recorded the options
each test passed in, `/work/scratch/research/ts-api-tests/probe-removed.json`) flagged; 610 of them
are services Transpile tests, whose harness defaults to ES5.

## Resources

`run.sh setup|run` runs the harness in its own systemd user unit (`MemoryMax=12G`, no swap;
`TS6_TESTS_MEMORY_MAX` changes the cap, `TS6_TESTS_SYSTEMD=0` runs it in place). The unit gets PATH,
HOME and the `TS6_TESTS_*` and `TSRS_*` variables only. `--jobs` is at most 4. `--detach` starts the
unit and returns; poll `<out-dir>/harness.log` for `DONE` or `FAIL`.
