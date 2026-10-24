// Makes a fillable PDF "flexible": text boxes wrap and auto-shrink their font,
// and stacks of one-line row boxes (e.g. a numbered "Notes 1..10" list) become one paragraph box.
// Usage: node make-flexible.cjs input.pdf [output.pdf]
const fs = require('fs');
const path = require('path');
const {
  PDFDocument, StandardFonts, PDFName, PDFBool, PDFTextField, PDFDict, PDFArray, PDFStream,
  beginMarkedContent, endMarkedContent, pushGraphicsState, popGraphicsState, rectangle, clip, endPath,
  beginText, endText, setFillingGrayscaleColor, setFontAndSize, setLineHeight, moveText, showText, nextLine,
} = require(path.join(__dirname, 'node_modules', 'pdf-lib'));

const ROW_MIN_WIDTH = 180;   // narrower stacks (table cells etc.) are left alone
const TALL = 26;             // boxes at least this tall become multi-line + auto size

function setDA(o, size) {
  let da = o.getDefaultAppearance() || '/Helv 0 Tf 0 g';
  da = /Tf/.test(da) ? da.replace(/(\/\S+)\s+[\d.]+\s+Tf/, `$1 ${size} Tf`) : `/Helv ${size} Tf ` + da;
  o.setDefaultAppearance(da);
}

const MAX_SIZE = 11;
const AUTO_DA = '/Helv 0 Tf 0 g';
function wrapLines(font, text, width, size) {
  const out = [];
  const w = s => font.widthOfTextAtSize(s, size);
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/ +/)) {
      const cand = line ? line + ' ' + word : word;
      if (w(cand) <= width) { line = cand; continue; }
      if (line) out.push(line);
      line = word;
      while (w(line) > width && line.length > 1) { // a single word wider than the box
        let i = line.length; while (i > 1 && w(line.slice(0, i)) > width) i--;
        out.push(line.slice(0, i)); line = line.slice(i);
      }
    }
    out.push(line);
  }
  return out;
}
const lineHeight = (font, s) => font.heightAtSize(s) * 1.15;
function fitSize(font, text, width, height) {
  if (!text.trim()) return MAX_SIZE;
  for (let s = MAX_SIZE; s > 4; s -= 0.25) if (wrapLines(font, text, width, s).length * lineHeight(font, s) <= height) return s;
  return 4;
}

// Draws the widget's printed look ourselves: pdf-lib's multi-line layout can run past the right edge.
function drawAppearance(doc, font, widget, text) {
  const { width: W, height: H } = widget.getRectangle();
  const PAD = 3, TW = (W - 2 * PAD) * 0.97; // viewers measure Helvetica up to ~1% wider than pdf-lib
  const size = fitSize(font, text, TW, H - 2 * PAD);
  const lh = lineHeight(font, size);
  const ops = [beginMarkedContent('Tx'), pushGraphicsState(), rectangle(1, 1, W - 2, H - 2), clip(), endPath()];
  if (text.trim()) {
    ops.push(beginText(), setFillingGrayscaleColor(0), setFontAndSize('F0', size), setLineHeight(lh),
      moveText(PAD, H - PAD - font.heightAtSize(size, { descender: false })));
    for (const ln of wrapLines(font, text, TW, size)) ops.push(showText(font.encodeText(ln)), nextLine());
    ops.push(endText());
  }
  ops.push(popGraphicsState(), endMarkedContent());
  const stream = doc.context.formXObject(ops, { BBox: [0, 0, W, H], Resources: { Font: { F0: font.ref } } });
  widget.setNormalAppearance(doc.context.register(stream));
}

// macOS Preview re-saves forms with new widget objects on the pages while the field's /Kids
// still lists the old, unseen copies. Point every field back at the widgets the pages show,
// and register text boxes that sit on a page without being in the form at all.
function relinkVisibleWidgets(doc, pages) {
  const { context } = doc;
  const acro = doc.catalog.lookup(PDFName.of('AcroForm'), PDFDict);
  const fieldsArr = acro.lookup(PDFName.of('Fields'), PDFArray);
  const reachable = new Set();
  const kidsArr = d => { const v = d instanceof PDFDict ? d.lookup(PDFName.of('Kids')) : undefined; return v instanceof PDFArray ? v : undefined; };
  const walk = ref => { const k = ref.toString(); if (reachable.has(k)) return; reachable.add(k); kidsArr(context.lookup(ref))?.asArray().forEach(walk); };
  fieldsArr.asArray().forEach(walk);
  // drop malformed appearance entries (seen: /AP written as an array) so pdf-lib can redraw the box
  for (const [, obj] of context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFDict) || String(obj.get(PDFName.of('Subtype'))) !== '/Widget') continue;
    const ap = obj.lookup(PDFName.of('AP'));
    const ok = v => v === undefined || v instanceof PDFDict || v instanceof PDFStream;
    if (ap !== undefined && (!(ap instanceof PDFDict) || !ap.has(PDFName.of('N')) || !['N', 'R', 'D'].every(k => ok(ap.lookup(PDFName.of(k)))))) obj.delete(PDFName.of('AP'));
  }
  const kidsOf = new Map(); let added = 0;
  pages.forEach(p => (p.node.Annots()?.asArray() || []).forEach(ref => {
    const a = context.lookup(ref);
    if (!(a instanceof PDFDict) || String(a.get(PDFName.of('Subtype'))) !== '/Widget') return;
    if (!a.get(PDFName.of('P'))) a.set(PDFName.of('P'), p.ref);
    const parent = a.get(PDFName.of('Parent'));
    if (parent && !a.get(PDFName.of('T'))) {
      const k = parent.toString();
      if (!kidsOf.has(k)) kidsOf.set(k, { parent, kids: [] });
      kidsOf.get(k).kids.push(ref);
    } else if (!parent && !reachable.has(ref.toString()) && String(a.get(PDFName.of('FT'))) === '/Tx') {
      fieldsArr.push(ref); reachable.add(ref.toString()); added++;
    }
  }));
  let relinked = 0;
  for (const { parent, kids } of kidsOf.values()) {
    const pd = context.lookup(parent, PDFDict);
    const cur = (kidsArr(pd)?.asArray() || []).map(String).sort().join();
    if (cur !== kids.map(String).sort().join()) {
      // never delete the old refs: in Preview-saved files those object numbers are reused by fonts/appearances
      pd.set(PDFName.of('Kids'), context.obj(kids)); relinked++;
    }
    if (!reachable.has(parent.toString()) && !pd.get(PDFName.of('Parent'))) { fieldsArr.push(parent); reachable.add(parent.toString()); }
  }
  return { relinked, added };
}

// Files saved by macOS Preview can have streams without /Length that pdf-lib reads wrongly
// (pages come out blank). qpdf rewrites them cleanly first; exit code 3 means "fixed with warnings".
function cleanWithQpdf(inp) {
  const tmp = path.join(require('os').tmpdir(), `fitpdf-${process.pid}.pdf`);
  try {
    require('child_process').execFileSync('/opt/homebrew/bin/qpdf', ['--object-streams=disable', inp, tmp], { stdio: 'ignore' });
  } catch (e) { if (e.status !== 3) throw new Error('qpdf could not read this PDF'); }
  const bytes = fs.readFileSync(tmp); fs.unlinkSync(tmp); return bytes;
}

(async () => {
  const [inp, outArg] = process.argv.slice(2);
  if (!inp) { console.error('usage: node make-flexible.cjs input.pdf [output.pdf]'); process.exit(1); }
  const doc = await PDFDocument.load(cleanWithQpdf(inp), { ignoreEncryption: true });
  const form = doc.getForm();
  // already converted (has our paragraph box) -> this run is the fit-before-printing pass
  const alreadyFlexible = form.getFields().some(f => / \(paragraph\)$/.test(f.getName()));
  const base = inp.replace(/\.pdf$/i, '').replace(/ - (flexible|PRINT)$/i, '');
  const out = outArg || base + (alreadyFlexible ? ' - PRINT.pdf' : ' - flexible.pdf');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pages = doc.getPages();
  const repaired = relinkVisibleWidgets(doc, pages);
  const pageOf = new Map();
  pages.forEach((p, i) => (p.node.Annots()?.asArray() || []).forEach(r => pageOf.set(r.toString(), i)));
  const widgetsOf = f => f.acroField.getWidgets().map(w => {
    const ref = doc.context.getObjectRef(w.dict);
    return { w, rect: w.getRectangle(), page: ref ? pageOf.get(ref.toString()) : undefined };
  });

  // 1. find stacks of numbered one-line boxes, per page
  const stacks = new Map();
  for (const f of form.getFields()) {
    if (!(f instanceof PDFTextField) || f.isMultiline()) continue;
    const m = f.getName().match(/^(.*?)(\d+)$/); if (!m) continue;
    for (const { rect, page } of widgetsOf(f)) {
      if (page === undefined) continue;
      const k = m[1] + '|' + page;
      if (!stacks.has(k)) stacks.set(k, { prefix: m[1], page, items: [] });
      stacks.get(k).items.push({ f, rect });
    }
  }
  const valid = [...stacks.values()].filter(s => {
    if (s.items.length < 3) return false;
    s.items.sort((a, b) => b.rect.y - a.rect.y);
    const h = s.items[0].rect.height, x = s.items[0].rect.x;
    s.width = Math.min(...s.items.map(i => i.rect.width));
    return s.items.every((it, i) => !i || (s.items[i - 1].rect.y - (it.rect.y + it.rect.height)) < h * 1.5 && Math.abs(it.rect.x - x) < 4);
  });
  const yc = r => r.y + r.height / 2;
  const groups = new Map(); // prefix -> { main stacks by page, label stacks by page }
  for (const s of valid) {
    if (s.width < ROW_MIN_WIDTH) continue;
    const label = valid.find(o => o !== s && o.page === s.page && o.width < s.width && Math.abs(o.items[0].rect.y - s.items[0].rect.y) < 3 && o.items[0].rect.x < s.items[0].rect.x);
    if (!groups.has(s.prefix)) groups.set(s.prefix, []);
    groups.get(s.prefix).push({ main: s, label });
  }

  const merged = [];
  for (const [prefix, parts] of groups) {
    // read existing text in row order (use the page with the most rows)
    const ref = parts.reduce((a, b) => (b.main.items.length > a.main.items.length ? b : a));
    const entries = [];
    for (const it of ref.main.items) {
      const l = ref.label?.items.find(x => Math.abs(yc(x.rect) - yc(it.rect)) < 3)?.f.getText()?.trim() || '';
      const t = (it.f.getText() || "").replace(/\s+/g, " ").trim();
      if (!l && !t) continue;
      if (l || !entries.length) entries.push((l ? l + '  ' : '') + t);
      else entries[entries.length - 1] += ' ' + t;
    }
    const value = entries.join('\n');
    const old = new Set();
    for (const p of parts) { p.main.items.forEach(i => old.add(i.f)); p.label?.items.forEach(i => old.add(i.f)); }
    const name = (prefix.trim() || 'Rows') + ' (paragraph)';
    const tf = form.createTextField(name);
    const rects = parts.map(p => {
      const all = [...p.main.items, ...(p.label?.items || [])].map(i => i.rect);
      const x0 = Math.min(...all.map(r => r.x)), y0 = Math.min(...all.map(r => r.y));
      const x1 = Math.max(...all.map(r => r.x + r.width)), y1 = Math.max(...all.map(r => r.y + r.height));
      return { page: p.main.page, x: x0 + 1, y: y0, width: x1 - x0 - 5, height: y1 - y0 };
    });
    // removed by hand: pdf-lib's removeField leaves refs in /Annots and throws on boxes without /AP
    const fieldsArr = form.acroForm.dict.lookup(PDFName.of('Fields'), PDFArray);
    for (const f of old) {
      const fieldRef = f.ref.toString();
      const widgetRefs = f.acroField.getWidgets().map(w => doc.context.getObjectRef(w.dict)).filter(Boolean);
      const drop = new Set([fieldRef, ...widgetRefs.map(String)]);
      for (const p of pages) {
        const annots = p.node.Annots(); if (!annots) continue;
        for (let i = annots.size() - 1; i >= 0; i--) if (drop.has(annots.get(i).toString())) annots.remove(i);
      }
      for (let i = fieldsArr.size() - 1; i >= 0; i--) if (fieldsArr.get(i).toString() === fieldRef) fieldsArr.remove(i);
      const parent = f.acroField.dict.lookup(PDFName.of('Parent'));
      const pk = parent instanceof PDFDict ? parent.lookup(PDFName.of('Kids')) : undefined;
      if (pk instanceof PDFArray) for (let i = pk.size() - 1; i >= 0; i--) if (pk.get(i).toString() === fieldRef) pk.remove(i);
    }
    for (const r of rects) tf.addToPage(pages[r.page], { x: r.x, y: r.y, width: r.width, height: r.height, borderWidth: 0, font });
    tf.enableMultiline();
    tf.enableScrolling();
    setDA(tf.acroField, 0); tf.acroField.getWidgets().forEach(w => setDA(w, 0));
    if (value) tf.setText(value);
    merged.push(`${name}: ${old.size} row boxes -> 1 paragraph box on page(s) ${rects.map(r => r.page + 1).join(', ')}`);
  }

  // 2. tall boxes: wrap + auto-shrink font
  const tall = [];
  for (const f of form.getFields()) {
    if (!(f instanceof PDFTextField) || f.getMaxLength()) continue;
    const ws = widgetsOf(f);
    if (!ws.some(x => x.rect.height >= TALL)) continue;
    f.enableMultiline(); f.enableScrolling();
    setDA(f.acroField, 0); ws.forEach(x => setDA(x.w, 0));
    f.setText((f.getText() || "").replace(/\r\n?/g, "\n") || undefined);
    tall.push(f.getName());
  }

  // pdf-lib's own multi-line auto-size neither shrinks to the box height nor stays inside the width,
  // so the wrap+shrink boxes get appearances drawn by us; their DA stays 0 (auto) for the next editor.
  form.updateFieldAppearances(font);
  for (const n of tall) for (const { w } of widgetsOf(form.getTextField(n))) drawAppearance(doc, font, w, form.getTextField(n).getText() || '');
  // pdf-lib writes the size it computed (huge for empty boxes) into each DA; put auto back so typing works
  for (const n of tall) { const a = form.getTextField(n).acroField; a.setDefaultAppearance(AUTO_DA); a.getWidgets().forEach(w => w.setDefaultAppearance(AUTO_DA)); }
  form.acroForm.dict.set(PDFName.of('NeedAppearances'), PDFBool.False);
  fs.writeFileSync(out, await doc.save({ updateFieldAppearances: false }));
  console.log(`form repair: ${repaired.relinked} fields relinked to their visible boxes, ${repaired.added} loose boxes registered`);
  console.log(merged.join('\n') || 'no row stacks found');
  console.log(`wrap + auto-shrink: ${tall.length} boxes (${tall.join(', ')})`);
  console.log('saved:', out);
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
