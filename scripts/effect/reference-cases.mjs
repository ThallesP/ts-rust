#!/usr/bin/env node
// Differential check of the native Effect diagnostics against the reference
// Effect-patched tsc, on the Effect-TS/tsgo test cases (testdata/tests/effect-v3, effect-v4).
// Each case becomes a small project (its units under .src, the pinned Effect
// packages linked into node_modules). Both compilers check it with the same
// tsconfig and flags; their `--pretty false` outputs are compared line by line.
//
// usage: node scripts/effect/reference-cases.mjs --ours <tsc> --ref <tsc> [--effect-repo DIR]
//          [--versions effect-v4,effect-v3] [--filter SUBSTR] [--out DIR] [--jobs N]
// The reference repo needs `pnpm install --filter ./testdata/tests/effect-v4 --filter ./testdata/tests/effect-v3`.
// Writes <out>/summary.json and <out>/<version>/<case>.diff for each mismatch. Exit 1 on any mismatch.
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs, promisify } from "node:util";
import { referenceCase } from "./reference-source.mjs";

const run = promisify(execFile);
const { values: args } = parseArgs({
  options: {
    ours: { type: "string" },
    ref: { type: "string" },
    "effect-repo": { type: "string", default: path.join(os.homedir(), ".cache/repo-explorer/Effect-TS-tsgo") },
    versions: { type: "string", default: "effect-v4,effect-v3" },
    filter: { type: "string", default: "" },
    out: { type: "string", default: "/tmp/effect-cases" },
    jobs: { type: "string", default: String(Math.max(1, os.availableParallelism() - 2)) },
    "keep-ts": { type: "boolean", default: false },
  },
});
if (!args.ours || !args.ref) {
  console.error("--ours and --ref are required");
  process.exit(2);
}

fs.mkdirSync(args.out, { recursive: true });
args.out = fs.realpathSync(args.out);

function linkPackages(srcModules, dstModules) {
  fs.mkdirSync(dstModules, { recursive: true });
  for (const entry of fs.readdirSync(srcModules)) {
    if (entry.startsWith(".")) continue;
    const src = path.join(srcModules, entry);
    if (entry.startsWith("@")) {
      for (const sub of fs.readdirSync(src)) {
        fs.mkdirSync(path.join(dstModules, entry), { recursive: true });
        const dst = path.join(dstModules, entry, sub);
        if (!fs.existsSync(dst)) fs.symlinkSync(fs.realpathSync(path.join(src, sub)), dst);
      }
    } else {
      const dst = path.join(dstModules, entry);
      if (!fs.existsSync(dst)) fs.symlinkSync(fs.realpathSync(src), dst);
    }
  }
}

function prepareCase(version, file) {
  const project = referenceCase(file);
  const dir = path.join(args.out, "projects", version, project.name);
  fs.rmSync(dir, { recursive: true, force: true });
  const srcDir = path.join(dir, ".src");
  fs.mkdirSync(srcDir, { recursive: true });
  for (const [rel, text] of project.files) {
    const target = path.join(dir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  }
  const modules = path.join(args["effect-repo"], "testdata/tests", version, "node_modules");
  linkPackages(modules, path.join(dir, "node_modules"));
  if (!project.vitest) {
    for (const p of ["vitest", "@vitest", "@effect/vitest"]) fs.rmSync(path.join(dir, "node_modules", p), { recursive: true, force: true });
  }
  return { base: project.name, dir, srcDir, configPath: path.join(dir, project.config) };
}

async function check(bin, c) {
  try {
    const { stdout } = await run(bin, ["-p", c.configPath, "--pretty", "false"], { cwd: c.srcDir, maxBuffer: 64 << 20 });
    return { code: 0, out: stdout };
  } catch (e) {
    if (typeof e.code !== "number") throw e;
    return { code: e.code, out: e.stdout ?? "" };
  }
}

// One diagnostic per entry: the first line and its indented continuation lines.
function diagnostics(out) {
  const result = [];
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    if (/^\s/.test(line) && result.length) result[result.length - 1] += "\n" + line;
    else result.push(line);
  }
  return result;
}

const isEffect = (d) => / TS377\d\d\d: /.test(d);

const summary = { cases: 0, match: 0, effectMismatch: 0, tsOnlyMismatch: 0, crashes: 0, mismatches: [] };
const work = [];
for (const version of args.versions.split(",")) {
  const casesDir = path.join(args["effect-repo"], "testdata/tests", version);
  for (const f of fs.readdirSync(casesDir).sort()) {
    if (!f.endsWith(".ts") || !f.includes(args.filter)) continue;
    work.push({ version, file: path.join(casesDir, f) });
  }
}

async function worker() {
  while (work.length) {
    const { version, file } = work.shift();
    const c = prepareCase(version, file);
    const [ours, ref] = await Promise.all([check(args.ours, c), check(args.ref, c)]);
    summary.cases++;
    const crashed = ours.code > 2 || /^panic: |unported/m.test(ours.out);
    const od = diagnostics(ours.out);
    const rd = diagnostics(ref.out);
    const oe = od.filter(isEffect).join("\n");
    const re = rd.filter(isEffect).join("\n");
    const effectSame = oe === re;
    // tsc-rs follows its pinned TypeScript Go revision, where --noEmit with errors
    // exits 2 (outputs generated); TS 7.0.2 exits 1. Only failure vs success counts.
    const allSame = od.join("\n") === rd.join("\n") && (ours.code === 0) === (ref.code === 0);
    if (crashed) summary.crashes++;
    if (allSame && !crashed) {
      summary.match++;
      continue;
    }
    if (!effectSame || crashed) summary.effectMismatch++;
    else summary.tsOnlyMismatch++;
    const kind = crashed ? "crash" : !effectSame ? "effect" : ours.code !== ref.code ? "exit" : "ts-only";
    summary.mismatches.push({ version, case: c.base, kind, exit: [ours.code, ref.code] });
    const diffDir = path.join(args.out, version);
    fs.mkdirSync(diffDir, { recursive: true });
    fs.writeFileSync(
      path.join(diffDir, c.base + ".diff"),
      `exit ours=${ours.code} ref=${ref.code}\n--- ours\n${ours.out}\n--- ref\n${ref.out}\n`,
    );
  }
}
fs.rmSync(path.join(args.out, "effect-v3"), { recursive: true, force: true });
fs.rmSync(path.join(args.out, "effect-v4"), { recursive: true, force: true });
await Promise.all(Array.from({ length: Number(args.jobs) }, worker));
summary.mismatches.sort((a, b) => (a.version + a.case).localeCompare(b.version + b.case));
fs.writeFileSync(path.join(args.out, "summary.json"), JSON.stringify(summary, null, 2));
console.log(
  `cases ${summary.cases}, identical ${summary.match}, Effect mismatches ${summary.effectMismatch}, TS-only mismatches ${summary.tsOnlyMismatch}, crashes ${summary.crashes}`,
);
const byKind = {};
for (const m of summary.mismatches) byKind[m.kind] = (byKind[m.kind] ?? 0) + 1;
console.log(JSON.stringify(byKind));
process.exit(summary.mismatches.length ? 1 : 0);
