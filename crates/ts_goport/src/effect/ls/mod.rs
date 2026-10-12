//! Port of Effect-TS/tsgo `etslshooks` at effect-tsgo 0.51.1 (`47cb1ed7`):
//! the Effect language service hooks.
//!
//! Go registers each hook in `init()` (`etslshooks/init.go:37-85`), and the
//! patched TypeScript code calls it. The port calls the hook functions here
//! directly from the `ls/*` sites, and each site names its patch:
//!
//! | Patch | Site | Hook |
//! |---|---|---|
//! | 011 | `ls/codeactions.rs` quick fix loop | [`EFFECT_FIX_PROVIDER`] |
//! | 011 | `ls/codeactions.rs` refactor loop | [`EFFECT_REFACTOR_PROVIDER`] |
//! | 012 | `ls/hover.rs` `provide_hover` | [`hover::after_quick_info`] |
//! | 015 | `ls/inlay_hints.rs` `provide_inlay_hint` | [`inlay_hints::after_inlay_hints`] |
//! | 022 | `ls/completions_p1.rs` `provide_completion` | [`after_completion`] |
//! | 024 | `ls/symbols.rs` `get_document_symbols_for_children` | [`after_document_symbols`] |
//! | 017 | `lsp/server.rs` `supported_code_action_kinds` | none: `refactor.rewrite` in the list |
//! | 018, 027 | `ls/autoimport/view.rs` `new_view`, `ls/autoimport/fix.rs` `get_fixes` and `edits` | [`autoimportstyle::new_view_fix_transformer`] |
//!
//! Every hook returns its input at once when the program has no Effect
//! plugin, as in Go. A standalone API process (`tsgo --api`) has the hooks
//! off unless `TSGO_EFFECT_API=1` (`rulerunner::enabled_options`), as for
//! the rules.
//!
//! All the editor features of effect-tsgo 0.51.1 are ported: the Effect
//! hover and the inlay filter (lane E2), the auto-import style (E3), the
//! fixable framework with the disable actions and all 55 fixes (E4, E5a,
//! E5b, E5c), the completions (E6), the Layer hover (E7), the document
//! symbols (E8) and the refactor framework with all 21 refactors (E9a to
//! E9d). Patch 017 (`refactor.rewrite` in the server's code action kinds) is
//! in `lsp/server.rs` `supported_code_action_kinds`, always on (decision D1
//! option B), so the lightbulb, the quick fix menu and the editor
//! "Refactor..." menu show the Effect refactors.

use std::sync::LazyLock;

use crate::effect::pluginoptions::resolve_effect_plugin_options_for_source_file;
use crate::effect::rulerunner::enabled_options;
use crate::effect::typeparser::TypeParser;
use crate::ls::prelude::*;

pub mod autoimportstyle;
pub mod completion;
pub mod completions;
pub mod document_symbols;
pub mod fixable;
pub mod fixables;
pub mod hover;
pub mod inlay_hints;
pub mod refactor;
pub mod refactors;
pub mod rewriter;
pub mod schemagen;

// Go: etslshooks/init.go:87 effectFixProvider
/// The code fix provider for the Effect diagnostic codes.
/// `ls/codeactions.rs` runs it after the built-in providers. It delegates to
/// the fixables of [`fixables::ALL`].
// PORT: Go sets `FixIds`, but nothing reads them, and no Effect action has a
// fix ID, so there is no fix-all.
pub static EFFECT_FIX_PROVIDER: LazyLock<CodeFixProvider> = LazyLock::new(|| CodeFixProvider {
    error_codes: fixables::all_error_codes(),
    get_code_actions: get_effect_code_actions,
    fix_ids: fixables::all_fix_ids(),
    get_all_code_actions: None,
});

// Go: etslshooks/init.go:94 getEffectCodeActions
// getEffectCodeActions finds applicable fixables and collects their code actions.
// PORT: Go `fixCtx.Program == nil` cannot happen in Rust, and
// `GetTypeCheckerForFile` never gives a nil checker. The plugin check is
// `rulerunner::enabled_options`, so a standalone API process without
// `TSGO_EFFECT_API=1` gets no Effect action, as it gets no Effect
// diagnostic.
fn get_effect_code_actions(
    ctx: &Context,
    fix_ctx: &CodeFixContext<'_>,
) -> Result<Vec<CodeAction>, GoError> {
    let Some(parsed_effect_config) = enabled_options(fix_ctx.program.options()) else {
        return Ok(Vec::new());
    };
    let options = resolve_effect_plugin_options_for_source_file(
        parsed_effect_config,
        source_file_file_name(fix_ctx.source_file),
        &fix_ctx.program.options().config_file_path,
        use_case_sensitive_file_names(),
    );

    let (ch, done) =
        ls_program::get_type_checker_for_file(fix_ctx.program, ctx, fix_ctx.source_file);
    let mut actions = Vec::new();
    {
        let mut ch = ch.borrow_mut();
        let program = ch.program;
        let mut tp = TypeParser::new(program, &mut ch);
        let mut f_ctx = fixable::new_context(ctx, fix_ctx, &options, &mut tp);
        for provider in fixables::by_error_code(fix_ctx.error_code) {
            actions.extend((provider.run)(&mut f_ctx));
        }
    }
    done.call();
    Ok(actions)
}

// Go: etslshooks/init.go:128 effectRefactorProvider
/// The refactor provider for the Effect refactors. `ls/codeactions.rs`
/// runs it in its refactor loop.
pub static EFFECT_REFACTOR_PROVIDER: RefactorProvider = RefactorProvider {
    get_refactor_actions: get_effect_refactor_actions,
};

// Go: etslshooks/init.go:133 getEffectRefactorActions
// getEffectRefactorActions iterates all registered refactors and collects their code actions.
// PORT: the plugin check is `rulerunner::enabled_options`, as for the code
// fix provider. One context runs all refactors of [`refactors::ALL`], in
// Go order.
fn get_effect_refactor_actions(
    ctx: &Context,
    file: Node,
    span: TextRange,
    program: &compiler::NewProgram,
    lang_service: &LanguageService,
) -> Result<Vec<CodeAction>, GoError> {
    let Some(effect_config) = enabled_options(program.options()) else {
        return Ok(Vec::new());
    };
    if !effect_config.get_refactors_enabled() {
        return Ok(Vec::new());
    }

    let (ch, done) = ls_program::get_type_checker_for_file(program, ctx, file);
    let mut actions = Vec::new();
    {
        let mut ch = ch.borrow_mut();
        let go_program = ch.program;
        let mut tp = TypeParser::new(go_program, &mut ch);
        let mut r_ctx = refactor::new_context(ctx, file, span, program, lang_service, &mut tp);
        for r in refactors::ALL {
            actions.extend((r.run)(&mut r_ctx));
        }
    }
    done.call();
    Ok(actions)
}

// Go: etslshooks/init.go:155 afterCompletion
/// Called by `ls/completions_p1.rs` after the completion list is built
/// (Effect-TS/tsgo patch 022). Returns the items with the Effect completions
/// of [`completions::ALL`] appended, in that order.
// PORT: Go builds the completion context over `items` and appends each
// provider's results to `items` in the loop; the context keeps the original
// slice as `ExistingItems`. Here the context borrows the items, so the
// results go to a second list, which is appended after the loop (the same
// items in the same order). Go also passes the language service to the
// context, which no provider reads.
pub fn after_completion(
    ctx: &Context,
    sf: Node,
    position: i32,
    mut items: Vec<lsproto::CompletionItem>,
    program: &compiler::NewProgram,
    _lang_service: &LanguageService,
) -> Vec<lsproto::CompletionItem> {
    let Some(effect_config) = enabled_options(program.options()) else {
        return items;
    };
    if !effect_config.get_completions_enabled() {
        return items;
    }

    if completions::ALL.is_empty() {
        return items;
    }

    let (ch, done) = ls_program::get_type_checker_for_file(program, ctx, sf);
    let mut added = Vec::new();
    {
        let mut ch = ch.borrow_mut();
        let tp_program = ch.program;
        let mut tp = TypeParser::new(tp_program, &mut ch);

        let mut completion_ctx =
            completion::new_context(ctx, sf, position, &items, program, &mut tp);

        for c in completions::ALL {
            let results = (c.run)(&mut completion_ctx);
            added.extend(results);
        }
    }
    done.call();

    items.extend(added);
    items
}

// Go: etslshooks/document_symbols.go:20 afterDocumentSymbols, which
// `ls/symbols.rs` calls (patch 024). It lives in `document_symbols.rs`, as in
// Go.
pub(crate) use document_symbols::after_document_symbols;
