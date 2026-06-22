/**
 * Normalize an Israeli WhatsApp number to a canonical E.164-like string
 * without the leading '+', e.g. "972501234567".
 *
 * Accepted input formats:
 *   05xxxxxxxx   (local 10-digit)
 *   5xxxxxxxxx   (local without leading 0)
 *   +9725xxxxxxxx
 *   9725xxxxxxxx
 *   972-50-123-4567  (dashes/spaces)
 */
export function normalizeIsraeliPhone(raw: string): string | null {
  // Strip all non-digit characters
  const digits = raw.replace(/\D/g, '');

  // Already in international format: 972 + 9 or 10 digits
  if (/^972\d{9}$/.test(digits)) return digits;

  // Local 10-digit starting with 0: 05xxxxxxxx → 9725xxxxxxxx
  if (/^0\d{9}$/.test(digits)) return '972' + digits.slice(1);

  // Local 9-digit without leading 0: 5xxxxxxxxx → 9725xxxxxxxxx
  if (/^\d{9}$/.test(digits)) return '972' + digits;

  return null; // unrecognizable format
}
