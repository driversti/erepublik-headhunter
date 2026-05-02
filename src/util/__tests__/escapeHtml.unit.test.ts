import { describe, expect, it } from 'vitest';
import { escapeHtml } from '../escapeHtml.js';

describe('escapeHtml', () => {
  it('escapes the three Telegram-mode dangerous characters', () => {
    expect(escapeHtml('a & b < c > d')).toBe('a &amp; b &lt; c &gt; d');
  });

  it('does not escape quotes or apostrophes (Telegram HTML mode does not require them)', () => {
    expect(escapeHtml(`"quoted" 'value'`)).toBe(`"quoted" 'value'`);
  });

  it('handles an empty string', () => {
    expect(escapeHtml('')).toBe('');
  });

  it('handles a string with no special characters', () => {
    expect(escapeHtml('hello world')).toBe('hello world');
  });

  it('escapes & before < and > so a literal &lt; survives intact', () => {
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
  });

  it('escapes a realistic XSS payload to a safe literal', () => {
    expect(escapeHtml('<script>alert("x")</script>')).toBe(
      '&lt;script&gt;alert("x")&lt;/script&gt;',
    );
  });
});
