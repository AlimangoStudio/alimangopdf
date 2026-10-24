// Builds the sample form used in the README: a made-up "Job Report" with no real data.
// Usage (from the repo root, after `cd engine && npm ci`):
//   node samples/make-sample.cjs            -> samples/sample-form.pdf and samples/sample-filled.pdf
//   node engine/make-flexible.cjs "samples/sample-filled.pdf"   -> "samples/sample-filled - flexible.pdf"
const fs = require('fs');
const path = require('path');
const { PDFDocument, StandardFonts, rgb } = require(path.join(__dirname, '..', 'engine', 'node_modules', 'pdf-lib'));

const ROWS = 8;

async function build(filled) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const form = doc.getForm();
  const text = (s, x, y, f = font, size = 10) => page.drawText(s, { x, y, size, font: f, color: rgb(0.1, 0.1, 0.1) });
  const field = (name, x, y, w, h, value) => {
    const tf = form.createTextField(name);
    tf.addToPage(page, { x, y, width: w, height: h, font, borderColor: rgb(0.6, 0.6, 0.6), borderWidth: 0.5 });
    if (filled && value) tf.setText(value);
    return tf;
  };

  text('JOB REPORT (sample form)', 50, 740, bold, 16);
  text('Customer', 50, 700); field('Customer', 130, 694, 250, 18, 'Northwind Bakery');
  text('Date', 400, 700); field('Date', 440, 694, 120, 18, '2026-10-24');

  text('Summary of work', 50, 660, bold, 11);
  field('Summary', 50, 560, 510, 90,
    'Replaced the worn drive belt on the dough mixer, realigned both pulleys, and tested the mixer at all three speeds under ' +
    'full load for twenty minutes. Cleaned the motor housing and the cooling vents, tightened the guard bolts, and logged the ' +
    'serial numbers of the new parts. The customer was shown how to check belt tension each month and asked to call if the ' +
    'squeal comes back. Next visit: routine service in six months, or sooner if the oven door seal is replaced.');

  text('Work log', 50, 530, bold, 11);
  const log = [
    ['08:10', 'Arrived on site, met the shift lead and agreed on a two-hour window while the morning batch was cooling'],
    ['08:25', 'Isolated power, removed guard'],
    ['08:40', 'Belt cracked along its length; pulleys 2 mm out of line'],
    ['09:15', 'Fitted new belt, realigned pulleys'],
    ['09:45', 'Load test at speeds 1 to 3, no slip or noise'],
    ['10:05', 'Cleaned vents, refitted guard, restored power and walked the shift lead through the monthly tension check'],
  ];
  for (let i = 0; i < ROWS; i++) {
    const y = 506 - i * 22;
    field(`Time${i + 1}`, 50, y, 60, 18, log[i]?.[0]);
    field(`Log${i + 1}`, 115, y, 445, 18, log[i]?.[1]);
  }

  text('Parts used', 50, 310, bold, 11);
  field('Parts', 50, 250, 510, 50, 'Drive belt A-42 x1, guard bolts M6 x4, cable ties x6');
  text('Signed', 50, 220); field('Signed', 100, 214, 200, 18, 'J. Rivera');

  return doc.save();
}

(async () => {
  fs.writeFileSync(path.join(__dirname, 'sample-form.pdf'), await build(false));
  fs.writeFileSync(path.join(__dirname, 'sample-filled.pdf'), await build(true));
  console.log('wrote samples/sample-form.pdf and samples/sample-filled.pdf');
})();
