//! macOS input via a listen-only `CGEventTap`. Listening requires the Input
//! Monitoring permission; the tap never modifies or swallows events.

use std::cell::Cell;
use std::ffi::c_void;
use std::rc::Rc;
use std::sync::mpsc::{self, Sender};
use std::thread::JoinHandle;
use std::time::Instant;

use core_foundation::base::TCFType;
use core_foundation::mach_port::CFMachPortRef;
use core_foundation::runloop::{
    CFRunLoop, CFRunLoopTimer, CFRunLoopTimerRef, kCFRunLoopCommonModes,
};
use core_graphics::event::{
    CGEvent, CGEventFlags, CGEventTap, CGEventTapLocation, CGEventTapOptions, CGEventTapPlacement,
    CGEventType, CallbackResult,
};
use heynimbo_gestures::{InputEvent, Modifiers};

use crate::runtime::Message;

#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    fn CGEventTapEnable(tap: CFMachPortRef, enable: bool);
    fn CGPreflightListenEventAccess() -> bool;
    fn CGRequestListenEventAccess() -> bool;
}

pub(crate) struct InputSource {
    run_loop: CFRunLoop,
    thread: JoinHandle<()>,
}

impl InputSource {
    /// Stops through a run-loop timer rather than `CFRunLoopStop` directly:
    /// CoreFoundation drops a stop issued before the thread enters its run loop,
    /// while a timer waits in the mode until the loop runs.
    pub(crate) fn stop(self) {
        let timer =
            CFRunLoopTimer::new(0.0, 0.0, 0, 0, stop_current_run_loop, std::ptr::null_mut());
        // SAFETY: `kCFRunLoopCommonModes` is an immutable framework constant.
        self.run_loop
            .add_timer(&timer, unsafe { kCFRunLoopCommonModes });
        // The tap thread only exits through this stop; a panic there already
        // lost its events, so there is nothing further to recover.
        let _ = self.thread.join();
    }
}

extern "C" fn stop_current_run_loop(_timer: CFRunLoopTimerRef, _info: *mut c_void) {
    CFRunLoop::get_current().stop();
}

/// Installs the tap on a dedicated run-loop thread and forwards input to `tx`.
pub(crate) fn start(tx: Sender<Message>) -> Result<InputSource, String> {
    let (ready_tx, ready_rx) = mpsc::sync_channel(1);
    let thread = std::thread::Builder::new()
        .name("heynimbo-input-tap".into())
        .spawn(move || run_tap(tx, &ready_tx))
        .map_err(|err| format!("could not spawn the input thread: {err}"))?;
    match ready_rx.recv() {
        Ok(Ok(run_loop)) => Ok(InputSource { run_loop, thread }),
        Ok(Err(message)) => {
            let _ = thread.join();
            Err(message)
        }
        Err(_) => Err("the input thread exited before installing its tap".into()),
    }
}

fn run_tap(tx: Sender<Message>, ready: &mpsc::SyncSender<Result<CFRunLoop, String>>) {
    let port: Rc<Cell<CFMachPortRef>> = Rc::new(Cell::new(std::ptr::null_mut()));
    let callback_port = Rc::clone(&port);
    let callback = move |_proxy, event_type: CGEventType, event: &CGEvent| {
        if matches!(
            event_type,
            CGEventType::TapDisabledByTimeout | CGEventType::TapDisabledByUserInput
        ) {
            // SAFETY: the port belongs to the tap that is invoking this callback,
            // so it is alive for the duration of the call.
            unsafe { CGEventTapEnable(callback_port.get(), true) };
        } else if let Some(input) = translate(event_type, event) {
            let _ = tx.send(Message::Input(input, Instant::now()));
        }
        CallbackResult::Keep
    };
    let events = vec![
        CGEventType::FlagsChanged,
        CGEventType::KeyDown,
        CGEventType::LeftMouseDown,
        CGEventType::RightMouseDown,
        CGEventType::OtherMouseDown,
        CGEventType::ScrollWheel,
    ];
    // SAFETY: the callback captures an `Rc`, which is not `Send`. That is sound
    // because the tap is only added to this thread's run loop and is dropped at
    // the end of this function, before `port` and the callback state.
    let tap = unsafe {
        CGEventTap::new_unchecked(
            CGEventTapLocation::Session,
            CGEventTapPlacement::TailAppendEventTap,
            CGEventTapOptions::ListenOnly,
            events,
            callback,
        )
    };
    let Ok(tap) = tap else {
        let _ = ready.send(Err(
            "macOS refused the event tap; grant Input Monitoring".into()
        ));
        return;
    };
    port.set(tap.mach_port().as_concrete_TypeRef());
    let Ok(source) = tap.mach_port().create_runloop_source(0) else {
        let _ = ready.send(Err(
            "could not create a run-loop source for the event tap".into()
        ));
        return;
    };
    let run_loop = CFRunLoop::get_current();
    // SAFETY: `kCFRunLoopCommonModes` is an immutable framework constant.
    run_loop.add_source(&source, unsafe { kCFRunLoopCommonModes });
    tap.enable();
    if ready.send(Ok(run_loop)).is_ok() {
        CFRunLoop::run_current();
    }
}

fn translate(event_type: CGEventType, event: &CGEvent) -> Option<InputEvent> {
    match event_type {
        CGEventType::FlagsChanged => Some(InputEvent::ModifiersChanged(modifiers_from(
            event.get_flags(),
        ))),
        CGEventType::KeyDown => Some(InputEvent::KeyDown),
        CGEventType::LeftMouseDown
        | CGEventType::RightMouseDown
        | CGEventType::OtherMouseDown
        | CGEventType::ScrollWheel => Some(InputEvent::PointerActivity),
        _ => None,
    }
}

/// Maps device-independent flags; Caps Lock (`CGEventFlagAlphaShift`) is ignored.
fn modifiers_from(flags: CGEventFlags) -> Modifiers {
    [
        (CGEventFlags::CGEventFlagControl, Modifiers::CONTROL),
        (CGEventFlags::CGEventFlagAlternate, Modifiers::OPTION),
        (CGEventFlags::CGEventFlagShift, Modifiers::SHIFT),
        (CGEventFlags::CGEventFlagCommand, Modifiers::COMMAND),
        (CGEventFlags::CGEventFlagSecondaryFn, Modifiers::FN),
    ]
    .into_iter()
    .filter(|(flag, _)| flags.contains(*flag))
    .fold(Modifiers::NONE, |held, (_, modifier)| held | modifier)
}

/// Whether this process may listen to global input (Input Monitoring).
pub(crate) fn has_input_access() -> bool {
    // SAFETY: a side-effect-free TCC query.
    unsafe { CGPreflightListenEventAccess() }
}

/// Shows the system prompt the first time; afterwards returns the current state.
pub(crate) fn request_input_access() -> bool {
    // SAFETY: may present a system permission prompt; no memory is shared.
    unsafe { CGRequestListenEventAccess() }
}
