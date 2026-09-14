/*
 * CSV, for handing a report to somebody who does not use Cobalt.
 *
 * Deliberately not a library: a correct CSV writer is a dozen lines, and the reports
 * that need one are exporting plain strings and numbers rather than anything exotic.
 */

/**
 * One value, quoted only when it has to be.
 *
 * Quoting everything would be simpler and is worse: a spreadsheet reads a quoted
 * number as text, so a column of hours arrives unsummable, which for a report whose
 * whole purpose is to be totalled by somebody else defeats the export.
 *
 * A leading `=`, `+`, `-` or `@` is prefixed with an apostrophe. Excel treats those as
 * the start of a formula, so a value beginning with one is executed rather than shown -
 * the injection that turns a note somebody typed into a ticket into a command on the
 * finance team's machine.
 */
function cell(value: string | number): string {
  const raw = typeof value === 'number' ? String(value) : (value ?? '')
  const guarded = /^[=+\-@]/.test(raw) ? `'${raw}` : raw
  return /[",\r\n]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded
}

/** Rows to CSV text. The first row is the header, like every other CSV. */
export function toCsv(rows: (string | number)[][]): string {
  // CRLF, because that is what Excel expects and what every other tool tolerates.
  return rows.map(r => r.map(cell).join(',')).join('\r\n')
}

/**
 * Hand the file to the browser.
 *
 * A BOM in front, because Excel on Windows reads a BOM-less UTF-8 CSV as the system
 * codepage and turns every accented client name into mojibake.
 */
export function downloadCsv(filename: string, rows: (string | number)[][]): void {
  const blob = new Blob(['﻿' + toCsv(rows)], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Revoked on the next turn of the loop: revoking synchronously races the download in
  // Safari, which has not finished reading the blob when click() returns.
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
