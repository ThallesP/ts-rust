//! flowmemo1: an exact memo of flow sub-walk results (design:
//! `flowmemo0/design.md` under `target/continuation-r97-goport`, sections 4
//! and 7; the Go model and its check: `flowmemo1/go-model.md`,
//! `go-model-check.md`; the register model follows tsrs `flowmemo.rs`).
//!
//! Go walks the flow graph backwards from each reference
//! (`getTypeAtFlowNode`, flow.go:117) and keeps results only inside one walk
//! (`sharedFlows`) and at loop labels (`flowLoopCache`). The memo keeps the
//! result of a sub-walk (a "frame": one `get_type_at_flow_node` call) under
//! (flow node, reference key) across walks.
//!
//! Store rule: the frame began at inline and serialization level 0, outside
//! reduce labels, with flow analysis on; its result is complete, it consumed
//! no transient state older than itself (a loop label in process, a
//! resolution cycle, a re-entered or uncached signature resolution, a reduce
//! label, the inline or depth limit, an initializer type with no link, a
//! context stack entry older than the frame, or a shared-flow entry that
//! carries one), read nothing of the reference node beyond its key, and made
//! nothing (types, symbols, signatures, instantiations, diagnostics,
//! suggestions, deferred diagnostics). Use rule: no loop analysis and no
//! instantiation is active, flow analysis is on, the `flowTypeCache` epoch
//! and the instantiation count match when the entry depends on them, both
//! context stacks are empty when the entry read them, the walk has no
//! tainted shared-flow entry, and the depth limit cannot be reached.
//!
//! Taint uses serial numbers: frames, walks, loop-stack entries and type
//! resolutions take one; an event taints the active frames younger than its
//! source.
//!
//! `GOPORT_FLOWMEMO`: unset or `0` off (no key, no frames). `on`: a hit ends
//! the frame with the entry's type (no redo rule: verify checks the depth at
//! hits and where Go answers from a shared entry an `on` walk lacks).
//! `verify` keeps the table and both rules, but at each would-be hit it lets
//! Go's walk run on and panics at the frame's end when Go's result, effects
//! or depth differ from the entry, or when Go's walk consumed a value older
//! than the frame; it also panics when Go answers from a shared entry that
//! an `on` mode lacks and walking the node again could differ. A verify
//! run's output is Go's output. While a would-be hit's sub-walk runs,
//! nothing is consulted or stored, as in an `on` mode that skips it.
//! `GOPORT_FLOWMEMO_DROP` drops use-rule gates in verify (a stress test).
//! `GOPORT_FLOWMEMO_STATS=<file>` writes the process totals (walks, steps,
//! consults, hits, blocks and refusals by rule, saved steps).
//! `GOPORT_FLOWMEMO_BITS` sets log2 of the table size (default 14). The
//! memo is off in LSP and API sessions and for walks of freeable files.

use crate::prelude::*;
use smallvec::SmallVec;
use std::sync::OnceLock;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FlowMemoMode {
    Off,
    /// A hit ends the frame with the entry's type.
    On,
    Verify,
}

static MODE: OnceLock<FlowMemoMode> = OnceLock::new();

/// `GOPORT_FLOWMEMO`, read once per process.
pub fn flow_memo_mode_from_env() -> FlowMemoMode {
    *MODE.get_or_init(|| match std::env::var("GOPORT_FLOWMEMO").as_deref() {
        Ok("on") => FlowMemoMode::On,
        Ok("verify") => FlowMemoMode::Verify,
        _ => FlowMemoMode::Off,
    })
}

/// Keeps the memo off in this process (LSP and API sessions, design 4.6).
/// Call before the first checker is made.
pub fn disable_flow_memo() {
    let _ = MODE.set(FlowMemoMode::Off);
}

/// The gates of the use rule, in the order `flow_memo_turn` tests them.
const GATE_NAMES: [&str; 8] = [
    "loop", "mapper", "epoch", "count", "impure", "height", "disabled", "context",
];

/// `GOPORT_FLOWMEMO_DROP`: a comma list of `GATE_NAMES` that verify mode
/// does not apply (a stress test: a needed gate makes verify panic).
fn dropped_gates() -> u16 {
    static DROP: OnceLock<u16> = OnceLock::new();
    *DROP.get_or_init(|| {
        let list = std::env::var("GOPORT_FLOWMEMO_DROP").unwrap_or_default();
        list.split(',')
            .filter_map(|name| GATE_NAMES.iter().position(|g| *g == name.trim()))
            .fold(0, |bits, i| bits | 1 << i)
    })
}

fn table_bits() -> u32 {
    static BITS: OnceLock<u32> = OnceLock::new();
    *BITS.get_or_init(|| {
        std::env::var("GOPORT_FLOWMEMO_BITS")
            .ok()
            .and_then(|v| v.parse().ok())
            .filter(|b| (8..=24).contains(b))
            .unwrap_or(14)
    })
}

/// No taint source.
pub const UNTAINTED: u32 = u32::MAX;
/// `FlowState::memo_key` of a walk in a memo mode whose reference has no
/// key: its steps are counted, it has no frames.
pub const KEYLESS: u32 = u32::MAX;
/// Go's limit of nested `getTypeAtFlowNode` calls (flow.go:118).
const DEPTH_LIMIT: i32 = 2000;

/// The frame instantiated, ran under an active mapper, or made a type,
/// symbol, signature or diagnostic.
const FLAG_EFFECTS: u8 = 1;
/// The frame read or wrote `flowTypeCache`.
const FLAG_TYPE_CACHE: u8 = 2;
/// The frame may have reset `instantiationCount` (it was 0 at the start, or
/// it changed).
const FLAG_COUNT_RESET: u8 = 4;
/// The frame read the contextual or inference stack and its answer depends
/// on the entries older than the frame not matching (M6): used only while
/// both stacks are empty.
const FLAG_CONTEXT: u8 = 8;
/// The frame passed a branch label that a reduce label of its file targets
/// (a finally block's label, W4). Such a frame is not stored: an `on` mode
/// lacks the shared entries of a hit's sub-walk, and walks their nodes again
/// later in the walk, where an active reduce label can give such a label
/// other antecedents than Go's entry saw. Kept per walk: shared entries
/// belong to one walk.
const FLAG_FINALLY: u8 = 16;

#[derive(Clone, Copy, Default)]
struct Slot {
    flow: FlowNodeId,
    /// 0: empty.
    key: u32,
    t: TypeId,
    height: u16,
    count_reset: bool,
    /// `FLAG_CONTEXT`: used only while both context stacks are empty.
    context: bool,
    /// The `flowTypeCache` epoch the value depends on, or 0.
    epoch: u32,
}

#[derive(Clone, Copy, Debug)]
struct Regs {
    /// Oldest transient source consumed so far.
    transient: u32,
    /// Oldest walk whose reference node was read beyond its key.
    reference: u32,
    /// Largest child height + 1 so far.
    height: u16,
    flags: u8,
}

const FRESH: Regs = Regs {
    transient: UNTAINTED,
    reference: UNTAINTED,
    height: 0,
    flags: 0,
};

/// What a shared-flow entry of a keyed walk stood for (by index into
/// `Checker::shared_flows`).
#[derive(Clone, Copy, Default)]
struct SharedMeta {
    transient: u32,
    reference: u32,
    height: u16,
    flags: u8,
    /// Verify: an `on` mode would not have the entry (Go pushed it in a
    /// would-be hit's sub-walk); `steps` is what its frame walked.
    lost: bool,
    steps: u32,
    /// The `flowTypeCache` epoch when the entry was pushed.
    epoch: u32,
}

/// Go state that a re-walk of a stored frame must leave as it is (verify).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Snapshot {
    types: u32,
    symbols: u32,
    signatures: u32,
    total_instantiations: u32,
    instantiations: u32,
    diagnostics: i32,
    suggestions: i32,
    deferred: usize,
    flow_loop_cache: usize,
    flow_node_reachable: usize,
    flow_type_cache: usize,
    epoch: u32,
    misses: u64,
    flow_analysis_disabled: bool,
}

/// Verify mode: a would-be hit of the frame, checked at the frame's end.
struct Hit {
    slot: Slot,
    entry_depth: i32,
    node: FlowNodeId,
    regs: Regs,
    snapshot: Snapshot,
    steps: u64,
    time: Instant,
    /// Gates (bits by `GATE_NAMES`) that would have blocked the hit, dropped
    /// by `GOPORT_FLOWMEMO_DROP`.
    bypassed: u16,
}

struct Frame {
    start: u32,
    saved: Regs,
    instantiations: u32,
    total_instantiations: u32,
    created: u32,
    diagnostics: i32,
    suggestions: i32,
    /// `deferred_diagnostic_callbacks.len()` when the frame began.
    deferred: usize,
    in_instantiation: bool,
    entry: FlowNodeId,
    entry_depth: i32,
    /// The frame may consult and store: inline level 0, outside reduce
    /// labels and verify regions, flow analysis on.
    memo: bool,
    checkpoints: u32,
    /// `type_resolutions.len()` when the frame began.
    resolutions: u32,
    /// `contextual_infos.len()` and `inference_context_infos.len()` when
    /// the frame began (both only grow along the frame stack).
    contexts: u32,
    inferences: u32,
    own_steps: u32,
    /// `S::steps` when the frame began.
    steps: u64,
    /// The node of the frame's hit, or NIL.
    hit_node: FlowNodeId,
    /// Verify: the would-be hit, checked at the frame's end.
    hit: Option<Box<Hit>>,
}

#[derive(Clone, PartialEq, Eq, Hash)]
struct MemoKey {
    /// Root symbol, or `u32::MAX` for `this`.
    root: u32,
    declared: TypeId,
    initial: TypeId,
    container: Node,
    /// Property names from the reference down to the root.
    names: SmallVec<[&'static str; 4]>,
}

macro_rules! stats {
    ($($name:ident),* $(,)?) => {
        #[allow(non_camel_case_types, clippy::upper_case_acronyms)]
        #[derive(Clone, Copy)]
        #[repr(usize)]
        enum S { $($name),* , COUNT }
        const STAT_NAMES: &[&str] = &[$(stringify!($name)),*];
    };
}

stats!(
    walks,
    keyed_walks,
    frames,
    steps,
    keyed_steps,
    flow_ns,
    consults,
    found,
    hits,
    blocked_loop,
    blocked_mapper,
    blocked_epoch,
    blocked_count,
    blocked_impure,
    blocked_height,
    blocked_disabled,
    blocked_context,
    stores,
    store_slots,
    refused_nomemo,
    refused_region,
    refused_transient,
    refused_reference,
    refused_effects,
    refused_incomplete,
    refused_short,
    refused_finally,
    shared_ends,
    region_tainted,
    saved_steps,
    saved_ns,
    saved_frames,
    lost_shared,
    lost_steps,
    bypassed,
    context_reads,
    context_found_old,
    init_fallback,
);

const STATS: usize = S::COUNT as usize;
static STATS_TOTAL: [AtomicU64; STATS] = [const { AtomicU64::new(0) }; STATS];

fn stats_path() -> Option<&'static str> {
    static PATH: OnceLock<Option<String>> = OnceLock::new();
    PATH.get_or_init(|| std::env::var("GOPORT_FLOWMEMO_STATS").ok())
        .as_deref()
}

/// The flow memo state of one checker (`Checker::flow_memo`).
pub struct FlowMemo {
    pub mode: FlowMemoMode,
    serial: u32,
    regs: Regs,
    /// The current `flowTypeCache` instance. Starts at a value serials never
    /// take; a reset takes a serial, a restore puts the old epoch back.
    pub epoch: u32,
    /// Effect sites that a re-walk of a stored frame must not reach again
    /// (verify): type resolution pushes, signature resolutions, effects
    /// signatures, assignment marks, exhaustive switch states, cached
    /// expression checks.
    pub misses: u64,
    /// `get_narrowable_type_for_reference` reads of the reference position.
    pub position_reads: u64,
    /// Verify: gates of the use rule that are not applied (bits by
    /// `GATE_NAMES`).
    dropped: u16,
    slots: Vec<Slot>,
    keys: FxHashMap<MemoKey, u32>,
    frames: Vec<Frame>,
    checkpoints: Vec<FlowNodeId>,
    shared_meta: Vec<SharedMeta>,
    /// Per file: the branch labels its reduce labels target.
    finally_targets: FxHashMap<u32, Box<[FlowNodeId]>>,
    /// Verify regions (would-be hits whose sub-walk runs) now active.
    region: u32,
    /// `GOPORT_FLOWMEMO_STATS` is set: walks read the clock.
    stats_on: bool,
    /// Verify: the walk of the active region, and the largest depth at
    /// which a frame of that walk began in it.
    region_walk: u32,
    region_max_depth: i32,
    walk_depth: u32,
    outer_walks: u64,
    walk_time: Option<Instant>,
    stats: [u64; STATS],
    flushed: [u64; STATS],
}

impl Default for FlowMemo {
    fn default() -> Self {
        let mode = flow_memo_mode_from_env();
        FlowMemo {
            mode,
            dropped: if mode == FlowMemoMode::Verify {
                dropped_gates()
            } else {
                0
            },
            serial: 1,
            regs: FRESH,
            epoch: UNTAINTED,
            misses: 0,
            position_reads: 0,
            slots: Vec::new(),
            keys: FxHashMap::default(),
            frames: Vec::new(),
            checkpoints: Vec::new(),
            shared_meta: Vec::new(),
            finally_targets: FxHashMap::default(),
            region: 0,
            stats_on: stats_path().is_some(),
            region_walk: 0,
            region_max_depth: 0,
            walk_depth: 0,
            outer_walks: 0,
            walk_time: None,
            stats: [0; STATS],
            flushed: [0; STATS],
        }
    }
}

impl std::fmt::Debug for FlowMemo {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FlowMemo")
            .field("mode", &self.mode)
            .field("keys", &self.keys.len())
            .finish_non_exhaustive()
    }
}

impl Drop for FlowMemo {
    fn drop(&mut self) {
        self.flush();
    }
}

impl FlowMemo {
    /// A fresh serial: a frame's start, a walk, a loop-stack entry or a type
    /// resolution.
    #[inline]
    pub fn next_serial(&mut self) -> u32 {
        let s = self.serial;
        self.serial = self.serial.wrapping_add(1);
        if self.serial == UNTAINTED {
            // Serials would wrap: stop the memo, keep the rest exact.
            self.mode = FlowMemoMode::Off;
            self.serial = 1;
        }
        s
    }

    /// The active frames younger than `source` consumed a transient value.
    #[inline]
    pub fn taint(&mut self, source: u32) {
        if source < self.regs.transient {
            self.regs.transient = source;
        }
    }

    #[inline]
    fn taint_reference(&mut self, source: u32) {
        if source < self.regs.reference {
            self.regs.reference = source;
        }
    }

    /// A `flowTypeCache` read or write (`getTypeOfExpression`).
    #[inline]
    pub fn type_cache_used(&mut self) {
        self.regs.flags |= FLAG_TYPE_CACHE;
    }

    /// Go `c.flowTypeCache = nil`: a new cache instance. Returns the epoch to
    /// put back with the old cache.
    #[inline]
    pub fn type_cache_reset(&mut self) -> u32 {
        let saved = self.epoch;
        if self.mode != FlowMemoMode::Off {
            self.epoch = self.next_serial();
        }
        saved
    }

    /// The registers after a hit on `slot`: the entry's height and flags
    /// added to those of the frame so far.
    fn regs_after_hit(&self, mut regs: Regs, slot: &Slot) -> Regs {
        regs.height = regs.height.max(slot.height);
        if slot.epoch != 0 {
            regs.flags |= FLAG_TYPE_CACHE;
        }
        if slot.count_reset {
            regs.flags |= FLAG_COUNT_RESET;
        }
        if slot.context {
            regs.flags |= FLAG_CONTEXT;
        }
        regs
    }

    fn bump(&mut self, s: S, n: u64) {
        self.stats[s as usize] += n;
    }

    fn slot_index(&self, flow: FlowNodeId, key: u32) -> usize {
        let h = flow.0.wrapping_mul(0x9E37_79B9_7F4A_7C15) ^ u64::from(key).rotate_left(29);
        (h.wrapping_mul(0xFF51_AFD7_ED55_8CCD) >> 32) as usize & (self.slots.len() - 1)
    }

    fn lookup(&self, flow: FlowNodeId, key: u32) -> Option<Slot> {
        if self.slots.is_empty() {
            return None;
        }
        let slot = self.slots[self.slot_index(flow, key)];
        (slot.key == key && slot.flow == flow).then_some(slot)
    }

    fn store(&mut self, slot: Slot) {
        if self.slots.is_empty() {
            self.slots = vec![Slot::default(); 1 << table_bits()];
        }
        let i = self.slot_index(slot.flow, slot.key);
        self.slots[i] = slot;
        self.stats[S::store_slots as usize] += 1;
    }

    /// Adds the counts since the last flush to the process totals and writes
    /// the totals to the stats file. Called at the end of each checked file
    /// (`check_source_file`) and when the checker is dropped, so the file
    /// has every count when the process exits without dropping checkers.
    /// One lock for the add and the write: the last write has the totals.
    pub fn flush(&mut self) {
        let Some(path) = stats_path() else {
            return;
        };
        static WRITE: std::sync::Mutex<()> = std::sync::Mutex::new(());
        let _lock = WRITE.lock().unwrap_or_else(|e| e.into_inner());
        for i in 0..STATS {
            STATS_TOTAL[i].fetch_add(self.stats[i] - self.flushed[i], Ordering::Relaxed);
        }
        self.flushed = self.stats;
        let mut text = String::new();
        for (i, name) in STAT_NAMES.iter().enumerate() {
            text.push_str(&format!(
                "{name} {}\n",
                STATS_TOTAL[i].load(Ordering::Relaxed)
            ));
        }
        let _ = std::fs::write(path, text);
    }
}

/// About one flow node in four, chosen by the node, so walks that start at
/// different places agree on them.
fn is_checkpoint(flow: FlowNodeId) -> bool {
    flow.0.wrapping_mul(0x9E37_79B9_7F4A_7C15) >> 62 == 0
}

impl Checker {
    fn flow_memo_snapshot(&self) -> Snapshot {
        Snapshot {
            types: self.type_count,
            symbols: self.symbol_count,
            signatures: self.signature_count,
            total_instantiations: self.total_instantiation_count,
            instantiations: self.instantiation_count,
            diagnostics: self.diagnostics.count,
            suggestions: self.suggestion_diagnostics.count,
            deferred: self.deferred_diagnostic_callbacks.len(),
            flow_loop_cache: self.flow_loop_cache.len(),
            flow_node_reachable: self.flow_node_reachable.len(),
            flow_type_cache: self.flow_type_cache.len(),
            epoch: self.flow_memo.epoch,
            misses: self.flow_memo.misses,
            flow_analysis_disabled: self.flow_analysis_disabled,
        }
    }

    fn flow_memo_created(&self) -> u32 {
        self.type_count
            .wrapping_add(self.symbol_count)
            .wrapping_add(self.signature_count)
    }

    /// The key of a walk's reference (design 4.1): an identifier with a
    /// cached resolved symbol, `this`, or a chain of non-optional property
    /// accesses on them; with the declared and initial types and the flow
    /// container. 0 when the reference has none. Reads no uncached state.
    fn flow_memo_key(
        &mut self,
        reference: Node,
        declared: TypeId,
        initial: TypeId,
        container: Node,
    ) -> u32 {
        let mut names = SmallVec::new();
        let mut x = reference;
        let root = loop {
            match x.kind() {
                SyntaxKind::Identifier => {
                    if is_this_in_type_query(x) {
                        return 0;
                    }
                    let Some(links) = self.symbol_node_links.try_get(x) else {
                        return 0;
                    };
                    let symbol = links.resolved_symbol;
                    if symbol.is_nil() || symbol == self.unknown_symbol {
                        return 0;
                    }
                    break symbol.0;
                }
                SyntaxKind::ThisKeyword => break u32::MAX,
                SyntaxKind::PropertyAccessExpression => {
                    if x.flags().intersects(NodeFlags::OPTIONAL_CHAIN) {
                        return 0;
                    }
                    names.push(x.name().text());
                    x = x.expression();
                }
                _ => return 0,
            }
        };
        let key = MemoKey {
            root,
            declared,
            initial,
            container,
            names,
        };
        let next = self.flow_memo.keys.len() as u32 + 1;
        *self.flow_memo.keys.entry(key).or_insert(next)
    }

    /// Starts a walk in a memo mode (`flow_walk`): its key, its serial, and
    /// the enclosing frame's height set aside. Returns that height.
    #[cold]
    #[inline(never)]
    pub(crate) fn flow_memo_walk_begin(
        &mut self,
        f: &Rc<RefCell<FlowState>>,
        flow_node: FlowNodeId,
    ) -> (u16, u8) {
        let (reference, declared, initial, container) = {
            let fb = f.borrow();
            (
                fb.reference,
                fb.declared_type,
                fb.initial_type,
                fb.flow_container,
            )
        };
        // Only a walk of a static file (a walk stays in one file): the
        // flow node ids of a freeable file version can be used again.
        let key = if matches!(flow_node.get_flow(), FileRef::Static(_)) {
            self.flow_memo_key(reference, declared, initial, container)
        } else {
            0
        };
        let walk = self.flow_memo.next_serial();
        // A keyless walk takes the plain copy of the walk in `on` mode
        // (`memo_key` 0); verify and the stats count its steps.
        let keyless = if self.flow_memo.mode == FlowMemoMode::On && !self.flow_memo.stats_on {
            0
        } else {
            KEYLESS
        };
        let finally = key != 0
            && !self
                .flow_memo_finally_targets(flow_node.file_index())
                .is_empty();
        {
            let mut fb = f.borrow_mut();
            fb.memo_key = if key == 0 { keyless } else { key };
            fb.memo_walk = walk;
            fb.memo_impure = 0;
            fb.memo_finally = finally;
        }
        let memo = &mut self.flow_memo;
        memo.bump(S::walks, 1);
        if key != 0 {
            memo.bump(S::keyed_walks, 1);
        }
        if memo.walk_depth == 0 && memo.stats_on {
            memo.walk_time = Some(Instant::now());
        }
        memo.walk_depth += 1;
        let finally = memo.regs.flags & FLAG_FINALLY;
        (std::mem::take(&mut memo.regs.height), finally)
    }

    /// The branch labels that the reduce labels of static file `file`
    /// target (empty for another file).
    fn flow_memo_finally_targets(&mut self, file: usize) -> &[FlowNodeId] {
        self.flow_memo
            .finally_targets
            .entry(file as u32)
            .or_insert_with(|| {
                let Some(flows) = static_go_file(file).and_then(|g| g.flow_nodes.get()) else {
                    return Box::default();
                };
                flows
                    .iter()
                    .filter(|flow| flow.flags.intersects(FlowFlags::REDUCE_LABEL))
                    .map(|flow| flow.antecedents[0])
                    .collect()
            })
    }

    /// Ends a walk in a memo mode: the enclosing frame's height and
    /// `FLAG_FINALLY` come back (`saved` from `flow_memo_walk_begin`).
    #[cold]
    #[inline(never)]
    pub(crate) fn flow_memo_walk_end(&mut self, saved: (u16, u8)) {
        let memo = &mut self.flow_memo;
        memo.regs.height = saved.0;
        memo.regs.flags = memo.regs.flags & !FLAG_FINALLY | saved.1;
        memo.walk_depth -= 1;
        if memo.walk_depth == 0 {
            if let Some(t0) = memo.walk_time.take() {
                memo.bump(S::flow_ns, t0.elapsed().as_nanos() as u64);
            }
            memo.outer_walks += 1;
        }
    }

    /// Begins a frame of a keyed walk (`get_type_at_flow_node`, after the
    /// depth check). `depth` is the walk depth before this call.
    // Not `#[cold]`: in `on` mode these run at every step and frame of a
    // keyed walk (`get_type_at_flow_node_memo_body`).
    #[inline(never)]
    pub(crate) fn flow_memo_begin(
        &mut self,
        f: &Rc<RefCell<FlowState>>,
        flow: FlowNodeId,
        depth: i32,
    ) {
        let (key, reduce, walk) = {
            let fb = f.borrow();
            (fb.memo_key, !fb.reduce_labels.is_empty(), fb.memo_walk)
        };
        if key == KEYLESS {
            return;
        }
        if self.flow_memo.region != 0 && walk == self.flow_memo.region_walk {
            let memo = &mut self.flow_memo;
            memo.region_max_depth = memo.region_max_depth.max(depth);
        }
        // A frame at serialization level 1 or more can make errors that Go
        // drops (`add_diagnostic` at level 2), so it neither consults nor
        // stores (M7).
        let memo = self.inline_level == 0
            && !reduce
            && !self.flow_analysis_disabled
            && self.serialization_level == 0
            && self.flow_memo.region == 0;
        let frame = Frame {
            start: self.flow_memo.next_serial(),
            saved: self.flow_memo.regs,
            instantiations: self.instantiation_count,
            total_instantiations: self.total_instantiation_count,
            created: self.flow_memo_created(),
            diagnostics: self.diagnostics.count,
            suggestions: self.suggestion_diagnostics.count,
            deferred: self.deferred_diagnostic_callbacks.len(),
            in_instantiation: !self.active_mappers.is_empty(),
            entry: flow,
            entry_depth: depth,
            memo,
            checkpoints: self.flow_memo.checkpoints.len() as u32,
            resolutions: self.type_resolutions.len() as u32,
            contexts: self.contextual_infos.len() as u32,
            inferences: self.inference_context_infos.len() as u32,
            own_steps: 0,
            steps: self.flow_memo.stats[S::steps as usize],
            hit_node: FlowNodeId::NIL,
            hit: None,
        };
        self.flow_memo.regs = FRESH;
        self.flow_memo.frames.push(frame);
        self.flow_memo.bump(S::frames, 1);
    }

    /// One loop turn of `get_type_at_flow_node` in a memo walk, after Go's
    /// `sharedFlows` scan (`shared_flow` is the iteration's last shared node
    /// so far): counts the step and, in a keyed frame, consults the memo at
    /// its first node, at a node that ends its iteration and at checkpoints.
    /// A hit in `on` mode ends the frame as Go's walk from the node would and
    /// returns the type: when the node ends the iteration, Go's last shared
    /// node of the iteration is known and gets its entry; a hit in the middle
    /// of an iteration pushes none. In verify, Go's walk runs on.
    // Not `#[cold]`: in `on` mode these run at every step and frame of a
    // keyed walk (`get_type_at_flow_node_memo_body`).
    #[inline(never)]
    pub(crate) fn flow_memo_turn(
        &mut self,
        f: &Rc<RefCell<FlowState>>,
        flow: FlowNodeId,
        flow_data: &FlowNode,
        shared_flow: FlowNodeId,
    ) -> Option<FlowType> {
        let (key, impure, finally) = {
            let fb = f.borrow();
            (fb.memo_key, fb.memo_impure, fb.memo_finally)
        };
        self.flow_memo.bump(S::steps, 1);
        if key == KEYLESS {
            return None;
        }
        self.flow_memo.bump(S::keyed_steps, 1);
        if finally
            && flow_data.flags.intersects(FlowFlags::BRANCH_LABEL)
            && self.flow_memo.finally_targets[&(flow.file_index() as u32)].contains(&flow)
        {
            self.flow_memo.regs.flags |= FLAG_FINALLY;
        }
        let frame = self.flow_memo.frames.last_mut()?;
        frame.own_steps += 1;
        if !frame.memo || self.flow_memo.region != 0 {
            return None;
        }
        let entry = frame.entry;
        let entry_depth = frame.entry_depth;
        let flags = flow_data.flags;
        let ends_iteration = flags.intersects(FlowFlags::CONDITION | FlowFlags::SWITCH_CLAUSE)
            || flags.intersects(FlowFlags::BRANCH_LABEL | FlowFlags::LOOP_LABEL)
                && flow_data.antecedents.len() > 1;
        if !ends_iteration && flow != entry {
            if !is_checkpoint(flow) {
                return None;
            }
            self.flow_memo.checkpoints.push(flow);
        }
        self.flow_memo.bump(S::consults, 1);
        let slot = self.flow_memo.lookup(flow, key)?;
        self.flow_memo.bump(S::found, 1);
        // The use rule, gate by gate, in `GATE_NAMES` order. Verify can drop
        // gates (`GOPORT_FLOWMEMO_DROP`) to show that each one is needed.
        let gates = [
            (!self.flow_loop_stack.is_empty(), S::blocked_loop),
            (!self.active_mappers.is_empty(), S::blocked_mapper),
            (
                slot.epoch != 0 && slot.epoch != self.flow_memo.epoch,
                S::blocked_epoch,
            ),
            (
                slot.count_reset && self.instantiation_count != 0,
                S::blocked_count,
            ),
            (impure != 0, S::blocked_impure),
            (
                entry_depth + i32::from(slot.height) >= DEPTH_LIMIT,
                S::blocked_height,
            ),
            // A nested walk reached the depth limit in this frame: Go's walk
            // from here gets errorType from every nested walk (M1).
            (self.flow_analysis_disabled, S::blocked_disabled),
            (
                slot.context
                    && !(self.contextual_infos.is_empty()
                        && self.inference_context_infos.is_empty()),
                S::blocked_context,
            ),
        ];
        let mut bypassed = 0u16;
        for (i, (closed, stat)) in gates.into_iter().enumerate() {
            if closed {
                if self.flow_memo.dropped & (1 << i) != 0 {
                    bypassed |= 1 << i;
                    continue;
                }
                self.flow_memo.bump(stat, 1);
                return None;
            }
        }
        if bypassed != 0 {
            self.flow_memo.bump(S::bypassed, 1);
        }
        self.flow_memo.bump(S::hits, 1);
        if self.flow_memo.mode == FlowMemoMode::On {
            let t = FlowType {
                t: slot.t,
                incomplete: false,
            };
            let memo = &mut self.flow_memo;
            memo.regs = memo.regs_after_hit(memo.regs, &slot);
            memo.frames.last_mut().unwrap().hit_node = flow;
            let shared = (ends_iteration && shared_flow.is_some()).then(|| {
                self.shared_flows.push(SharedFlow {
                    flow: shared_flow,
                    flow_type: t,
                });
                self.shared_flows.len() - 1
            });
            f.borrow_mut().depth -= 1;
            self.flow_memo_end(f, flow, t, shared);
            return Some(t);
        }
        // Verify: Go's walk runs on; the frame's end checks it.
        let hit = Hit {
            slot,
            entry_depth,
            node: flow,
            regs: self.flow_memo.regs,
            snapshot: self.flow_memo_snapshot(),
            steps: self.flow_memo.stats[S::steps as usize],
            time: Instant::now(),
            bypassed,
        };
        self.flow_memo.regs = FRESH;
        self.flow_memo.region += 1;
        self.flow_memo.region_walk = f.borrow().memo_walk;
        self.flow_memo.region_max_depth = entry_depth;
        let frame = self.flow_memo.frames.last_mut().unwrap();
        frame.hit_node = flow;
        frame.hit = Some(Box::new(hit));
        None
    }

    /// Ends the frame's registers: the taint older than the frame, its
    /// flags, and the parent's registers with this frame's height
    /// (`height` + 1) folded in.
    fn flow_memo_end_regs(&mut self, frame: &Frame, height: u16) -> Regs {
        let memo = &mut self.flow_memo;
        let r = memo.regs;
        let taint = Regs {
            transient: if r.transient < frame.start {
                r.transient
            } else {
                UNTAINTED
            },
            reference: if r.reference < frame.start {
                r.reference
            } else {
                UNTAINTED
            },
            height,
            flags: r.flags,
        };
        let p = frame.saved;
        memo.regs = Regs {
            transient: r.transient.min(p.transient),
            reference: r.reference.min(p.reference),
            height: p.height.max(height.saturating_add(1)),
            flags: r.flags | p.flags,
        };
        taint
    }

    /// Adds the frame's counter flags to the registers.
    fn flow_memo_counters(&mut self, frame: &Frame) {
        if self.total_instantiation_count != frame.total_instantiations
            || frame.in_instantiation
            || self.flow_memo_created() != frame.created
            || self.diagnostics.count != frame.diagnostics
            || self.suggestion_diagnostics.count != frame.suggestions
            || self.deferred_diagnostic_callbacks.len() != frame.deferred
        {
            self.flow_memo.regs.flags |= FLAG_EFFECTS;
        }
        if frame.instantiations == 0 || self.instantiation_count != frame.instantiations {
            self.flow_memo.regs.flags |= FLAG_COUNT_RESET;
        }
    }

    /// Verify: the frame had a would-be hit; Go's walk from there must give
    /// the entry's type and change nothing. Then the registers become what
    /// an `on` mode's hit leaves.
    fn flow_memo_verify(
        &mut self,
        f: &Rc<RefCell<FlowState>>,
        hit: &Hit,
        frame_start: u32,
        t: FlowType,
    ) {
        self.flow_memo.region -= 1;
        // The depth Go's walk reached below the frame (the registers' height
        // also counts shared-flow hits with the height they stand for).
        let region_height = (self.flow_memo.region_max_depth - hit.entry_depth) as u16;
        let region = self.flow_memo.regs;
        let region_transient = region.transient != UNTAINTED;
        let now = self.flow_memo_snapshot();
        let problem = if t.t != hit.slot.t || t.incomplete {
            Some(format!(
                "Go's walk gave type {:?} `{}` (incomplete {}), the memo {:?} `{}`",
                t.t,
                self.type_to_string(t.t),
                t.incomplete,
                hit.slot.t,
                self.type_to_string(hit.slot.t)
            ))
        } else if now != hit.snapshot {
            Some(format!(
                "Go's walk changed state: at the hit {:?}, at the end {now:?}",
                hit.snapshot
            ))
        } else if region_height > hit.slot.height {
            Some(format!(
                "Go's walk reached height {region_height}, the entry has {}",
                hit.slot.height
            ))
        } else if region.transient < frame_start || region.reference < frame_start {
            // The stored frame consumed nothing older than itself, so Go's
            // walk took another path.
            Some(format!(
                "Go's walk consumed a value older than the frame (transient {}, reference {}, frame {frame_start})",
                region.transient, region.reference
            ))
        } else {
            None
        };
        if let Some(mut problem) = problem {
            if hit.bypassed != 0 {
                let names: Vec<&str> = (0..GATE_NAMES.len())
                    .filter(|i| hit.bypassed & (1 << i) != 0)
                    .map(|i| GATE_NAMES[i])
                    .collect();
                problem.push_str(&format!(" (dropped gates passed: {})", names.join(",")));
            }
            self.flow_memo_panic(f, hit.node, &problem);
        }
        let memo = &mut self.flow_memo;
        let saved = memo.stats[S::steps as usize] - hit.steps;
        memo.bump(S::saved_steps, saved);
        memo.bump(S::saved_ns, hit.time.elapsed().as_nanos() as u64);
        memo.bump(S::saved_frames, 1);
        if region_transient {
            memo.bump(S::region_tainted, 1);
        }
        // The registers of the sub-walk Go ran are dropped: an `on` mode
        // takes only the entry's height and flags.
        memo.regs = memo.regs_after_hit(hit.regs, &hit.slot);
    }

    /// Verify found a difference from Go at flow node `node`.
    fn flow_memo_panic(&self, f: &Rc<RefCell<FlowState>>, node: FlowNodeId, problem: &str) -> ! {
        let reference = f.borrow().reference;
        let source_file = get_source_file_of_node(reference);
        panic!(
            "flowmemo verify: {} pos {} reference `{}` ({:?}) at flow node {:?} ({:?}): {problem}",
            source_file_file_name(source_file),
            reference.pos(),
            get_text_of_node(reference),
            reference.kind(),
            node,
            node.get_flow().flags,
        );
    }

    /// Ends a keyed frame that returned a `sharedFlows` entry (index `i`):
    /// the frame consumed what that entry's computation consumed.
    // Not `#[cold]`: in `on` mode these run at every step and frame of a
    // keyed walk (`get_type_at_flow_node_memo_body`).
    #[inline(never)]
    pub(crate) fn flow_memo_end_shared(&mut self, f: &Rc<RefCell<FlowState>>, i: usize) {
        if f.borrow().memo_key == KEYLESS {
            return;
        }
        if self
            .flow_memo
            .frames
            .last()
            .is_some_and(|frame| frame.hit.is_some())
        {
            // Go's walk on from a would-be hit ended at a shared node: an
            // `on` mode ends the frame at the hit.
            let t = self.shared_flows[i].flow_type;
            self.flow_memo_end(f, FlowNodeId::NIL, t, None);
            return;
        }
        let frame = self.flow_memo.frames.pop().expect("a flow memo frame");
        let meta = self.flow_memo.shared_meta[i];
        if meta.lost && self.flow_memo.region == 0 {
            // An `on` mode does not have this entry: this frame walks the
            // node again. That walk equals the one Go's entry stands for only
            // in the same state (W4): no active reduce label that targets a
            // label the entry passed (`getBranchLabelAntecedents` reads them;
            // a region has none, `FLAG_FINALLY`), no loop analysis, the same
            // `flowTypeCache` when the entry read it, room below the depth
            // limit, and an entry that consumed no transient value and made
            // nothing.
            let problem = if !f.borrow().reduce_labels.is_empty() && meta.flags & FLAG_FINALLY != 0
            {
                Some("a reduce label is active and the entry passed a label it can target")
            } else if !self.flow_loop_stack.is_empty() {
                Some("loop analysis is active")
            } else if meta.flags & FLAG_TYPE_CACHE != 0 && meta.epoch != self.flow_memo.epoch {
                Some("the flowTypeCache is another one")
            } else if frame.entry_depth + i32::from(meta.height) >= DEPTH_LIMIT {
                Some("the depth limit is in reach")
            } else if meta.transient != UNTAINTED {
                Some("the entry consumed a transient value")
            } else if meta.flags & FLAG_EFFECTS != 0 {
                Some("the entry made something")
            } else {
                None
            };
            if let Some(problem) = problem {
                self.flow_memo_panic(
                    f,
                    self.shared_flows[i].flow,
                    &format!("Go answers from an entry that an `on` mode lacks, and {problem}"),
                );
            }
            let memo = &mut self.flow_memo;
            memo.shared_meta[i].lost = false;
            memo.bump(S::lost_shared, 1);
            memo.bump(S::lost_steps, u64::from(meta.steps));
        }
        if meta.transient != UNTAINTED {
            let source = meta.transient;
            // The source is live when it is a loop stack entry still on the
            // stack: only the frames younger than it are tainted. Any other
            // source (0, or a resolution cycle's serial before a frame's
            // start, `flow_memo_resolution_cycle`) taints every frame. A cycle
            // source can equal the serial of a loop entry pushed just before
            // that frame began; that entry is younger than the resolution, so
            // while it is live the resolution is too, and the frames younger
            // than it are the frames the cycle tainted.
            let live = source != 0 && self.flow_loop_stack.iter().any(|l| l.memo_serial == source);
            self.flow_memo.taint(if live { source } else { 0 });
        }
        if meta.reference != UNTAINTED {
            self.flow_memo.taint_reference(meta.reference);
        }
        self.flow_memo.regs.flags |= meta.flags;
        self.flow_memo_counters(&frame);
        self.flow_memo_end_regs(&frame, meta.height);
        self.flow_memo
            .checkpoints
            .truncate(frame.checkpoints as usize);
        self.flow_memo.bump(S::shared_ends, 1);
    }

    /// Ends a keyed frame that computed `t` at `last` (the node that ended
    /// its iteration). `shared` is the index of the `sharedFlows` entry the
    /// frame pushed, if any. Stores the result when the store rule holds.
    // Not `#[cold]`: in `on` mode these run at every step and frame of a
    // keyed walk (`get_type_at_flow_node_memo_body`).
    #[inline(never)]
    pub(crate) fn flow_memo_end(
        &mut self,
        f: &Rc<RefCell<FlowState>>,
        last: FlowNodeId,
        t: FlowType,
        shared: Option<usize>,
    ) {
        let key = f.borrow().memo_key;
        if key == KEYLESS {
            return;
        }
        let mut frame = self.flow_memo.frames.pop().expect("a flow memo frame");
        if let Some(hit) = frame.hit.take() {
            self.flow_memo_verify(f, &hit, frame.start, t);
        }
        let hit_node = frame.hit_node;
        self.flow_memo_counters(&frame);
        let height = self.flow_memo.regs.height;
        let taint = self.flow_memo_end_regs(&frame, height);
        if let Some(i) = shared {
            let memo = &mut self.flow_memo;
            if memo.shared_meta.len() <= i {
                memo.shared_meta.resize(i + 1, SharedMeta::default());
            }
            let lost = memo.region != 0 || hit_node.is_some() && hit_node != last;
            let steps = (memo.stats[S::steps as usize] - frame.steps).min(u64::from(u32::MAX));
            memo.shared_meta[i] = SharedMeta {
                transient: taint.transient,
                reference: taint.reference,
                height,
                flags: taint.flags,
                lost,
                steps: steps as u32,
                epoch: memo.epoch,
            };
            if taint.transient != UNTAINTED {
                f.borrow_mut().memo_impure += 1;
            }
        }
        let refused = if !frame.memo {
            Some(S::refused_nomemo)
        } else if self.flow_memo.region != 0 {
            Some(S::refused_region)
        } else if taint.transient != UNTAINTED {
            Some(S::refused_transient)
        } else if taint.reference != UNTAINTED {
            Some(S::refused_reference)
        } else if taint.flags & FLAG_EFFECTS != 0 {
            Some(S::refused_effects)
        } else if t.incomplete || self.flow_analysis_disabled {
            Some(S::refused_incomplete)
        } else if taint.flags & FLAG_FINALLY != 0 {
            Some(S::refused_finally)
        } else if height == 0 && frame.own_steps < 4 && hit_node.is_nil() {
            // A short iteration without recursion costs less to walk again.
            Some(S::refused_short)
        } else {
            None
        };
        let memo = &mut self.flow_memo;
        if let Some(reason) = refused {
            memo.bump(reason, 1);
        } else {
            memo.bump(S::stores, 1);
            let slot = Slot {
                flow: frame.entry,
                key,
                t: t.t,
                height,
                count_reset: taint.flags & FLAG_COUNT_RESET != 0,
                context: taint.flags & FLAG_CONTEXT != 0,
                epoch: if taint.flags & FLAG_TYPE_CACHE != 0 {
                    memo.epoch
                } else {
                    0
                },
            };
            // A hit ends the iteration at the hit node, which has the entry.
            let last = if hit_node.is_some() { hit_node } else { last };
            if hit_node.is_nil() || last != frame.entry {
                memo.store(slot);
            }
            if hit_node.is_nil() && last != frame.entry {
                memo.store(Slot { flow: last, ..slot });
            }
            for i in frame.checkpoints as usize..memo.checkpoints.len() {
                let checkpoint = memo.checkpoints[i];
                if checkpoint != last {
                    memo.store(Slot {
                        flow: checkpoint,
                        ..slot
                    });
                }
            }
        }
        memo.checkpoints.truncate(frame.checkpoints as usize);
    }

    /// Reference taint of the current walk: Go read the reference node
    /// beyond its key.
    pub(crate) fn flow_memo_reference_read(&mut self, f: &Rc<RefCell<FlowState>>) {
        let walk = f.borrow().memo_walk;
        if walk != 0 {
            self.flow_memo.taint_reference(walk);
        }
    }

    /// A type resolution cycle found entry `i` (`findResolutionCycleStartIndex`):
    /// the frames that began after the entry was pushed read a transient
    /// result. Frames nest in time, so they are the frames on the stack from
    /// the first one that began with more than `i` entries.
    #[cold]
    #[inline(never)]
    pub(crate) fn flow_memo_resolution_cycle(&mut self, i: usize) {
        let memo = &mut self.flow_memo;
        if let Some(frame) = memo
            .frames
            .iter()
            .find(|frame| frame.resolutions as usize > i)
        {
            let source = frame.start - 1;
            memo.taint(source);
        }
    }

    /// A read of the contextual (`inference` false) or inference stack that
    /// found entry `found` or nothing (M6). The frames that began after that
    /// entry was pushed read a value older than themselves: taint. The answer
    /// also depends on the entries older than a frame not matching (the
    /// contextual search starts at the oldest entry; an inference search
    /// that finds nothing reads them all), so the frames get `FLAG_CONTEXT`.
    /// The newest inference match reads no older entry.
    #[cold]
    #[inline(never)]
    pub(crate) fn flow_memo_context_read(&mut self, inference: bool, found: Option<usize>) {
        let memo = &mut self.flow_memo;
        if memo.frames.is_empty() {
            return;
        }
        memo.bump(S::context_reads, 1);
        if !inference || found.is_none() {
            memo.regs.flags |= FLAG_CONTEXT;
        }
        if let Some(j) = found {
            let first = memo.frames.partition_point(|frame| {
                (if inference {
                    frame.inferences
                } else {
                    frame.contexts
                }) as usize
                    <= j
            });
            if let Some(frame) = memo.frames.get(first) {
                let source = frame.start - 1;
                memo.bump(S::context_found_old, 1);
                memo.taint(source);
            }
        }
    }

    /// `getTypeOfInitializer` (flow.go:2264) found no link and computes the
    /// type without caching it (M4). A later `checkExpressionCached` sets the
    /// link, and a later walk reads that instead: every active frame is
    /// tainted.
    #[cold]
    #[inline(never)]
    pub(crate) fn flow_memo_initializer_fallback(&mut self) {
        let memo = &mut self.flow_memo;
        if !memo.frames.is_empty() {
            memo.bump(S::init_fallback, 1);
        }
        memo.taint(0);
    }

    /// Taint by the newest flow loop stack entry (Go does not cache a
    /// signature resolved under loop analysis, checker.go:8651).
    pub(crate) fn flow_memo_taint_loop_top(&mut self) {
        if let Some(top) = self.flow_loop_stack.last() {
            let source = top.memo_serial;
            self.flow_memo.taint(source);
        }
    }
}

impl FlowMemo {
    /// A counter of this checker by its stats name (tests).
    #[cfg(test)]
    fn stat(&self, name: &str) -> u64 {
        let i = STAT_NAMES.iter().position(|n| *n == name).expect("a stat");
        self.stats[i]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// What a check of `a.ts` gave: diagnostic codes, the type, symbol and
    /// instantiation counts, and the memo's hits and stores.
    #[derive(Debug, PartialEq)]
    struct Outcome {
        codes: Vec<i32>,
        counts: (u32, u32, u32),
        hits: u64,
        stores: u64,
    }

    /// Checks `a.ts` (`source`) in a new project with the memo in `mode`
    /// (verify panics when a would-be hit differs from Go's walk).
    fn check_with_memo(label: &str, source: &str, mode: FlowMemoMode) -> Outcome {
        let dir =
            std::env::temp_dir().join(format!("ts_goport_flowmemo_{label}_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.ts"), source).unwrap();
        std::fs::write(
            dir.join("tsconfig.json"),
            r#"{ "compilerOptions": { "strict": true, "target": "es2020", "types": [] }, "files": ["a.ts"] }"#,
        )
        .unwrap();
        let config = dir.join("tsconfig.json");
        let program = crate::program::try_load_version(&config.to_string_lossy(), |_| {})
            .unwrap_or_else(|e| panic!("cannot load {}: {e}", config.display()));
        let _ = std::fs::remove_dir_all(&dir);
        let scope = crate::core::enter_program(Some(program));
        let file = program
            .source_files()
            .find(|file| file.info.file_name.ends_with("/a.ts"))
            .expect("a.ts is not in the program")
            .root;
        let result = crate::program::with_type_checker_for_file(file, move |checker| {
            checker.flow_memo.mode = mode;
            let ctx = crate::gostd::context::background();
            let codes: Vec<i32> = checker
                .get_diagnostics(&ctx, file, false)
                .iter()
                .map(|d| d.code())
                .collect();
            Outcome {
                codes,
                counts: (
                    checker.type_count,
                    checker.symbol_count,
                    checker.total_instantiation_count,
                ),
                hits: checker.flow_memo.stat("hits"),
                stores: checker.flow_memo.stat("stores"),
            }
        });
        drop(scope);
        crate::program::release_program(program);
        result
    }

    /// Repeated references to one variable after a long chain of
    /// statements hit the memo, and Go's walks agree.
    #[test]
    fn repeated_references_hit() {
        let mut source = String::from(
            "declare function g(n: number): void;\nexport function f(x: string | number | undefined, o: { a?: { b: string | number } }) {\n",
        );
        for i in 0..12 {
            source.push_str(&format!(
                "  g({i});\n  let v{i} = {i};\n  if (v{i} > 3) g(v{i});\n"
            ));
        }
        source.push_str("  if (x === undefined || !o.a) return;\n");
        for _ in 0..6 {
            source.push_str("  g(typeof x === 'string' ? x.length : x);\n  o.a.b;\n");
        }
        source.push_str("}\n");
        let on = all_modes_agree("repeat", &source);
        assert_eq!(on.codes, Vec::<i32>::new());
        assert!(on.hits > 0, "{on:?}");
    }

    /// Off, verify and on give the same diagnostics and counts, and verify
    /// and on hit the same number of times. Returns the `on` outcome.
    fn all_modes_agree(label: &str, source: &str) -> Outcome {
        let off = check_with_memo(&format!("{label}_off"), source, FlowMemoMode::Off);
        let verify = check_with_memo(&format!("{label}_verify"), source, FlowMemoMode::Verify);
        let on = check_with_memo(&format!("{label}_on"), source, FlowMemoMode::On);
        assert_eq!((&off.codes, off.counts), (&verify.codes, verify.counts));
        assert_eq!((&off.codes, off.counts), (&on.codes, on.counts));
        assert!(verify.stores > 0, "{verify:?}");
        on
    }

    /// Loops, try/finally, an auto-typed `let` assigned object literals,
    /// aliased conditions and a constraint position: verify mode finds no
    /// difference.
    #[test]
    fn transient_cases_agree() {
        let source = r#"
declare function g(n: unknown): void;
declare function cond(): boolean;
export function loops(xs: number[]) {
  let a: string | number = 0;
  for (const x of xs) {
    if (typeof a === "number") a = String(a);
    else a = x;
    g(a); g(a); g(a);
  }
  g(a); g(a);
}
export function auto() {
  let o;
  o = { k: 1 };
  g(o); g(o);
  if (cond()) o = { k: 2 };
  g(o); g(o); g(o);
}
export function tryFinally(x: string | undefined) {
  try {
    if (!x) return;
    g(x); g(x);
  } finally {
    g(x); g(x);
  }
  g(x); g(x);
}
export function alias(x: string | number, y: string | number) {
  const isString = typeof x === "string";
  const both = isString && typeof y === "string";
  if (both) { g(x.length); g(x.length); g(y.length); }
  if (isString) { g(x.length); g(x.length); }
}
export function constraint<T extends string | undefined>(t: T) {
  let u = t;
  if (u) { g(u.length); g(u.length); }
  g(u); g(u);
}
"#;
        let on = all_modes_agree("transient", source);
        assert_eq!(on.codes, Vec::<i32>::new());
    }
}
