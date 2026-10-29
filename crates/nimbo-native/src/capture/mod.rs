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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fit_within_downscales_by_the_long_edge_and_never_upscales() {
        assert_eq!(fit_within(2560.0, 1080.0, 1280), (1280, 540));
        assert_eq!(fit_within(900.0, 1440.0, 1280), (800, 1280));
        assert_eq!(fit_within(1024.0, 768.0, 1280), (1024, 768));
        assert_eq!(fit_within(10_000.0, 1.0, 1280), (1280, 1));
    }

    #[test]
    fn image_points_scale_from_global_points_including_negative_origins() {
        // A secondary display left of and above the primary.
        let frame = Frame {
            x: -1440.0,
            y: -900.0,
            width: 1440.0,
            height: 900.0,
        };
        let image = fit_within(frame.width, frame.height, 720);
        assert_eq!(
            to_image_point((-720.0, -450.0), &frame, image),
            Some((360.0, 225.0))
        );
        assert_eq!(
            to_image_point((-1440.0, -900.0), &frame, image),
            Some((0.0, 0.0))
        );
        // The right and bottom edges belong to the neighbouring display.
        assert_eq!(to_image_point((0.0, -450.0), &frame, image), None);
        assert_eq!(to_image_point((-720.0, 0.0), &frame, image), None);
    }

    #[test]
    fn encode_jpeg_keeps_channel_order_and_orientation_and_rejects_bad_input() {
        // Quadrants in BGRA: red | blue over green | white.
        let (width, height) = (32u32, 32u32);
        let quadrant = |x: u32, y: u32| match (x < 16, y < 16) {
            (true, true) => [0, 0, 255, 255],
            (false, true) => [255, 0, 0, 255],
            (true, false) => [0, 255, 0, 255],
            (false, false) => [255, 255, 255, 255],
        };
        let bgra: Vec<u8> = (0..height)
            .flat_map(|y| (0..width).flat_map(move |x| quadrant(x, y)))
            .collect();
        let jpeg = encode_jpeg(&bgra, width, height, 95).unwrap();

        let mut decoder = jpeg_decoder::Decoder::new(jpeg.as_slice());
        let rgb = decoder.decode().unwrap();
        let info = decoder.info().unwrap();
        assert_eq!(
            (u32::from(info.width), u32::from(info.height)),
            (width, height)
        );
        let pixel = |x: usize, y: usize| {
            let i = (y * width as usize + x) * 3;
            [rgb[i], rgb[i + 1], rgb[i + 2]]
        };
        let close =
            |got: [u8; 3], want: [u8; 3]| got.iter().zip(want).all(|(g, w)| g.abs_diff(w) < 40);
        for ((x, y), want) in [
            ((8, 8), [255, 0, 0]),
            ((24, 8), [0, 0, 255]),
            ((8, 24), [0, 255, 0]),
            ((24, 24), [255; 3]),
        ] {
            assert!(
                close(pixel(x, y), want),
                "({x},{y}) decoded as {:?}",
                pixel(x, y)
            );
        }

        assert!(
            encode_jpeg(&bgra[..100], width, height, 95).is_err(),
            "undersized buffer"
        );
        assert!(
            encode_jpeg(&[], 70_000, 1, 80).is_err(),
            "too wide for JPEG"
        );
    }
}
