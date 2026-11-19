// Dessine un texte d'écran (sous-titre) en PNG transparent, pour la vidéo verticale.
// Usage : clark-text <sortie.png> <largeur> <hauteur> <taille-police> <texte>
// Texte blanc, gras, sur un bandeau sombre arrondi, centré, aux deux tiers de la hauteur
// (au-dessus de la zone basse que l'interface de TikTok recouvre).
import AppKit

let args = CommandLine.arguments
guard args.count >= 6, let width = Int(args[2]), let height = Int(args[3]), let size = Double(args[4]) else {
  FileHandle.standardError.write("usage: clark-text out.png largeur hauteur taille texte\n".data(using: .utf8)!)
  exit(2)
}
let out = args[1]
let text = args[5...].joined(separator: " ")

let font = NSFont.systemFont(ofSize: CGFloat(size), weight: .bold)
let paragraph = NSMutableParagraphStyle()
paragraph.alignment = .center
paragraph.lineBreakMode = .byWordWrapping
let attributes: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: NSColor.white, .paragraphStyle: paragraph]
let string = NSAttributedString(string: text, attributes: attributes)

let maxWidth = CGFloat(width) * 0.8
let bounds = string.boundingRect(with: NSSize(width: maxWidth, height: CGFloat(height)), options: [.usesLineFragmentOrigin, .usesFontLeading])
let padX = CGFloat(size) * 0.6, padY = CGFloat(size) * 0.35
let box = NSRect(
  x: (CGFloat(width) - bounds.width) / 2 - padX,
  y: CGFloat(height) * 0.33 - padY,
  width: bounds.width + 2 * padX,
  height: bounds.height + 2 * padY
)

guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: width, pixelsHigh: height, bitsPerSample: 8, samplesPerPixel: 4,
                                 hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else { exit(1) }
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
NSColor.clear.set()
NSRect(x: 0, y: 0, width: width, height: height).fill()
NSColor(calibratedWhite: 0.05, alpha: 0.72).setFill()
NSBezierPath(roundedRect: box, xRadius: CGFloat(size) * 0.35, yRadius: CGFloat(size) * 0.35).fill()
string.draw(with: NSRect(x: box.minX + padX, y: box.minY + padY, width: bounds.width, height: bounds.height), options: [.usesLineFragmentOrigin, .usesFontLeading])
NSGraphicsContext.restoreGraphicsState()

guard let png = rep.representation(using: .png, properties: [:]) else { exit(1) }
do { try png.write(to: URL(fileURLWithPath: out)) } catch { exit(1) }
