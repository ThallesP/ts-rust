//! Port of Effect-TS/tsgo `internal/keybuilder`: the deterministic keys of
//! service, tag and error declarations.

use crate::effect::etscore::KeyPattern;
use crate::effect::typeparser::*;
use crate::prelude::*;

// Go: keybuilder/keybuilder.go Cyrb53
/// Cyrb53 computes a fast non-cryptographic hash of the input string,
/// producing a 16-character zero-padded hex string from two uint32 halves.
/// This is a Go port of the cyrb53 function from the reference TS implementation.
pub fn cyrb53(str: &str) -> String {
    let mut h1: u32 = 0xdead_beef;
    let mut h2: u32 = 0x41c6_ce57;

    for &b in str.as_bytes() {
        let ch = u32::from(b);
        h1 = imul(h1 ^ ch, 2_654_435_761);
        h2 = imul(h2 ^ ch, 1_597_334_677);
    }

    h1 = imul(h1 ^ (h1 >> 16), 2_246_822_507);
    h1 ^= imul(h2 ^ (h2 >> 13), 3_266_489_909);
    h2 = imul(h2 ^ (h2 >> 16), 2_246_822_507);
    h2 ^= imul(h1 ^ (h1 >> 13), 3_266_489_909);

    format!("{h2:08x}{h1:08x}")
}

// Go: keybuilder/keybuilder.go imul
/// imul emulates JavaScript's Math.imul: 32-bit integer multiplication
/// that discards overflow (keeps only the lower 32 bits).
fn imul(a: u32, b: u32) -> u32 {
    a.wrapping_mul(b)
}

/// Go `strings.ToLower`: `unicode.ToLower` on each rune.
fn strings_to_lower(s: &str) -> String {
    s.chars().map(crate::gostd::unicode::to_lower).collect()
}

// Go: keybuilder/keybuilder.go CreateString
/// CreateString computes the expected key string for a class declaration.
/// It takes the source file name, package name, package directory, class name,
/// and target category, and returns the expected key string using the first
/// matching key pattern. Returns empty string if no pattern matches or if
/// package info is missing.
pub fn create_string(
    source_file_name: &str,
    package_name: &str,
    package_directory: &str,
    class_name: &str,
    target: &str,
    key_patterns: &[KeyPattern],
) -> String {
    if package_name.is_empty() {
        return String::new();
    }

    for key_pattern in key_patterns {
        if key_pattern.target != target {
            continue;
        }

        // Construct onlyFileName: basename without extension, strip "index" suffix
        let mut only_file_name: String = match source_file_name.rfind('/') {
            None => source_file_name.to_string(),
            Some(last_index) => source_file_name[last_index + 1..].to_string(),
        };
        if let Some(last_ext_index) = only_file_name.rfind('.') {
            only_file_name.truncate(last_ext_index);
        }
        if strings_to_lower(&only_file_name).ends_with("/index") {
            only_file_name.truncate(only_file_name.len() - 6);
        }
        // The TS reference strips "index" when the filename IS "index" (after removing extension)
        if strings_to_lower(&only_file_name) == "index" {
            only_file_name = String::new();
        }
        if let Some(rest) = only_file_name.strip_prefix('/') {
            only_file_name = rest.to_string();
        }

        // Construct subDirectory: directory relative to package directory
        let mut sub_directory = crate::frontend::tspath::get_directory_path(source_file_name);
        if !sub_directory.starts_with(package_directory) {
            continue;
        }
        sub_directory = sub_directory[package_directory.len()..].to_string();
        if !sub_directory.ends_with('/') {
            sub_directory.push('/');
        }
        if let Some(rest) = sub_directory.strip_prefix('/') {
            sub_directory = rest.to_string();
        }
        for prefix in key_pattern.skip_leading_path.iter().flatten() {
            if sub_directory.starts_with(prefix.as_str()) {
                sub_directory = sub_directory[prefix.len()..].to_string();
                break;
            }
        }

        // Construct parts based on pattern
        let mut parts: Vec<String>;
        let class_name_matches =
            crate::fswatch::pathcompare::equal_fold(&only_file_name, class_name);

        match key_pattern.pattern.as_str() {
            "package-identifier" => {
                parts = vec![package_name.to_string(), only_file_name.clone()];
                if !class_name_matches {
                    parts.push(class_name.to_string());
                }
            }
            _ => {
                // "default" and "default-hashed"
                parts = vec![
                    package_name.to_string(),
                    sub_directory.clone(),
                    only_file_name.clone(),
                ];
                if !class_name_matches {
                    parts.push(class_name.to_string());
                }
            }
        }

        // Strip leading/trailing slashes from each part
        for part in &mut parts {
            let mut p: &str = part.as_str();
            p = p.strip_prefix('/').unwrap_or(p);
            p = p.strip_suffix('/').unwrap_or(p);
            *part = p.to_string();
        }

        // Filter empty parts and join
        let filtered: Vec<String> = parts
            .into_iter()
            .filter(|part| !part.trim().is_empty())
            .collect();
        let full_key = filtered.join("/");

        // Hash if default-hashed pattern
        if key_pattern.pattern == "default-hashed" {
            return cyrb53(&full_key);
        }
        return full_key;
    }

    String::new()
}
