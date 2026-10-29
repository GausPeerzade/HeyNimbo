use std::path::{Path, PathBuf};
use std::process::Command;

fn main() {
    napi_build::setup();
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        link_swift_runtime();
    }
}

/// ScreenCaptureKit's bridge is Swift. Cargo applies link args only to the crate
/// that emits them, so this library and its tests must name the Swift runtime
/// themselves: the OS copy at run time, the toolchain's static shims at link time.
fn link_swift_runtime() {
    println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");
    let Ok(output) = Command::new("xcrun").args(["--find", "swift"]).output() else {
        return;
    };
    let swift = PathBuf::from(String::from_utf8_lossy(&output.stdout).trim());
    if let Some(usr) = swift.parent().and_then(Path::parent)
        && output.status.success()
    {
        println!(
            "cargo:rustc-link-search=native={}",
            usr.join("lib/swift/macosx").display()
        );
    }
}
