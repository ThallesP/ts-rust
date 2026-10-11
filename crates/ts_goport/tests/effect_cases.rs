//! The Effect diagnostic cases of Effect-TS/tsgo 0.51.1 (issue #43), one test
//! per case: `<suite>::<case>`. `effect_cases/<suite>.txt` holds the cases of
//! a suite: the project files, the `tsc` command and the expected output,
//! which the reference binary (effect-tsgo 0.51.1 `tsc`) printed.
//! `scripts/effect/gen-effect-cases.mjs` writes those files and `names.rs`
//! (its header gives the format). Do not edit them by hand: run it again.
//!
//! Suites:
//! - `go_unit`: the inline sources of the Go unit tests of the API stability
//!   rules, and the config tables of the Go `unknownRuleName` tests.
//! - `effect_v3`, `effect_v4`: the cases of `testdata/tests/effect-v3` and
//!   `effect-v4`, diagnostics only. They import the pinned Effect packages.
//!   `<suite>.modules.gz` holds the files of those packages that the cases
//!   load. The first test of a suite unpacks it into the system temp dir
//!   (`goport-effect-modules-<hash>`, kept for later runs), and each case
//!   links `node_modules/<package>` to it.
//!
//! A test writes its case into a new dir under the system temp dir and runs
//! `tsgo -p <config> --pretty false` in it, and `--pretty true` when the case
//! has a pretty output (related information). It compares stdout, and
//! success or failure (not the exit code: with errors and `--noEmit` our pin
//! exits 2 where TS 7.0 exits 1). In stdout, ANSI codes are removed, the case
//! dir is `<case>` and the unpacked `node_modules` (absolute or relative to the
//! cwd) is `<modules>`.
//! A passing test deletes its dir; a failing one keeps it and names it.
#![cfg(unix)]

use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{LazyLock, OnceLock};

/// The case files.
const DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/effect_cases");

/// The start of a section line in the case files and the packs.
const MARK: &str = "#### ";

/// One test per case: `mod <suite>` with a test fn per case and `NAMES`.
macro_rules! suite {
    ($suite:ident: $($case:ident,)*) => {
        #[allow(non_snake_case)]
        mod $suite {
            pub const NAMES: &[&str] = &[$(stringify!($case)),*];
            $(
                #[test]
                fn $case() {
                    super::run(stringify!($suite), stringify!($case));
                }
            )*
        }
    };
}

include!("effect_cases/names.rs");

/// A case of a suite file.
#[derive(Default)]
struct Case {
    origin: String,
    /// `node_modules/<package>` links to the unpacked pack.
    links: Vec<String>,
    /// Path (relative to the case dir) and text.
    files: Vec<(String, String)>,
    /// Where `tsgo` runs, relative to the case dir.
    cwd: String,
    /// The `-p` argument, relative to `cwd`.
    config: String,
    fails: bool,
    out: String,
    pretty: Option<String>,
}

struct Suite {
    /// The case names in file order.
    names: Vec<String>,
    cases: HashMap<String, Case>,
    /// The unpacked `<suite>.modules.gz`, on first use.
    modules: OnceLock<PathBuf>,
}

/// Every suite of `SUITE_NAMES`, parsed.
static SUITES: LazyLock<HashMap<&str, Suite>> = LazyLock::new(|| {
    SUITE_NAMES
        .iter()
        .map(|&(suite, _)| (suite, parse_suite(&read_text(&format!("{suite}.txt")))))
        .collect()
});

fn read_text(name: &str) -> String {
    let path = Path::new(DIR).join(name);
    fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()))
}

/// The sections of a case file or a pack: a line that starts with `MARK`
/// starts one, and the lines up to the next one are its content.
fn sections(text: &str) -> Vec<(&str, String)> {
    let mut result: Vec<(&str, Vec<&str>)> = Vec::new();
    for line in text.strip_suffix('\n').unwrap_or(text).split('\n') {
        if let Some(marker) = line.strip_prefix(MARK) {
            result.push((marker, Vec::new()));
        } else if let Some((_, lines)) = result.last_mut() {
            lines.push(line);
        }
    }
    result
        .into_iter()
        .map(|(marker, lines)| (marker, lines.join("\n")))
        .collect()
}

fn parse_suite(text: &str) -> Suite {
    let mut names: Vec<String> = Vec::new();
    let mut cases: HashMap<String, Case> = HashMap::new();
    for (marker, content) in sections(text) {
        let (kind, rest) = marker.split_once(' ').unwrap_or((marker, ""));
        if kind == "case" {
            let (name, origin) = rest.split_once(' ').expect("case <name> <origin>");
            let case = Case {
                origin: origin.to_string(),
                ..Case::default()
            };
            assert!(
                cases.insert(name.to_string(), case).is_none(),
                "two cases {name}"
            );
            names.push(name.to_string());
            continue;
        }
        let name = names.last().expect("a section before the first case");
        let case = cases.get_mut(name).expect("the current case");
        match kind {
            "links" => case.links = rest.split(' ').map(str::to_string).collect(),
            "file" => case.files.push((rest.to_string(), content)),
            "run" => {
                let (cwd, config) = rest.split_once(' ').expect("run <cwd> <config>");
                case.cwd = cwd.to_string();
                case.config = config.to_string();
            }
            "out" => {
                case.fails = rest == "fail";
                case.out = content;
            }
            "pretty" => case.pretty = Some(content),
            _ => panic!("{name}: unknown section {marker}"),
        }
    }
    Suite {
        names,
        cases,
        modules: OnceLock::new(),
    }
}

/// Unpacks `<suite>.modules.gz` into `<temp>/goport-effect-modules-<hash>`
/// and returns its `node_modules` dir. A dir of an earlier run is used when
/// every file is there with its size; else it is written again. A lock file
/// keeps two test processes apart.
fn unpack(suite: &str) -> PathBuf {
    let pack = Path::new(DIR).join(format!("{suite}.modules.gz"));
    let gz = fs::read(&pack).unwrap_or_else(|e| panic!("read {}: {e}", pack.display()));
    let mut text = String::new();
    flate2::read::GzDecoder::new(gz.as_slice())
        .read_to_string(&mut text)
        .unwrap_or_else(|e| panic!("gunzip {}: {e}", pack.display()));
    let files: Vec<(String, String)> = sections(&text)
        .into_iter()
        .map(|(marker, content)| {
            let path = marker.strip_prefix("file ").expect("a file section");
            (path.to_string(), content)
        })
        .collect();
    let name = format!(
        "goport-effect-modules-{:016x}",
        xxhash_rust::xxh3::xxh3_64(&gz)
    );
    let root = std::env::temp_dir().join(&name);
    let lock_path = std::env::temp_dir().join(format!("{name}.lock"));
    let lock = fs::File::create(&lock_path)
        .unwrap_or_else(|e| panic!("create {}: {e}", lock_path.display()));
    lock.lock()
        .unwrap_or_else(|e| panic!("lock {}: {e}", lock_path.display()));
    let modules = root.join("node_modules");
    let complete = files.iter().all(|(path, content)| {
        fs::metadata(modules.join(path)).is_ok_and(|m| m.len() == content.len() as u64)
    });
    if !complete {
        if root.exists() {
            fs::remove_dir_all(&root).unwrap_or_else(|e| panic!("remove {}: {e}", root.display()));
        }
        for (path, content) in &files {
            write_file(&modules.join(path), content);
        }
    }
    drop(lock);
    fs::canonicalize(&modules).unwrap_or_else(|e| panic!("{}: {e}", modules.display()))
}

fn write_file(path: &Path, text: &str) {
    let parent = path.parent().expect("a parent dir");
    fs::create_dir_all(parent).unwrap_or_else(|e| panic!("mkdir {}: {e}", parent.display()));
    fs::write(path, text).unwrap_or_else(|e| panic!("write {}: {e}", path.display()));
}

/// What `tsgo` printed, and whether it failed.
struct Output {
    fails: bool,
    stdout: String,
}

fn tsgo(cwd: &Path, config: &str, pretty: bool) -> Output {
    let output = Command::new(env!("CARGO_BIN_EXE_tsgo"))
        .args([
            "-p",
            config,
            "--pretty",
            if pretty { "true" } else { "false" },
        ])
        .current_dir(cwd)
        .output()
        .unwrap_or_else(|e| panic!("run tsgo in {}: {e}", cwd.display()));
    // 0: no errors; 1 and 2: diagnostics. Anything else is a crash.
    assert!(
        matches!(output.status.code(), Some(0..=2)),
        "tsgo -p {config} in {} ended with {}:\n{}",
        cwd.display(),
        output.status,
        String::from_utf8_lossy(&output.stderr)
    );
    Output {
        fails: !output.status.success(),
        stdout: String::from_utf8(output.stdout).expect("UTF-8 stdout"),
    }
}

/// `text` without the ANSI color codes (`ESC [ <digits and ;> m`).
fn strip_ansi(text: &str) -> String {
    let mut result = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find("\x1b[") {
        result.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let end = after
            .find(|c: char| !(c.is_ascii_digit() || c == ';'))
            .unwrap_or(after.len());
        if after[end..].starts_with('m') {
            rest = &after[end + 1..];
        } else {
            result.push_str("\x1b[");
            rest = after;
        }
    }
    result.push_str(rest);
    result
}

/// The path of `to` relative to `from` (both absolute), as `tsgo` prints it.
fn relative(from: &Path, to: &Path) -> String {
    let from: Vec<_> = from.components().collect();
    let to: Vec<_> = to.components().collect();
    let common = from.iter().zip(&to).take_while(|(a, b)| a == b).count();
    let mut parts = vec![String::from(".."); from.len() - common];
    parts.extend(
        to[common..]
            .iter()
            .map(|c| c.as_os_str().to_string_lossy().into_owned()),
    );
    parts.join("/")
}

/// Runs the case `name` of `suite` and compares its outputs.
fn run(suite: &str, name: &str) {
    let data = &SUITES[suite];
    let case = &data.cases[name];
    let dir = std::env::temp_dir().join(format!(
        "goport-effect-case-{}-{suite}-{name}",
        std::process::id()
    ));
    if dir.exists() {
        fs::remove_dir_all(&dir).unwrap_or_else(|e| panic!("remove {}: {e}", dir.display()));
    }
    for (path, text) in &case.files {
        write_file(&dir.join(path), text);
    }
    let modules = (!case.links.is_empty()).then(|| data.modules.get_or_init(|| unpack(suite)));
    for package in &case.links {
        // A package of the case's own files stays.
        let link = dir.join("node_modules").join(package);
        if link.exists() {
            continue;
        }
        let parent = link.parent().expect("a parent dir");
        fs::create_dir_all(parent).unwrap_or_else(|e| panic!("mkdir {}: {e}", parent.display()));
        let target = modules.expect("the unpacked pack").join(package);
        std::os::unix::fs::symlink(&target, &link)
            .unwrap_or_else(|e| panic!("link {}: {e}", link.display()));
    }
    let cwd = dir.join(&case.cwd);
    fs::create_dir_all(&cwd).unwrap_or_else(|e| panic!("mkdir {}: {e}", cwd.display()));
    let real = fs::canonicalize(&dir).unwrap_or_else(|e| panic!("{}: {e}", dir.display()));
    let real_cwd = fs::canonicalize(&cwd).unwrap_or_else(|e| panic!("{}: {e}", cwd.display()));
    let normalize = |text: &str| {
        let text = match modules {
            Some(modules) => text
                .replace(&*modules.to_string_lossy(), "<modules>")
                .replace(&format!("{}/", relative(&real_cwd, modules)), "<modules>/"),
            None => text.to_string(),
        };
        text.replace(&*real.to_string_lossy(), "<case>")
    };

    let mut problems = Vec::new();
    let plain = tsgo(&cwd, &case.config, false);
    if plain.fails != case.fails {
        problems.push(format!(
            "tsgo {}, the reference {}",
            if plain.fails { "failed" } else { "succeeded" },
            if case.fails { "failed" } else { "succeeded" }
        ));
    }
    let out = normalize(&plain.stdout);
    if out != case.out {
        problems.push(format!(
            "--pretty false\n--- expected\n{}\n--- actual\n{out}",
            case.out
        ));
    }
    if let Some(expected) = &case.pretty {
        let pretty = normalize(&strip_ansi(&tsgo(&cwd, &case.config, true).stdout));
        if &pretty != expected {
            problems.push(format!(
                "--pretty true\n--- expected\n{expected}\n--- actual\n{pretty}"
            ));
        }
    }
    assert!(
        problems.is_empty(),
        "{suite}::{name} ({}), project kept in {}:\n{}",
        case.origin,
        dir.display(),
        problems.join("\n")
    );
    fs::remove_dir_all(&dir).unwrap_or_else(|e| panic!("remove {}: {e}", dir.display()));
}

/// `names.rs` names every case of each suite file, in order, and every suite
/// file is in `names.rs`.
#[test]
fn every_case_has_a_test() {
    for &(suite, names) in SUITE_NAMES {
        let parsed: Vec<&str> = SUITES[suite].names.iter().map(String::as_str).collect();
        assert_eq!(
            parsed, names,
            "{suite}.txt against names.rs: run scripts/effect/gen-effect-cases.mjs"
        );
    }
    for entry in fs::read_dir(DIR).expect("the case dir") {
        let name = entry.expect("a dir entry").file_name();
        let name = name.to_string_lossy();
        if let Some(suite) = name.strip_suffix(".txt") {
            assert!(
                SUITE_NAMES.iter().any(|&(s, _)| s == suite),
                "{name} is not in names.rs"
            );
        }
    }
}
