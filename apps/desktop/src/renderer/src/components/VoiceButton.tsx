import { useEffect, useRef, useState } from 'react';
import type { VoiceEngineId, VoiceStatus } from '@shared/api';
import { Icon } from './Icon';
import { useStore, useT } from '../store';
import { toast } from '../ui';
import { cancelRecording, finishRecording, loadVoicePrefs, recordingLevel, startRecording, useVoice } from '../voice';

type T = ReturnType<typeof useT>;

let statusCache: Promise<VoiceStatus> | null = null;
/** Which engines work (asked once; Settings asks again after a change). */
export function voiceStatus(refresh = false): Promise<VoiceStatus> {
  if (refresh || !statusCache) statusCache = window.alchemist.voiceStatus(loadVoicePrefs().model).catch(() => ({ engines: [], auto: null, platform: '' }));
  return statusCache;
}

export const engineName = (t: T, id: 'auto' | VoiceEngineId) => t(`voice.engine.${id}` as never);

/** A failure in words: a refused microphone, nothing heard, no engine… */
function voiceError(t: T, e: unknown): string {
  const raw = (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  if (raw === 'micDenied' || raw === 'empty' || raw === 'tooLong' || raw === 'noEngine') return t(`voice.${raw}`);
  if (raw.startsWith('unavailable:')) return t('voice.unavailable', { engine: engineName(t, raw.slice(12) as VoiceEngineId) });
  return t('voice.failed', { error: raw.slice(0, 200) });
}

/**
 * The names your speech likely has, for the engine to spell them right: the organization, its
 * agents and the open projects (Whisper's "initial prompt"; it costs no tokens).
 */
export function speechHintOf(s: { orgSettings: { name?: string } | null; botConfigs: Array<{ name: string; proposed?: boolean }>; projects: Array<{ id: number; name: string }>; settings: { openProjectIds: number[] } }): string {
  const names = [s.orgSettings?.name ?? '', ...s.botConfigs.filter((c) => !c.proposed).map((c) => c.name), ...s.projects.filter((p) => s.settings.openProjectIds.includes(p.id)).map((p) => p.name)];
  return [...new Set(names.map((n) => n.trim()).filter((n) => n && n !== 'My organization'))].join(', ');
}

const clock = (ms: number) => `${Math.floor(ms / 60_000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;
const openVoiceSettings = () => useStore.setState({ settingsOpen: true, settingsSection: 'voice' });

/**
 * The microphone next to Send: click, speak, click again and what you said is written where you
 * type. While it records it says so in words, with the time and a dot that follows your voice
 * (Esc throws the recording away). macOS dictation types straight into the box instead.
 */
export function VoiceButton({ owner, onText, focus, compact }: { owner: string; onText: (text: string) => void; focus?: () => void; compact?: boolean }) {
  const t = useT();
  const locale = useStore((s) => s.locale);
  const phase = useVoice((v) => (v.owner === owner ? v.phase : 'idle'));
  const elsewhere = useVoice((v) => v.owner !== null && v.owner !== owner);
  const startedAt = useVoice((v) => v.startedAt);
  const [engine, setEngine] = useState<'auto' | VoiceEngineId>(() => loadVoicePrefs().engine);
  const [, tick] = useState(0);
  const dot = useRef<HTMLSpanElement>(null);

  // --voice=recording|transcribing (captures): its look in that state.
  const captureVoice = useStore((s) => s.info?.capture?.voice ?? null);
  useEffect(() => {
    if (captureVoice && owner.startsWith('composer:')) useVoice.setState({ phase: captureVoice, owner, startedAt: Date.now() - 7000 });
  }, [captureVoice, owner]);

  useEffect(() => {
    let alive = true;
    void voiceStatus().then((s) => {
      const prefs = loadVoicePrefs();
      if (alive) setEngine(prefs.engine === 'auto' ? (s.auto ?? 'auto') : prefs.engine);
    });
    return () => {
      alive = false;
    };
  }, []);

  const stop = async () => {
    try {
      const spoken = await finishRecording(loadVoicePrefs(), locale, speechHintOf(useStore.getState()));
      if (!spoken.text) return toast(t('voice.nothingHeard'));
      onText(spoken.text);
      // Tidying says what it took out, so you know it did (and what it saves the agent).
      if (spoken.removed > 0) toast(t('voice.tidied', { n: spoken.removed, pct: Math.round((spoken.removed / Math.max(1, spoken.words)) * 100) }), { label: t('settings.title'), run: openVoiceSettings }, 4000);
    } catch (e) {
      toast(voiceError(t, e), { label: t('settings.title'), run: openVoiceSettings });
    }
  };

  // While recording: the clock, the dot, and Esc to throw it away.
  useEffect(() => {
    if (phase !== 'recording') return;
    let raf = 0;
    let last = 0;
    const loop = (now: number) => {
      if (dot.current) dot.current.style.transform = `scale(${(1 + recordingLevel() * 0.8).toFixed(2)})`;
      if (now - last > 500) {
        last = now;
        tick((n) => n + 1);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      cancelRecording();
      toast(t('voice.cancelled'));
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [phase]);

  const start = async () => {
    const prefs = loadVoicePrefs();
    const status = await voiceStatus();
    const use = prefs.engine === 'auto' ? status.auto : prefs.engine;
    if (!use) return toast(t('voice.noEngine'), { label: t('settings.title'), run: openVoiceSettings }, 10_000);
    if (use === 'dictation') {
      // The system listens and types into the box you're in.
      focus?.();
      setTimeout(() => window.alchemist.voiceDictate(), 80);
      return;
    }
    try {
      await startRecording(owner, () => void stop());
    } catch (e) {
      toast(voiceError(t, e), { label: t('settings.title'), run: openVoiceSettings });
    }
  };

  if (phase === 'recording' || phase === 'starting') {
    return (
      <span className="voice-live">
        <button className="voice-btn recording" onClick={() => void stop()} title={t('voice.stopTip')} aria-label={t('voice.stopTip')}>
          <span className="rec-dot" ref={dot} aria-hidden />
          <span className="voice-label">{phase === 'starting' ? t('voice.starting') : t('voice.recording', { time: clock(Date.now() - startedAt) })}</span>
          <Icon name="check" size={13} />
        </button>
        <button className="voice-cancel icon-btn" onClick={() => cancelRecording()} title={t('voice.cancel')} aria-label={t('voice.cancel')}>
          <Icon name="close" size={12} />
        </button>
      </span>
    );
  }
  if (phase === 'transcribing') {
    return (
      <span className="voice-btn transcribing" role="status">
        <span className="spin" aria-hidden />
        <span className="voice-label">{t('voice.transcribing')}</span>
      </span>
    );
  }
  const tip = `${t('voice.start')} · ${engineName(t, engine)}`;
  return (
    <button className={`voice-btn ${compact ? 'compact' : ''}`} onClick={() => void start()} disabled={elsewhere} title={elsewhere ? t('voice.busyElsewhere') : tip} aria-label={tip}>
      <Icon name="mic" size={15} />
    </button>
  );
}
