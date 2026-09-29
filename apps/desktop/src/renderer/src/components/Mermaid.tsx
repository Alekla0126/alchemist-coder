import { useEffect, useState } from 'react';

let ready: Promise<typeof import('mermaid').default> | null = null;
let counter = 0;

function load() {
  ready ??= import('mermaid').then(({ default: mermaid }) => {
    // strict: labels are sanitized and click handlers disabled; SVG labels so it renders as an image.
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', htmlLabels: false, theme: 'dark', fontFamily: 'ui-sans-serif, system-ui, sans-serif' });
    return mermaid;
  });
  return ready;
}

/** Renders a Mermaid diagram as an <img>, so nothing in it can run or touch the page. */
export default function Mermaid({ code }: { code: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void load()
      .then((mermaid) => mermaid.render(`mmd-${++counter}`, code))
      .then(({ svg }) => !cancelled && setSrc(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`))
      .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, [code]);
  if (error)
    return (
      <pre className="mermaid-error" title={error}>
        {code}
      </pre>
    );
  return src ? <img className="mermaid" src={src} alt="diagram" /> : <div className="mermaid-loading">…</div>;
}
