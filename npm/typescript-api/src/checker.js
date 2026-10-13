"use strict";

// A TS 6.0 TypeChecker backed by the checker of a tsc-rs program: every member of TS 6.0's public
// TypeChecker (src/compiler/types.ts:5073) plus the internal members that tools and TS 6.0's own
// services object model call. Each member maps to a tsc-rs API request, or is emulated in JS from
// such requests where tsc-rs has no request for it.

const { createObjectModel, decodeSyntheticNode } = require("./objects.js");
const { nodeBuilderFlagsToNative, symbolFlagsToNative, syntaxKindToNative, typeFormatFlagsToNative } = require("./flags.js");

const symbolOwnerSnapshot = 1;

function unsupported(api, reason) {
    return new Error(`tsc-rs: ${api} is not supported: ${reason}`);
}

// TS 6.0: src/compiler/checker.ts:1610 createTypeChecker (the `checker` object)
function createChecker(program) {
    const { ts } = program;
    const { SyntaxKind, TypeFlags, SymbolFlags, NodeBuilderFlags, TypeFormatFlags, SignatureKind, IndexKind, CheckFlags } = ts;
    const checker = {};
    const model = createObjectModel(checker, program);
    model.symbolOfDeclaration = node => getSymbolOfDeclaration(node);
    const memo = new Map();
    let errorType;
    let wellKnown;

    const request = (method, params) => model.request(method, params);
    const typeOf = data => model.type(data);
    const typesOf = list => (list ?? []).map(data => model.type(data));
    const symbolOf = data => model.symbol(data);
    const symbolsOf = list => (list ?? []).map(data => model.symbol(data)).filter(symbol => symbol !== undefined);
    const typeId = type => model.typeId(type);
    const reference = symbol => model.symbolReference(symbol);

    function cached(key, compute) {
        if (memo.has(key)) {
            return memo.get(key);
        }
        const value = compute();
        memo.set(key, value);
        return value;
    }

    function symbolKey(symbol) {
        const ref = reference(symbol);
        return ref.kind === symbolOwnerSnapshot ? `s${ref.id}` : `f${ref.file.nodeId}:${ref.id}`;
    }

    // The tsc-rs handle of a parse tree node of this program (TS 6.0 getParseTreeNode(node, filter)).
    function handleOf(node, filter) {
        if (node === undefined) {
            return undefined;
        }
        const parseNode = ts.getParseTreeNode(node, filter);
        if (parseNode === undefined) {
            return undefined;
        }
        return program.nodeToHandle(parseNode) ?? heritageTypeHandle(parseNode);
    }

    // tsc-rs parses the types of `implements` and interface `extends` clauses as TypeReference
    // nodes where TS 6.0 has ExpressionWithTypeArguments.
    function heritageTypeHandle(node) {
        const sourceFile = ts.isExpressionWithTypeArguments(node) ? ts.getSourceFileOfNode(node) : undefined;
        if (sourceFile === undefined || program.getSourceFile(sourceFile.fileName) !== sourceFile) {
            return undefined;
        }
        const file = program.nativeFile(program.toNativeFileName(sourceFile.fileName));
        const index = file?.indexOf(syntaxKindToNative(SyntaxKind.TypeReference), node.pos, node.end);
        return index === undefined ? undefined : file.handle(index);
    }

    // TS 6.0 errorType: the type of tsc-rs's unknown symbol is its error type.
    function getErrorType() {
        if (errorType === undefined) {
            const symbol = { kind: symbolOwnerSnapshot, snapshot: program.snapshot, project: program.project, id: wellKnownSymbols().unknown };
            errorType = typeOf(request("getTypeOfSymbol", { symbol }));
        }
        return errorType;
    }

    function wellKnownSymbols() {
        wellKnown ??= request("getWellKnownSymbols", {});
        return wellKnown;
    }

    function isWellKnown(symbol, name) {
        const ref = reference(symbol);
        return ref.kind === symbolOwnerSnapshot && ref.id === wellKnownSymbols()[name];
    }

    function intrinsic(method) {
        return cached(method, () => typeOf(request(method, {})));
    }

    // Types and symbols

    function getTypeOfSymbol(symbol) {
        return cached(`typeOfSymbol:${symbolKey(symbol)}`, () => typeOf(request("getTypeOfSymbol", { symbol: reference(symbol) })));
    }

    function getDeclaredTypeOfSymbol(symbol) {
        return cached(`declaredType:${symbolKey(symbol)}`, () => typeOf(request("getDeclaredTypeOfSymbol", { symbol: reference(symbol) })));
    }

    function getTypeOfSymbolAtLocation(symbol, location) {
        const handle = handleOf(location);
        if (handle === undefined) {
            return getErrorType();
        }
        return typeOf(request("getTypeOfSymbolAtLocation", { symbol: reference(symbol), location: handle }));
    }

    function getPropertiesOfType(type) {
        return cached(`properties:${typeId(type)}`, () => symbolsOf(request("getPropertiesOfType", { type: typeId(type) })));
    }

    function getPropertyOfType(type, name) {
        return cached(`property:${typeId(type)}:${name}`, () => symbolOf(request("getPropertyOfType", { type: typeId(type), name: String(name) })));
    }

    function getTypeOfPropertyOfType(type, name) {
        return typeOf(request("getTypeOfPropertyOfType", { type: typeId(type), name: String(name) }));
    }

    function getAugmentedPropertiesOfType(type) {
        return cached(`augmented:${typeId(type)}`, () => symbolsOf(request("getApparentPropertiesOfType", { objectId: typeId(type) })));
    }

    function getSignaturesOfType(type, kind) {
        return cached(`signatures:${typeId(type)}:${kind}`, () => (request("getSignaturesOfType", { type: typeId(type), kind }) ?? []).map(data => model.signature(data)));
    }

    function getIndexInfosOfType(type) {
        return cached(`indexInfos:${typeId(type)}`, () => (request("getIndexInfosOfType", { type: typeId(type) }) ?? []).map(data => model.indexInfo(data)));
    }

    // TS 6.0 getIndexInfoOfType(type, kind === IndexKind.String ? stringType : numberType): the
    // index info whose key type is exactly that type.
    function getIndexInfoOfType(type, kind) {
        const keyType = kind === IndexKind.String ? getStringType() : getNumberType();
        return getIndexInfosOfType(type).find(info => info.keyType === keyType);
    }

    function getIndexTypeOfType(type, kind) {
        return getIndexInfoOfType(type, kind)?.type;
    }

    function getBaseTypes(type) {
        return cached(`baseTypes:${typeId(type)}`, () => typesOf(request("getBaseTypes", { type: typeId(type) })));
    }

    function getTypeArguments(type) {
        return cached(`typeArguments:${typeId(type)}`, () => typesOf(request("getTypeArguments", { type: typeId(type) })));
    }

    function typeRequest(method, type, field = "type") {
        return cached(`${method}:${typeId(type)}`, () => typeOf(request(method, { [field]: typeId(type) })));
    }

    function getApparentType(type) {
        return typeRequest("getApparentType", type, "objectId");
    }

    function getNonNullableType(type) {
        return typeRequest("getNonNullableType", type, "objectId");
    }

    function getBaseConstraintOfType(type) {
        return typeRequest("getBaseConstraintOfType", type);
    }

    function getConstraintOfTypeParameter(type) {
        return typeRequest("getConstraintOfTypeParameter", type, "objectId");
    }

    // TS 6.0: type && type.flags & TypeFlags.TypeParameter ? getDefaultFromTypeParameter(type) : undefined
    function getDefaultFromTypeParameter(type) {
        if (type === undefined || !(type.flags & TypeFlags.TypeParameter)) {
            return undefined;
        }
        return typeRequest("getDefaultFromTypeParameter", type, "objectId");
    }

    function getStringType() {
        return intrinsic("getStringType");
    }

    function getNumberType() {
        return intrinsic("getNumberType");
    }

    function getUnknownType() {
        return intrinsic("getUnknownType");
    }

    // TS 6.0 regularTrueType and regularFalseType are the members of boolean.
    function booleanLiteral(name, fresh) {
        const regular = intrinsic("getBooleanType").types.find(type => type.intrinsicName === name);
        return fresh ? regular.freshType : regular;
    }

    // TS 6.0: src/compiler/checker.ts getNullableType
    function getNullableType(type, flags) {
        const missing = (flags & ~type.flags) & (TypeFlags.Undefined | TypeFlags.Null);
        if (missing === 0) {
            return type;
        }
        throw unsupported("getNullableType", "tsc-rs cannot create a union type");
    }

    // TS 6.0 isNullableType = hasTypeFacts(type, TypeFacts.IsUndefinedOrNull).
    function isNullableType(type) {
        if (type.flags & (TypeFlags.Any | TypeFlags.Unknown | TypeFlags.Nullable | TypeFlags.Void)) {
            return true;
        }
        if (type.flags & TypeFlags.Union) {
            return type.types.some(isNullableType);
        }
        if (type.flags & TypeFlags.Intersection) {
            return type.types.every(isNullableType);
        }
        if (type.flags & TypeFlags.Instantiable) {
            const constraint = getBaseConstraintOfType(type);
            return constraint === undefined || constraint === type || isNullableType(constraint);
        }
        return false;
    }

    // TS 6.0 removeOptionalTypeMarker: tsc-rs exposes no optional marker type, so a type only keeps
    // one when it is a union with an `undefined` member that is not the undefined type.
    function getNonOptionalType(type) {
        if (!(type.flags & TypeFlags.Union)) {
            return type;
        }
        const undefinedType = intrinsic("getUndefinedType");
        if (type.types.some(member => member.flags & TypeFlags.Undefined && member !== undefinedType)) {
            throw unsupported("getNonOptionalType", "tsc-rs cannot create a union type");
        }
        return type;
    }

    function getAwaitedType(type) {
        return typeRequest("getAwaitedType", type);
    }

    function getReturnTypeOfSignature(signature) {
        const id = model.signatureId(signature);
        return cached(`returnType:${id}`, () => typeOf(request("getReturnTypeOfSignature", { objectId: id })));
    }

    function getTypePredicateOfSignature(signature) {
        const id = model.signatureId(signature);
        return cached(`predicate:${id}`, () => {
            const data = request("getTypePredicateOfSignature", { signature: id });
            return data === undefined || data === null ? undefined : model.typePredicate(data);
        });
    }

    function getParameterType(signature, index) {
        return typeOf(request("getParameterType", { signature: model.signatureId(signature), index }));
    }

    // Nodes

    function getTypeAtLocation(node) {
        const handle = handleOf(node);
        if (handle === undefined) {
            return getErrorType();
        }
        return cached(`typeAt:${handle}`, () => {
            const type = typeOf(request("getTypeAtLocation", { location: handle }));
            return type === getErrorType() && isEntityNameInType(node) ? typeOfEntityNameInType(node) : type;
        });
    }

    // TS 6.0 getTypeFromTypeNodeWorker answers the names in a type (`T` of `x: T`) with the
    // declared type of their symbol; tsc-rs answers the error type.
    function isEntityNameInType(nodeIn) {
        const node = ts.getParseTreeNode(nodeIn);
        return (ts.isIdentifier(node) || ts.isQualifiedName(node) || ts.isPropertyAccessExpression(node)) && ts.isPartOfTypeNode(node);
    }

    // TS 6.0: src/compiler/checker.ts:20528 getTypeFromTypeNodeWorker
    function typeOfEntityNameInType(node) {
        const symbol = getSymbolAtLocation(node);
        return symbol === undefined ? getErrorType() : getDeclaredTypeOfSymbol(symbol);
    }

    function getSymbolAtLocation(node) {
        const handle = handleOf(node);
        if (handle === undefined) {
            return undefined;
        }
        return cached(`symbolAt:${handle}`, () => symbolOf(request("getSymbolAtLocation", { location: handle })));
    }

    function getTypeFromTypeNode(node) {
        const handle = handleOf(node, ts.isTypeNode);
        if (handle === undefined) {
            return getErrorType();
        }
        return cached(`typeFromTypeNode:${handle}`, () => typeOf(request("getTypeFromTypeNode", { location: handle })));
    }

    function getSignatureFromDeclaration(declaration) {
        const handle = handleOf(declaration, ts.isFunctionLike);
        if (handle === undefined) {
            return undefined;
        }
        return cached(`signatureOf:${handle}`, () => model.signature(request("getSignatureFromDeclaration", { location: handle })));
    }

    // TS 6.0 getSymbolOfDeclaration: the merged symbol of a declaration.
    function getSymbolOfDeclaration(node) {
        const handle = handleOf(node);
        if (handle === undefined) {
            return undefined;
        }
        return cached(`symbolOf:${handle}`, () => symbolOf(request("getSymbolOfDeclarationForChecker", { location: handle })));
    }

    function getResolvedSignature(node, candidatesOutArray, argumentCount) {
        if (candidatesOutArray !== undefined || argumentCount !== undefined) {
            throw unsupported("getResolvedSignature", "tsc-rs does not send the candidate signatures or take an argument count");
        }
        const handle = handleOf(node);
        if (handle === undefined) {
            return undefined;
        }
        return cached(`resolvedSignature:${handle}`, () => model.signature(request("getResolvedSignature", { location: handle })));
    }

    function getContextualType(node, contextFlags) {
        if (contextFlags !== undefined && contextFlags !== 0) {
            throw unsupported("getContextualType", "tsc-rs does not take context flags");
        }
        const handle = handleOf(node, ts.isExpression);
        if (handle === undefined) {
            return undefined;
        }
        return cached(`contextualType:${handle}`, () => typeOf(request("getContextualType", { location: handle })));
    }

    // Printing

    function nativeTypeFormatFlags(flags) {
        const native = typeFormatFlagsToNative(flags);
        // tsc-rs reads flags 0 as "the default flags"; InElementType is outside its node builder mask.
        return native === 0 ? typeFormatFlagsToNative(TypeFormatFlags.InElementType) : native;
    }

    function typeToString(type, enclosingDeclaration, flags) {
        const params = { type: typeId(type), location: handleOf(enclosingDeclaration) };
        if (flags !== undefined) {
            params.flags = nativeTypeFormatFlags(flags);
        }
        return cached(`typeToString:${params.type}:${params.location}:${params.flags}`, () => request("typeToString", params));
    }

    function decodeOptions(flags) {
        return {
            multilineObjectLiterals: (flags & NodeBuilderFlags.MultilineObjectLiterals) !== 0,
            singleQuote: (flags & NodeBuilderFlags.UseSingleQuotesForStringLiteralType) !== 0,
        };
    }

    function typeToTypeNode(type, enclosingDeclaration, flags = NodeBuilderFlags.None) {
        const bytes = model.requestBinary("typeToTypeNode", { type: typeId(type), location: handleOf(enclosingDeclaration), flags: nodeBuilderFlagsToNative(flags) });
        return decodeSyntheticNode(ts, bytes, decodeOptions(flags));
    }

    function signatureToSignatureDeclaration(signature, kind, enclosingDeclaration, flags = NodeBuilderFlags.None) {
        const nativeKind = syntaxKindToNative(kind);
        if (nativeKind === undefined) {
            throw unsupported("signatureToSignatureDeclaration", `tsc-rs has no SyntaxKind ${SyntaxKind[kind]}`);
        }
        const bytes = model.requestBinary("signatureToSignatureDeclaration", {
            signature: model.signatureId(signature),
            kind: nativeKind,
            location: handleOf(enclosingDeclaration),
            flags: nodeBuilderFlagsToNative(flags),
        });
        return decodeSyntheticNode(ts, bytes, decodeOptions(flags));
    }

    // TS 6.0: src/compiler/checker.ts indexInfoToIndexSignatureDeclarationHelper
    function indexInfoToIndexSignatureDeclaration(indexInfo, enclosingDeclaration, flags = NodeBuilderFlags.None) {
        const name = indexInfo.declaration ? ts.declarationNameToString(indexInfo.declaration.parameters[0].name) : "x";
        const keyTypeNode = typeToTypeNode(indexInfo.keyType, enclosingDeclaration, flags);
        const typeNode = typeToTypeNode(indexInfo.type ?? intrinsic("getAnyType"), enclosingDeclaration, flags);
        if (keyTypeNode === undefined || typeNode === undefined) {
            return undefined;
        }
        const parameter = ts.factory.createParameterDeclaration(undefined, undefined, name, undefined, keyTypeNode, undefined);
        return ts.factory.createIndexSignature(indexInfo.isReadonly ? [ts.factory.createToken(SyntaxKind.ReadonlyKeyword)] : undefined, [parameter], typeNode);
    }

    // TS 6.0: src/compiler/checker.ts signatureToString
    function signatureToString(signature, enclosingDeclaration, flags = TypeFormatFlags.None, kind) {
        let declarationKind;
        if (flags & TypeFormatFlags.WriteArrowStyleSignature) {
            declarationKind = kind === SignatureKind.Construct ? SyntaxKind.ConstructorType : SyntaxKind.FunctionType;
        }
        else {
            declarationKind = kind === SignatureKind.Construct ? SyntaxKind.ConstructSignature : SyntaxKind.CallSignature;
        }
        const nodeFlags = (flags & TypeFormatFlags.NodeBuilderFlagsMask) | NodeBuilderFlags.IgnoreErrors | NodeBuilderFlags.WriteTypeParametersInQualifiedName;
        const node = signatureToSignatureDeclaration(signature, declarationKind, enclosingDeclaration, nodeFlags);
        const parseNode = ts.getParseTreeNode(enclosingDeclaration);
        const sourceFile = parseNode && ts.getSourceFileOfNode(parseNode);
        const printer = ts.createPrinterWithRemoveCommentsOmitTrailingSemicolon();
        return ts.usingSingleLineStringWriter(writer => {
            printer.writeNode(ts.EmitHint.Unspecified, node, sourceFile, ts.getTrailingSemicolonDeferringWriter(writer));
        });
    }

    // TS 6.0: src/compiler/checker.ts typePredicateToString
    function typePredicateToString(predicate, enclosingDeclaration, flags = TypeFormatFlags.UseAliasDefinedOutsideCurrentScope) {
        const { TypePredicateKind } = ts;
        const asserts = predicate.kind === TypePredicateKind.AssertsThis || predicate.kind === TypePredicateKind.AssertsIdentifier;
        const isThis = predicate.kind === TypePredicateKind.This || predicate.kind === TypePredicateKind.AssertsThis;
        const name = isThis ? "this" : predicate.parameterName;
        const type = predicate.type === undefined ? "" : ` is ${typeToString(predicate.type, enclosingDeclaration, flags | TypeFormatFlags.NoTypeReduction)}`;
        return `${asserts ? "asserts " : ""}${name}${type}`;
    }

    // TS 6.0 symbolToString prints the accessible symbol chain (src/compiler/checker.ts
    // getAccessibleSymbolChain). Without an enclosing declaration that is the symbol's own name;
    // with one, a symbol that its name does not reach from there is qualified by its container: a
    // class, interface, enum or namespace, or the alias of its module.
    function symbolToString(symbol, enclosingDeclaration) {
        const name = splitQualifiedName(getFullyQualifiedName(symbol)).at(-1);
        const location = ts.getParseTreeNode(enclosingDeclaration);
        if (location === undefined || symbol.flags & SymbolFlags.TypeParameter || isAccessibleByName(symbol, location)) {
            return name;
        }
        const alias = aliasInScope(symbol, location);
        if (alias !== undefined) {
            return alias.name;
        }
        const container = symbol.parent;
        if (container === undefined) {
            return name;
        }
        if (container.escapedName.startsWith("\"")) {
            const moduleAlias = aliasInScope(container, location);
            return moduleAlias === undefined ? name : qualify(moduleAlias.name, symbol, name);
        }
        if (!(container.flags & (SymbolFlags.Class | SymbolFlags.Interface | SymbolFlags.Enum | SymbolFlags.Module))) {
            return name;
        }
        return qualify(symbolToString(container, location), symbol, name);
    }

    // TS 6.0 forEachSymbolTableInScope visits no enum's members, so enum members stay qualified.
    function isAccessibleByName(symbol, location) {
        const meaning = symbol.flags & (SymbolFlags.Value | SymbolFlags.Type | SymbolFlags.Namespace);
        if (meaning === 0 || symbol.flags & SymbolFlags.EnumMember) {
            return false;
        }
        const resolved = resolveName(symbol.name, location, meaning, false);
        if (resolved === undefined) {
            return false;
        }
        if (resolved === symbol || getExportSymbolOfSymbol(resolved) === symbol || resolved === getExportSymbolOfSymbol(symbol)) {
            return true;
        }
        return (resolved.flags & SymbolFlags.Alias) !== 0 && getAliasedSymbol(resolved) === getMergedSymbol(symbol);
    }

    // The first alias in scope, in source order as TS 6.0 walks a scope's locals, that names the
    // symbol (`import { A as B }`, `import * as m`).
    function aliasInScope(symbol, location) {
        const target = getMergedSymbol(symbol);
        const declaration = symbol.declarations?.[0];
        return aliasesInScope(location).find(([, aliased]) => aliased === target || aliased === symbol || (declaration !== undefined && aliased.declarations?.[0] === declaration))?.[0];
    }

    function aliasesInScope(location) {
        return cached(`aliasesInScope:${handleOf(location)}`, () => getSymbolsInScope(location, SymbolFlags.Alias)
            .filter(alias => alias.flags & SymbolFlags.Alias)
            .sort((left, right) => (left.declarations?.[0]?.pos ?? 0) - (right.declarations?.[0]?.pos ?? 0))
            .map(alias => [alias, getAliasedSymbol(alias)]));
    }

    function qualify(left, symbol, right) {
        if (ts.isIdentifierText(symbol.name, ts.ScriptTarget.ESNext)) {
            return `${left}.${right}`;
        }
        return /^\d+$/.test(symbol.name) ? `${left}[${symbol.name}]` : `${left}[${right.startsWith("\"") ? right : JSON.stringify(symbol.name)}]`;
    }

    function splitQualifiedName(name) {
        const segments = [];
        let start = 0;
        let quoted = false;
        for (let index = 0; index < name.length; index++) {
            const char = name[index];
            if (char === "\"" && name[index - 1] !== "\\") {
                quoted = !quoted;
            }
            else if (char === "." && !quoted) {
                segments.push(name.slice(start, index));
                start = index + 1;
            }
        }
        segments.push(name.slice(start));
        return segments;
    }

    function getFullyQualifiedName(symbol) {
        return cached(`fullName:${symbolKey(symbol)}`, () => request("getFullyQualifiedName", { symbol: reference(symbol) }));
    }

    // TS 6.0 symbolToEntityName: the name tsc-rs's node builder writes for the symbol's type or
    // value, else the qualified name of its containers.
    function symbolToEntityName(symbol, meaning, enclosingDeclaration, flags = NodeBuilderFlags.None) {
        const fromTypeNode = entityNameFromTypeNode(symbol, meaning, enclosingDeclaration, flags);
        if (fromTypeNode !== undefined) {
            return fromTypeNode;
        }
        const segments = symbolToString(symbol, enclosingDeclaration ?? program.getSourceFiles()[0]).split(".");
        return segments.slice(1).reduce((left, right) => ts.factory.createQualifiedName(left, right), ts.factory.createIdentifier(segments[0]));
    }

    function entityNameFromTypeNode(symbol, meaning, enclosingDeclaration, flags) {
        const typeFlags = SymbolFlags.Class | SymbolFlags.Interface | SymbolFlags.Enum | SymbolFlags.TypeAlias | SymbolFlags.TypeParameter;
        if (meaning & SymbolFlags.Type && symbol.flags & typeFlags) {
            const node = typeToTypeNode(getDeclaredTypeOfSymbol(symbol), enclosingDeclaration, flags | NodeBuilderFlags.UseAliasDefinedOutsideCurrentScope);
            return node !== undefined && ts.isTypeReferenceNode(node) ? node.typeName : undefined;
        }
        if (meaning & SymbolFlags.Value && symbol.flags & (SymbolFlags.Function | SymbolFlags.Class | SymbolFlags.Enum | SymbolFlags.ValueModule)) {
            const node = typeToTypeNode(getTypeOfSymbol(symbol), enclosingDeclaration, flags | NodeBuilderFlags.UseTypeOfFunction);
            return node !== undefined && ts.isTypeQueryNode(node) && ts.isEntityName(node.exprName) ? node.exprName : undefined;
        }
        return undefined;
    }

    // TS 6.0 symbolToExpression: the entity name as identifiers and property accesses.
    function symbolToExpression(symbol, meaning, enclosingDeclaration, flags) {
        const toExpression = name => ts.isIdentifier(name) ? name : ts.factory.createPropertyAccessExpression(toExpression(name.left), name.right);
        return toExpression(symbolToEntityName(symbol, meaning, enclosingDeclaration, flags));
    }

    // TS 6.0 typeParameterToDeclaration, from tsc-rs's nodes for the name, constraint and default.
    function typeParameterToDeclaration(parameter, enclosingDeclaration, flags = NodeBuilderFlags.None) {
        const nameNode = typeToTypeNode(parameter, enclosingDeclaration, flags);
        if (nameNode === undefined) {
            return undefined;
        }
        const name = ts.isTypeReferenceNode(nameNode) && ts.isIdentifier(nameNode.typeName) ? nameNode.typeName : ts.factory.createIdentifier(parameter.symbol?.name ?? "T");
        const declaration = parameter.symbol?.declarations?.find(ts.isTypeParameterDeclaration);
        const modifiers = declaration?.modifiers?.map(modifier => ts.factory.createModifier(modifier.kind));
        const constraint = getConstraintOfTypeParameter(parameter);
        const defaultType = getDefaultFromTypeParameter(parameter);
        return ts.factory.createTypeParameterDeclaration(
            modifiers,
            name,
            constraint === undefined ? undefined : typeToTypeNode(constraint, enclosingDeclaration, flags),
            defaultType === undefined ? undefined : typeToTypeNode(defaultType, enclosingDeclaration, flags),
        );
    }

    // TS 6.0: src/compiler/checker.ts typeParametersToTypeParameterDeclarations
    function symbolToTypeParameterDeclarations(symbol, enclosingDeclaration, flags) {
        if (!(symbol.flags & (SymbolFlags.Class | SymbolFlags.Interface | SymbolFlags.TypeAlias))) {
            return undefined;
        }
        const typeParameters = getLocalTypeParametersOfClassOrInterfaceOrTypeAlias(symbol) ?? [];
        return ts.factory.createNodeArray(typeParameters.map(parameter => typeParameterToDeclaration(parameter, enclosingDeclaration, flags)));
    }

    // TS 6.0: src/compiler/checker.ts getLocalTypeParametersOfClassOrInterfaceOrTypeAlias. The
    // declared type of a generic alias carries the alias's type parameters as its arguments.
    function getLocalTypeParametersOfClassOrInterfaceOrTypeAlias(symbol) {
        if (symbol.flags & (SymbolFlags.Class | SymbolFlags.Interface)) {
            return getDeclaredTypeOfSymbol(symbol).localTypeParameters;
        }
        if (symbol.flags & SymbolFlags.TypeAlias) {
            return getDeclaredTypeOfSymbol(symbol).aliasTypeArguments;
        }
        return undefined;
    }

    // TS 6.0 getGlobalPromiseType and getGlobalPromiseLikeType: the declared global generic type.
    function globalType(name) {
        return cached(`global:${name}`, () => {
            const symbol = resolveName(name, undefined, SymbolFlags.Type, false);
            return symbol === undefined ? undefined : getDeclaredTypeOfSymbol(symbol);
        });
    }

    // TS 6.0 symbolToParameterDeclaration: the parameter as tsc-rs's node builder writes it in the
    // signature of its function.
    function symbolToParameterDeclaration(symbol, enclosingDeclaration, flags = NodeBuilderFlags.None) {
        const declaration = symbol.valueDeclaration;
        if (declaration === undefined || !ts.isParameter(declaration) || !ts.isFunctionLike(declaration.parent)) {
            throw unsupported("symbolToParameterDeclaration", "the symbol is not a parameter of a declared function");
        }
        const signature = getSignatureFromDeclaration(declaration.parent);
        const node = signature && signatureToSignatureDeclaration(signature, SyntaxKind.FunctionType, enclosingDeclaration, flags);
        const parameters = declaration.parent.parameters.filter(parameter => !ts.parameterIsThisKeyword(parameter));
        const index = parameters.indexOf(declaration);
        return index < 0 ? undefined : node?.parameters[index];
    }

    // Symbol relations

    function getMergedSymbol(symbol) {
        return cached(`merged:${symbolKey(symbol)}`, () => symbolOf(request("getMergedSymbol", { symbol: reference(symbol) })) ?? symbol);
    }

    function getExportSymbolOfSymbol(symbol) {
        return cached(`exportSymbol:${symbolKey(symbol)}`, () => symbolOf(request("getExportSymbolOfSymbolForChecker", { symbol: reference(symbol) })) ?? symbol);
    }

    // TS 6.0 resolveAlias asserts that the symbol is an alias; tsc-rs would fail the request.
    function assertAlias(symbol) {
        if (!(symbol.flags & SymbolFlags.Alias)) {
            ts.Debug.fail("Should only get Alias here.");
        }
    }

    function getAliasedSymbol(symbol) {
        assertAlias(symbol);
        return cached(`aliased:${symbolKey(symbol)}`, () => symbolOf(request("getAliasedSymbol", { symbol: reference(symbol) })));
    }

    function getImmediateAliasedSymbol(symbol) {
        assertAlias(symbol);
        return cached(`immediateAliased:${symbolKey(symbol)}`, () => symbolOf(request("getImmediateAliasedSymbol", { symbol: reference(symbol) })));
    }

    function getExportsOfModule(moduleSymbol) {
        return cached(`exportsOfModule:${symbolKey(moduleSymbol)}`, () => symbolsOf(request("getExportsOfModule", { symbol: reference(moduleSymbol) })));
    }

    // TS 6.0: src/compiler/checker.ts getRootSymbols. tsc-rs keeps no link from a synthetic union
    // or intersection property to its constituents, so those resolve through their declarations.
    function getRootSymbols(symbol) {
        const roots = immediateRootSymbols(symbol);
        return roots ? roots.flatMap(getRootSymbols) : [symbol];
    }

    function immediateRootSymbols(symbol) {
        if (!(symbol.flags & SymbolFlags.Transient)) {
            return undefined;
        }
        const checkFlags = symbol.links?.checkFlags ?? 0;
        if (checkFlags & CheckFlags.Synthetic) {
            const roots = [];
            for (const declaration of symbol.declarations ?? []) {
                const root = getSymbolOfDeclaration(declaration);
                if (root !== undefined && root !== symbol && !roots.includes(root)) {
                    roots.push(root);
                }
            }
            return roots;
        }
        const target = symbolOf(request("getTargetSymbol", { symbol: reference(symbol) }));
        return target === undefined || target === symbol ? undefined : [target];
    }

    // TS 6.0: src/compiler/checker.ts isImplementationOfOverload and getSignaturesOfSymbol
    function isImplementationOfOverload(node) {
        const declaration = ts.getParseTreeNode(node, ts.isFunctionLike);
        if (declaration === undefined) {
            return undefined;
        }
        if (!ts.nodeIsPresent(declaration.body) || ts.isGetAccessor(declaration) || ts.isSetAccessor(declaration)) {
            return false;
        }
        const declarations = getSymbolOfDeclaration(declaration)?.declarations ?? [];
        const signatureDeclarations = declarations.filter((candidate, index) => {
            if (!ts.isFunctionLike(candidate)) {
                return false;
            }
            const previous = declarations[index - 1];
            return !(index > 0 && candidate.body && candidate.parent === previous.parent && candidate.kind === previous.kind && candidate.pos === previous.end);
        });
        return signatureDeclarations.length > 1 || (signatureDeclarations.length === 1 && signatureDeclarations[0] !== declaration);
    }

    // TS 6.0: src/compiler/checker.ts isOptionalParameter
    function isOptionalParameter(node) {
        const parameter = ts.getParseTreeNode(node, ts.isParameter);
        if (parameter === undefined) {
            return false;
        }
        if (parameter.questionToken !== undefined || ts.isJSDocOptionalParameter(parameter)) {
            return true;
        }
        const parameters = parameter.parent.parameters;
        const index = parameters.indexOf(parameter);
        if (parameter.initializer !== undefined) {
            const signature = getSignatureFromDeclaration(parameter.parent);
            const thisOffset = parameters.length > 0 && ts.parameterIsThisKeyword(parameters[0]) ? 1 : 0;
            return signature !== undefined && index - thisOffset >= signature.minArgumentCount;
        }
        const iife = ts.getImmediatelyInvokedFunctionExpression(parameter.parent);
        if (iife !== undefined) {
            return parameter.type === undefined && parameter.dotDotDotToken === undefined && index >= iife.arguments.length;
        }
        return false;
    }

    // TS 6.0: src/compiler/checker.ts getSymbolsOfParameterPropertyDeclaration
    function getSymbolsOfParameterPropertyDeclaration(parameterIn, parameterName) {
        const parameter = ts.getParseTreeNode(parameterIn, ts.isParameter);
        if (parameter === undefined) {
            return ts.Debug.fail("Cannot get symbols of a synthetic parameter that cannot be resolved to a parse-tree node.");
        }
        ts.Debug.assert(ts.isParameterPropertyDeclaration(parameter, parameter.parent));
        const name = ts.escapeLeadingUnderscores(parameterName);
        const parameterSymbol = resolveName(parameterName, parameter, SymbolFlags.Value, true);
        const propertySymbol = getSymbolOfDeclaration(parameter.parent.parent)?.members?.get(name);
        if (parameterSymbol !== undefined && propertySymbol !== undefined && parameterSymbol.escapedName === name) {
            return [parameterSymbol, propertySymbol];
        }
        return ts.Debug.fail("There should exist two symbols, one as property declaration and one as parameter declaration");
    }

    // TS 6.0: src/compiler/checker.ts getTypeOfAssignmentPattern, for the patterns whose source
    // type tsc-rs can answer: an assignment and a property assignment nested in one.
    function getTypeOfAssignmentPattern(nodeIn) {
        const pattern = ts.getParseTreeNode(nodeIn, ts.isAssignmentPattern);
        if (pattern === undefined) {
            return getErrorType();
        }
        const parent = pattern.parent;
        if (ts.isBinaryExpression(parent)) {
            return getTypeAtLocation(parent.right);
        }
        if (ts.isPropertyAssignment(parent)) {
            const parentType = getTypeOfAssignmentPattern(parent.parent);
            const name = ts.getTextOfPropertyName(parent.name);
            return getTypeOfPropertyOfType(parentType, ts.unescapeLeadingUnderscores(name)) ?? getErrorType();
        }
        throw unsupported("getTypeOfAssignmentPattern", "tsc-rs has no request for the iterated type of a destructuring pattern");
    }

    // TS 6.0: src/compiler/checker.ts getPropertySymbolOfDestructuringAssignment
    function getPropertySymbolOfDestructuringAssignment(locationIn) {
        const location = ts.getParseTreeNode(locationIn, ts.isIdentifier);
        if (location === undefined) {
            return undefined;
        }
        const type = getTypeOfAssignmentPattern(ts.cast(location.parent.parent, ts.isAssignmentPattern));
        return type && getPropertyOfType(type, ts.idText(location));
    }

    // TS 6.0: src/compiler/checker.ts getPrivateIdentifierPropertyOfType: the class around the
    // location that declares the private name, then that member in the type.
    function getPrivateIdentifierPropertyOfType(leftType, name, locationIn) {
        const location = ts.getParseTreeNode(locationIn);
        if (location === undefined) {
            return undefined;
        }
        for (let container = ts.getContainingClass(location); container !== undefined; container = ts.getContainingClass(container)) {
            const member = container.members.find(candidate => candidate.name !== undefined && ts.isPrivateIdentifier(candidate.name) && candidate.name.text === name);
            if (member === undefined) {
                continue;
            }
            const declared = getSymbolOfDeclaration(member);
            return getPropertiesOfType(leftType).find(property => property === declared || property.escapedName === declared?.escapedName);
        }
        return undefined;
    }

    // TS 6.0: src/compiler/checker.ts getIndexInfosOfIndexSymbol: the index infos of the declaring
    // type that come from the index symbol's declarations.
    function getIndexInfosOfIndexSymbol(indexSymbol) {
        const parent = indexSymbol.parent;
        if (parent === undefined) {
            return [];
        }
        const type = parent.flags & (SymbolFlags.Class | SymbolFlags.Interface) ? getDeclaredTypeOfSymbol(parent) : getTypeOfSymbol(parent);
        const declarations = indexSymbol.declarations ?? [];
        return getIndexInfosOfType(type).filter(info => info.declaration !== undefined && declarations.includes(info.declaration));
    }

    // TS 6.0: src/compiler/checker.ts getJsxIntrinsicTagNamesAt, with the global JSX namespace.
    function getJsxIntrinsicTagNamesAt(location) {
        const jsx = resolveName("JSX", location, SymbolFlags.Namespace, false);
        const intrinsics = jsx?.exports?.get("IntrinsicElements");
        return intrinsics === undefined ? [] : getPropertiesOfType(getDeclaredTypeOfSymbol(intrinsics));
    }

    // TS 6.0: src/compiler/checker.ts getAmbientModules: the global `declare module "x"` symbols.
    function getAmbientModules() {
        return cached("ambientModules", () => {
            const files = program.getSourceFiles();
            const location = files.find(file => !ts.isExternalModule(file)) ?? files[0];
            return getSymbolsInScope(location, SymbolFlags.ValueModule).filter(symbol => symbol.escapedName.startsWith("\""));
        });
    }

    function getSymbolsInScope(locationIn, meaning) {
        const handle = handleOf(locationIn);
        if (handle === undefined) {
            return [];
        }
        return symbolsOf(request("getSymbolsInScope", { location: handle, meaning: symbolFlagsToNative(meaning) }));
    }

    function resolveName(name, location, meaning, excludeGlobals) {
        return symbolOf(request("resolveName", {
            name,
            location: handleOf(location),
            meaning: symbolFlagsToNative(meaning),
            excludeGlobals: excludeGlobals === true,
        }));
    }

    // TS 6.0: src/compiler/checker.ts isValidPropertyAccess and isPropertyAccessible: the property
    // exists on the type of the left side and its declared accessibility allows the location.
    function isValidPropertyAccess(nodeIn, propertyName) {
        const node = ts.getParseTreeNode(nodeIn, ts.isPropertyAccessOrQualifiedNameOrImportTypeNode);
        if (node === undefined) {
            return false;
        }
        const left = ts.isPropertyAccessExpression(node) ? node.expression : ts.isQualifiedName(node) ? node.left : node;
        const isSuper = left.kind === SyntaxKind.SuperKeyword;
        const type = ts.isImportTypeNode(node) ? getTypeFromTypeNode(node) : getTypeAtLocation(left);
        if (type.flags & TypeFlags.Any) {
            return true;
        }
        const property = getPropertyOfType(getApparentType(type), propertyName);
        return property !== undefined && isPropertyAccessible(node, isSuper, type, property);
    }

    // TS 6.0: src/compiler/checker.ts checkPropertyAccessibilityAtLocation, for declared members.
    function isPropertyAccessible(location, isSuper, containingType, property) {
        const declaration = property.valueDeclaration;
        if (declaration === undefined) {
            return true;
        }
        if (declaration.name !== undefined && ts.isPrivateIdentifier(declaration.name)) {
            return ts.findAncestor(location, node => node === declaration.parent) !== undefined;
        }
        const modifiers = ts.getCombinedModifierFlags(declaration);
        if (isSuper && modifiers & ts.ModifierFlags.Abstract) {
            return false;
        }
        if (!(modifiers & ts.ModifierFlags.NonPublicAccessibilityModifier)) {
            return true;
        }
        const declaringClass = declaration.parent;
        if (modifiers & ts.ModifierFlags.Private) {
            return ts.findAncestor(location, node => node === declaringClass) !== undefined;
        }
        if (isSuper) {
            return true;
        }
        const declaringSymbol = getSymbolOfDeclaration(declaringClass);
        let enclosingClass;
        for (let container = ts.getContainingClass(location); container !== undefined && enclosingClass === undefined; container = ts.getContainingClass(container)) {
            const classType = getDeclaredTypeOfSymbol(getSymbolOfDeclaration(container));
            if (derivesFrom(classType, declaringSymbol, new Set())) {
                enclosingClass = classType;
            }
        }
        if (enclosingClass === undefined) {
            return false;
        }
        if (modifiers & ts.ModifierFlags.Static) {
            return true;
        }
        let type = containingType;
        if (type.flags & TypeFlags.TypeParameter) {
            type = type.isThisType ? getConstraintOfTypeParameter(type) : getBaseConstraintOfType(type);
        }
        return type !== undefined && derivesFrom(type.target ?? type, enclosingClass.symbol, new Set());
    }

    function derivesFrom(type, symbol, seen) {
        if (type === undefined || seen.has(type)) {
            return false;
        }
        seen.add(type);
        if (type.symbol === symbol) {
            return true;
        }
        if (type.flags & TypeFlags.Intersection) {
            return type.types.some(member => derivesFrom(member, symbol, seen));
        }
        return type.isClassOrInterface() && getBaseTypes(type).some(base => derivesFrom(base.target ?? base, symbol, seen));
    }

    // TS 6.0: src/compiler/checker.ts getTypeArgumentsForResolvedSignature. tsc-rs sends no
    // mapper, so only a signature that is no instantiation has an answer (undefined).
    function getTypeArgumentsForResolvedSignature(signature) {
        if (signature.target === undefined) {
            return undefined;
        }
        throw unsupported("getTypeArgumentsForResolvedSignature", "tsc-rs does not send the type mapper of an instantiated signature");
    }

    function getConstantValue(nodeIn) {
        const handle = handleOf(nodeIn, node => ts.isEnumMember(node) || ts.isAccessExpression(node));
        if (handle === undefined) {
            return undefined;
        }
        const data = request("getConstantValue", { location: handle });
        if (data === undefined || data === null || data.value === null || data.value === undefined) {
            return undefined;
        }
        if (data.isNumber && typeof data.value === "string") {
            return data.value === "NaN" ? NaN : data.value === "-Infinity" ? -Infinity : Infinity;
        }
        return data.value;
    }

    function notSupported(api, reason) {
        return () => {
            throw unsupported(api, reason);
        };
    }

    Object.assign(checker, {
        getNodeCount: () => program.getNodeCount(),
        getIdentifierCount: () => program.getIdentifierCount(),
        getSymbolCount: () => program.getSymbolCount(),
        getTypeCount: () => program.getTypeCount(),
        getInstantiationCount: () => program.getInstantiationCount(),
        getRelationCacheSizes: () => program.getRelationCacheSizes(),
        isUndefinedSymbol: symbol => isWellKnown(symbol, "undefined"),
        isArgumentsSymbol: symbol => isWellKnown(symbol, "arguments"),
        isUnknownSymbol: symbol => isWellKnown(symbol, "unknown"),
        getMergedSymbol,
        getDiagnostics: sourceFile => program.getSemanticDiagnostics(sourceFile),
        getGlobalDiagnostics: () => program.getGlobalDiagnostics(),
        getSuggestionDiagnostics: sourceFile => program.getSuggestionDiagnostics(sourceFile),
        getTypeOfSymbolAtLocation,
        getTypeOfSymbol,
        getSymbolsOfParameterPropertyDeclaration,
        getDeclaredTypeOfSymbol,
        getPropertiesOfType,
        getPropertyOfType,
        getPrivateIdentifierPropertyOfType,
        getTypeOfPropertyOfType,
        getIndexInfoOfType,
        getIndexInfosOfType,
        getIndexInfosOfIndexSymbol,
        getSignaturesOfType,
        getIndexTypeOfType,
        getIndexType: notSupported("getIndexType", "tsc-rs cannot create an index type"),
        getBaseTypes,
        getBaseTypeOfLiteralType: type => typeRequest("getBaseTypeOfLiteralType", type),
        getWidenedType: type => typeRequest("getWidenedType", type),
        getTypeFromTypeNode,
        getParameterType,
        getAwaitedType,
        getReturnTypeOfSignature,
        isNullableType,
        getNullableType,
        getNonNullableType,
        getNonOptionalType,
        getTypeArguments,
        typeToTypeNode,
        indexInfoToIndexSignatureDeclaration,
        signatureToSignatureDeclaration,
        symbolToEntityName,
        symbolToExpression,
        symbolToTypeParameterDeclarations,
        symbolToParameterDeclaration,
        typeParameterToDeclaration,
        getSymbolsInScope,
        getSymbolAtLocation,
        getShorthandAssignmentValueSymbol: nodeIn => {
            const handle = handleOf(nodeIn);
            return handle === undefined ? undefined : symbolOf(request("getShorthandAssignmentValueSymbol", { location: handle }));
        },
        getExportSpecifierLocalTargetSymbol: nodeIn => {
            const handle = handleOf(nodeIn, ts.isExportSpecifier);
            return handle === undefined ? undefined : symbolOf(request("getExportSpecifierLocalTargetSymbol", { location: handle }));
        },
        getExportSymbolOfSymbol,
        getTypeAtLocation,
        getTypeOfAssignmentPattern,
        getPropertySymbolOfDestructuringAssignment,
        signatureToString,
        typeToString,
        symbolToString,
        typePredicateToString,
        getFullyQualifiedName,
        getAugmentedPropertiesOfType,
        getRootSymbols,
        getSymbolOfExpando: notSupported("getSymbolOfExpando", "tsc-rs has no request for expando symbols"),
        getContextualType,
        getContextualTypeForArgumentAtIndex: (nodeIn, argIndex) => {
            const handle = handleOf(nodeIn, ts.isCallLikeExpression);
            return handle === undefined ? undefined : typeOf(request("getContextualTypeForArgument", { location: handle, index: argIndex }));
        },
        isContextSensitive: node => {
            const handle = handleOf(node);
            return handle !== undefined && request("isContextSensitive", { location: handle });
        },
        getResolvedSignature,
        getSignatureFromDeclaration,
        isImplementationOfOverload,
        getConstantValue,
        isValidPropertyAccess,
        getAliasedSymbol,
        getImmediateAliasedSymbol,
        getExportsOfModule,
        getJsxIntrinsicTagNamesAt,
        isOptionalParameter,
        getAmbientModules,
        tryGetMemberInModuleExports: (memberName, moduleSymbol) => symbolOf(request("getMemberInModuleExports", { symbol: reference(moduleSymbol), name: memberName })),
        getApparentType,
        getBaseConstraintOfType,
        getConstraintOfTypeParameter,
        getDefaultFromTypeParameter,
        getAnyType: () => intrinsic("getAnyType"),
        getStringType,
        getStringLiteralType: notSupported("getStringLiteralType", "tsc-rs cannot create literal types on request"),
        getNumberType,
        getNumberLiteralType: notSupported("getNumberLiteralType", "tsc-rs cannot create literal types on request"),
        getBigIntType: () => intrinsic("getBigIntType"),
        getBigIntLiteralType: notSupported("getBigIntLiteralType", "tsc-rs cannot create literal types on request"),
        getBooleanType: () => intrinsic("getBooleanType"),
        getUnknownType,
        getFalseType: fresh => booleanLiteral("false", fresh),
        getTrueType: fresh => booleanLiteral("true", fresh),
        getVoidType: () => intrinsic("getVoidType"),
        getUndefinedType: () => intrinsic("getUndefinedType"),
        getNullType: () => intrinsic("getNullType"),
        getESSymbolType: () => intrinsic("getESSymbolType"),
        getNeverType: () => intrinsic("getNeverType"),
        getNonPrimitiveType: () => intrinsic("getNonPrimitiveType"),
        isTypeAssignableTo: (source, target) => request("isTypeAssignableTo", { source: typeId(source), target: typeId(target) }),
        isArrayType: type => cached(`isArray:${typeId(type)}`, () => request("isArrayType", { type: typeId(type) })),
        isTupleType: type => model.typeData(type).isTupleType === true,
        isArrayLikeType: type => cached(`isArrayLike:${typeId(type)}`, () => request("isArrayLikeType", { type: typeId(type) })),
        resolveName,
        getTypePredicateOfSignature,
        runWithCancellationToken: (token, callback) => callback(checker),
        getTypeArgumentsForResolvedSignature,
        getLocalTypeParametersOfClassOrInterfaceOrTypeAlias,
        typeHasCallOrConstructSignatures: type => getSignaturesOfType(type, SignatureKind.Call).length > 0 || getSignaturesOfType(type, SignatureKind.Construct).length > 0,
        getElementTypeOfArrayType: type => checker.isArrayType(type) ? getTypeArguments(type)[0] : undefined,
        getPromiseType: () => globalType("Promise"),
        getPromiseLikeType: () => globalType("PromiseLike"),
    });
    return checker;
}

module.exports = { createChecker };
