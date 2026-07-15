/**
 * VOICE-8 — single source of the "גלי" robot artwork.
 *
 * ONE place holds the robot image as a base64 data URI. The voice page centers
 * it, the PWA manifest uses it as the app icon, and the browser tab uses it as
 * the favicon — all from `ROBOT_DATA_URI`. To rebrand, replace ONLY this file
 * (run `npm run voice:icon -- <path-to-png>` to regenerate it from an image).
 *
 * Until a real image is embedded, ROBOT_DATA_URI is null and the callers fall
 * back to a friendly emoji placeholder (the page still works, the PWA still
 * installs — just with a generated icon instead of the branded one).
 */

/**
 * base64 PNG data URI of the גלי robot, or null when not yet embedded.
 * Replace with:  export const ROBOT_DATA_URI = 'data:image/png;base64,....';
 */
export const ROBOT_DATA_URI: string | null = null;

/** True once a real branded image has been embedded. */
export function hasRobotImage(): boolean {
  return typeof ROBOT_DATA_URI === 'string' && ROBOT_DATA_URI.startsWith('data:image/');
}
