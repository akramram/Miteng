// Draws the DMG window background. Regenerate after changing the copy or the
// icon positions in tauri.conf.json (bundle > macOS > dmg):
//   cd frontend/src-tauri/dmg && swift background.swift && \
//   tiffutil -cathidpicheck background.png background@2x.png -out background.tiff && \
//   rm background.png background@2x.png
import AppKit

let size = NSSize(width: 660, height: 420)
// Icon centres from tauri.conf.json, in Finder's top-left coordinates.
let iconY: CGFloat = 190
let appX: CGFloat = 170
let applicationsX: CGFloat = 490

let paper = NSColor(srgbRed: 0.957, green: 0.933, blue: 0.894, alpha: 1)
let band = NSColor(srgbRed: 0.918, green: 0.886, blue: 0.835, alpha: 1)
let hairline = NSColor(srgbRed: 0.851, green: 0.808, blue: 0.741, alpha: 1)
let ink = NSColor(srgbRed: 0.165, green: 0.137, blue: 0.098, alpha: 1)
let muted = NSColor(srgbRed: 0.427, green: 0.384, blue: 0.329, alpha: 1)
let brown = NSColor(srgbRed: 0.396, green: 0.267, blue: 0.169, alpha: 1)

func render(scale: CGFloat, to path: String) {
    let rep = NSBitmapImageRep(
        bitmapDataPlanes: nil, pixelsWide: Int(size.width * scale), pixelsHigh: Int(size.height * scale),
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
        colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    rep.size = size
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    // Flip so y runs down like Finder's icon positions.
    let flip = NSAffineTransform()
    flip.translateX(by: 0, yBy: size.height)
    flip.scaleX(by: 1, yBy: -1)
    flip.concat()

    paper.setFill()
    NSRect(origin: .zero, size: size).fill()

    // Footer: what to do when Gatekeeper stops the unsigned first launch.
    let bandTop: CGFloat = 304
    band.setFill()
    NSRect(x: 0, y: bandTop, width: size.width, height: size.height - bandTop).fill()
    hairline.setFill()
    NSRect(x: 0, y: bandTop, width: size.width, height: 1).fill()

    func text(_ string: String, y: CGFloat, font: NSFont, color: NSColor) {
        let style = NSMutableParagraphStyle()
        style.alignment = .center
        let attributed = NSAttributedString(string: string, attributes: [
            .font: font, .foregroundColor: color, .paragraphStyle: style,
        ])
        let height = attributed.size().height
        NSGraphicsContext.saveGraphicsState()
        // Text draws upright inside the flipped context.
        let ctx = NSGraphicsContext(cgContext: NSGraphicsContext.current!.cgContext, flipped: true)
        NSGraphicsContext.current = ctx
        attributed.draw(in: NSRect(x: 0, y: y - height / 2, width: size.width, height: height))
        NSGraphicsContext.restoreGraphicsState()
    }

    text("Install Miteng", y: 46, font: .systemFont(ofSize: 24, weight: .semibold), color: ink)
    text("Drag Miteng onto the Applications folder.", y: 76, font: .systemFont(ofSize: 14), color: muted)

    // Arrow between the two icons (128 pt wide, so leave room on both sides).
    let start = appX + 92, end = applicationsX - 92
    let arrow = NSBezierPath()
    arrow.lineWidth = 3
    arrow.lineCapStyle = .round
    arrow.lineJoinStyle = .round
    arrow.move(to: NSPoint(x: start, y: iconY))
    arrow.line(to: NSPoint(x: end, y: iconY))
    arrow.move(to: NSPoint(x: end - 12, y: iconY - 12))
    arrow.line(to: NSPoint(x: end, y: iconY))
    arrow.line(to: NSPoint(x: end - 12, y: iconY + 12))
    brown.setStroke()
    arrow.stroke()

    text("Blocked on first launch? Open System Settings → Privacy & Security,",
         y: 332, font: .systemFont(ofSize: 12.5), color: muted)
    text("scroll down, and click Open Anyway.",
         y: 351, font: .systemFont(ofSize: 12.5), color: muted)

    NSGraphicsContext.restoreGraphicsState()
    try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: path))
}

render(scale: 1, to: "background.png")
render(scale: 2, to: "background@2x.png")
