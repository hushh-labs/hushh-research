/**
 * One safe path segment for an upstream (backend) URL.
 *
 * Next decodes dynamic route params, so `..%2F..%2Fdebug` arrives as
 * `../../debug`; interpolated into a URL it would walk out of the intended
 * route once WHATWG URL parsing normalises the dots. Anything that could
 * change the path's shape is refused instead of escaped, and the caller
 * answers 400 before any fetch.
 */
const MAX_SEGMENT_LENGTH = 128;
// Separators, query/fragment markers, escapes, and C0/DEL/C1 control characters.
const UNSAFE_SEGMENT = /[/\\?#%\u0000-\u001f\u007f-\u009f]/;

export function safePathSegment(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (value.length === 0 || value.length > MAX_SEGMENT_LENGTH) return null;
  if (value === "." || value === "..") return null;
  if (UNSAFE_SEGMENT.test(value)) return null;
  return encodeURIComponent(value);
}
