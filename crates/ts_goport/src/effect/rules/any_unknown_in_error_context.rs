//! Port of Effect-TS/tsgo `internal/rules/any_unknown_in_error_context.go`.

use crate::effect::diag;
use crate::effect::etscore::*;
use crate::effect::rule::*;
use crate::effect::typeparser::*;
use crate::prelude::*;

/// AnyUnknownInErrorContext detects 'any' or 'unknown' types in the error (E) or
/// requirements (R) channels of Effect and Layer types.
pub static ANY_UNKNOWN_IN_ERROR_CONTEXT: Rule = Rule {
    name: "anyUnknownInErrorContext",
    group: "correctness",
    description: "Detects 'any' or 'unknown' types in Effect error or requirements channels",
    default_severity: Severity::Off,
    supported_effect: &["v3", "v4"],
    codes: &[377030],
    run: run_any_unknown_in_error_context,
};

struct MatchEntry {
    node: Node,
    message_text: String,
    start: i32,
    end: i32,
}

fn run_any_unknown_in_error_context(ctx: &mut RuleContext<'_, '_>) -> Vec<Diagnostic> {
    let mut matches: Vec<MatchEntry> = Vec::new();

    // Stack-based traversal
    // PERF: Go walks the tree with a stack of nodes; this stack holds node
    // order indexes and pushes and pops at the same points (effperf4).
    let order = ctx.tp.node_order(ctx.source_file);
    let mut node_to_visit: Vec<u32> = order.children(0).collect();

    // Pop from the end (stack)
    while let Some(i) = node_to_visit.pop() {
        let node = order.node(i);

        // Skip type nodes
        if is_type_node(node) {
            continue;
        }
        // Skip type alias declarations
        if node.kind() == SyntaxKind::TypeAliasDeclaration {
            continue;
        }
        // Skip interface declarations
        if node.kind() == SyntaxKind::InterfaceDeclaration {
            continue;
        }
        // Skip "as any" expressions
        if node.kind() == SyntaxKind::AsExpression {
            let type_node = node.type_();
            if type_node.is_some() && type_node.kind() == SyntaxKind::AnyKeyword {
                continue;
            }
        }

        // If this is a parameter, property, or variable declaration with explicit
        // Effect or Layer type annotation, skip it entirely (user intentionally typed it)
        if node.kind() == SyntaxKind::Parameter
            || node.kind() == SyntaxKind::PropertyDeclaration
            || node.kind() == SyntaxKind::VariableDeclaration
        {
            let type_node = node.type_();
            if type_node.is_some() {
                let annotation_type = ctx.tp.get_type_at_location(type_node);
                if annotation_type.is_some() {
                    if ctx.tp.strict_effect_type(annotation_type).is_some() {
                        continue;
                    }
                    if ctx.tp.layer_type(annotation_type).is_some() {
                        continue;
                    }
                }
            }
        }

        // Enqueue children for visiting
        node_to_visit.extend(order.children(i));

        // Get the type at this location
        let mut t = ctx.tp.get_type_at_location(node);

        // For call expressions, use the resolved signature's return type
        if node.kind() == SyntaxKind::CallExpression {
            let sig = ctx.tp.checker.get_resolved_signature_exported(node);
            if sig.is_some() {
                t = ctx.tp.checker.get_return_type_of_signature_exported(sig);
            }
        }

        if t.is_nil() {
            continue;
        }

        // Try strict Effect type first, then Layer type
        let mut e_type = TypeId::NIL;
        let mut r_type = TypeId::NIL;
        if let Some(eff) = ctx.tp.strict_effect_type(t) {
            e_type = eff.e;
            r_type = eff.r;
        } else if let Some(layer) = ctx.tp.layer_type(t) {
            e_type = layer.e;
            r_type = layer.r_in;
        }

        if e_type.is_nil() || r_type.is_nil() {
            continue;
        }

        let r_flags = ctx.tp.checker.ty(r_type).flags();
        let e_flags = ctx.tp.checker.ty(e_type).flags();
        let has_any_unknown_r = r_flags.intersects(TypeFlags::ANY | TypeFlags::UNKNOWN);
        let has_any_unknown_e = e_flags.intersects(TypeFlags::ANY | TypeFlags::UNKNOWN);

        if !has_any_unknown_r && !has_any_unknown_e {
            continue;
        }

        // Build the channel descriptions
        let mut channels: Vec<String> = Vec::new();
        if has_any_unknown_r {
            let mut type_name = "unknown";
            if r_flags.intersects(TypeFlags::ANY) {
                type_name = "any";
            }
            channels.push(format!("{type_name} in the requirements channel"));
        }
        if has_any_unknown_e {
            let mut type_name = "unknown";
            if e_flags.intersects(TypeFlags::ANY) {
                type_name = "any";
            }
            channels.push(format!("{type_name} in the error channel"));
        }

        // Compose the diagnostic message
        let mut suggestions: Vec<String> = Vec::new();
        suggestions.push(format!(
            "This has {} which is not recommended.",
            channels.join(" and ")
        ));
        if has_any_unknown_r {
            suggestions.push(
                "Only service identifiers should appear in the requirements channel.".to_string(),
            );
        }
        if has_any_unknown_e {
            suggestions.push("Having an unknown or any error type is not useful. Consider instead using specific error types baked by Data.TaggedError for example.".to_string());
        }
        let message_text = suggestions.join("\n");

        let node_start = get_token_pos_of_node(node, ctx.source_file, false);
        let node_end = node.end();

        // Innermost-node deduplication: remove parent nodes that contain this node
        let mut i = matches.len();
        while i > 0 {
            i -= 1;
            if matches[i].start <= node_start && matches[i].end >= node_end {
                matches.remove(i);
            }
        }

        matches.push(MatchEntry {
            node,
            message_text,
            start: node_start,
            end: node_end,
        });
    }

    // Report all innermost matching nodes
    let mut diags: Vec<Diagnostic> = Vec::new();
    for m in matches {
        diags.push(ctx.new_diagnostic(
            get_source_file_of_node(m.node),
            ctx.get_error_range(m.node),
            diag::X_0_effect_anyUnknownInErrorContext,
            Vec::new(),
            vec![m.message_text],
        ));
    }

    diags
}
