// Renders branding/perch-mark.svg into Perch's app icon and product logos.
//
//   swift branding/render-icons.swift <chromium src> <perch repo>   writes overlay/ files
//   swift branding/render-icons.swift preview <out dir>              writes 16/32/128/1024 px PNGs
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
    render(svg, pixels: pixelWidth(original), to: target)
    print("wrote \(target.path)")
}
