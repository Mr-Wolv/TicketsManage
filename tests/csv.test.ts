import { describe, expect, it } from 'vitest';
import { csvEscape, protectSpreadsheetFormula, toCsv } from '../server/csv.js';

describe('CSV serialization', () => {
  it('quotes commas, quotes, CR and LF per RFC 4180', () => {
    expect(csvEscape('plain')).toBe('plain');
    expect(csvEscape('a,b')).toBe('"a,b"');
    expect(csvEscape('say "hi"')).toBe('"say ""hi"""');
    expect(csvEscape('line1\nline2')).toBe('"line1\nline2"');
    expect(csvEscape('line1\r\nline2')).toBe('"line1\r\nline2"');
  });

  it('renders numbers without formula protection', () => {
    expect(csvEscape(2)).toBe('2');
    expect(csvEscape(2.5)).toBe('2.5');
    expect(csvEscape(0)).toBe('0');
    expect(csvEscape(-3)).toBe('-3');
    expect(csvEscape(Number.NaN)).toBe('');
  });

  it('represents missing values as empty cells, not zeros', () => {
    expect(csvEscape(null)).toBe('');
    expect(csvEscape(undefined)).toBe('');
  });

  it('neutralises spreadsheet formulas in text cells', () => {
    expect(protectSpreadsheetFormula('=SUM(A1:A2)')).toBe("'=SUM(A1:A2)");
    expect(protectSpreadsheetFormula('+1')).toBe("'+1");
    expect(protectSpreadsheetFormula('-2')).toBe("'-2");
    expect(protectSpreadsheetFormula('@cmd')).toBe("'@cmd");
    expect(csvEscape('=HYPERLINK("http://evil")')).toBe('"\'=HYPERLINK(""http://evil"")"');
  });

  it('builds a CRLF table with a BOM and a header row', () => {
    const csv = toCsv(['ticket', 'staff'], [['100', 'Amina'], ['101', 'Omar, Jr']]);
    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(csv).toBe('\uFEFFticket,staff\r\n100,Amina\r\n101,"Omar, Jr"\r\n');
  });

  it('can suppress the BOM when requested', () => {
    expect(toCsv(['a'], [['b']], { bom: false })).toBe('a\r\nb\r\n');
  });
});
