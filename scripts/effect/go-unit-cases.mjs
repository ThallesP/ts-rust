#!/usr/bin/env node
// Differential check of the Effect API stability rules on the inline sources of
// the Effect-TS/tsgo Go unit tests (the reference binary is the oracle; the Go
// expectations are not read).
//
// go-unit-source.mjs extracts the sources (maps, string constants, table rows,
// template helpers) as small projects.
//
// Each project gets a tsconfig with the Go test options (target and module
// esnext/nodenext, strict, skipLibCheck) and the Effect plugin with
// `apiStabilityLeak`, `unstableApiUsage` and `experimentalApiUsage` at warning.
// Both compilers check it with `--pretty false` and with `--pretty true` (ANSI
// removed; this mode prints the related locations of TS377138). A project is a
// match when both outputs are equal and both succeed or both fail.
//
// usage: node scripts/effect/go-unit-cases.mjs --ours <tsc> --ref <tsc> --effect-repo DIR
//          [--out DIR] [--jobs N] [--filter SUBSTR] [--list]
// Writes <out>/summary.json, <out>/cases/<id>/ and <out>/diffs/<id>.diff. Exit 1 on any mismatch.
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs, promisify } from "node:util";
import { goUnitProjects, goUnitTsconfig } from "./go-unit-source.mjs";

const run = promisify(execFile);
const { values: args } = parseArgs({
  options: {
    ours: { type: "string" },
    ref: { type: "string" },
    "effect-repo": { type: "string" },
    out: { type: "string", default: "/tmp/effect-go-unit-cases" },
    jobs: { type: "string", default: String(Math.max(1, os.availableParallelism() - 2)) },
    filter: { type: "string", default: "" },
    list: { type: "boolean", default: false },
  },
});
if (!args["effect-repo"] || (!args.list && (!args.ours || !args.ref))) {
  console.error("--effect-repo, --ours and --ref are required (--list needs only --effect-repo)");
  process.exit(2);
}

const { projects: unique, skipped } = goUnitProjects(args["effect-repo"]);
const projects = unique.filter((p) => p.origin.includes(args.filter));
projects.forEach((p, index) => {
  p.id = String(index).padStart(3, "0") + "-" + path.basename(p.origin).replace(/[^A-Za-z0-9]+/g, "-");
});
if (args.list) {
  for (const p of projects) console.log(p.id, p.origin, Object.keys(p.files).join(","));
  for (const s of skipped) console.log("skipped", s);
  console.log(`projects ${projects.length}, skipped maps ${skipped.length}`);
  process.exit(0);
}

fs.rmSync(args.out, { recursive: true, force: true });
fs.mkdirSync(path.join(args.out, "diffs"), { recursive: true });
args.out = fs.realpathSync(args.out);

function prepare(p) {
  const dir = path.join(args.out, "cases", p.id);
  for (const [name, text] of Object.entries(p.files)) {
    const file = path.join(dir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  const tsconfig = goUnitTsconfig(Object.keys(p.files));
  fs.writeFileSync(path.join(dir, "tsconfig.json"), JSON.stringify(tsconfig, null, 2));
  return dir;
}

async function check(bin, dir, pretty) {
  try {
    const { stdout } = await run(bin, ["-p", "tsconfig.json", "--pretty", String(pretty)], {
      cwd: dir,
      maxBuffer: 64 << 20,
      timeout: 300_000,
    });
    return { code: 0, out: stdout };
  } catch (e) {
    if (typeof e.code !== "number") return { code: -1, out: String(e.stdout ?? "") + `\n<${e.signal ?? e.code}>` };
    return { code: e.code, out: e.stdout ?? "" };
  }
}

// eslint-disable-next-line no-control-regex
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const isEffect = (line) => /TS377\d\d\d/.test(line);

const summary = { projects: projects.length, skippedMaps: skipped.length, skipped, match: 0, effectMismatch: 0, tsOnlyMismatch: 0, crashes: 0, leakLines: 0, mismatches: [] };
const work = [...projects];
async function worker() {
  while (work.length) {
    const p = work.shift();
    const dir = prepare(p);
    const [ours, ref, oursPretty, refPretty] = await Promise.all([
      check(args.ours, dir, false),
      check(args.ref, dir, false),
      check(args.ours, dir, true),
      check(args.ref, dir, true),
    ]);
    const o = ours.out.trimEnd();
    const r = ref.out.trimEnd();
    const op = stripAnsi(oursPretty.out).trimEnd();
    const rp = stripAnsi(refPretty.out).trimEnd();
    summary.leakLines += r.split("\n").filter((l) => / TS37713[78]: /.test(l)).length;
    const crashed = ours.code < 0 || ours.code > 2 || /^panic: |unported/m.test(ours.out + oursPretty.out);
    const sameExit = (ours.code === 0) === (ref.code === 0);
    if (!crashed && o === r && op === rp && sameExit) {
      summary.match++;
      continue;
    }
    const oe = o.split("\n").filter(isEffect).join("\n");
    const re = r.split("\n").filter(isEffect).join("\n");
    // The pretty output carries the related locations: compare its Effect blocks too.
    const prettyEffect = (s) => s.split(/\n(?=\S)/).filter(isEffect).join("\n");
    const effectSame = oe === re && prettyEffect(op) === prettyEffect(rp);
    if (crashed) summary.crashes++;
    if (!effectSame || crashed) summary.effectMismatch++;
    else summary.tsOnlyMismatch++;
    const kind = crashed ? "crash" : !effectSame ? "effect" : "ts-only";
    summary.mismatches.push({ id: p.id, origin: p.origin, kind, exit: [ours.code, ref.code] });
    fs.writeFileSync(
      path.join(args.out, "diffs", p.id + ".diff"),
      `origin ${p.origin}\nexit ours=${ours.code} ref=${ref.code}\n--- ours\n${o}\n--- ref\n${r}\n--- ours pretty\n${op}\n--- ref pretty\n${rp}\n`,
    );
  }
}
await Promise.all(Array.from({ length: Number(args.jobs) }, worker));
summary.mismatches.sort((a, b) => a.id.localeCompare(b.id));
fs.writeFileSync(path.join(args.out, "summary.json"), JSON.stringify(summary, null, 2));
console.log(
  `projects ${summary.projects} (skipped maps ${summary.skippedMaps}), identical ${summary.match}, Effect mismatches ${summary.effectMismatch}, TS-only mismatches ${summary.tsOnlyMismatch}, crashes ${summary.crashes}, ref TS377137/8 lines ${summary.leakLines}`,
);
process.exit(summary.mismatches.length ? 1 : 0);
