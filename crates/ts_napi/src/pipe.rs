//! A one-way in-memory queue between threads, with a close reason: the
//! frame pipes between the JS thread and the session thread, and the
//! session thread's command queue.
//!
//! A reader that finds the queue empty spins for `SPIN` before it sleeps on
//! the condition variable. Both sides of a request are usually ready within
//! microseconds, and a futex wake costs about 28 µs per round trip, where a
//! spinning reader sees the item in under 1 µs (napi-session probe,
//! `R-rust-host.md`).

use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Condvar, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

/// How long a reader spins on an empty pipe before it sleeps.
const SPIN: Duration = Duration::from_micros(50);

/// Spins between two reads of the clock.
const SPINS_PER_CLOCK: u32 = 64;

pub struct Pipe<T> {
    state: Mutex<State<T>>,
    ready: Condvar,
    /// Counts pushes and the close: a spinning reader watches it without
    /// the lock.
    version: AtomicU64,
}

struct State<T> {
    items: VecDeque<T>,
    closed: Option<String>,
    /// Readers that sleep on `ready`.
    sleepers: usize,
}

impl<T> Pipe<T> {
    pub fn new() -> Self {
        Pipe {
            state: Mutex::new(State {
                items: VecDeque::new(),
                closed: None,
                sleepers: 0,
            }),
            ready: Condvar::new(),
            version: AtomicU64::new(0),
        }
    }

    fn lock(&self) -> MutexGuard<'_, State<T>> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Appends `items`. False when the pipe is closed: they are dropped.
    pub fn push(&self, items: impl IntoIterator<Item = T>) -> bool {
        let mut state = self.lock();
        if state.closed.is_some() {
            return false;
        }
        state.items.extend(items);
        self.version.fetch_add(1, Ordering::Release);
        let wake = state.sleepers > 0;
        drop(state);
        if wake {
            self.ready.notify_all();
        }
        true
    }

    /// Appends `item`, or gives it back when the pipe is closed.
    pub fn send(&self, item: T) -> Result<(), T> {
        let mut state = self.lock();
        if state.closed.is_some() {
            return Err(item);
        }
        state.items.push_back(item);
        self.version.fetch_add(1, Ordering::Release);
        let wake = state.sleepers > 0;
        drop(state);
        if wake {
            self.ready.notify_all();
        }
        Ok(())
    }

    /// Closes the pipe. The items in it can still be read. The first
    /// reason stays.
    pub fn close(&self, reason: &str) {
        let mut state = self.lock();
        if state.closed.is_none() {
            state.closed = Some(reason.to_string());
        }
        self.version.fetch_add(1, Ordering::Release);
        drop(state);
        self.ready.notify_all();
    }

    pub fn is_closed(&self) -> bool {
        self.lock().closed.is_some()
    }

    /// The close reason, or `None` while the pipe is open.
    pub fn reason(&self) -> Option<String> {
        self.lock().closed.clone()
    }

    /// Closed, with nothing left to read.
    pub fn is_finished(&self) -> bool {
        let state = self.lock();
        state.closed.is_some() && state.items.is_empty()
    }

    /// The next item without a wait: `None` when the pipe is empty and
    /// open, `Some(Err)` with the close reason when it is empty and closed.
    pub fn pop_now(&self) -> Option<Result<T, String>> {
        let mut state = self.lock();
        if let Some(item) = state.items.pop_front() {
            return Some(Ok(item));
        }
        state.closed.clone().map(Err)
    }

    /// The next item, after a wait for one. `Err` with the close reason
    /// once the pipe is closed and empty.
    pub fn pop(&self) -> Result<T, String> {
        let start = Instant::now();
        loop {
            let seen = self.version.load(Ordering::Acquire);
            let mut state = self.lock();
            if let Some(item) = state.items.pop_front() {
                return Ok(item);
            }
            if let Some(reason) = &state.closed {
                return Err(reason.clone());
            }
            if start.elapsed() >= SPIN {
                state.sleepers += 1;
                while state.items.is_empty() && state.closed.is_none() {
                    state = self
                        .ready
                        .wait(state)
                        .unwrap_or_else(PoisonError::into_inner);
                }
                state.sleepers -= 1;
                continue;
            }
            drop(state);
            self.spin_while_unchanged(seen, start);
        }
    }

    /// Spins until `version` moves past `seen` or `SPIN` has passed since
    /// `start`.
    fn spin_while_unchanged(&self, seen: u64, start: Instant) {
        loop {
            for _ in 0..SPINS_PER_CLOCK {
                if self.version.load(Ordering::Acquire) != seen {
                    return;
                }
                std::hint::spin_loop();
            }
            if start.elapsed() >= SPIN {
                return;
            }
        }
    }
}
