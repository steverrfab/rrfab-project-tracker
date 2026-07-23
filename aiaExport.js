'use strict';

/*
 * aiaExport.js
 * ------------
 * Builds Steve's AIA G702/G703 pay application as an .xlsx.
 *
 * The workbook is built from scratch with ExcelJS and every figure is written
 * as a STATIC, pre-computed value (no live formulas, no template round-trip).
 * That is deliberate: a pay app that gets emailed to a GC should open cleanly
 * in any copy of Excel with zero "we found a problem / repaired" prompts, and
 * an earlier template-based version tripped Excel's repair on both worksheets.
 * Whoever receives the file can Save As PDF.
 *
 * Two sheets:
 *   - 'AIA-G702' : the cover / application-for-payment page (lines 1-9).
 *   - 'AIA-G703' : the continuation sheet, one row per schedule-of-values line.
 *
 * All AIA math is done here in JS so the sheet and the tracker agree:
 *   line total (G) = scheduled * %/100 + stored
 *   this period (E) = G - fromPrevious
 *   balance   (I)   = scheduled - G
 *   retainage (J)   = G * retainagePct/100   (per line, so a 0% line holds none)
 * and the cover foots from those:
 *   completed (4) = sum(G);  retainage (5) = sum(J)
 *   earned less retainage (6) = 4 - 5
 *   current payment due (8) = 6 - previousCertificates
 *   balance to finish incl. retainage (9) = contract sum to date - 6
 */

const fs = require('fs');
const path = require('path');

const ExcelJS = require('exceljs');

const MONEY = '#,##0.00';
const PCT = '0.0%';
const num = v => { const n = Number(v); return isNaN(n) ? 0 : n; };
const r2 = n => Math.round(n * 100) / 100;

// Dates come in as 'YYYY-MM-DD' (or an ISO datetime / Date). Print them the way
// a US GC expects to read them on the pay app: MM/DD/YYYY. Anything we can't
// parse is passed through untouched so we never blank out a real value.
function fmtDate(v) {
  if (!v) return '';
  const s = (v instanceof Date) ? v.toISOString().slice(0, 10)
          : (typeof v === 'string' ? v.slice(0, 10) : String(v));
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  return m ? `${m[2]}/${m[3]}/${m[1]}` : String(v);
}

function money(cell) { cell.numFmt = MONEY; cell.alignment = { horizontal: 'right' }; }
function thinBox(cell) {
  cell.border = {
    top: { style: 'thin', color: { argb: 'FF999999' } },
    left: { style: 'thin', color: { argb: 'FF999999' } },
    bottom: { style: 'thin', color: { argb: 'FF999999' } },
    right: { style: 'thin', color: { argb: 'FF999999' } },
  };
}

function buildG702(ws, cover, totals) {
  ws.views = [{ showGridLines: false }];
  ws.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 };

  ws.getCell('A1').value = 'APPLICATION AND CERTIFICATE FOR PAYMENT';
  ws.getCell('A1').font = { bold: true, size: 14 };
  ws.getCell('A2').value = 'AIA Document G702 - style';
  ws.getCell('A2').font = { italic: true, size: 9, color: { argb: 'FF666666' } };

  const label = (addr, text) => { const c = ws.getCell(addr); c.value = text; c.font = { bold: true, size: 9 }; };
  label('A3', 'TO OWNER / GC:');
  ws.getCell('B3').value = cover.ownerGc || '';
  label('A5', 'PROJECT:');
  ws.getCell('E3').value = cover.project || '';
  ws.getCell('E3').font = { bold: true };
  label('A7', 'FROM CONTRACTOR:');
  ws.getCell('B7').value = cover.contractor || '';

  const rlabel = (addr, text) => { const c = ws.getCell(addr); c.value = text; c.font = { bold: true, size: 9 }; c.alignment = { horizontal: 'right' }; };
  rlabel('J3', 'APPLICATION NO:'); ws.getCell('K3').value = cover.appNo != null ? cover.appNo : '';
  rlabel('J4', 'APPLICATION DATE:'); ws.getCell('K4').value = fmtDate(cover.invoiceDate);
  rlabel('J5', 'PERIOD TO:'); ws.getCell('K5').value = fmtDate(cover.periodTo);
  rlabel('J8', 'PROJECT NO:'); ws.getCell('K8').value = cover.projectNo || '';
  rlabel('J10', 'CONTRACT DATE:'); ws.getCell('K10').value = fmtDate(cover.contractDate);

  // Final application banner (retainage-release app, or one flagged Final).
  if (cover.finalApp) {
    const fc = ws.getCell('A12'); fc.value = 'FINAL APPLICATION';
    fc.font = { bold: true, size: 12, color: { argb: 'FFB00020' } };
  }

  const line = (row, text, bold) => { const c = ws.getCell('A' + row); c.value = text; c.font = { bold: !!bold, size: 10 }; };
  const dollar = (addr, val, bold) => { const c = ws.getCell(addr); c.value = r2(val); money(c); if (bold) c.font = { bold: true }; };

  const contractSum = num(cover.originalContractSum);
  const netCO = num(cover.netChangeByCO);
  const contractToDate = contractSum + netCO;
  const prevCert = num(cover.previousCertificates);
  const earnedLessRet = totals.completed - totals.retainage;
  const due = earnedLessRet - prevCert;
  const balance = contractToDate - earnedLessRet;

  line(14, '1. ORIGINAL CONTRACT SUM'); dollar('N14', contractSum);
  line(15, '2. Net change by Change Orders'); dollar('N15', netCO);
  line(16, '3. CONTRACT SUM TO DATE (Line 1 +/- 2)', true); dollar('N16', contractToDate, true);
  line(17, '4. TOTAL COMPLETED & STORED TO DATE', true); dollar('N17', totals.completed, true);
  line(19, '5. RETAINAGE:', true);
  ws.getCell('B20').value = 'a.'; ws.getCell('C20').value = 'of Completed Work';
  ws.getCell('H20').value = num(cover.stdRetPct); ws.getCell('H20').numFmt = '0.0"%"'; ws.getCell('H20').alignment = { horizontal: 'right' };
  ws.getCell('B22').value = 'b.'; ws.getCell('C22').value = 'of Stored Material';
  ws.getCell('H22').value = num(cover.storedRetPct); ws.getCell('H22').numFmt = '0.0"%"'; ws.getCell('H22').alignment = { horizontal: 'right' };
  line(23, 'Total Retainage (Line 5a + 5b)'); dollar('N23', totals.retainage);
  line(24, '6. TOTAL EARNED LESS RETAINAGE (Line 4 - 5)', true); dollar('N24', earnedLessRet, true);
  line(27, '7. LESS PREVIOUS CERTIFICATES FOR PAYMENT'); dollar('N27', prevCert);
  line(28, '8. CURRENT PAYMENT DUE', true); dollar('N28', due, true);
  line(29, '9. BALANCE TO FINISH, INCLUDING RETAINAGE (Line 3 - 6)'); dollar('N29', balance);

  ws.getColumn(1).width = 34; ws.getColumn(2).width = 4; ws.getColumn(3).width = 18;
  ws.getColumn(8).width = 8; ws.getColumn(10).width = 18; ws.getColumn(11).width = 16; ws.getColumn(14).width = 16;
}

function buildG703(ws, lineRows, totals) {
  ws.views = [{ showGridLines: false }];
  ws.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 };

  ws.getCell('A1').value = 'CONTINUATION SHEET';
  ws.getCell('A1').font = { bold: true, size: 14 };
  ws.getCell('A2').value = 'AIA Document G703 - style   (Schedule of Values)';
  ws.getCell('A2').font = { italic: true, size: 9, color: { argb: 'FF666666' } };

  const heads = {
    A: 'ITEM NO', B: 'DESCRIPTION OF WORK', C: 'SCHEDULED VALUE', D: 'FROM PREVIOUS APPLICATION',
    E: 'THIS PERIOD', F: 'MATERIALS STORED', G: 'TOTAL COMPLETED & STORED TO DATE', H: '% (G/C)',
    I: 'BALANCE TO FINISH', J: 'RETAINAGE',
  };
  Object.keys(heads).forEach(col => {
    const c = ws.getCell(col + '15'); c.value = heads[col];
    c.font = { bold: true, size: 8 };
    c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEDEFF2' } };
    thinBox(c);
  });
  ws.getRow(15).height = 30;

  lineRows.forEach((l, i) => {
    const r = 16 + i;
    ws.getCell('A' + r).value = l.itemNo || '';
    ws.getCell('B' + r).value = l.description || '';
    const setM = (col, v) => { const c = ws.getCell(col + r); c.value = r2(v); money(c); };
    setM('C', l.scheduled);
    setM('D', l.fromPrevious);
    setM('E', l.thisPeriod);
    setM('F', l.stored);
    setM('G', l.total);
    const h = ws.getCell('H' + r); h.value = l.pctFraction; h.numFmt = PCT; h.alignment = { horizontal: 'right' };
    setM('I', l.balance);
    setM('J', l.retainage);
    'ABCDEFGHIJ'.split('').forEach(col => thinBox(ws.getCell(col + r)));
  });

  const tr = 16 + lineRows.length;
  ws.getCell('B' + tr).value = 'GRAND TOTAL'; ws.getCell('B' + tr).font = { bold: true };
  const tot = (col, v) => { const c = ws.getCell(col + tr); c.value = r2(v); money(c); c.font = { bold: true }; c.border = { top: { style: 'medium', color: { argb: 'FF333333' } }, bottom: { style: 'medium', color: { argb: 'FF333333' } } }; };
  tot('C', totals.scheduled); tot('D', totals.fromPrevious); tot('E', totals.thisPeriod);
  tot('F', totals.stored); tot('G', totals.completed); tot('I', totals.balance); tot('J', totals.retainage);

  const widths = { A: 6, B: 34, C: 14, D: 15, E: 13, F: 12, G: 16, H: 8, I: 14, J: 13 };
  Object.keys(widths).forEach((col, idx) => { ws.getColumn(idx + 1).width = widths[col]; });
}

/**
 * Build the pay-app .xlsx. templatePath is accepted for backward compatibility
 * but is intentionally ignored (the workbook is built from scratch).
 *
 * @returns {Promise<{ xlsxPath: string, pdfPath: string|null, pdfError: string|null }>}
 */
async function buildPayAppFiles({ templatePath, outDir, baseName, cover, lines }) {
  const coverData = cover || {};
  const lineData = Array.isArray(lines) ? lines : [];

  // ---- Compute every line + the roll-up totals (all static) --------------
  const lineRows = lineData.map(line => {
    const scheduled = num(line.scheduledValue);
    const fromPrevious = num(line.fromPrevious);
    const stored = num(line.storedMaterials);
    const pct = num(line.percentComplete);
    const retPct = (line.retainagePct === null || line.retainagePct === undefined) ? 0 : num(line.retainagePct);
    const total = scheduled * pct / 100 + stored;
    return {
      itemNo: line.itemNo, description: line.description,
      scheduled, fromPrevious, stored,
      total,
      thisPeriod: total - fromPrevious,
      balance: scheduled - total,
      retainage: total * retPct / 100,
      pctFraction: scheduled > 0 ? total / scheduled : (pct / 100),
    };
  });
  const totals = lineRows.reduce((t, l) => {
    t.scheduled += l.scheduled; t.fromPrevious += l.fromPrevious; t.thisPeriod += l.thisPeriod;
    t.stored += l.stored; t.completed += l.total; t.balance += l.balance; t.retainage += l.retainage;
    return t;
  }, { scheduled: 0, fromPrevious: 0, thisPeriod: 0, stored: 0, completed: 0, balance: 0, retainage: 0 });

  // ---- Build the workbook from scratch -----------------------------------
  const wb = new ExcelJS.Workbook();
  wb.creator = 'R&R Project Tracker';
  const g702 = wb.addWorksheet('AIA-G702');
  const g703 = wb.addWorksheet('AIA-G703');
  buildG702(g702, coverData, totals);
  buildG703(g703, lineRows, totals);

  fs.mkdirSync(outDir, { recursive: true });
  const xlsxPath = path.join(outDir, `${baseName}.xlsx`);
  await wb.xlsx.writeFile(xlsxPath);

  // PDF is intentionally not produced (Excel-only); whoever downloads it can
  // Save As PDF. Returning the same shape keeps the caller unchanged.
  return { xlsxPath, pdfPath: null, pdfError: null };
}

module.exports = { buildPayAppFiles };
