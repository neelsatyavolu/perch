// Renders Perch's app icon and product logos into overlay/.
//
//   swift branding/render-icons.swift <chromium src> <perch repo>   writes overlay/ files
//   swift branding/render-icons.swift preview <out dir>              writes 16/32/128/1024 px PNGs
//
// Sources: branding/perch-mark.svg (the flat mark on its rounded square) for every bitmap, and
// branding/AppIcon.icon (the macOS 26+ layered icon). Assets.car is compiled with Chromium's own
// tools/mac/icons/compile_car.py, which needs Xcode's actool.
import AppKit

func fail(_ message: String) -> Never {
    FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
    exit(1)
}

func render(_ svg: URL, pixels: Int, to out: URL) {
    guard let image = NSImage(contentsOf: svg) else { fail("cannot read \(svg.path)") }
    guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels,
                                     bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                                     colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else { fail("bitmap") }
    rep.size = NSSize(width: pixels, height: pixels)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    NSGraphicsContext.current?.imageInterpolation = .high
    image.draw(in: NSRect(x: 0, y: 0, width: pixels, height: pixels))
    NSGraphicsContext.restoreGraphicsState()
    guard let png = rep.representation(using: .png, properties: [:]) else { fail("png encode") }
    try? FileManager.default.createDirectory(at: out.deletingLastPathComponent(), withIntermediateDirectories: true)
    do { try png.write(to: out) } catch { fail("write \(out.path): \(error)") }
}

func pixelHeight(_ png: URL) -> Int {
    let out = shell(["sips", "-g", "pixelHeight", png.path])
    guard let last = out.split(separator: " ").last, let height = Int(last.trimmingCharacters(in: .whitespacesAndNewlines)) else {
        fail("cannot read height of \(png.path)")
    }
    return height
}

// The wordmark: the mark, then "Perch" in Geist Medium (system font if Geist is not installed).
func renderWordmark(_ svg: URL, width: Int, height: Int, white: Bool, to out: URL) {
    guard let mark = NSImage(contentsOf: svg) else { fail("cannot read \(svg.path)") }
    guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: width, pixelsHigh: height,
                                     bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                                     colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else { fail("bitmap") }
    rep.size = NSSize(width: width, height: height)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    NSGraphicsContext.current?.imageInterpolation = .high
    let h = CGFloat(height)
    mark.draw(in: NSRect(x: 0, y: 0, width: h, height: h))
    let size = h * 0.64
    let font = NSFont(name: "Geist-Medium", size: size) ?? NSFont.systemFont(ofSize: size, weight: .medium)
    let ink = white ? NSColor.white : NSColor(srgbRed: 0x0A / 255, green: 0x0A / 255, blue: 0x0C / 255, alpha: 1)
    let text = NSAttributedString(string: "Perch", attributes: [.font: font, .foregroundColor: ink])
    let textSize = text.size()
    text.draw(at: NSPoint(x: h * 1.25, y: (h - textSize.height) / 2))
    NSGraphicsContext.restoreGraphicsState()
    guard let png = rep.representation(using: .png, properties: [:]) else { fail("png encode") }
    try? FileManager.default.createDirectory(at: out.deletingLastPathComponent(), withIntermediateDirectories: true)
    do { try png.write(to: out) } catch { fail("write \(out.path): \(error)") }
}

func copyReplacing(_ from: URL, _ to: URL) {
    let fm = FileManager.default
    try? fm.removeItem(at: to)
    try? fm.createDirectory(at: to.deletingLastPathComponent(), withIntermediateDirectories: true)
    do { try fm.copyItem(at: from, to: to) } catch { fail("copy \(from.path) to \(to.path): \(error)") }
}

func pngs(under dir: URL) -> [URL] {
    let walker = FileManager.default.enumerator(at: dir, includingPropertiesForKeys: nil)
    return (walker?.allObjects as? [URL] ?? []).filter { $0.pathExtension == "png" }.sorted { $0.path < $1.path }
}

func shell(_ args: [String], cwd: URL? = nil) -> String {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
    process.arguments = args
    if let cwd { process.currentDirectoryURL = cwd }
    let pipe = Pipe()
    process.standardOutput = pipe
    do { try process.run() } catch { fail("run \(args): \(error)") }
    process.waitUntilExit()
    if process.terminationStatus != 0 { fail("\(args.joined(separator: " ")) exited \(process.terminationStatus)") }
    return String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
}

func pixelWidth(_ png: URL) -> Int {
    let out = shell(["sips", "-g", "pixelWidth", png.path])
    guard let last = out.split(separator: " ").last, let width = Int(last.trimmingCharacters(in: .whitespacesAndNewlines)) else {
        fail("cannot read width of \(png.path)")
    }
    return width
}

let args = CommandLine.arguments
let scriptDir = URL(fileURLWithPath: args[0]).deletingLastPathComponent()
let svg = scriptDir.appendingPathComponent("perch-mark.svg")

if args.count == 3 && args[1] == "preview" {
    let outDir = URL(fileURLWithPath: args[2])
    for size in [16, 32, 128, 1024] {
        render(svg, pixels: size, to: outDir.appendingPathComponent("perch-\(size).png"))
    }
    exit(0)
}
guard args.count == 3 else { fail("usage: render-icons.swift <chromium src> <perch repo> | preview <out dir>") }
let src = URL(fileURLWithPath: args[1])
let overlay = URL(fileURLWithPath: args[2]).appendingPathComponent("overlay")

// 1. app.icns from a standard 10-image iconset.
let iconset = FileManager.default.temporaryDirectory.appendingPathComponent("perch.iconset")
try? FileManager.default.removeItem(at: iconset)
for base in [16, 32, 128, 256, 512] {
    render(svg, pixels: base, to: iconset.appendingPathComponent("icon_\(base)x\(base).png"))
    render(svg, pixels: base * 2, to: iconset.appendingPathComponent("icon_\(base)x\(base)@2x.png"))
}
let icns = overlay.appendingPathComponent("chrome/app/theme/chromium/mac/app.icns")
try? FileManager.default.createDirectory(at: icns.deletingLastPathComponent(), withIntermediateDirectories: true)
_ = shell(["iconutil", "-c", "icns", iconset.path, "-o", icns.path])
print("wrote \(icns.path)")

// 2. Every Chromium product logo PNG, each at its own pixel size.
let listed = shell(["git", "-C", src.path, "ls-files", "--",
                    "chrome/app/theme/chromium/*product_logo*.png",
                    "chrome/app/theme/*/chromium/product_logo*.png"])
for name in listed.split(separator: "\n") where !name.isEmpty {
    let original = src.appendingPathComponent(String(name))
    let target = overlay.appendingPathComponent(String(name))
    if name.contains("product_logo_name") {
        renderWordmark(svg, width: pixelWidth(original), height: pixelHeight(original),
                       white: name.contains("_white"), to: target)
    } else {
        render(svg, pixels: pixelWidth(original), to: target)
    }
    print("wrote \(target.path)")
}

// 3. Assets.car: Chromium's asset catalog with Perch's bitmaps, plus Perch's AppIcon.icon.
let macDir = "chrome/app/theme/chromium/mac"
let staging = FileManager.default.temporaryDirectory.appendingPathComponent("perch-car/mac")
try? FileManager.default.removeItem(at: staging.deletingLastPathComponent())
let stagedCatalog = staging.appendingPathComponent("Assets.xcassets")
copyReplacing(src.appendingPathComponent("\(macDir)/Assets.xcassets"), stagedCatalog)
for png in pngs(under: stagedCatalog) {
    render(svg, pixels: pixelWidth(png), to: png)
    let rel = String(png.path.dropFirst(staging.path.count + 1))
    copyReplacing(png, overlay.appendingPathComponent("\(macDir)/\(rel)"))
}
copyReplacing(scriptDir.appendingPathComponent("AppIcon.icon"), staging.appendingPathComponent("AppIcon.icon"))
copyReplacing(scriptDir.appendingPathComponent("AppIcon.icon"), overlay.appendingPathComponent("\(macDir)/AppIcon.icon"))
_ = shell(["python3", src.appendingPathComponent("tools/mac/icons/compile_car.py").path, stagedCatalog.path])
copyReplacing(staging.appendingPathComponent("Assets.car"), overlay.appendingPathComponent("\(macDir)/Assets.car"))
print("wrote \(overlay.appendingPathComponent("\(macDir)/Assets.car").path)")
let emittedIcns = staging.appendingPathComponent("app.icns")
if FileManager.default.fileExists(atPath: emittedIcns.path) {
    copyReplacing(emittedIcns, icns)
    print("actool emitted app.icns; using it")
}
