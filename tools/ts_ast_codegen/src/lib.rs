//! Generation of Rust AST definitions from TypeScript Go's `ast.json`.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fmt::Write as _;
use std::path::Path;

use serde::Deserialize;

#[derive(Debug, Deserialize)]
struct Schema {
    kinds: Kinds,
    #[serde(default)]
    bases: BTreeMap<String, BaseDef>,
    #[serde(default)]
    nodes: Nodes,
}

#[derive(Debug, Deserialize)]
struct Kinds {
    elements: Vec<KindElement>,
    markers: Vec<KindMarker>,
    #[serde(default)]
    aliases: BTreeMap<String, KindAlias>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BaseDef {
    #[serde(default)]
    extends: Vec<String>,
    #[serde(default)]
    fields: BTreeMap<String, FieldDef>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Nodes {
    definitions: BTreeMap<String, NodeDef>,
    aliases: BTreeMap<String, NodeAlias>,
    #[serde(default)]
    list_aliases: BTreeMap<String, String>,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum NodeAlias {
    Base { base: String },
    Members(Vec<String>),
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
struct NodeDef {
    #[serde(default)]
    kind: Option<StringOrList>,
    extends: Vec<String>,
    #[serde(default)]
    members: Vec<MemberDef>,
    #[serde(default)]
    type_parameters: Vec<TypeParameterDef>,
    #[serde(default)]
    instantiation_aliases: BTreeMap<String, String>,
    #[serde(default)]
    hand_written: bool,
    #[serde(default)]
    hand_written_visitor: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
struct TypeParameterDef {
    name: String,
    constraint: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code, clippy::struct_excessive_bools)] // Mirrors boolean schema attributes.
struct MemberDef {
    name: String,
    #[serde(default)]
    r#type: Option<StringOrList>,
    #[serde(default)]
    inherited: bool,
    #[serde(default)]
    optional: Option<bool>,
    #[serde(default)]
    list: Option<ListKind>,
    #[serde(default)]
    go_only: bool,
    #[serde(default)]
    no_go: bool,
    #[serde(default)]
    no_factory: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code, clippy::struct_excessive_bools)] // Mirrors boolean schema attributes.
struct FieldDef {
    r#type: StringOrList,
    #[serde(default)]
    optional: bool,
    #[serde(default)]
    list: Option<ListKind>,
    #[serde(default)]
    go_only: bool,
    #[serde(default)]
    no_go: bool,
    #[serde(default)]
    no_factory: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(untagged)]
enum StringOrList {
    One(String),
    Many(Vec<String>),
}

#[derive(Clone, Copy, Debug, Deserialize)]
enum ListKind {
    NodeList,
    ModifierList,
    #[serde(rename = "raw")]
    Raw,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum KindElement {
    Name(String),
    Detailed {
        name: Option<String>,
        comment: Option<String>,
    },
}

#[derive(Debug, Deserialize)]
struct KindMarker {
    name: String,
    value: String,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum KindAlias {
    Members(Vec<String>),
    Range { range: [String; 2] },
}

#[derive(Debug)]
struct NamedKind<'a> {
    schema_name: &'a str,
    rust_name: String,
    comment: Option<&'a str>,
    discriminant: u16,
}

/// Generate a complete, dependency-free Rust `SyntaxKind` module.
///
/// # Errors
///
/// Returns an error when the input is not valid JSON, contains more kinds than
/// fit in `u16`, or has invalid/cyclic marker and alias references.
pub fn generate_syntax_kind(json: &str) -> Result<String, String> {
    let schema: Schema = serde_json::from_str(json).map_err(|error| error.to_string())?;
    Generator::new(&schema)?.generate()
}

/// Read an `ast.json` file and generate its Rust `SyntaxKind` module.
///
/// # Errors
///
/// Returns an error when the file cannot be read or its contents cannot be
/// generated.
pub fn generate_syntax_kind_file(path: &Path) -> Result<String, String> {
    let json = std::fs::read_to_string(path)
        .map_err(|error| format!("failed to read {}: {error}", path.display()))?;
    generate_syntax_kind(&json)
}

mod ast;

pub use ast::{generate_ast, generate_ast_file};

struct Generator<'a> {
    schema: &'a Schema,
    kinds: Vec<NamedKind<'a>>,
    kind_names: HashSet<&'a str>,
    markers: HashMap<&'a str, &'a str>,
}

impl<'a> Generator<'a> {
    fn new(schema: &'a Schema) -> Result<Self, String> {
        let mut kinds = Vec::new();
        let mut kind_names = HashSet::new();
        for element in &schema.kinds.elements {
            let (name, comment) = match element {
                KindElement::Name(name) => (Some(name.as_str()), None),
                KindElement::Detailed { name, comment } => (name.as_deref(), comment.as_deref()),
            };
            let Some(name) = name else { continue };
            if !kind_names.insert(name) {
                return Err(format!("duplicate SyntaxKind {name}"));
            }
            let discriminant = u16::try_from(kinds.len())
                .map_err(|_| "SyntaxKind count exceeds u16".to_owned())?;
            kinds.push(NamedKind {
                schema_name: name,
                rust_name: rust_type_name(name),
                comment,
                discriminant,
            });
        }

        let markers: HashMap<_, _> = schema
            .kinds
            .markers
            .iter()
            .map(|marker| (marker.name.as_str(), marker.value.as_str()))
            .collect();
        if markers.len() != schema.kinds.markers.len() {
            return Err("duplicate SyntaxKind marker".to_owned());
        }

        let generator = Self {
            schema,
            kinds,
            kind_names,
            markers,
        };
        generator.validate()?;
        Ok(generator)
    }

    fn validate(&self) -> Result<(), String> {
        let mut rust_names = HashSet::new();
        for kind in &self.kinds {
            if !rust_names.insert(kind.rust_name.as_str()) {
                return Err(format!(
                    "SyntaxKind names collide after Rust normalization: {}",
                    kind.rust_name
                ));
            }
        }
        for marker in &self.schema.kinds.markers {
            self.resolve_marker(&marker.name, &mut Vec::new())?;
        }
        for alias in self.schema.kinds.aliases.keys() {
            self.expand_alias(alias, &mut Vec::new())?;
        }
        Ok(())
    }

    fn resolve_marker<'b>(
        &'b self,
        name: &'b str,
        stack: &mut Vec<&'b str>,
    ) -> Result<&'b str, String> {
        if self.kind_names.contains(name) {
            return Ok(name);
        }
        let Some(value) = self.markers.get(name).copied() else {
            return Err(format!("unknown SyntaxKind or marker {name}"));
        };
        if stack.contains(&name) {
            return Err(format!("cyclic SyntaxKind marker involving {name}"));
        }
        stack.push(name);
        let resolved = self.resolve_marker(value, stack);
        stack.pop();
        resolved
    }

    fn expand_alias<'b>(
        &'b self,
        name: &'b str,
        stack: &mut Vec<&'b str>,
    ) -> Result<Vec<&'b str>, String> {
        if self.kind_names.contains(name) {
            return Ok(vec![name]);
        }
        let Some(alias) = self.schema.kinds.aliases.get(name) else {
            return Err(format!("unknown SyntaxKind alias member {name}"));
        };
        if stack.contains(&name) {
            return Err(format!("cyclic SyntaxKind alias involving {name}"));
        }
        stack.push(name);
        let result = match alias {
            KindAlias::Members(members) => {
                let mut expanded = Vec::new();
                for member in members {
                    expanded.extend(self.expand_alias(member, stack)?);
                }
                expanded
            }
            KindAlias::Range { range } => {
                let first = self.resolve_marker(&range[0], &mut Vec::new())?;
                let last = self.resolve_marker(&range[1], &mut Vec::new())?;
                let first_index = self
                    .kinds
                    .iter()
                    .position(|kind| kind.schema_name == first)
                    .ok_or_else(|| format!("range start {first} is not a SyntaxKind"))?;
                let last_index = self
                    .kinds
                    .iter()
                    .position(|kind| kind.schema_name == last)
                    .ok_or_else(|| format!("range end {last} is not a SyntaxKind"))?;
                if first_index > last_index {
                    return Err(format!("reversed SyntaxKind range {first}..{last}"));
                }
                self.kinds[first_index..=last_index]
                    .iter()
                    .map(|kind| kind.schema_name)
                    .collect()
            }
        };
        stack.pop();
        Ok(result)
    }

    #[allow(clippy::too_many_lines)]
    fn generate(&self) -> Result<String, String> {
        let mut output = String::new();
        writeln!(
            output,
            "// Code generated by tools/ts_ast_codegen. DO NOT EDIT."
        )
        .unwrap();
        writeln!(output).unwrap();
        writeln!(output, "/// Lexical token and AST node kinds.").unwrap();
        writeln!(output, "#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]").unwrap();
        writeln!(output, "#[repr(u16)]").unwrap();
        writeln!(output, "pub enum SyntaxKind {{").unwrap();
        for element in &self.schema.kinds.elements {
            match element {
                KindElement::Name(name) => {
                    self.write_kind(&mut output, name, None)?;
                }
                KindElement::Detailed { name, comment } => {
                    if let Some(name) = name {
                        self.write_kind(&mut output, name, comment.as_deref())?;
                    } else if let Some(comment) = comment {
                        writeln!(output, "    // {}", one_line(comment)).unwrap();
                    }
                }
            }
        }
        writeln!(output, "}}").unwrap();
        writeln!(output).unwrap();
        writeln!(output, "impl SyntaxKind {{").unwrap();
        writeln!(output, "    pub const COUNT: usize = {};", self.kinds.len()).unwrap();
        for marker in &self.schema.kinds.markers {
            writeln!(
                output,
                "    pub const {}: Self = Self::{};",
                upper_snake_case(&marker.name),
                self.reference_name(&marker.value)
            )
            .unwrap();
        }

        writeln!(output).unwrap();
        writeln!(output, "    #[allow(clippy::too_many_lines)]").unwrap();
        writeln!(output, "    #[must_use]").unwrap();
        writeln!(output, "    pub const fn as_str(self) -> &'static str {{").unwrap();
        writeln!(output, "        match self {{").unwrap();
        for kind in &self.kinds {
            writeln!(
                output,
                "            Self::{} => {:?},",
                kind.rust_name, kind.schema_name
            )
            .unwrap();
        }
        writeln!(output, "        }}").unwrap();
        writeln!(output, "    }}").unwrap();

        let mut aliases: Vec<_> = self.schema.kinds.aliases.iter().collect();
        aliases.sort_by_key(|(name, _)| *name);
        for (name, alias) in aliases {
            writeln!(output).unwrap();
            writeln!(output, "    #[must_use]").unwrap();
            writeln!(
                output,
                "    pub const fn {}(self) -> bool {{",
                predicate_name(name)
            )
            .unwrap();
            match alias {
                KindAlias::Range { range } => {
                    writeln!(
                        output,
                        "        (self as u16) >= (Self::{} as u16) && (self as u16) <= (Self::{} as u16)",
                        self.resolved_rust_name(&range[0])?,
                        self.resolved_rust_name(&range[1])?
                    )
                    .unwrap();
                }
                KindAlias::Members(_) => {
                    let mut members = self.expand_alias(name, &mut Vec::new())?;
                    members.sort_unstable();
                    members.dedup();
                    write!(output, "        matches!(self,").unwrap();
                    for (index, member) in members.iter().enumerate() {
                        let separator = if index == 0 { " " } else { " | " };
                        write!(output, "{separator}Self::{}", rust_type_name(member)).unwrap();
                    }
                    writeln!(output, ")").unwrap();
                }
            }
            writeln!(output, "    }}").unwrap();
        }
        writeln!(output, "}}").unwrap();

        writeln!(output).unwrap();
        writeln!(output, "impl TryFrom<u16> for SyntaxKind {{").unwrap();
        writeln!(output, "    type Error = (); ").unwrap();
        writeln!(output).unwrap();
        writeln!(output, "    #[allow(clippy::too_many_lines)]").unwrap();
        writeln!(
            output,
            "    fn try_from(value: u16) -> Result<Self, Self::Error> {{"
        )
        .unwrap();
        writeln!(output, "        match value {{").unwrap();
        for kind in &self.kinds {
            writeln!(
                output,
                "            {} => Ok(Self::{}),",
                kind.discriminant, kind.rust_name
            )
            .unwrap();
        }
        writeln!(output, "            _ => Err(()),").unwrap();
        writeln!(output, "        }}").unwrap();
        writeln!(output, "    }}").unwrap();
        writeln!(output, "}}").unwrap();
        Ok(output)
    }

    fn write_kind(
        &self,
        output: &mut String,
        name: &str,
        comment: Option<&str>,
    ) -> Result<(), String> {
        let kind = self
            .kinds
            .iter()
            .find(|kind| kind.schema_name == name)
            .ok_or_else(|| format!("missing resolved SyntaxKind {name}"))?;
        let comment = comment.or(kind.comment);
        if let Some(comment) = comment {
            writeln!(
                output,
                "    {} = {}, // {}",
                kind.rust_name,
                kind.discriminant,
                one_line(comment)
            )
            .unwrap();
        } else {
            writeln!(output, "    {} = {},", kind.rust_name, kind.discriminant).unwrap();
        }
        Ok(())
    }

    fn reference_name(&self, name: &str) -> String {
        if self.kind_names.contains(name) {
            rust_type_name(name)
        } else {
            upper_snake_case(name)
        }
    }

    fn resolved_rust_name(&self, name: &str) -> Result<String, String> {
        let resolved = self.resolve_marker(name, &mut Vec::new())?;
        Ok(rust_type_name(resolved))
    }
}

fn rust_type_name(name: &str) -> String {
    name.replace("JSDoc", "JsDoc")
        .replace("JSImport", "JsImport")
        .replace("JSType", "JsType")
}

fn upper_snake_case(name: &str) -> String {
    let mut output = String::new();
    let chars: Vec<_> = name.chars().collect();
    for (index, &ch) in chars.iter().enumerate() {
        if index > 0
            && ch.is_ascii_uppercase()
            && (chars[index - 1].is_ascii_lowercase()
                || (index + 1 < chars.len() && chars[index + 1].is_ascii_lowercase()))
        {
            output.push('_');
        }
        output.push(ch.to_ascii_uppercase());
    }
    output
}

fn predicate_name(alias: &str) -> String {
    let base = alias.strip_suffix("SyntaxKind").unwrap_or(alias);
    format!("is_{}", snake_case(base))
}

fn snake_case(name: &str) -> String {
    upper_snake_case(name).to_ascii_lowercase()
}

fn one_line(comment: &str) -> String {
    comment.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::generate_syntax_kind;

    const UPSTREAM_AST: &str = include_str!("../spec/ast.json");

    #[test]
    fn comment_only_elements_do_not_consume_discriminants() {
        let input = r#"{
            "kinds": {
                "elements": ["Unknown", {"comment":"Group"}, "EndOfFile"],
                "markers": [],
                "aliases": {}
            }
        }"#;
        let output = generate_syntax_kind(input).unwrap();
        assert!(output.contains("    Unknown = 0,"));
        assert!(output.contains("    // Group\n    EndOfFile = 1,"));
        assert!(output.contains("pub const COUNT: usize = 2;"));
    }

    #[test]
    fn current_upstream_boundaries_are_explicit() {
        let output = generate_syntax_kind(UPSTREAM_AST).unwrap();
        assert!(output.contains("    Unknown = 0,"));
        assert!(output.contains("    DeferKeyword = 166,"));
        assert!(output.contains("    SourceKeyword = 167,"));
        assert!(output.contains("    QualifiedName = 168,"));
        assert!(output.contains("    SourceFile = 308,"));
        assert!(output.contains("    NotEmittedTypeElement = 351,"));
        assert!(output.contains("pub const COUNT: usize = 352;"));
    }

    #[test]
    fn current_upstream_markers_and_aliases_are_generated() {
        let output = generate_syntax_kind(UPSTREAM_AST).unwrap();
        assert!(output.contains("pub const LAST_TOKEN: Self = Self::LAST_KEYWORD;"));
        assert!(output.contains("pub const fn is_keyword(self) -> bool"));
        assert!(output.contains("pub const fn is_binary_operator(self) -> bool"));
    }
}
