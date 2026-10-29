//! Per-OS input sources. Each exposes `start(tx) -> InputSource`,
//! `InputSource::stop`, `has_input_access` and `request_input_access`.

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
pub(crate) use macos::*;

#[cfg(not(target_os = "macos"))]
mod unsupported {
    use std::sync::mpsc::Sender;

    use crate::runtime::Message;

    pub(crate) struct InputSource;

    impl InputSource {
        pub(crate) fn stop(self) {}
    }

    pub(crate) fn start(_tx: Sender<Message>) -> Result<InputSource, String> {
        Err("global gestures are not implemented on this platform yet".into())
    }

    // No permission gate exists here; `start` reports the missing support instead.
    pub(crate) fn has_input_access() -> bool {
        true
    }

    pub(crate) fn request_input_access() -> bool {
        true
    }
}
#[cfg(not(target_os = "macos"))]
pub(crate) use unsupported::*;
