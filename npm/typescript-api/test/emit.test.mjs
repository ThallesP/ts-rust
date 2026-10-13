// Tests for src/emit.js, src/transformers.js and src/transpile.js: program.emit with TS 6.0's
// writeFile contract, custom transformers, and transpileModule / transpileDeclaration. Run after
// `node scripts/build.mjs`: `node --test test/emit.test.mjs`.
// Most tests are differential: TypeScript 6.0.3 itself (given `stableTypeOrdering: true`, the
// TS 7 ordering) emits the same fixture and the outputs must agree, except for the TS 7
// differences named in each test. Source maps are compared by what they point at, not byte for
// byte: tsc-rs maps lines slightly differently and leaves out `"sourceRoot":""`.
// The consumer tests (nest-cli's tsconfig-paths hook, @nestjs/swagger, ts-jest) use the installed
// packages in TSRS_CONSUMERS (default /work/scratch/consumers/node_modules) and nest-cli's spec
// fixtures in TSRS_NEST_CLI (default /work/scratch/repos/nest-cli); they skip when missing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

// TEMPORARY: src/index.js installs the hooks only with this set, until root removes the gate.

const require = createRequire(import.meta.url);
const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoDir = path.resolve(packageDir, "../..");
const ts = require(path.join(packageDir, "lib/typescript.js"));
const ts6Main = findTs6Reference();
const ts6 = ts6Main === undefined ? undefined : require(ts6Main);
const ts6Skip = ts6 === undefined ? "no TypeScript 6.0.3 reference (run scripts/build.mjs or set TSRS_TS6)" : false;
const consumers = process.env.TSRS_CONSUMERS ?? "/work/scratch/consumers/node_modules";
const nestCli = process.env.TSRS_NEST_CLI ?? "/work/scratch/repos/nest-cli";
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "tsrs-emit-"));

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

function skipUnless(...paths) {
    if (ts6Skip) {
        return ts6Skip;
    }
    const missing = paths.find(file => !fs.existsSync(file));
    return missing === undefined ? false : `${missing} is missing`;
}

// A busy host can refuse a fork once (ENOMEM, EAGAIN): the run is tried again.
function spawnNode(args, options) {
    const run = () => spawnSync(process.execPath, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...options });
    const child = run();
    return child.error === undefined ? child : run();
}

let fixtureCount = 0;
function writeFixture(files) {
    const dir = path.join(workDir, `fixture${fixtureCount++}`);
    for (const [file, text] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
        fs.writeFileSync(path.join(dir, file), text);
    }
    return dir;
}

// Emits `files` with `api` (this package or TypeScript 6.0.3) and records every writeFile call.
// `emitArgs(api, program, dir)` gives program.emit's arguments after writeFile.
function emitWith(api, dir, rootNames, options, emitArgs = () => []) {
    const compilerOptions = { types: [], ...options(api, dir) };
    if (api === ts6) {
        compilerOptions.stableTypeOrdering = true;
    }
    const program = api.createProgram(rootNames.map(name => path.join(dir, name)), compilerOptions);
    const [target, ...rest] = emitArgs(api, program, dir);
    const writes = [];
    const write = (fileName, text, writeByteOrderMark, onError, sourceFiles, data) => {
        writes.push({
            fileName: path.relative(dir, fileName),
            text,
            writeByteOrderMark,
            sourceFiles: sourceFiles?.map(file => path.relative(dir, file.fileName)),
            data: data === undefined ? undefined : { ...data, diagnostics: data.diagnostics?.map(diagnostic => diagnostic.code) },
        });
    };
    const targetFile = target === undefined ? undefined : program.getSourceFile(path.join(dir, target));
    const result = program.emit(targetFile, write, ...rest);
    return { program, writes, result, dir };
}

function emitBoth(files, options, emitArgs, rootNames = Object.keys(files).filter(file => /\.[cm]?tsx?$/.test(file) && !file.endsWith(".d.ts"))) {
    const reference = emitWith(ts6, writeFixture(files), rootNames, options, emitArgs);
    const native = emitWith(ts, writeFixture(files), rootNames, options, emitArgs);
    return { reference, native };
}

// Output texts that compare across the two compilers: maps and inline maps are left out.
function texts(writes) {
    return Object.fromEntries(writes.filter(write => !write.fileName.endsWith(".map")).map(write => [write.fileName, withoutInlineMap(write.text)]));
}

function withoutInlineMap(text) {
    return text.replace(/\/\/# sourceMappingURL=data:application\/json;base64,[A-Za-z0-9+/=]+$/, "//# sourceMappingURL=<inline>");
}

function calls(writes) {
    return writes.map(({ fileName, writeByteOrderMark, sourceFiles, data }) => ({ fileName, writeByteOrderMark, sourceFiles, data: data === undefined ? undefined : Object.keys(data).filter(key => data[key] !== undefined) }));
}

function resultShape(result, dir) {
    return {
        emitSkipped: result.emitSkipped,
        diagnostics: result.diagnostics.map(diagnostic => diagnostic.code),
        emittedFiles: result.emittedFiles?.map(file => path.relative(dir, file)),
        sourceMaps: result.sourceMaps?.map(map => ({ inputSourceFileNames: map.inputSourceFileNames.map(file => path.relative(dir, file)), file: map.sourceMap.file, sources: map.sourceMap.sources })),
    };
}

// Each mapping must point an identifier of the output at the same identifier of the source.
function assertMapPointsAtSource(api, output, map, source) {
    const json = JSON.parse(map);
    const outputLines = api.computeLineStarts(output);
    const sourceLines = api.computeLineStarts(source);
    const word = (text, position) => (/^[A-Za-z_$][\w$]*/.exec(text.slice(position)) ?? [""])[0];
    let checked = 0;
    for (const mapping of api.decodeMappings(json.mappings)) {
        if (mapping.sourceIndex === undefined) {
            continue;
        }
        const generated = word(output, outputLines[mapping.generatedLine] + mapping.generatedCharacter);
        const original = word(source, sourceLines[mapping.sourceLine] + mapping.sourceCharacter);
        if (generated !== "" && original !== "" && /^(?:other|answer|helper)$/.test(generated)) {
            assert.equal(original, generated, `mapping ${mapping.generatedLine}:${mapping.generatedCharacter}`);
            checked++;
        }
    }
    return checked;
}

const cjs = (api, dir) => ({ outDir: path.join(dir, "out"), module: api.ModuleKind.CommonJS, target: api.ScriptTarget.ES2022 });
const twoFiles = {
    "a.ts": "import { b } from './b';\n/** doc */\nexport const a: number = b;\nexport function f() { return { x: a }; }\n",
    "b.ts": "export const b = 1;\n",
};

// The swagger test runs first: it starts child processes, before this process grows.
const swaggerPlugin = path.join(consumers, "@nestjs/swagger/dist/plugin/compiler-plugin.js");

test("@nestjs/swagger's plugin emits the same files as TypeScript 6.0", { skip: skipUnless(swaggerPlugin, path.join(consumers, "@nestjs/common")) }, () => {
    const app = writeFixture({
        "src/cats/dto/create-cat.dto.ts": "import { Role } from '../entities/role.enum';\n\nexport class CreateCatDto {\n  /**\n   * The name of the cat\n   * @example Kitty\n   */\n  name: string;\n  age?: number;\n  tags: string[];\n  role: Role;\n  breed: string | null;\n  readonly createdAt: Date = new Date();\n}\n",
        "src/cats/entities/role.enum.ts": "export enum Role {\n  Admin = 'admin',\n  User = 'user',\n}\n",
        "src/cats/entities/cat.entity.ts": "export class Cat {\n  name: string;\n  age: number;\n  owners?: Cat[];\n}\n",
        "src/cats/cats.controller.ts": "import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';\nimport { CreateCatDto } from './dto/create-cat.dto';\nimport { Cat } from './entities/cat.entity';\n\n@Controller('cats')\nexport class CatsController {\n  private readonly cats: Cat[] = [];\n\n  /** Create a cat */\n  @Post()\n  @HttpCode(201)\n  async create(@Body() createCatDto: CreateCatDto): Promise<Cat> {\n    const cat = { ...createCatDto, owners: [] } as unknown as Cat;\n    this.cats.push(cat);\n    return cat;\n  }\n\n  @Get(':id')\n  findOne(@Param('id') id: string): Cat {\n    return this.cats[+id];\n  }\n}\n",
    });
    fs.symlinkSync(consumers, path.join(app, "node_modules"));
    // @nestjs/swagger imports `typescript` as an ES module: a resolve hook points it at the
    // TypeScript that the run compares.
    fs.writeFileSync(path.join(app, "loader.mjs"), "export async function resolve(specifier, context, next) {\n    if (specifier === \"typescript\") {\n        return { url: process.env.TS_URL, shortCircuit: true, format: \"commonjs\" };\n    }\n    return next(specifier, context);\n}\n");
    fs.writeFileSync(path.join(app, "register.mjs"), "import { register } from \"node:module\";\nregister(\"./loader.mjs\", import.meta.url);\n");
    fs.writeFileSync(path.join(app, "run.mjs"), `import { createRequire } from "node:module";
import path from "node:path";
const require = createRequire(import.meta.url);
const ts = require(new URL(process.env.TS_URL).pathname);
const plugin = await import(${JSON.stringify(pathToFileURL(swaggerPlugin).href)});
const app = ${JSON.stringify(app)};
const files = ["src/cats/cats.controller.ts", "src/cats/dto/create-cat.dto.ts", "src/cats/entities/cat.entity.ts", "src/cats/entities/role.enum.ts"].map(file => path.join(app, file));
const esm = process.argv[2] === "esm";
const options = { module: esm ? ts.ModuleKind.ESNext : ts.ModuleKind.CommonJS, moduleResolution: esm ? ts.ModuleResolutionKind.Bundler : ts.ModuleResolutionKind.Node10, ignoreDeprecations: "6.0", target: ts.ScriptTarget.ES2021, experimentalDecorators: true, emitDecoratorMetadata: true, declaration: true, outDir: path.join(app, "dist"), rootDir: path.join(app, "src"), strict: false, skipLibCheck: true, stableTypeOrdering: true, types: [] };
const program = ts.createProgram(files, options);
const out = {};
program.emit(undefined, (fileName, text) => out[path.relative(app, fileName)] = text, undefined, undefined, { before: [plugin.before({ introspectComments: true }, program)] });
process.stdout.write(JSON.stringify(out));
`);
    const run = (typescript, format) => {
        const child = spawnNode(["--import", path.join(app, "register.mjs"), path.join(app, "run.mjs"), format], {
            env: { ...process.env, TS_URL: pathToFileURL(typescript).href },
        });
        assert.equal(child.status, 0, child.error?.message ?? child.stderr);
        return JSON.parse(child.stdout);
    };
    for (const format of ["cjs", "esm"]) {
        const reference = run(ts6Main, format);
        const native = run(path.join(packageDir, "lib/typescript.js"), format);
        assert.deepEqual(native, reference, format);
        assert.match(native["dist/cats/dto/create-cat.dto.js"], /_OPENAPI_METADATA_FACTORY/);
    }
});

test("program.emit writes each output in TS 6.0's order with TS 6.0's writeFile arguments", { skip: ts6Skip }, () => {
    const options = (api, dir) => ({ ...cjs(api, dir), declaration: true, declarationMap: true, sourceMap: true, emitBOM: true });
    const { reference, native } = emitBoth(twoFiles, options);
    assert.deepEqual(calls(native.writes), calls(reference.writes));
    assert.deepEqual(texts(native.writes), texts(reference.writes));
    assert.deepEqual(native.writes.map(write => write.data?.sourceMapUrlPos), reference.writes.map(write => write.data?.sourceMapUrlPos));
});

test("program.emit returns emittedFiles and sourceMaps like TS 6.0", { skip: ts6Skip }, () => {
    const options = (api, dir) => ({ ...cjs(api, dir), declaration: true, declarationMap: true, sourceMap: true, listEmittedFiles: true });
    const { reference, native } = emitBoth(twoFiles, options);
    assert.deepEqual(resultShape(native.result, native.dir), resultShape(reference.result, reference.dir));
    assert.equal(native.result.sourceMaps.length, 4);
});

test("program.emit without a writeFile writes through the compiler host", { skip: ts6Skip }, () => {
    const dir = writeFixture(twoFiles);
    const written = [];
    const options = cjs(ts, dir);
    const host = ts.createCompilerHost(options);
    host.writeFile = (fileName, text, writeByteOrderMark, onError, sourceFiles) => written.push([path.relative(dir, fileName), sourceFiles.length]);
    const program = ts.createProgram([path.join(dir, "a.ts")], options, host);
    const result = program.emit();
    assert.equal(result.emitSkipped, false);
    assert.deepEqual(written, [["out/b.js", 1], ["out/a.js", 1]]);
});

test("program.emit of one target file writes only that file's outputs", { skip: ts6Skip }, () => {
    const options = (api, dir) => ({ ...cjs(api, dir), declaration: true, sourceMap: true, listEmittedFiles: true });
    const { reference, native } = emitBoth(twoFiles, options, () => ["b.ts"]);
    assert.deepEqual(calls(native.writes), calls(reference.writes));
    assert.deepEqual(texts(native.writes), texts(reference.writes));
    assert.deepEqual(resultShape(native.result, native.dir), resultShape(reference.result, reference.dir));
});

test("emitOnlyDtsFiles and EmitOnly.Js limit the outputs like TS 6.0", { skip: ts6Skip }, () => {
    const options = (api, dir) => ({ ...cjs(api, dir), declaration: true });
    for (const emitOnly of [true, 0]) {
        for (const target of [undefined, "a.ts"]) {
            const { reference, native } = emitBoth(twoFiles, options, () => [target, undefined, emitOnly]);
            assert.deepEqual(calls(native.writes), calls(reference.writes), `emitOnly ${emitOnly} target ${target}`);
            assert.deepEqual(texts(native.writes), texts(reference.writes));
        }
    }
});

test("emitOnlyDtsFiles and emitDeclarationOnly without declarations skip the emit like TS 6.0", { skip: ts6Skip }, () => {
    const emits = [[cjs, () => [undefined, undefined, true]], [cjs, () => ["a.ts", undefined, true]], [(api, dir) => ({ ...cjs(api, dir), emitDeclarationOnly: true }), () => []]];
    for (const [options, emitArgs] of emits) {
        const { reference, native } = emitBoth(twoFiles, options, emitArgs);
        assert.deepEqual(native.writes, []);
        assert.deepEqual(resultShape(native.result, native.dir), resultShape(reference.result, reference.dir));
        assert.equal(native.result.emitSkipped, true);
    }
});

test("EmitOnly.BuilderSignature prints a declaration without a map and lists the map like TS 6.0", { skip: ts6Skip }, () => {
    const options = (api, dir) => ({ ...cjs(api, dir), declaration: true, declarationMap: true, listEmittedFiles: true });
    const { reference, native } = emitBoth(twoFiles, options, api => ["a.ts", undefined, api.EmitOnly.BuilderSignature, undefined, true]);
    assert.deepEqual(native.writes.map(({ fileName, text, data }) => ({ fileName, text, data })), reference.writes.map(({ fileName, text, data }) => ({ fileName, text, data })));
    assert.deepEqual(resultShape(native.result, native.dir), resultShape(reference.result, reference.dir));
    assert.deepEqual(native.result.emittedFiles.map(file => path.relative(native.dir, file)), ["out/a.d.ts", "out/a.d.ts.map"]);
});

test("forceDtsEmit writes declarations without the declaration option", { skip: ts6Skip }, () => {
    for (const target of [undefined, "b.ts"]) {
        const { reference, native } = emitBoth(twoFiles, cjs, () => [target, undefined, true, undefined, true]);
        assert.deepEqual(calls(native.writes), calls(reference.writes));
        assert.deepEqual(texts(native.writes), texts(reference.writes));
        assert.equal(native.result.emitSkipped, false);
    }
});

test("noEmit skips the emit and writes only the build info of an incremental program", { skip: ts6Skip }, () => {
    const noEmit = (api, dir) => ({ ...cjs(api, dir), noEmit: true });
    const all = emitBoth(twoFiles, noEmit);
    assert.deepEqual(all.native.writes, []);
    assert.equal(all.native.result.emitSkipped, all.reference.result.emitSkipped);
    const one = emitBoth(twoFiles, noEmit, () => ["a.ts"]);
    assert.equal(one.native.result.emitSkipped, true);
    const incremental = (api, dir) => ({ ...noEmit(api, dir), incremental: true, configFilePath: path.join(dir, "tsconfig.json") });
    const { reference, native } = emitBoth(twoFiles, incremental);
    assert.deepEqual(native.writes, reference.writes);
    assert.deepEqual(native.writes.map(write => write.fileName), ["out/tsconfig.tsbuildinfo"]);
});

test("noEmitOnError returns the errors and writes nothing", { skip: ts6Skip }, () => {
    const files = { ...twoFiles, "bad.ts": "export const c: string = 1;\n" };
    const options = (api, dir) => ({ ...cjs(api, dir), noEmitOnError: true });
    const { reference, native } = emitBoth(files, options);
    assert.deepEqual(native.writes, []);
    assert.deepEqual(resultShape(native.result, native.dir), resultShape(reference.result, reference.dir));
    assert.deepEqual(native.result.diagnostics.map(diagnostic => diagnostic.code), [2322]);
    const clean = emitBoth(files, options, () => ["b.ts"]);
    assert.deepEqual(calls(clean.native.writes), calls(clean.reference.writes));
});

test("emitDeclarationOnly writes only declarations", { skip: ts6Skip }, () => {
    const options = (api, dir) => ({ ...cjs(api, dir), declaration: true, emitDeclarationOnly: true });
    for (const target of [undefined, "a.ts"]) {
        const { reference, native } = emitBoth(twoFiles, options, () => [target]);
        assert.deepEqual(calls(native.writes), calls(reference.writes));
        assert.deepEqual(texts(native.writes), texts(reference.writes));
    }
});

test("declaration errors keep the declaration file unwritten unless forceDtsEmit", () => {
    const dir = writeFixture({ "a.ts": "export const x = Math.random();\nexport function h(a: number) { return [a]; }\n" });
    const program = ts.createProgram([path.join(dir, "a.ts")], { ...cjs(ts, dir), declaration: true, isolatedDeclarations: true });
    const source = program.getSourceFile(path.join(dir, "a.ts"));
    for (const target of [undefined, source]) {
        const written = [];
        const result = program.emit(target, fileName => written.push(path.relative(dir, fileName)));
        assert.deepEqual(written, ["out/a.js"]);
        assert.equal(result.emitSkipped, true);
        assert.deepEqual(result.diagnostics.map(diagnostic => diagnostic.code), [9010, 9017]);
    }
    const forced = [];
    program.emit(source, (fileName, text, bom, onError, sourceFiles, data) => forced.push([path.relative(dir, fileName), data.diagnostics.length > 0]), undefined, true, undefined, true);
    assert.deepEqual(forced, [["out/a.d.ts", true]]);
});

test("a failed write becomes a TS5033 diagnostic", () => {
    const dir = writeFixture(twoFiles);
    const program = ts.createProgram([path.join(dir, "b.ts")], cjs(ts, dir));
    const result = program.emit(undefined, (fileName, text, bom, onError) => onError("disk full"));
    assert.deepEqual(result.diagnostics.map(diagnostic => diagnostic.code), [5033]);
    assert.match(ts.flattenDiagnosticMessageText(result.diagnostics[0].messageText, "\n"), /b\.js': disk full/);
});

test("a cancelled token stops the emit with OperationCanceledException", () => {
    const dir = writeFixture(twoFiles);
    const program = ts.createProgram([path.join(dir, "a.ts")], cjs(ts, dir));
    const token = { isCancellationRequested: () => true, throwIfCancellationRequested: () => { throw new ts.OperationCanceledException(); } };
    const written = [];
    assert.throws(() => program.emit(undefined, fileName => written.push(fileName), token), ts.OperationCanceledException);
    assert.deepEqual(written, []);
});

test("relative root file names give relative output names like TS 6.0", { skip: ts6Skip }, () => {
    const dir = writeFixture({ "src/a.ts": "export const a = 1;\n" });
    // The program's current directory is the process's at its first program, so each run is a
    // process of its own started in the fixture.
    const names = typescript => {
        const script = `const ts = require(${JSON.stringify(typescript)});
const written = [];
for (const options of [{ declaration: true, types: [] }, { outDir: "out", types: [] }]) {
    ts.createProgram(["src/a.ts"], options).emit(undefined, fileName => written.push(fileName));
}
process.stdout.write(JSON.stringify(written));`;
        const child = spawnNode(["-e", script], { cwd: dir });
        assert.equal(child.status, 0, child.error?.message ?? child.stderr);
        return JSON.parse(child.stdout);
    };
    const native = names(path.join(packageDir, "lib/typescript.js"));
    assert.deepEqual(native, names(ts6Main));
    assert.deepEqual(native, ["src/a.js", "src/a.d.ts", "out/a.js"]);
});

// Custom transformers. Each one is a function of the `typescript` module it runs with.

const renameValue = api => context => sourceFile => {
    const visit = node => api.isIdentifier(node) && node.text === "oldName" ? context.factory.createIdentifier("value") : api.visitEachChild(node, visit, context);
    return api.visitNode(sourceFile, visit);
};

const appendLog = api => context => sourceFile => context.factory.updateSourceFile(sourceFile, [
    ...sourceFile.statements,
    context.factory.createExpressionStatement(context.factory.createCallExpression(context.factory.createIdentifier("console.log"), undefined, [context.factory.createStringLiteral("added")])),
]);

const transformerSource = `/* Copyright header */

import { b } from './b'; // trailing b
/** Doc for a */
export const a: number = b;
function oldName(x: number) { return x * 2; }
export const c = oldName(3) + oldName(4);
const other = 'other';
export const d = other + other;
// end comment
`;

function transformerFixture(extra = {}) {
    return { "a.ts": transformerSource, "b.ts": "export const b = 1;\n", ...extra };
}

test("a before transformer that returns the same tree leaves the emit untouched", () => {
    const dir = writeFixture(transformerFixture());
    const options = { ...cjs(ts, dir), declaration: true, sourceMap: true, types: [] };
    const program = ts.createProgram([path.join(dir, "a.ts")], options);
    const plain = {};
    program.emit(undefined, (fileName, text) => plain[fileName] = text);
    const visited = {};
    const identity = context => sourceFile => ts.visitEachChild(sourceFile, node => node, context);
    program.emit(undefined, (fileName, text) => visited[fileName] = text, undefined, false, { before: [identity, () => sourceFile => sourceFile], after: [() => sourceFile => sourceFile] });
    assert.deepEqual(visited, plain);
});

test("before transformers that rename and add statements emit like TS 6.0", { skip: ts6Skip }, () => {
    const options = (api, dir) => ({ ...cjs(api, dir), declaration: true, sourceMap: true });
    const { reference, native } = emitBoth(transformerFixture(), options, api => [undefined, undefined, false, { before: [renameValue(api), appendLog(api)] }]);
    assert.deepEqual(texts(native.writes), texts(reference.writes));
    const output = native.writes.find(write => write.fileName === "out/a.js");
    assert.match(output.text, /function value\(x\)/);
    const map = native.writes.find(write => write.fileName === "out/a.js.map");
    assert.ok(assertMapPointsAtSource(ts, output.text, map.text, transformerSource) >= 2);
});

test("a before transformer that keeps the statement list keeps the file header and end comments", { skip: ts6Skip }, () => {
    const options = (api, dir) => cjs(api, dir);
    const { reference, native } = emitBoth(transformerFixture(), options, api => [undefined, undefined, false, { before: [renameValue(api)] }]);
    assert.deepEqual(texts(native.writes), texts(reference.writes));
    assert.match(native.writes.find(write => write.fileName === "out/a.js").text, /\/\/ end comment/);
});

test("a before transformer that adds a decorator gets decorator metadata like TS 6.0", { skip: ts6Skip }, () => {
    const files = { "a.ts": "function Log(): MethodDecorator { return () => {}; }\nexport class Service {\n  /** doc */\n  run(x: number): string { return String(x); }\n  other() {}\n}\n" };
    const options = (api, dir) => ({ ...cjs(api, dir), target: api.ScriptTarget.ES2021, experimentalDecorators: true, emitDecoratorMetadata: true });
    const addDecorator = api => context => sourceFile => {
        const visit = node => {
            if (api.isMethodDeclaration(node) && node.name.getText() === "run") {
                const decorator = context.factory.createDecorator(context.factory.createCallExpression(context.factory.createIdentifier("Log"), undefined, []));
                return context.factory.updateMethodDeclaration(node, [decorator, ...node.modifiers ?? []], node.asteriskToken, node.name, node.questionToken, node.typeParameters, node.parameters, node.type, node.body);
            }
            return api.visitEachChild(node, visit, context);
        };
        return api.visitNode(sourceFile, visit);
    };
    const { reference, native } = emitBoth(files, options, api => [undefined, undefined, false, { before: [addDecorator(api)] }]);
    assert.deepEqual(texts(native.writes), texts(reference.writes));
    assert.match(texts(native.writes)["out/a.js"], /__metadata\("design:returntype", String\)/);
});

test("emit helpers that before transformers request are written after the prologue", { skip: ts6Skip }, () => {
    const files = { "a.ts": "\"use strict\";\nexport class C { m() { return 2; } }\n" };
    const decorate = api => context => sourceFile => {
        const call = context.getEmitHelperFactory().createDecorateHelper([context.factory.createIdentifier("dec")], context.factory.createIdentifier("C"));
        return context.factory.updateSourceFile(sourceFile, [...sourceFile.statements, context.factory.createExpressionStatement(call)]);
    };
    const custom = api => context => sourceFile => {
        context.requestEmitHelper({ name: "test:helper", importName: "__helper", scoped: false, text: "var __helper = function () { return 1; };" });
        return context.factory.updateSourceFile(sourceFile, [...sourceFile.statements, context.factory.createExpressionStatement(context.factory.createCallExpression(context.factory.createIdentifier("__helper"), undefined, []))]);
    };
    for (const transformer of [decorate, custom]) {
        const { reference, native } = emitBoth(files, cjs, api => [undefined, undefined, false, { before: [transformer(api)] }]);
        assert.deepEqual(texts(native.writes), texts(reference.writes));
    }
});

test("substitutions of before transformers apply when the file is printed", { skip: ts6Skip }, () => {
    const files = { "a.ts": "const answer = 1;\nexport function f() { return answer + answer; }\n" };
    const substitute = api => context => {
        const previous = context.onSubstituteNode;
        context.enableSubstitution(api.SyntaxKind.Identifier);
        context.onSubstituteNode = (hint, node) => api.isIdentifier(node) && node.text === "answer" && hint === api.EmitHint.Expression ? context.factory.createNumericLiteral(42) : previous(hint, node);
        return sourceFile => sourceFile;
    };
    const options = (api, dir) => ({ ...cjs(api, dir), module: api.ModuleKind.ESNext });
    const { reference, native } = emitBoth(files, options, api => [undefined, undefined, false, { before: [substitute(api)] }]);
    assert.deepEqual(texts(native.writes), texts(reference.writes));
    assert.match(texts(native.writes)["out/a.js"], /return 42 \+ 42;/);
});

test("synthetic comments and emit flags on original nodes reach the output", { skip: ts6Skip }, () => {
    const files = { "a.ts": "// keep\nexport const a = 1;\n/** doc b */\nexport const b = 2;\nexport const c = 3;\n" };
    const annotate = api => () => sourceFile => {
        api.addSyntheticLeadingComment(sourceFile.statements[2], api.SyntaxKind.MultiLineCommentTrivia, "* added ", true);
        api.setEmitFlags(sourceFile.statements[1], api.EmitFlags.NoComments);
        return sourceFile;
    };
    const options = (api, dir) => ({ ...cjs(api, dir), declaration: true });
    const { reference, native } = emitBoth(files, options, api => [undefined, undefined, false, { before: [annotate(api)] }]);
    assert.deepEqual(texts(native.writes), texts(reference.writes));
});

test("transformers that reorder node arrays in place are seen", { skip: ts6Skip }, () => {
    const files = { "a.ts": "import { x } from './x';\nconsole.log(x);\nfunction g() {\n  const y = 1;\n  hoist(y);\n}\nhoist(2);\n", "x.ts": "export const x = 1;\n" };
    // Like ts-jest's hoist-jest: sorts the statement arrays of the parse tree itself.
    const hoist = api => context => sourceFile => {
        const isHoisted = statement => api.isExpressionStatement(statement) && api.isCallExpression(statement.expression) && api.isIdentifier(statement.expression.expression) && statement.expression.expression.text === "hoist";
        const visit = node => {
            const result = api.visitEachChild(node, visit, context);
            if (api.isBlock(result) || api.isSourceFile(result)) {
                result.statements.sort((left, right) => Number(isHoisted(right)) - Number(isHoisted(left)));
            }
            return result;
        };
        return api.visitNode(sourceFile, visit);
    };
    const { reference, native } = emitBoth(files, cjs, api => [undefined, undefined, false, { before: [hoist(api)] }]);
    assert.deepEqual(texts(native.writes), texts(reference.writes));
    assert.match(texts(native.writes)["out/a.js"], /\nhoist\(2\);\nconst x_1 = require\("\.\/x"\);\n[^]*\{\n {4}hoist\(y\);\n {4}const y = 1;/);
});

test("imports that a before transformer creates are kept even when unused", { skip: ts6Skip }, () => {
    const files = { "a.dto.ts": "export class Dto { name: string = ''; }\n" };
    // Like @nestjs/swagger: `import openapi = require(...)` (CommonJS) or a namespace import (ESM).
    const addImport = api => context => sourceFile => {
        const { factory } = context;
        const esm = context.getCompilerOptions().module === api.ModuleKind.ESNext;
        const declaration = esm
            ? factory.createImportDeclaration(undefined, factory.createImportClause(false, undefined, factory.createNamespaceImport(factory.createIdentifier("openapi"))), factory.createStringLiteral("@nestjs/swagger"), undefined)
            : factory.createImportEqualsDeclaration(undefined, false, factory.createIdentifier("openapi"), factory.createExternalModuleReference(factory.createStringLiteral("@nestjs/swagger")));
        return factory.updateSourceFile(sourceFile, [declaration, ...sourceFile.statements]);
    };
    for (const module of ["CommonJS", "ESNext"]) {
        const options = (api, dir) => ({ ...cjs(api, dir), module: api.ModuleKind[module], sourceMap: true });
        const { reference, native } = emitBoth(files, options, api => [undefined, undefined, false, { before: [addImport(api)] }]);
        assert.deepEqual(texts(native.writes), texts(reference.writes), module);
        assert.match(texts(native.writes)["out/a.dto.js"], /openapi/);
    }
});

test("inline source maps of transformed files keep the original source", () => {
    const dir = writeFixture(transformerFixture());
    const program = ts.createProgram([path.join(dir, "a.ts")], { ...cjs(ts, dir), inlineSourceMap: true, inlineSources: true, types: [] });
    const out = {};
    program.emit(undefined, (fileName, text) => out[path.relative(dir, fileName)] = text, undefined, false, { before: [renameValue(ts)] });
    const text = out["out/a.js"];
    const encoded = /\/\/# sourceMappingURL=data:application\/json;base64,(.*)$/.exec(text)[1];
    const map = Buffer.from(encoded, "base64").toString("utf8");
    assert.deepEqual(JSON.parse(map).sourcesContent, [transformerSource]);
    assert.ok(assertMapPointsAtSource(ts, text, map, transformerSource) >= 2);
});

// The after transformers get the JS text that tsc-rs emitted, parsed again: a transformer that
// makes a new statement list keeps a copyright header where tsc-rs printed it (after the
// prologue), where TS 6.0 moves it to the first statement of the source.
test("after transformers see and change the emitted JavaScript like TS 6.0", { skip: ts6Skip }, () => {
    const banner = api => context => sourceFile => {
        api.addSyntheticLeadingComment(sourceFile.statements[0], api.SyntaxKind.MultiLineCommentTrivia, " banner ", true);
        return context.factory.updateSourceFile(sourceFile, [...sourceFile.statements, context.factory.createExpressionStatement(context.factory.createIdentifier("void 0"))]);
    };
    const options = (api, dir) => ({ ...cjs(api, dir), sourceMap: true });
    const source = transformerSource.replace("/* Copyright header */\n\n", "");
    const { reference, native } = emitBoth(transformerFixture({ "a.ts": source }), options, api => [undefined, undefined, false, { after: [banner(api)] }]);
    assert.deepEqual(texts(native.writes), texts(reference.writes));
    const output = native.writes.find(write => write.fileName === "out/a.js");
    const map = native.writes.find(write => write.fileName === "out/a.js.map");
    assert.ok(assertMapPointsAtSource(ts, output.text, map.text, source) >= 2);
});

test("afterDeclarations transformers rewrite declaration files like TS 6.0", { skip: ts6Skip }, () => {
    const files = { "a.ts": "/// <reference lib=\"es2020\" />\nexport { b } from './b';\nexport function f(oldName: string) { return oldName; }\n", "b.ts": "export const b = 1;\n" };
    const rewrite = api => context => sourceFile => {
        api.addSyntheticLeadingComment(sourceFile.statements[0], api.SyntaxKind.MultiLineCommentTrivia, "* generated ", true);
        const visit = node => {
            if (api.isStringLiteral(node) && node.text === "./b") {
                return context.factory.createStringLiteral("./b.js");
            }
            return api.isIdentifier(node) && node.text === "oldName" ? context.factory.createIdentifier("value") : api.visitEachChild(node, visit, context);
        };
        return api.visitNode(sourceFile, visit);
    };
    const options = (api, dir) => ({ ...cjs(api, dir), declaration: true, declarationMap: true });
    const { reference, native } = emitBoth(files, options, api => [undefined, undefined, false, { afterDeclarations: [rewrite(api)] }]);
    assert.deepEqual(texts(native.writes), texts(reference.writes));
    assert.match(texts(native.writes)["out/a.d.ts"], /from "\.\/b\.js"/);
});

test("transformer objects with transformSourceFile work like factories", { skip: ts6Skip }, () => {
    const asObject = api => context => ({ transformSourceFile: renameValue(api)(context), transformBundle: bundle => bundle });
    const { reference, native } = emitBoth(transformerFixture(), cjs, api => [undefined, undefined, false, { before: [asObject(api)], afterDeclarations: [asObject(api)] }]);
    assert.deepEqual(texts(native.writes), texts(reference.writes));
});

test("custom transformers on an emit of one file work like TS 6.0 (ts-loader)", { skip: ts6Skip }, () => {
    const options = (api, dir) => ({ ...cjs(api, dir), sourceMap: true, declaration: true });
    const { reference, native } = emitBoth(transformerFixture(), options, api => ["a.ts", undefined, false, { before: [renameValue(api)], afterDeclarations: [renameValue(api)] }]);
    assert.deepEqual(calls(native.writes), calls(reference.writes));
    assert.deepEqual(texts(native.writes), texts(reference.writes));
});

// The consumers.

const nestHook = path.join(consumers, "@nestjs/cli/lib/compiler/hooks/tsconfig-paths.hook.js");
const nestFixtures = path.join(nestCli, "test/lib/compiler/hooks/fixtures");

test("nest-cli's tsconfig-paths hook emits the same files as TypeScript 6.0", { skip: skipUnless(nestHook, nestFixtures) }, async () => {
    const { tsconfigPathsBeforeHookFactory } = await import(pathToFileURL(nestHook).href);
    // The hook loads `typescript` from the current directory.
    const cwdFor = (name, target) => {
        const dir = path.join(workDir, name);
        fs.mkdirSync(path.join(dir, "node_modules"), { recursive: true });
        fs.symlinkSync(target, path.join(dir, "node_modules/typescript"));
        return dir;
    };
    const cwds = new Map([[ts6, cwdFor("ts6-cwd", path.resolve(path.dirname(ts6Main), ".."))], [ts, cwdFor("ours-cwd", packageDir)]]);
    const cases = [
        ["decorated-re-export", ["src/main.ts", "src/value.ts"], api => ({ target: api.ScriptTarget.ES2023, experimentalDecorators: true, emitDecoratorMetadata: true, paths: { "~/*": ["./src/*"] } })],
        ["type-imports", ["src/main.ts", "src/type-a.ts", "src/type-b.ts", "src/type-c.ts", "src/type-d.ts"], () => ({})],
        ["unused-imports", ["src/main.ts", "src/foo.ts", "src/bar.ts"], api => ({ module: api.ModuleKind.ESNext })],
        ["aliased-imports", ["src/main.ts", "src/foo.ts", "src/bar.ts"], api => ({ paths: { "~/*": ["./src/*"] }, jsx: api.JsxEmit.Preserve, allowJs: true })],
        ["aliased-imports", ["src/main.ts", "src/foo.ts", "src/bar.ts"], api => ({ module: api.ModuleKind.ESNext, paths: { "~/*": ["./src/*"] }, jsx: api.JsxEmit.Preserve, allowJs: true })],
        ["aliased-dts-imports", ["src/main.ts", "src/foo.ts", "src/bar.ts"], () => ({ declaration: true, paths: { "~/*": ["./src/*"] } })],
        ["esm-imports", ["src/main.ts"], api => ({ module: api.ModuleKind.NodeNext, moduleResolution: api.ModuleResolutionKind.NodeNext, paths: { "~lib": ["./src/lib"] } })],
        ["esm-imports", ["src/uses-mts.mts"], api => ({ module: api.ModuleKind.NodeNext, moduleResolution: api.ModuleResolutionKind.NodeNext, paths: { "~mod": ["./src/mod.mts"] } })],
        ["esm-imports", ["src/uses-others.ts"], api => ({ module: api.ModuleKind.NodeNext, moduleResolution: api.ModuleResolutionKind.NodeNext, allowJs: true, paths: { "~lib/*": ["./src/lib/*"] } })],
    ];
    const previous = process.cwd();
    try {
        for (const [name, rootNames, extra] of cases) {
            const outputs = new Map();
            for (const api of [ts6, ts]) {
                process.chdir(cwds.get(api));
                const baseUrl = path.join(workDir, `nest-${outputs.size}-${name}`);
                fs.cpSync(path.join(nestFixtures, name), baseUrl, { recursive: true });
                const options = { baseUrl, outDir: path.join(baseUrl, "dist"), target: api.ScriptTarget.ESNext, module: api.ModuleKind.CommonJS, stableTypeOrdering: true, types: [], ...extra(api) };
                const program = api.createProgram({ rootNames: rootNames.map(file => path.join(baseUrl, file)), options });
                const hook = tsconfigPathsBeforeHookFactory(options);
                const written = {};
                program.emit(undefined, (fileName, text) => written[path.relative(baseUrl, fileName)] = text, undefined, undefined, { before: [hook], afterDeclarations: options.declaration ? [hook] : [] });
                outputs.set(api, written);
            }
            assert.deepEqual(outputs.get(ts), outputs.get(ts6), name);
            if (extra(ts).paths !== undefined) {
                assert.match(Object.values(outputs.get(ts)).join("\n"), /(?:require\(|from )"\.\/(?:foo|value|lib|mod)/, name);
            }
        }
    }
    finally {
        process.chdir(previous);
    }
});

// transpileModule, transpile and transpileDeclaration.

const decoratedService = "import { Injectable } from '@nestjs/common';\nimport type { Foo } from './foo';\n@Injectable()\nexport class Svc {\n  constructor(private readonly foo: Foo, public n: number) {}\n  @Log() m(@Arg() a: string): Promise<void> { return null!; }\n}\n";

function transpileBoth(input, transpileOptions, declaration = false) {
    const run = api => {
        const output = declaration ? api.transpileDeclaration(input, transpileOptions(api)) : api.transpileModule(input, transpileOptions(api));
        return {
            outputText: output.outputText,
            sourceMapText: output.sourceMapText === undefined ? undefined : JSON.parse(output.sourceMapText).mappings,
            diagnostics: (output.diagnostics ?? []).map(diagnostic => [diagnostic.code, diagnostic.start, diagnostic.length, diagnostic.file?.fileName]),
        };
    };
    return { reference: run(ts6), native: run(ts) };
}

test("transpileModule matches TypeScript 6.0 on typical ts-jest and ts-loader inputs", { skip: ts6Skip }, () => {
    const cases = [
        ["export const a = 1;\nexport default function f() { return a ?? 2; }\n", api => ({ module: api.ModuleKind.CommonJS, target: api.ScriptTarget.ES2021 })],
        ["import fs from 'fs';\nexport const read = (p: string) => fs.readFileSync(p);\n", api => ({ module: api.ModuleKind.ESNext, target: api.ScriptTarget.ESNext })],
        ["export enum E { A, B = 'b' }\n", () => ({ module: "commonjs", target: "es2020" })],
        [decoratedService, api => ({ module: api.ModuleKind.CommonJS, target: api.ScriptTarget.ES2021, experimentalDecorators: true, emitDecoratorMetadata: true })],
        ["function d(v: any, c: any) {}\n@d export class X { @d m() {} }\n", api => ({ module: api.ModuleKind.ESNext, target: api.ScriptTarget.ES2022 })],
        ["export const C = () => <div className=\"x\">{1}</div>;\n", api => ({ jsx: api.JsxEmit.React, module: api.ModuleKind.CommonJS }), "c.tsx"],
        ["export const C = () => <div />;\n", api => ({ jsx: api.JsxEmit.Preserve })],
        ["export const enum CE { A = 1 }\nexport enum E { X = CE.A }\nconst v = CE.A;\n", api => ({ module: api.ModuleKind.CommonJS, isolatedModules: true })],
        ["export namespace N { export const x = 1; }\n", api => ({ module: api.ModuleKind.CommonJS })],
        ["import { T } from './t';\nexport { T };\n", api => ({ module: api.ModuleKind.CommonJS, isolatedModules: true })],
        ["import { a } from './a';\nimport type { B } from './b';\nexport const c: B = a;\n", api => ({ verbatimModuleSyntax: true, module: api.ModuleKind.ESNext })],
        ["import x from 'x';\nimport * as y from 'y';\nconsole.log(x, y);\n", api => ({ module: api.ModuleKind.CommonJS, esModuleInterop: true })],
        ["export class A { x = 1; constructor(public y: number) {} }\n", api => ({ useDefineForClassFields: false, target: api.ScriptTarget.ES2022, module: api.ModuleKind.CommonJS })],
        ["/** doc */\nexport const a = 1; // c\n/*! keep */\n", () => ({ removeComments: true })],
        ["export const a = 1;\nexport const b = 2;\n", api => ({ newLine: api.NewLineKind.CarriageReturnLineFeed, module: api.ModuleKind.CommonJS })],
        ["export const a = 1;\n", api => ({ module: api.ModuleKind.NodeNext }), "x.mts"],
        ["export const a = 1;\n", api => ({ module: api.ModuleKind.NodeNext }), "x.cts"],
        ["export const a: number = 1;\n", api => ({ sourceMap: true, module: api.ModuleKind.CommonJS }), "src/file.ts"],
    ];
    for (const [input, compilerOptions, fileName] of cases) {
        const { reference, native } = transpileBoth(input, api => ({ compilerOptions: compilerOptions(api), fileName, reportDiagnostics: true }));
        assert.deepEqual(native, reference, input);
    }
});

test("transpileModule reports syntax and option diagnostics like TypeScript 6.0", { skip: ts6Skip }, () => {
    const syntax = transpileBoth("const x = ;\nlet z = <any>1;\n", () => ({ reportDiagnostics: true, fileName: "f.ts" }));
    assert.deepEqual(syntax.native.diagnostics, syntax.reference.diagnostics);
    assert.deepEqual(syntax.native.diagnostics.map(diagnostic => diagnostic[0]), [1109]);
    const badOption = transpileBoth("export const a = 1;\n", () => ({ compilerOptions: { module: "nonsense" }, reportDiagnostics: true }));
    assert.deepEqual(badOption.native.diagnostics, badOption.reference.diagnostics);
});

test("transpileModule keeps sourcesContent and inline source maps", { skip: ts6Skip }, () => {
    const input = "export const a: number = 1;\n";
    const inline = transpileBoth(input, api => ({ compilerOptions: { inlineSourceMap: true, inlineSources: true, module: api.ModuleKind.CommonJS }, fileName: "file.ts" }));
    assert.equal(withoutInlineMap(inline.native.outputText), withoutInlineMap(inline.reference.outputText));
    const output = ts.transpileModule(input, { compilerOptions: { sourceMap: true, inlineSources: true }, fileName: "file.ts" });
    assert.deepEqual(JSON.parse(output.sourceMapText).sourcesContent, [input]);
    assert.equal(ts.transpileModule(input, {}).sourceMapText, undefined);
});

test("transpile() returns the output text and fills the diagnostics array", { skip: ts6Skip }, () => {
    const run = api => {
        const diagnostics = [];
        const output = api.transpile("let a: number = ;", { module: api.ModuleKind.CommonJS }, "a.ts", diagnostics);
        return { output, codes: diagnostics.map(diagnostic => diagnostic.code) };
    };
    assert.deepEqual(run(ts), run(ts6));
});

test("transpileDeclaration emits declarations and reports isolatedDeclarations errors", { skip: ts6Skip }, () => {
    const { reference, native } = transpileBoth("export function f(a: number) { return a; }\nexport const x = 1;\nexport class C { p = 'x'; }\n", () => ({ reportDiagnostics: true }), true);
    // TS 7: tsc-rs reports an inferred return type as 9039 at the return expression, where TS 6.0
    // reports 9007 at the function name; the declaration text agrees.
    assert.deepEqual(reference.diagnostics.map(diagnostic => diagnostic[0]), [9007]);
    assert.deepEqual(native.diagnostics.map(diagnostic => diagnostic[0]), [9039]);
    assert.equal(native.outputText, reference.outputText);
    const error = ts.transpileDeclaration("export function f() { return Math.random() ? 1 : 2; }\n", { reportDiagnostics: true });
    assert.ok(error.diagnostics.some(diagnostic => diagnostic.code >= 9000 && diagnostic.code < 10000));
});

test("transpileDeclaration writes the amd-module directive of moduleName", { skip: ts6Skip }, () => {
    const { reference, native } = transpileBoth("export const x = 1;\n", () => ({ moduleName: "mod" }), true);
    assert.equal(native.outputText, reference.outputText);
    assert.match(native.outputText, /^\/\/\/ <amd-module name="mod" \/>\n/);
});

test("transpileModule applies renamedDependencies to CommonJS requires", { skip: ts6Skip }, () => {
    const input = "import { a } from 'old';\nexport { b } from 'old2';\nimport c = require('old3');\nconsole.log(a, c);\n";
    const { reference, native } = transpileBoth(input, api => ({ renamedDependencies: { old: "new", old2: "new2", old3: "new3" }, compilerOptions: { module: api.ModuleKind.CommonJS } }));
    assert.deepEqual(native, reference);
});

test("transpileModule with target ES5 reports the TS 7 removal and emits ES2015 or later", () => {
    // TS 7: target ES5 was removed. TS 6.0 reports 5107 (deprecated) and emits ES5; tsc-rs reports
    // 5108 (removed) and emits ES2015+ syntax.
    const output = ts.transpileModule("export const a = [...[1]];\nclass A {}\n", { compilerOptions: { target: ts.ScriptTarget.ES5, module: ts.ModuleKind.CommonJS }, reportDiagnostics: true });
    assert.deepEqual(output.diagnostics.map(diagnostic => diagnostic.code), [5108]);
    assert.match(output.outputText, /\nclass A \{\n\}/);
});

test("transpileModule runs custom transformers like TypeScript 6.0", { skip: ts6Skip }, () => {
    const banner = api => context => sourceFile => context.factory.updateSourceFile(sourceFile, [context.factory.createExpressionStatement(context.factory.createStringLiteral("banner")), ...sourceFile.statements]);
    const input = "export const oldName = 1;\nconst other = oldName + 1;\n";
    const options = api => ({ compilerOptions: { module: api.ModuleKind.ESNext, sourceMap: true }, fileName: "/p/x.ts", transformers: { before: [renameValue(api)], after: [banner(api)] } });
    const { reference, native } = transpileBoth(input, options);
    assert.equal(native.outputText, reference.outputText);
    const output = ts.transpileModule(input, options(ts));
    assert.ok(assertMapPointsAtSource(ts, output.outputText, output.sourceMapText, input) >= 1);
    const declarations = transpileBoth("export { a } from './x';\nexport const oldName = 1;\n", api => ({ transformers: { afterDeclarations: [renameValue(api)] } }), true);
    assert.equal(declarations.native.outputText, declarations.reference.outputText);
});

const hoistJest = path.join(consumers, "ts-jest/dist/transformers/hoist-jest.js");

test("ts-jest's hoist-jest transformer hoists jest.mock like TypeScript 6.0", { skip: skipUnless(hoistJest) }, () => {
    const hoist = require(hoistJest);
    const logger = { child: () => logger, debug() {}, trace() {}, info() {}, warn() {}, wrap: (_level, _message, run) => run };
    const input = "import { sum } from './sum';\nimport { describe, it, expect, jest } from '@jest/globals';\n// mocks\njest.mock('./sum', () => ({ sum: jest.fn(() => 3) }));\ndescribe('sum', () => {\n  it('adds', () => {\n    expect(sum(1, 2)).toBe(3);\n  });\n});\n";
    for (const module of ["CommonJS", "ESNext"]) {
        const options = api => ({
            fileName: "/p/sum.spec.ts",
            compilerOptions: { module: api.ModuleKind[module], target: api.ScriptTarget.ES2022, sourceMap: true, esModuleInterop: true },
            transformers: { before: [hoist.factory({ configSet: { logger, compilerModule: api } })] },
            reportDiagnostics: true,
        });
        const { reference, native } = transpileBoth(input, options);
        assert.equal(native.outputText, reference.outputText, module);
        assert.deepEqual(native.sourceMapText, reference.sourceMapText, module);
    }
});
