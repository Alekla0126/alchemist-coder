import { describe, expect, it } from 'vitest';
import { clickScript, focusScript, formatSnapshot, keyScript, locateScript, normalizeUrl, SNAPSHOT_SCRIPT } from '../src/main/browser-page';

describe('the address bar', () => {
  it('takes web addresses, bare domains and local servers', () => {
    expect(normalizeUrl('https://example.com/a?b=1')).toBe('https://example.com/a?b=1');
    expect(normalizeUrl('  example.com ')).toBe('https://example.com/');
    expect(normalizeUrl('docs.python.org/3/library')).toBe('https://docs.python.org/3/library');
    expect(normalizeUrl('localhost:5173')).toBe('http://localhost:5173/');
    expect(normalizeUrl('127.0.0.1:8080/health')).toBe('http://127.0.0.1:8080/health');
    expect(normalizeUrl('about:blank')).toBe('about:blank');
  });

  it('searches for anything else', () => {
    expect(normalizeUrl('mejor taquería en puebla')).toBe('https://duckduckgo.com/?q=mejor%20taquer%C3%ADa%20en%20puebla');
    expect(normalizeUrl('react')).toBe('https://duckduckgo.com/?q=react');
  });

  it('never loads files, scripts or other schemes', () => {
    for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,<b>x</b>', 'chrome://settings', 'vscode://x']) {
      expect(normalizeUrl(bad)).toBeNull();
    }
    expect(normalizeUrl('   ')).toBeNull();
  });
});

describe('what an agent reads', () => {
  it('lists what it can act on by number, then the text', () => {
    const text = formatSnapshot({
      url: 'https://shop.example/cart',
      title: 'Cart',
      text: 'Your cart\nTotal: $20',
      elements: [
        { ref: 1, tag: 'a', role: null, name: 'Home', href: 'https://shop.example/', type: null },
        { ref: 2, tag: 'input', role: null, name: 'Coupon', href: null, type: 'text' },
        { ref: 3, tag: 'button', role: null, name: 'Pay now', href: null, type: null },
        { ref: 4, tag: 'div', role: 'tab', name: 'Details', href: null, type: null },
      ],
    });
    expect(text).toContain('URL: https://shop.example/cart');
    expect(text).toContain('[1] link "Home" → https://shop.example/');
    expect(text).toContain('[2] input:text "Coupon"');
    expect(text).toContain('[3] button "Pay now"');
    expect(text).toContain('[4] tab "Details"');
    expect(text.endsWith('Your cart\nTotal: $20')).toBe(true);
  });

  it('says when there is nothing to act on', () => {
    expect(formatSnapshot({ url: 'about:blank', title: '', text: '', elements: [] })).toContain('Nothing to click or type into on screen.');
  });
});

describe('the scripts that run in the page', () => {
  it('are valid JavaScript', () => {
    for (const code of [SNAPSHOT_SCRIPT, locateScript(3), focusScript(3, true), focusScript(3, false), clickScript(3), keyScript('Enter'), keyScript('Space')]) {
      expect(() => new Function(`return ${code}`)).not.toThrow();
    }
  });

  it('only ever put a whole number into the page', () => {
    const sneaky = '1"]; alert(1); ["' as unknown as number;
    expect(locateScript(sneaky)).not.toContain('alert');
    expect(locateScript(2.7)).toContain('data-ac-ref="2"');
    expect(focusScript(sneaky, true)).not.toContain('alert');
    expect(clickScript(sneaky)).not.toContain('alert');
  });
});
