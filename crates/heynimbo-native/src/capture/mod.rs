//! Screen capture shared by the platform backends: geometry and in-memory JPEG
//! encoding. Frames never touch the disk.

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
pub(crate) use macos::{capture, has_access, request_access};

#[cfg(not(target_os = "macos"))]
mod unsupported {
    use super::{RawCapture, Request};

    pub(crate) fn capture(_request: &Request) -> Result<Vec<RawCapture>, String> {
        Err("screen capture is not implemented on this platform yet".into())
    }

    pub(crate) fn has_access() -> bool {
        true
    }

    pub(crate) fn request_access() -> bool {
        true
    }
}
#[cfg(not(target_os = "macos"))]
pub(crate) use unsupported::{capture, has_access, request_access};

/// A rectangle in global screen points, top-left origin.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Frame {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Frame {
    /// Half-open: the right and bottom edges belong to the neighbouring display.
    pub(crate) fn contains(&self, point: (f64, f64)) -> bool {
        (self.x..self.x + self.width).contains(&point.0)
            && (self.y..self.y + self.height).contains(&point.1)
    }
}

#[cfg_attr(
    not(target_os = "macos"),
    expect(dead_code, reason = "only the macOS backend captures so far")
)]
pub(crate) struct Request {
    pub max_long_edge: u32,
    pub all_displays: bool,
}

/// One display's pixels, tightly packed BGRA, plus where it sits on screen.
pub(crate) struct RawCapture {
    pub display_id: u32,
    pub frame: Frame,
    pub width: u32,
    pub height: u32,
    pub bgra: Vec<u8>,
    /// Cursor in global points, if it is on this display.
    pub cursor: Option<(f64, f64)>,
}

#[cfg_attr(
    not(any(target_os = "macos", test)),
    expect(dead_code, reason = "only the macOS backend captures so far")
)]
/// Largest size with the frame's aspect ratio whose long edge is at most
/// `max_long_edge`. Never upscales and never returns a zero dimension.
pub(crate) fn fit_within(width: f64, height: f64, max_long_edge: u32) -> (u32, u32) {
    let long_edge = width.max(height);
    let scale = (f64::from(max_long_edge) / long_edge).min(1.0);
    let px = |value: f64| (value * scale).round().clamp(1.0, f64::from(u32::MAX)) as u32;
    (px(width), px(height))
}

/// Maps a global point onto image pixels, or `None` when it lies outside `frame`.
pub(crate) fn to_image_point(
    global: (f64, f64),
    frame: &Frame,
    image: (u32, u32),
) -> Option<(f64, f64)> {
    frame.contains(global).then(|| {
        (
            (global.0 - frame.x) * f64::from(image.0) / frame.width,
            (global.1 - frame.y) * f64::from(image.1) / frame.height,
        )
    })
}

pub(crate) fn encode_jpeg(
    bgra: &[u8],
    width: u32,
    height: u32,
    quality: u8,
) -> Result<Vec<u8>, String> {
    let too_large = || format!("{width}x{height} is too large to encode as JPEG");
    let (w, h) = (
        u16::try_from(width).map_err(|_| too_large())?,
        u16::try_from(height).map_err(|_| too_large())?,
    );
    let mut jpeg = Vec::new();
    jpeg_encoder::Encoder::new(&mut jpeg, quality)
        .encode(bgra, w, h, jpeg_encoder::ColorType::Bgra)
        .map_err(|err| format!("JPEG encoding failed: {err}"))?;
    Ok(jpeg)
}
