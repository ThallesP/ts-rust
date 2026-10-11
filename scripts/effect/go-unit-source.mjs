// The inline sources of the Effect-TS/tsgo Go unit tests of the API stability
// rules, as small projects. Used by go-unit-cases.mjs (differential check) and
// gen-effect-cases.mjs (the in-repo cases of crates/ts_goport/tests/effect_cases).
//
// The Go tests keep their sources in `map[string]string{...}` literals (one
// project per map) and in string constants, variables, struct fields and call
// arguments (one `test.ts` project per string that contains `export`). String
// expressions are joined from Go string literals, `+` and identifiers that name
// another string expression of the same file (the nearest definition before the
// use, else a package-level one). Anything else (fmt.Sprintf, ...) is skipped
// and counted.
import fs from "node:fs";
import path from "node:path";

// The Go test files with API stability sources.
export const TEST_FILES = [
  "internal/rulerunner/api_stability_leak_test.go",
  "internal/rulerunner/api_stability_leak_inheritance_test.go",
  "internal/rulerunner/api_stability_leak_internal_properties_test.go",
  "internal/rules/api_stability_leak_test.go",
  "internal/rules/api_stability_leak_regression_test.go",
  "internal/rules/stability_api_usage_test.go",
  "internal/typeparser/api_stability_test.go",
  "internal/typeparser/api_stability_surface_test.go",
  "internal/typeparser/api_stability_safety_test.go",
  "internal/typeparser/api_stability_inheritance_test.go",
];

// Go tokens: { kind: "str" | "id" | "num" | "op", text, value, line }.
function tokenize(src) {
  const tokens = [];
  let i = 0;
  let line = 1;
  const push = (kind, text, value) => tokens.push({ kind, text, value, line });
  while (i < src.length) {
    const ch = src[i];
    if (ch === "\n") {
      line++;
      i++;
      continue;
    }
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (src.startsWith("//", i)) {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (src.startsWith("/*", i)) {
      const end = src.indexOf("*/", i + 2);
      const body = src.slice(i, end + 2);
      line += body.split("\n").length - 1;
      i = end + 2;
      continue;
    }
    if (ch === "`") {
      const end = src.indexOf("`", i + 1);
      const body = src.slice(i + 1, end);
      push("str", src.slice(i, end + 1), body.replace(/\r/g, ""));
      line += body.split("\n").length - 1;
      i = end + 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let value = "";
      while (src[j] !== '"') {
        if (src[j] === "\\") {
          const e = src[j + 1];
          const simple = { n: "\n", t: "\t", r: "\r", '"': '"', "\\": "\\", "'": "'", a: "\x07", b: "\b", f: "\f", v: "\v" };
          if (e in simple) {
            value += simple[e];
            j += 2;
          } else if (e === "x") {
            value += String.fromCharCode(parseInt(src.slice(j + 2, j + 4), 16));
            j += 4;
          } else if (e === "u") {
            value += String.fromCodePoint(parseInt(src.slice(j + 2, j + 6), 16));
            j += 6;
          } else if (e === "U") {
            value += String.fromCodePoint(parseInt(src.slice(j + 2, j + 10), 16));
            j += 10;
          } else {
            value += String.fromCharCode(parseInt(src.slice(j + 1, j + 4), 8));
            j += 4;
          }
        } else {
          value += src[j];
          j++;
        }
      }
      push("str", src.slice(i, j + 1), value);
      i = j + 1;
      continue;
    }
    if (ch === "'") {
      let j = i + 1;
      while (src[j] !== "'") j += src[j] === "\\" ? 2 : 1;
      push("op", src.slice(i, j + 1));
      i = j + 1;
      continue;
    }
    const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i, i + 200));
    if (word) {
      push("id", word[0]);
      i += word[0].length;
      continue;
    }
    const num = /^[0-9][0-9A-Za-z_.]*/.exec(src.slice(i, i + 100));
    if (num) {
      push("num", num[0]);
      i += num[0].length;
      continue;
    }
    const op = [":=", "==", "!=", "<=", ">=", "&&", "||", "+=", "...", "<-"].find((o) => src.startsWith(o, i)) ?? ch;
    push("op", op);
    i += op.length;
  }
  return tokens;
}

function extract(file, src) {
  const t = tokenize(src);
  // Definitions: name -> [{ pos, start }] where start is the expression token.
  const defs = new Map();
  let depth = 0;
  const depthAt = [];
  const match = [];
  const open = [];
  for (let k = 0; k < t.length; k++) {
    depthAt[k] = depth;
    if (t[k].text === "{") {
      depth++;
      open.push(k);
    }
    if (t[k].text === "}") {
      depth--;
      match[open.pop()] = k;
    }
  }
  // The direct `field: value` keys of the composite element at `{` b.
  function elementFields(b) {
    const fields = new Map();
    let rel = 0;
    for (let j = b + 1; j < match[b]; j++) {
      const x = t[j].text;
      if (x === "{" || x === "(" || x === "[") rel++;
      else if (x === "}" || x === ")" || x === "]") rel--;
      else if (rel === 0 && t[j].kind === "id" && t[j + 1]?.text === ":") fields.set(x, j + 2);
    }
    return fields;
  }
  // Table rows for a map at k that reads `row.field` values: the composite
  // elements of the enclosing function that set at least one of the fields.
  function tableRows(k, wanted) {
    let start = k;
    while (start > 0 && !(t[start].text === "func" && depthAt[start] === 0)) start--;
    const rows = [];
    for (let b = start; b < k; b++) {
      if (t[b].text !== "{" || match[b] === undefined) continue;
      const fields = elementFields(b);
      if (![...wanted].some((f) => fields.has(f))) continue;
      const values = new Map();
      let ok = true;
      for (const f of wanted) {
        if (!fields.has(f)) {
          values.set(f, "");
          continue;
        }
        const v = parseExpr(fields.get(f));
        if (!v) {
          ok = false;
          break;
        }
        values.set(f, v.value);
      }
      if (ok) rows.push({ line: t[b].line, values });
    }
    return rows;
  }
  for (let k = 0; k + 2 < t.length; k++) {
    if (t[k].kind !== "id") continue;
    const next = t[k + 1].text;
    let start = -1;
    if (next === ":=" || next === "=") start = k + 2;
    else if (next === "string" && t[k + 2].text === "=") start = k + 3;
    if (start < 0) continue;
    // `a, b := ...` and `x.y = ...` are not string definitions of one name.
    if (k > 0 && (t[k - 1].text === "," || t[k - 1].text === ".")) continue;
    if (!defs.has(t[k].text)) defs.set(t[k].text, []);
    defs.get(t[k].text).push({ pos: k, start, global: depthAt[k] === 0 });
  }

  const resolving = new Set();
  // Template parameters bound while a template map is read.
  let bindings = new Map();
  // Table fields (`test.source`) bound while a map is read for one table row,
  // and the fields a failed read asked for.
  let fieldBindings = null;
  let missingFields = new Set();
  function resolveIdent(name, pos) {
    if (bindings.has(name)) return bindings.get(name);
    const list = defs.get(name);
    if (!list) return null;
    let best = null;
    for (const d of list) if (d.pos < pos && (!best || d.pos > best.pos)) best = d;
    if (!best) best = list.find((d) => d.global) ?? null;
    if (!best) return null;
    const key = name + "@" + best.pos;
    if (resolving.has(key)) return null;
    resolving.add(key);
    const r = parseExpr(best.start);
    resolving.delete(key);
    return r ? r.value : null;
  }
  // expr = term ('+' term)*; term = STRING | IDENT | '(' expr ')'
  function parseTerm(k) {
    const tok = t[k];
    if (!tok) return null;
    if (tok.kind === "str") return { value: tok.value, end: k + 1 };
    if (tok.text === "(") {
      const inner = parseExpr(k + 1);
      if (!inner || t[inner.end]?.text !== ")") return null;
      return { value: inner.value, end: inner.end + 1 };
    }
    // strings.Repeat(expr, count)
    if (tok.text === "strings" && t[k + 1]?.text === "." && t[k + 2]?.text === "Repeat" && t[k + 3]?.text === "(") {
      const inner = parseExpr(k + 4);
      if (!inner || t[inner.end]?.text !== "," || t[inner.end + 1]?.kind !== "num" || t[inner.end + 2]?.text !== ")") return null;
      return { value: inner.value.repeat(Number(t[inner.end + 1].text.replace(/_/g, ""))), end: inner.end + 3 };
    }
    if (tok.kind === "id" && t[k + 1]?.text === "." && t[k + 2]?.kind === "id" && t[k + 3]?.text !== "(") {
      const field = t[k + 2].text;
      if (fieldBindings && fieldBindings.has(field)) return { value: fieldBindings.get(field), end: k + 3 };
      missingFields.add(field);
      return null;
    }
    if (tok.kind === "id") {
      const after = t[k + 1]?.text;
      if (after === "(" || after === "." || after === "[" || after === "{") return null;
      const value = resolveIdent(tok.text, k);
      if (value === null) return null;
      return { value, end: k + 1 };
    }
    return null;
  }
  function parseExpr(k) {
    let left = parseTerm(k);
    if (!left) return null;
    while (t[left.end]?.text === "+") {
      const right = parseTerm(left.end + 1);
      if (!right) return null;
      left = { value: left.value + right.value, end: right.end };
    }
    const stop = t[left.end]?.text;
    // A string followed by anything but a delimiter is part of a larger
    // expression (a comparison, a method call, ...).
    if (stop !== undefined && ![",", "}", ")", ";", "]", ":"].includes(stop) && t[left.end].line === t[left.end - 1].line) return null;
    return left;
  }

  const projects = [];
  const skipped = [];
  const mapValues = new Set();
  const isMapAt = (k) =>
    t[k]?.text === "map" && t[k + 1]?.text === "[" && t[k + 2]?.text === "string" && t[k + 3]?.text === "]" && t[k + 4]?.text === "string" && t[k + 5]?.text === "{";
  // Template functions: func NAME(P string) map[string]string { return map[string]string{...} }
  const templates = new Map();
  for (let k = 0; k + 14 < t.length; k++) {
    if (t[k].text !== "func" || t[k + 1].kind !== "id" || t[k + 2].text !== "(" || t[k + 3].kind !== "id" || t[k + 4].text !== "string" || t[k + 5].text !== ")") continue;
    if (!isMapAt(k + 6) || t[k + 12].text !== "return" || !isMapAt(k + 13)) continue;
    templates.set(t[k + 1].text, { param: t[k + 3].text, map: k + 13 });
  }
  const templateMaps = new Set([...templates.values()].map((v) => v.map));
  // Reads the map literal at k; null when an entry is not a string expression.
  function readMap(k) {
    let j = k + 6;
    const files = {};
    let ok = true;
    let tsKeys = 0;
    while (t[j] && t[j].text !== "}") {
      const key = parseExpr(j);
      if (!key || t[key.end]?.text !== ":") {
        ok = false;
        break;
      }
      const value = parseExpr(key.end + 1);
      if (!value) {
        ok = false;
        break;
      }
      const name = key.value.replace(/^\/\.src\//, "");
      if (/\.(d\.)?[cm]?tsx?$/.test(name) || name.endsWith(".json")) tsKeys++;
      files[name] = value.value;
      j = value.end;
      if (t[j]?.text === ",") j++;
    }
    return { ok, files, tsKeys };
  }
  const addMap = (origin, files, tsKeys) => {
    if (!tsKeys || tsKeys !== Object.keys(files).length) return;
    for (const v of Object.values(files)) mapValues.add(v);
    projects.push({ origin, files });
  };
  for (let k = 0; k + 5 < t.length; k++) {
    if (!isMapAt(k) || templateMaps.has(k)) continue;
    missingFields = new Set();
    const { ok, files, tsKeys } = readMap(k);
    if (!ok && missingFields.size) {
      // A read stops at its first unknown field: widen the wanted set until
      // the rows read or ask for nothing new.
      const wanted = new Set(missingFields);
      let read = [];
      for (let round = 0; round < 8; round++) {
        read = [];
        const before = wanted.size;
        for (const row of tableRows(k, wanted)) {
          fieldBindings = row.values;
          missingFields = new Set();
          const r = readMap(k);
          fieldBindings = null;
          for (const f of missingFields) wanted.add(f);
          if (r.ok) read.push({ row, r });
        }
        if (wanted.size === before) break;
      }
      for (const { row, r } of read) addMap(`${file}:${t[k].line}@${row.line}`, r.files, r.tsKeys);
      if (read.length) continue;
    }
    if (!ok) {
      if (Object.keys(files).length || tsKeys) skipped.push(`${file}:${t[k].line}`);
      else {
        // An entry we cannot read: count it only when the map looks like sources.
        let m = k + 6;
        while (t[m] && t[m].text !== "}" && m < k + 12) {
          if (t[m].kind === "str" && /\.ts"?$/.test(t[m].value)) {
            skipped.push(`${file}:${t[k].line}`);
            break;
          }
          m++;
        }
      }
      continue;
    }
    addMap(`${file}:${t[k].line}`, files, tsKeys);
  }
  // Template calls: NAME(expr) binds the parameter and reads the template map.
  for (let k = 0; k + 2 < t.length; k++) {
    const template = templates.get(t[k].text);
    if (!template || t[k + 1].text !== "(" || t[k - 1]?.text === "func") continue;
    const argument = parseExpr(k + 2);
    if (!argument || t[argument.end]?.text !== ")") {
      skipped.push(`${file}:${t[k].line}`);
      continue;
    }
    mapValues.add(argument.value);
    bindings = new Map([[template.param, argument.value]]);
    const { ok, files, tsKeys } = readMap(template.map);
    bindings = new Map();
    if (!ok) {
      skipped.push(`${file}:${t[k].line}`);
      continue;
    }
    addMap(`${file}:${t[k].line}`, files, tsKeys);
  }
  // Standalone sources: string expressions with `export` outside the maps.
  const seen = new Set();
  for (let k = 0; k < t.length; k++) {
    if (t[k].kind !== "str") continue;
    const prev = t[k - 1]?.text;
    if (![":=", "=", ":", "(", ","].includes(prev)) continue;
    const expr = parseExpr(k);
    if (!expr || !/\bexport\b/.test(expr.value) || mapValues.has(expr.value) || seen.has(expr.value)) continue;
    seen.add(expr.value);
    projects.push({ origin: `${file}:${t[k].line}`, files: { "test.ts": expr.value } });
  }
  // Identifier sources (`files: {"test.ts": source}` is a map; `compile(t, source)` is not).
  for (let k = 1; k < t.length; k++) {
    if (t[k].kind !== "id" || !["(", ","].includes(t[k - 1].text) || ![")", ","].includes(t[k + 1]?.text)) continue;
    if (!/source|Source|code|Code/.test(t[k].text)) continue;
    const value = resolveIdent(t[k].text, k);
    if (value === null || !/\bexport\b/.test(value) || mapValues.has(value) || seen.has(value)) continue;
    seen.add(value);
    projects.push({ origin: `${file}:${t[k].line}`, files: { "test.ts": value } });
  }
  return { projects, skipped };
}

// Every project of the Go test files under `effectRepo`, one per distinct file
// set, in file order: { projects: [{ origin, files }], skipped: [origin] }.
export function goUnitProjects(effectRepo) {
  const all = [];
  const skipped = [];
  for (const rel of TEST_FILES) {
    const full = path.join(effectRepo, rel);
    if (!fs.existsSync(full)) continue;
    const r = extract(rel, fs.readFileSync(full, "utf8"));
    all.push(...r.projects);
    skipped.push(...r.skipped);
  }
  const projects = [];
  const keys = new Set();
  for (const p of all) {
    const key = JSON.stringify(Object.entries(p.files).sort());
    if (keys.has(key)) continue;
    keys.add(key);
    projects.push(p);
  }
  return { projects, skipped };
}

// The tsconfig of a project: the Go test options (target and module esnext and
// nodenext, strict, skipLibCheck) and the Effect plugin with `apiStabilityLeak`,
// `unstableApiUsage` and `experimentalApiUsage` at warning.
export function goUnitTsconfig(fileNames) {
  return {
    compilerOptions: {
      target: "esnext",
      module: "nodenext",
      moduleResolution: "nodenext",
      strict: true,
      skipLibCheck: true,
      skipDefaultLibCheck: true,
      noErrorTruncation: true,
      noEmit: true,
      types: [],
      plugins: [
        {
          name: "@effect/language-service",
          diagnosticSeverity: {
            apiStabilityLeak: "warning",
            unstableApiUsage: "warning",
            experimentalApiUsage: "warning",
          },
        },
      ],
    },
    files: fileNames.filter((n) => !n.endsWith(".json")).sort(),
  };
}

// The table rows of TestUnknownRuleNames and TestUnknownRuleNamesExtends
// (internal/effectconfigcheck/validation_test.go) as projects: { origin, files }
// with their own tsconfig.json (and base.json, middle.json) and main.ts. Go's
// `config` helper roots the file list at "/main.ts" of its virtual file system;
// here it is "main.ts".
export function configProjects(effectRepo) {
  const rel = "internal/effectconfigcheck/validation_test.go";
  const full = path.join(effectRepo, rel);
  if (!fs.existsSync(full)) return [];
  const lines = fs.readFileSync(full, "utf8").split("\n");
  const config = (options, extra) =>
    `{"files":["main.ts"],"compilerOptions":{"plugins":[{"name":"@effect/language-service",` + options + `}]}` + extra + `}`;
  const projects = [];
  let test = "";
  lines.forEach((line, i) => {
    const func = /^func (Test\w+)\(/.exec(line);
    if (func) test = func[1];
    const origin = `${rel}:${i + 1}`;
    let m;
    if (test === "TestUnknownRuleNames" && (m = /^\t\t\{"[^"]+", `([^`]*)`, \d+, diagnostics\.Category\w+\},$/.exec(line))) {
      projects.push({ origin, files: { "main.ts": "export {}", "tsconfig.json": config(m[1], "") } });
    }
    if (test === "TestUnknownRuleNamesExtends" && (m = /^\t\t\{"[^"]+", `([^`]*)`, `([^`]*)`, \d+, diagnostics\.Category\w+, (?:true|false)\},$/.exec(line))) {
      projects.push({
        origin,
        files: {
          "main.ts": "export {}",
          "base.json": config(m[1], ""),
          "middle.json": `{"extends":"./base.json"}`,
          "tsconfig.json": config(m[2], `,"extends":"./middle.json"`),
        },
      });
    }
  });
  if (!projects.length) throw new Error(`no table rows in ${rel}`);
  return projects;
}
