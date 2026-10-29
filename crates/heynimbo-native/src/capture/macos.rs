//! Capture through ScreenCaptureKit (macOS 14+). This process's windows are
//! excluded by the filter itself, since content protection alone does not hide
//! them from ScreenCaptureKit.

use core_graphics::event::CGEvent;
use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
use screencapturekit::screenshot_manager::{CGImageExt, SCScreenshotManager};
use screencapturekit::shareable_content::{SCDisplay, SCRunningApplication, SCShareableContent};
use screencapturekit::stream::configuration::SCStreamConfiguration;
use screencapturekit::stream::content_filter::SCContentFilter;

use super::{Frame, RawCapture, Request, fit_within};

#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGRequestScreenCaptureAccess() -> bool;
}

/// Captures the display under the cursor, or every display with it first.
pub(crate) fn capture(request: &Request) -> Result<Vec<RawCapture>, String> {
    let content =
        SCShareableContent::get().map_err(|err| format!("could not list screens: {err}"))?;
    let me = i32::try_from(std::process::id()).unwrap_or(i32::MAX);
    let own: Vec<SCRunningApplication> = content
        .applications()
        .into_iter()
        .filter(|app| app.process_id() == me)
        .collect();
    let own: Vec<&SCRunningApplication> = own.iter().collect();
    let cursor = cursor_location();
    let mut displays: Vec<(SCDisplay, Frame)> = content
        .displays()
        .into_iter()
        .map(|display| {
            let frame = frame_of(&display);
            (display, frame)
        })
        .collect();
    displays.sort_by_key(|(_, frame)| !cursor.is_some_and(|point| frame.contains(point)));
    if !request.all_displays {
        displays.truncate(1);
    }
    displays
        .iter()
        .map(|(display, frame)| {
            capture_display(display, *frame, &own, cursor, request.max_long_edge)
        })
        .collect()
}

fn capture_display(
    display: &SCDisplay,
    frame: Frame,
    own: &[&SCRunningApplication],
    cursor: Option<(f64, f64)>,
    max_long_edge: u32,
) -> Result<RawCapture, String> {
    let (width, height) = fit_within(frame.width, frame.height, max_long_edge);
    let filter = SCContentFilter::create()
        .with_display(display)
        .with_excluding_applications(own, &[])
        .build()
        .map_err(|err| format!("could not build the capture filter: {err}"))?;
    let config = SCStreamConfiguration::new()
        .with_width(width)
        .with_height(height)
        .with_shows_cursor(true);
    let image = SCScreenshotManager::capture_image(&filter, &config)
        .map_err(|err| format!("capture failed: {err}"))?;
    let bgra = image
        .bgra_data()
        .map_err(|err| format!("could not read captured pixels: {err}"))?;
    let size =
        |value: usize| u32::try_from(value).map_err(|_| "captured image is too large".to_string());
    Ok(RawCapture {
        display_id: display.display_id(),
        frame,
        width: size(image.width())?,
        height: size(image.height())?,
        bgra,
        cursor: cursor.filter(|&point| frame.contains(point)),
    })
}

fn frame_of(display: &SCDisplay) -> Frame {
    let rect = display.frame();
    Frame {
        x: rect.origin.x,
        y: rect.origin.y,
        width: rect.size.width,
        height: rect.size.height,
    }
}

/// The cursor in global points, top-left origin (the same space as display frames).
fn cursor_location() -> Option<(f64, f64)> {
    let source = CGEventSource::new(CGEventSourceStateID::CombinedSessionState).ok()?;
    let point = CGEvent::new(source).ok()?.location();
    Some((point.x, point.y))
}

/// Whether this process may record the screen (Screen Recording permission).
pub(crate) fn has_access() -> bool {
    // SAFETY: a side-effect-free TCC query.
    unsafe { CGPreflightScreenCaptureAccess() }
}

/// Shows the system prompt the first time; afterwards returns the current state.
pub(crate) fn request_access() -> bool {
    // SAFETY: may present a system permission prompt; no memory is shared.
    unsafe { CGRequestScreenCaptureAccess() }
}
