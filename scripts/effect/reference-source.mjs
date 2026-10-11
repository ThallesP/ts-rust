// The Effect-TS/tsgo test cases (testdata/tests/effect-v3, effect-v4) as small
// projects, as the Go effecttest harness builds them. Used by reference-cases.mjs
// (differential check) and gen-effect-cases.mjs (the in-repo cases of
// crates/ts_goport/tests/effect_cases).
import fs from "node:fs";
import path from "node:path";

// Go effecttest DefaultTsConfig (runner.go): the 3 stability rules are off
// unless a case's own tsconfig turns them on.
const DEFAULT_TSCONFIG = {
  compilerOptions: {
    skipLibCheck: true,
    plugins: [
      {
        name: "@effect/language-service",
        ignoreEffectErrorsInTscExitCode: true,
        skipDisabledOptimization: true,
        diagnosticSeverity: {
          experimentalApiUsage: "off",
          unstableApiUsage: "off",
          apiStabilityLeak: "off",
        },
      },
    ],
  },
};

// Go effecttest.parseTestUnits
function parseUnits(content, defaultName) {
  const units = [];
  let name = "";
  let lines = [];
  for (const line of content.split(/\r?\n/)) {
    const m = /^\/{2}\s*@(\w+)\s*:\s*([^\r\n]*)/.exec(line);
    if (m && m[1].toLowerCase() === "filename") {
      if (name && lines.length) units.push({ name, content: lines.join("\n") });
      name = m[2].trim();
      lines = [];
      continue;
    }
    lines.push(line);
  }
  if (name) units.push({ name, content: lines.join("\n") });
  else if (lines.length) units.push({ name: defaultName, content: lines.join("\n") });
  return units;
}

// Lenient JSONC: strips comments and trailing commas.
function parseJsonc(text) {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2) + 1;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

// The project of the case file `file`: { name, files, config, vitest }. `files`
// maps each path (relative to the case dir; units go under .src, `/x` units to
// `x`) to its text, the tsconfig included. `config` is the tsconfig path, and the
// compilers run in .src. `vitest`: the case names vitest, so the harness links the
// vitest packages.
export function referenceCase(file) {
  const content = fs.readFileSync(file, "utf8");
  const units = parseUnits(content, path.basename(file));
  const files = new Map();
  let tsconfig = null;
  let config = ".src/tsconfig.json";
  for (const unit of units) {
    const abs = unit.name.startsWith("/") ? unit.name : "/.src/" + unit.name;
    const rel = path.posix.normalize(abs).slice(1);
    if (/(^|\/)tsconfig[^/]*\.json$/.test(unit.name) && !abs.startsWith("/node_modules/")) {
      tsconfig = parseJsonc(unit.content);
      config = rel;
      continue;
    }
    files.set(rel, unit.content);
  }
  const injected = tsconfig === null;
  tsconfig ??= structuredClone(DEFAULT_TSCONFIG);
  tsconfig.compilerOptions ??= {};
  const co = tsconfig.compilerOptions;
  Object.assign(co, { newLine: "lf", skipDefaultLibCheck: true, skipLibCheck: true, noErrorTruncation: true, noEmit: true });
  co.target ??= "esnext";
  co.module ??= "nodenext";
  co.moduleResolution ??= "nodenext";
  if (injected) Object.assign(co, { esModuleInterop: true, allowSyntheticDefaultImports: true });
  // The harness passes only the input units as roots.
  delete tsconfig.include;
  tsconfig.files = units
    .map((u) => (u.name.startsWith("/") ? u.name : "/.src/" + u.name))
    .filter((n) => !n.startsWith("/node_modules/") && !/tsconfig[^/]*\.json$/.test(n) && /\.(m|c)?tsx?$/.test(n))
    .map((n) => path.posix.relative(path.posix.dirname("/" + config), n));
  delete tsconfig.extends;
  files.set(config, JSON.stringify(tsconfig, null, 2));
  return { name: path.basename(file, ".ts"), files, config, vitest: content.includes("vitest") };
}
