const fs=require('fs');const {PDFDocument,StandardFonts,PDFTextField,PDFCheckBox,PDFRadioGroup}=require(require('path').join(__dirname,'node_modules','pdf-lib'));
(async()=>{const d=await PDFDocument.load(fs.readFileSync(process.argv[2]));const f=d.getForm();
const keep=[];for(const x of f.getFields()){ if(!(x instanceof PDFTextField)) continue; const a=x.acroField; keep.push([a,a.getDefaultAppearance()]); a.getWidgets().forEach(w=>keep.push([w,w.getDefaultAppearance()])); }
const {PDFName}=require(require('path').join(__dirname,'node_modules','pdf-lib'));
for(const x of f.getFields()) if(x instanceof PDFTextField) x.acroField.getWidgets().forEach(w=>{ if(w.dict!==x.acroField.dict) w.dict.delete(PDFName.of('V')); }); // stale per-box values
for(const x of f.getFields()){ if(x instanceof PDFTextField)x.setText(undefined); else if(x instanceof PDFCheckBox)x.uncheck(); else if(x instanceof PDFRadioGroup)x.clear(); }
f.updateFieldAppearances(await d.embedFont(StandardFonts.Helvetica));
// orphan text widgets (on the page but not in /Fields) keep their own /V, /DV and drawn text
const {PDFDict}=require(require('path').join(__dirname,'node_modules','pdf-lib'));let orphans=0;
for(const pg of d.getPages()) for(const r of (pg.node.Annots()?.asArray()||[])){ const a=d.context.lookup(r);
  if(!(a instanceof PDFDict)) continue; const ft=a.get(PDFName.of('FT'))||a.lookup(PDFName.of('Parent'))?.get?.(PDFName.of('FT'));
  if(String(ft)!=='/Tx'||!(a.has(PDFName.of('V'))||a.has(PDFName.of('DV')))) continue;
  a.delete(PDFName.of('V')); a.delete(PDFName.of('DV')); a.delete(PDFName.of('AP')); orphans++; }
console.log('orphan boxes cleared:',orphans);
let ticks=0; // checkboxes: any widget showing an "on" state goes to /Off, on the widget and its parent
for(const pg of d.getPages()) for(const r of (pg.node.Annots()?.asArray()||[])){ const a=d.context.lookup(r);
  if(!(a instanceof PDFDict)) continue; const par=a.lookup(PDFName.of('Parent')); const ft=String(a.get(PDFName.of('FT'))||(par instanceof PDFDict?par.get(PDFName.of('FT')):''));
  if(ft!=='/Btn') continue; const as=a.get(PDFName.of('AS')); if(as&&String(as)!=='/Off'){ a.set(PDFName.of('AS'),PDFName.of('Off')); ticks++; }
  for(const o of [a, par]) if(o instanceof PDFDict && o.has(PDFName.of('V'))){ o.set(PDFName.of('V'),PDFName.of('Off')); o.delete(PDFName.of('DV')); } }
console.log('ticks cleared:',ticks);
for(const [o,da] of keep) if(da) o.setDefaultAppearance(da);   // pdf-lib overwrites DA with computed sizes
d.setTitle('Blank form (flexible template)');fs.writeFileSync(process.argv[3],await d.save({updateFieldAppearances:false}));})();
