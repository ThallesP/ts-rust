"use strict";

// A TS 6.0 TypeChecker backed by the checker of a tsc-rs program: every member of TS 6.0's public
// TypeChecker (src/compiler/types.ts:5073) plus the internal members that tools and TS 6.0's own
// services object model call. Each member maps to a tsc-rs API request, or is emulated in JS from
// such requests where tsc-rs has no request for it.

const { circularList, createObjectModel, decodeSyntheticNode } = require("./objects.js");
const { nodeBuilderFlagsToNative, symbolFlagsToNative, syntaxKindToNative, typeFormatFlagsToNative } = require("./flags.js");

const symbolOwnerSnapshot = 1;
const stackRoom = new Array(8192).fill(0);

function unsupported(api, reason) {
    return new Error(`tsc-rs: ${api} is not supported: ${reason}`);
}

// TS 6.0 leaves a resolution that a stack overflow interrupts on its resolution stack
// (pushTypeResolution), or with the empty members it set first (resolveAnonymousTypeMembers), and
// answers it as a circularity from then on: errorType, no members. A consumer's unbounded walk
// relies on that to end (typescript-eslint no-unnecessary-type-assertion typeContains, issue
// 12705). Taking a tsc-rs answer in needs JS stack, and V8 compiles a function lazily only with
// 40 KB left, so a resolution asked with less than 64 KB of stack left answers that circularity at
// once instead of overflowing in the middle of a request.
function hasStackRoom() {
    try {
        Reflect.apply(Math.max, undefined, stackRoom);
        return true;
    }
    catch {
        return false;
    }
}

// TS 6.0: src/compiler/checker.ts:1610 createTypeChecker (the `checker` object)
function createChecker(program) {
    const { ts } = program;
    const { SyntaxKind, TypeFlags, SymbolFlags, NodeBuilderFlags, TypeFormatFlags, SignatureKind, IndexKind, CheckFlags } = ts;
    const checker = {};
    const model = createObjectModel(checker, program);
    model.symbolOfDeclaration = node => getSymbolOfDeclaration(node);
    model.interruptible = (compute, interrupted) => (interrupted === undefined || hasStackRoom() ? undefined : circularAnswer(interrupted)) ?? compute();
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

    // `interrupted` ("type" or "list") marks a resolution TS 6.0 guards with its resolution stack
    // (pushTypeResolution) or empty members (resolveAnonymousTypeMembers); see hasStackRoom.
    function cached(key, compute, interrupted) {
        if (memo.has(key)) {
            return memo.get(key);
        }
        const circular = interrupted === undefined || hasStackRoom() ? undefined : circularAnswer(interrupted);
        if (circular !== undefined) {
            return circular;
        }
        const value = compute();
        memo.set(key, value);
        return value;
    }

    // The error type takes two requests the first time; with 64 KB of stack left they still fit.
    function circularAnswer(interrupted) {
        if (interrupted === "list") {
            return circularList;
        }
        try {
            return getErrorType();
        }
        catch {
            return undefined;
        }
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
        return program.nodeToHandle(parseNode);
    }

    // TS 6.0 errorType: the type of tsc-rs's unknown symbol is its error type.
    function getErrorType() {
        if (errorType === undefined) {
            const symbol = { kind: symbolOwnerSnapshot, snapshot: program.snapshot, project: program.project, id: wellKnownSymbols().unknown };
            errorType = typeOf(request("getTypeOfSymbol", { symbol }));
        }
        return errorType;
    }

    // tsc-rs's errorType (intrinsic "error"), told apart from the error types of alias references
    // without asking for it.
    function isErrorType(type) {
        if (errorType !== undefined) {
            return type === errorType;
        }
        if (type.intrinsicName !== "error" || model.typeData(type).aliasSymbol !== undefined) {
            return false;
        }
        errorType = type;
        return true;
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
        return cached(`typeOfSymbol:${symbolKey(symbol)}`, () => typeOf(request("getTypeOfSymbol", { symbol: reference(symbol) })), "type");
    }

    function getDeclaredTypeOfSymbol(symbol) {
        return cached(`declaredType:${symbolKey(symbol)}`, () => typeOf(request("getDeclaredTypeOfSymbol", { symbol: reference(symbol) })));
    }

    // TS 6.0 getTypeOfSymbolAtLocation answers a location that is no reference to the symbol (a
    // keyword of its declaration, which tsc-rs's syntax tree does not keep) with its declared type.
    function getTypeOfSymbolAtLocation(symbol, location) {
        const handle = handleOf(location);
        if (handle === undefined) {
            const token = ts.getParseTreeNode(location);
            if (token === undefined || !ts.isTokenKind(token.kind) || ts.isIdentifier(token) || ts.isPrivateIdentifier(token) || program.nodeToHandle(token.parent) === undefined) {
                return getErrorType();
            }
            return cached(`nonMissingType:${symbolKey(symbol)}`, () => typeOf(request("getNonMissingTypeOfSymbol", { symbol: reference(symbol) })));
        }
        return cached(`typeOfSymbolAt:${symbolKey(symbol)}:${handle}`, () => typeOf(request("getTypeOfSymbolAtLocation", { symbol: reference(symbol), location: handle })));
    }

    function getPropertiesOfType(type) {
        return cached(`properties:${typeId(type)}`, () => symbolsOf(request("getPropertiesOfType", { type: typeId(type) })));
    }

    function getPropertyOfType(type, name) {
        return cached(`property:${typeId(type)}:${name}`, () => symbolOf(request("getPropertyOfType", { type: typeId(type), name: String(name) })));
    }

    function getTypeOfPropertyOfType(type, name) {
        return cached(`typeOfProperty:${typeId(type)}:${name}`, () => typeOf(request("getTypeOfPropertyOfType", { type: typeId(type), name: String(name) })));
    }

    function getAugmentedPropertiesOfType(type) {
        return cached(`augmented:${typeId(type)}`, () => symbolsOf(request("getApparentPropertiesOfType", { objectId: typeId(type) })));
    }

    function getSignaturesOfType(type, kind) {
        return cached(`signatures:${typeId(type)}:${kind}`, () => (request("getSignaturesOfType", { type: typeId(type), kind }) ?? []).map(data => model.signature(data)), "list");
    }

    function getIndexInfosOfType(type) {
        return cached(`indexInfos:${typeId(type)}`, () => (request("getIndexInfosOfType", { type: typeId(type) }) ?? []).map(data => model.indexInfo(data)));
    }

    // TS 6.0 getIndexInfoOfType(type, kind === IndexKind.String ? stringType : numberType): the
    // index info whose key type is exactly that type, the one intrinsic type with only that flag.
    function getIndexInfoOfType(type, kind) {
        const keyFlags = kind === IndexKind.String ? TypeFlags.String : TypeFlags.Number;
        const keyName = kind === IndexKind.String ? "string" : "number";
        return getIndexInfosOfType(type).find(info => info.keyType.flags === keyFlags && info.keyType.intrinsicName === keyName);
    }

    function getIndexTypeOfType(type, kind) {
        return getIndexInfoOfType(type, kind)?.type;
    }

    function getBaseTypes(type) {
        return cached(`baseTypes:${typeId(type)}`, () => typesOf(request("getBaseTypes", { type: typeId(type) })));
    }

    function getTypeArguments(type) {
        return cached(`typeArguments:${typeId(type)}`, () => typesOf(request("getTypeArguments", { type: typeId(type) })), "list");
    }

    function typeRequest(method, type, field = "type") {
        return cached(`${method}:${typeId(type)}`, () => typeOf(request(method, { [field]: typeId(type) })));
    }

    // TS 6.0: src/compiler/checker.ts getApparentType returns an object type that is not mapped, and
    // a union that is not `boolean`, unchanged.
    function getApparentType(type) {
        if (type.flags === TypeFlags.Union || (type.flags === TypeFlags.Object && !(type.objectFlags & ts.ObjectFlags.Mapped))) {
            return type;
        }
        return typeRequest("getApparentType", type, "objectId");
    }

    function getNonNullableType(type) {
        return typeRequest("getNonNullableType", type, "objectId");
    }

    // TS 6.0: src/compiler/checker.ts getBaseConstraintOfType: only instantiable, union,
    // intersection, template literal, string mapping and index types and generic tuples have one.
    function getBaseConstraintOfType(type) {
        const constrained = TypeFlags.InstantiableNonPrimitive | TypeFlags.UnionOrIntersection | TypeFlags.TemplateLiteral | TypeFlags.StringMapping | TypeFlags.Index;
        if (!(type.flags & constrained) && model.typeData(type).isTupleType !== true) {
            return undefined;
        }
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
        return cached(`returnType:${id}`, () => typeOf(request("getReturnTypeOfSignature", { objectId: id })), "type");
    }

    function getTypePredicateOfSignature(signature) {
        const id = model.signatureId(signature);
        return cached(`predicate:${id}`, () => {
            const data = request("getTypePredicateOfSignature", { signature: id });
            return data === undefined || data === null ? undefined : model.typePredicate(data);
        });
    }

    function getParameterType(signature, index) {
        const id = model.signatureId(signature);
        return cached(`parameterType:${id}:${index}`, () => typeOf(request("getParameterType", { signature: id, index })));
    }

    // Nodes

    function getTypeAtLocation(node) {
        const handle = handleOf(node);
        if (handle === undefined) {
            return getErrorType();
        }
        return cached(`typeAt:${handle}`, () => {
            const type = typeOf(request("getTypeAtLocation", { location: handle }));
            return isErrorType(type) && isEntityNameInType(node) ? typeOfEntityNameInType(node) : type;
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
            return symbolOfToken(node);
        }
        return cached(`symbolAt:${handle}`, () => symbolOf(request("getSymbolAtLocation", { location: handle })));
    }

    // TS 6.0 getSymbolAtLocation answers these tokens of a declaration, which tsc-rs's syntax tree
    // does not keep as nodes, with the declaration's symbol.
    function symbolOfToken(nodeIn) {
        const node = ts.getParseTreeNode(nodeIn);
        if (node?.parent === undefined) {
            return undefined;
        }
        switch (node.kind) {
            case SyntaxKind.DefaultKeyword:
            case SyntaxKind.FunctionKeyword:
            case SyntaxKind.EqualsGreaterThanToken:
            case SyntaxKind.ClassKeyword:
                return getSymbolOfDeclaration(node.parent);
            case SyntaxKind.ConstructorKeyword:
                return node.parent.kind === SyntaxKind.Constructor ? getSymbolOfDeclaration(node.parent.parent) : undefined;
            default:
                return undefined;
        }
    }

    // TS 6.0: src/compiler/checker.ts getIndexInfosAtLocation: the index infos of the object's type
    // that apply to the name of a property access. A name is never numeric, so a number key never
    // applies; a template literal or string mapping key needs the name's literal type.
    function getIndexInfosAtLocation(nodeIn) {
        const node = ts.getParseTreeNode(nodeIn);
        if (node === undefined || !ts.isIdentifier(node) || !ts.isPropertyAccessExpression(node.parent) || node.parent.name !== node) {
            return undefined;
        }
        const objectType = getTypeAtLocation(node.parent.expression);
        const objectTypes = objectType.flags & TypeFlags.Union ? objectType.types : [objectType];
        return objectTypes.flatMap(type => getIndexInfosOfType(type).filter(info => isApplicableToName(info.keyType)));
    }

    // TS 6.0: src/compiler/checker.ts isApplicableIndexType for the literal type of an identifier.
    function isApplicableToName(keyType) {
        if (keyType.flags & TypeFlags.Union) {
            return keyType.types.some(isApplicableToName);
        }
        if (keyType.flags & (TypeFlags.TemplateLiteral | TypeFlags.StringMapping)) {
            throw unsupported("getIndexInfosAtLocation", "tsc-rs cannot make the literal type of a property name to match a pattern index key");
        }
        return (keyType.flags & TypeFlags.String) !== 0;
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

    // TS 6.0 getResolvedSignatureForSignatureHelp resolves the call with CheckMode.IsForSignatureHelp
    // and fills `candidatesOutArray` with the callee's signatures in resolveCall's order
    // (reorderCandidates), the chosen one replaced by its instantiation (chooseOverload). tsc-rs
    // resolves the call as the checker does; the candidates are the call or construct signatures
    // of the callee's apparent type. `argumentCount` (the arguments typed so far) is not used.
    function getResolvedSignatureForSignatureHelp(nodeIn, candidatesOutArray) {
        const node = ts.getParseTreeNode(nodeIn, ts.isCallLikeExpression);
        if (node === undefined) {
            return undefined;
        }
        const resolved = getResolvedSignature(node);
        if (candidatesOutArray === undefined) {
            return resolved;
        }
        const candidates = signatureHelpCandidates(node);
        reorderCandidates(candidates, candidatesOutArray);
        const chosen = resolved === undefined ? -1 : candidatesOutArray.findIndex(candidate => candidate === resolved || candidate === resolved.target);
        if (chosen >= 0) {
            candidatesOutArray[chosen] = resolved;
        }
        return resolved;
    }

    // TS 6.0: src/compiler/checker.ts resolveCallExpression, resolveNewExpression,
    // resolveTaggedTemplateExpression and getUninstantiatedJsxSignaturesOfType pick these; a super
    // call's are the base constructor's (tsc-rs answers `super` with the base constructor type,
    // not instantiated with the `extends` clause's type arguments).
    function signatureHelpCandidates(node) {
        if (ts.isCallExpression(node) && node.expression.kind === SyntaxKind.SuperKeyword) {
            return getSignaturesOfType(getTypeAtLocation(node.expression), SignatureKind.Construct);
        }
        if (ts.isCallExpression(node) || ts.isTaggedTemplateExpression(node)) {
            const callee = getApparentType(getTypeAtLocation(ts.isCallExpression(node) ? node.expression : node.tag));
            return getSignaturesOfType(callee, SignatureKind.Call);
        }
        if (ts.isNewExpression(node)) {
            return getSignaturesOfType(getApparentType(getTypeAtLocation(node.expression)), SignatureKind.Construct);
        }
        if (ts.isJsxOpeningLikeElement(node)) {
            const element = getApparentType(getTypeAtLocation(node.tagName));
            const construct = getSignaturesOfType(element, SignatureKind.Construct);
            return construct.length > 0 ? construct : getSignaturesOfType(element, SignatureKind.Call);
        }
        return [];
    }

    // TS 6.0: src/compiler/checker.ts reorderCandidates
    function reorderCandidates(signatures, result) {
        let lastParent;
        let lastSymbol;
        let cutoffIndex = 0;
        let index;
        let specializedIndex = -1;
        for (const signature of signatures) {
            const declaration = signature.declaration;
            const symbol = declaration && getSymbolOfDeclaration(declaration);
            const parent = declaration && declaration.parent;
            if (!lastSymbol || symbol === lastSymbol) {
                if (lastParent && parent === lastParent) {
                    index++;
                }
                else {
                    lastParent = parent;
                    index = cutoffIndex;
                }
            }
            else {
                index = cutoffIndex = result.length;
                lastParent = parent;
            }
            lastSymbol = symbol;
            let spliceIndex = index;
            if (signature.flags & ts.SignatureFlags.HasLiteralTypes) {
                specializedIndex++;
                spliceIndex = specializedIndex;
                cutoffIndex++;
            }
            result.splice(spliceIndex, 0, signature);
        }
    }

    // TS 6.0: src/compiler/checker.ts getExpandedParameters. A rest parameter of a tuple type is
    // spread into one transient symbol per element, which tsc-rs cannot make.
    function getExpandedParameters(signature, skipUnionExpanding) {
        if (signature.flags & ts.SignatureFlags.HasRestParameter) {
            const restType = getTypeOfSymbol(signature.parameters[signature.parameters.length - 1]);
            if (checker.isTupleType(restType) || (!skipUnionExpanding && restType.flags & TypeFlags.Union && restType.types.every(checker.isTupleType))) {
                throw unsupported("getExpandedParameters", "tsc-rs cannot make the parameter symbols of a tuple rest parameter's elements");
            }
        }
        return [signature.parameters];
    }

    // TS 6.0: src/compiler/checker.ts hasEffectiveRestParameter
    function hasEffectiveRestParameter(signature) {
        if (!(signature.flags & ts.SignatureFlags.HasRestParameter)) {
            return false;
        }
        const restType = getTypeOfSymbol(signature.parameters[signature.parameters.length - 1]);
        return !checker.isTupleType(restType) || (restType.target.combinedFlags & ts.ElementFlags.Variable) !== 0;
    }

    // TS 6.0 ContextFlags.IgnoreNodeInferences re-resolves the nearest call around the node without
    // inferences from it (runWithInferenceBlockedFromSourceNode); that changes nothing unless the
    // call's signature is generic. tsc-rs takes no context flags.
    function getContextualType(node, contextFlags) {
        if (contextFlags !== undefined && contextFlags !== 0 && (contextFlags !== ts.ContextFlags.IgnoreNodeInferences || dependsOnCallInference(node))) {
            throw unsupported("getContextualType", "tsc-rs does not take context flags");
        }
        const handle = handleOf(node, ts.isExpression);
        if (handle === undefined) {
            return undefined;
        }
        return cached(`contextualType:${handle}`, () => typeOf(request("getContextualType", { location: handle })));
    }

    // Only an argument of a call gets its contextual type from the call's signature.
    function dependsOnCallInference(nodeIn) {
        let child = ts.getParseTreeNode(nodeIn);
        let call = child;
        while (call !== undefined && !ts.isCallLikeExpression(call)) {
            child = call;
            call = call.parent;
        }
        if (call === undefined || !isArgumentOf(call, child)) {
            return false;
        }
        const signature = getResolvedSignature(call);
        return ((signature?.target ?? signature)?.typeParameters?.length ?? 0) > 0;
    }

    function isArgumentOf(call, child) {
        if (ts.isCallExpression(call) || ts.isNewExpression(call)) {
            return call.arguments?.includes(child) ?? false;
        }
        if (ts.isTaggedTemplateExpression(call)) {
            return child === call.template;
        }
        return ts.isJsxOpeningLikeElement(call) && child === call.attributes;
    }

    // TS 6.0: src/compiler/checker.ts tryGetThisTypeAt. tsc-rs answers the type of a `this`
    // expression, which is TS 6.0's checkThisExpression: tryGetThisTypeAt narrowed by control flow,
    // or `any` when there is none. Elsewhere the this type of the container is its declared one (a
    // class's this type, a `this` parameter) or its contextual one (contextualThisType).
    function tryGetThisTypeAt(nodeIn, includeGlobalThis = true, containerIn) {
        const node = ts.getParseTreeNode(nodeIn);
        if (node === undefined) {
            return undefined;
        }
        const container = containerIn ?? ts.getThisContainer(node, false, false);
        const thisExpression = containerIn === undefined && node.kind === SyntaxKind.ThisKeyword && ts.isExpression(node);
        if (ts.isFunctionLike(container) && (!isInParameterInitializerBeforeContainingFunction(node) || ts.getThisParameter(container))) {
            const thisParameter = getSignatureFromDeclaration(container)?.thisParameter;
            if (thisParameter !== undefined) {
                return thisExpression ? getTypeAtLocation(node) : getTypeOfSymbol(thisParameter);
            }
            if (!thisExpression) {
                const contextual = contextualThisType(container);
                if (contextual !== undefined) {
                    return contextual;
                }
            }
            else {
                // `any` is TS 6.0's answer for a `this` with no this type too.
                const type = getTypeAtLocation(node);
                if (!(type.flags & TypeFlags.Any) || (hasContextualThis(container) && contextualThisType(container) !== undefined)) {
                    return type;
                }
            }
        }
        if (ts.isClassLike(container.parent)) {
            if (thisExpression) {
                return getTypeAtLocation(node);
            }
            const symbol = getSymbolOfDeclaration(container.parent);
            return ts.isStatic(container) ? getTypeOfSymbol(symbol) : getDeclaredTypeOfSymbol(symbol).thisType;
        }
        if (ts.isSourceFile(container)) {
            if (container.commonJsModuleIndicator) {
                const fileSymbol = getSymbolOfDeclaration(container);
                return fileSymbol && getTypeOfSymbol(fileSymbol);
            }
            if (container.externalModuleIndicator) {
                return intrinsic("getUndefinedType");
            }
            if (includeGlobalThis) {
                const globalThisSymbol = resolveName("globalThis", undefined, SymbolFlags.Value, false);
                return globalThisSymbol && getTypeOfSymbol(globalThisSymbol);
            }
        }
        return undefined;
    }

    // TS 6.0 getContextualThisParameterType answers for context sensitive function expressions and
    // object literal methods, and (with noImplicitThis or in JS) for functions in an object literal
    // or assigned to a property.
    function hasContextualThis(func) {
        return ts.isFunctionExpression(func) || ts.isObjectLiteralExpression(func.parent);
    }

    // TS 6.0: src/compiler/checker.ts getContextualThisParameterType. With a `ThisType<T>` marker in
    // the contextual type of an object literal, or in an argument of a generic call (whose
    // contextual types the call's inference instantiates), the answer needs the checker's
    // inference state, which tsc-rs does not send: there is none here.
    function contextualThisType(func) {
        if (func.kind === SyntaxKind.ArrowFunction) {
            return undefined;
        }
        const literal = containingObjectLiteral(func);
        if (dependsOnCallInference(literal ?? func) || (literal !== undefined && hasThisTypeMarker(literal))) {
            return undefined;
        }
        if ((ts.isFunctionExpression(func) || ts.isObjectLiteralMethod(func)) && checker.isContextSensitive(func)) {
            const thisParameter = contextualSignatureThisParameter(func);
            if (thisParameter !== undefined) {
                return getTypeOfSymbol(thisParameter);
            }
        }
        if (!ts.getStrictOptionValue(program.getCompilerOptions(), "noImplicitThis") && !ts.isInJSFile(func)) {
            return undefined;
        }
        if (literal !== undefined) {
            const contextual = getContextualType(literal);
            return checker.getWidenedType(contextual === undefined ? getTypeAtLocation(literal) : getNonNullableType(getApparentType(contextual)));
        }
        const parent = ts.walkUpParenthesizedExpressions(func.parent);
        if (ts.isAssignmentExpression(parent) && ts.isAccessExpression(parent.left)) {
            const { expression } = parent.left;
            const sourceFile = ts.getSourceFileOfNode(parent);
            if (ts.isInJSFile(func) && ts.isIdentifier(expression) && sourceFile.commonJsModuleIndicator && getSymbolAtLocation(expression) === getSymbolOfDeclaration(sourceFile)) {
                return undefined;
            }
            return checker.getWidenedType(getTypeAtLocation(expression));
        }
        return undefined;
    }

    // TS 6.0: src/compiler/checker.ts getContextualSignature: the one call signature of the
    // contextual type (for a method, of its property in the literal's contextual type).
    function contextualSignatureThisParameter(func) {
        let contextual;
        if (ts.isObjectLiteralMethod(func)) {
            const literalType = getContextualType(func.parent);
            const type = literalType === undefined ? undefined : getApparentType(literalType);
            if (type === undefined || type.flags & TypeFlags.Union || !(type.flags & TypeFlags.StructuredType) || func.name === undefined || ts.isComputedPropertyName(func.name)) {
                return undefined;
            }
            const property = getPropertyOfType(type, ts.unescapeLeadingUnderscores(ts.getTextOfPropertyName(func.name)));
            contextual = property === undefined ? undefined : getTypeOfSymbol(property);
        }
        else {
            contextual = getContextualType(func);
        }
        const signatures = contextual === undefined || contextual.flags & TypeFlags.Union ? [] : getSignaturesOfType(getApparentType(contextual), SignatureKind.Call);
        return signatures.length === 1 ? signatures[0].thisParameter : undefined;
    }

    // TS 6.0: src/compiler/checker.ts getContainingObjectLiteral
    function containingObjectLiteral(func) {
        if ((ts.isMethodDeclaration(func) || ts.isGetAccessor(func) || ts.isSetAccessor(func)) && ts.isObjectLiteralExpression(func.parent)) {
            return func.parent;
        }
        return ts.isFunctionExpression(func) && ts.isPropertyAssignment(func.parent) ? func.parent.parent : undefined;
    }

    // TS 6.0: src/compiler/checker.ts getThisTypeOfObjectLiteral looks for ThisType<T> in the contextual
    // types of the literal and of the literals around it.
    function hasThisTypeMarker(literalIn) {
        const marker = globalType("ThisType");
        if (marker === undefined) {
            return false;
        }
        const isMarker = type => (type.objectFlags ?? 0) & ts.ObjectFlags.Reference && type.target === marker;
        for (let literal = literalIn; ; literal = literal.parent.parent) {
            const contextual = getContextualType(literal);
            const members = contextual === undefined ? [] : contextual.flags & TypeFlags.UnionOrIntersection ? contextual.types.flatMap(type => type.flags & TypeFlags.Intersection ? type.types : [type]) : [contextual];
            if (members.some(isMarker)) {
                return true;
            }
            if (!ts.isPropertyAssignment(literal.parent) || !ts.isObjectLiteralExpression(literal.parent.parent)) {
                return false;
            }
        }
    }

    // TS 6.0: src/compiler/checker.ts isInParameterInitializerBeforeContainingFunction
    function isInParameterInitializerBeforeContainingFunction(nodeIn) {
        let node = nodeIn;
        let inBindingInitializer = false;
        while (node.parent && !ts.isFunctionLike(node.parent)) {
            if (ts.isParameter(node.parent) && (inBindingInitializer || node.parent.initializer === node)) {
                return true;
            }
            if (ts.isBindingElement(node.parent) && node.parent.initializer === node) {
                inBindingInitializer = true;
            }
            node = node.parent;
        }
        return false;
    }

    // TS 6.0: src/compiler/checker.ts isDeclarationVisible. TS 6.0 also marks visible what an
    // `export { x }` or `export = x` of the file names, when it checks the file with declaration emit
    // on (collectLinkedAliases); that counts here as checked.
    const declarationVisibility = new WeakMap();

    function isDeclarationVisible(nodeIn) {
        const node = ts.getParseTreeNode(nodeIn);
        if (node === undefined) {
            return false;
        }
        let visible = declarationVisibility.get(node);
        if (visible === undefined) {
            visible = isLinkedAliasDeclaration(node) || determineIfDeclarationIsVisible(node);
            declarationVisibility.set(node, visible);
        }
        return visible;
    }

    function determineIfDeclarationIsVisible(node) {
        switch (node.kind) {
            case SyntaxKind.JSDocCallbackTag:
            case SyntaxKind.JSDocTypedefTag:
            case SyntaxKind.JSDocEnumTag:
                return node.parent?.parent?.parent !== undefined && ts.isSourceFile(node.parent.parent.parent);
            case SyntaxKind.BindingElement:
                return isDeclarationVisible(node.parent.parent);
            case SyntaxKind.VariableDeclaration:
                if (ts.isBindingPattern(node.name) && node.name.elements.length === 0) {
                    return false;
                }
            // falls through
            case SyntaxKind.ModuleDeclaration:
            case SyntaxKind.ClassDeclaration:
            case SyntaxKind.InterfaceDeclaration:
            case SyntaxKind.TypeAliasDeclaration:
            case SyntaxKind.FunctionDeclaration:
            case SyntaxKind.EnumDeclaration:
            case SyntaxKind.ImportEqualsDeclaration: {
                if (ts.isExternalModuleAugmentation(node)) {
                    return true;
                }
                const parent = getDeclarationContainer(node);
                const ambientMember = node.kind !== SyntaxKind.ImportEqualsDeclaration && parent.kind !== SyntaxKind.SourceFile && (parent.flags & ts.NodeFlags.Ambient) !== 0;
                if (!(ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Export) && !ambientMember) {
                    return ts.isGlobalSourceFile(parent);
                }
                return isDeclarationVisible(parent);
            }
            case SyntaxKind.PropertyDeclaration:
            case SyntaxKind.PropertySignature:
            case SyntaxKind.GetAccessor:
            case SyntaxKind.SetAccessor:
            case SyntaxKind.MethodDeclaration:
            case SyntaxKind.MethodSignature:
                if (ts.hasEffectiveModifier(node, ts.ModifierFlags.Private | ts.ModifierFlags.Protected)) {
                    return false;
                }
            // falls through
            case SyntaxKind.Constructor:
            case SyntaxKind.ConstructSignature:
            case SyntaxKind.CallSignature:
            case SyntaxKind.IndexSignature:
            case SyntaxKind.Parameter:
            case SyntaxKind.ModuleBlock:
            case SyntaxKind.FunctionType:
            case SyntaxKind.ConstructorType:
            case SyntaxKind.TypeLiteral:
            case SyntaxKind.TypeReference:
            case SyntaxKind.ArrayType:
            case SyntaxKind.TupleType:
            case SyntaxKind.UnionType:
            case SyntaxKind.IntersectionType:
            case SyntaxKind.ParenthesizedType:
            case SyntaxKind.NamedTupleMember:
                return isDeclarationVisible(node.parent);
            case SyntaxKind.TypeParameter:
            case SyntaxKind.SourceFile:
            case SyntaxKind.NamespaceExportDeclaration:
                return true;
            default:
                return false;
        }
    }

    // TS 6.0: src/compiler/checker.ts getDeclarationContainer
    function getDeclarationContainer(node) {
        const skipped = new Set([SyntaxKind.VariableDeclaration, SyntaxKind.VariableDeclarationList, SyntaxKind.ImportSpecifier, SyntaxKind.NamedImports, SyntaxKind.NamespaceImport, SyntaxKind.ImportClause]);
        return ts.findAncestor(ts.getRootDeclaration(node), ancestor => !skipped.has(ancestor.kind)).parent;
    }

    // TS 6.0: src/compiler/checker.ts collectLinkedAliases(setVisibility) from checkExportSpecifier
    // and checkExportAssignment: the declarations of what the file's local export specifiers and
    // export assignments name.
    const linkedAliasDeclarations = new WeakMap();

    function isLinkedAliasDeclaration(node) {
        const sourceFile = ts.getSourceFileOfNode(node);
        if (sourceFile === undefined || !ts.getEmitDeclarations(program.getCompilerOptions())) {
            return false;
        }
        let declarations = linkedAliasDeclarations.get(sourceFile);
        if (declarations === undefined) {
            declarations = new Set();
            const meaning = SymbolFlags.Value | SymbolFlags.Type | SymbolFlags.Namespace | SymbolFlags.Alias;
            const visit = statement => {
                let symbol;
                if (ts.isExportAssignment(statement) && ts.isIdentifier(statement.expression)) {
                    symbol = resolveName(ts.idText(statement.expression), statement, meaning, false);
                }
                for (const specifier of ts.isExportDeclaration(statement) && statement.moduleSpecifier === undefined && statement.exportClause !== undefined && ts.isNamedExports(statement.exportClause) ? statement.exportClause.elements : []) {
                    checker.getExportSpecifierLocalTargetSymbol(specifier)?.declarations?.forEach(declaration => declarations.add(declaration));
                }
                symbol?.declarations?.forEach(declaration => declarations.add(declaration));
                if (ts.isModuleDeclaration(statement) && statement.body !== undefined && ts.isModuleBlock(statement.body)) {
                    statement.body.statements.forEach(visit);
                }
            };
            sourceFile.statements.forEach(visit);
            linkedAliasDeclarations.set(sourceFile, declarations);
        }
        return declarations.has(node);
    }

    // TS 6.0: src/compiler/checker.ts isLibType
    function isLibType(type) {
        const symbol = (type.objectFlags ?? 0) & ts.ObjectFlags.Reference ? type.target.symbol : type.symbol;
        return checker.isTupleType(type) || (symbol?.declarations?.some(declaration => program.isSourceFileDefaultLibrary(ts.getSourceFileOfNode(declaration))) ?? false);
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

    // TS 6.0 prints into the writer it is given, or into a single-line one and answers its text.
    function printTo(writer, print) {
        if (writer === undefined) {
            return ts.usingSingleLineStringWriter(print);
        }
        print(writer);
        return writer.getText();
    }

    function sourceFileOf(enclosingDeclaration) {
        const parseNode = ts.getParseTreeNode(enclosingDeclaration);
        return parseNode && ts.getSourceFileOfNode(parseNode);
    }

    // TS 6.0 hover expansion (verbosityLevel) needs node builder state tsc-rs does not keep; a
    // caller that passes `out` learns that nothing was truncated and nothing can expand.
    function noExpansion(out) {
        if (out !== undefined) {
            out.canIncreaseExpansionDepth = false;
            out.truncated = false;
        }
    }

    // TS 6.0: src/compiler/checker.ts signatureToString
    function signatureToString(signature, enclosingDeclaration, flags = TypeFormatFlags.None, kind, writer, maximumLength, verbosityLevel, out) {
        let declarationKind;
        if (flags & TypeFormatFlags.WriteArrowStyleSignature) {
            declarationKind = kind === SignatureKind.Construct ? SyntaxKind.ConstructorType : SyntaxKind.FunctionType;
        }
        else {
            declarationKind = kind === SignatureKind.Construct ? SyntaxKind.ConstructSignature : SyntaxKind.CallSignature;
        }
        const nodeFlags = (flags & TypeFormatFlags.NodeBuilderFlagsMask) | NodeBuilderFlags.IgnoreErrors | NodeBuilderFlags.WriteTypeParametersInQualifiedName;
        const node = signatureToSignatureDeclaration(signature, declarationKind, enclosingDeclaration, nodeFlags);
        noExpansion(out);
        const printer = ts.createPrinterWithRemoveCommentsOmitTrailingSemicolon();
        return printTo(writer, target => printer.writeNode(ts.EmitHint.Unspecified, node, sourceFileOf(enclosingDeclaration), ts.getTrailingSemicolonDeferringWriter(target)));
    }

    // TS 6.0: src/compiler/checker.ts typeToString with a writer (writeType): the type node printed.
    function writeType(type, enclosingDeclaration, flags = TypeFormatFlags.AllowUniqueESSymbolType | TypeFormatFlags.UseAliasDefinedOutsideCurrentScope, writer = ts.createTextWriter(""), maximumLength, verbosityLevel, out) {
        const noTruncation = (!maximumLength && program.getCompilerOptions().noErrorTruncation) || (flags & TypeFormatFlags.NoTruncation) !== 0;
        const nodeFlags = (flags & TypeFormatFlags.NodeBuilderFlagsMask) | NodeBuilderFlags.IgnoreErrors | (noTruncation ? NodeBuilderFlags.NoTruncation : 0);
        const node = typeToTypeNode(type, enclosingDeclaration, nodeFlags);
        if (node === undefined) {
            return ts.Debug.fail("should always get typenode");
        }
        noExpansion(out);
        // TS 6.0 keeps comments only for its unresolved type (a synthesized comment on `any`).
        const printer = type.intrinsicName === "unresolved" ? ts.createPrinterWithDefaults() : ts.createPrinterWithRemoveComments();
        printer.writeNode(ts.EmitHint.Unspecified, node, sourceFileOf(enclosingDeclaration), writer);
        const result = writer.getText();
        const maxLength = maximumLength || (noTruncation ? 1_000_000 * 2 : 160 * 2);
        return result.length >= maxLength ? `${result.substr(0, maxLength - "...".length)}...` : result;
    }

    // TS 6.0: src/compiler/checker.ts typePredicateToTypePredicateNodeHelper
    function typePredicateToTypePredicateNode(predicate, enclosingDeclaration, flags = NodeBuilderFlags.None) {
        const { TypePredicateKind, factory } = ts;
        const asserts = predicate.kind === TypePredicateKind.AssertsThis || predicate.kind === TypePredicateKind.AssertsIdentifier;
        const parameterName = predicate.kind === TypePredicateKind.Identifier || predicate.kind === TypePredicateKind.AssertsIdentifier
            ? ts.setEmitFlags(factory.createIdentifier(predicate.parameterName), ts.EmitFlags.NoAsciiEscaping)
            : factory.createThisTypeNode();
        const typeNode = predicate.type && typeToTypeNode(predicate.type, enclosingDeclaration, flags);
        return factory.createTypePredicateNode(asserts ? factory.createToken(SyntaxKind.AssertsKeyword) : undefined, parameterName, typeNode);
    }

    // TS 6.0: src/compiler/checker.ts typePredicateToString with a writer (writeTypePredicate)
    function writeTypePredicate(predicate, enclosingDeclaration, flags = TypeFormatFlags.UseAliasDefinedOutsideCurrentScope, writer) {
        const nodeFlags = (flags & TypeFormatFlags.NodeBuilderFlagsMask) | NodeBuilderFlags.IgnoreErrors | NodeBuilderFlags.WriteTypeParametersInQualifiedName;
        const node = typePredicateToTypePredicateNode(predicate, enclosingDeclaration, nodeFlags);
        return printTo(writer, target => ts.createPrinterWithRemoveComments().writeNode(ts.EmitHint.Unspecified, node, sourceFileOf(enclosingDeclaration), target));
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

    function symbolToString(symbol, enclosingDeclaration, meaning, flags = ts.SymbolFormatFlags.AllowAnyNodeKind) {
        return writeSymbol(symbol, enclosingDeclaration, meaning, flags, undefined);
    }

    // TS 6.0: src/compiler/checker.ts symbolToString. The entity name it prints writes each name
    // with its symbol (writer.writeSymbol), which gives display parts their kinds; with
    // AllowAnyNodeKind a module is its module specifier, and with WriteTypeParametersOrArguments a
    // container is written with its type parameters (lookupTypeParameterNodes; tsc-rs does not send
    // the type arguments of an instantiated member's container, which is then written without).
    function writeSymbol(symbol, enclosingDeclaration, meaning, flags = ts.SymbolFormatFlags.AllowAnyNodeKind, writer) {
        const chain = symbolChain(symbol, enclosingDeclaration, flags);
        const sourceFile = sourceFileOf(enclosingDeclaration);
        const [first] = chain;
        const specifier = flags & ts.SymbolFormatFlags.AllowAnyNodeKind && first.name.startsWith("\"") && first.symbol.declarations?.some(isExternalModuleDeclaration)
            ? specifierForModuleSymbol(first.symbol, sourceFile)
            : undefined;
        const typeParameters = chain.map((part, index) => {
            const next = chain[index + 1];
            if (!(flags & ts.SymbolFormatFlags.WriteTypeParametersOrArguments) || next === undefined || (next.symbol.links?.checkFlags ?? 0) & CheckFlags.Instantiated) {
                return undefined;
            }
            return symbolToTypeParameterDeclarations(part.symbol, enclosingDeclaration, NodeBuilderFlags.IgnoreErrors);
        });
        return printTo(writer, target => {
            chain.forEach(({ name, symbol: part }, index) => {
                if (index === 0) {
                    if (specifier === undefined) {
                        target.writeSymbol(name, part);
                    }
                    else {
                        target.writeStringLiteral(`"${ts.escapeString(specifier, 34)}"`);
                    }
                }
                else if (ts.isIdentifierText(part.name, ts.ScriptTarget.ESNext)) {
                    target.writePunctuation(".");
                    target.writeSymbol(name, part);
                }
                else {
                    target.writePunctuation("[");
                    target.writeStringLiteral(/^\d+$/.test(part.name) || name.startsWith("\"") ? name : JSON.stringify(part.name));
                    target.writePunctuation("]");
                }
                if (typeParameters[index]?.length) {
                    ts.createPrinterWithRemoveComments().writeList(ts.ListFormat.TypeParameters, typeParameters[index], sourceFile, target);
                }
            });
        });
    }

    // TS 6.0: src/compiler/checker.ts hasNonGlobalAugmentationExternalModuleSymbol
    function isExternalModuleDeclaration(declaration) {
        return ts.isModuleWithStringLiteralName(declaration) || (ts.isSourceFile(declaration) && ts.isExternalOrCommonJsModule(declaration));
    }

    // TS 6.0: src/compiler/checker.ts getSpecifierForModuleSymbol
    function specifierForModuleSymbol(symbol, contextFile) {
        const file = symbol.declarations?.find(ts.isSourceFile);
        if (file?.moduleName !== undefined) {
            return file.moduleName;
        }
        const ambientName = /^".+"$/s.test(symbol.escapedName) ? symbol.escapedName.slice(1, -1) : undefined;
        if (file === undefined && ambientName !== undefined) {
            return ambientName;
        }
        if (contextFile === undefined) {
            return ambientName ?? ts.getSourceFileOfNode(ts.getNonAugmentationDeclaration(symbol)).fileName;
        }
        const resolutionMode = program.getDefaultResolutionModeForFile(contextFile);
        const preferences = { importModuleSpecifierPreference: "project-relative", importModuleSpecifierEnding: resolutionMode === ts.ModuleKind.ESNext ? "js" : undefined };
        return cached(`specifier:${symbolKey(symbol)}:${contextFile.path}`, () => ts.moduleSpecifiers.getModuleSpecifiers(symbol, checker, program.getCompilerOptions(), contextFile, moduleSpecifierHost(), preferences, {})[0]);
    }

    // TS 6.0: src/compiler/checker.ts createBasicNodeBuilderModuleSpecifierResolutionHost(program)
    function moduleSpecifierHost() {
        return {
            getCommonSourceDirectory: () => program.getCommonSourceDirectory(),
            getCurrentDirectory: () => program.getCurrentDirectory(),
            getSymlinkCache: () => program.getSymlinkCache(),
            getPackageJsonInfoCache: () => program.getPackageJsonInfoCache?.(),
            useCaseSensitiveFileNames: () => program.useCaseSensitiveFileNames(),
            redirectTargetsMap: program.redirectTargetsMap,
            getRedirectFromSourceFile: fileName => program.getRedirectFromSourceFile(fileName),
            isSourceOfProjectReferenceRedirect: fileName => program.isSourceOfProjectReferenceRedirect(fileName),
            fileExists: fileName => program.fileExists(fileName),
            getFileIncludeReasons: () => program.getFileIncludeReasons(),
            readFile: fileName => program.readFile(fileName),
            getDefaultResolutionModeForFile: file => program.getDefaultResolutionModeForFile(file),
            getModeForResolutionAtIndex: (file, index) => program.getModeForResolutionAtIndex(file, index),
            getGlobalTypingsCacheLocation: () => program.getGlobalTypingsCacheLocation?.(),
        };
    }

    // TS 6.0 symbolToString prints the accessible symbol chain (src/compiler/checker.ts
    // getAccessibleSymbolChain), each name with its symbol. Without an enclosing declaration that
    // is the symbol's own name; with one, a symbol that its name does not reach from there is
    // qualified by its container: a class, interface, enum or namespace, or the alias of its module.
    function symbolChain(symbol, enclosingDeclaration, flags) {
        const name = splitQualifiedName(getFullyQualifiedName(symbol)).at(-1);
        const location = ts.getParseTreeNode(enclosingDeclaration);
        if (location === undefined || flags & ts.SymbolFormatFlags.DoNotIncludeSymbolChain || symbol.flags & SymbolFlags.TypeParameter || isAccessibleByName(symbol, location)) {
            return [{ name, symbol }];
        }
        const alias = aliasInScope(symbol, location);
        if (alias !== undefined) {
            return [{ name: alias.name, symbol: alias }];
        }
        const container = symbol.parent;
        if (container === undefined) {
            return [{ name, symbol }];
        }
        if (container.escapedName.startsWith("\"")) {
            const moduleAlias = aliasInScope(container, location);
            return moduleAlias === undefined ? [{ name, symbol }] : [{ name: moduleAlias.name, symbol: moduleAlias }, { name, symbol }];
        }
        if (!(container.flags & (SymbolFlags.Class | SymbolFlags.Interface | SymbolFlags.Enum | SymbolFlags.Module))) {
            return [{ name, symbol }];
        }
        return [...symbolChain(container, location, flags), { name, symbol }];
    }

    // TS 6.0: src/compiler/checker.ts getAccessibleSymbolChain, as symbolToString finds the chain:
    // the symbol by its name or by an alias in scope, or its container's chain and the symbol.
    function getAccessibleSymbolChain(symbol, enclosingDeclaration) {
        if (symbol === undefined || isPropertyOrMethodDeclarationSymbol(symbol)) {
            return undefined;
        }
        return accessibleChain(symbol, ts.getParseTreeNode(enclosingDeclaration));
    }

    function accessibleChain(symbol, location) {
        if (!(symbol.flags & SymbolFlags.TypeParameter) && isAccessibleByName(symbol, location)) {
            return [symbol];
        }
        const alias = location === undefined ? undefined : aliasInScope(symbol, location);
        if (alias !== undefined) {
            return [alias];
        }
        const container = symbol.parent;
        if (container === undefined) {
            return undefined;
        }
        if (container.escapedName.startsWith("\"")) {
            const moduleAlias = location === undefined ? undefined : aliasInScope(container, location);
            return moduleAlias === undefined ? undefined : [moduleAlias, symbol];
        }
        if (!(container.flags & (SymbolFlags.Class | SymbolFlags.Interface | SymbolFlags.Enum | SymbolFlags.Module))) {
            return undefined;
        }
        const left = accessibleChain(container, location);
        return left === undefined ? undefined : [...left, symbol];
    }

    // TS 6.0: src/compiler/checker.ts isPropertyOrMethodDeclarationSymbol
    function isPropertyOrMethodDeclarationSymbol(symbol) {
        const kinds = [SyntaxKind.PropertyDeclaration, SyntaxKind.MethodDeclaration, SyntaxKind.GetAccessor, SyntaxKind.SetAccessor];
        return (symbol.declarations?.length ?? 0) > 0 && symbol.declarations.every(declaration => kinds.includes(declaration.kind));
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
        const segments = symbolToString(symbol, enclosingDeclaration ?? program.getSourceFiles()[0], meaning, ts.SymbolFormatFlags.None).split(".");
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
    // TS 6.0 symbolToParameterDeclaration: the parameter as tsc-rs's node builder writes it in the
    // signature that lists the symbol (an instantiated signature's own parameter symbols), else in
    // the signature of its declared function.
    function symbolToParameterDeclaration(symbol, enclosingDeclaration, flags = NodeBuilderFlags.None) {
        const signature = model.signatureOfParameter(symbol) ?? declaredSignatureOfParameter(symbol);
        const node = signature && signatureToSignatureDeclaration(signature, SyntaxKind.FunctionType, enclosingDeclaration, flags);
        if (node === undefined) {
            return undefined;
        }
        const isThis = parameter => ts.isIdentifier(parameter.name) && parameter.name.escapedText === "this";
        if (symbol === signature.thisParameter) {
            return node.parameters.find(isThis);
        }
        const declaration = symbol.valueDeclaration;
        let index = signature.parameters.indexOf(symbol);
        if (index < 0 && declaration !== undefined && ts.isParameter(declaration)) {
            index = declaration.parent.parameters.filter(parameter => !ts.parameterIsThisKeyword(parameter)).indexOf(declaration);
        }
        return index < 0 ? undefined : node.parameters.filter(parameter => !isThis(parameter))[index];
    }

    function declaredSignatureOfParameter(symbol) {
        const declaration = symbol.valueDeclaration;
        if (declaration === undefined || !ts.isParameter(declaration) || !ts.isFunctionLike(declaration.parent)) {
            throw unsupported("symbolToParameterDeclaration", "the symbol is not a parameter of a declared function");
        }
        return getSignatureFromDeclaration(declaration.parent);
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
        return cached(`symbolsInScope:${handle}:${meaning}`, () => symbolsOf(request("getSymbolsInScope", { location: handle, meaning: symbolFlagsToNative(meaning) }))).slice();
    }

    function resolveName(name, location, meaning, excludeGlobals) {
        const handle = handleOf(location);
        return cached(`resolveName:${name}:${handle}:${meaning}:${excludeGlobals === true}`, () => symbolOf(request("resolveName", {
            name,
            location: handle,
            meaning: symbolFlagsToNative(meaning),
            excludeGlobals: excludeGlobals === true,
        })));
    }

    // TS 6.0: src/compiler/checker.ts isValidPropertyAccessForCompletions
    function isValidPropertyAccessForCompletions(nodeIn, type, property) {
        const node = ts.getParseTreeNode(nodeIn, ts.isPropertyAccessExpression);
        if (node === undefined) {
            return false;
        }
        return (type.flags & TypeFlags.Any) !== 0 || isPropertyAccessible(node, node.expression.kind === SyntaxKind.SuperKeyword, type, property);
    }

    // TS 6.0: src/compiler/checker.ts getContextualTypeForObjectLiteralElement. The contextual type
    // of a property's value is the property's (tsc-rs getContextualType of the initializer); a
    // method or accessor reads the property of the object literal's contextual type, which a union
    // would need to map.
    function getContextualTypeForObjectLiteralElement(nodeIn) {
        const node = ts.getParseTreeNode(nodeIn, ts.isObjectLiteralElementLike);
        if (node === undefined || !ts.isObjectLiteralExpression(node.parent)) {
            return undefined;
        }
        if (ts.isPropertyAssignment(node)) {
            return getContextualType(node.initializer);
        }
        if (ts.isShorthandPropertyAssignment(node)) {
            return getContextualType(node.name);
        }
        const contextual = getContextualType(node.parent);
        if (contextual === undefined || node.name === undefined || ts.isComputedPropertyName(node.name)) {
            return undefined;
        }
        const type = getApparentType(contextual);
        if (type.flags & TypeFlags.Union) {
            throw unsupported("getContextualTypeForObjectLiteralElement", "tsc-rs cannot make the union of the members' property types");
        }
        if (!(type.flags & TypeFlags.StructuredType)) {
            return undefined;
        }
        const name = ts.getTextOfPropertyName(node.name);
        const property = getPropertyOfType(type, ts.unescapeLeadingUnderscores(name));
        return property === undefined ? getIndexInfoOfType(type, IndexKind.String)?.type : getTypeOfSymbol(property);
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
        const data = cached(`constantValue:${handle}`, () => request("getConstantValue", { location: handle }));
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
            return handle === undefined ? undefined : cached(`shorthandValue:${handle}`, () => symbolOf(request("getShorthandAssignmentValueSymbol", { location: handle })));
        },
        getExportSpecifierLocalTargetSymbol: nodeIn => {
            const handle = handleOf(nodeIn, ts.isExportSpecifier);
            return handle === undefined ? undefined : cached(`exportSpecifierTarget:${handle}`, () => symbolOf(request("getExportSpecifierLocalTargetSymbol", { location: handle })));
        },
        getExportSymbolOfSymbol,
        getTypeAtLocation,
        getTypeOfAssignmentPattern,
        getPropertySymbolOfDestructuringAssignment,
        signatureToString: (signature, enclosingDeclaration, flags, kind) => signatureToString(signature, enclosingDeclaration, flags, kind),
        typeToString,
        symbolToString,
        typePredicateToString,
        writeSignature: signatureToString,
        writeType,
        writeSymbol,
        writeTypePredicate,
        typePredicateToTypePredicateNode,
        getFullyQualifiedName,
        getAugmentedPropertiesOfType,
        getRootSymbols,
        getSymbolOfExpando: notSupported("getSymbolOfExpando", "tsc-rs has no request for expando symbols"),
        getContextualType,
        getContextualTypeForArgumentAtIndex: (nodeIn, argIndex) => {
            const handle = handleOf(nodeIn, ts.isCallLikeExpression);
            return handle === undefined ? undefined : cached(`contextualArgument:${handle}:${argIndex}`, () => typeOf(request("getContextualTypeForArgument", { location: handle, index: argIndex })));
        },
        isContextSensitive: node => {
            const handle = handleOf(node);
            return handle !== undefined && cached(`contextSensitive:${handle}`, () => request("isContextSensitive", { location: handle }));
        },
        getResolvedSignature,
        getResolvedSignatureForSignatureHelp,
        getExpandedParameters,
        hasEffectiveRestParameter,
        getSignatureFromDeclaration,
        isImplementationOfOverload,
        getConstantValue,
        isValidPropertyAccess,
        isValidPropertyAccessForCompletions,
        getAccessibleSymbolChain,
        getContextualTypeForObjectLiteralElement,
        getIndexInfosAtLocation,
        getAliasedSymbol,
        getImmediateAliasedSymbol,
        getExportsOfModule,
        getJsxIntrinsicTagNamesAt,
        isOptionalParameter,
        getAmbientModules,
        tryGetMemberInModuleExports: (memberName, moduleSymbol) => cached(`memberInModuleExports:${symbolKey(moduleSymbol)}:${memberName}`, () => symbolOf(request("getMemberInModuleExports", { symbol: reference(moduleSymbol), name: memberName }))),
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
        isTypeAssignableTo: (source, target) => cached(`assignable:${typeId(source)}:${typeId(target)}`, () => request("isTypeAssignableTo", { source: typeId(source), target: typeId(target) })),
        // TS 6.0 isArrayType: a reference to the global Array or ReadonlyArray type.
        isArrayType: type => (type.flags & TypeFlags.Object) !== 0 && (type.objectFlags & ts.ObjectFlags.Reference) !== 0 && cached(`isArray:${typeId(type)}`, () => request("isArrayType", { type: typeId(type) })),
        isTupleType: type => model.typeData(type).isTupleType === true,
        isArrayLikeType: type => cached(`isArrayLike:${typeId(type)}`, () => request("isArrayLikeType", { type: typeId(type) })),
        resolveName,
        getTypePredicateOfSignature,
        getTypeArgumentsForResolvedSignature,
        getLocalTypeParametersOfClassOrInterfaceOrTypeAlias,
        typeHasCallOrConstructSignatures: type => getSignaturesOfType(type, SignatureKind.Call).length > 0 || getSignaturesOfType(type, SignatureKind.Construct).length > 0,
        getElementTypeOfArrayType: type => checker.isArrayType(type) ? getTypeArguments(type)[0] : undefined,
        tryGetThisTypeAt,
        isDeclarationVisible,
        isLibType,
        getPromiseType: () => globalType("Promise"),
        getPromiseLikeType: () => globalType("PromiseLike"),
    });
    return checker;
}

module.exports = { createChecker };
