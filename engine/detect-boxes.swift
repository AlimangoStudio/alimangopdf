// Finds the places on a form where someone is meant to write or tick, from how the page looks:
// empty squares (checkboxes), empty boxes and blank lines with room above them (text).
// It renders each page's printed content only (no form fields), so it works however the PDF drew its boxes.
// Usage: detect-boxes form.pdf   -> JSON [{"page":0,"kind":"check"|"text","x":..,"y":..,"w":..,"h":..}] in PDF points
// Build: swiftc -O detect-boxes.swift -o detect-boxes   (macOS, Xcode Command Line Tools)
import Foundation
import CoreGraphics

let S: CGFloat = 3            // pixels per point
// darker than this is ink: two passes, 150 keeps close double rules apart, 200 also sees light-grey forms
let INK: [UInt8] = [150, 200]

struct Found: Encodable { let page: Int; let kind: String; let x: Double; let y: Double; let w: Double; let h: Double }

func detect(_ page: CGPDFPage, _ index: Int) -> [Found] {
    let box = page.getBoxRect(.mediaBox)
    guard page.rotationAngle % 360 == 0 else { return [] }   // rotated pages are left alone
    let W = Int(box.width * S), H = Int(box.height * S)
    guard W > 0, H > 0, W * H < 60_000_000 else { return [] }
    var px = [UInt8](repeating: 255, count: W * H)
    let ok: Bool = px.withUnsafeMutableBytes { raw in
        guard let ctx = CGContext(data: raw.baseAddress, width: W, height: H, bitsPerComponent: 8, bytesPerRow: W,
                                  space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue) else { return false }
        ctx.setFillColor(gray: 1, alpha: 1); ctx.fill(CGRect(x: 0, y: 0, width: W, height: H))
        ctx.scaleBy(x: S, y: S); ctx.translateBy(x: -box.minX, y: -box.minY)
        ctx.drawPDFPage(page)   // page content only: form fields are annotations and are not drawn
        return true
    }
    guard ok else { return [] }
    if let dir = ProcessInfo.processInfo.environment["DETECT_DUMP"] {   // debugging: the page as a PGM image
        let head = "P5 \(W) \(H) 255\n".data(using: .ascii)!
        try? (head + Data(px)).write(to: URL(fileURLWithPath: "\(dir)/page\(index + 1).pgm"))
    }
    var out: [Found] = []
    for DARK in INK { out += analyze(px, W, H, box, index, DARK) }
    return out
}

func analyze(_ px: [UInt8], _ W: Int, _ H: Int, _ box: CGRect, _ index: Int, _ DARK: UInt8) -> [Found] {
    // row 0 of the bitmap is the top of the page
    @inline(__always) func dark(_ x: Int, _ y: Int) -> Bool { px[y * W + x] < DARK }
    @inline(__always) func faint(_ x: Int, _ y: Int) -> Bool { px[y * W + x] < 225 }   // any ink, even light grey lines
    let pt = { (v: Int) in Double(v) / Double(S) }
    var out: [Found] = []
    func add(_ kind: String, _ x0: Int, _ y0: Int, _ x1: Int, _ y1: Int) {   // pixel box, y0 = top row
        out.append(Found(page: index, kind: kind, x: Double(box.minX) + pt(x0), y: Double(box.minY) + pt(H - 1 - y1),
                         w: pt(x1 - x0 + 1), h: pt(y1 - y0 + 1)))
    }

    // 1. Empty enclosed boxes: white regions that do not touch the page edge and fill their bounding box.
    var seen = [Bool](repeating: false, count: W * H)
    var stack: [Int] = []
    for start in 0..<(W * H) where !seen[start] && px[start] >= DARK {
        var x0 = W, y0 = H, x1 = -1, y1 = -1, count = 0, edge = false
        seen[start] = true; stack.append(start)
        while let i = stack.popLast() {
            let x = i % W, y = i / W
            count += 1
            if x < x0 { x0 = x }; if x > x1 { x1 = x }; if y < y0 { y0 = y }; if y > y1 { y1 = y }
            if x == 0 || y == 0 || x == W - 1 || y == H - 1 { edge = true }
            for n in [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, y > 0 ? i - W : -1, y < H - 1 ? i + W : -1] where n >= 0 {
                if !seen[n] && px[n] >= DARK { seen[n] = true; stack.append(n) }
            }
        }
        if edge { continue }
        let bw = x1 - x0 + 1, bh = y1 - y0 + 1
        let w = pt(bw), h = pt(bh)
        guard Double(bw * bh - count) <= 0.004 * Double(bw * bh) else { continue }   // any text or mark inside: a label, not a blank
        guard w * h < 0.25 * Double(box.width * box.height) else { continue }    // page frames and big panels
        // the edge must be drawn ink all round (a ruled box), not the inside of a letter or a picture
        var ring = 0, inked = 0
        for x in x0...x1 { ring += 2; if dark(x, y0 - 1) { inked += 1 }; if dark(x, y1 + 1) { inked += 1 } }
        for y in y0...y1 { ring += 2; if dark(x0 - 1, y) { inked += 1 }; if dark(x1 + 1, y) { inked += 1 } }
        guard Double(inked) >= 0.9 * Double(ring) else { continue }
        if w >= 6, w <= 20, h >= 6, h <= 20, abs(w - h) <= 0.35 * max(w, h) { add("check", x0, y0, x1, y1) }
        else if h >= 7, h <= 150, w >= 12 { add("text", x0, y0, x1, y1) }
    }

    // 2. Blank lines (underlines, |_|_| date ticks): a thin horizontal rule with nothing written above it.
    let minRun = Int(8 * S), band = Int(13 * S)
    var used = [Bool](repeating: false, count: W * H)
    for y in 1..<(H - 1) {
        var x = 0
        while x < W {
            guard dark(x, y), !used[y * W + x] else { x += 1; continue }
            var e = x; while e + 1 < W && dark(e + 1, y) { e += 1 }
            defer { x = e + 1 }
            guard e - x + 1 >= minRun else { continue }
            // thickness: the rows below that repeat the same run belong to this rule
            var t = y; while t + 1 < H && t - y < Int(3 * S) && (x...e).filter({ dark($0, t + 1) }).count > (e - x + 1) * 9 / 10 { t += 1 }
            for yy in y...t { for xx in x...e { used[yy * W + xx] = true } }
            guard t - y <= Int(2.5 * S) else { continue }                           // a bar, not a rule
            guard Double(e - x) < 0.75 * Double(box.width * S) else { continue }     // page-wide separators
            // a drawn rule stands alone: the rows just above (bar ticks) and below it are mostly paper.
            // Bold text and pictures have ink there too.
            let len = e - x + 1
            guard t + 2 < H, y >= 2, (x...e).filter({ dark($0, t + 2) }).count * 10 < len * 3,
                  (x...e).filter({ dark($0, y - 2) }).count * 10 < len * 3 else { continue }
            // a curve's peak (a round seal) runs on downwards past its ends; a drawn rule ends cleanly
            let side = Int(2 * S), below = Int(3 * S)
            func inkPast(_ x0: Int, _ x1: Int) -> Bool {
                guard x0 >= 0, x1 < W, t + below < H else { return false }
                var n = 0; for yy in (t + 1)...(t + below) { for xx in x0...x1 where faint(xx, yy) { n += 1 } }
                return n * 10 > (x1 - x0 + 1) * below * 2
            }
            if inkPast(x - side, x - 1) || inkPast(e + 1, e + side) { continue }
            // ink hanging below the rule (a box's sides, a letter's stem): the top of a box or a letter, not a blank
            let drop = Int(3 * S)
            guard t + drop < H, !(x...e).contains(where: { xx in (1...drop).allSatisfy { faint(xx, t + $0) } }) else { continue }
            // nothing above: ticks (ink columns standing on the rule, |_|_|) are fine, anything else is text or a box top
            let open = max(0, y - band)
            var clear = true, top = open
            var tickHeight = [Int](repeating: 0, count: e - x + 1)
            outer: for xx in x...e {
                var yy = y - 1
                while yy >= top && dark(xx, yy) { yy -= 1 }                            // skip a tick on this column
                tickHeight[xx - x] = y - 1 - yy
                var k = yy; while k >= top { if dark(xx, k) { if y - k <= Int(2 * S) { clear = false; break outer }; top = max(top, k + 1); break }; k -= 1 }
            }
            guard clear, y - top >= Int(8 * S) else { continue }                    // need room for a line of text
            // a second rule just below (double underline / table border): not a blank to fill
            var double = false
            for yy in (t + 1)...min(H - 1, t + Int(4 * S)) where (x...e).filter({ dark($0, yy) }).count > (e - x + 1) * 8 / 10 { double = true; break }
            if double { continue }
            // tall ticks inside a long rule divide it into separate blanks (a row of dates, one per column)
            var cuts = [x]
            for i in 0..<tickHeight.count where tickHeight[i] >= Int(8 * S) && i > Int(2 * S) && i < tickHeight.count - Int(2 * S) {
                if x + i - cuts.last! > Int(2 * S) { cuts.append(x + i) }
            }
            cuts.append(e)
            for j in 0..<(cuts.count - 1) where cuts[j + 1] - cuts[j] >= minRun {
                // closed on top and about square: a tick box whose outline was not one clean shape
                let w = pt(cuts[j + 1] - cuts[j]), h = pt(y - top)
                let square = top > open && w <= 20 && abs(w - h) <= 0.35 * max(w, h)
                add(square ? "check" : "text", cuts[j], top, cuts[j + 1], y - 1)
            }
        }
    }
    return out
}

guard CommandLine.arguments.count == 2, let doc = CGPDFDocument(URL(fileURLWithPath: CommandLine.arguments[1]) as CFURL) else {
    FileHandle.standardError.write("usage: detect-boxes form.pdf\n".data(using: .utf8)!); exit(1)
}
var all: [Found] = []
for i in 0..<doc.numberOfPages { if let p = doc.page(at: i + 1) { all += detect(p, i) } }
let enc = JSONEncoder(); enc.outputFormatting = [.sortedKeys]
print(String(data: try! enc.encode(all), encoding: .utf8)!)
