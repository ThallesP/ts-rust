"use strict";

// Custom transformers ({ before, after, afterDeclarations }) on top of tsc-rs emit. They run on
// TS 6.0 trees with TS 6.0's own machinery (transformNodes, the factory, the printer); tsc-rs only
// ever sees text:
// - before: a file whose tree changed is printed back to source text (statements the
//   transformers left alone keep their original text) and tsc-rs emits that text;
// - after and afterDeclarations: each emitted text is parsed by TS 6.0, transformed and, when the
//   tree changed, printed back.
// Source maps are composed, so they still point at the original source.

const sourceMappingUrl = "//# sourceMappingURL=";
const inlineSourceMap = "data:application/json;base64,";
const byteOrderMark = "\uFEFF";
const base64Digits = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const keptStatementMarker = "__tsrs_kept_statement_";

// Runs the custom transformers over the outputs of `files` ({ sourceFile, nativeFileName,
// outputs: [{ fileName, text }] }), replacing outputs in place. `reemit(texts)` emits the JS of
// changed files from their new source texts (Map nativeFileName -> text) and returns
// Map nativeFileName -> outputs.
function transformOutputs(ts, { options, emitHost, files, customTransformers, reemit, cancellationToken }) {
    const before = customTransformers?.before ?? [];
    const after = customTransformers?.after ?? [];
    const afterDeclarations = customTransformers?.afterDeclarations ?? [];
    if (before.length !== 0) {
        transformSources(ts, { options, emitHost, files, factories: before, reemit, cancellationToken });
    }
    if (after.length === 0 && afterDeclarations.length === 0) {
        return;
    }
    for (const file of files) {
        cancellationToken?.throwIfCancellationRequested();
        for (const output of [...file.outputs]) {
            if (after.length !== 0 && isScriptOutput(ts, output.fileName)) {
                const diagnostics = transformEmittedText(ts, { options, emitHost, file, output, factories: after, kind: "script" });
                file.scriptDiagnostics = [...file.scriptDiagnostics ?? [], ...diagnostics];
            }
            else if (afterDeclarations.length !== 0 && isDeclarationOutput(ts, output.fileName)) {
                const diagnostics = transformEmittedText(ts, { options, emitHost, file, output, factories: afterDeclarations, kind: "declaration" });
                file.declarationDiagnostics = [...file.declarationDiagnostics ?? [], ...diagnostics];
            }
        }
    }
}

function transformSources(ts, { options, emitHost, files, factories, reemit, cancellationToken }) {
    const changed = [];
    for (const file of files) {
        // TS 6.0 runs the script transformers on every file it writes JS (or JSON) for.
        if (!file.outputs.some(output => isScriptOutput(ts, output.fileName) || ts.fileExtensionIs(output.fileName, ts.Extension.Json))) {
            continue;
        }
        cancellationToken?.throwIfCancellationRequested();
        const change = transformSource(ts, { options, emitHost, sourceFile: file.sourceFile, factories });
        file.scriptDiagnostics = change.diagnostics;
        if (change.splice !== undefined) {
            changed.push({ file, change });
        }
    }
    if (changed.length === 0) {
        return;
    }
    const outputs = reemit(new Map(changed.map(({ file, change }) => [file.nativeFileName, change.splice.text])));
    for (const { file, change } of changed) {
        const reemitted = outputs.get(file.nativeFileName) ?? [];
        if (!reemitted.some(output => isScriptOutput(ts, output.fileName))) {
            throw new Error(`tsc-rs: internal error: no JavaScript output for the transformed ${file.sourceFile.fileName}`);
        }
        file.outputs = file.outputs.filter(output => !isScriptOutput(ts, output.fileName) && !isScriptMapOutput(ts, output.fileName));
        for (const output of reemitted) {
            if (isScriptMapOutput(ts, output.fileName)) {
                continue;
            }
            const mapOutput = reemitted.find(candidate => candidate.fileName === `${output.fileName}.map`);
            if (change.splice.keepAlive !== undefined) {
                removeKeepAlive(ts, output, mapOutput, change.splice.keepAlive);
            }
            rewriteSourceMap(ts, output, mapOutput, json => composeWithSplice(json, change.splice, file.sourceFile.text));
            file.outputs.push(output);
            if (mapOutput !== undefined) {
                file.outputs.push(mapOutput);
            }
            if (change.helpers.length !== 0) {
                insertHelpers(ts, { options, emitHost, file, output, helpers: change.helpers });
            }
        }
    }
}

// TS 6.0: src/compiler/emitter.ts emitJsFileOrBundle runs `before` ahead of its own transformers;
// here they run alone, and a file whose tree changed becomes new source text for tsc-rs.
function transformSource(ts, { options, emitHost, sourceFile, factories }) {
    const state = { helpers: undefined, printerHooks: false, context: undefined };
    const captureHelpers = context => node => {
        state.helpers = context.readEmitHelpers();
        return node;
    };
    const originalStatements = [...sourceFile.statements];
    const transform = ts.transformNodes(
        unsupportedResolver(),
        emitHost,
        ts.factory,
        options,
        [sourceFile],
        [...factories.map(factory => wrapScriptFactory(ts, factory, state)), captureHelpers],
        /*allowDtsFiles*/ false,
    );
    try {
        const result = transform.transformed[0];
        const helpers = [...state.helpers ?? [], ...unscopedSourceFileHelpers(ts, sourceFile, result)];
        if (result === sourceFile && !state.printerHooks && helpers.length === 0 && annotatedNodes(sourceFile).length === 0 && !mutatedInPlace(ts, sourceFile, originalStatements)) {
            return { diagnostics: transform.diagnostics, helpers };
        }
        if (ts.isJsonSourceFile(sourceFile)) {
            throw new Error(`tsc-rs: a custom 'before' transformer that changes a JSON source file is not supported (${sourceFile.fileName})`);
        }
        const splice = printSpliced(ts, {
            file: sourceFile,
            originalStatements,
            result,
            transform,
            printerOptions: { ...scriptPrinterOptions(ts, options), removeComments: false, noEmitHelpers: true },
            printAll: state.printerHooks || sourceFileHasOwnEmitNode(sourceFile, result),
            keepAlive: true,
        });
        return { diagnostics: transform.diagnostics, helpers: helpers.filter(helper => !helper.scoped), splice };
    }
    finally {
        transform.dispose();
    }
}

// Parses an emitted JS or declaration text, runs `factories` on it, and when the tree changed,
// prints it back into `output` (and its map).
function transformEmittedText(ts, { options, emitHost, file, output, factories, kind }) {
    const hasByteOrderMark = output.text.startsWith(byteOrderMark);
    const { body, url } = splitSourceMappingUrl(hasByteOrderMark ? output.text.slice(1) : output.text);
    const scriptKind = kind === "declaration" ? ts.ScriptKind.TS : ts.fileExtensionIs(output.fileName, ts.Extension.Jsx) ? ts.ScriptKind.JSX : ts.ScriptKind.JS;
    const parsed = ts.createSourceFile(
        file.sourceFile.fileName,
        body,
        {
            languageVersion: ts.getEmitScriptTarget(options),
            impliedNodeFormat: file.sourceFile.impliedNodeFormat,
            setExternalModuleIndicator: ts.getSetExternalModuleIndicator(options),
        },
        /*setParentNodes*/ true,
        scriptKind,
    );
    if (kind === "declaration") {
        // TS 6.0: src/compiler/transformers/declarations.ts transformRoot hands afterDeclarations a declaration file.
        parsed.isDeclarationFile = true;
    }
    const state = { helpers: undefined, printerHooks: false, context: undefined };
    const wrap = kind === "declaration" ? wrapDeclarationFactory : wrapScriptFactory;
    const originalStatements = [...parsed.statements];
    const transform = ts.transformNodes(unsupportedResolver(), emitHost, ts.factory, options, [parsed], factories.map(factory => wrap(ts, factory, state)), /*allowDtsFiles*/ true);
    try {
        const result = transform.transformed[0];
        if (result === parsed && !state.printerHooks && annotatedNodes(parsed).length === 0 && !mutatedInPlace(ts, parsed, originalStatements)) {
            return transform.diagnostics;
        }
        const splice = printSpliced(ts, {
            file: parsed,
            originalStatements,
            result,
            transform,
            printerOptions: kind === "declaration" ? declarationPrinterOptions(options) : scriptPrinterOptions(ts, options),
            printAll: state.printerHooks || sourceFileHasOwnEmitNode(parsed, result),
            extraHeader: kind === "declaration" ? addedReferenceDirectives(ts, parsed, result, ts.getNewLineCharacter(options)) : "",
        });
        replaceOutputText(ts, file, output, splice, { hasByteOrderMark, url });
        return transform.diagnostics;
    }
    finally {
        transform.dispose();
    }
}

// Helpers that `before` transformers requested go into the JS output after its prologue, as
// TS 6.0's printer writes them; helpers tsc-rs already wrote are not repeated.
function insertHelpers(ts, { options, emitHost, file, output, helpers }) {
    const missing = helpers.filter(helper => helper.importName === undefined || !output.text.includes(`var ${helper.importName} = `));
    if (missing.length === 0) {
        return;
    }
    const addHelpers = () => sourceFile => {
        ts.addEmitHelpers(sourceFile, missing);
        return sourceFile;
    };
    transformEmittedText(ts, { options, emitHost, file, output, factories: [addHelpers], kind: "script" });
}

function replaceOutputText(ts, file, output, splice, { hasByteOrderMark, url }) {
    let text = splice.text;
    if (url !== undefined) {
        if (!/[\r\n]$/.test(text)) {
            text += "\n";
        }
        const mapOutput = file.outputs.find(candidate => candidate.fileName === `${output.fileName}.map`);
        const remap = json => ({ ...json, mappings: encodeMappings(splice.remap(decodeMappings(ts, json.mappings))) });
        if (url.startsWith(inlineSourceMap)) {
            text += sourceMappingUrl + toInlineSourceMap(remap(fromInlineSourceMap(url)));
        }
        else {
            if (mapOutput !== undefined) {
                mapOutput.text = JSON.stringify(remap(JSON.parse(mapOutput.text)));
            }
            text += sourceMappingUrl + url;
        }
    }
    output.text = (hasByteOrderMark ? byteOrderMark : "") + text;
}

// Updates the source map of `output` (its own .map output or the inline one) with `update(json)`.
function rewriteSourceMap(ts, output, mapOutput, update) {
    const hasByteOrderMark = output.text.startsWith(byteOrderMark);
    const { body, url } = splitSourceMappingUrl(hasByteOrderMark ? output.text.slice(1) : output.text);
    if (url?.startsWith(inlineSourceMap)) {
        output.text = (hasByteOrderMark ? byteOrderMark : "") + body + sourceMappingUrl + toInlineSourceMap(update(fromInlineSourceMap(url)));
        return;
    }
    if (mapOutput !== undefined) {
        mapOutput.text = JSON.stringify(update(JSON.parse(mapOutput.text)));
    }
}

// The source map of a sourceMappingURL that holds the map itself, or undefined.
function fromInlineSourceMap(url) {
    if (!url.startsWith(inlineSourceMap)) {
        return undefined;
    }
    return JSON.parse(Buffer.from(url.slice(inlineSourceMap.length), "base64").toString("utf8"));
}

// TS 6.0: src/compiler/emitter.ts getSourceMappingURL (base64 of the UTF-8 text)
function toInlineSourceMap(json) {
    return inlineSourceMap + Buffer.from(JSON.stringify(json), "utf8").toString("base64");
}

// The map that tsc-rs made for the printed source, moved onto the original source.
function composeWithSplice(json, splice, originalText) {
    const lines = splice.decode(json.mappings).map(segments => segments?.map(segment => {
        if (segment.length === 1) {
            return segment;
        }
        const original = splice.originalPosition(segment[2], segment[3]);
        return original === undefined ? [segment[0]] : [segment[0], segment[1], original.line, original.character, segment[4]];
    }));
    const composed = { ...json, mappings: encodeMappings(lines) };
    if (Array.isArray(json.sourcesContent)) {
        composed.sourcesContent = json.sourcesContent.map((content, index) => index === 0 ? originalText : content);
    }
    return composed;
}

// TS 6.0: src/compiler/transformer.ts wrapScriptTransformerFactory
function wrapScriptFactory(ts, factory, state) {
    return context => {
        watchContext(context, state);
        const transformer = factory(context);
        if (typeof transformer !== "function") {
            return node => ts.isBundle(node) ? transformer.transformBundle(node) : transformer.transformSourceFile(node);
        }
        return ts.chainBundle(context, transformer);
    };
}

// TS 6.0: src/compiler/transformer.ts wrapDeclarationTransformerFactory
function wrapDeclarationFactory(ts, factory, state) {
    return context => {
        watchContext(context, state);
        const transformer = factory(context);
        if (typeof transformer !== "function") {
            return node => ts.isBundle(node) ? transformer.transformBundle(node) : transformer.transformSourceFile(node);
        }
        return transformer;
    };
}

// Substitutions and emit notifications act when the printer runs, so a file that asks for them
// is printed whole.
function watchContext(context, state) {
    if (state.context === context) {
        return;
    }
    state.context = context;
    const { enableSubstitution, enableEmitNotification } = context;
    context.enableSubstitution = kind => {
        state.printerHooks = true;
        enableSubstitution(kind);
    };
    context.enableEmitNotification = kind => {
        state.printerHooks = true;
        enableEmitNotification(kind);
    };
}

function unsupportedResolver() {
    return new Proxy({}, {
        get(_, name) {
            if (typeof name === "symbol") {
                return undefined;
            }
            return () => {
                throw new Error(`tsc-rs: EmitResolver.${name} is not supported: custom transformers run without the TypeScript 6.0 checker`);
            };
        },
    });
}

// Parse tree nodes that got an emit node (emit flags, synthetic comments, source map ranges,
// helpers): TS 6.0 records them on the source file so it can clean them up after the emit.
function annotatedNodes(sourceFile) {
    return sourceFile.emitNode?.annotatedNodes ?? [];
}

// Emit flags, comments or source map ranges on the source file itself change how all of it
// prints (helpers are handled apart).
function sourceFileHasOwnEmitNode(sourceFile, result) {
    const hasEmitData = emitNode => emitNode !== undefined
        && Object.keys(emitNode).some(key => key !== "annotatedNodes" && key !== "helpers" && emitNode[key] !== undefined);
    return hasEmitData(sourceFile.emitNode) || (result !== sourceFile && hasEmitData(result.emitNode));
}

function unscopedSourceFileHelpers(ts, sourceFile, result) {
    const helpers = new Set([...ts.getEmitHelpers(sourceFile) ?? [], ...ts.getEmitHelpers(result) ?? []]);
    return [...helpers].filter(helper => !helper.scoped);
}

// TS 6.0: src/compiler/emitter.ts:850 emitJsFileOrBundle printerOptions
function scriptPrinterOptions(ts, options) {
    return {
        removeComments: options.removeComments,
        newLine: options.newLine,
        noEmitHelpers: options.noEmitHelpers,
        module: ts.getEmitModuleKind(options),
        moduleResolution: ts.getEmitModuleResolutionKind(options),
        target: ts.getEmitScriptTarget(options),
        sourceMap: options.sourceMap,
        inlineSourceMap: options.inlineSourceMap,
        inlineSources: options.inlineSources,
        extendedDiagnostics: options.extendedDiagnostics,
    };
}

// TS 6.0: src/compiler/emitter.ts:925 emitDeclarationFileOrBundle printerOptions
function declarationPrinterOptions(options) {
    return {
        removeComments: options.removeComments,
        newLine: options.newLine,
        noEmitHelpers: true,
        module: options.module,
        moduleResolution: options.moduleResolution,
        target: options.target,
        sourceMap: options.declarationMap,
        inlineSourceMap: options.inlineSourceMap,
        extendedDiagnostics: options.extendedDiagnostics,
        onlyPrintJsDocStyle: true,
        omitBraceSourceMapPositions: true,
    };
}

// Reference directives an afterDeclarations transformer added with updateSourceFile.
function addedReferenceDirectives(ts, parsed, result, newLine) {
    if (result === parsed) {
        return "";
    }
    const lines = [];
    const add = (kind, before, after) => {
        const known = new Set((before ?? []).map(reference => reference.fileName));
        for (const reference of after ?? []) {
            if (!known.has(reference.fileName)) {
                const preserve = reference.preserve ? `preserve="true" ` : "";
                lines.push(`/// <reference ${kind}="${reference.fileName}" ${preserve}/>`);
            }
        }
    };
    add("path", parsed.referencedFiles, result.referencedFiles);
    add("types", parsed.typeReferenceDirectives, result.typeReferenceDirectives);
    add("lib", parsed.libReferenceDirectives, result.libReferenceDirectives);
    return lines.map(line => line + newLine).join("");
}

// Prints `result`, the transformed `file`, back to text. Top-level statements that are still the
// original nodes (and that no transformer annotated) keep their original text, so only the
// changed statements go through the printer; the file header (shebang, copyright comments,
// reference directives) and the end of the file keep their text too. All changed statements print
// in one pass, as TS 6.0 prints a file, so generated names do not collide.
function printSpliced(ts, { file, originalStatements, result, transform, printerOptions, printAll, extraHeader = "", keepAlive = false }) {
    const text = file.text;
    // TS 6.0: src/compiler/emitter.ts emitBodyWithDetachedComments prints the detached comments and
    // the comments at the end of the file only when the statement list kept its text range; a
    // transformer that builds a new list makes the file header the first statement's comments.
    const statementsKeepRange = !ts.positionIsSynthesized(result.statements.pos);
    const headerEnd = fileHeaderEnd(ts, file, originalStatements, statementsKeepRange);
    const dirty = printAll ? undefined : dirtyStatements(file);
    if (!statementsKeepRange && originalStatements.length !== 0) {
        dirty?.add(originalStatements[0]);
    }
    const originalIndex = new Map(originalStatements.map((statement, index) => [statement, index]));
    const used = new Set();
    const marker = `${keptStatementMarker}${Math.random().toString(36).slice(2)}_`;
    const kept = [];
    const prologueCount = countPrologue(ts, result.statements);
    const statements = result.statements.map((statement, index) => {
        const original = originalIndex.get(statement);
        if (dirty === undefined || original === undefined || index < prologueCount || dirty.has(statement) || used.has(statement) || !isPristine(ts, statement)) {
            return statement;
        }
        used.add(statement);
        kept.push(keptRange(ts, file, statement, original, headerEnd));
        return ts.factory.createExpressionStatement(ts.factory.createIdentifier(`${marker}${kept.length - 1}`));
    });
    const keepAliveMarker = keepAlive ? `${marker}keep_alive` : undefined;
    const keepAliveNames = keepAlive ? statements.flatMap(statement => synthesizedImportNames(ts, statement)) : [];
    if (keepAliveNames.length !== 0) {
        const { factory } = ts;
        const list = factory.createArrayLiteralExpression([factory.createStringLiteral(keepAliveMarker), ...keepAliveNames]);
        statements.push(factory.createExpressionStatement(factory.createVoidExpression(list)));
    }

    const synthetic = ts.factory.updateSourceFile(result, statements);
    synthetic.text = blank(text, 0, headerEnd);
    synthetic.isDeclarationFile = false;
    ts.setEmitFlags(synthetic, ts.EmitFlags.NoLeadingComments | ts.EmitFlags.NoTrailingComments);

    const recorder = createMappingRecorder();
    const printer = ts.createPrinter(printerOptions, {
        onEmitNode: transform.emitNodeWithNotification,
        isEmitNotificationEnabled: transform.isEmitNotificationEnabled,
        substituteNode: transform.substituteNode,
    });
    const writer = ts.createTextWriter(ts.getNewLineCharacter(printerOptions));
    printer.writeFile(synthetic, writer, recorder);
    const printed = writer.getText().replace(/[\r\n]+$/, "");

    const builder = new SpliceBuilder(ts, text, printed, recorder.lines);
    builder.original(0, headerEnd);
    builder.inserted(extraHeader);
    let cursor = 0;
    for (let index = 0; index < kept.length; index++) {
        const name = `${marker}${index};`;
        const at = printed.indexOf(name, cursor);
        if (at < 0) {
            throw new Error("tsc-rs: internal error: a kept statement was not printed");
        }
        builder.printed(cursor, at);
        builder.original(kept[index].start, kept[index].end);
        cursor = at + name.length;
    }
    builder.printed(cursor, printed.length);
    if (statementsKeepRange) {
        builder.original(fileEndStart(ts, file, originalStatements, headerEnd), text.length);
    }
    else {
        builder.inserted(ts.getNewLineCharacter(printerOptions));
    }
    return builder.finish(keepAliveNames.length === 0 ? undefined : keepAliveMarker);
}

// TS 6.0 never elides an import that a transformer created (src/compiler/checker.ts emit resolver
// isReferencedAliasDeclaration answers true for a node with no parse tree node); tsc-rs elides
// unused imports in the text it gets. These are the local names of such imports in a printed
// statement: a statement at the end of the printed text uses them, and its output is removed.
function synthesizedImportNames(ts, statement) {
    const names = [];
    const add = (node, name) => {
        if (name !== undefined && ts.getParseTreeNode(node) === undefined) {
            names.push(name);
        }
    };
    if (ts.isImportEqualsDeclaration(statement)) {
        const exported = statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword);
        if (!statement.isTypeOnly && !exported && ts.isExternalModuleReference(statement.moduleReference)) {
            add(statement, statement.name);
        }
        return names;
    }
    const clause = ts.isImportDeclaration(statement) ? statement.importClause : undefined;
    if (clause === undefined || clause.isTypeOnly) {
        return names;
    }
    add(clause, clause.name);
    const bindings = clause.namedBindings;
    if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
        add(bindings, bindings.name);
    }
    else if (bindings !== undefined) {
        for (const element of bindings.elements) {
            if (!element.isTypeOnly) {
                add(element, element.name);
            }
        }
    }
    return names;
}

// Removes the line of the statement that kept synthesized imports alive (see
// synthesizedImportNames) from tsc-rs's output and its map.
function removeKeepAlive(ts, output, mapOutput, marker) {
    const hasByteOrderMark = output.text.startsWith(byteOrderMark);
    const { body, url } = splitSourceMappingUrl(hasByteOrderMark ? output.text.slice(1) : output.text);
    const at = body.indexOf(`"${marker}"`);
    if (at < 0) {
        return;
    }
    const lineStart = body.lastIndexOf("\n", at) + 1;
    const lineBreak = body.indexOf("\n", at);
    const lineEnd = lineBreak < 0 ? body.length : lineBreak + 1;
    if (!/^\s*void \[$/.test(body.slice(lineStart, at))) {
        throw new Error("tsc-rs: internal error: unexpected output for a kept import");
    }
    const line = body.slice(0, lineStart).split("\n").length - 1;
    const newBody = body.slice(0, lineStart) + body.slice(lineEnd);
    output.text = (hasByteOrderMark ? byteOrderMark : "") + newBody + (url === undefined ? "" : sourceMappingUrl + url);
    rewriteSourceMap(ts, output, mapOutput, json => {
        const lines = decodeMappings(ts, json.mappings);
        lines.splice(line, 1);
        return { ...json, mappings: encodeMappings(lines) };
    });
}

// Some transformers reorder or edit node arrays of the parse tree in place (ts-jest's hoist-jest
// sorts statements); TS 6.0 then prints the edited tree, so such a file counts as changed.
function mutatedInPlace(ts, sourceFile, originalStatements) {
    const statements = sourceFile.statements;
    if (statements.length !== originalStatements.length || statements.some((statement, index) => statement !== originalStatements[index])) {
        return true;
    }
    return !statements.every(statement => isPristine(ts, statement));
}

// A parse tree node whose node arrays still hold parse tree nodes in source order.
function isPristine(ts, node) {
    let pristine = node.pos >= 0;
    const visitNode = child => {
        if (child.pos < 0) {
            pristine = false;
        }
        return pristine ? ts.forEachChild(child, visitNode, visitNodes) : true;
    };
    const visitNodes = nodes => {
        let end = nodes.pos;
        for (const child of nodes) {
            if (child.pos < end || visitNode(child)) {
                pristine = false;
                return true;
            }
            end = child.end;
        }
        return undefined;
    };
    if (pristine) {
        ts.forEachChild(node, visitNode, visitNodes);
    }
    return pristine;
}

function countPrologue(ts, statements) {
    let count = 0;
    while (count < statements.length && ts.isPrologueDirective(statements[count])) {
        count++;
    }
    return count;
}

// Top-level statements under a parse tree node that a transformer annotated.
function dirtyStatements(file) {
    const dirty = new Set();
    for (const node of annotatedNodes(file)) {
        let statement = node;
        while (statement.parent !== undefined && statement.parent !== file) {
            statement = statement.parent;
        }
        if (statement.parent === file) {
            dirty.add(statement);
        }
    }
    return dirty;
}

// The end of the text that stays at the top of the file: the shebang, the detached comments
// (TS 6.0: src/compiler/utilities.ts emitDetachedComments) and reference directives.
function fileHeaderEnd(ts, file, originalStatements, withDetachedComments) {
    const text = file.text;
    const shebang = ts.getShebang(text);
    let end = shebang === undefined ? 0 : shebang.length;
    if (originalStatements.length === 0) {
        return end === 0 ? 0 : skipWhitespace(text, end);
    }
    const comments = ts.getLeadingCommentRanges(text, 0) ?? [];
    const lineStarts = ts.getLineStarts(file);
    const lineOf = position => ts.computeLineOfPosition(lineStarts, position);
    let last;
    for (const comment of comments) {
        if (last !== undefined && lineOf(comment.pos) >= lineOf(last.end) + 2) {
            break;
        }
        last = comment;
    }
    if (withDetachedComments && last !== undefined && lineOf(ts.skipTrivia(text, 0)) >= lineOf(last.end) + 2) {
        end = Math.max(end, last.end);
    }
    for (const comment of comments) {
        if (text.startsWith("///", comment.pos)) {
            end = Math.max(end, comment.end);
        }
    }
    return end === 0 ? 0 : skipWhitespace(text, end);
}

// The original text of a kept statement: its leading comments (not the trailing comments of the
// statement before it, which are on the line where that one ends) through its own trailing
// comments.
function keptRange(ts, file, statement, index, headerEnd) {
    const text = file.text;
    let start = statement.pos;
    if (index === 0) {
        start = Math.max(start, headerEnd);
    }
    else {
        const previousTrailing = ts.getTrailingCommentRanges(text, statement.pos);
        if (previousTrailing !== undefined && previousTrailing.length !== 0) {
            start = previousTrailing.at(-1).end;
        }
    }
    return { start: skipWhitespace(text, start), end: trailingCommentsEnd(ts, text, statement.end) };
}

function fileEndStart(ts, file, originalStatements, headerEnd) {
    const last = originalStatements.at(-1);
    return last === undefined ? headerEnd : trailingCommentsEnd(ts, file.text, last.end);
}

function trailingCommentsEnd(ts, text, position) {
    const trailing = ts.getTrailingCommentRanges(text, position);
    return trailing === undefined || trailing.length === 0 ? position : trailing.at(-1).end;
}

function skipWhitespace(text, position) {
    while (position < text.length && /\s/.test(text[position])) {
        position++;
    }
    return position;
}

// `text` with the characters in [start, end) turned into spaces, line breaks kept, so positions
// and lines stay the same.
function blank(text, start, end) {
    if (end <= start) {
        return text;
    }
    return text.slice(0, start) + text.slice(start, end).replace(/[^\r\n\u2028\u2029]/g, " ") + text.slice(end);
}

// Builds the spliced text out of pieces of the original text and of the printed text, and maps
// positions of the result back.
class SpliceBuilder {
    constructor(ts, originalText, printedText, printedMappings) {
        this.ts = ts;
        this.originalText = originalText;
        this.printedText = printedText;
        this.printedMappings = printedMappings;
        this.text = "";
        this.pieces = [];
    }

    original(start, end) {
        if (end > start) {
            this.pieces.push({ kind: "original", start: this.text.length, length: end - start, source: start });
            this.text += this.originalText.slice(start, end);
        }
    }

    printed(start, end) {
        if (end > start) {
            this.pieces.push({ kind: "printed", start: this.text.length, length: end - start, source: start });
            this.text += this.printedText.slice(start, end);
        }
    }

    inserted(text) {
        this.text += text;
    }

    // `keepAlive` is the marker of the statement that keeps synthesized imports (see
    // synthesizedImportNames), if the text has one.
    finish(keepAlive) {
        return new SplicedText(this.ts, this.text, this.pieces, this.originalText, this.printedText, this.printedMappings, keepAlive);
    }
}

class SplicedText {
    constructor(ts, text, pieces, originalText, printedText, printedMappings, keepAlive) {
        this.ts = ts;
        this.text = text;
        this.pieces = pieces;
        this.keepAlive = keepAlive;
        this.originalText = originalText;
        this.printedText = printedText;
        this.lineStarts = ts.computeLineStarts(text);
        this.originalLineStarts = ts.computeLineStarts(originalText);
        this.printedLineStarts = ts.computeLineStarts(printedText);
        this.printedMappings = printedMappings;
    }

    decode(mappings) {
        return decodeMappings(this.ts, mappings);
    }

    // The index of the last piece that starts at or before `position`.
    pieceIndex(position) {
        let low = 0;
        let high = this.pieces.length - 1;
        let found = -1;
        while (low <= high) {
            const middle = (low + high) >> 1;
            if (this.pieces[middle].start <= position) {
                found = middle;
                low = middle + 1;
            }
            else {
                high = middle - 1;
            }
        }
        return found;
    }

    // The position in the original text of a line and character of this text. A position where a
    // piece ends (the end of a node) maps through that piece when the next one does not map it.
    originalPosition(line, character) {
        if (line >= this.lineStarts.length) {
            return undefined;
        }
        const position = this.lineStarts[line] + character;
        const index = this.pieceIndex(position);
        for (const candidate of [this.pieces[index], this.pieces[index - 1]]) {
            if (candidate === undefined || position > candidate.start + candidate.length) {
                continue;
            }
            const original = this.originalPositionIn(candidate, position);
            if (original !== undefined) {
                return original;
            }
        }
        return undefined;
    }

    originalPositionIn(piece, position) {
        if (piece.kind === "original") {
            return lineAndCharacter(this.ts, this.originalLineStarts, piece.source + position - piece.start);
        }
        // From the printer's last mapping on the line, only through text copied from the original:
        // text the printer made up (synthesized nodes) maps nowhere, as in TS 6.0.
        const printedPosition = piece.source + position - piece.start;
        const printed = lineAndCharacter(this.ts, this.printedLineStarts, printedPosition);
        const segment = findSegment(this.printedMappings, printed.line, printed.character);
        if (segment === undefined) {
            return undefined;
        }
        const distance = printed.character - segment[0];
        const source = this.originalLineStarts[segment[2]] + segment[3];
        if (distance !== 0 && this.printedText.substr(printedPosition - distance, distance) !== this.originalText.substr(source, distance)) {
            return undefined;
        }
        return { line: segment[2], character: segment[3] + distance };
    }

    // `mappings` (decoded, from the original text to some source) moved onto this text.
    remap(mappings) {
        const result = [];
        const add = (position, segment) => {
            const { line, character } = lineAndCharacter(this.ts, this.lineStarts, position);
            (result[line] ??= []).push([character, ...segment.slice(1)]);
        };
        for (const piece of this.pieces) {
            const isOriginal = piece.kind === "original";
            const lineStarts = isOriginal ? this.originalLineStarts : this.printedLineStarts;
            const sourceMappings = isOriginal ? mappings : this.printedMappings;
            const end = piece.source + piece.length;
            const firstLine = this.ts.computeLineOfPosition(lineStarts, piece.source);
            const lastLine = this.ts.computeLineOfPosition(lineStarts, end);
            for (let line = firstLine; line <= lastLine; line++) {
                for (const segment of sourceMappings[line] ?? []) {
                    const position = lineStarts[line] + segment[0];
                    if (position < piece.source || position >= end || segment.length === 1) {
                        continue;
                    }
                    if (isOriginal) {
                        add(piece.start + position - piece.source, segment);
                        continue;
                    }
                    const source = findSegment(mappings, segment[2], segment[3]);
                    if (source !== undefined) {
                        add(piece.start + position - piece.source, source);
                    }
                }
            }
        }
        for (const segments of result) {
            segments?.sort((a, b) => a[0] - b[0]);
        }
        return result;
    }
}

function lineAndCharacter(ts, lineStarts, position) {
    return ts.computeLineAndCharacterOfPosition(lineStarts, position);
}

// The last mapped segment of `line` at or before `character`.
function findSegment(mappings, line, character) {
    const segments = mappings[line];
    if (segments === undefined) {
        return undefined;
    }
    let found;
    for (const segment of segments) {
        if (segment[0] > character) {
            break;
        }
        if (segment.length > 1) {
            found = segment;
        }
    }
    return found;
}

// A source map generator for the printer that keeps the mappings of its own source, by
// generated line: [column, sourceIndex, sourceLine, sourceCharacter].
function createMappingRecorder() {
    const lines = [];
    let sources = 0;
    return {
        lines,
        addSource: () => sources++,
        setSourceContent() {},
        addMapping(generatedLine, generatedCharacter, sourceIndex, sourceLine, sourceCharacter) {
            if (sourceIndex === 0) {
                (lines[generatedLine] ??= []).push([generatedCharacter, 0, sourceLine, sourceCharacter]);
            }
        },
    };
}

function decodeMappings(ts, mappings) {
    const lines = [];
    const decoder = ts.decodeMappings(mappings);
    for (const mapping of decoder) {
        const segment = mapping.sourceIndex === undefined
            ? [mapping.generatedCharacter]
            : [mapping.generatedCharacter, mapping.sourceIndex, mapping.sourceLine, mapping.sourceCharacter, mapping.nameIndex];
        (lines[mapping.generatedLine] ??= []).push(segment);
    }
    if (decoder.error !== undefined) {
        throw new Error(`tsc-rs: cannot read a source map: ${decoder.error}`);
    }
    return lines;
}

function encodeMappings(lines) {
    let text = "";
    let sourceIndex = 0;
    let sourceLine = 0;
    let sourceCharacter = 0;
    let nameIndex = 0;
    for (let line = 0; line < lines.length; line++) {
        if (line > 0) {
            text += ";";
        }
        let column = 0;
        let previous;
        for (const segment of lines[line] ?? []) {
            if (previous !== undefined && sameSegment(previous, segment)) {
                continue;
            }
            if (previous !== undefined) {
                text += ",";
            }
            previous = segment;
            text += vlq(segment[0] - column);
            column = segment[0];
            if (segment.length === 1) {
                continue;
            }
            text += vlq(segment[1] - sourceIndex) + vlq(segment[2] - sourceLine) + vlq(segment[3] - sourceCharacter);
            [sourceIndex, sourceLine, sourceCharacter] = [segment[1], segment[2], segment[3]];
            if (segment[4] !== undefined) {
                text += vlq(segment[4] - nameIndex);
                nameIndex = segment[4];
            }
        }
    }
    return text;
}

function sameSegment(a, b) {
    return a.length === b.length && a.every((value, index) => value === b[index]);
}

function vlq(value) {
    let rest = value < 0 ? (-value << 1) + 1 : value << 1;
    let text = "";
    do {
        let digit = rest & 31;
        rest >>>= 5;
        if (rest > 0) {
            digit |= 32;
        }
        text += base64Digits[digit];
    } while (rest > 0);
    return text;
}

// TS 6.0 ends an output that has a map with "//# sourceMappingURL=<url>" and no line break.
function splitSourceMappingUrl(text) {
    const at = text.lastIndexOf(sourceMappingUrl);
    if (at < 0 || (at > 0 && text[at - 1] !== "\n") || /[\r\n]/.test(text.slice(at))) {
        return { body: text, url: undefined };
    }
    return { body: text.slice(0, at), url: text.slice(at + sourceMappingUrl.length) };
}

function isScriptMapOutput(ts, fileName) {
    return ts.fileExtensionIs(fileName, ".map") && isScriptOutput(ts, fileName.slice(0, -".map".length));
}

function isScriptOutput(ts, fileName) {
    return ts.fileExtensionIsOneOf(fileName, [ts.Extension.Js, ts.Extension.Jsx, ts.Extension.Mjs, ts.Extension.Cjs]);
}

function isDeclarationOutput(ts, fileName) {
    return ts.isDeclarationFileName(fileName);
}

module.exports = {
    transformOutputs,
    splitSourceMappingUrl,
    fromInlineSourceMap,
    isScriptOutput,
    isDeclarationOutput,
};
