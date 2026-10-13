// Tests for src/program.js, src/host.js and src/session.js: TS 6.0 Programs backed by tsc-rs
// snapshots, as tools and TS 6.0's own callers (language service, ts.server.ProjectService) use
// them. Run after `node scripts/build.mjs`: `node --test test/program.test.mjs`.
// Differential tests build the same program with TypeScript 6.0.3 itself (`stableTypeOrdering:
// true`) and compare; TypeScript 6.0.3 comes from the tarball scripts/build.mjs cached (TSRS_TS6
// overrides it).

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// TEMPORARY: src/index.js installs the hooks only with this set, until root removes the gate.

const require = createRequire(import.meta.url);
const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoDir = path.resolve(packageDir, "../..");
const ts = require(path.join(packageDir, "lib/typescript.js"));
const ts6Main = findTs6Reference();
const ts6 = ts6Main === undefined ? undefined : require(ts6Main);
const needsTs6 = { skip: ts6 === undefined ? "no TypeScript 6.0.3 reference (run scripts/build.mjs or set TSRS_TS6)" : false };
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "tsrs-program-"));

function findTs6Reference() {
    if (process.env.TSRS_TS6) {
        return require.resolve(process.env.TSRS_TS6);
    }
    const tarball = path.join(packageDir, ".cache/typescript-6.0.3.tgz");
    const dir = path.join(repoDir, "target/typescript-api/ts603");
    const main = path.join(dir, "package/lib/typescript.js");
    if (!fs.existsSync(main)) {
        if (!fs.existsSync(tarball)) {
            return undefined;
        }
        fs.mkdirSync(dir, { recursive: true });
        execFileSync("tar", ["-xzf", tarball, "-C", dir]);
    }
    return main;
}

function writeFixture(name, files) {
    const dir = path.join(workDir, name);
    for (const [file, text] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
        fs.writeFileSync(path.join(dir, file), text);
    }
    return dir;
}

// File names relative to the fixture; lib files by their base name (each package has its own lib/).
function relative(dir, fileName) {
    if (fileName === undefined) {
        return undefined;
    }
    return /[\\/]lib\.[^\\/]*\.d\.ts$/.test(fileName) ? `lib:${path.basename(fileName)}` : path.relative(dir, fileName);
}

function describeDiagnostics(dir, diagnostics) {
    return diagnostics.map(diagnostic => `${relative(dir, diagnostic.file?.fileName) ?? "-"}:${diagnostic.start ?? "-"}:${diagnostic.length ?? "-"}:${diagnostic.code}`);
}

// A node16 project with a package, ambient modules, augmentations and a dynamic import.
const moduleFixture = {
    "package.json": JSON.stringify({ name: "app", type: "module" }),
    "src/a.ts": [
        "import { b } from \"./b.js\";",
        "import type { P } from \"pkg\";",
        "import * as fs from \"node:fs\";",
        "import x = require(\"./c.cjs\");",
        "declare module \"./b.js\" { interface B { y: number } }",
        "export const a: number = b;",
        "export const z = import(\"./d.js\");",
        "let q: string = 1;",
        "",
    ].join("\n"),
    "src/b.ts": "export const b = 1;\nexport interface B { x: number }\n",
    "src/c.cts": "export = 1;\n",
    "src/d.ts": "/// <reference path=\"./missing.d.ts\" />\nexport const d = 1;\n",
    "src/g.d.ts": "declare module \"ambient-x\" { export const q: number; }\n",
    "node_modules/pkg/package.json": JSON.stringify({ name: "pkg", version: "1.2.3", types: "index.d.ts" }),
    "node_modules/pkg/index.d.ts": "export interface P { p: string }\n",
    "node_modules/@types/node/package.json": JSON.stringify({ name: "@types/node", version: "20.0.0", types: "index.d.ts" }),
    "node_modules/@types/node/index.d.ts": "declare module \"node:fs\" { export const readFileSync: unknown; }\n",
};

function moduleProgram(anyTs, dir) {
    const options = {
        module: anyTs.ModuleKind.NodeNext,
        moduleResolution: anyTs.ModuleResolutionKind.NodeNext,
        target: anyTs.ScriptTarget.ES2022,
        strict: true,
        declaration: true,
        outDir: path.join(dir, "out"),
        types: ["node"],
        stableTypeOrdering: true,
    };
    return anyTs.createProgram([path.join(dir, "src/a.ts"), path.join(dir, "src/g.d.ts")], options);
}

// What TS 6.0's program says about its files, in names relative to the fixture.
function describeModuleProgram(anyTs, dir) {
    const program = moduleProgram(anyTs, dir);
    const files = program.getSourceFiles();
    const userFiles = files.filter(file => !relative(dir, file.fileName).startsWith("lib:"));
    const a = program.getSourceFile(path.join(dir, "src/a.ts"));
    const resolutions = [];
    program.forEachResolvedModule((resolution, name, mode, filePath) => {
        resolutions.push(`${relative(dir, filePath)} ${name} ${mode} ${relative(dir, resolution.resolvedModule?.resolvedFileName) ?? "unresolved"}`);
    });
    const reasons = program.getFileIncludeReasons();
    return {
        files: files.map(file => relative(dir, file.fileName)),
        flags: userFiles.map(file => [relative(dir, file.fileName), program.isSourceFileFromExternalLibrary(file), program.isSourceFileDefaultLibrary(file), file.impliedNodeFormat]),
        defaultLibraries: files.filter(file => program.isSourceFileDefaultLibrary(file)).length,
        references: userFiles.map(file => [file.imports.map(literal => literal.text), file.moduleAugmentations.map(name => name.text), file.ambientModuleNames]),
        modes: a.imports.map(literal => [literal.text, program.getModeForUsageLocation(a, literal), program.getModeForResolutionAtIndex(a, a.imports.indexOf(literal))]),
        resolved: a.imports.map(literal => {
            const resolved = program.getResolvedModule(a, literal.text, program.getModeForUsageLocation(a, literal))?.resolvedModule;
            return resolved && [relative(dir, resolved.resolvedFileName), resolved.extension, resolved.isExternalLibraryImport, resolved.packageId];
        }),
        resolutions: resolutions.sort(),
        packageNames: [...program.sourceFileToPackageName].map(([filePath, name]) => [relative(dir, filePath), name]),
        commonSourceDirectory: relative(dir, program.getCommonSourceDirectory()),
        missing: [...program.getMissingFilePaths().values()].map(fileName => relative(dir, fileName)),
        reasons: userFiles.map(file => [relative(dir, file.fileName), (reasons.get(file.path) ?? []).map(reason => `${anyTs.FileIncludeKind[reason.kind]}:${reason.index ?? ""}:${relative(dir, reason.file) ?? ""}`)]),
        usesUriStyleNodeCoreModules: program.usesUriStyleNodeCoreModules,
        formats: userFiles.map(file => [program.getImpliedNodeFormatForEmit(file), program.getEmitModuleFormatOfFile(file), program.getDefaultResolutionModeForFile(file), program.shouldTransformImportCall(file)]),
        emitted: ["out/a.js", "src/a.js", "src/b.ts", "out/b.d.ts"].map(file => program.isEmittedFile(path.join(dir, file))),
    };
}

test("a program lists its files, imports and module formats like TypeScript 6.0", needsTs6, () => {
    const dir = writeFixture("modules", moduleFixture);
    const expected = describeModuleProgram(ts6, dir);
    const actual = describeModuleProgram(ts, dir);
    for (const key of ["files", "flags", "defaultLibraries", "references", "modes", "formats", "emitted", "usesUriStyleNodeCoreModules"]) {
        assert.deepEqual(actual[key], expected[key], key);
    }
});

test("module resolutions, package names and file include reasons match TypeScript 6.0", needsTs6, () => {
    const dir = writeFixture("resolutions", moduleFixture);
    const expected = describeModuleProgram(ts6, dir);
    const actual = describeModuleProgram(ts, dir);
    for (const key of ["resolved", "resolutions", "packageNames", "commonSourceDirectory", "missing", "reasons"]) {
        assert.deepEqual(actual[key], expected[key], key);
    }
});

test("each kind of diagnostic matches TypeScript 6.0", needsTs6, () => {
    const dir = writeFixture("diagnostics", {
        "syntax.ts": "export const s = ;\n",
        "semantic.ts": "export const n: number = \"x\";\nexport function f(a) { return a; }\n",
        "declaration.ts": "export const C = class { private x = 1; };\nexport function make() { return class { protected y = 2; }; }\n",
    });
    const describe = anyTs => {
        const options = { strict: true, declaration: true, target: anyTs.ScriptTarget.ES2022, module: anyTs.ModuleKind.CommonJS, types: [], outDir: path.join(dir, "out"), stableTypeOrdering: true };
        const program = anyTs.createProgram(["syntax.ts", "semantic.ts", "declaration.ts", "missing.ts"].map(file => path.join(dir, file)), options);
        const semantic = program.getSourceFile(path.join(dir, "semantic.ts"));
        return {
            syntactic: describeDiagnostics(dir, program.getSyntacticDiagnostics()),
            semantic: describeDiagnostics(dir, program.getSemanticDiagnostics()),
            semanticOfFile: describeDiagnostics(dir, program.getSemanticDiagnostics(semantic)),
            global: describeDiagnostics(dir, program.getGlobalDiagnostics()),
            options: describeDiagnostics(dir, program.getOptionsDiagnostics()),
            declaration: describeDiagnostics(dir, program.getDeclarationDiagnostics()),
            preEmit: describeDiagnostics(dir, anyTs.getPreEmitDiagnostics(program)),
        };
    };
    assert.deepEqual(describe(ts), describe(ts6));
});

test("getCommonSourceDirectory matches TypeScript 6.0 with and without rootDir", needsTs6, () => {
    const dir = writeFixture("common", {
        "src/app/main.ts": "export const main = 1;\n",
        "src/lib/util.ts": "export const util = 1;\n",
        "src/types.d.ts": "declare const g: number;\n",
    });
    const roots = ["src/app/main.ts", "src/lib/util.ts", "src/types.d.ts"].map(file => path.join(dir, file));
    for (const extra of [{}, { rootDir: dir }, { rootDir: path.join(dir, "src") }]) {
        const common = anyTs => relative(dir, anyTs.createProgram(roots, { outDir: path.join(dir, "out"), types: [], ...extra }).getCommonSourceDirectory());
        assert.equal(common(ts), common(ts6), JSON.stringify(extra));
    }
});

test("a host's SourceFiles are the program's SourceFiles, with parents and program fields set", () => {
    const dir = writeFixture("host-files", {
        "main.ts": "import { dep } from \"./dep\";\nexport const value: number = dep;\n",
        "dep.ts": "export const dep = 1;\n",
    });
    const options = { strict: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, types: [] };
    const base = ts.createCompilerHost(options);
    const created = new Map();
    const host = {
        ...base,
        getSourceFile(fileName, languageVersion) {
            if (!created.has(fileName)) {
                const text = base.readFile(fileName);
                created.set(fileName, text === undefined ? undefined : ts.createSourceFile(fileName, text, languageVersion, false));
            }
            return created.get(fileName);
        },
    };
    const program = ts.createProgram([path.join(dir, "main.ts")], options, host);
    const main = program.getSourceFile(path.join(dir, "main.ts"));
    assert.equal(main, created.get(path.join(dir, "main.ts")));
    assert.equal(program.getSourceFile(path.join(dir, "dep.ts")), created.get(path.join(dir, "dep.ts")));
    assert.equal(main.statements[1].parent, main);
    assert.equal(main.path, ts.toPath(path.join(dir, "main.ts"), dir, ts.createGetCanonicalFileName(ts.sys.useCaseSensitiveFileNames)));
    assert.equal(main.resolvedPath, main.path);
    assert.equal(main.originalFileName, path.join(dir, "main.ts"));
    assert.deepEqual(main.imports.map(literal => literal.text), ["./dep"]);
    const checker = program.getTypeChecker();
    assert.equal(checker.typeToString(checker.getTypeAtLocation(main.statements[1].declarationList.declarations[0].name)), "number");
    // Lib files come from the host too when it has tsc-rs's lib text (here the package's lib/).
    const lib = program.getSourceFiles().find(file => program.isSourceFileDefaultLibrary(file));
    assert.equal(lib, created.get(lib.fileName));
});

test("an exception thrown by the host leaves createProgram with that exception and the session usable", () => {
    const dir = writeFixture("host-throws", { "main.ts": "export const main = 1;\n" });
    const options = { types: [] };
    const base = ts.createCompilerHost(options);
    const failure = new Error("host failure");
    const host = {
        ...base,
        getSourceFile(fileName, languageVersion) {
            if (fileName.endsWith("main.ts")) {
                throw failure;
            }
            return base.getSourceFile(fileName, languageVersion);
        },
    };
    assert.throws(() => ts.createProgram([path.join(dir, "main.ts")], options, host), error => error === failure);
    const program = ts.createProgram([path.join(dir, "main.ts")], options);
    assert.deepEqual(describeDiagnostics(dir, ts.getPreEmitDiagnostics(program)), []);
});

// A ts-loader style host: "@app/x" maps to lib/x.ts, everything else to TS 6.0's resolver.
function aliasFixture(anyTs, name, useLiterals) {
    const dir = writeFixture(name, {
        "src/main.ts": "import { helper } from \"@app/helper\";\nimport { other } from \"@app/other\";\nimport { b } from \"./b\";\nexport const x: string = helper(other + b);\n",
        "src/b.ts": "import { helper } from \"@app/helper\";\nexport const b = helper(\"b\").length;\n",
        "lib/helper.ts": "export function helper(value: string | number): string { return String(value); }\n",
        "lib/other.ts": "export const other = 2;\n",
    });
    const options = { strict: true, target: anyTs.ScriptTarget.ES2022, module: anyTs.ModuleKind.CommonJS, noEmit: true, types: [] };
    const base = anyTs.createCompilerHost(options);
    const calls = [];
    const resolve = (name, containingFile, compilerOptions) => name.startsWith("@app/")
        ? { resolvedFileName: path.join(dir, "lib", `${name.slice(5)}.ts`), extension: ".ts" }
        : anyTs.resolveModuleName(name, containingFile, compilerOptions, base).resolvedModule;
    const host = useLiterals
        ? {
            ...base,
            resolveModuleNameLiterals(literals, containingFile, redirectedReference, compilerOptions, containingSourceFile) {
                calls.push(`${relative(dir, containingFile)}: ${literals.map(literal => `${literal.text}${literal.parent === undefined ? "" : " (parent)"}`).join(", ")} ${containingSourceFile.fileName === containingFile}`);
                return literals.map(literal => ({ resolvedModule: resolve(literal.text, containingFile, compilerOptions) }));
            },
        }
        : {
            ...base,
            resolveModuleNames(names, containingFile, reusedNames, redirectedReference, compilerOptions, containingSourceFile) {
                calls.push(`${relative(dir, containingFile)}: ${names.join(", ")} ${containingSourceFile.fileName === containingFile}`);
                return names.map(name => resolve(name, containingFile, compilerOptions));
            },
        };
    const program = anyTs.createProgram([path.join(dir, "src/main.ts")], options, host);
    const main = program.getSourceFile(path.join(dir, "src/main.ts"));
    return {
        files: program.getSourceFiles().map(file => relative(dir, file.fileName)).filter(file => !file.startsWith("lib:")),
        calls,
        diagnostics: describeDiagnostics(dir, anyTs.getPreEmitDiagnostics(program)),
        resolved: main.imports.map(literal => relative(dir, program.getResolvedModule(main, literal.text, program.getModeForUsageLocation(main, literal))?.resolvedModule?.resolvedFileName)),
    };
}

test("a host's resolveModuleNames answers module resolution, called once per file like TypeScript 6.0", needsTs6, () => {
    assert.deepEqual(aliasFixture(ts, "aliases-names", false), aliasFixture(ts6, "aliases-names-ts6", false));
});

test("a host's resolveModuleNameLiterals gets the import literals with their parents, like TypeScript 6.0", needsTs6, () => {
    assert.deepEqual(aliasFixture(ts, "aliases-literals", true), aliasFixture(ts6, "aliases-literals-ts6", true));
});

// A watch style host: one SourceFile per file, replaced when a test edits the file.
function editableHost(anyTs, dir, options) {
    const base = anyTs.createCompilerHost(options);
    const files = new Map();
    const edits = new Map();
    let invalidated = false;
    const host = {
        ...base,
        getSourceFile(fileName, languageVersion) {
            if (!files.has(fileName)) {
                const text = edits.get(fileName) ?? base.readFile(fileName);
                files.set(fileName, text === undefined ? undefined : anyTs.createSourceFile(fileName, text, languageVersion, true));
            }
            return files.get(fileName);
        },
        fileExists: fileName => edits.has(fileName) || base.fileExists(fileName),
        readFile: fileName => edits.get(fileName) ?? base.readFile(fileName),
        hasInvalidatedResolutions: () => invalidated,
    };
    return {
        host,
        edit(file, text) {
            edits.set(path.join(dir, file), text);
            files.delete(path.join(dir, file));
        },
        invalidate(value) {
            invalidated = value;
        },
    };
}

test("a program made from an oldProgram reuses its structure the way TypeScript 6.0 reports it", needsTs6, () => {
    const describe = anyTs => {
        const dir = writeFixture(`reuse-${anyTs === ts ? "tsrs" : "ts6"}`, {
            "main.ts": "import { dep } from \"./dep\";\nexport const value: number = dep;\n",
            "dep.ts": "export const dep = 1;\n",
            "extra.ts": "export const extra = \"x\";\n",
        });
        const options = { strict: true, target: anyTs.ScriptTarget.ES2022, module: anyTs.ModuleKind.CommonJS, types: [] };
        const { host, edit } = editableHost(anyTs, dir, options);
        const roots = [path.join(dir, "main.ts")];
        const steps = [];
        let program = anyTs.createProgram(roots, options, host);
        const next = (label, rootNames = roots) => {
            program = anyTs.createProgram(rootNames, options, host, program);
            steps.push([label, program.structureIsReused, program.getSourceFiles().filter(file => !relative(dir, file.fileName).startsWith("lib:")).length, describeDiagnostics(dir, anyTs.getPreEmitDiagnostics(program))]);
        };
        next("nothing changed");
        edit("dep.ts", "export const dep = \"text\";\n");
        next("text changed");
        edit("main.ts", "import { dep } from \"./dep\";\nimport { extra } from \"./extra\";\nexport const value: number = dep + extra;\n");
        next("imports changed");
        next("roots changed", [...roots, path.join(dir, "dep.ts")]);
        return steps;
    };
    assert.deepEqual(describe(ts), describe(ts6));
});

test("a program made from an oldProgram has tsc-rs read only the files whose text changed", () => {
    const dir = writeFixture("reuse-reads", {
        "main.ts": "import { dep } from \"./dep\";\nexport const value: number = dep;\n",
        "dep.ts": "export const dep = 1;\n",
    });
    const options = { strict: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, types: [] };
    const { host, edit, invalidate } = editableHost(ts, dir, options);
    const roots = [path.join(dir, "main.ts")];
    const first = ts.createProgram(roots, options, host);
    // What tsc-rs reads through the program's file system (it can read a changed file twice).
    const { session } = first;
    const answer = session.answer;
    let reads = [];
    session.answer = function countReads(name, payload) {
        const fileName = JSON.parse(payload);
        if (name === "readFile" && !fileName.startsWith("bundled:") && !reads.includes(path.basename(fileName))) {
            reads.push(path.basename(fileName));
        }
        return answer.call(this, name, payload);
    };
    const next = oldProgram => {
        reads = [];
        return ts.createProgram(roots, options, host, oldProgram);
    };
    try {
        edit("dep.ts", "export const dep = \"text\";\n");
        const second = next(first);
        assert.deepEqual(reads, ["dep.ts"]);
        assert.deepEqual(second.getSemanticDiagnostics().map(diagnostic => diagnostic.code), [2322]);
        const third = next(second);
        assert.deepEqual(reads, []);
        assert.equal(third.getSourceFile(path.join(dir, "main.ts")), second.getSourceFile(path.join(dir, "main.ts")));
        // Invalidated resolutions (a watch host's failed lookups) make tsc-rs read every file again.
        invalidate(true);
        const fourth = next(third);
        assert.deepEqual(reads.sort(), ["dep.ts", "main.ts"]);
        assert.equal(fourth.structureIsReused, ts.StructureIsReused.SafeModules);
    }
    finally {
        session.answer = answer;
    }
});

test("programs made from an oldProgram keep their own compiler state while they are referenced", () => {
    const dir = writeFixture("release", { "main.ts": "export const main: number = 1;\n" });
    const options = { types: [] };
    const { host, edit } = editableHost(ts, dir, options);
    const roots = [path.join(dir, "main.ts")];
    const first = ts.createProgram(roots, options, host);
    edit("main.ts", "export const main: number = 2;\n");
    const second = ts.createProgram(roots, options, host, first);
    edit("main.ts", "export const main: number = \"3\";\n");
    const third = ts.createProgram(roots, options, host, second);
    assert.equal(first.getSemanticDiagnostics().length, 0);
    assert.equal(first.getSourceFile(path.join(dir, "main.ts")).text, "export const main: number = 1;\n");
    assert.equal(second.getSemanticDiagnostics().length, 0);
    assert.deepEqual(third.getSemanticDiagnostics().map(diagnostic => diagnostic.code), [2322]);
});

// A language service host over in-memory files, as TS 6.0's tests and tools write them.
function languageServiceHost(anyTs, dir, files, options) {
    const versions = new Map(Object.keys(files).map(file => [file, 1]));
    const host = {
        getScriptFileNames: () => Object.keys(files).map(file => path.join(dir, file)),
        getScriptVersion: fileName => String(versions.get(path.relative(dir, fileName)) ?? 0),
        getScriptSnapshot(fileName) {
            const text = files[path.relative(dir, fileName)] ?? anyTs.sys.readFile(fileName);
            return text === undefined ? undefined : anyTs.ScriptSnapshot.fromString(text);
        },
        getCurrentDirectory: () => dir,
        getCompilationSettings: () => options,
        getDefaultLibFileName: compilerOptions => anyTs.getDefaultLibFilePath(compilerOptions),
        fileExists: fileName => files[path.relative(dir, fileName)] !== undefined || anyTs.sys.fileExists(fileName),
        readFile: fileName => files[path.relative(dir, fileName)] ?? anyTs.sys.readFile(fileName),
        readDirectory: anyTs.sys.readDirectory,
        directoryExists: anyTs.sys.directoryExists,
        getDirectories: anyTs.sys.getDirectories,
    };
    return {
        host,
        edit(file, text) {
            files[file] = text;
            versions.set(file, versions.get(file) + 1);
        },
    };
}

test("TS 6.0's language service runs on tsc-rs programs and reuses them while nothing changes", needsTs6, () => {
    const describe = anyTs => {
        const dir = path.join(workDir, `language-service-${anyTs === ts ? "tsrs" : "ts6"}`);
        fs.mkdirSync(dir, { recursive: true });
        const files = {
            "a.ts": "import { b } from \"./b\";\nexport const a: number = b;\nexport function f(x: string) { return x.length; }\nconst unused = 1;\n",
            "b.ts": "export const b = 2;\n",
        };
        const options = { strict: true, noUnusedLocals: true, declaration: true, target: anyTs.ScriptTarget.ES2022, module: anyTs.ModuleKind.CommonJS, types: [], outDir: path.join(dir, "out"), stableTypeOrdering: true };
        const { host, edit } = languageServiceHost(anyTs, dir, files, options);
        const service = anyTs.createLanguageService(host, anyTs.createDocumentRegistry());
        const a = path.join(dir, "a.ts");
        const steps = [];
        for (const change of [undefined, "export const b = \"text\";\n"]) {
            if (change !== undefined) {
                edit("b.ts", change);
            }
            const program = service.getProgram();
            steps.push({
                reused: service.getProgram() === program,
                structure: program.structureIsReused,
                files: program.getSourceFiles().length,
                syntactic: describeDiagnostics(dir, service.getSyntacticDiagnostics(a)),
                semantic: describeDiagnostics(dir, service.getSemanticDiagnostics(a)),
                suggestion: describeDiagnostics(dir, service.getSuggestionDiagnostics(a)),
                compilerOptions: describeDiagnostics(dir, service.getCompilerOptionsDiagnostics()),
                emit: service.getEmitOutput(a).outputFiles.map(output => [path.basename(output.name), output.text]),
                declarationEmit: service.getEmitOutput(a, true).outputFiles.map(output => path.basename(output.name)),
            });
        }
        return steps;
    };
    const actual = describe(ts);
    const expected = describe(ts6);
    // TS 7 lib differences: tsc-rs's default libs need not be TS 6.0's.
    for (const step of [...actual, ...expected]) {
        delete step.files;
    }
    assert.deepEqual(actual, expected);
});

test("a language service's document registry counts the program's files as TypeScript 6.0's does", needsTs6, () => {
    const describe = anyTs => {
        const dir = path.join(workDir, `registry-${anyTs === ts ? "tsrs" : "ts6"}`);
        fs.mkdirSync(dir, { recursive: true });
        const files = { "a.ts": "import { b } from \"./b\";\nexport const a = b;\n", "b.ts": "export const b = 1;\n", "c.ts": "export const c = 1;\n" };
        const { host, edit } = languageServiceHost(anyTs, dir, files, { types: [], target: anyTs.ScriptTarget.ES2022 });
        let roots = ["a.ts", "c.ts"];
        host.getScriptFileNames = () => roots.map(file => path.join(dir, file));
        const registry = anyTs.createDocumentRegistry();
        const service = anyTs.createLanguageService(host, registry);
        const counts = () => {
            const result = [];
            for (const [, bucket] of registry.getBuckets()) {
                for (const [filePath, entry] of bucket) {
                    const { languageServiceRefCount } = entry.sourceFile === undefined ? [...entry.values()][0] : entry;
                    result.push(`${relative(dir, filePath).startsWith("lib:") ? "lib" : path.basename(filePath)}:${languageServiceRefCount}`);
                }
            }
            return result.sort();
        };
        const steps = [];
        service.getProgram();
        steps.push(counts());
        roots = ["a.ts"];
        service.getProgram();
        steps.push(counts());
        edit("a.ts", "export const a = 1;\n");
        service.getProgram();
        steps.push(counts());
        service.cleanupSemanticCache();
        steps.push(counts());
        service.getProgram();
        service.dispose();
        steps.push(counts());
        return steps.map(step => step.filter(entry => !entry.startsWith("lib:")));
    };
    assert.deepEqual(describe(ts), describe(ts6));
});

test("program members work unbound, as TS 6.0's program closures do", () => {
    const dir = writeFixture("unbound", { "main.ts": "import { dep } from \"./dep\";\nexport const main = dep;\n", "dep.ts": "export const dep = 1;\n" });
    const program = ts.createProgram([path.join(dir, "main.ts")], { types: [] });
    const { getSourceFile, getSourceFiles, forEachResolvedModule, getTypeChecker, getCompilerOptions } = program;
    assert.equal(getSourceFile(path.join(dir, "main.ts")), program.getSourceFile(path.join(dir, "main.ts")));
    assert.equal(getSourceFiles(), program.getSourceFiles());
    const names = [];
    forEachResolvedModule((resolution, name) => names.push(name));
    assert.deepEqual(names, ["./dep"]);
    assert.equal(getTypeChecker(), program.getTypeChecker());
    assert.equal(getCompilerOptions().types.length, 0);
});

// Quick info, completions, references and signature help need TS 6.0's checker internals.
function assertCheckerFeaturesFail(service, fileName, text) {
    const position = text.indexOf("f(\"q\")");
    const features = {
        getQuickInfoAtPosition: () => service.getQuickInfoAtPosition(fileName, position),
        getCompletionsAtPosition: () => service.getCompletionsAtPosition(fileName, text.indexOf("o.k") + 2, {}),
        findReferences: () => service.findReferences(fileName, position),
        getSignatureHelpItems: () => service.getSignatureHelpItems(fileName, position + 2, undefined),
    };
    for (const [name, feature] of Object.entries(features)) {
        let failure;
        try {
            feature();
        }
        catch (error) {
            failure = error;
        }
        // A feature that tsc-rs's checker can answer may work; one that cannot must say so.
        if (failure !== undefined) {
            assert.match(failure.message, /^tsc-rs: \S+ is not supported/, name);
        }
    }
}

const featureText = "export function f(x: string) { return x.length; }\nf(\"q\");\nconst o = { k: 1 };\no.k;\n";

test("language service features of a ts.server project that need TS 6.0's checker fail with a tsc-rs error", () => {
    const dir = writeFixture("project-service-features", {
        "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true, types: [] }, include: ["src"] }),
        "src/a.ts": featureText,
    });
    const service = projectService(ts);
    const fileName = path.join(dir, "src/a.ts");
    service.openClientFile(fileName, featureText, undefined, dir);
    const languageService = service.getDefaultProjectForFile(fileName, true).getLanguageService(true);
    assertCheckerFeaturesFail(languageService, fileName, featureText);
    assert.equal(languageService.getNavigationTree(fileName).childItems.length, 2);
});

const languageServiceHook = fs.readFileSync(path.join(packageDir, "lib/typescript.js"), "utf8").includes("function createLanguageService__ts6(");

test("features of ts.createLanguageService that need TS 6.0's checker fail with a tsc-rs error", { skip: languageServiceHook ? false : "lib/typescript.js has no createLanguageService hook point (scripts/build.mjs HOOKS)" }, () => {
    const dir = path.join(workDir, "language-service-features");
    fs.mkdirSync(dir, { recursive: true });
    const { host } = languageServiceHost(ts, dir, { "a.ts": featureText }, { strict: true, types: [] });
    const service = ts.createLanguageService(host);
    assertCheckerFeaturesFail(service, path.join(dir, "a.ts"), featureText);
});

test("getTypeChecker gives every member of TS 6.0's TypeChecker", () => {
    const dir = writeFixture("checker-members", { "a.ts": "export const a = 1;\n" });
    const program = ts.createProgram([path.join(dir, "a.ts")], { types: [] });
    const checker = program.getTypeChecker();
    assert.equal(program.getTypeChecker(), checker);
    for (const name of ["getTypeAtLocation", "runWithCancellationToken", "getNodeCount", "getRelationCacheSizes", "getSymbolWalker", "getEmitResolver"]) {
        assert.equal(typeof checker[name], "function", name);
    }
    assert.equal(checker.runWithCancellationToken(undefined, inner => inner), checker);
    assert.throws(() => checker.getEmitResolver(), /^Error: tsc-rs: checker\.getEmitResolver is not supported/);
    assert.ok(program.getNodeCount() > 0);
    assert.ok(program.getIdentifierCount() > 0);
});

// typescript-eslint's project service (packages/project-service/src/createProjectService.ts).
function projectService(anyTs) {
    const noop = () => {};
    const host = {
        ...anyTs.sys,
        clearImmediate,
        clearTimeout,
        setImmediate,
        setTimeout,
        watchDirectory: () => ({ close: noop }),
        watchFile: () => ({ close: noop }),
    };
    const logger = { close: noop, endGroup: noop, getLogFileName: () => undefined, hasLevel: () => false, info: noop, loggingEnabled: () => false, msg: noop, perftrc: noop, startGroup: noop };
    const service = new anyTs.server.ProjectService({
        cancellationToken: anyTs.server.nullCancellationToken,
        host,
        logger,
        session: undefined,
        useInferredProjectPerProjectRoot: false,
        useSingleInferredProject: false,
        jsDocParsingMode: anyTs.JSDocParsingMode.ParseAll,
    });
    service.setHostConfiguration({ preferences: { includePackageJsonAutoImports: "off" } });
    return service;
}

function projectServiceFixture(name) {
    return writeFixture(name, {
        "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true, target: "es2022", module: "commonjs", types: [], stableTypeOrdering: true }, include: ["src"] }),
        "src/dep.ts": "export interface Dep { a: number; b: string }\nexport const dep: Dep = { a: 1, b: \"x\" };\n",
        "src/file.ts": "",
    });
}

// typescript-eslint's useProgramFromProjectService: open the linted text, then ask the program.
function lintOnce(anyTs, service, dir, code) {
    const file = path.join(dir, "src/file.ts");
    const opened = service.openClientFile(file, code, undefined, dir);
    const program = service.getDefaultProjectForFile(service.getScriptInfo(file).fileName, true).getLanguageService(true).getProgram();
    const sourceFile = program.getSourceFile(file);
    const checker = program.getTypeChecker();
    const types = sourceFile.statements
        .filter(statement => anyTs.isVariableStatement(statement))
        .map(statement => checker.typeToString(checker.getTypeAtLocation(statement.declarationList.declarations[0].name)));
    return { configFileName: relative(dir, opened.configFileName), errors: opened.configFileErrors?.length ?? 0, text: sourceFile.text === code, types, program };
}

test("ts.server.ProjectService opens a file and answers type queries through its program, like TypeScript 6.0", needsTs6, () => {
    const describe = anyTs => {
        const dir = projectServiceFixture(`project-service-${anyTs === ts ? "tsrs" : "ts6"}`);
        const service = projectService(anyTs);
        const results = [];
        for (const code of ["import { dep } from \"./dep\";\nconst x = dep.a;\nconst y = dep;\n", "import { dep } from \"./dep\";\nconst z = [dep.b];\n"]) {
            const { program, ...result } = lintOnce(anyTs, service, dir, code);
            results.push({ ...result, sameAsService: service.getDefaultProjectForFile(path.join(dir, "src/file.ts"), true).getLanguageService(true).getProgram() === program });
        }
        return results;
    };
    assert.deepEqual(describe(ts), describe(ts6));
});

test("repeated openClientFile with new content stays fast, and every program it gave out keeps working", () => {
    const dir = projectServiceFixture("project-service-loop");
    const service = projectService(ts);
    const programs = new Set();
    const started = performance.now();
    const updates = 300;
    for (let index = 0; index < updates; index++) {
        const { program, types } = lintOnce(ts, service, dir, `import { dep } from "./dep";\nconst x${index} = dep.a + ${index};\n`);
        assert.deepEqual(types, ["number"]);
        programs.add(program);
    }
    const perUpdate = (performance.now() - started) / updates;
    assert.equal(programs.size, updates);
    assert.equal([...programs].filter(program => program.released).length, 0);
    const [first] = programs;
    assert.equal(first.getTypeChecker().typeToString(first.getTypeChecker().getTypeAtLocation(first.getSourceFile(path.join(dir, "src/file.ts")).statements[1].declarationList.declarations[0].name)), "number");
    // Generous: about 3 ms per update on an idle machine, as with TS 6.0.3's own ProjectService.
    assert.ok(perUpdate < 100, `${perUpdate.toFixed(1)} ms per update`);
});

test("project references give TS 6.0's resolved references and redirects; tsc-rs compiles their sources", needsTs6, () => {
    const describe = anyTs => {
        const dir = writeFixture(`references-${anyTs === ts ? "tsrs" : "ts6"}`, {
            "lib/tsconfig.json": JSON.stringify({ compilerOptions: { composite: true, outDir: "dist", rootDir: "src", types: [] }, include: ["src"] }),
            "lib/src/index.ts": "export const lib: number = 1;\n",
            "lib/dist/index.d.ts": "export declare const lib: number;\n",
            "app/tsconfig.json": JSON.stringify({ compilerOptions: { outDir: "dist", rootDir: "src", strict: true, types: [] }, include: ["src"], references: [{ path: "../lib" }] }),
            "app/src/main.ts": "import { lib } from \"../../lib/src/index\";\nexport const x: string = lib;\n",
        });
        const parsed = anyTs.getParsedCommandLineOfConfigFile(path.join(dir, "app/tsconfig.json"), undefined, { ...anyTs.sys, onUnRecoverableConfigFileDiagnostic: () => {} });
        const program = anyTs.createProgram({ rootNames: parsed.fileNames, options: parsed.options, projectReferences: parsed.projectReferences });
        const [reference] = program.getResolvedProjectReferences();
        let visited = 0;
        program.forEachResolvedProjectReference(() => {
            visited++;
        });
        const lib = path.join(dir, "lib/src/index.ts");
        return {
            reference: [relative(dir, reference.sourceFile.fileName), reference.commandLine.fileNames.map(file => relative(dir, file)), reference.references],
            visited,
            redirect: relative(dir, program.getRedirectFromSourceFile(lib)?.outputDts),
            byPath: program.getResolvedProjectReferenceByPath(reference.sourceFile.path) === reference,
            semantic: describeDiagnostics(dir, program.getSemanticDiagnostics()),
            files: program.getSourceFiles().map(file => relative(dir, file.fileName)).filter(file => !file.startsWith("lib:")),
        };
    };
    const actual = describe(ts);
    const expected = describe(ts6);
    // tsc-rs programs hold the referenced project's sources (TS 6.0 does that only with
    // useSourceOfProjectReferenceRedirect); TS 6.0's compiler holds its declaration output.
    assert.deepEqual(actual.files, ["lib/src/index.ts", "app/src/main.ts"]);
    assert.deepEqual(expected.files, ["lib/dist/index.d.ts", "app/src/main.ts"]);
    delete actual.files;
    delete expected.files;
    assert.deepEqual(actual, expected);
});

// A compiler host over in-memory files, like TS 6.0's own tests use. Lib files come from the
// package's lib directory unless `libs` is false.
function memoryHost(anyTs, files, { currentDirectory = "/", caseSensitive = true, defaultLib, libs = true } = {}) {
    const libDir = path.dirname(anyTs.getDefaultLibFilePath({}));
    const key = fileName => {
        const absolute = anyTs.normalizePath(anyTs.combinePaths(currentDirectory, fileName));
        return caseSensitive ? absolute : absolute.toLowerCase();
    };
    const texts = new Map(Object.entries(files).map(([fileName, text]) => [key(fileName), text]));
    const readFile = fileName => texts.get(key(fileName)) ?? (libs && fileName.startsWith(libDir) ? anyTs.sys.readFile(fileName) : undefined);
    const requests = [];
    return {
        requests,
        getSourceFile: (fileName, languageVersion) => {
            requests.push(fileName);
            const text = readFile(fileName);
            return text === undefined ? undefined : anyTs.createSourceFile(fileName, text, languageVersion);
        },
        getDefaultLibFileName: options => defaultLib ?? path.join(libDir, anyTs.getDefaultLibFileName(options)),
        writeFile: () => {},
        getCurrentDirectory: () => currentDirectory,
        getCanonicalFileName: fileName => (caseSensitive ? fileName : fileName.toLowerCase()),
        getNewLine: () => "\n",
        useCaseSensitiveFileNames: () => caseSensitive,
        fileExists: fileName => readFile(fileName) !== undefined,
        readFile,
        getDirectories: () => [],
    };
}

function messages(anyTs, diagnostics) {
    return diagnostics.map(diagnostic => `${diagnostic.file?.fileName ?? "-"}:${diagnostic.start ?? "-"}:${diagnostic.code}:${anyTs.flattenDiagnosticMessageText(diagnostic.messageText, "\n")}`);
}

test("createProgram throws like TypeScript 6.0 on options read from tsconfig JSON without parsing", () => {
    const host = memoryHost(ts, { "/a.ts": "export {};\n" });
    assert.throws(() => ts.createProgram(["/a.ts"], { module: "nodenext" }, host), /^Error: module is a string value; tsconfig JSON must be parsed with parseJsonSourceFileConfigFileContent/);
});

test("missing files are the ones TypeScript 6.0 tried: each extension of a reference, and a default lib the host does not have", needsTs6, () => {
    const describe = anyTs => {
        const files = { "/p/main.ts": "/// <reference path=\"./gone\" />\n/// <reference path=\"./here\" />\n/// <reference path=\"other.ts\" />\nlet a: Array<number>;\n", "/p/here.tsx": "export {};\n" };
        const host = memoryHost(anyTs, files, { currentDirectory: "/p", defaultLib: "lib.d.ts", libs: false });
        const program = anyTs.createProgram(["main.ts"], { types: [] }, host);
        return {
            files: program.getSourceFiles().map(file => file.fileName),
            missing: [...program.getMissingFilePaths().keys()].sort(),
            options: messages(anyTs, program.getOptionsDiagnostics()),
            noDefaultLibName: anyTs.createProgram(["/p/main.ts"], { types: [] }, memoryHost(anyTs, files, { defaultLib: "", libs: false })).getSourceFiles().length,
        };
    };
    assert.deepEqual(describe(ts), describe(ts6));
});

test("a copy of a package found again under another path is a redirect to the first, like TypeScript 6.0", needsTs6, () => {
    const describe = anyTs => {
        const packageJson = JSON.stringify({ name: "foo", version: "1.2.3" });
        const host = memoryHost(anyTs, {
            "/a.ts": "import * as bar from \"bar\"; import * as foo from \"foo\";\n",
            "/node_modules/bar/index.d.ts": "import * as foo from \"foo\";\n",
            "/node_modules/bar/node_modules/foo/package.json": packageJson,
            "/node_modules/bar/node_modules/foo/index.d.ts": "export const x: number;\n",
            "/node_modules/foo/package.json": packageJson,
            "/node_modules/foo/index.d.ts": "export const x: number;\n",
        });
        const program = anyTs.createProgram(["/a.ts"], { types: [] }, host);
        const copy = program.getSourceFile("/node_modules/foo/index.d.ts");
        return {
            copy: [copy.fileName, copy.path, copy.redirectInfo?.redirectTarget.fileName, copy.statements.length, program.isSourceFileFromExternalLibrary(copy)],
            targets: [...program.redirectTargetsMap.entries()],
            types: program.getSemanticDiagnostics().length,
        };
    };
    assert.deepEqual(describe(ts), describe(ts6));
});

test("the types of implements and interface extends clauses map to tsc-rs's TypeReference and QualifiedName nodes", () => {
    const host = memoryHost(ts, { "/file.ts": "namespace N { export interface I { a: number } }\ninterface J extends N.I {}\nclass C implements N.I { a = 1; }\n" });
    const program = ts.createProgram({ host, rootNames: ["/file.ts"], options: { types: [] } });
    const checker = program.getTypeChecker();
    const file = program.getSourceFile("/file.ts");
    const [, j, c] = file.statements;
    for (const heritage of [j.heritageClauses[0].types[0], c.heritageClauses[0].types[0]]) {
        const type = checker.getTypeAtLocation(heritage.expression);
        assert.equal(type.symbol?.name, "I");
        assert.equal(type, checker.getTypeAtLocation(heritage.expression.name));
        assert.equal(program.handleToNode(program.nodeToHandle(heritage)), heritage);
        assert.equal(program.handleToNode(program.nodeToHandle(heritage.expression)), heritage.expression);
    }
});

test("a cancelled language service request ends with OperationCanceledException, also where a feature is not supported", () => {
    const files = { "a.ts": "function foo(x: number) { return x; }\nfoo(1);\n" };
    const dir = writeFixture("cancel", files);
    let cancelled = false;
    const host = { ...languageServiceHost(ts, dir, files, { types: [] }).host, getCancellationToken: () => ({ isCancellationRequested: () => cancelled }) };
    const service = ts.createLanguageService(host);
    const file = path.join(dir, "a.ts");
    const position = fs.readFileSync(file, "utf8").lastIndexOf("foo");
    service.getSemanticDiagnostics(file);
    cancelled = true;
    for (const request of [() => service.getQuickInfoAtPosition(file, position), () => service.getSignatureHelpItems(file, position + 4, undefined), () => service.getSemanticDiagnostics(file)]) {
        assert.throws(request, error => error instanceof ts.OperationCanceledException);
    }
    const checker = service.getProgram().getTypeChecker();
    const token = {
        isCancellationRequested: () => true,
        throwIfCancellationRequested() {
            throw new ts.OperationCanceledException();
        },
    };
    assert.throws(() => checker.runWithCancellationToken(token, view => view.getTypeAtLocation(service.getProgram().getSourceFile(file))), error => error instanceof ts.OperationCanceledException);
});

test("a host's resolveModuleNames is not asked for the ambient modules a file declares, like TypeScript 6.0", needsTs6, () => {
    const describe = anyTs => {
        const asked = [];
        const host = memoryHost(anyTs, { "/app.d.ts": "declare module \"fs\" { export interface Stat { id: number } }\ndeclare module \"fs-client\" { import { Stat } from \"fs\"; import { Q } from \"q\"; export function foo(): Stat; }\n" });
        host.resolveModuleNames = names => {
            asked.push(...names);
            return names.map(() => undefined);
        };
        const program = anyTs.createProgram(["/app.d.ts"], { types: [] }, host);
        return { asked, diagnostics: messages(anyTs, program.getSemanticDiagnostics()) };
    };
    assert.deepEqual(describe(ts), describe(ts6));
});

test("a case-insensitive host gets case-insensitive file names on any system, like TypeScript 6.0", needsTs6, () => {
    const describe = anyTs => {
        const host = memoryHost(anyTs, {
            "/Src/Main.ts": "import { B } from \"./other\";\nimport c = require(\"D:/Src/c\");\nexport const a: B = { x: 1 };\n",
            "/Src/Other.ts": "export interface B { x: number }\n",
            "d:/Src/c.ts": "import d = require(\"./Other\");\nexport = 1;\n",
        }, { caseSensitive: false });
        const program = anyTs.createProgram(["/Src/Main.ts", "d:/src/c.ts"], { types: [], module: anyTs.ModuleKind.CommonJS, forceConsistentCasingInFileNames: true }, host);
        const main = program.getSourceFile("/src/main.ts");
        const checker = program.getTypeChecker();
        const type = checker.getTypeAtLocation(main.statements[2].declarationList.declarations[0].name);
        return {
            files: program.getSourceFiles().map(file => file.fileName).filter(name => !name.includes("/lib.")),
            declarations: type.symbol.declarations.map(declaration => declaration.getSourceFile().fileName),
            diagnostics: messages(anyTs, [...program.getOptionsDiagnostics(), ...program.getSemanticDiagnostics()]),
        };
    };
    assert.deepEqual(describe(ts), describe(ts6));
});

test("a host whose current directory is relative gets relative file names and messages, like TypeScript 6.0", needsTs6, () => {
    const describe = anyTs => {
        const host = memoryHost(anyTs, { "moduleA.ts": "import { x } from \"./ModuleB\";\n", "moduleB.ts": "export var x;\n" }, { currentDirectory: "", caseSensitive: false });
        const program = anyTs.createProgram(["moduleA.ts", "moduleB.ts"], { module: anyTs.ModuleKind.CommonJS, forceConsistentCasingInFileNames: true, noImplicitAny: true, types: [] }, host);
        return {
            files: program.getSourceFiles().map(file => file.fileName).filter(name => !name.includes("lib.")),
            diagnostics: messages(anyTs, program.getSemanticDiagnostics()),
            options: messages(anyTs, program.getOptionsDiagnostics()),
        };
    };
    assert.deepEqual(describe(ts), describe(ts6));
});

test("a file first found through a relative reference keeps that relative name, like TypeScript 6.0", needsTs6, () => {
    const describe = anyTs => {
        const host = memoryHost(anyTs, { "/a/b/c.ts": "/// <reference path=\"b.ts\"/>\n", "/a/b/b.ts": "var x;\n" }, { currentDirectory: "/a/b" });
        const program = anyTs.createProgram(["c.ts", "/a/b/b.ts"], { types: [] }, host);
        return program.getSourceFiles().map(file => file.fileName).filter(name => !name.includes("/lib."));
    };
    assert.deepEqual(describe(ts), describe(ts6));
});

test("a program made from an oldProgram with nothing changed answers diagnostics without checking again", () => {
    const dir = writeFixture("same-diagnostics", { "main.ts": "export const main: number = \"1\";\n" });
    const options = { types: [] };
    const { host } = editableHost(ts, dir, options);
    const roots = [path.join(dir, "main.ts")];
    const first = ts.createProgram(roots, options, host);
    assert.deepEqual(first.getSemanticDiagnostics().map(diagnostic => diagnostic.code), [2322]);
    first.getGlobalDiagnostics();
    const second = ts.createProgram(roots, options, host, first);
    const methods = [];
    const request = second.session.request;
    second.session.request = function countingRequest(method, params) {
        methods.push(method);
        return request.call(this, method, params);
    };
    try {
        assert.deepEqual(second.getSemanticDiagnostics().map(diagnostic => [diagnostic.code, diagnostic.file === second.getSourceFile(roots[0])]), [[2322, true]]);
        assert.deepEqual(second.getGlobalDiagnostics(), []);
    }
    finally {
        delete second.session.request;
    }
    assert.deepEqual(methods.filter(method => method.endsWith("Diagnostics")), []);
});

// TS 7 behavior kept: tsc-rs compiles its own bundled lib files; a language service host's own
// lib.d.ts with other text is not compiled (TS 6.0's languageService "detects program upto date"
// tests), and the program lists tsc-rs's lib files.
test("a host's own default lib with other text is not compiled: tsc-rs's lib files are", () => {
    const host = memoryHost(ts, { "/project/root.ts": "let a: Array<number> = [];\n", "/lib/lib.d.ts": "interface Array<T> {}\n" }, { defaultLib: "/lib/lib.d.ts", libs: false });
    const program = ts.createProgram(["/project/root.ts"], { types: [] }, host);
    const names = program.getSourceFiles().map(file => file.fileName);
    assert.ok(names.includes("/lib/lib.es5.d.ts"));
    assert.ok(!names.includes("/lib/lib.d.ts") || program.getSourceFile("/lib/lib.d.ts").text !== "interface Array<T> {}\n");
    assert.deepEqual(program.getSemanticDiagnostics(), []);
});
