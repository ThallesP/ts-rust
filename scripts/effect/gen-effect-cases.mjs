#!/usr/bin/env node
// Generates the in-repo Effect diagnostic cases of crates/ts_goport/tests/effect_cases
// (the test target crates/ts_goport/tests/effect_cases.rs runs them). The expected
// outputs come from the reference binary (effect-tsgo `tsc`), never from our compiler.
//
// Suites (one case file each, <suite>.txt):
//   go_unit    the inline sources of the Go API stability unit tests and the config tables of
//              internal/effectconfigcheck/validation_test.go (go-unit-source.mjs)
//   effect_v3  the cases of testdata/tests/effect-v3 (reference-source.mjs), diagnostics only
//   effect_v4  the cases of testdata/tests/effect-v4, diagnostics only
// effect_v3 and effect_v4 import the pinned packages of testdata/tests/<version>/node_modules.
// <suite>.modules.gz holds the part of them that the cases load: every file that
// `--listFilesOnly` lists, and the package.json and LICENSE files of each package.
// Packages sit flat under node_modules/<name> (one version of each per suite).
//
// For each case the script builds the project twice, as the test does: (a) with the
// node_modules links to the effect repo's pnpm packages (as reference-cases.mjs runs
// it) and (b) with the links to the packages unpacked from <suite>.modules.gz. The
// `--pretty false` outputs of (a) and (b) must be equal: else the pack misses a file.
// (b) gives the expected output, and the `--pretty true` output (ANSI removed) when it
// prints related information.
//
// Case file format: lines that start with "#### " start a section; the lines up to
// the next one are its content (joined with "\n"). Header lines start with "# ".
//   #### case <name> <origin>
//   #### links <package>...       node_modules/<package> links to the unpacked pack (optional)
//   #### file <path>              a file of the project (path relative to the case dir)
//   #### run <cwd> <config>       tsc -p <config> runs in <cwd> (relative to the case dir)
//   #### out ok|fail              the `--pretty false` stdout; fail: a nonzero exit
//   #### pretty                   the `--pretty true` stdout without ANSI (optional)
// In the outputs, <case> stands for the case dir and <modules> for the node_modules dir
// of the unpacked pack: its absolute path (a few TS and Effect messages print it) and its
// path relative to the cwd (related information in a package file).
// The pack uses the same format (`#### file <path under node_modules>`). The tsconfig of
// each case is the one of go-unit-cases.mjs and reference-cases.mjs, on one line.
//
// usage: node scripts/effect/gen-effect-cases.mjs --ref <tsc> --effect-repo DIR [--work DIR] [--jobs N] [--check]
// --effect-repo is the Effect-TS/tsgo checkout with `pnpm install --filter ./testdata/tests/effect-v4
// --filter ./testdata/tests/effect-v3`. --check writes nothing: exit 1 when a generated file differs
// from the committed one. Prints the coverage of the Effect diagnostic codes.
import { execFile, execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import zlib from "node:zlib";
import { configProjects, goUnitProjects, goUnitTsconfig } from "./go-unit-source.mjs";
import { referenceCase } from "./reference-source.mjs";

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = path.join(root, "crates/ts_goport/tests/effect_cases");
const CATALOG = path.join(root, "crates/ts_goport/data/effect/effectDiagnosticMessages.json");
const { values: args } = parseArgs({
  options: {
    ref: { type: "string" },
    "effect-repo": { type: "string" },
    work: { type: "string", default: "/tmp/effect-gen-cases" },
    jobs: { type: "string", default: String(Math.max(1, os.availableParallelism() - 2)) },
    check: { type: "boolean", default: false },
  },
});
if (!args.ref || !args["effect-repo"]) {
  console.error("--ref and --effect-repo are required");
  process.exit(2);
}
const repo = fs.realpathSync(args["effect-repo"]);
fs.rmSync(args.work, { recursive: true, force: true });
fs.mkdirSync(args.work, { recursive: true });
const work = fs.realpathSync(args.work);

// Section format (see the header).
const MARK = "#### ";
function sections(text) {
  const result = [];
  const lines = (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");
  for (const line of lines) {
    if (line.startsWith(MARK)) result.push({ marker: line.slice(MARK.length), lines: [] });
    else if (result.length) result.at(-1).lines.push(line);
  }
  return result.map((s) => ({ marker: s.marker, content: s.lines.join("\n") }));
}
function section(marker, content) {
  if (content === undefined) return `${MARK}${marker}\n`;
  if (content.split("\n").some((l) => l.startsWith(MARK))) throw new Error(`a line of "${marker}" starts with "${MARK}"`);
  return `${MARK}${marker}\n${content}\n`;
}

const sha256 = (data) => crypto.createHash("sha256").update(data).digest("hex");
const refSha = sha256(fs.readFileSync(args.ref));
const refVersion = execFileSync(args.ref, ["--version"], { encoding: "utf8" }).trim();
const repoCommit = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const repoVersion = JSON.parse(fs.readFileSync(path.join(repo, "_packages/tsgo/package.json"), "utf8")).version;

// go_unit names: <dir>_<file without _test.go>_<line>[_<row line>].
function uniqueName(names, base) {
  let name = base;
  for (let i = 2; names.has(name); i++) name = `${base}_${i}`;
  names.add(name);
  return name;
}

// Top-level packages of testdata/tests/<version>/node_modules (scoped as @scope/name).
function topLevelPackages(version) {
  const dir = path.join(repo, "testdata/tests", version, "node_modules");
  const names = [];
  for (const entry of fs.readdirSync(dir).sort()) {
    if (entry.startsWith(".")) continue;
    if (entry.startsWith("@")) for (const sub of fs.readdirSync(path.join(dir, entry)).sort()) names.push(`${entry}/${sub}`);
    else names.push(entry);
  }
  return names;
}
const VITEST = (name) => name === "vitest" || name.startsWith("@vitest/") || name === "@effect/vitest";

const suites = [];
{
  const names = new Set();
  const sources = goUnitProjects(repo).projects.map((p) => ({
    origin: p.origin,
    files: { ...p.files, "tsconfig.json": JSON.stringify(goUnitTsconfig(Object.keys(p.files))) },
  }));
  const cases = [...sources, ...configProjects(repo)].map((p) => {
    const m = /^internal\/([^/]+)\/(.+?)(?:_test)?\.go:(\d+)(?:@(\d+))?$/.exec(p.origin);
    if (!m) throw new Error(`unexpected origin ${p.origin}`);
    const files = new Map(Object.entries(p.files));
    const base = [m[1], m[2], m[3], m[4]].filter(Boolean).join("_");
    return { name: uniqueName(names, base), origin: p.origin, files, cwd: ".", config: "tsconfig.json", links: null };
  });
  suites.push({ suite: "go_unit", source: "internal/**/api_stability*_test.go, stability_api_usage_test.go, effectconfigcheck/validation_test.go", cases });
}
for (const version of ["effect-v3", "effect-v4"]) {
  const dir = path.join(repo, "testdata/tests", version);
  const top = topLevelPackages(version);
  const cases = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".ts"))
    .sort()
    .map((f) => {
      const c = referenceCase(path.join(dir, f));
      c.files.set(c.config, JSON.stringify(JSON.parse(c.files.get(c.config))));
      return {
        name: c.name,
        origin: `testdata/tests/${version}/${f}`,
        files: c.files,
        cwd: ".src",
        config: path.posix.relative(".src", c.config),
        links: top.filter((n) => c.vitest || !VITEST(n)),
      };
    });
  suites.push({ suite: version.replace("-", "_"), version, source: `testdata/tests/${version}`, cases });
}

// Writes the project of case `c` under `dir`; links go to `<modules>/<name>`.
function materialize(c, dir, modules) {
  fs.rmSync(dir, { recursive: true, force: true });
  for (const [rel, text] of c.files) {
    const target = path.join(dir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  }
  for (const name of c.links ?? []) {
    const link = path.join(dir, "node_modules", name);
    if (fs.existsSync(link)) continue;
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(fs.realpathSync(path.join(modules, name)), link);
  }
  fs.mkdirSync(path.join(dir, c.cwd), { recursive: true });
  return path.join(dir, c.cwd);
}

async function tsc(cwd, config, ...flags) {
  try {
    const { stdout } = await run(args.ref, ["-p", config, ...flags], { cwd, maxBuffer: 64 << 20, timeout: 300_000 });
    return { fails: false, out: stdout };
  } catch (e) {
    if (typeof e.code !== "number") throw new Error(`${cwd}: ${e.message}`);
    return { fails: true, out: e.stdout ?? "" };
  }
}

async function pool(items, fn) {
  const queue = [...items];
  const worker = async () => {
    while (queue.length) await fn(queue.shift());
  };
  await Promise.all(Array.from({ length: Number(args.jobs) }, worker));
}

// eslint-disable-next-line no-control-regex
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
// A related information line of the pretty output: "  file:line:col - message".
const RELATED = /^ {2}\S[^\n]*:\d+:\d+ - /m;

const files = new Map(); // generated file name -> Buffer or string
const problems = [];
for (const s of suites) {
  let modulesDir = null;
  if (s.version) {
    // (a): the effect repo's packages. Their loaded files make the pack.
    const pnpm = path.join(repo, "node_modules/.pnpm") + "/";
    const original = path.join(repo, "testdata/tests", s.version, "node_modules");
    const loaded = new Map(); // node_modules path -> real path
    await pool(s.cases, async (c) => {
      c.dirA = path.join(work, "a", s.suite, c.name);
      const cwd = materialize(c, c.dirA, original);
      c.original = await tsc(cwd, c.config, "--pretty", "false");
      const list = await tsc(cwd, c.config, "--listFilesOnly");
      for (const file of list.out.split("\n")) {
        if (!file.startsWith(pnpm)) continue;
        const m = /^[^/]+\/node_modules\/((?:@[^/]+\/)?[^/]+)\/(.+)$/.exec(file.slice(pnpm.length));
        if (!m) throw new Error(`unexpected package file ${file}`);
        const rel = `${m[1]}/${m[2]}`;
        if (loaded.has(rel) && loaded.get(rel) !== file) throw new Error(`two versions of ${rel}: ${loaded.get(rel)}, ${file}`);
        loaded.set(rel, file);
      }
    });
    // Each package: its package.json files (nested node_modules aside), its LICENSE files
    // and the loaded files. The top-level packages are there even when no case loads them.
    const packages = new Map(); // name -> package dir
    for (const [rel, file] of loaded) {
      const name = /^(@[^/]+\/[^/]+|[^/]+)\//.exec(rel)[1];
      packages.set(name, file.slice(0, file.length - (rel.length - name.length)));
    }
    for (const name of topLevelPackages(s.version)) packages.set(name, fs.realpathSync(path.join(original, name)));
    for (const c of s.cases) {
      let out = c.original.out.replaceAll(c.dirA, "<case>");
      for (const [name, dir] of packages) out = out.replaceAll(dir, `<modules>/${name}`);
      c.original.out = out;
    }
    const pack = new Map();
    for (const [name, dir] of [...packages].sort()) {
      const walk = (d) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, e.name);
          if (e.isDirectory() && e.name !== "node_modules") walk(p);
          else if (e.isFile() && (e.name === "package.json" || (d === dir && /^licen[cs]e/i.test(e.name)))) {
            pack.set(`${name}/${path.relative(dir, p)}`, p);
          }
        }
      };
      walk(dir);
    }
    for (const [rel, file] of loaded) pack.set(rel, file);
    const versions = [...packages.keys()]
      .sort()
      .map((n) => `${n}@${JSON.parse(fs.readFileSync(path.join(packages.get(n), "package.json"), "utf8")).version}`);
    let text =
      `# The node_modules of the ${s.suite} Effect cases (crates/ts_goport/tests/effect_cases.rs).\n` +
      `# Generated by scripts/effect/gen-effect-cases.mjs. Do not edit.\n` +
      `# The files of Effect-TS/tsgo ${repoCommit.slice(0, 8)} testdata/tests/${s.version}/node_modules that the cases load,\n` +
      `# and the package.json and LICENSE files of each package. Packages:\n` +
      versions.map((v) => `#   ${v}\n`).join("");
    for (const [rel, file] of [...pack].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      const content = fs.readFileSync(file);
      if (!content.equals(Buffer.from(content.toString("utf8"), "utf8"))) throw new Error(`${file} is not UTF-8`);
      text += section(`file ${rel}`, content.toString("utf8"));
    }
    const gz = zlib.gzipSync(Buffer.from(text, "utf8"), { level: 9 });
    files.set(`${s.suite}.modules.gz`, gz);
    s.pack = { files: pack.size, bytes: text.length, gz: gz.length, sha: sha256(gz) };
    // Unpack it as the test does.
    modulesDir = path.join(work, "store", s.suite, "node_modules");
    for (const { marker, content } of sections(zlib.gunzipSync(gz).toString("utf8"))) {
      const target = path.join(modulesDir, marker.slice("file ".length));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
    }
  }
  // (b): the layout of the test.
  await pool(s.cases, async (c) => {
    const dir = path.join(work, "b", s.suite, c.name);
    const cwd = materialize(c, dir, modulesDir);
    const plain = await tsc(cwd, c.config, "--pretty", "false");
    const pretty = await tsc(cwd, c.config, "--pretty", "true");
    const normalize = (out) =>
      (modulesDir ? out.replaceAll(modulesDir, "<modules>").replaceAll(path.relative(cwd, modulesDir) + "/", "<modules>/") : out).replaceAll(dir, "<case>");
    c.fails = plain.fails;
    c.out = normalize(plain.out);
    const p = normalize(stripAnsi(pretty.out));
    c.pretty = RELATED.test(p) ? p : undefined;
    if (c.original && (c.original.out !== c.out || c.original.fails !== c.fails)) {
      problems.push(`${s.suite}/${c.name}: the output with the pack differs from the output with the effect repo's packages`);
    }
    if ((c.out + (c.pretty ?? "")).includes(work)) problems.push(`${s.suite}/${c.name}: the output names the work dir`);
  });
  let text =
    `# Effect diagnostic cases (crates/ts_goport/tests/effect_cases.rs runs them; the format is in\n` +
    `# scripts/effect/gen-effect-cases.mjs). Generated by that script. Do not edit.\n` +
    `# Source: Effect-TS/tsgo ${repoCommit} (${repoVersion}) ${s.source}.\n` +
    `# Expected outputs: ${refVersion}, sha256 ${refSha}.\n` +
    (s.pack ? `# node_modules: ${s.suite}.modules.gz, sha256 ${s.pack.sha}.\n` : "");
  for (const c of s.cases) {
    text += section(`case ${c.name} ${c.origin}`);
    if (c.links) text += section(`links ${c.links.join(" ")}`);
    for (const [rel, content] of [...c.files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) text += section(`file ${rel}`, content);
    text += section(`run ${c.cwd} ${c.config}`);
    text += section(`out ${c.fails ? "fail" : "ok"}`, c.out);
    if (c.pretty !== undefined) text += section("pretty", c.pretty);
  }
  files.set(`${s.suite}.txt`, text);
}
if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}

let names =
  "// The test names of the Effect cases (tests/effect_cases.rs): one per case of <suite>.txt.\n" +
  "// Generated by scripts/effect/gen-effect-cases.mjs. Do not edit.\n";
for (const s of suites) names += `suite! {\n    ${s.suite}:\n${s.cases.map((c) => `    ${c.name},\n`).join("")}}\n`;
names +=
  "\n/// Each suite and its test names.\nconst SUITE_NAMES: &[(&str, &[&str])] = &[\n" +
  suites.map((s) => `    ("${s.suite}", ${s.suite}::NAMES),\n`).join("") +
  "];\n";
files.set("names.rs", names);

// Coverage of the Effect diagnostic codes: a code is covered when an expected output
// prints it (`TS<code>`), or, for related information (no code in the output), when a
// pretty output prints its message.
const catalog = Object.entries(JSON.parse(fs.readFileSync(CATALOG, "utf8"))).map(([message, v]) => ({ message, ...v }));
const outputs = suites.flatMap((s) => s.cases.map((c) => ({ s: s.suite, c, text: c.out + "\n" + (c.pretty ?? "") })));
const escape = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const coverage = catalog
  .sort((a, b) => a.code - b.code)
  .map((d) => {
    const byCode = outputs.filter((o) => o.text.includes(`TS${d.code}:`));
    const text = new RegExp("^ {2}\\S.*:\\d+:\\d+ - " + d.message.split(/\{\d+\}/).map(escape).join("[^\\n]*"), "m");
    const byText = byCode.length ? [] : outputs.filter((o) => o.c.pretty && text.test(o.c.pretty));
    return { code: d.code, category: d.category, message: d.message, byCode, byText };
  });
const covered = coverage.filter((c) => c.byCode.length || c.byText.length);
console.log(
  suites
    .map((s) => `${s.suite}: ${s.cases.length} cases, ${s.cases.filter((c) => c.pretty !== undefined).length} with pretty` + (s.pack ? `, pack ${s.pack.files} files, ${s.pack.bytes} bytes, ${s.pack.gz} gzip` : ""))
    .join("\n"),
);
console.log(`codes ${coverage.length}: ${covered.length} covered (${coverage.filter((c) => c.byText.length).length} as related information), ${coverage.length - covered.length} not covered`);
for (const c of coverage) {
  const where = c.byCode.length ? c.byCode : c.byText;
  const suitesOf = [...new Set(where.map((o) => o.s))].join(",");
  console.log(`TS${c.code} ${c.category.padEnd(10)} ${String(where.length).padStart(3)} ${c.byText.length ? "related " : ""}${suitesOf || "-"} ${c.message.slice(0, 90).replace(/\n/g, " ")}`);
}

if (args.check) {
  let differ = 0;
  for (const [name, content] of files) {
    const file = path.join(OUT, name);
    if (!fs.existsSync(file) || !fs.readFileSync(file).equals(Buffer.from(content))) {
      console.log(`differs: ${name}`);
      differ++;
    }
  }
  process.exit(differ ? 1 : 0);
}
fs.mkdirSync(OUT, { recursive: true });
for (const [name, content] of files) fs.writeFileSync(path.join(OUT, name), content);
console.log(`wrote ${[...files.keys()].join(", ")} to ${path.relative(root, OUT)}`);
