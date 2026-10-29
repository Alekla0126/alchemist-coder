import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { translate } from '../src/renderer/src/i18n';
import { SignInsOffer } from '../src/renderer/src/components/BrowserPane';

vi.mock('../src/renderer/src/store', () => ({
  useStore: () => null,
  sessionTitle: () => '',
  useT: () => (key: never, vars?: Record<string, string | number>) => translate('es', key, vars),
}));

describe('the offer of sign-ins from other projects', () => {
  it('lets you bring one site at a time, or all, or none', () => {
    const sites = ['google.com', 'apple.com', ...Array.from({ length: 9 }, (_, i) => `site${i}.com`)];
    const html = renderToStaticMarkup(<SignInsOffer sites={sites} earlier={false} />);
    expect(html).toContain('Ya iniciaste sesión en estos sitios en otros proyectos');
    expect(html).toContain('title="Traer solo la sesión de google.com"');
    expect(html).toContain('>apple.com</button>');
    // eight names, then how many more
    expect(html.match(/class="bsi-site"/g)).toHaveLength(8);
    expect(html).toContain('+3');
    expect(html).toContain('Traer todas');
    expect(html).toContain('No, gracias');
  });

  it('keeps the earlier offer as it was: the sites in the sentence, all at once', () => {
    const html = renderToStaticMarkup(<SignInsOffer sites={['google.com', 'reddit.com']} earlier />);
    expect(html).toContain('(google.com, reddit.com)');
    expect(html).not.toContain('bsi-site');
    expect(html).toContain('Traerlos');
  });
});
