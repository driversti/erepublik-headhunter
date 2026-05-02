/**
 * Escapes the three characters Telegram's HTML parse mode treats as syntax:
 * `&`, `<`, `>`. Quotes and apostrophes don't need escaping in this mode.
 *
 * Order matters: `&` must be replaced first; otherwise replacing `<` first
 * would re-escape the ampersand inside the resulting `&lt;`.
 */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
