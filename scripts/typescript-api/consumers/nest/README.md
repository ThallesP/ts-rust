# NestJS end-to-end harness

Runs NestJS tooling (`@nestjs/cli` 12.0.8, `@nestjs/swagger` 12.0.2, `@nestjs/graphql` 14.0.3)
against a `typescript` package directory or tarball, and diffs two runs. Entry point:
`scripts/typescript-api/consumers/nest.sh` (`nest.sh help`). Background: `/work/scratch/research/R-nest.md`.

```sh
scripts/typescript-api/consumers/nest.sh run npm/typescript-api/.cache/typescript-6.0.3.tgz target/typescript-api/consumers/nest/runs/stock
scripts/typescript-api/consumers/nest.sh run npm/typescript-api target/typescript-api/consumers/nest/runs/pkg --env TSRS_DEV_HOOKS=1
scripts/typescript-api/consumers/nest.sh compare target/typescript-api/consumers/nest/runs/stock target/typescript-api/consumers/nest/runs/pkg --out target/typescript-api/consumers/nest/runs/stock-vs-pkg
```

## How the package is installed

`run` packs the package with `npm pack --ignore-scripts` (a `.tgz` argument is used as is) into
`<out>/package/`, unpacks it and records a manifest (sha256 per file, `treeHash`). Each app copy
gets `"typescript": "file:<tgz>"` in the section that held typescript and
`"overrides": {"typescript": "$typescript"}`, and its lockfile loses its typescript entries. After
`npm install`, every `node_modules/**/typescript` directory must have the package's `treeHash`
(check "every installed typescript copy is the package under test", `<scenario>/install.json`).
nest-cli (a) is the exception: `npm ci`, then `npm install --no-save typescript@file:<tgz>`, so that
its own `test/package-json.spec.ts` keeps passing.

Upstream sources are cloned at the commits in `pins.json` into
`target/typescript-api/consumers/nest/_cache/src/`. Sample installs use `--before` (`pins.json`
`npmBefore`) and reuse the lockfile of their first install (`_cache/locks/`), so transitive
versions do not drift between the two runs of a comparison. npm uses its own cache
(`_cache/npm`). App copies live in `target/typescript-api/consumers/nest/<scenario>/` and are
recreated from scratch (node_modules included) on every run. One run at a time (`.lock`).

## Scenarios

| | id | what runs | kept outputs |
|---|---|---|---|
| a | nest-cli-unit | nestjs/nest-cli 12.0.8 as its CI does: `npm ci`, `npm run build` (the package's `bin/tsc`), `npm run clean`, `npm test` (vitest, 4 workers) | `build/` (files the build created), per-test results |
| b | swagger-sample | nestjs/nest `sample/11-swagger` (ESM, nodenext): `npm run build` (tsc builder, swagger plugin with introspectComments), its unit and e2e vitest suites, `node dist/main.js`, `GET /api-json` | `dist/`, tsbuildinfo, `api-json.json`, per-test results |
| c | cjs-paths | `../fixtures/nest-cjs-paths`: CommonJS, `baseUrl` + `paths` (`@app/*`, `@common`), `ignoreDeprecations: "6.0"`, swagger plugin; `npm run build`, run the app, six HTTP requests, `GET /api-json`; checks that no alias is left in `dist` | `dist/`, tsbuildinfo, `http/*.json`, `api-json.json` |
| d | cjs-paths-watch | the same fixture with `nest start --watch`: first build, `GET /`, edit `src/app.service.ts`, wait for "File change detected" and the second "Found 0 errors", check the restarted app answers the edit, stop | `dist-initial/`, `dist-after-edit/`, `http/`, watch event order |
| e | swagger-swc | `sample/11-swagger` plus `@swc/cli`/`@swc/core` (`pins.json`): `nest build --builder swc --type-check` | `dist/`, `metadata.ts` (TS program + printer) |
| f | graphql-sample | `sample/23-graphql-code-first` with the graphql plugin: `--legacy-peer-deps`, `strict: false` (TS 6.0 defaults to strict and the sample has 4 errors), plus `@as-integrations/express5` (missing from the sample; the app does not start without it); `npm run build`, run the app, one GraphQL query | `dist/`, tsbuildinfo, the generated `schema.gql`, `http/` |

Every scenario also keeps `build-output.txt` (build output with paths, times and pids replaced)
where it builds. Samples listen on port 3000; `preload-port.cjs` (`node -r`) moves them to a free
port without editing them. The fixture reads `PORT`.

## Output

`<out>/results.json` (package, pins, host, every scenario record) and `<out>/summary.md`;
per scenario `<out>/<id>/status.json` (status `pass`/`fail`/`error`, steps with exit codes, times
and logs, checks, tests, artifacts, metrics), `logs/NN-<step>.log`, the artifacts above,
`tests/<suite>.json` (`{counts, tests: {"<file> > <describe> > <test>": status}}`) and the raw
vitest report. A scenario fails when a step exits non-zero or a required check fails; `info`
checks never fail it. `run` exits 0 when every scenario passes, 1 otherwise.

## Compare

`compare <base> <new>` prints a markdown report: status per scenario, step and check changes,
per suite the retained, lost, recovered, absent and added tests, and per artifact the files that
differ byte by byte (unified diff excerpts; JSON files are diffed with sorted keys and labelled
"bytes differ, JSON equal" when only order or spacing changed), plus the watch event order.
Times are shown, never counted. Exit 0 when nothing differs, 1 otherwise. `--out <dir>` writes
`compare.md` (longer excerpts), `compare.json` and every full diff under `diffs/`.

## Environment

- `--env NAME=VALUE` (repeatable) reaches builds, tests and apps, never npm, so a `NODE_OPTIONS`
  preload does not run inside npm.
- `TSRS_*` variables of the caller reach every command (for example `TSRS_DEV_HOOKS=1`,
  `TSRS_API_CHANNEL`, `TSRS_NAPI_PATH`).
- `nest.sh run` re-runs itself under `systemd-run --user --collect --wait --pipe` with
  `MemoryMax=12G` (`NEST_HARNESS_NO_UNIT=1` skips that). `NEST_HARNESS_TIMEOUT_SCALE=N`
  multiplies every timeout.
- Needs network access for the first clone and npm installs; later runs work from the caches as
  long as the package set does not change.
