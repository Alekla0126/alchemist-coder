import { create } from 'zustand';
import type { Locale, VoiceEngineId } from '@shared/api';
import { tidySpeech } from './voice-tidy';

/**
 * The microphone: records what you say (one recording at a time, wherever you started it) and hands
 * a 16 kHz mono WAV to the main process, which turns it into text (main/voice.ts).
 */

export interface VoicePrefs {
  engine: 'auto' | VoiceEngineId;
  /** Whisper's model size (local engines). */
  model: string;
  /** 'app': the app's language; 'auto': the engine tells. */
  language: 'app' | 'auto';
  /** Take out the hesitations and stutters of speech before it's written in the box (voice-tidy.ts). */
  tidy: boolean;
}

const KEY = 'alchemist.voice';
export const VOICE_DEFAULTS: VoicePrefs = { engine: 'auto', model: 'base', language: 'app', tidy: true };
/** Long enough for any prompt; a 10-minute WAV still fits OpenAI's 25 MB. */
export const MAX_RECORDING_MS = 10 * 60_000;

export function loadVoicePrefs(): VoicePrefs {
  try {
    return { ...VOICE_DEFAULTS, ...(JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<VoicePrefs>) };
  } catch {
    return VOICE_DEFAULTS;
  }
}

export function saveVoicePrefs(prefs: VoicePrefs): void {
  localStorage.setItem(KEY, JSON.stringify(prefs));
}

/** The speech's language for the engine: the app's own ("pt-BR" → "pt"), or null to let it tell. */
export function speechLanguage(prefs: VoicePrefs, locale: Locale): string | null {
  return prefs.language === 'auto' ? null : locale.split('-')[0]!.toLowerCase();
}

/** 16-bit PCM WAV, mono. */
export function encodeWav(samples: Float32Array, rate = 16_000): Uint8Array {
  const out = new DataView(new ArrayBuffer(44 + samples.length * 2));
  const text = (at: number, s: string) => [...s].forEach((c, i) => out.setUint8(at + i, c.charCodeAt(0)));
  text(0, 'RIFF');
  out.setUint32(4, 36 + samples.length * 2, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  out.setUint32(16, 16, true);
  out.setUint16(20, 1, true);
  out.setUint16(22, 1, true);
  out.setUint32(24, rate, true);
  out.setUint32(28, rate * 2, true);
  out.setUint16(32, 2, true);
  out.setUint16(34, 16, true);
  text(36, 'data');
  out.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]!));
    out.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
  }
  return new Uint8Array(out.buffer);
}

/** Records the microphone; stop() gives the WAV. */
class Recorder {
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private buf = new Float32Array(1024);

  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    this.chunks = [];
    this.recorder = new MediaRecorder(this.stream);
    this.recorder.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
    this.recorder.start(250);
    this.ctx = new AudioContext();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.ctx.createMediaStreamSource(this.stream).connect(this.analyser);
  }

  /** How loud it is now, 0 to 1 (for the dot that moves while you speak). */
  level(): number {
    if (!this.analyser) return 0;
    this.analyser.getFloatTimeDomainData(this.buf);
    let sum = 0;
    for (const v of this.buf) sum += v * v;
    return Math.min(1, Math.sqrt(sum / this.buf.length) * 6);
  }

  async stop(): Promise<Uint8Array> {
    const recorder = this.recorder;
    if (!recorder) throw new Error('empty');
    const done = new Promise<void>((resolve) => (recorder.onstop = () => resolve()));
    recorder.stop();
    await done;
    const type = recorder.mimeType || 'audio/webm';
    const blob = new Blob(this.chunks, { type });
    this.release();
    if (blob.size < 200) throw new Error('empty');
    // Whatever the browser recorded (Opus), resampled to what every engine reads.
    const decoder = new AudioContext();
    try {
      const audio = await decoder.decodeAudioData(await blob.arrayBuffer());
      const offline = new OfflineAudioContext(1, Math.max(1, Math.ceil(audio.duration * 16_000)), 16_000);
      const source = offline.createBufferSource();
      source.buffer = audio;
      source.connect(offline.destination);
      source.start();
      return encodeWav((await offline.startRendering()).getChannelData(0));
    } finally {
      void decoder.close();
    }
  }

  release(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.ctx?.close().catch(() => {});
    this.stream = null;
    this.recorder = null;
    this.ctx = null;
    this.analyser = null;
  }
}

export type VoicePhase = 'idle' | 'starting' | 'recording' | 'transcribing';

interface VoiceState {
  phase: VoicePhase;
  /** The input that started it (one recording at a time, wherever it was started). */
  owner: string | null;
  startedAt: number;
}

export const useVoice = create<VoiceState>(() => ({ phase: 'idle', owner: null, startedAt: 0 }));

let recorder: Recorder | null = null;
let autoStop: ReturnType<typeof setTimeout> | null = null;

/** Starts recording for `owner`; refused microphone → an Error('micDenied'). */
export async function startRecording(owner: string, onAutoStop: () => void): Promise<void> {
  if (useVoice.getState().phase !== 'idle') return;
  useVoice.setState({ phase: 'starting', owner });
  try {
    if (!(await window.alchemist.voiceMicrophone())) throw new Error('micDenied');
    recorder = new Recorder();
    await recorder.start();
    useVoice.setState({ phase: 'recording', startedAt: Date.now() });
    autoStop = setTimeout(onAutoStop, MAX_RECORDING_MS);
  } catch (e) {
    recorder?.release();
    recorder = null;
    useVoice.setState({ phase: 'idle', owner: null });
    throw e instanceof Error && /Permission|NotAllowed/i.test(e.name + e.message) ? new Error('micDenied') : e;
  }
}

export function recordingLevel(): number {
  return recorder?.level() ?? 0;
}

/** What a recording became: its text, and how many words tidying took out (0 when it's off). */
export interface Spoken {
  text: string;
  removed: number;
  words: number;
}

/**
 * Stops and transcribes; the text (trimmed, tidied if you want it) or an Error with the reason's key.
 * `hint`: words the speech likely has (your agents' and projects' names), so they're spelled right.
 */
export async function finishRecording(prefs: VoicePrefs, locale: Locale, hint = ''): Promise<Spoken> {
  if (autoStop) clearTimeout(autoStop);
  const rec = recorder;
  recorder = null;
  if (!rec) return { text: '', removed: 0, words: 0 };
  useVoice.setState({ phase: 'transcribing' });
  try {
    const wav = await rec.stop();
    const language = speechLanguage(prefs, locale);
    const { text } = await window.alchemist.transcribe(wav, { engine: prefs.engine, model: prefs.model, language, hint });
    if (!prefs.tidy) return { text: text.trim(), removed: 0, words: 0 };
    return tidySpeech(text, language ?? locale);
  } finally {
    useVoice.setState({ phase: 'idle', owner: null });
  }
}

/** What you said, after what's already written (a space between, the cursor at the end). */
export const appendSpoken = (current: string, text: string) => (current.trim() ? `${current.replace(/\s+$/, '')} ${text}` : text);

export function cancelRecording(): void {
  if (autoStop) clearTimeout(autoStop);
  recorder?.release();
  recorder = null;
  useVoice.setState({ phase: 'idle', owner: null });
}
