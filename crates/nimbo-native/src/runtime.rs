//! Runs the gesture detector on its own thread. Platform hooks only forward
//! input, so slow JavaScript callbacks can never stall the OS event tap.

use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::time::{Duration, Instant};

use nimbo_gestures::{Gesture, GestureDetector, InputEvent};

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

#[cfg(test)]
mod tests {
    use super::*;
    use nimbo_gestures::{Binding, Modifiers, Timing};
    use std::sync::mpsc;

    #[test]
    fn pending_double_tap_fires_from_the_deadline_alone_and_stop_ends_the_thread() {
        let bindings = vec![
            (
                "text",
                Binding::MultiTap {
                    chord: Modifiers::CONTROL,
                    count: 2,
                },
            ),
            (
                "always_on",
                Binding::MultiTap {
                    chord: Modifiers::CONTROL,
                    count: 3,
                },
            ),
        ];
        let timing = Timing {
            tap_max_ms: 200,
            tap_gap_ms: 40,
        };
        let detector = GestureDetector::new(bindings, timing).unwrap();
        let (input_tx, input_rx) = mpsc::channel();
        let (out_tx, out_rx) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            run_detector(detector, &input_rx, |g| out_tx.send(g).unwrap())
        });

        for held in [
            Modifiers::CONTROL,
            Modifiers::NONE,
            Modifiers::CONTROL,
            Modifiers::NONE,
        ] {
            input_tx
                .send(Message::Input(
                    InputEvent::ModifiersChanged(held),
                    Instant::now(),
                ))
                .unwrap();
        }
        let fired = out_rx.recv_timeout(Duration::from_secs(2));
        input_tx.send(Message::Stop).unwrap();
        worker.join().unwrap();

        assert_eq!(fired, Ok(Gesture::Tapped("text")));
    }
}
