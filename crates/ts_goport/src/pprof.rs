//! Go: pprof/pprof.go (package `pprof`), and the parts of the Go standard
//! library package `runtime/pprof` (go1.27.1, the oracle's toolchain) that
//! it calls. go1.27.1 changed only the parts that the port does not run (the
//! record loop of `writeHeapProto` and the text form of `writeHeap`).
//!
//! `BeginProfiling` and `ProfileSession.Stop` serve `tscCompilation` and
//! `tscBuildCompilation` (execute/execute_tsc.rs). `CPUProfiler`,
//! `SaveHeapProfile`, `SaveAllocProfile` and `RunGC` serve the language
//! server (lsp/server.rs) and the API session (api/session_p1.rs).
//!
//! PORT: Go `runtime/pprof` builds its profiles from samples that the Go
//! runtime takes: CPU samples on SIGPROF, and allocation samples every
//! `runtime.MemProfileRate` bytes. The port has no such sampler, so it has
//! no samples. It writes the profiles as `runtime/pprof` writes a profile
//! with no samples: the gzip-compressed `profile.proto` message with the
//! sample types, the period, the times, the executable mappings of
//! `/proc/self/maps` with their GNU build IDs, and the string table. It
//! writes no `Sample`, `Location` or `Function` message. The directory,
//! the file names, the file order and the printed lines are Go's. The pid,
//! the times, the mappings and the profile bytes never match Go, like the
//! memory statistics (execute/tsc/statistics.rs `read_mem_stats`).
//!
//! PORT: Go `runtime.GC()` has nothing to do in Rust (no garbage
//! collector), so `run_gc` is a no-op. The `os` calls of the language
//! server functions (`MkdirAll`, `Create`, `Remove`) give Go's error texts
//! (`mkdir_all`, `path_error`).

use std::cell::RefCell;
use std::ffi::OsStr;
use std::fs::{File, OpenOptions};
use std::io::{self, Write};
use std::mem::ManuallyDrop;
#[cfg(unix)]
use std::os::unix::ffi::OsStrExt;
#[cfg(unix)]
use std::os::unix::fs::FileExt;
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use flate2::Compression;
use flate2::write::GzEncoder;
use rustc_hash::FxHashMap;

use crate::core::go_panic;
use crate::execute::incremental::emit_files::fs_error_text;
use crate::execute::tsc::compile::{Writer, write_str};
// PORT: the paths are port forms of Go strings (see
// `scanner_util::GO_STRING_MARKER`); the OS gets their Go bytes (`os_path`).
use crate::frontend::vfs::osvfs::{filepath_clean, os_mkdir_all, os_path};
use crate::fswatch::syscall::io_error_text;
use crate::gostd::{GoError, errors};

// Go: pprof/pprof.go:15 ProfileSession
// PORT: `cpu_file` is `None` after Go `p.cpuFile.Close()`. `cpu_profile`
// is the state of the Go `runtime/pprof` goroutine `profileWriter` (see
// `start_cpu_profile`).
pub struct ProfileSession {
    cpu_file_path: String,
    mem_file_path: String,
    cpu_file: Option<File>,
    log_writer: Writer,
    cpu_profile: Option<ProfileBuilder>,
}

// Go: pprof/pprof.go:23 BeginProfiling
// BeginProfiling starts CPU and memory profiling, writing the profiles to the specified directory.
// PORT: Go `panic(err)` is `go_panic` with the Go error text.
#[must_use]
pub fn begin_profiling(profile_dir: &str, log_writer: Writer) -> ProfileSession {
    if let Err(err) = mkdir_all(profile_dir, 0o755) {
        go_panic(err.error());
    }

    let pid = std::process::id();

    // Go: filepath.Join(profileDir, ...). `profileDir` is not empty.
    let cpu_profile_path = filepath_clean(&format!("{profile_dir}/{pid}-cpuprofile.pb.gz"));
    let mem_profile_path = filepath_clean(&format!("{profile_dir}/{pid}-memprofile.pb.gz"));
    let cpu_file = os_create(&cpu_profile_path);

    // Go: pprof.StartCPUProfile(cpuFile), then `panic(err)`.
    let cpu_profile = match start_cpu_profile() {
        Ok(cpu_profile) => cpu_profile,
        Err(err) => go_panic(err.to_string()),
    };

    ProfileSession {
        cpu_file_path: cpu_profile_path,
        mem_file_path: mem_profile_path,
        cpu_file: Some(cpu_file),
        log_writer,
        cpu_profile: Some(cpu_profile),
    }
}

impl ProfileSession {
    // Go: pprof/pprof.go:49 Stop
    // PORT: only `Drop` calls it (Go `defer profileSession.Stop()`).
    fn stop(&mut self) {
        // Go: pprof.StopCPUProfile()
        if let (Some(cpu_profile), Some(cpu_file)) = (self.cpu_profile.take(), &self.cpu_file) {
            stop_cpu_profile(cpu_profile, cpu_file);
        }
        // Go: p.cpuFile.Close()
        self.cpu_file = None;

        if !self.mem_file_path.is_empty() {
            let mem_file = os_create(&self.mem_file_path);
            // Go: pprof.Lookup("allocs").WriteTo(memFile, 0), then `panic(err)`.
            if let Err(err) = write_alloc(&mem_file) {
                go_panic(path_error("write", &self.mem_file_path, &err).error());
            }
            // Go: memFile.Close()
            drop(mem_file);
            write_str(
                &self.log_writer,
                &format!("Memory profile: {}\n", self.mem_file_path),
            );
        }

        write_str(
            &self.log_writer,
            &format!("CPU profile: {}\n", self.cpu_file_path),
        );
    }
}

// PORT: Go `defer profileSession.Stop()`. The callers keep the session
// in a local, so it stops when they return, and also when they panic,
// as a Go defer does.
impl Drop for ProfileSession {
    fn drop(&mut self) {
        self.stop();
    }
}

// Go: os.Create (O_RDWR|O_CREATE|O_TRUNC, 0o666), then `panic(err)`.
fn os_create(name: &str) -> File {
    match create(name) {
        Ok(file) => file,
        Err(err) => go_panic(err.error()),
    }
}

// Go: pprof/pprof.go:69 CPUProfiler
// CPUProfiler manages on-demand CPU profiling.
// PORT: the session is `ManuallyDrop` because a Go session that nobody
// stops stays open: a `CPUProfiler` that drops while profiling must not
// stop the profile (`ProfileSession` stops when it drops).
#[derive(Default)]
pub struct CpuProfiler {
    mu: Mutex<Option<ManuallyDrop<ProfileSession>>>,
}

impl CpuProfiler {
    // Go: pprof/pprof.go:75 StartCPUProfile
    // StartCPUProfile starts CPU profiling, writing to the specified directory when stopped.
    pub fn start_cpu_profile(&self, profile_dir: &str) -> Result<(), GoError> {
        let mut session = lock(&self.mu);

        if session.is_some() {
            return Err(errors::new("CPU profiling already in progress"));
        }

        if let Err(err) = mkdir_all(profile_dir, 0o755) {
            return Err(wrap("failed to create profile directory", err));
        }

        let cpu_profile_path = profile_path(profile_dir, "cpuprofile");
        let cpu_file = match create(&cpu_profile_path) {
            Ok(file) => file,
            Err(err) => return Err(wrap("failed to create CPU profile file", err)),
        };

        // Go: pprof.StartCPUProfile(cpuFile)
        let cpu_profile = match start_cpu_profile() {
            Ok(cpu_profile) => cpu_profile,
            Err(err) => {
                // Go: cpuFile.Close()
                drop(cpu_file);
                // Go: os.Remove(cpuProfilePath). Go ignores its error.
                let _ = std::fs::remove_file(os_path(&cpu_profile_path));
                return Err(wrap("failed to start CPU profile", errors::new(err)));
            }
        };

        // Go: logWriter: io.Discard
        let log_writer: Writer = Rc::new(RefCell::new(io::sink()));
        *session = Some(ManuallyDrop::new(ProfileSession {
            cpu_file_path: cpu_profile_path,
            mem_file_path: String::new(),
            cpu_file: Some(cpu_file),
            log_writer,
            cpu_profile: Some(cpu_profile),
        }));
        Ok(())
    }

    // Go: pprof/pprof.go:108 StopCPUProfile
    // StopCPUProfile stops CPU profiling and returns the path to the profile file.
    pub fn stop_cpu_profile(&self) -> Result<String, GoError> {
        let mut session = lock(&self.mu);

        let Some(stopped) = session.take() else {
            return Err(errors::new("CPU profiling not in progress"));
        };

        let file_path = stopped.cpu_file_path.clone();
        // Go: c.session.Stop(), then c.session = nil (the `take` above).
        drop(ManuallyDrop::into_inner(stopped));

        Ok(file_path)
    }
}

// Go: pprof/pprof.go:124 SaveHeapProfile
// SaveHeapProfile saves a heap profile to the specified directory.
pub fn save_heap_profile(profile_dir: &str) -> Result<String, GoError> {
    if let Err(err) = mkdir_all(profile_dir, 0o755) {
        return Err(wrap("failed to create profile directory", err));
    }

    let heap_profile_path = profile_path(profile_dir, "heapprofile");
    // Go: defer heapFile.Close(). The file closes when it drops.
    let heap_file = match create(&heap_profile_path) {
        Ok(file) => file,
        Err(err) => return Err(wrap("failed to create heap profile file", err)),
    };

    run_gc();
    // Go: pprof.Lookup("heap").WriteTo(heapFile, 0)
    if let Err(err) = write_heap(&heap_file) {
        // Go: os.Remove(heapProfilePath). Go ignores its error.
        let _ = std::fs::remove_file(os_path(&heap_profile_path));
        let err = path_error("write", &heap_profile_path, &err);
        return Err(wrap("failed to write heap profile", err));
    }

    Ok(heap_profile_path)
}

// Go: pprof/pprof.go:146 SaveAllocProfile
// SaveAllocProfile saves an allocation profile to the specified directory.
pub fn save_alloc_profile(profile_dir: &str) -> Result<String, GoError> {
    if let Err(err) = mkdir_all(profile_dir, 0o755) {
        return Err(wrap("failed to create profile directory", err));
    }

    let alloc_profile_path = profile_path(profile_dir, "allocprofile");
    // Go: defer allocFile.Close(). The file closes when it drops.
    let alloc_file = match create(&alloc_profile_path) {
        Ok(file) => file,
        Err(err) => return Err(wrap("failed to create alloc profile file", err)),
    };

    // Go: pprof.Lookup("allocs").WriteTo(allocFile, 0)
    if let Err(err) = write_alloc(&alloc_file) {
        // Go: os.Remove(allocProfilePath). Go ignores its error.
        let _ = std::fs::remove_file(os_path(&alloc_profile_path));
        let err = path_error("write", &alloc_profile_path, &err);
        return Err(wrap("failed to write alloc profile", err));
    }

    Ok(alloc_profile_path)
}

// Go: pprof/pprof.go:167 RunGC
// RunGC triggers garbage collection.
// PORT: Go `runtime.GC()`. Rust has no garbage collector, so there is
// nothing to do.
pub fn run_gc() {}

// Go: filepath.Join(profileDir, fmt.Sprintf("%d-%d-<kind>.pb.gz", os.Getpid(),
// time.Now().UnixMilli())). `profileDir` is not empty: `MkdirAll("")` fails
// first.
fn profile_path(profile_dir: &str, kind: &str) -> String {
    let pid = std::process::id();
    let ms = unix_milli(SystemTime::now());
    filepath_clean(&format!("{profile_dir}/{pid}-{ms}-{kind}.pb.gz"))
}

// Go: fmt.Errorf("<text>: %w", err)
fn wrap(text: &str, err: GoError) -> GoError {
    errors::errorf(format!("{text}: {err}"), vec![err])
}

// PORT: Go `sync.Mutex.Lock`. A panic while the lock is held does not
// poison a Go mutex.
fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

// ---------------------------------------------------------------------
// Go standard library: os (go1.27.1)
// ---------------------------------------------------------------------

// Go: os/path.go:19 MkdirAll, as a Go error (osvfs `os_mkdir_all`).
fn mkdir_all(path: &str, perm: u32) -> Result<(), GoError> {
    os_mkdir_all(path, perm).map_err(|err| errors::new(fs_error_text(&err)))
}

// Go: os/file.go:399 Create, which returns `&PathError{Op: "open", ...}`.
fn create(name: &str) -> Result<File, GoError> {
    OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(true)
        .open(os_path(name))
        .map_err(|err| path_error("open", name, &err))
}

// Go: io/fs.PathError.Error, "op path: err", with the Go text of the errno.
pub fn path_error(op: &str, path: &str, err: &io::Error) -> GoError {
    errors::new(format!("{op} {path}: {}", io_error_text(err)))
}

// ---------------------------------------------------------------------
// Go standard library: runtime/pprof (go1.27.1)
// ---------------------------------------------------------------------

// Go: runtime/pprof/pprof.go:868 cpu (the `profiling` field)
// PORT: Go guards it with a mutex. The atomic swap does the same job.
static CPU_PROFILING: AtomicBool = AtomicBool::new(false);

// Go: runtime/mprof.go:870 MemProfileRate. tsgo does not change it.
const MEM_PROFILE_RATE: i64 = 512 * 1024;

// Go: runtime/pprof/pprof.go:885 StartCPUProfile
// PORT: Go starts the runtime sampler with `runtime.SetCPUProfileRate(hz)`
// and runs `profileWriter(w)` in a goroutine, which owns the profile
// builder and writes it to `w` when profiling stops. The port returns
// that builder, and `stop_cpu_profile` takes it back with `w`.
fn start_cpu_profile() -> Result<ProfileBuilder, &'static str> {
    // The runtime routines allow a variable profiling rate,
    // but in practice operating systems cannot trigger signals
    // at more than about 500 Hz, and our processing of the
    // signal is not cheap (mostly getting the stack trace).
    // 100 Hz is a reasonable choice: it is frequent enough to
    // produce useful data, rare enough not to bog down the
    // system, and a nice round number to make it easy to
    // convert sample counts to seconds. Instead of requiring
    // each client to specify the frequency, we hard code it.
    const HZ: i64 = 100;

    // Double-check.
    if CPU_PROFILING.swap(true, Ordering::SeqCst) {
        return Err("cpu profiling already in use");
    }

    // Go: pprof.go:919 profileWriter: b := newProfileBuilder(w)
    let mut b = ProfileBuilder::new();
    // Go: proto.go:278 addCPUData, for the header record that
    // `runtime.SetCPUProfileRate(hz)` writes first. The port has no other
    // record (see the module comment).
    // data[2] is sampling rate in Hz. Convert to sampling
    // period in nanoseconds.
    b.period = 1_000_000_000 / HZ;
    b.have_period = true;
    Ok(b)
}

// Go: runtime/pprof/pprof.go:947 StopCPUProfile
// StopCPUProfile stops the current CPU profile, if any.
// PORT: Go `<-cpu.done` waits for `profileWriter`, which reads the end
// of the profile, calls `b.build()` and ignores its error.
fn stop_cpu_profile(b: ProfileBuilder, w: &File) {
    if !CPU_PROFILING.swap(false, Ordering::SeqCst) {
        return;
    }
    let _ = b.build(w);
}

// Go: runtime/pprof/pprof.go:618 writeHeap
// PORT: Go `pprof.Lookup("heap").WriteTo(w, 0)` calls it with debug 0, so
// `writeHeapInternal` calls `writeHeapProto` with no default sample type
// (see `write_alloc`).
fn write_heap(w: &File) -> io::Result<()> {
    write_heap_proto(w, MEM_PROFILE_RATE, "")
}

// Go: runtime/pprof/pprof.go:624 writeAlloc
// PORT: Go `pprof.Lookup("allocs").WriteTo(w, 0)` calls it with debug 0,
// so `writeHeapInternal` (pprof.go:628) calls `writeHeapProto` with the
// runtime memory profile records and `runtime.MemProfileRate`. The port
// has no records (see the module comment).
fn write_alloc(w: &File) -> io::Result<()> {
    write_heap_proto(w, MEM_PROFILE_RATE, "alloc_space")
}

// Go: runtime/pprof/protomem.go:16 writeHeapProto
// writeHeapProto writes the current heap profile in protobuf format to w.
// PORT: the record list `p` is always empty, so the loop over it is not
// ported.
fn write_heap_proto(w: &File, rate: i64, default_sample_type: &str) -> io::Result<()> {
    let mut b = ProfileBuilder::new();
    b.pb_value_type(TAG_PROFILE_PERIOD_TYPE, "space", "bytes");
    b.pb.int64_opt(TAG_PROFILE_PERIOD, rate);
    b.pb_value_type(TAG_PROFILE_SAMPLE_TYPE, "alloc_objects", "count");
    b.pb_value_type(TAG_PROFILE_SAMPLE_TYPE, "alloc_space", "bytes");
    b.pb_value_type(TAG_PROFILE_SAMPLE_TYPE, "inuse_objects", "count");
    b.pb_value_type(TAG_PROFILE_SAMPLE_TYPE, "inuse_space", "bytes");
    if !default_sample_type.is_empty() {
        let index = b.string_index(default_sample_type.as_bytes());
        b.pb.int64_opt(TAG_PROFILE_DEFAULT_SAMPLE_TYPE, index);
    }
    b.build(w)
}

// Go: runtime/pprof/proto.go:70 (the tags that a profile with no samples
// writes)
// message Profile
const TAG_PROFILE_SAMPLE_TYPE: u64 = 1; // repeated ValueType
const TAG_PROFILE_MAPPING: u64 = 3; // repeated Mapping
const TAG_PROFILE_STRING_TABLE: u64 = 6; // repeated string
const TAG_PROFILE_TIME_NANOS: u64 = 9; // int64
const TAG_PROFILE_DURATION_NANOS: u64 = 10; // int64
const TAG_PROFILE_PERIOD_TYPE: u64 = 11; // ValueType (really optional string???)
const TAG_PROFILE_PERIOD: u64 = 12; // int64
const TAG_PROFILE_DEFAULT_SAMPLE_TYPE: u64 = 14; // int64
// message ValueType
const TAG_VALUE_TYPE_TYPE: u64 = 1; // int64 (string table index)
const TAG_VALUE_TYPE_UNIT: u64 = 2; // int64 (string table index)
// message Mapping
const TAG_MAPPING_ID: u64 = 1; // uint64
const TAG_MAPPING_START: u64 = 2; // uint64
const TAG_MAPPING_LIMIT: u64 = 3; // uint64
const TAG_MAPPING_OFFSET: u64 = 4; // uint64
const TAG_MAPPING_FILENAME: u64 = 5; // int64 (string table index)
const TAG_MAPPING_BUILD_ID: u64 = 6; // int64 (string table index)

// Go: runtime/pprof/proto.go:27 profileBuilder
// A profileBuilder writes a profile incrementally from a
// stream of profile samples delivered by the runtime.
// PORT: only the fields that a profile with no samples uses. Go makes the
// gzip writer `zw` in `newProfileBuilder`. It writes nothing before its
// first `Write`, so `build` makes it. Go `time.Time` holds a wall and a
// monotonic reading: `start` is the wall reading for `UnixNano`, and
// `start_mono` the monotonic one for `Sub`. Go strings hold any bytes, so
// the string table holds bytes.
struct ProfileBuilder {
    start: SystemTime,
    start_mono: Instant,
    have_period: bool,
    period: i64,

    // encoding state
    pb: Protobuf,
    strings: Vec<Vec<u8>>,
    string_map: FxHashMap<Vec<u8>, i64>,
    mem: Vec<MemMap>,
}

// Go: runtime/pprof/proto.go:46 memMap
// PORT: `funcs` and `fake` serve locations, which a profile with no
// samples does not have.
struct MemMap {
    start: u64,       // Address at which the binary (or DLL) is loaded into memory.
    end: u64,         // The limit of the address range occupied by this mapping.
    offset: u64,      // Offset in the binary that corresponds to the first mapped address.
    file: Vec<u8>,    // The object this entry is loaded from.
    build_id: String, // A string that uniquely identifies a particular program version with high probability.
}

impl ProfileBuilder {
    // Go: runtime/pprof/proto.go:259 newProfileBuilder
    fn new() -> ProfileBuilder {
        let mut string_map = FxHashMap::default();
        string_map.insert(Vec::new(), 0);
        let mut b = ProfileBuilder {
            start: SystemTime::now(),
            start_mono: Instant::now(),
            have_period: false,
            period: 0,
            pb: Protobuf::default(),
            strings: vec![Vec::new()],
            string_map,
            mem: Vec::new(),
        };
        b.read_mapping();
        b
    }

    // Go: runtime/pprof/proto.go:133 stringIndex
    // stringIndex adds s to the string table if not already present
    // and returns the index of s in the string table.
    fn string_index(&mut self, s: &[u8]) -> i64 {
        if let Some(&id) = self.string_map.get(s) {
            return id;
        }
        let id = self.strings.len() as i64;
        self.strings.push(s.to_vec());
        self.string_map.insert(s.to_vec(), id);
        id
    }

    // Go: runtime/pprof/proto.go:152 pbValueType
    // pbValueType encodes a ValueType message to b.pb.
    fn pb_value_type(&mut self, tag: u64, typ: &str, unit: &str) {
        let start = self.pb.start_message();
        let typ = self.string_index(typ.as_bytes());
        self.pb.int64(TAG_VALUE_TYPE_TYPE, typ);
        let unit = self.string_index(unit.as_bytes());
        self.pb.int64(TAG_VALUE_TYPE_UNIT, unit);
        self.pb.end_message(tag, start);
    }

    // Go: runtime/pprof/proto.go:189 pbMapping
    // pbMapping encodes a Mapping message to b.pb.
    // PORT: Go writes `HasFunctions` only for a mapping whose locations
    // were all symbolized. A profile with no samples has no locations, so
    // `hasFuncs` is always false and not ported.
    fn pb_mapping(
        &mut self,
        tag: u64,
        id: u64,
        base: u64,
        limit: u64,
        offset: u64,
        file: &[u8],
        build_id: &str,
    ) {
        let start = self.pb.start_message();
        self.pb.uint64_opt(TAG_MAPPING_ID, id);
        self.pb.uint64_opt(TAG_MAPPING_START, base);
        self.pb.uint64_opt(TAG_MAPPING_LIMIT, limit);
        self.pb.uint64_opt(TAG_MAPPING_OFFSET, offset);
        let file = self.string_index(file);
        self.pb.int64_opt(TAG_MAPPING_FILENAME, file);
        let build_id = self.string_index(build_id.as_bytes());
        self.pb.int64_opt(TAG_MAPPING_BUILD_ID, build_id);
        self.pb.end_message(tag, start);
    }

    // Go: runtime/pprof/proto.go:348 build
    // build completes and returns the constructed profile.
    // PORT: Go writes a `Sample` message for each profiled stack between
    // the header and the mappings. The port has no samples.
    fn build(mut self, w: &File) -> io::Result<()> {
        // Go: b.end = time.Now()
        let end = Instant::now();

        self.pb
            .int64_opt(TAG_PROFILE_TIME_NANOS, unix_nano(self.start));
        if self.have_period {
            // must be CPU profile
            self.pb_value_type(TAG_PROFILE_SAMPLE_TYPE, "samples", "count");
            self.pb_value_type(TAG_PROFILE_SAMPLE_TYPE, "cpu", "nanoseconds");
            let duration = end.duration_since(self.start_mono).as_nanos() as i64;
            self.pb.int64_opt(TAG_PROFILE_DURATION_NANOS, duration);
            self.pb_value_type(TAG_PROFILE_PERIOD_TYPE, "cpu", "nanoseconds");
            self.pb.int64_opt(TAG_PROFILE_PERIOD, self.period);
        }

        let mem = std::mem::take(&mut self.mem);
        for (i, m) in mem.iter().enumerate() {
            self.pb_mapping(
                TAG_PROFILE_MAPPING,
                i as u64 + 1,
                m.start,
                m.end,
                m.offset,
                &m.file,
                &m.build_id,
            );
        }

        // TODO: Anything for tagProfile_DropFrames?
        // TODO: Anything for tagProfile_KeepFrames?

        self.pb.strings(TAG_PROFILE_STRING_TABLE, &self.strings);
        // Go: gzip.NewWriterLevel(w, gzip.BestSpeed) in newProfileBuilder.
        // Both write the gzip header with mtime 0, XFL 4 and OS 255.
        let mut zw = GzEncoder::new(w, Compression::fast());
        zw.write_all(&self.pb.data)?;
        // Go: b.zw.Close()
        zw.finish()?;
        Ok(())
    }

    // Go: runtime/pprof/proto_other.go:17 readMapping
    // readMapping reads /proc/self/maps and writes mappings to b.pb.
    // It saves the address ranges of the mappings in b.mem for use
    // when emitting locations.
    fn read_mapping(&mut self) {
        let data = std::fs::read("/proc/self/maps").unwrap_or_default();
        parse_proc_self_maps(&data, &mut |lo, hi, offset, file, build_id| {
            self.add_mapping_entry(lo, hi, offset, file, build_id);
        });
        if self.mem.is_empty() {
            // pprof expects a map entry, so fake one.
            self.add_mapping_entry(0, 0, 0, b"", String::new());
        }
    }

    // Go: runtime/pprof/proto.go:760 addMappingEntry
    // PORT: Go `addMapping` (proto.go:756) calls it with `fake` false.
    // The `fake` field is not ported (see `MemMap`).
    fn add_mapping_entry(&mut self, lo: u64, hi: u64, offset: u64, file: &[u8], build_id: String) {
        self.mem.push(MemMap {
            start: lo,
            end: hi,
            offset,
            file: file.to_vec(),
            build_id,
        });
    }
}

// Go: runtime/pprof/proto.go:665 parseProcSelfMaps
fn parse_proc_self_maps(
    mut data: &[u8],
    add_mapping: &mut dyn FnMut(u64, u64, u64, &[u8], String),
) {
    // $ cat /proc/self/maps
    // 00400000-0040b000 r-xp 00000000 fc:01 787766                             /bin/cat
    // 0060a000-0060b000 r--p 0000a000 fc:01 787766                             /bin/cat
    // 014ab000-014cc000 rw-p 00000000 00:00 0                                  [heap]
    // 7f7d7797c000-7f7d77b36000 r-xp 00000000 fc:01 1180226                    /lib/x86_64-linux-gnu/libc-2.19.so
    // 7f7d77d3c000-7f7d77d41000 rw-p 00000000 00:00 0
    // 7ffc34343000-7ffc34345000 r-xp 00000000 00:00 0                          [vdso]
    // ffffffffff600000-ffffffffff601000 r-xp 00000000 00:00 0                  [vsyscall]

    // next removes and returns the next field in the line.
    // It also removes from line any spaces following the field.
    fn next<'a>(line: &mut &'a [u8]) -> &'a [u8] {
        let (f, rest) = cut(*line, b' ');
        *line = trim_left_spaces(rest);
        f
    }

    while !data.is_empty() {
        let (mut line, rest) = cut(data, b'\n');
        data = rest;
        let addr = next(&mut line);
        let Some(dash) = memchr::memchr(b'-', addr) else {
            continue;
        };
        let (lo_str, hi_str) = (&addr[..dash], &addr[dash + 1..]);
        let Some(lo) = parse_uint_hex(lo_str) else {
            continue;
        };
        let Some(hi) = parse_uint_hex(hi_str) else {
            continue;
        };
        let perm = next(&mut line);
        if perm.len() < 4 || perm[2] != b'x' {
            // Only interested in executable mappings.
            continue;
        }
        let Some(offset) = parse_uint_hex(next(&mut line)) else {
            continue;
        };
        next(&mut line); // dev
        let inode = next(&mut line); // inode
        // PORT: Go `bytes.TrimLeft` in `next` returns nil for an empty
        // rest, so Go `line == nil` is an empty `line`.
        if line.is_empty() {
            continue;
        }
        let mut file = line;

        // Trim deleted file marker.
        const DELETED_STR: &[u8] = b" (deleted)";
        if file.ends_with(DELETED_STR) {
            file = &file[..file.len() - DELETED_STR.len()];
        }

        if inode == b"0" && file.is_empty() {
            // Huge-page text mappings list the initial fragment of
            // mapped but unpopulated memory as being inode 0.
            // Don't report that part.
            // But [vdso] and [vsyscall] are inode 0, so let non-empty file names through.
            continue;
        }

        // TODO: pprof's remapMappingIDs makes one adjustment:
        // 1. If there is an /anon_hugepage mapping first and it is
        // consecutive to a next mapping, drop the /anon_hugepage.
        // There's no indication why this is needed.
        // Let's try not doing this and see what breaks.
        // If we do need it, it would go here, before we
        // enter the mappings into b.mem in the first place.

        let build_id = elf_build_id(file).unwrap_or_default();
        add_mapping(lo, hi, offset, file, build_id);
    }
}

// Go: bytes.Cut(s, []byte{sep}). `after` is empty when `sep` is missing
// (Go returns nil, which the callers treat the same way).
fn cut(s: &[u8], sep: u8) -> (&[u8], &[u8]) {
    match memchr::memchr(sep, s) {
        Some(i) => (&s[..i], &s[i + 1..]),
        None => (s, &[]),
    }
}

// Go: bytes.TrimLeft(s, " ")
fn trim_left_spaces(s: &[u8]) -> &[u8] {
    let n = s.iter().take_while(|&&c| c == b' ').count();
    &s[n..]
}

// Go: strconv.ParseUint(s, 16, 64). Rust `from_str_radix` also takes a
// leading `+`, which Go rejects.
fn parse_uint_hex(s: &[u8]) -> Option<u64> {
    if s.first() == Some(&b'+') {
        return None;
    }
    u64::from_str_radix(std::str::from_utf8(s).ok()?, 16).ok()
}

// Go: time.Time.UnixNano
fn unix_nano(t: SystemTime) -> i64 {
    match t.duration_since(UNIX_EPOCH) {
        Ok(d) => d.as_nanos() as i64,
        Err(err) => -(err.duration().as_nanos() as i64),
    }
}

// Go: time.Time.UnixMilli
fn unix_milli(t: SystemTime) -> i64 {
    match t.duration_since(UNIX_EPOCH) {
        Ok(d) => d.as_millis() as i64,
        Err(err) => -(err.duration().as_millis() as i64),
    }
}

// Go: runtime/pprof/elf.go:21 elfBuildID
// elfBuildID returns the GNU build ID of the named ELF binary,
// without introducing a dependency on debug/elf and its dependencies.
// PORT: Go returns an error that its only caller ignores. `None` is
// that error.
fn elf_build_id(file: &[u8]) -> Option<String> {
    let mut buf = [0u8; 256];
    #[cfg(unix)]
    let f = File::open(OsStr::from_bytes(file)).ok()?;
    // PORT: off unix a path must be UTF-8. No caller gets here: there is no
    // /proc/self/maps.
    #[cfg(not(unix))]
    let f = File::open(std::str::from_utf8(file).ok()?).ok()?;

    read_at(&f, &mut buf[..64], 0)?;

    // ELF file begins with \x7F E L F.
    if buf[0] != 0x7F || buf[1] != b'E' || buf[2] != b'L' || buf[3] != b'F' {
        return None; // errBadELF
    }

    // Go: binary.LittleEndian (1) or binary.BigEndian (2). `uint` reads
    // the unsigned value of all bytes of `b`.
    let big_endian = match buf[5] {
        1 => false,       // little-endian
        2 => true,        // big-endian
        _ => return None, // errBadELF
    };
    let uint = move |b: &[u8]| -> u64 {
        let mut x = 0u64;
        if big_endian {
            for &c in b {
                x = x << 8 | u64::from(c);
            }
        } else {
            for &c in b.iter().rev() {
                x = x << 8 | u64::from(c);
            }
        }
        x
    };

    let (shnum, shoff, shentsize): (i64, i64, i64) = match buf[4] {
        1 => {
            // 32-bit file header
            let shoff = uint(&buf[32..36]) as i64;
            let shentsize = uint(&buf[46..48]) as i64;
            if shentsize != 40 {
                return None; // errBadELF
            }
            (uint(&buf[48..50]) as i64, shoff, shentsize)
        }
        2 => {
            // 64-bit file header
            let shoff = uint(&buf[40..48]) as i64;
            let shentsize = uint(&buf[58..60]) as i64;
            if shentsize != 64 {
                return None; // errBadELF
            }
            (uint(&buf[60..62]) as i64, shoff, shentsize)
        }
        _ => return None, // errBadELF
    };

    for i in 0..shnum {
        read_at(
            &f,
            &mut buf[..shentsize as usize],
            shoff.wrapping_add(i.wrapping_mul(shentsize)),
        )?;
        if uint(&buf[4..8]) != 7 {
            // SHT_NOTE
            continue;
        }
        let (mut off, mut size) = if shentsize == 40 {
            // 32-bit section header
            (uint(&buf[16..20]) as i64, uint(&buf[20..24]) as i64)
        } else {
            // 64-bit section header
            (uint(&buf[24..32]) as i64, uint(&buf[32..40]) as i64)
        };
        size = size.wrapping_add(off);
        while off < size {
            // room for header + name GNU\x00
            read_at(&f, &mut buf[..16], off)?;
            let name_size = uint(&buf[0..4]) as i64;
            let desc_size = uint(&buf[4..8]) as i64;
            let note_type = uint(&buf[8..12]);
            let desc_off = off.wrapping_add(12 + ((name_size + 3) & !3));
            off = desc_off.wrapping_add((desc_size + 3) & !3);
            if name_size != 4 || note_type != 3 || &buf[12..16] != b"GNU\x00" {
                // want name GNU\x00 type 3 (NT_GNU_BUILD_ID)
                continue;
            }
            if desc_size > buf.len() as i64 {
                return None; // errBadELF
            }
            read_at(&f, &mut buf[..desc_size as usize], desc_off)?;
            // Go: fmt.Sprintf("%x", buf[:descSize])
            let mut id = String::with_capacity(desc_size as usize * 2);
            for c in &buf[..desc_size as usize] {
                id.push_str(&format!("{c:02x}"));
            }
            return Some(id);
        }
    }
    None // errNoBuildID
}

// Go: (*os.File).ReadAt, which fails on a negative offset and on a short
// read.
#[cfg(unix)]
fn read_at(f: &File, buf: &mut [u8], off: i64) -> Option<()> {
    f.read_exact_at(buf, u64::try_from(off).ok()?).ok()
}

// PORT: off unix, a seek and a read (the only caller reads one file on one
// thread).
#[cfg(not(unix))]
fn read_at(mut f: &File, buf: &mut [u8], off: i64) -> Option<()> {
    use std::io::{Read, Seek, SeekFrom};
    f.seek(SeekFrom::Start(u64::try_from(off).ok()?)).ok()?;
    f.read_exact(buf).ok()
}

// Go: runtime/pprof/protobuf.go:8 protobuf
// A protobuf is a simple protocol buffer encoder.
// PORT: Go `tmp` holds the length bytes that `endMessage` moves, and
// `nest` serves `profileBuilder.flush`. `end_message` rotates the slice
// instead, and `flush` serves samples and locations, which the port does
// not write. So neither field is ported.
#[derive(Default)]
struct Protobuf {
    data: Vec<u8>,
}

impl Protobuf {
    // Go: runtime/pprof/protobuf.go:14 varint
    fn varint(&mut self, mut x: u64) {
        while x >= 128 {
            self.data.push(x as u8 | 0x80);
            x >>= 7;
        }
        self.data.push(x as u8);
    }

    // Go: runtime/pprof/protobuf.go:22 length
    fn length(&mut self, tag: u64, len: usize) {
        self.varint(tag << 3 | 2);
        self.varint(len as u64);
    }

    // Go: runtime/pprof/protobuf.go:27 uint64
    fn uint64(&mut self, tag: u64, x: u64) {
        // append varint to b.data
        self.varint(tag << 3);
        self.varint(x);
    }

    // Go: runtime/pprof/protobuf.go:53 uint64Opt
    fn uint64_opt(&mut self, tag: u64, x: u64) {
        if x == 0 {
            return;
        }
        self.uint64(tag, x);
    }

    // Go: runtime/pprof/protobuf.go:60 int64
    fn int64(&mut self, tag: u64, x: i64) {
        self.uint64(tag, x as u64);
    }

    // Go: runtime/pprof/protobuf.go:65 int64Opt
    fn int64_opt(&mut self, tag: u64, x: i64) {
        if x == 0 {
            return;
        }
        self.int64(tag, x);
    }

    // Go: runtime/pprof/protobuf.go:92 string
    fn string(&mut self, tag: u64, x: &[u8]) {
        self.length(tag, x.len());
        self.data.extend_from_slice(x);
    }

    // Go: runtime/pprof/protobuf.go:97 strings
    fn strings(&mut self, tag: u64, x: &[Vec<u8>]) {
        for s in x {
            self.string(tag, s);
        }
    }

    // Go: runtime/pprof/protobuf.go:127 startMessage
    fn start_message(&mut self) -> usize {
        self.data.len()
    }

    // Go: runtime/pprof/protobuf.go:132 endMessage
    // PORT: Go appends the length, then moves its bytes in front of the
    // message with `tmp`. `rotate_right` moves them the same way.
    fn end_message(&mut self, tag: u64, start: usize) {
        let n1 = start;
        let n2 = self.data.len();
        self.length(tag, n2 - n1);
        let n3 = self.data.len();
        self.data[n1..].rotate_right(n3 - n2);
    }
}
