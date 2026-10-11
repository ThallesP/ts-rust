// Go: internal/typeparser/discover.go

use crate::effect::typeparser::*;
use crate::prelude::*;

/// DiscoveredPackage represents a package found in the program's source files.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct DiscoveredPackage {
    pub name: String,
    pub version: Option<String>,
    pub depends_on_effect: bool,
    pub package_directory: String,
}

/// packageKey is used for deduplication of discovered packages.
#[derive(Clone, Debug, Default, PartialEq, Eq, Hash)]
pub struct PackageKey {
    pub name: String,
    pub version: String,
    pub has_ver: bool,
}

/// EffectMajorVersion represents the detected major version of the Effect library.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum EffectMajorVersion {
    #[default]
    Unknown = 0,
    V3 = 3,
    V4 = 4,
}

impl EffectMajorVersion {
    /// String returns the string representation of the Effect major version.
    #[must_use]
    pub fn string(self) -> &'static str {
        match self {
            EffectMajorVersion::V3 => "v3",
            EffectMajorVersion::V4 => "v4",
            _ => "unknown",
        }
    }
}

impl std::fmt::Display for EffectMajorVersion {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.string())
    }
}

impl TypeParser<'_> {
    /// DetectEffectVersion detects the major version of the Effect library from the program's
    /// source files. Returns EffectMajorUnknown if no Effect dependency is found or if
    /// conflicting versions are detected. The result is cached per checker lifetime.
    pub fn detect_effect_version(&mut self) -> EffectMajorVersion {
        if self.links().detect_effect_version_computed {
            return self.links().detect_effect_version_value;
        }
        let result = self.detect_effect_version_uncached();
        self.links().detect_effect_version_value = result;
        self.links().detect_effect_version_computed = true;
        result
    }

    /// detectEffectVersionUncached performs the actual version detection logic.
    pub fn detect_effect_version_uncached(&mut self) -> EffectMajorVersion {
        let packages = self.discover_packages();

        let mut detected = EffectMajorVersion::Unknown;
        let mut found = false;

        for pkg in packages.iter() {
            if pkg.name != "effect" {
                continue;
            }

            let major = match &pkg.version {
                None => EffectMajorVersion::Unknown,
                Some(version) if !version.is_empty() => match version.as_bytes()[0] {
                    b'3' => EffectMajorVersion::V3,
                    b'4' => EffectMajorVersion::V4,
                    _ => EffectMajorVersion::Unknown,
                },
                Some(_) => EffectMajorVersion::Unknown,
            };

            if !found {
                detected = major;
                found = true;
            } else if detected != major {
                return EffectMajorVersion::Unknown;
            }
        }

        if !found {
            return EffectMajorVersion::Unknown;
        }
        detected
    }

    /// SupportedEffectVersion returns the normalized supported Effect major version.
    /// It returns EffectMajorV4 when v4 is detected, and EffectMajorV3 for all other
    /// outcomes (including unknown). This is the central extension point for future
    /// compiler-option-based version forcing. The result is cached per checker lifetime.
    pub fn supported_effect_version(&mut self) -> EffectMajorVersion {
        if self.detect_effect_version() == EffectMajorVersion::V4 {
            return EffectMajorVersion::V4;
        }
        EffectMajorVersion::V3
    }

    /// DetectEffectVersionString returns the exact version string of the Effect library.
    /// Returns "unknown" if no Effect dependency is found, if the version is nil, or if
    /// conflicting versions are detected.
    pub fn detect_effect_version_string(&mut self) -> String {
        let packages = self.discover_packages();

        let mut detected = String::new();
        let mut found = false;

        for pkg in packages.iter() {
            let Some(version) = &pkg.version else {
                continue;
            };
            if pkg.name != "effect" {
                continue;
            }

            if !found {
                detected = version.clone();
                found = true;
            } else if detected != *version {
                return "unknown".to_string();
            }
        }

        if !found {
            return "unknown".to_string();
        }
        detected
    }

    /// DiscoverPackages iterates all source files in the program, resolves each one's
    /// nearest package.json, and returns a deduplicated list of discovered packages.
    /// Results are cached per checker so repeated calls within the same check cycle
    /// (from DetectEffectVersion, DetectEffectVersionString, duplicatePackage rule, etc.)
    /// do not re-scan all source files.
    // PERF: the cache shares one list; the duplicatePackage rule asks for it
    // once per file (effperf3 item 9).
    pub fn discover_packages(&mut self) -> Rc<[DiscoveredPackage]> {
        if let Some(packages) = &self.links().discover_packages {
            return packages.clone();
        }

        let result: Rc<[DiscoveredPackage]> = self.discover_packages_uncached().into();
        self.links().discover_packages = Some(result.clone());
        result
    }

    /// discoverPackagesUncached performs the actual source file scan.
    pub fn discover_packages_uncached(&mut self) -> Vec<DiscoveredPackage> {
        // PORT: Go asserts tp.program to sourceFileProgram and
        // packageJsonProgram; the Rust program always has both.
        let source_files: Vec<Node> = self.program.source_files().map(|file| file.root).collect();

        let mut seen: FxHashSet<PackageKey> = FxHashSet::default();
        let mut result: Vec<DiscoveredPackage> = Vec::new();
        for sf in source_files {
            if sf.is_nil() {
                continue;
            }

            let Some(pkg) = self.package_json_for_source_file(sf) else {
                continue;
            };

            let (name, ok) = pkg.fields.name.get_value();
            if !ok {
                continue;
            }

            let mut key = PackageKey {
                name: name.clone(),
                ..PackageKey::default()
            };
            let mut ver_ptr: Option<String> = None;

            let (ver, ok) = pkg.fields.version.get_value();
            if ok {
                key.version = ver.clone();
                key.has_ver = true;
                ver_ptr = Some(ver);
            }

            if seen.contains(&key) {
                continue;
            }
            seen.insert(key);

            let mut depends_on_effect = false;
            let (peer_deps, ok) = pkg.fields.peer_dependencies.get_value();
            if ok {
                depends_on_effect = peer_deps.contains_key("effect");
            }

            let meta = get_source_file_meta_data(&source_file_info(sf).path);
            let pkg_dir = meta.package_json_directory;

            result.push(DiscoveredPackage {
                name,
                version: ver_ptr,
                depends_on_effect,
                package_directory: pkg_dir,
            });
        }

        result
    }
}
