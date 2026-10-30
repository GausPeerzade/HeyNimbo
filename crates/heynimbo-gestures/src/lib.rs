//! Detects modifier-only gestures from raw keyboard and pointer events.
//!
//! Two gesture kinds are supported:
//! - **Hold**: a chord of modifiers held down, e.g. Ctrl+Option for push-to-talk.
//! - **Multi-tap**: a chord pressed and released quickly N times, e.g. Ctrl twice.
//!
//! The detector is pure: callers feed events with a monotonic timestamp and
//! re-arm a timer from [`GestureDetector::next_deadline`]. Platform hooks only
//! translate OS events into [`InputEvent`]s.

use thiserror::Error;

/// A set of modifier keys. Lock keys (Caps Lock, Num Lock) are deliberately absent,
/// so a lock key never changes which gesture matches.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct Modifiers(u8);

impl Modifiers {
    pub const NONE: Self = Self(0);
    pub const CONTROL: Self = Self(1);
    /// Option on macOS, Alt on Windows and Linux.
    pub const OPTION: Self = Self(1 << 1);
    pub const SHIFT: Self = Self(1 << 2);
    /// Command on macOS, Windows key on Windows, Super on Linux.
    pub const COMMAND: Self = Self(1 << 3);
    pub const FN: Self = Self(1 << 4);

    pub const fn from_bits(bits: u8) -> Self {
        Self(bits & 0b1_1111)
    }

    pub const fn bits(self) -> u8 {
        self.0
    }

    pub const fn is_empty(self) -> bool {
        self.0 == 0
    }

    pub const fn contains(self, other: Self) -> bool {
        self.0 & other.0 == other.0
    }

    pub const fn union(self, other: Self) -> Self {
        Self(self.0 | other.0)
    }
}

impl std::ops::BitOr for Modifiers {
    type Output = Self;

    fn bitor(self, rhs: Self) -> Self {
        self.union(rhs)
    }
}

/// Raw input, already translated from the platform event stream.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InputEvent {
    /// The complete set of modifiers now held.
    ModifiersChanged(Modifiers),
    /// Any non-modifier key went down.
    KeyDown,
    /// A mouse button went down or the wheel scrolled.
    PointerActivity,
}

/// What the user must do to trigger an action.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Binding {
    Hold { chord: Modifiers },
    MultiTap { chord: Modifiers, count: u8 },
}

/// A recognized gesture for the action it was bound to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Gesture<A> {
    HoldStarted(A),
    HoldEnded(A),
    /// The chord turned out to be part of a regular shortcut (another key or
    /// modifier joined), so the hold must be discarded rather than completed.
    HoldCancelled(A),
    Tapped(A),
}

/// Timing thresholds in milliseconds.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Timing {
    /// Longest press that still counts as a tap.
    pub tap_max_ms: u64,
    /// Longest pause between a release and the next press of a multi-tap.
    pub tap_gap_ms: u64,
}

impl Default for Timing {
    fn default() -> Self {
        Self {
            tap_max_ms: 300,
            tap_gap_ms: 300,
        }
    }
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ConfigError {
    #[error("binding {0} has no modifiers")]
    EmptyChord(usize),
    #[error("binding {0} has a tap count of zero")]
    ZeroTapCount(usize),
    #[error("binding {0} duplicates an earlier binding")]
    Duplicate(usize),
}

/// One press cycle: from the first modifier going down until all are released.
#[derive(Clone, Copy, Debug)]
struct PressCycle {
    started_ms: u64,
    /// Every modifier seen during the cycle, so `Ctrl` then `Win` taps as `Ctrl+Win`.
    union: Modifiers,
    /// A key, click or scroll happened, so this was a shortcut, not a tap.
    dirty: bool,
}

/// Consecutive clean taps of one chord that have not been resolved yet.
#[derive(Clone, Copy, Debug)]
struct TapRun {
    chord: Modifiers,
    count: u8,
    last_release_ms: u64,
}

#[derive(Clone, Copy, Debug)]
struct ActiveHold {
    binding: usize,
    cancelled: bool,
}

pub struct GestureDetector<A> {
    bindings: Vec<(A, Binding)>,
    timing: Timing,
    held: Modifiers,
    cycle: Option<PressCycle>,
    run: Option<TapRun>,
    hold: Option<ActiveHold>,
}

impl<A: Clone> GestureDetector<A> {
    /// Validates the bindings. A hold and a multi-tap may share a chord (a tap is a
    /// short hold, e.g. hold Ctrl+Win to dictate, double-tap it for hands-free).
    pub fn new(bindings: Vec<(A, Binding)>, timing: Timing) -> Result<Self, ConfigError> {
        for (i, (_, binding)) in bindings.iter().enumerate() {
            match *binding {
                Binding::Hold { chord } | Binding::MultiTap { chord, .. } if chord.is_empty() => {
                    return Err(ConfigError::EmptyChord(i));
                }
                Binding::MultiTap { count: 0, .. } => return Err(ConfigError::ZeroTapCount(i)),
                _ => {}
            }
            if bindings[..i].iter().any(|(_, earlier)| earlier == binding) {
                return Err(ConfigError::Duplicate(i));
            }
        }
        Ok(Self {
            bindings,
            timing,
            held: Modifiers::NONE,
            cycle: None,
            run: None,
            hold: None,
        })
    }

    /// Feeds one input event observed at `now_ms` (monotonic).
    pub fn handle(&mut self, event: InputEvent, now_ms: u64) -> Vec<Gesture<A>> {
        let mut out = Vec::new();
        self.expire_run(now_ms, &mut out);
        match event {
            InputEvent::ModifiersChanged(next) => self.on_modifiers(next, now_ms, &mut out),
            InputEvent::KeyDown => self.on_activity(true, &mut out),
            InputEvent::PointerActivity => self.on_activity(false, &mut out),
        }
        out
    }

    /// Call when the timer armed from [`Self::next_deadline`] fires.
    pub fn tick(&mut self, now_ms: u64) -> Vec<Gesture<A>> {
        let mut out = Vec::new();
        self.expire_run(now_ms, &mut out);
        out
    }

    /// When a pending multi-tap must be resolved. `None` while a press is in
    /// progress, because that press decides whether the run continues.
    pub fn next_deadline(&self) -> Option<u64> {
        match (self.cycle, self.run) {
            (None, Some(run)) => Some(run.last_release_ms + self.timing.tap_gap_ms),
            _ => None,
        }
    }

    fn on_modifiers(&mut self, next: Modifiers, now_ms: u64, out: &mut Vec<Gesture<A>>) {
        let prev = self.held;
        if next == prev {
            return;
        }
        self.held = next;
        match &mut self.cycle {
            Some(cycle) => cycle.union = cycle.union | next,
            None => {
                self.cycle = Some(PressCycle {
                    started_ms: now_ms,
                    union: next,
                    dirty: false,
                });
            }
        }
        self.update_hold(prev, next, out);
        if next.is_empty()
            && let Some(cycle) = self.cycle.take()
        {
            self.finish_cycle(cycle, now_ms, out);
        }
    }

    /// Ends or cancels the active hold, then starts a hold only when modifiers were
    /// added: releasing Option from Ctrl+Option must not start a Ctrl hold, but
    /// adding Option to a held Ctrl must reach a Ctrl+Option hold.
    fn update_hold(&mut self, prev: Modifiers, next: Modifiers, out: &mut Vec<Gesture<A>>) {
        if let Some(hold) = self.hold.take() {
            let (action, binding) = &self.bindings[hold.binding];
            let chord = binding_chord(*binding);
            if next == chord {
                self.hold = Some(hold);
                return;
            }
            if !hold.cancelled {
                out.push(if next.contains(chord) {
                    Gesture::HoldCancelled(action.clone())
                } else {
                    Gesture::HoldEnded(action.clone())
                });
            }
        }
        let added = next.contains(prev);
        let clean = self.cycle.is_some_and(|cycle| !cycle.dirty);
        if added
            && clean
            && let Some(index) = self.hold_binding_for(next)
        {
            self.hold = Some(ActiveHold {
                binding: index,
                cancelled: false,
            });
            out.push(Gesture::HoldStarted(self.bindings[index].0.clone()));
        }
    }

    /// A key or pointer event turns the current press into a shortcut. Keys also
    /// cancel a hold; pointer activity does not, so the user can draw while holding.
    fn on_activity(&mut self, is_key: bool, out: &mut Vec<Gesture<A>>) {
        match &mut self.cycle {
            Some(cycle) => cycle.dirty = true,
            None => self.run = None,
        }
        if is_key
            && let Some(hold) = &mut self.hold
            && !hold.cancelled
        {
            hold.cancelled = true;
            out.push(Gesture::HoldCancelled(
                self.bindings[hold.binding].0.clone(),
            ));
        }
    }

    /// Classifies a completed press. A clean, short press of a tap chord extends the
    /// run when it began within the gap; anything else abandons the run, because a
    /// false text-box open is worse than a missed one.
    fn finish_cycle(&mut self, cycle: PressCycle, now_ms: u64, out: &mut Vec<Gesture<A>>) {
        let is_tap = !cycle.dirty
            && now_ms.saturating_sub(cycle.started_ms) <= self.timing.tap_max_ms
            && self.max_tap_count(cycle.union).is_some();
        if !is_tap {
            self.run = None;
            return;
        }
        let continues = self.run.is_some_and(|run| {
            run.chord == cycle.union
                && cycle.started_ms <= run.last_release_ms + self.timing.tap_gap_ms
        });
        let count = match self.run {
            Some(run) if continues => run.count.saturating_add(1),
            _ => 1,
        };
        self.run = Some(TapRun {
            chord: cycle.union,
            count,
            last_release_ms: now_ms,
        });
        if self
            .max_tap_count(cycle.union)
            .is_some_and(|max| count >= max)
        {
            self.resolve_run(out);
        }
    }

    /// Fires the run once its gap has passed with no further press.
    fn expire_run(&mut self, now_ms: u64, out: &mut Vec<Gesture<A>>) {
        if self
            .next_deadline()
            .is_some_and(|deadline| now_ms >= deadline)
        {
            self.resolve_run(out);
        }
    }

    fn resolve_run(&mut self, out: &mut Vec<Gesture<A>>) {
        let Some(run) = self.run.take() else { return };
        let matched = self.bindings.iter().find(|(_, binding)| {
            *binding
                == Binding::MultiTap {
                    chord: run.chord,
                    count: run.count,
                }
        });
        if let Some((action, _)) = matched {
            out.push(Gesture::Tapped(action.clone()));
        }
    }

    fn hold_binding_for(&self, chord: Modifiers) -> Option<usize> {
        self.bindings
            .iter()
            .position(|(_, binding)| *binding == Binding::Hold { chord })
    }

    /// The largest tap count bound to `chord`, or `None` if it has no tap binding.
    fn max_tap_count(&self, chord: Modifiers) -> Option<u8> {
        self.bindings
            .iter()
            .filter_map(|(_, binding)| match *binding {
                Binding::MultiTap { chord: c, count } if c == chord => Some(count),
                _ => None,
            })
            .max()
    }
}

fn binding_chord(binding: Binding) -> Modifiers {
    match binding {
        Binding::Hold { chord } | Binding::MultiTap { chord, .. } => chord,
    }
}
