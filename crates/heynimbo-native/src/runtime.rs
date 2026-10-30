//! Runs the gesture detector on its own thread. Platform hooks only forward
//! input, so slow JavaScript callbacks can never stall the OS event tap.

use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::time::{Duration, Instant};

use heynimbo_gestures::{Gesture, GestureDetector, InputEvent};

pub(crate) enum Message {
    Input(InputEvent, Instant),
    Stop,
}

/// Feeds `rx` into `detector` until [`Message::Stop`] or every sender is dropped,
/// firing multi-tap deadlines with `recv_timeout`.
pub(crate) fn run_detector<A: Clone>(
    mut detector: GestureDetector<A>,
    rx: &Receiver<Message>,
    mut emit: impl FnMut(Gesture<A>),
) {
    let epoch = Instant::now();
    let ms_since = |at: Instant| {
        u64::try_from(at.saturating_duration_since(epoch).as_millis()).unwrap_or(u64::MAX)
    };
    loop {
        let message = match detector.next_deadline() {
            Some(deadline) => {
                let wait = Duration::from_millis(deadline.saturating_sub(ms_since(Instant::now())));
                match rx.recv_timeout(wait) {
                    Ok(message) => Some(message),
                    Err(RecvTimeoutError::Timeout) => None,
                    Err(RecvTimeoutError::Disconnected) => return,
                }
            }
            None => match rx.recv() {
                Ok(message) => Some(message),
                Err(_) => return,
            },
        };
        let gestures = match message {
            Some(Message::Input(event, at)) => detector.handle(event, ms_since(at)),
            Some(Message::Stop) => return,
            None => detector.tick(ms_since(Instant::now())),
        };
        gestures.into_iter().for_each(&mut emit);
    }
}
