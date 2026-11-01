import { useEffect, useRef, useState } from 'react';
import type { BotTeam } from '@shared/api';
import { relativeTime } from '../format';
import { exchangesOf, teamState, YOU, type Exchange } from '../org-model';
import { openAssignment } from '../actions/org';
import { useStore, useT } from '../store';
import { isDemo } from '../org-office';
import { toast } from '../ui';
import { appendSpoken } from '../voice';
import { errorText } from './Bots';
import { VoiceButton } from './VoiceButton';

type T = ReturnType<typeof useT>;

/** The latest lines of the conversation: enough to follow it, the whole one is in the assignment. */
const LINES = 8;
/** A long answer shows its start; the rest is one click away. */
const CLIP = 600;

interface Line {
  key: string;
  at: number;
  mine: boolean;
  who: string;
  text: string;
}

/** What an exchange without words says: an approved plan. */
function textOf(x: Exchange, t: T): string {
  if (x.kind === 'approved') return t('org.chat.approved', { n: x.n ?? 0 });
  return x.text.replace(/\s+\n/g, '\n').trim();
}

/**
 * The conversation with the organization, on its home: what you asked an assignment and what it
 * answered you (its questions, its plan, its result), the newest last, with a box to answer its
 * coordinator. It reads the assignment's own log, so showing it costs no tokens.
 */
export function OrgChat({ team }: { team: BotTeam | undefined }) {
  const t = useT();
  const locale = useStore((s) => s.locale);
  const messageBot = useStore((s) => s.messageBot);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const log = useRef<HTMLDivElement>(null);
  const lead = team?.bots[0];
  const lines: Line[] = !team
    ? []
    : [
        { key: 'goal', at: team.createdAt, mine: true, who: t('bots.you'), text: team.goal },
        ...exchangesOf(team)
          .filter((x) => x.from === YOU || x.to === YOU)
          .map((x) => ({ key: x.key, at: x.at, mine: x.from === YOU, who: x.from === YOU ? t('bots.you') : (team.bots.find((b) => b.id === x.from)?.name ?? '?'), text: textOf(x, t) }))
          .filter((l) => l.text),
      ].slice(-LINES);
  const last = lines[lines.length - 1]?.key;
  // The newest line shows by scrolling the conversation's own box, never the page you're looking at.
  useEffect(() => {
    const el = log.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [last]);
  if (!team || !lead) return null;
  const planPending = team.plan?.status === 'pending';
  const state = teamState(team);
  const send = async () => {
    const v = text.trim();
    if (!v || busy) return;
    if (isDemo(team.id)) return void toast(t('org.office.demoNoSend'), undefined, 3000);
    setBusy(true);
    try {
      await messageBot(team.id, lead.id, v);
      setText('');
    } catch (e) {
      toast(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="org-chat" aria-label={t('org.chat.title')}>
      <header className="org-chat-head">
        <h3>{t('org.chat.title')}</h3>
        <span className={`team-state ts-${state}`}>{t(`bots.team.${state}`)}</span>
        <b className="org-chat-goal" title={team.goal}>
          {team.title || team.goal}
        </b>
        <span className="composer-sp" />
        <button className="link small" onClick={() => openAssignment(team)}>
          {t('org.chat.open')} →
        </button>
      </header>
      <div className="org-chat-lines" role="log" aria-live="polite" ref={log}>
        {lines.map((l) => (
          <div key={l.key} className={`org-chat-line ${l.mine ? 'mine' : ''}`}>
            <small>
              {l.who} · {relativeTime(l.at, locale)}
            </small>
            <p>{l.text.length > CLIP ? `${l.text.slice(0, CLIP).trimEnd()}…` : l.text}</p>
          </div>
        ))}
      </div>
      <div className="composer-box org-chat-box">
        <textarea
          ref={box}
          rows={1}
          value={text}
          disabled={planPending}
          placeholder={planPending ? t('bots.answerPlanFirst') : t('bots.messagePlaceholder', { name: lead.name })}
          aria-label={t('bots.messagePlaceholder', { name: lead.name })}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <div className="composer-bar">
          <span className="composer-note">{t('org.chat.hint')}</span>
          <span className="composer-sp" />
          <VoiceButton
            owner={`org-chat:${team.id}`}
            onText={(spoken) => {
              setText((v) => appendSpoken(v, spoken));
              requestAnimationFrame(() => box.current?.focus());
            }}
            focus={() => box.current?.focus()}
          />
          <button className="btn-send" disabled={planPending || busy || !text.trim()} onClick={() => void send()}>
            {busy ? <span className="spin" /> : null} {t('run.send')} ↵
          </button>
        </div>
      </div>
    </section>
  );
}
