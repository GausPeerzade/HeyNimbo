// Lists on-screen windows owned by a PID (bounds and layer only; needs no permission).
import CoreGraphics
import Foundation

let pid = Int32(CommandLine.arguments.dropFirst().first ?? "") ?? 0
let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] ?? []
for window in windows where (window[kCGWindowOwnerPID as String] as? Int32) == pid {
    let bounds = window[kCGWindowBounds as String] as? [String: Any] ?? [:]
    let layer = window[kCGWindowLayer as String] as? Int ?? -1
    let sharing = window[kCGWindowSharingState as String] as? Int ?? -1
    print("layer=\(layer) sharing=\(sharing) bounds=\(bounds)")
}
