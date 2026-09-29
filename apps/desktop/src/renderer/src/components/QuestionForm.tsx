import { useEffect, useState } from 'react';
import type { QuestionAnswer } from '@alchemist-coder/core';
import { answerSummary, type LiveQuestion } from '../live-turns';
import { useStore, useT } from '../store';

type Value = string | string[] | boolean;

const empty = (v: Value | undefined) => v == null || v === '' || (Array.isArray(v) && !v.length);

/** The questions themselves, without their "Other" boxes. */
export const mainFields = (q: LiveQuestion) => {
  const keys = new Set(q.fields.map((f) => f.key));
  return q.fields.filter((f) => !(f.forKey && keys.has(f.forKey)));
};

// Claude's adapter titles every multi-question form the same way; that says nothing.
const GENERIC = /^please answer the following questions\.?$/i;

/** What the card is about: the agent's message, unless it's the generic one. */
export function questionHeading(q: LiveQuestion): string {
  const m = q.message.trim();
  if (m && !GENERIC.test(m)) return m;
  const main = mainFields(q);
  return main.length === 1 ? main[0]!.description || main[0]!.title : '';
}

/** Open cards, oldest first: the keyboard answers the newest. */
const openCards: string[] = [];

/** The agent's question as a form you fill in: options (one or several), your own answer, then send or skip. */
export function QuestionForm({ runId, request, shortcuts = true }: { runId: string; request: LiveQuestion; shortcuts?: boolean }) {
  const t = useT();
  const answer = useStore((s) => s.answerQuestion);
  const [values, setValues] = useState<Record<string, Value>>({});
  const [sent, setSent] = useState(false);
  const keys = new Set(request.fields.map((f) => f.key));
  const extras = new Map(request.fields.filter((f) => f.forKey && keys.has(f.forKey)).map((f) => [f.forKey!, f]));
  const main = mainFields(request);
  // Number keys pick the options of the first question that has them.
  const keyed = shortcuts ? main.find((f) => f.kind === 'single' || f.kind === 'multi') : undefined;
  const set = (key: string, v: Value) => setValues((s) => ({ ...s, [key]: v }));
  const missing = main.some((f) => f.required && empty(values[f.key]) && empty(values[extras.get(f.key)?.key ?? '']));
  const nothing = request.fields.every((f) => empty(values[f.key]));
  const content = () => {
    const out: NonNullable<QuestionAnswer['content']> = {};
    for (const f of request.fields) {
      const v = values[f.key];
      if (empty(v)) continue;
      if (f.kind === 'number') {
        const n = Number(v);
        if (Number.isFinite(n)) out[f.key] = n;
      } else out[f.key] = typeof v === 'string' ? v.trim() : v!;
    }
    return out;
  };
  const send = () => {
    if (sent || missing || nothing) return;
    setSent(true);
    const c = content();
    void answer(runId, request.requestId, { action: 'accept', content: c }, answerSummary(request.fields, c));
  };
  const skip = () => {
    if (sent) return;
    setSent(true);
    void answer(runId, request.requestId, { action: 'decline' }, '');
  };
  const onEnter = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };
  const pick = (f: typeof main[number], value: string) => {
    const v = values[f.key];
    if (f.kind === 'single') set(f.key, v === value ? '' : value);
    else {
      const list = Array.isArray(v) ? v : [];
      set(f.key, list.includes(value) ? list.filter((x) => x !== value) : [...list, value]);
    }
  };
  // Keyboard: 1–9 pick an option (outside text boxes), ⌘↵ sends.
  useEffect(() => {
    if (!shortcuts) return;
    openCards.push(request.requestId);
    const onKey = (e: KeyboardEvent) => {
      if (sent || openCards.at(-1) !== request.requestId) return;
      const el = document.activeElement as HTMLInputElement | null;
      const typing = !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable) && el.type !== 'radio' && el.type !== 'checkbox';
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        if (typing && !el!.closest('.q-card')) return;
        e.preventDefault();
        send();
        return;
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey || !keyed) return;
      const n = Number(e.key);
      const option = Number.isInteger(n) && n >= 1 ? keyed.options[n - 1] : undefined;
      if (!option) return;
      e.preventDefault();
      pick(keyed, option.value);
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      openCards.splice(openCards.indexOf(request.requestId), 1);
    };
  });
  const heading = questionHeading(request);
  return (
    <div className="perm-card q-card" role="group" aria-label={heading || t('ask.badge')}>
      <div className="q-head">
        <span className="perm-badge">{main.length > 1 ? t('ask.nQuestions', { n: main.length }) : t('ask.badge')}</span>
        {heading && <b>{heading}</b>}
      </div>
      {main.map((f) => {
        const extra = extras.get(f.key);
        const v = values[f.key];
        return (
          <fieldset key={f.key} className="q-field" disabled={sent}>
            {((f.title && f.kind !== 'boolean') || (f.description && f.description !== heading)) && (
              <legend className="ask-top">
                {f.title && f.title !== heading && f.kind !== 'boolean' && <span className="ask-h">{f.title}</span>}
                {f.description && f.description !== heading && <span className="q-desc">{f.description}</span>}
              </legend>
            )}
            {(f.kind === 'single' || f.kind === 'multi') && (
              <div className="q-opts" role={f.kind === 'single' ? 'radiogroup' : 'group'}>
                {f.options.map((o, oi) => {
                  const on = f.kind === 'single' ? v === o.value : Array.isArray(v) && v.includes(o.value);
                  return (
                    <label key={o.value} className={`q-opt ${on ? 'on' : ''}`}>
                      <input
                        type={f.kind === 'single' ? 'radio' : 'checkbox'}
                        name={`${request.requestId}:${f.key}`}
                        checked={on}
                        onChange={() => pick(f, o.value)}
                        onClick={() => {
                          // A second click on the picked option clears it.
                          if (f.kind === 'single' && on) set(f.key, '');
                        }}
                      />
                      <span>
                        <b>{o.title}</b>
                        {o.description && <small>{o.description}</small>}
                      </span>
                      {f === keyed && oi < 9 && <kbd className="perm-key q-key">{oi + 1}</kbd>}
                    </label>
                  );
                })}
              </div>
            )}
            {f.kind === 'text' && (
              <input className="q-text" value={String(v ?? '')} onChange={(e) => set(f.key, e.target.value)} onKeyDown={onEnter} placeholder={f.description || f.title} maxLength={4000} />
            )}
            {f.kind === 'number' && <input className="q-text q-num" type="number" value={String(v ?? '')} onChange={(e) => set(f.key, e.target.value)} onKeyDown={onEnter} />}
            {f.kind === 'boolean' && (
              <label className="q-opt q-bool">
                <input type="checkbox" checked={v === true} onChange={(e) => set(f.key, e.target.checked)} />
                <span>{f.title || t('ask.yes')}</span>
              </label>
            )}
            {extra && (
              <input
                className="q-text"
                value={String(values[extra.key] ?? '')}
                onChange={(e) => set(extra.key, e.target.value)}
                onKeyDown={onEnter}
                placeholder={t(f.kind === 'multi' ? 'ask.otherMulti' : 'ask.other')}
                aria-label={t(f.kind === 'multi' ? 'ask.otherMulti' : 'ask.other')}
                maxLength={4000}
              />
            )}
          </fieldset>
        );
      })}
      <div className="perm-actions">
        <button className="perm-btn allow_once" disabled={sent || missing || nothing} onClick={send} title={nothing ? t('ask.pickFirst') : undefined}>
          {t('ask.send')} {shortcuts && <kbd className="q-send-key">⌘↵</kbd>}
        </button>
        <button className="perm-btn" disabled={sent} onClick={skip} title={t('ask.skipTitle')}>
          {t('ask.skip')}
        </button>
      </div>
    </div>
  );
}
