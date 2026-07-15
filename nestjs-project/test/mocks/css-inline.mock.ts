/**
 * Mock for @css-inline/css-inline — native dependency that fails to load in Jest
 * This module is used internally by @nestjs-modules/mailer's HandlebarsAdapter
 * for inlining CSS in email templates.
 *
 * Jest cannot load native binaries, so we replace it with a pass-through mock
 * that returns the input HTML unchanged. In tests, we care about the email
 * being created/sent, not about CSS inlining specifics.
 */

/**
 * Pass-through inline function — returns HTML unchanged.
 * In production, @css-inline/css-inline inlines external CSS into the HTML.
 * In tests, this mock simply returns the HTML as-is.
 *
 * @param html The HTML string to inline CSS into
 * @param options Optional configuration (ignored in mock)
 * @returns The HTML string (unchanged)
 */
export function inline(html: string): string {
  return html;
}

// Export as default for compatibility with different import styles
export default {
  inline,
};
