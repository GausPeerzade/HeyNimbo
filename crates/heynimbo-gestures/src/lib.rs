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

#[cfg(test)]
mod tests {
    use super::*;

    const CTRL: Modifiers = Modifiers::CONTROL;
    const OPT: Modifiers = Modifiers::OPTION;
    const SHIFT: Modifiers = Modifiers::SHIFT;
    const CMD: Modifiers = Modifiers::COMMAND;
    const NONE: Modifiers = Modifiers::NONE;
    const GAP: u64 = 300;

    /// The default desktop layout: push-to-talk, text box, always-on, dictation.
    fn bindings() -> Vec<(&'static str, Binding)> {
        vec![
            ("talk", Binding::Hold { chord: CTRL | OPT }),
            (
                "text",
                Binding::MultiTap {
                    chord: CTRL,
                    count: 2,
                },
            ),
            (
                "always_on",
                Binding::MultiTap {
                    chord: CTRL,
                    count: 3,
                },
            ),
            ("dictate", Binding::Hold { chord: CTRL | CMD }),
            (
                "hands_free",
                Binding::MultiTap {
                    chord: CTRL | CMD,
                    count: 2,
                },
            ),
        ]
    }

    struct Driver {
        detector: GestureDetector<&'static str>,
        out: Vec<Gesture<&'static str>>,
    }

    impl Driver {
        fn new() -> Self {
            let detector = GestureDetector::new(bindings(), Timing::default());
            Self {
                detector: detector.unwrap(),
                out: Vec::new(),
            }
        }

        fn mods(&mut self, held: Modifiers, at: u64) -> &mut Self {
            let gestures = self.detector.handle(InputEvent::ModifiersChanged(held), at);
            self.out.extend(gestures);
            self
        }

        fn key(&mut self, at: u64) -> &mut Self {
            self.out
                .extend(self.detector.handle(InputEvent::KeyDown, at));
            self
        }

        fn pointer(&mut self, at: u64) -> &mut Self {
            self.out
                .extend(self.detector.handle(InputEvent::PointerActivity, at));
            self
        }

        fn tick(&mut self, at: u64) -> &mut Self {
            self.out.extend(self.detector.tick(at));
            self
        }

        /// A quick press and release of `chord`, 50 ms long, starting at `at`.
        fn tap(&mut self, chord: Modifiers, at: u64) -> &mut Self {
            self.mods(chord, at).mods(NONE, at + 50)
        }

        fn take(&mut self) -> Vec<Gesture<&'static str>> {
            std::mem::take(&mut self.out)
        }
    }

    #[test]
    fn hold_starts_in_either_key_order_and_ends_once_on_release() {
        for first in [OPT, CTRL] {
            let mut d = Driver::new();
            d.mods(first, 0)
                .mods(CTRL | OPT, 20)
                .mods(first, 900)
                .mods(NONE, 950);
            assert_eq!(
                d.take(),
                [Gesture::HoldStarted("talk"), Gesture::HoldEnded("talk")],
                "{first:?} first"
            );
        }
    }

    #[test]
    fn growing_a_held_chord_hands_over_to_the_larger_hold() {
        let bindings = vec![
            ("small", Binding::Hold { chord: CTRL }),
            ("large", Binding::Hold { chord: CTRL | OPT }),
        ];
        let mut d = Driver {
            detector: GestureDetector::new(bindings, Timing::default()).unwrap(),
            out: Vec::new(),
        };
        d.mods(CTRL, 0).mods(CTRL | OPT, 40).mods(CTRL, 500);
        assert_eq!(
            d.take(),
            [
                Gesture::HoldStarted("small"),
                Gesture::HoldCancelled("small"),
                Gesture::HoldStarted("large"),
                Gesture::HoldEnded("large"),
            ]
        );
    }

    #[test]
    fn key_during_hold_cancels_it_and_the_release_stays_silent() {
        let mut d = Driver::new();
        d.mods(CTRL | OPT, 0).key(100).key(150).mods(NONE, 400);
        assert_eq!(
            d.take(),
            [Gesture::HoldStarted("talk"), Gesture::HoldCancelled("talk")]
        );
    }

    #[test]
    fn adding_a_modifier_turns_the_hold_into_a_cancelled_shortcut() {
        let mut d = Driver::new();
        d.mods(CTRL | OPT, 0)
            .mods(CTRL | OPT | SHIFT, 80)
            .mods(NONE, 300);
        assert_eq!(
            d.take(),
            [Gesture::HoldStarted("talk"), Gesture::HoldCancelled("talk")]
        );
    }

    #[test]
    fn pointer_activity_keeps_the_hold_so_the_user_can_draw() {
        let mut d = Driver::new();
        d.mods(CTRL | OPT, 0)
            .pointer(200)
            .pointer(400)
            .mods(NONE, 1_000);
        assert_eq!(
            d.take(),
            [Gesture::HoldStarted("talk"), Gesture::HoldEnded("talk")]
        );
    }

    #[test]
    fn releasing_into_a_hold_chord_does_not_start_that_hold() {
        let mut d = Driver::new();
        // Shift+Ctrl+Option, then Shift released: Ctrl+Option reached by removal.
        d.mods(SHIFT, 0)
            .mods(SHIFT | CTRL, 10)
            .mods(SHIFT | CTRL | OPT, 20)
            .mods(CTRL | OPT, 60);
        assert_eq!(d.take(), []);
    }

    #[test]
    fn hold_does_not_start_once_the_press_became_a_shortcut() {
        let mut d = Driver::new();
        d.mods(CTRL, 0).key(30).mods(CTRL | OPT, 60).mods(NONE, 400);
        assert_eq!(d.take(), []);
    }

    #[test]
    fn double_tap_waits_out_the_triple_tap_window_before_firing() {
        let mut d = Driver::new();
        d.tap(CTRL, 0).tap(CTRL, 150);
        assert_eq!(d.detector.next_deadline(), Some(200 + GAP));
        d.tick(200 + GAP - 1);
        assert_eq!(d.take(), []);
        d.tick(200 + GAP);
        assert_eq!(d.take(), [Gesture::Tapped("text")]);
    }

    #[test]
    fn triple_tap_fires_immediately_without_a_double() {
        let mut d = Driver::new();
        d.tap(CTRL, 0).tap(CTRL, 150).tap(CTRL, 300);
        assert_eq!(d.take(), [Gesture::Tapped("always_on")]);
        assert_eq!(d.detector.next_deadline(), None);
    }

    #[test]
    fn control_shortcuts_scrolls_and_typing_between_taps_never_count() {
        for interrupt in [0, 1, 2] {
            let mut d = Driver::new();
            d.tap(CTRL, 0);
            match interrupt {
                0 => d.mods(CTRL, 120).key(140).mods(NONE, 160), // Ctrl+C
                1 => d.mods(CTRL, 120).pointer(140).mods(NONE, 160), // Ctrl+scroll
                _ => d.key(120),                                 // typing between two taps
            };
            d.tap(CTRL, 200).tick(10_000);
            assert_eq!(d.take(), [], "interrupt case {interrupt}");
        }
    }

    #[test]
    fn slow_press_or_long_pause_breaks_the_run() {
        let mut d = Driver::new();
        d.tap(CTRL, 0)
            .mods(CTRL, 100)
            .mods(NONE, 100 + 301)
            .tap(CTRL, 450)
            .tick(10_000);
        d.tap(CTRL, 20_000).tap(CTRL, 20_050 + GAP + 1).tick(30_000);
        assert_eq!(d.take(), []);
    }

    #[test]
    fn a_press_started_inside_the_gap_continues_the_run_after_the_deadline() {
        let mut d = Driver::new();
        d.tap(CTRL, 0).mods(CTRL, 50 + GAP - 5);
        assert_eq!(
            d.detector.next_deadline(),
            None,
            "no deadline while pressed"
        );
        d.mods(NONE, 50 + GAP + 60).tick(10_000);
        assert_eq!(d.take(), [Gesture::Tapped("text")]);
    }

    #[test]
    fn hold_and_double_tap_can_share_a_two_modifier_chord() {
        let mut d = Driver::new();
        for start in [0, 150] {
            d.mods(CTRL, start)
                .mods(CTRL | CMD, start + 10)
                .mods(CTRL, start + 40)
                .mods(NONE, start + 50);
        }
        let dictate_tap = [
            Gesture::HoldStarted("dictate"),
            Gesture::HoldEnded("dictate"),
        ];
        let expected: Vec<_> = dictate_tap
            .iter()
            .chain(&dictate_tap)
            .cloned()
            .chain([Gesture::Tapped("hands_free")])
            .collect();
        assert_eq!(d.take(), expected);
    }

    #[test]
    fn invalid_bindings_are_rejected_with_their_index() {
        let cases = [
            (
                vec![("a", Binding::Hold { chord: NONE })],
                ConfigError::EmptyChord(0),
            ),
            (
                vec![
                    ("a", Binding::Hold { chord: CTRL }),
                    (
                        "b",
                        Binding::MultiTap {
                            chord: CTRL,
                            count: 0,
                        },
                    ),
                ],
                ConfigError::ZeroTapCount(1),
            ),
            (
                vec![
                    ("a", Binding::Hold { chord: CTRL }),
                    ("b", Binding::Hold { chord: CTRL }),
                ],
                ConfigError::Duplicate(1),
            ),
        ];
        for (bindings, expected) in cases {
            let result = GestureDetector::new(bindings, Timing::default());
            assert_eq!(result.err(), Some(expected));
        }
    }
}
