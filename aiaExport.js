'use strict';

/*
 * aiaExport.js
 * ------------
 * Fills Steve's AIA G702/G703 Excel workbook template and renders a PDF.
 *
 * The template is a 1981-form workbook with two sheets:
 *   - 'AIA-G702' : the cover / application-for-payment page. Its lines 3-9 are
 *                  computed by the template's own formulas, so we only write the
 *                  handful of raw input cells (contract sum, retainage %, header
 *                  info, etc.). See the G702 cell map below.
 *   - 'AIA-G703' : the continuation sheet. One row per schedule-of-values line,
 *                  starting at row 16 (row 16 = first item). For line index i,
 *                  r = 16 + i.
 *
 * We only write the raw input cells and let the template's own formulas do the
 * rest (e.g. G703 computes G = H*C and I = C-G; G702 computes its line totals).
 *
 * Two deliberate fixes to the stock template:
 *   1. Column E formula on EVERY filled row. The stock template only carries
 *      '=G-D' in E on row 16. We write '=G{r}-D{r}' on every filled row so the
 *      "this period" column is correct all the way down.
 *   2. Per-line retainage in column J. The stock template hard-codes a single
 *      retainage rate. We instead write '=G{r}*(retPct/100)' per line using that
 *      line's own retainagePct, so a 0% line holds no retainage.
 *
 * PDF is produced by converting the saved .xlsx with headless LibreOffice.
 * If LibreOffice is missing or fails, we swallow the error, return pdfPath=null
 * and a short pdfError, and still hand back the .xlsx.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const util = require('util');

const ExcelJS = require('exceljs');

const execFileAsync = util.promisify(execFile);

// Only set a cell when the value is actually provided; skip null/undefined so we
// don't blank out a cell the template may have defaulted.
function setIfPresent(ws, addr, value) {
  if (value === null || value === undefined) return;
  ws.getCell(addr).value = value;
}

function makeLandscapeFitWidth(ws) {
  if (!ws) return;
  ws.pageSetup = {
    ...(ws.pageSetup || {}),
    orientation: 'landscape',
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
  };
}

async function convertToPdf(xlsxPath, outDir, baseName) {
  const expectedPdf = path.join(outDir, `${baseName}.pdf`);

  // Unique per-call LibreOffice user profile dir to avoid concurrency clashes.
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lo-profile-'));
  const userInstallation = 'file://' + profileDir;

  const args = [
    '--headless',
    '--convert-to',
    'pdf:calc_pdf_Export',
    '--outdir',
    outDir,
    '-env:UserInstallation=' + userInstallation,
    xlsxPath,
  ];

  const binaries = ['libreoffice', 'soffice'];
  let lastErr = null;

  for (const bin of binaries) {
    try {
      await execFileAsync(bin, args, { timeout: 60000 });
      if (fs.existsSync(expectedPdf)) {
        return { pdfPath: expectedPdf, pdfError: null };
      }
      lastErr = new Error('PDF not produced by ' + bin);
      // Try next binary in case this one silently no-op'd.
    } catch (err) {
      lastErr = err;
      // If the binary simply isn't installed, try the next name; otherwise the
      // conversion itself failed and the alternate name likely won't help, but
      // trying it is cheap and harmless.
      if (err && err.code === 'ENOENT') {
        continue;
      }
      // Non-ENOENT failure: still fall through to try the other binary once.
      continue;
    }
  }

  const msg = lastErr ? (lastErr.message || String(lastErr)) : 'PDF conversion failed';
  return { pdfPath: null, pdfError: msg };
}

/**
 * Build the pay-app .xlsx (and, if possible, .pdf) from the AIA template.
 *
 * @returns {Promise<{ xlsxPath: string, pdfPath: string|null, pdfError: string|null }>}
 */
async function buildPayAppFiles({ templatePath, outDir, baseName, cover, lines }) {
  // TEMPLATE_MISSING is the only error we throw for the missing-template case;
  // the caller catches it specifically.
  if (!templatePath || !fs.existsSync(templatePath)) {
    throw new Error('TEMPLATE_MISSING');
  }

  const coverData = cover || {};
  const lineData = Array.isArray(lines) ? lines : [];

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(templatePath);

  const g703 = wb.getWorksheet('AIA-G703');
  const g702 = wb.getWorksheet('AIA-G702');

  // ---- G703 continuation sheet: one row per line, starting at row 16 -------
  if (g703) {
    for (let i = 0; i < lineData.length; i++) {
      const line = lineData[i] || {};
      const r = 16 + i;

      setIfPresent(g703, 'A' + r, line.itemNo);
      setIfPresent(g703, 'B' + r, line.description);
      setIfPresent(g703, 'C' + r, line.scheduledValue);
      setIfPresent(g703, 'D' + r, line.fromPrevious);
      setIfPresent(g703, 'F' + r, line.storedMaterials);

      // H = percent complete AS A FRACTION (100 -> 1.0, 50 -> 0.5).
      if (line.percentComplete !== null && line.percentComplete !== undefined) {
        g703.getCell('H' + r).value = line.percentComplete / 100;
      }

      // Fix 1: '=G-D' on EVERY filled row (template only has it on row 16).
      g703.getCell('E' + r).value = { formula: 'G' + r + '-D' + r };

      // Fix 2: per-line retainage in J using this line's own rate.
      const retPct =
        line.retainagePct === null || line.retainagePct === undefined
          ? 0
          : line.retainagePct;
      g703.getCell('J' + r).value = { formula: 'G' + r + '*(' + retPct + '/100)' };

      // G (=H*C) and I (=C-G) are left to the template's own formulas.
    }
  }

  // ---- G702 cover sheet: raw input cells only ------------------------------
  if (g702) {
    setIfPresent(g702, 'N14', coverData.originalContractSum);
    setIfPresent(g702, 'H20', coverData.stdRetPct);
    setIfPresent(g702, 'H22', coverData.storedRetPct);
    setIfPresent(g702, 'N27', coverData.previousCertificates);
    setIfPresent(g702, 'E3', coverData.project);
    setIfPresent(g702, 'B3', coverData.ownerGc);
    setIfPresent(g702, 'B7', coverData.contractor);
    setIfPresent(g702, 'K3', coverData.appNo);
    setIfPresent(g702, 'K4', coverData.invoiceDate);
    setIfPresent(g702, 'K5', coverData.periodTo);
    setIfPresent(g702, 'K8', coverData.projectNo);
    setIfPresent(g702, 'K10', coverData.contractDate);
  }

  // ---- Landscape + fit-to-width so the PDF matches his form ----------------
  makeLandscapeFitWidth(g702);
  makeLandscapeFitWidth(g703);

  // ---- Save the xlsx -------------------------------------------------------
  const xlsxPath = path.join(outDir, `${baseName}.xlsx`);
  await wb.xlsx.writeFile(xlsxPath);

  // ---- PDF via LibreOffice (failures swallowed into pdfError) --------------
  let pdfPath = null;
  let pdfError = null;
  try {
    const result = await convertToPdf(xlsxPath, outDir, baseName);
    pdfPath = result.pdfPath;
    pdfError = result.pdfError;
  } catch (err) {
    // Belt-and-suspenders: never let a LibreOffice problem propagate.
    pdfPath = null;
    pdfError = err && err.message ? err.message : String(err);
  }

  return { xlsxPath, pdfPath, pdfError };
}

module.exports = { buildPayAppFiles };
