// Renders branding/app-icons/perch-mark-*.svg to the 1024 px Dock icons people can pick in
// Settings › Appearance › App icon (ui-pages/public/app-icons). Sakura's two are rendered by
// branding/sakura/render-sakura-icons.swift. Run from the repo: swift branding/app-icons/render-app-icons.swift
import AppKit

for name in ["paper", "ink", "blue", "mono"] {
    let svg = URL(fileURLWithPath: "branding/app-icons/perch-mark-\(name).svg")
    let out = URL(fileURLWithPath: "ui-pages/public/app-icons/app-\(name).png")
    guard let image = NSImage(contentsOf: svg),
          let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 1024, pixelsHigh: 1024, bitsPerSample: 8,
                                     samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
                                     bytesPerRow: 0, bitsPerPixel: 0) else { fatalError("cannot render \(svg.path)") }
    rep.size = NSSize(width: 1024, height: 1024)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    NSGraphicsContext.current?.imageInterpolation = .high
    image.draw(in: NSRect(x: 0, y: 0, width: 1024, height: 1024))
    NSGraphicsContext.restoreGraphicsState()
    try! rep.representation(using: .png, properties: [:])!.write(to: out)
}
