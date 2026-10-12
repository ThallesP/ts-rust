//! Port of Effect-TS/tsgo `internal/rules/promise_in_effect_success.go`.

use crate::effect::diag;
use crate::effect::etscore::*;
use crate::effect::rule::*;
use crate::effect::typeparser::*;
use crate::prelude::*;

pub static PROMISE_IN_EFFECT_SUCCESS: Rule = Rule {
    name: "promiseInEffectSuccess",
    group: "correctness",
    description: "Detects Promise types in Effect success channels where they are not awaited",
    default_severity: Severity::Warning,
    supported_effect: &["v3", "v4"],
    codes: &[377108],
    run: run_promise_in_effect_success,
};

fn run_promise_in_effect_success(ctx: &mut RuleContext<'_, '_>) -> Vec<Diagnostic> {
    let mut diags = Vec::new();
    // PERF: the node is a node order index (effperf4).
    struct StackEntry {
        index: u32,
        visited: bool,
    }

    // PERF: Go walks the tree with a stack of nodes; this stack holds node
    // order indexes and pushes and pops at the same points (effperf4).
    let order = ctx.tp.node_order(ctx.source_file);
    let mut stack = vec![StackEntry {
        index: 0,
        visited: false,
    }];
    let mut matched: FxHashMap<Node, bool> = FxHashMap::default();

    while let Some(entry) = stack.pop() {
        let node = order.node(entry.index);
        // Go: promise_in_effect_success.go:39. The node order holds no nil
        // node, so this never skips; it keeps Go's shape.
        if node.is_nil() {
            continue;
        }

        if !entry.visited {
            if is_type_node(node) {
                continue;
            }
            stack.push(StackEntry {
                index: entry.index,
                visited: true,
            });
            stack.extend(order.children(entry.index).map(|child| StackEntry {
                index: child,
                visited: false,
            }));
            continue;
        }

        if matched.get(&node).copied().unwrap_or(false) {
            if node.parent().is_some() && !is_function_like(node) {
                matched.insert(node.parent(), true);
            }
            continue;
        }

        if !is_expression(node) || is_declaration_name(node) {
            continue;
        }

        // Declared-type prefilter: a diagnostic requires a strict Effect
        // flow type on the node, which reference nodes with a
        // conclusively non-Effect declared type — and calls whose
        // resolved signature conclusively cannot return one — can never
        // have. Skipped nodes can never match, so no matched-map
        // bookkeeping is needed.
        if !ctx.tp.node_could_be_strict_effect(node) {
            continue;
        }

        let mut t = TypeId::NIL;
        if node.kind() == SyntaxKind::CallExpression {
            let signature = ctx.tp.checker.get_resolved_signature_exported(node);
            if signature.is_some() {
                t = ctx.tp.checker.get_return_type_of_signature(signature);
            }
        }
        if t.is_nil() {
            t = ctx.tp.get_type_at_location(node);
        }
        let effect = ctx.tp.strict_effect_type(t);
        let Some(effect) = effect else {
            continue;
        };
        if !type_contains_promise(ctx.tp, effect.a) {
            continue;
        }

        if has_explicit_promise_effect_context(ctx.tp, node)
            || has_explicit_promise_success_type_arguments(ctx.tp, node)
            || is_effect_sync_call(ctx.tp, node)
        {
            continue;
        }

        diags.push(ctx.new_diagnostic(
            ctx.source_file,
            ctx.get_error_range(node),
            diag::The_Effect_success_channel_contains_a_Promise_that_is_not_awaited_Use_Effect_promise_or_Effect_tryPromise_to_represent_async_work_effect_promiseInEffectSuccess,
            Vec::new(),
            Vec::new(),
        ));
        if node.parent().is_some() {
            matched.insert(node.parent(), true);
        }
    }

    diags
}

// Go: rules/promise_in_effect_success.go hasExplicitPromiseEffectContext
fn has_explicit_promise_effect_context(tp: &mut TypeParser<'_>, node: Node) -> bool {
    let mut current = node;
    while current.is_some() {
        match current.kind() {
            SyntaxKind::VariableDeclaration
            | SyntaxKind::PropertyDeclaration
            | SyntaxKind::Parameter => {
                return is_explicit_promise_effect_type(tp, current.type_());
            }
            SyntaxKind::AsExpression | SyntaxKind::SatisfiesExpression => {
                if is_explicit_promise_effect_type(tp, current.type_()) {
                    return true;
                }
            }
            SyntaxKind::ArrowFunction
            | SyntaxKind::FunctionExpression
            | SyntaxKind::FunctionDeclaration
            | SyntaxKind::MethodDeclaration => {
                if current.kind() == SyntaxKind::ArrowFunction
                    && current.body().kind() != SyntaxKind::Block
                {
                    return has_explicit_promise_effect_return(tp, current);
                }
                return false;
            }
            SyntaxKind::ReturnStatement => {
                let function = get_containing_function(current);
                return function.is_some() && has_explicit_promise_effect_return(tp, function);
            }
            _ => {}
        }
        current = current.parent();
    }
    false
}

// Go: rules/promise_in_effect_success.go isExplicitPromiseEffectType
fn is_explicit_promise_effect_type(tp: &mut TypeParser<'_>, type_node: Node) -> bool {
    if type_node.is_nil() {
        return false;
    }
    let t = tp.get_type_at_location(type_node);
    let effect = tp.strict_effect_type(t);
    effect.is_some_and(|effect| type_contains_promise(tp, effect.a))
}

// Go: rules/promise_in_effect_success.go hasExplicitPromiseEffectReturn
fn has_explicit_promise_effect_return(tp: &mut TypeParser<'_>, function: Node) -> bool {
    if is_explicit_promise_effect_type(tp, function.type_()) {
        return true;
    }
    let mut parent = function.parent();
    while parent.is_some() && parent.kind() == SyntaxKind::ParenthesizedExpression {
        parent = parent.parent();
    }
    if parent.is_nil() {
        return false;
    }
    let type_node = parent.type_();
    if type_node.is_nil() {
        return false;
    }
    let t = tp.get_type_at_location(type_node);
    for member in tp.unroll_union_members(t) {
        let signatures = tp
            .checker
            .get_signatures_of_type(member, SignatureKind::CALL)
            .to_vec();
        for signature in signatures {
            let return_type = tp.checker.get_return_type_of_signature(signature);
            let result = tp.strict_effect_type(return_type);
            if let Some(result) = result
                && type_contains_promise(tp, result.a)
            {
                return true;
            }
        }
    }
    false
}

// Go: rules/promise_in_effect_success.go typeContainsPromise
fn type_contains_promise(tp: &mut TypeParser<'_>, t: TypeId) -> bool {
    for member in tp.unroll_union_members(t) {
        if tp.promise_type(member).is_some() {
            return true;
        }
    }
    false
}

/// explicitPromiseSuccessApis lists the Effect APIs whose explicit type
/// arguments annotate the success channel directly.
static EXPLICIT_PROMISE_SUCCESS_APIS: [ExportMember; 4] = [
    ExportMember::new("succeed"),
    ExportMember::new("as"),
    ExportMember::new("map"),
    ExportMember::new("zipWith"),
];

/// hasExplicitPromiseSuccessTypeArguments reports whether the promise in the
/// success channel was written explicitly through type arguments on the node
/// itself or on a transformation of the piping flow rooted at the node.
/// Flow transformations count at any position when the flow is rooted at a
/// pipe call; otherwise only the node's own final transformation counts, so an
/// explicit annotation passed as an argument to an unrelated constructor still
/// reports.
// Go: rules/promise_in_effect_success.go hasExplicitPromiseSuccessTypeArguments
fn has_explicit_promise_success_type_arguments(tp: &mut TypeParser<'_>, node: Node) -> bool {
    let Some(flow) = tp.longest_piping_flow_at(node, true) else {
        return false;
    };
    if flow.transformations.is_empty() {
        return false;
    }
    let last = flow.transformations.len() - 1;
    let final_kind = flow.transformations[last].kind;
    let pipe_rooted =
        final_kind == TransformationKind::Pipe || final_kind == TransformationKind::Pipeable;
    for i in 0..flow.transformations.len() {
        if !is_explicit_promise_success_transformation(tp, Some(&flow.transformations[i])) {
            continue;
        }
        if pipe_rooted || i == last {
            return true;
        }
    }
    false
}

/// isExplicitPromiseSuccessTransformation reports whether a piping transformation
/// applies one of the explicit promise-success APIs with explicit type arguments.
/// Callees may be wrapped in parentheses or curried (e.g. Effect.as<...>(value)).
// Go: rules/promise_in_effect_success.go isExplicitPromiseSuccessTransformation
fn is_explicit_promise_success_transformation(
    tp: &mut TypeParser<'_>,
    transformation: Option<&PipingFlowTransformation>,
) -> bool {
    let Some(transformation) = transformation else {
        return false;
    };
    if transformation.type_arguments.is_nil() || transformation.type_arguments.nodes().is_empty() {
        return false;
    }
    let mut callee = skip_parentheses(transformation.callee);
    if callee.is_nil() {
        return false;
    }
    if callee.kind() == SyntaxKind::CallExpression {
        callee = callee.expression();
    }
    is_explicit_promise_success_api(tp, callee)
}

// Go: rules/promise_in_effect_success.go isExplicitPromiseSuccessApi
fn is_explicit_promise_success_api(tp: &mut TypeParser<'_>, node: Node) -> bool {
    for name in &EXPLICIT_PROMISE_SUCCESS_APIS {
        if tp.is_node_reference_to_effect_module_api(node, name) {
            return true;
        }
    }
    false
}

// Go: rules/promise_in_effect_success.go isEffectSyncCall
fn is_effect_sync_call(tp: &mut TypeParser<'_>, node: Node) -> bool {
    if node.is_nil() || node.kind() != SyntaxKind::CallExpression {
        return false;
    }
    tp.is_node_reference_to_effect_module_api(node.expression(), member!("sync"))
}
