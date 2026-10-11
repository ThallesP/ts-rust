//! Ports of small Effect-TS/tsgo unit tests of the API stability engine, at
//! `@effect/tsgo@0.51.1` (`47cb1ed7`, `internal/typeparser`; R190 reviewer
//! item 4): the Safe verdict memo, the guard budget, settle after the budget,
//! the declared and shared cache keys, the session signature memo, the
//! incomplete result and the inheritance minimum. They read the engine state
//! that the CLI output cannot show. `scripts/effect/go-unit-cases.mjs`
//! compares the CLI output of every Go test source with effect-tsgo.
//!
//! PORT: a Go `t.Run` subtest that makes a program of its own is a test of
//! its own here: a program and the OS override are process-wide, so each
//! test runs in a child process (`childprog`). Go `primeApiStabilityChecker`
//! (`program.GetSemanticDiagnostics(ctx, nil)`) checks each root file with
//! the test's checker (`prime`): with `skipDefaultLibCheck` the lib files are
//! not checked, and the single-threaded program has only that checker. Go
//! `TestApiStabilityCacheDifferentCheckerIsolation` and
//! `TestApiStabilitySignatureCacheIsolation` need two programs at once and
//! are not ported.

use super::childprog::{in_child, install_map_fs, source_file};
use crate::support::vfstest::MapFs;
use ts_goport::effect::typeparser::checker_integration::get_resolved_members_of_type_if_materialized;
use ts_goport::effect::typeparser::*;
use ts_goport::frontend::bundled;
use ts_goport::frontend::compiler::{ProgramOptions, new_compiler_host};
use ts_goport::frontend::tsoptions::{ParsedCommandLine, ParsedOptions};
use ts_goport::gostd::context;
use ts_goport::prelude::*;
use ts_goport::program::ls_program;

const TEST_FILE: &str = "/.src/test.ts";

// Go: typeparser/helpers_test.go:20 compileAndGetCheckerAndSourceFilesInternal
/// A single-threaded program of `sources` with the Go test options. `body`
/// gets a type parser over the program's checker and the source file of each
/// root (a `.ts` file outside `node_modules`), in `sources` order.
fn with_type_parser(sources: &[(&str, &str)], body: impl FnOnce(&mut TypeParser<'_>, &[Node])) {
    let map_fs = MapFs::from_map(
        sources.iter().copied(),
        true, /*useCaseSensitiveFileNames*/
    );
    install_map_fs(&map_fs, "/");
    let file_names: Vec<String> = sources
        .iter()
        .map(|&(path, _)| path)
        .filter(|path| !path.contains("/node_modules/") && path.ends_with(".ts"))
        .map(str::to_string)
        .collect();
    let options = CompilerOptions {
        new_line: NewLineKind::LF,
        skip_default_lib_check: Tristate::True,
        no_error_truncation: Tristate::True,
        target: ScriptTarget::ES_NEXT,
        module: ModuleKind::NODE_NEXT,
        module_resolution: ModuleResolutionKind::NODE_NEXT,
        strict: Tristate::True,
        ..Default::default()
    };
    let config = ParsedCommandLine {
        parsed_config: ParsedOptions {
            compiler_options: Rc::new(options),
            file_names: file_names.clone(),
            ..Default::default()
        },
        ..Default::default()
    };
    let host = new_compiler_host(
        "/",
        bundled::wrap_fs(map_fs.fs()),
        &bundled::lib_path(),
        None,
        None,
        None,
    );
    let p = ls_program::new_program(
        ProgramOptions {
            host,
            config: Rc::new(config),
            use_source_of_project_reference: false,
            single_threaded: Tristate::True,
            typings_location: String::new(),
            project_name: String::new(),
            create_module_resolver: None,
            skip_module_resolution: false,
        },
        None,
    );
    let _current = ls_program::enter(&p);
    ls_program::bind_source_files(&p);
    let files: Vec<Node> = file_names
        .iter()
        .map(|name| source_file(&p, name).root)
        .collect();
    let (checker, done) = ls_program::get_type_checker(&p, &context::background());
    {
        let mut c = checker.borrow_mut();
        let program = c.program;
        let mut tp = TypeParser::new(program, &mut c);
        body(&mut tp, &files);
    }
    done.call();
}

// Go: typeparser/api_stability_test.go:52 primeApiStabilityChecker
fn prime(tp: &mut TypeParser<'_>, files: &[Node]) {
    let ctx = context::background();
    for &file in files {
        tp.checker.get_diagnostics(&ctx, file, false);
    }
}

// Go: typeparser/api_stability_test.go:15 apiStabilityTestExport
fn export(tp: &mut TypeParser<'_>, sf: Node, name: &str) -> SymbolId {
    let c = &mut *tp.checker;
    let module = c.get_symbol_of_declaration(sf);
    assert!(module.is_some(), "no module symbol");
    c.get_exports_of_module_exported(module)
        .into_iter()
        .find(|&symbol| symbol.is_some() && c.sym(symbol).name == name)
        .unwrap_or_else(|| panic!("export {name:?} not found"))
}

// Go: typeparser/api_stability_test.go:426 apiStabilityTestSignatures
fn call_signatures(tp: &mut TypeParser<'_>, symbol: SymbolId) -> Vec<SignatureId> {
    let t = tp.checker.get_type_of_symbol_exported(symbol);
    let signatures = tp
        .checker
        .get_signatures_of_type_exported(t, SignatureKind::CALL);
    assert!(!signatures.is_empty(), "symbol has no call signatures");
    signatures
}

// Go: typeparser/api_stability_test.go:30 apiStabilityDependencyNames
fn dependency_names(tp: &TypeParser<'_>, used: &ApiStabilityUsed) -> Vec<String> {
    used.dependencies
        .iter()
        .map(|dependency| api_stability_dependency_name(&*tp.checker, dependency))
        .collect()
}

// Go: typeparser/api_stability_test.go:38 containsDependency
fn contains_dependency(tp: &TypeParser<'_>, used: &ApiStabilityUsed, name: &str) -> bool {
    dependency_names(tp, used).iter().any(|n| n == name)
}

/// The type parser's published snapshot key of `t` (Go
/// `apiStabilitySharedTypeEntry`, api_stability_surface_test.go:1186).
fn shared_type_published(tp: &mut TypeParser<'_>, t: TypeId) -> bool {
    let key = ApiStabilitySurfaceTypeKey {
        t,
        inspect: ApiStabilityInspection::Expand,
    };
    tp.links().api_stability_surface_type.contains_key(&key)
}

// Go: typeparser/api_stability_safety_test.go:264 TestApiStabilitySafetyMaterializedReferenceSkipsGuard
#[test]
fn test_api_stability_safety_materialized_reference_skips_guard() {
    in_child(
        module_path!(),
        "test_api_stability_safety_materialized_reference_skips_guard",
        || {
            let source = r#"export interface Box<A> { value: A }; export const box: Box<string> = { value: "x" }"#;
            with_type_parser(&[(TEST_FILE, source)], |tp, files| {
                prime(tp, files);
                let symbol = export(tp, files[0], "box");
                let t = tp.checker.get_type_of_symbol_exported(symbol);
                tp.checker.get_properties_of_type_exported(t);
                assert!(
                    get_resolved_members_of_type_if_materialized(&*tp.checker, t).1,
                    "member table should be materialized"
                );
                let mut analysis = new_api_stability_analysis(tp);
                let mut surface = new_api_stability_surface();
                analysis.collect_concrete_reference_surface(tp, &mut surface, t);
                assert_eq!(
                    analysis.safety_work, 0,
                    "materialized reference consumed guard work units"
                );
                assert!(
                    surface.complete && !surface.blocked,
                    "materialized reference surface should be complete, got complete={} blocked={}",
                    surface.complete,
                    surface.blocked
                );
            });
        },
    );
}

// Go: typeparser/api_stability_safety_test.go:292 TestApiStabilitySafetySafeVerdictIsReused
#[test]
fn test_api_stability_safety_safe_verdict_is_reused() {
    in_child(
        module_path!(),
        "test_api_stability_safety_safe_verdict_is_reused",
        || {
            let source = "export interface Box<A> { value: A; map(fn: (value: A) => A): Box<A> }";
            with_type_parser(&[(TEST_FILE, source)], |tp, files| {
                let symbol = export(tp, files[0], "Box");
                let declaration = tp.checker.get_declared_type_of_symbol_exported(symbol);
                assert!(declaration.is_some(), "declared type missing");
                let mut analysis = new_api_stability_analysis(tp);
                let empty = ApiStabilitySubstitution::default();
                assert!(
                    analysis.member_table_resolution_is_safe(tp, declaration, &empty),
                    "bounded interface member table should be safe"
                );
                let spent = analysis.safety_work;
                assert_ne!(
                    spent, 0,
                    "guard unexpectedly consumed no budget on the first request"
                );
                assert!(
                    analysis.member_table_resolution_is_safe(tp, declaration, &empty),
                    "repeated guard request must stay safe"
                );
                assert_eq!(
                    analysis.safety_work, spent,
                    "completed Safe verdict was not reused"
                );
                assert!(
                    !analysis.safety_safe_memo.is_empty(),
                    "completed Safe verdict was not recorded"
                );
            });
        },
    );
}

// Go: typeparser/api_stability_safety_test.go:327 TestApiStabilitySafetyPostBudgetRefusalIsCheap
#[test]
fn test_api_stability_safety_post_budget_refusal_is_cheap() {
    in_child(
        module_path!(),
        "test_api_stability_safety_post_budget_refusal_is_cheap",
        || {
            with_type_parser(
                &[(TEST_FILE, "export interface Box<A> { value: A }")],
                |tp, files| {
                    let symbol = export(tp, files[0], "Box");
                    let declaration = tp.checker.get_declared_type_of_symbol_exported(symbol);
                    let mut analysis = new_api_stability_analysis(tp);
                    analysis.safety_work = API_STABILITY_SAFETY_MAX_WORK + 1;
                    let empty = ApiStabilitySubstitution::default();
                    assert!(
                        !analysis.member_table_resolution_is_safe(tp, declaration, &empty),
                        "exhausted analysis must refuse member table resolution"
                    );
                    let type_symbol = tp.checker.ty(declaration).symbol();
                    let first_declaration = tp.checker.sym(type_symbol).declarations[0];
                    assert!(
                        !analysis.annotation_resolution_is_safe(tp, first_declaration, &empty),
                        "exhausted analysis must refuse annotation resolution"
                    );
                    assert_eq!(
                        analysis.safety_work,
                        API_STABILITY_SAFETY_MAX_WORK + 1,
                        "post-budget refusals consumed budget"
                    );
                    assert!(
                        analysis.safety_safe_memo.is_empty(),
                        "post-budget refusals must not publish a Safe verdict"
                    );
                },
            );
        },
    );
}

// Go: typeparser/api_stability_safety_test.go:360 TestApiStabilitySafetySettleSkipsBlockedRecollectionAfterExhaustion
#[test]
fn test_api_stability_safety_settle_skips_blocked_recollection_after_exhaustion() {
    in_child(
        module_path!(),
        "test_api_stability_safety_settle_skips_blocked_recollection_after_exhaustion",
        || {
            with_type_parser(
                &[(TEST_FILE, "export interface Box<A> { value: A }")],
                |tp, files| {
                    let mut analysis = new_api_stability_analysis(tp);
                    let symbol = export(tp, files[0], "Box");
                    let declaration = tp.checker.get_declared_type_of_symbol_exported(symbol);
                    let key = ApiStabilityTypeKey {
                        t: declaration,
                        inspect: ApiStabilityInspection::Expand,
                        ..Default::default()
                    };
                    let mut surface = new_api_stability_surface();
                    surface.block();
                    analysis.store_type_surface(key, surface);
                    analysis.safety_work = API_STABILITY_SAFETY_MAX_WORK + 1;

                    analysis.settle(tp);
                    assert_eq!(
                        analysis.safety_work,
                        API_STABILITY_SAFETY_MAX_WORK + 1,
                        "settle recollection consumed budget after exhaustion"
                    );
                    assert!(
                        !analysis
                            .session_types
                            .get(&key)
                            .is_some_and(|entry| entry.complete),
                        "blocked surface must never settle complete"
                    );
                },
            );
        },
    );
}

// Go: typeparser/api_stability_safety_test.go:388 TestApiStabilitySafetyTypeNameLookupCacheIsIdentitySafe
#[test]
fn test_api_stability_safety_type_name_lookup_cache_is_identity_safe() {
    in_child(
        module_path!(),
        "test_api_stability_safety_type_name_lookup_cache_is_identity_safe",
        || {
            let source = "/** @stability experimental */\ninterface E { value: string }\nexport declare function consume(x: E): E";
            with_type_parser(&[(TEST_FILE, source)], |tp, files| {
                tp.checker
                    .get_diagnostics(&context::background(), files[0], false);
                let mut analysis = new_api_stability_analysis(tp);
                let declaration = files[0].statements().get(1);
                let type_name = declaration.parameters().get(0).type_().type_name();
                let first = analysis.symbol_at_type_name_node(tp, type_name);
                assert!(first.is_some(), "type name lookup failed");
                assert_eq!(
                    analysis.symbol_at_type_name_node(tp, type_name),
                    first,
                    "cached lookup changed identity"
                );
                assert_eq!(
                    analysis.type_name_symbols.get(&type_name),
                    Some(&first),
                    "successful lookup was not cached by AST identity"
                );
                assert!(
                    analysis.symbol_at_type_name_node(tp, Node::NIL).is_nil(),
                    "nil node must not resolve"
                );
                assert_eq!(
                    analysis.type_name_symbols.len(),
                    1,
                    "failed or nil lookups must not be cached"
                );
            });
        },
    );
}

// Go: typeparser/api_stability_test.go:311 TestApiStabilityCacheGenericArgumentsDoNotContaminate
fn cache_generic_arguments_do_not_contaminate(leaky_first: bool) {
    let leaky = "export type Leaky = Box<E>";
    let clean = "export type Clean = Box<string>";
    let declarations = if leaky_first {
        format!("{leaky}\n{clean}")
    } else {
        format!("{clean}\n{leaky}")
    };
    let source = format!(
        "/** @stability experimental */\ninterface E {{ value: string }}\ninterface Box<T> {{ value: T }}\n{declarations}\n"
    );
    with_type_parser(&[(TEST_FILE, source.as_str())], |tp, files| {
        prime(tp, files);
        let leaky = export(tp, files[0], "Leaky");
        let clean = export(tp, files[0], "Clean");
        let leaky_used = tp.api_stability_used_by_symbol(leaky);
        assert!(
            contains_dependency(tp, &leaky_used, "E"),
            "Box<E> should expose E"
        );
        let clean_used = tp.api_stability_used_by_symbol(clean);
        assert!(
            !contains_dependency(tp, &clean_used, "E"),
            "Box<string> must not inherit E, got {:?}",
            dependency_names(tp, &clean_used)
        );
    });
}

// Go: the "leaky-first" subtest.
#[test]
fn test_api_stability_cache_generic_arguments_do_not_contaminate_leaky_first() {
    in_child(
        module_path!(),
        "test_api_stability_cache_generic_arguments_do_not_contaminate_leaky_first",
        || cache_generic_arguments_do_not_contaminate(true),
    );
}

// Go: the "clean-first" subtest.
#[test]
fn test_api_stability_cache_generic_arguments_do_not_contaminate_clean_first() {
    in_child(
        module_path!(),
        "test_api_stability_cache_generic_arguments_do_not_contaminate_clean_first",
        || cache_generic_arguments_do_not_contaminate(false),
    );
}

// Go: typeparser/api_stability_test.go:392 TestApiStabilitySignatureDeclaredCacheKeepsOverloadsDistinct
#[test]
fn test_api_stability_signature_declared_cache_keeps_overloads_distinct() {
    in_child(
        module_path!(),
        "test_api_stability_signature_declared_cache_keeps_overloads_distinct",
        || {
            let source = "export function f(x: string): string\n/** @stability unstable */\nexport function f(x: number): string\nexport function f(x: string | number): string { return \"\" }\n";
            with_type_parser(&[(TEST_FILE, source)], |tp, files| {
                let f = export(tp, files[0], "f");
                let signatures = call_signatures(tp, f);
                assert_eq!(signatures.len(), 2, "expected two public overloads");
                let first = tp.declared_api_stability_of_signature(signatures[0]);
                let second = tp.declared_api_stability_of_signature(signatures[1]);
                assert_ne!(
                    first.level, second.level,
                    "distinct overload tags collapsed"
                );
                assert_eq!(
                    (first.level, second.level),
                    (ApiStabilityLevel::Stable, ApiStabilityLevel::Unstable),
                    "unexpected overload levels"
                );
                for signature in signatures {
                    let raw = raw_signature(&*tp.checker, signature);
                    assert!(
                        tp.links()
                            .api_stability_declared_signature
                            .contains_key(&raw),
                        "both overload declarations should be cached separately"
                    );
                }
            });
        },
    );
}

// Go: typeparser/api_stability_test.go:441 TestApiStabilitySignatureSurfaceRetainsSubstitution
#[test]
fn test_api_stability_signature_surface_retains_substitution() {
    in_child(
        module_path!(),
        "test_api_stability_signature_surface_retains_substitution",
        || {
            let source = "/** @stability experimental */\ninterface E { value: string }\ndeclare function make<T>(): (x: T) => T\nexport const f = make<E>()\n";
            with_type_parser(&[(TEST_FILE, source)], |tp, files| {
                let f = export(tp, files[0], "f");
                let instantiated = call_signatures(tp, f)[0];

                let mut session = tp.new_api_stability_session();
                let computed = session.used_by_signature(tp, instantiated);
                assert!(
                    contains_dependency(tp, &computed, "E"),
                    "instantiated signature should expose E, got {:?}",
                    dependency_names(tp, &computed)
                );
                let key = ApiStabilitySignatureKey {
                    signature: instantiated,
                    ..Default::default()
                };
                let analysis = session.analysis.as_deref().expect("session analysis");
                assert!(
                    analysis
                        .session_signatures
                        .get(&key)
                        .is_some_and(|surface| surface.complete),
                    "completed signature surface should be memoized in the session"
                );
                let work = analysis.work;
                let repeat = session.used_by_signature(tp, instantiated);
                assert!(
                    contains_dependency(tp, &repeat, "E"),
                    "repeated session query lost E, got {:?}",
                    dependency_names(tp, &repeat)
                );
                assert_eq!(
                    session.analysis.as_deref().expect("session analysis").work,
                    work,
                    "repeated session query recomputed the memoized signature surface"
                );

                // The raw target's type parameter is not an experimental
                // dependency, so the shallow form must not report E.
                let raw = raw_signature(&*tp.checker, instantiated);
                assert_ne!(
                    raw, instantiated,
                    "expected an instantiated signature with a raw target"
                );
                let shallow = tp.api_stability_used_by_signature(raw);
                assert!(
                    !contains_dependency(tp, &shallow, "E"),
                    "raw target should stay shallow, got {:?}",
                    dependency_names(tp, &shallow)
                );
            });
        },
    );
}

// Go: typeparser/api_stability_test.go:1132 TestApiStabilitySettleSkipRequiresNoAdvancement
#[test]
fn test_api_stability_settle_skip_requires_no_advancement() {
    in_child(
        module_path!(),
        "test_api_stability_settle_skip_requires_no_advancement",
        || {
            with_type_parser(
                &[(TEST_FILE, "export interface Box<A> { value: A }")],
                |tp, _| {
                    let mut analysis = new_api_stability_analysis(tp);
                    let mut surface = new_api_stability_surface();
                    surface.block();

                    assert!(
                        !analysis.settle_cannot_advance(&surface),
                        "a surface must not be skipped while the guard budget is available"
                    );
                    analysis.safety_work = API_STABILITY_SAFETY_MAX_WORK + 1;
                    surface.observed_epoch = 7;
                    analysis.materialization_epoch = 7;
                    assert!(
                        analysis.settle_cannot_advance(&surface),
                        "a blocked surface with no advancement since collection must be skipped"
                    );
                    analysis.materialization_epoch = 8;
                    assert!(
                        !analysis.settle_cannot_advance(&surface),
                        "a materialization advancement must force a recollection"
                    );
                    analysis.materialization_epoch = 7;
                    let mut complete = new_api_stability_surface();
                    complete.observed_epoch = 7;
                    assert!(
                        !analysis.settle_cannot_advance(&complete),
                        "only blocked surfaces are skipped"
                    );
                },
            );
        },
    );
}

// Go: typeparser/api_stability_test.go:1492 TestApiStabilityIncompleteIsNotStable
#[test]
fn test_api_stability_incomplete_is_not_stable() {
    in_child(
        module_path!(),
        "test_api_stability_incomplete_is_not_stable",
        || {
            let source = "/** @stability experimental */\ninterface E { value: string }\nexport interface WellKnownOnly { plain: number; [Symbol.iterator](): E }\n";
            with_type_parser(&[(TEST_FILE, source)], |tp, files| {
                let symbol = export(tp, files[0], "WellKnownOnly");
                let declared = tp.checker.get_declared_type_of_symbol_exported(symbol);
                let cold = tp.api_stability_used_by_symbol(symbol);
                assert!(
                    cold.incomplete,
                    "an unmaterialized computed member must report an incomplete result"
                );
                assert!(
                    !shared_type_published(tp, declared),
                    "an incomplete result must never be published"
                );

                prime(tp, files);
                let warm = TypeParser::new(tp.program, &mut *tp.checker)
                    .api_stability_used_by_symbol(symbol);
                assert!(
                    !warm.incomplete && contains_dependency(tp, &warm, "E"),
                    "the materialized retry should settle complete with E, got {:?} (incomplete={})",
                    dependency_names(tp, &warm),
                    warm.incomplete
                );
                assert!(
                    shared_type_published(tp, declared),
                    "the materialized retry should publish its complete surface"
                );
            });
        },
    );
}

// Go: typeparser/api_stability_inheritance_test.go:5 TestApiStabilityInheritanceMinimumAndCacheIsolation
fn inheritance_minimum_and_cache_isolation(warm: bool) {
    let source = "/** @stability unstable */\ninterface Reportable {\n/** @stability experimental */ test?: string }\ndeclare global { interface Error extends Reportable {} }\nexport function augmented(e: Error) {}\nexport interface Expanded extends Error {}\nexport interface Ordinary extends Reportable {}\nexport function direct(e: Reportable) {}\n";
    with_type_parser(&[(TEST_FILE, source)], |tp, files| {
        if warm {
            prime(tp, files);
        }
        // Go `t.Errorf`: every failure is reported, then the test fails.
        let mut errors = Vec::new();
        // Repeat with opposite root orders so neither shared surfaces nor an
        // analysis-local result can erase a directly exposed dependency.
        for order in [
            ["augmented", "Expanded", "direct", "Ordinary"],
            ["Ordinary", "direct", "Expanded", "augmented"],
        ] {
            for name in order {
                let symbol = export(tp, files[0], name);
                if warm && name == "Expanded" {
                    let t = tp.checker.get_declared_type_of_symbol_exported(symbol);
                    tp.checker.get_properties_of_type_exported(t);
                }
                let used = tp.api_stability_used_by_symbol(symbol);
                let want = if name == "direct" {
                    ApiStabilityLevel::Unstable
                } else {
                    ApiStabilityLevel::Stable
                };
                if used.minimum != want || (warm && used.incomplete) {
                    errors.push(format!(
                        "{name} minimum={:?} incomplete={} deps={:?}, want {want:?}",
                        used.minimum,
                        used.incomplete,
                        dependency_names(tp, &used)
                    ));
                }
                if name == "Expanded" {
                    // Also inspect its represented type after the compiler has
                    // flattened the inherited member table.
                    let t = tp.checker.get_declared_type_of_symbol_exported(symbol);
                    tp.checker.get_properties_of_type_exported(t);
                    let used = tp.api_stability_used_by_type(t);
                    if used.incomplete || used.minimum != ApiStabilityLevel::Stable {
                        errors.push(format!(
                            "expanded type minimum={:?} incomplete={} deps={:?}",
                            used.minimum,
                            used.incomplete,
                            dependency_names(tp, &used)
                        ));
                    }
                }
            }
        }
        assert!(errors.is_empty(), "{}", errors.join("\n"));
    });
}

// Go: the "cold" subtest.
#[test]
fn test_api_stability_inheritance_minimum_and_cache_isolation_cold() {
    in_child(
        module_path!(),
        "test_api_stability_inheritance_minimum_and_cache_isolation_cold",
        || inheritance_minimum_and_cache_isolation(false),
    );
}

// Go: the "warm" subtest.
#[test]
fn test_api_stability_inheritance_minimum_and_cache_isolation_warm() {
    in_child(
        module_path!(),
        "test_api_stability_inheritance_minimum_and_cache_isolation_warm",
        || inheritance_minimum_and_cache_isolation(true),
    );
}

// Go: typeparser/api_stability_surface_test.go:282 TestApiStabilityOverloadTagsStayDistinct
#[test]
fn test_api_stability_overload_tags_stay_distinct() {
    in_child(
        module_path!(),
        "test_api_stability_overload_tags_stay_distinct",
        || {
            let source = "/** @stability unstable */\nexport function mixed(x: string): string\n/** @stability experimental */\nexport function mixed(x: number): number\nexport function mixed(x: string | number): string | number { return \"\" }\n\nexport function other(x: string): string\n/** @stability experimental */\nexport function other(x: number): number\nexport function other(x: string | number): string | number { return \"\" }\n";
            with_type_parser(&[(TEST_FILE, source)], |tp, files| {
                prime(tp, files);
                let mut session = tp.new_api_stability_session();

                let mixed = export(tp, files[0], "mixed");
                assert_eq!(
                    tp.declared_api_stability_of_symbol(mixed).level,
                    ApiStabilityLevel::Unstable,
                    "mixed declared, want unstable (the first tagged own declaration)"
                );
                let signatures = call_signatures(tp, mixed);
                assert_eq!(signatures.len(), 2, "expected two public overloads");
                assert_eq!(
                    (
                        tp.declared_api_stability_of_signature(signatures[0]).level,
                        tp.declared_api_stability_of_signature(signatures[1]).level
                    ),
                    (ApiStabilityLevel::Unstable, ApiStabilityLevel::Experimental),
                    "overload tags collapsed"
                );

                // The unstable overload is the declared own tag and is
                // excluded; the experimental overload is another declaration
                // and contributes as a child.
                let mixed_used = session.used_by_symbol(tp, mixed);
                assert!(
                    !mixed_used.incomplete && mixed_used.minimum == ApiStabilityLevel::Experimental,
                    "mixed surface = {:?}/{:?}, want experimental from the other overload",
                    mixed_used.minimum,
                    dependency_names(tp, &mixed_used)
                );
                let own = raw_signature(&*tp.checker, signatures[0]);
                let mut found_experimental = false;
                for dependency in &mixed_used.dependencies {
                    if dependency.signature.is_some() {
                        found_experimental |= dependency.level == ApiStabilityLevel::Experimental;
                        assert_ne!(
                            raw_signature(&*tp.checker, dependency.signature),
                            own,
                            "the declared own overload leaked into the surface: {:?}",
                            dependency_names(tp, &mixed_used)
                        );
                    }
                }
                assert!(
                    found_experimental,
                    "the experimental overload should stay an exposed child, got {:?}",
                    dependency_names(tp, &mixed_used)
                );

                // Each overload's own tag is excluded from its own signature
                // surface; the stable parameter/return types expose nothing.
                for (index, signature) in signatures.into_iter().enumerate() {
                    let used = session.used_by_signature(tp, signature);
                    assert!(
                        !used.incomplete
                            && used.minimum == ApiStabilityLevel::Stable
                            && used.dependencies.is_empty(),
                        "overload {index} own tag must be excluded, got min={:?} deps={:?}",
                        used.minimum,
                        dependency_names(tp, &used)
                    );
                }

                // When the symbol-level declared tag is the only tagged own
                // declaration, the whole symbol surface has no child findings.
                let other = export(tp, files[0], "other");
                assert_eq!(
                    tp.declared_api_stability_of_symbol(other).level,
                    ApiStabilityLevel::Experimental,
                    "other declared, want experimental"
                );
                let other_used = session.used_by_symbol(tp, other);
                assert!(
                    !other_used.incomplete
                        && other_used.minimum == ApiStabilityLevel::Stable
                        && other_used.dependencies.is_empty(),
                    "other's only tag is its own declared tag, got min={:?} deps={:?}",
                    other_used.minimum,
                    dependency_names(tp, &other_used)
                );
            });
        },
    );
}
