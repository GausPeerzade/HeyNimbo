//! Native OS capabilities for NimboGuide's desktop shell, exposed through N-API.

mod platform;
mod runtime;

use std::sync::mpsc;
use std::thread::JoinHandle;

use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;
use nimbo_gestures::{Binding, Gesture, GestureDetector, Modifiers, Timing};

#[napi(string_enum)]
pub enum ModifierKey {
    Control,
    /// Option on macOS, Alt on Windows.
    Option,
    Shift,
    /// Command on macOS, Windows key on Windows.
    Command,
    Fn,
}

#[napi(string_enum)]
pub enum GestureKind {
    HoldStarted,
    HoldEnded,
    HoldCancelled,
    Tapped,
}

#[napi(object)]
pub struct GestureBinding {
    pub action: String,
    pub chord: Vec<ModifierKey>,
    /// Omit for a hold; set for a multi-tap (2 is a double tap).
    pub taps: Option<u32>,
}

#[napi(object)]
pub struct GestureTiming {
    pub tap_max_ms: Option<u32>,
    pub tap_gap_ms: Option<u32>,
}

#[napi(object)]
pub struct GestureEvent {
    pub kind: GestureKind,
    pub action: String,
}

struct Running {
    input: platform::InputSource,
    detector_tx: mpsc::Sender<runtime::Message>,
    detector: JoinHandle<()>,
}

/// Listens for global modifier gestures and reports them to a JS callback.
#[napi]
#[derive(Default)]
pub struct GestureMonitor {
    running: Option<Running>,
}

#[napi]
impl GestureMonitor {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self::default()
    }

    /// Starts listening, replacing any previous configuration.
    #[napi]
    pub fn start(
        &mut self,
        bindings: Vec<GestureBinding>,
        timing: Option<GestureTiming>,
        on_gesture: ThreadsafeFunction<GestureEvent, (), GestureEvent, Status, false>,
    ) -> Result<()> {
        self.stop();
        let detector = GestureDetector::new(to_bindings(bindings)?, to_timing(timing))
            .map_err(|err| Error::new(Status::InvalidArg, err.to_string()))?;
        let (detector_tx, detector_rx) = mpsc::channel();
        let detector = std::thread::Builder::new()
            .name("nimbo-gestures".into())
            .spawn(move || {
                runtime::run_detector(detector, &detector_rx, |gesture| {
                    on_gesture.call(to_event(gesture), ThreadsafeFunctionCallMode::NonBlocking);
                });
            })
            .map_err(|err| {
                Error::from_reason(format!("could not spawn the gesture thread: {err}"))
            })?;
        match platform::start(detector_tx.clone()) {
            Ok(input) => {
                self.running = Some(Running {
                    input,
                    detector_tx,
                    detector,
                });
                Ok(())
            }
            Err(reason) => {
                let _ = detector_tx.send(runtime::Message::Stop);
                let _ = detector.join();
                Err(Error::from_reason(reason))
            }
        }
    }

    /// Stops listening. Safe to call when not running.
    #[napi]
    pub fn stop(&mut self) {
        if let Some(running) = self.running.take() {
            running.input.stop();
            let _ = running.detector_tx.send(runtime::Message::Stop);
            let _ = running.detector.join();
        }
    }
}

impl Drop for GestureMonitor {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Whether global input may be observed (macOS Input Monitoring).
#[napi]
pub fn has_input_monitoring_access() -> bool {
    platform::has_input_access()
}

/// Prompts for Input Monitoring once; returns whether access is granted.
#[napi]
pub fn request_input_monitoring_access() -> bool {
    platform::request_input_access()
}

fn to_bindings(specs: Vec<GestureBinding>) -> Result<Vec<(String, Binding)>> {
    specs
        .into_iter()
        .map(|spec| {
            let chord = spec
                .chord
                .iter()
                .fold(Modifiers::NONE, |chord, key| chord | to_modifier(key));
            let binding = match spec.taps {
                None => Binding::Hold { chord },
                Some(taps) => Binding::MultiTap {
                    chord,
                    count: u8::try_from(taps).map_err(|_| {
                        Error::new(
                            Status::InvalidArg,
                            format!("{}: too many taps", spec.action),
                        )
                    })?,
                },
            };
            Ok((spec.action, binding))
        })
        .collect()
}

fn to_modifier(key: &ModifierKey) -> Modifiers {
    match key {
        ModifierKey::Control => Modifiers::CONTROL,
        ModifierKey::Option => Modifiers::OPTION,
        ModifierKey::Shift => Modifiers::SHIFT,
        ModifierKey::Command => Modifiers::COMMAND,
        ModifierKey::Fn => Modifiers::FN,
    }
}

fn to_timing(timing: Option<GestureTiming>) -> Timing {
    let defaults = Timing::default();
    let Some(timing) = timing else {
        return defaults;
    };
    Timing {
        tap_max_ms: timing.tap_max_ms.map_or(defaults.tap_max_ms, u64::from),
        tap_gap_ms: timing.tap_gap_ms.map_or(defaults.tap_gap_ms, u64::from),
    }
}

fn to_event(gesture: Gesture<String>) -> GestureEvent {
    let (kind, action) = match gesture {
        Gesture::HoldStarted(action) => (GestureKind::HoldStarted, action),
        Gesture::HoldEnded(action) => (GestureKind::HoldEnded, action),
        Gesture::HoldCancelled(action) => (GestureKind::HoldCancelled, action),
        Gesture::Tapped(action) => (GestureKind::Tapped, action),
    };
    GestureEvent { kind, action }
}
