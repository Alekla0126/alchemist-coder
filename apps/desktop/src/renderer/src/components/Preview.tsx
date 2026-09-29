import { useEffect, useRef, useState } from 'react';
import { useT } from '../store';
import { Markdown } from './Markdown';

export type PreviewKind = 'html' | 'markdown' | 'image';

const FIT_WIDTH = 1280;

const KINDS: Array<[RegExp, PreviewKind]> = [
  [/\.(html?|xhtml)$/i, 'html'],
  [/\.(md|markdown|mdx)$/i, 'markdown'],
  [/\.(svg|png|jpe?g|gif|webp|avif|ico|bmp)$/i, 'image'],
];

/** What the preview pane can show for a file, if anything. */
export function previewKind(path: string | null | undefined): PreviewKind | null {
  if (!path) return null;
  return KINDS.find(([re]) => re.test(path))?.[1] ?? null;
}

/**
 * Nimbalyst-style preview. HTML runs in a sandboxed iframe served by the app's preview protocol
 * (no network, no access to the app); Markdown renders with Mermaid diagrams; images and SVG as
 * images. `text` gives live content (e.g. the editor's unsaved buffer) for Markdown.
 */
export function Preview({ root, path, text, version = 0 }: { root: string | null; path: string; text?: string | null; version?: number }) {
  const t = useT();
  const kind = previewKind(path);
  const [url, setUrl] = useState<string | null>(null);
  const [fileText, setFileText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [blocked, setBlocked] = useState<string | null>(null);
  // Mockups are drawn for a desktop width: "fit" renders them at 1280px and scales them down.
  const [fit, setFit] = useState(() => /\.mockup\.html?$/i.test(path));
  const body = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = body.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => entry && setBox({ w: entry.contentRect.width, h: entry.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [kind]);
  const scale = fit && box.w ? Math.min(1, box.w / FIT_WIDTH) : 1;

  useEffect(() => (kind === 'html' ? window.alchemist.onPreviewBlocked((u) => setBlocked(u)) : undefined), [kind]);
  useEffect(() => setBlocked(null), [url]);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    if (kind === 'markdown') {
      if (text == null)
        void window.alchemist
          .readFile(path)
          .then((f) => !cancelled && setFileText(f.text ?? ''))
          .catch((e: unknown) => !cancelled && setError(String(e)));
      return;
    }
    if (kind)
      void window.alchemist
        .previewUrl(root, path)
        .then((u) => !cancelled && setUrl(`${u}?v=${version}-${reload}`))
        .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, [root, path, kind, version, reload, text == null]);

  if (!kind) return <div className="panel-empty">{t('preview.none')}</div>;
  return (
    <div className="preview">
      <div className="preview-bar">
        <span className="preview-kind">{t(`preview.${kind}`)}</span>
        <span className="preview-path" title={path}>
          {path.split(/[\\/]/).slice(-2).join('/')}
        </span>
        <span className="composer-sp" />
        {kind === 'html' && (
          <button className={`preview-fit ${fit ? 'on' : ''}`} onClick={() => setFit(!fit)} title={t('preview.fitHint')}>
            ⤢ {t('preview.fit')}
          </button>
        )}
        {kind === 'html' && <span className="preview-safe" title={t('preview.sandboxHint')}>🔒 {t('preview.sandbox')}</span>}
        <button className="icon-btn" onClick={() => setReload((r) => r + 1)} title={t('preview.reload')}>
          ↻
        </button>
      </div>
      {blocked && (
        <div className="preview-blocked">
          {t('preview.blocked', { url: blocked })}{' '}
          <button className="link" onClick={() => setReload((r) => r + 1)}>
            {t('preview.reload')}
          </button>
        </div>
      )}
      <div ref={body} className={`preview-body ${kind}${kind === 'html' && fit ? ' fit' : ''}`}>
        {error ? (
          <div className="live-error">{error}</div>
        ) : kind === 'markdown' ? (
          <div className="preview-md">
            <Markdown text={text ?? fileText ?? ''} />
          </div>
        ) : !url ? (
          <span className="spin" />
        ) : kind === 'html' ? (
          <iframe
            key={url}
            src={url}
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            title={path}
            style={fit ? { width: FIT_WIDTH, height: box.h / scale, transform: `scale(${scale})` } : undefined}
          />
        ) : (
          <img src={url} alt={path} />
        )}
      </div>
    </div>
  );
}
