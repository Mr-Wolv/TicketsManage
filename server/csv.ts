export type CsvValue = string | number | null | undefined;

const FORMULA_PREFIX = /^[=+\-@\t\r]/;

/**
 * Spreadsheet formula protection is intentionally separate from CSV
 * serialization. It applies only to text cells; numeric scores are untouched.
 */
export function protectSpreadsheetFormula(value: string): string {
  if (FORMULA_PREFIX.test(value)) return `'${value}`;
  return value;
}

export function csvEscape(value: CsvValue, protectFormula = true): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '';
    return String(value);
  }
  let text = protectFormula ? protectSpreadsheetFormula(value) : value;
  // RFC 4180 quoting: wrap when the cell contains a comma, quote, CR or LF.
  if (/[",\r\n]/.test(text)) {
    text = `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

export function toCsv(
  headers: string[],
  rows: CsvValue[][],
  options: { protectFormulas?: boolean; bom?: boolean } = {},
): string {
  const protect = options.protectFormulas !== false;
  const lines = [headers.map((header) => csvEscape(header, protect)).join(',')];
  for (const row of rows) {
    lines.push(row.map((value) => csvEscape(value, protect)).join(','));
  }
  const body = lines.join('\r\n') + '\r\n';
  return (options.bom === false ? '' : '\uFEFF') + body;
}
