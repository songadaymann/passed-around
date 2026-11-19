import AppKit
import Foundation

let output = CommandLine.arguments[1]
let size = 1024
let image = NSImage(size: NSSize(width: size, height: size))
image.lockFocus()
let square = NSRect(x: 20, y: 20, width: 984, height: 984)
NSColor(calibratedRed: 0.84, green: 0.96, blue: 0.28, alpha: 1).setFill()
NSBezierPath(roundedRect: square, xRadius: 210, yRadius: 210).fill()
NSColor(calibratedRed: 0.12, green: 0.14, blue: 0.10, alpha: 1).setFill()
NSBezierPath(ovalIn: NSRect(x: 155, y: 155, width: 714, height: 714)).fill()
NSColor(calibratedWhite: 0.30, alpha: 1).setStroke()
for radius in stride(from: 206, through: 337, by: 16) {
    let ring = NSBezierPath(ovalIn: NSRect(x: 512 - radius, y: 512 - radius, width: radius * 2, height: radius * 2))
    ring.lineWidth = 3; ring.stroke()
}
NSColor(calibratedRed: 0.70, green: 0.60, blue: 0.86, alpha: 1).setFill()
NSBezierPath(ovalIn: NSRect(x: 369, y: 369, width: 286, height: 286)).fill()
NSColor(calibratedRed: 0.12, green: 0.14, blue: 0.10, alpha: 1).setFill()
NSBezierPath(ovalIn: NSRect(x: 490, y: 490, width: 44, height: 44)).fill()
image.unlockFocus()
let representation = NSBitmapImageRep(data: image.tiffRepresentation!)!
try representation.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: output))
