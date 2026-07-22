# AIA G702/G703 export template

Place Steve's AIA G702/G703 workbook here as:

    templates/aia_g702_g703.xlsx

The pay-app export (`aiaExport.js`) opens this file and fills only the input
cells, leaving the workbook's own formulas to compute the totals, so the output
is byte-for-byte Steve's form.

Expected sheets: `AIA-G702` (cover) and `AIA-G703` (continuation).

Cells the app writes:
- G703 line rows start at **row 16** (item 1). Per line it writes
  A=item, B=description, C=scheduled value, D=from previous ($),
  F=stored materials ($), H=percent complete **as a fraction** (1.0 = 100%).
  It also writes E=`=G{r}-D{r}` on every filled row and J=`=G{r}*(retPct/100)`
  per line (the two fixes the stock template is missing). G and I are left to
  the template (`G=H*C`, `I=C-G`).
- G702 cover inputs: N14 contract sum, H20 std retainage %, H22 stored
  retainage %, N27 previous certificates, and headers E3/B3/B7/K3/K4/K5/K8/K10.

Until this file is committed, the "Generate G702/G703" button returns a clear
message asking for the template; everything else works without it.

PDF rendering uses LibreOffice (installed via `nixpacks.toml`). If LibreOffice
is unavailable the Excel is still produced and the PDF is skipped.
