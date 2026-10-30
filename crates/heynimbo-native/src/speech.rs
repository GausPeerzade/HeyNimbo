//! Speech consumes the existing capture stream: signed little-endian PCM16,
//! 24 kHz, mono. It never opens an audio input device.

use napi::bindgen_prelude::*;
use napi_derive::napi;

#[cfg(target_os = "macos")]
#[path = "speech/macos.rs"]
mod platform;

#[napi(object)]
pub struct SpeechAvailability {
    pub available: bool,
    pub authorization: String,
    pub reason: Option<String>,
}

fn unavailable(reason: &str) -> SpeechAvailability {
    SpeechAvailability {
        available: false,
        authorization: "unavailable".into(),
        reason: Some(reason.into()),
    }
}

/// The guard must run before even querying authorization status, not just before
/// requesting permission: development Electron bundles may lack usage strings.
#[cfg(any(target_os = "macos", test))]
fn with_usage_strings<T>(
    speech: bool,
    microphone: bool,
    authorized: impl FnOnce() -> T,
) -> Option<T> {
    (speech && microphone).then(authorized)
}

#[cfg(any(target_os = "macos", test))]
fn guarded_availability(
    speech: bool,
    microphone: bool,
    inspect: impl FnOnce() -> SpeechAvailability,
) -> SpeechAvailability {
    with_usage_strings(speech, microphone, inspect).unwrap_or_else(|| unavailable("This app is missing speech or microphone usage descriptions. For development, run pnpm dev:speech-permissions and restart Electron."))
}

/// Checks bundle metadata only, without contacting any protected-resource API.
#[napi]
pub fn has_voice_usage_descriptions() -> bool {
    #[cfg(target_os = "macos")]
    {
        platform::has_usage_strings()
    }
    #[cfg(not(target_os = "macos"))]
    {
        true
    }
}

#[napi]
pub fn speech_availability(locale: Option<String>) -> SpeechAvailability {
    #[cfg(target_os = "macos")]
    {
        platform::availability(locale.as_deref())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = locale;
        unavailable("Built-in listening requires macOS.")
    }
}

pub struct SpeechAuthorizationTask {
    receiver: std::sync::mpsc::Receiver<String>,
}

impl Task for SpeechAuthorizationTask {
    type Output = String;
    type JsValue = String;
    fn compute(&mut self) -> Result<String> {
        self.receiver
            .recv_timeout(std::time::Duration::from_secs(120))
            .map_err(|_| Error::from_reason("Speech permission request timed out."))
    }
    fn resolve(&mut self, _env: Env, output: String) -> Result<String> {
        Ok(output)
    }
}

/// Call only from an explicit user action. Missing usage strings never reach TCC.
#[napi(ts_return_type = "Promise<string>")]
pub fn request_speech_authorization() -> AsyncTask<SpeechAuthorizationTask> {
    let (sender, receiver) = std::sync::mpsc::channel();
    #[cfg(target_os = "macos")]
    platform::request_authorization(sender);
    #[cfg(not(target_os = "macos"))]
    let _ = sender.send("unavailable".into());
    AsyncTask::new(SpeechAuthorizationTask { receiver })
}

#[napi]
pub fn speech_language(text: String) -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        platform::language(&text)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = text;
        None
    }
}

#[cfg(not(target_os = "macos"))]
#[napi]
pub struct SpeechSession;
#[cfg(not(target_os = "macos"))]
#[napi]
impl SpeechSession {
    #[napi(constructor)]
    pub fn new(_locale: Option<String>) -> Result<Self> {
        Err(Error::from_reason("Built-in listening requires macOS."))
    }
    #[napi]
    pub fn append(&self, _pcm: Buffer) {}
    #[napi]
    pub fn cancel(&self) {}
    #[napi(ts_return_type = "Promise<string>")]
    pub fn finish(&self) -> Result<AsyncTask<SpeechAuthorizationTask>> {
        Err(Error::from_reason("Built-in listening requires macOS."))
    }
}

#[cfg(any(target_os = "macos", test))]
#[derive(Default)]
struct Pcm16 {
    trailing: Option<u8>,
}
#[cfg(any(target_os = "macos", test))]
impl Pcm16 {
    fn convert(&mut self, bytes: &[u8]) -> Vec<f32> {
        let mut input = bytes.iter().copied();
        let mut samples = Vec::with_capacity(bytes.len().div_ceil(2));
        if let Some(low) = self.trailing.take() {
            if let Some(high) = input.next() {
                samples.push(f32::from(i16::from_le_bytes([low, high])) / 32768.0);
            } else {
                self.trailing = Some(low);
            }
        }
        while let Some(low) = input.next() {
            if let Some(high) = input.next() {
                samples.push(f32::from(i16::from_le_bytes([low, high])) / 32768.0);
            } else {
                self.trailing = Some(low);
            }
        }
        samples
    }
}
