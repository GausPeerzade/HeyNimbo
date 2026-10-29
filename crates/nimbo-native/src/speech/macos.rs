use super::{Pcm16, SpeechAvailability, guarded_availability, unavailable, with_usage_strings};
use block2::RcBlock;
use napi::bindgen_prelude::*;
use napi_derive::napi;
use objc2::{
    AllocAnyThread,
    rc::{Retained, autoreleasepool},
};
use objc2_avf_audio::{AVAudioFormat, AVAudioPCMBuffer};
use objc2_foundation::{NSBundle, NSError, NSLocale, NSString};
use objc2_natural_language::NLLanguageRecognizer;
use objc2_speech::{
    SFSpeechAudioBufferRecognitionRequest, SFSpeechRecognitionResult, SFSpeechRecognitionTask,
    SFSpeechRecognizer, SFSpeechRecognizerAuthorizationStatus as Authorization,
};
use std::sync::{Arc, Condvar, Mutex, mpsc};
use std::time::Duration;

fn usage_strings() -> (bool, bool) {
    let bundle = NSBundle::mainBundle();
    let present = |key| {
        bundle
            .objectForInfoDictionaryKey(&NSString::from_str(key))
            .and_then(|value| value.downcast::<NSString>().ok())
            .is_some_and(|value| !value.to_string().trim().is_empty())
    };
    (
        present("NSSpeechRecognitionUsageDescription"),
        present("NSMicrophoneUsageDescription"),
    )
}

pub(super) fn has_usage_strings() -> bool {
    let (speech, microphone) = usage_strings();
    with_usage_strings(speech, microphone, || ()).is_some()
}

fn authorization_name(status: Authorization) -> String {
    match status {
        Authorization::Authorized => "authorized",
        Authorization::NotDetermined => "notDetermined",
        Authorization::Denied => "denied",
        Authorization::Restricted => "restricted",
        _ => "unavailable",
    }
    .into()
}

fn recognizer(locale: Option<&str>) -> Option<Retained<SFSpeechRecognizer>> {
    // Locale defaults to the user's Mac language, not a separate voice setting.
    unsafe {
        let locale = locale
            .map(|s| NSLocale::initWithLocaleIdentifier(NSLocale::alloc(), &NSString::from_str(s)))
            .unwrap_or_else(NSLocale::currentLocale);
        SFSpeechRecognizer::initWithLocale(SFSpeechRecognizer::alloc(), &locale)
    }
}

pub(super) fn availability(locale: Option<&str>) -> SpeechAvailability {
    autoreleasepool(|_| {
        let (speech, microphone) = usage_strings();
        guarded_availability(speech, microphone, || {
            // No authorization API above this point.
            let status = unsafe { SFSpeechRecognizer::authorizationStatus() };
            let Some(recognizer) = recognizer(locale) else {
                return unavailable(
                    "This Mac does not support speech recognition for your language.",
                );
            };
            if !unsafe { recognizer.supportsOnDeviceRecognition() } {
                return unavailable(
                    "Mac speech for your language isn't downloaded yet. Turn on Dictation in System Settings → Keyboard to download it.",
                );
            }
            let reason = match status {
            Authorization::Denied => Some("Speech recognition was denied. Allow it in System Settings → Privacy & Security → Speech Recognition.".into()),
            Authorization::Restricted => Some("Speech recognition is restricted on this Mac.".into()),
            Authorization::NotDetermined => Some("Allow speech recognition in Settings → Connection.".into()),
            _ if !unsafe { recognizer.isAvailable() } => Some("On-device speech recognition is temporarily unavailable.".into()),
            _ => None,
        };
            SpeechAvailability {
                available: reason.is_none(),
                authorization: authorization_name(status),
                reason,
            }
        })
    })
}

pub(super) fn request_authorization(sender: mpsc::Sender<String>) {
    autoreleasepool(|_| {
        if !has_usage_strings() {
            let _ = sender.send("unavailable".into());
            return;
        }
        let block = RcBlock::new(move |status: Authorization| {
            let _ = sender.send(authorization_name(status));
        });
        unsafe {
            SFSpeechRecognizer::requestAuthorization(&block);
        }
    });
}

pub(super) fn language(text: &str) -> Option<String> {
    autoreleasepool(|_| unsafe {
        NLLanguageRecognizer::dominantLanguageForString(&NSString::from_str(text))
            .map(|s| s.to_string())
    })
}

#[derive(Default)]
struct Transcript {
    text: String,
    done: bool,
    error: Option<String>,
}
type SharedTranscript = Arc<(Mutex<Transcript>, Condvar)>;

pub struct SpeechFinishTask {
    state: SharedTranscript,
}
impl Task for SpeechFinishTask {
    type Output = String;
    type JsValue = String;
    fn compute(&mut self) -> Result<String> {
        let (lock, ready) = &*self.state;
        let state = lock
            .lock()
            .map_err(|_| Error::from_reason("Speech session lock failed."))?;
        let (mut state, timeout) = ready
            .wait_timeout_while(state, Duration::from_secs(15), |s| !s.done)
            .map_err(|_| Error::from_reason("Speech session lock failed."))?;
        if timeout.timed_out() && !state.done {
            return Err(Error::from_reason("On-device transcription timed out."));
        }
        if let Some(error) = state.error.take() {
            return Err(Error::from_reason(error));
        }
        Ok(state.text.trim().into())
    }
    fn resolve(&mut self, _env: Env, output: String) -> Result<String> {
        Ok(output)
    }
}

#[napi]
pub struct SpeechSession {
    _recognizer: Retained<SFSpeechRecognizer>,
    request: Retained<SFSpeechAudioBufferRecognitionRequest>,
    task: Retained<SFSpeechRecognitionTask>,
    state: SharedTranscript,
    pcm: Pcm16,
    ended: bool,
}

#[napi]
impl SpeechSession {
    #[napi(constructor)]
    pub fn new(locale: Option<String>) -> Result<Self> {
        autoreleasepool(|_| {
            let availability = availability(locale.as_deref());
            if !availability.available {
                return Err(Error::from_reason(
                    availability
                        .reason
                        .unwrap_or_else(|| "Speech recognition unavailable.".into()),
                ));
            }
            let recognizer = recognizer(locale.as_deref())
                .ok_or_else(|| Error::from_reason("Speech language unavailable."))?;
            let state = Arc::new((Mutex::new(Transcript::default()), Condvar::new()));
            let result_state = state.clone();
            let callback = RcBlock::new(
                move |result: *mut SFSpeechRecognitionResult, error: *mut NSError| {
                    let (lock, ready) = &*result_state;
                    let Ok(mut state) = lock.lock() else {
                        return;
                    };
                    if state.done {
                        return;
                    }
                    unsafe {
                        if let Some(result) = result.as_ref() {
                            state.text = result.bestTranscription().formattedString().to_string();
                            state.done = result.isFinal();
                        }
                        if !error.is_null() && !state.done {
                            // No-speech is an empty transcript, not an infrastructure failure.
                            let error = &*error;
                            if !(error.domain().to_string() == "kAFAssistantErrorDomain"
                                && error.code() == 1110)
                            {
                                state.error = Some("On-device speech recognition failed. Check language availability and permissions.".into());
                            }
                            state.done = true;
                        }
                    }
                    if state.done {
                        ready.notify_all();
                    }
                },
            );
            unsafe {
                let request = SFSpeechAudioBufferRecognitionRequest::new();
                request.setRequiresOnDeviceRecognition(true);
                request.setShouldReportPartialResults(true);
                let task = recognizer.recognitionTaskWithRequest_resultHandler(&request, &callback);
                Ok(Self {
                    _recognizer: recognizer,
                    request,
                    task,
                    state,
                    pcm: Pcm16::default(),
                    ended: false,
                })
            }
        })
    }

    #[napi]
    pub fn append(&mut self, pcm: Buffer) -> Result<()> {
        if self.ended {
            return Err(Error::from_reason("Speech input is already finished."));
        }
        let samples = self.pcm.convert(&pcm);
        if samples.is_empty() {
            return Ok(());
        }
        autoreleasepool(|_| {
            let buffer = audio_buffer(&samples).map_err(Error::from_reason)?;
            unsafe {
                self.request.appendAudioPCMBuffer(&buffer);
            }
            Ok(())
        })
    }

    #[napi(ts_return_type = "Promise<string>")]
    pub fn finish(&mut self) -> Result<AsyncTask<SpeechFinishTask>> {
        if self.ended {
            return Err(Error::from_reason("Speech input is already finished."));
        }
        if self.pcm.trailing.is_some() {
            self.cancel();
            return Err(Error::from_reason("Incomplete PCM16 sample."));
        }
        self.ended = true;
        unsafe {
            self.request.endAudio();
        }
        Ok(AsyncTask::new(SpeechFinishTask {
            state: self.state.clone(),
        }))
    }

    #[napi]
    pub fn cancel(&mut self) {
        self.ended = true;
        let (lock, ready) = &*self.state;
        if let Ok(mut state) = lock.lock() {
            state.text.clear();
            state.error = None;
            state.done = true;
            ready.notify_all();
        }
        unsafe {
            self.task.cancel();
        }
    }
}
impl Drop for SpeechSession {
    fn drop(&mut self) {
        self.cancel();
    }
}

fn audio_buffer(samples: &[f32]) -> std::result::Result<Retained<AVAudioPCMBuffer>, String> {
    unsafe {
        let format = AVAudioFormat::initStandardFormatWithSampleRate_channels(
            AVAudioFormat::alloc(),
            24_000.0,
            1,
        )
        .ok_or_else(|| "Could not create the capture audio format.".to_string())?;
        let frames =
            u32::try_from(samples.len()).map_err(|_| "Speech chunk too large.".to_string())?;
        let buffer = AVAudioPCMBuffer::initWithPCMFormat_frameCapacity(
            AVAudioPCMBuffer::alloc(),
            &format,
            frames,
        )
        .ok_or_else(|| "Could not allocate speech audio.".to_string())?;
        buffer.setFrameLength(frames);
        let channels = buffer.floatChannelData();
        if channels.is_null() {
            return Err("Speech audio has no float channel.".into());
        }
        std::ptr::copy_nonoverlapping(samples.as_ptr(), (*channels).as_ptr(), samples.len());
        Ok(buffer)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn capture_buffer_has_mono_24khz_float_samples_and_exact_frames() {
        autoreleasepool(|_| {
            let samples = Pcm16::default().convert(&[0, 128, 0, 64, 255, 127]);
            let buffer = audio_buffer(&samples).unwrap_or_else(|e| panic!("{e}"));
            unsafe {
                assert_eq!(buffer.format().sampleRate(), 24_000.0);
                assert_eq!(buffer.format().channelCount(), 1);
                assert!(!buffer.format().isInterleaved());
                assert_eq!(buffer.frameLength(), 3);
                assert_eq!(
                    std::slice::from_raw_parts((*buffer.floatChannelData()).as_ptr(), 3),
                    samples
                );
            }
        });
    }
}
