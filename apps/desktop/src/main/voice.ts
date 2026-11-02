import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { Menu, systemPreferences } from 'electron';
import type { SecretStore } from '@alchemist-coder/core';
import { VOICE_ENGINES, WHISPER_MODELS, type VoiceEngineId, type VoiceRequest, type VoiceStatus } from '../shared/api';

/**
 * Speech to text for the composer's microphone. The recording (16 kHz mono WAV, made in the window)
 * is turned into text by the first engine that works, local ones first: whisper.cpp, OpenAI's
 * Whisper (the Python CLI), an OpenAI API key you saved for Codex, and, on macOS, the system's own
 * dictation as the last resort. Audio never leaves the computer unless the engine is OpenAI's API.
 */

/** OpenAI's audio endpoint refuses bigger files. */
const MAX_BYTES = 25 * 1024 * 1024;
const OPENAI_KEY = 'openai.apiKey';
/** About 80 words: enough for the names of an organization, its agents and its projects. */
const HINT_MAX = 400;

function onPath(bin: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    for (const name of process.platform === 'win32' ? [`${bin}.exe`, `${bin}.cmd`] : [bin]) {
      const p = dir && join(dir, name);
      if (p && statSync(p, { throwIfNoEntry: false })?.isFile()) return p;
    }
  }
  return null;
}

/** Where whisper.cpp's ggml models usually live (Homebrew doesn't ship one: you download it). */
export function ggmlDirs(home: string, userData: string): string[] {
  return [join(userData, 'whisper'), join(home, '.cache', 'whisper.cpp'), join(home, '.cache', 'whisper'), join(home, 'whisper.cpp', 'models'), '/opt/homebrew/share/whisper-cpp', '/opt/homebrew/share/whisper-cpp/models', '/usr/local/share/whisper-cpp', '/usr/share/whisper-cpp'];
}

/** The ggml model to use: the size you picked if it's there, else the best one found. */
export function pickGgml(files: string[], want: string): string | null {
  const models = files.filter((f) => /(^|\/)ggml-[\w.-]+\.bin$/.test(f));
  const named = (size: string) => models.find((f) => new RegExp(`ggml-${size.replace('.', '\\.')}(\\.|-|$)`).test(f.split('/').pop()!));
  return (want === 'turbo' ? named('large-v3-turbo') : undefined) ?? named(want) ?? ['large-v3-turbo', 'turbo', 'small', 'base', 'medium', 'tiny', 'large'].map(named).find(Boolean) ?? models[0] ?? null;
}

async function findGgml(want: string, userData: string): Promise<string | null> {
  if (process.env.WHISPER_CPP_MODEL && existsSync(process.env.WHISPER_CPP_MODEL)) return process.env.WHISPER_CPP_MODEL;
  const found: string[] = [];
  for (const dir of ggmlDirs(homedir(), userData)) {
    const names = await readdir(dir).catch(() => [] as string[]);
    for (const n of names) if (n.endsWith('.bin')) found.push(join(dir, n));
  }
  return pickGgml(found, want);
}

const run = (file: string, args: string[], timeout: number) =>
  new Promise<string>((resolve, reject) =>
    execFile(file, args, { timeout, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      if (error) reject(new Error((stderr || error.message).trim().split('\n').slice(-3).join(' ').slice(0, 400)));
      else resolve(stdout);
    }),
  );

/** whisper.cpp prints each segment on a line; with -nt there are no timestamps. */
export function cleanTranscript(text: string): string {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^\[(BLANK_AUDIO|MUSIC|NOISE|SILENCE)\]$/i.test(l) && !/^\((music|silence|noise)\)$/i.test(l))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The words to expect, as the engines take them: one short line (Whisper reads only its last 224
 * tokens) that ends like a sentence. A list left open makes Whisper take the recording for its
 * continuation and drop its start (measured: half of a 9-second phrase gone).
 */
export function speechHint(hint: string | null | undefined): string | null {
  const one = String(hint ?? '')
    .replace(/[\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, HINT_MAX - 1)
    .replace(/[\s,;:]+$/, '');
  return one ? (/[.!?]$/.test(one) ? one : `${one}.`) : null;
}

export class Voice {
  constructor(
    private readonly secrets: SecretStore,
    private readonly userData: string,
  ) {}

  private async hasOpenAiKey(): Promise<boolean> {
    return !!process.env.OPENAI_API_KEY || (await this.secrets.has(OPENAI_KEY));
  }

  async status(model: string): Promise<VoiceStatus> {
    const cpp = onPath('whisper-cli') ?? onPath('whisper-cpp');
    const ggml = cpp ? await findGgml(model, this.userData) : null;
    const py = onPath('whisper');
    const ffmpeg = onPath('ffmpeg');
    const key = await this.hasOpenAiKey();
    const engines: VoiceStatus['engines'] = [
      { id: 'whisper-cpp', available: !!cpp && !!ggml, detail: !cpp ? 'missing' : ggml ? ggml.split(/[\\/]/).pop()! : 'noModel' },
      { id: 'whisper', available: !!py && !!ffmpeg, detail: !py ? 'missing' : ffmpeg ? '' : 'noFfmpeg' },
      { id: 'openai', available: key, detail: key ? '' : 'noKey' },
      { id: 'dictation', available: process.platform === 'darwin', detail: process.platform === 'darwin' ? '' : 'macOnly' },
    ];
    return { engines, auto: engines.find((e) => e.available)?.id ?? null, platform: process.platform };
  }

  /** Asks the system for the microphone (macOS shows its prompt once); false when it's refused. */
  async microphone(): Promise<boolean> {
    if (process.platform !== 'darwin') return true;
    if (systemPreferences.getMediaAccessStatus('microphone') === 'granted') return true;
    return systemPreferences.askForMediaAccess('microphone').catch(() => false);
  }

  /** macOS dictation in the focused text field: the system listens and types, on the computer. */
  dictate(): void {
    if (process.platform === 'darwin') Menu.sendActionToFirstResponder('startDictation:');
  }

  async transcribe(audio: Uint8Array, request: VoiceRequest): Promise<{ text: string; engine: VoiceEngineId }> {
    if (!(audio instanceof Uint8Array) || audio.byteLength < 1000) throw new Error('empty');
    if (audio.byteLength > MAX_BYTES) throw new Error('tooLong');
    const model = WHISPER_MODELS.includes(request.model as never) ? request.model : 'base';
    const language = /^[a-z]{2}$/.test(request.language ?? '') ? request.language! : null;
    const hint = speechHint(request.hint);
    const status = await this.status(model);
    const engine = request.engine === 'auto' ? status.auto : VOICE_ENGINES.includes(request.engine as never) ? (request.engine as VoiceEngineId) : null;
    if (!engine || engine === 'dictation') throw new Error('noEngine');
    if (!status.engines.find((e) => e.id === engine)?.available) throw new Error(`unavailable:${engine}`);
    const dir = await mkdtemp(join(tmpdir(), 'ac-voice-'));
    try {
      const wav = join(dir, 'voice.wav');
      await writeFile(wav, audio);
      const text = engine === 'whisper-cpp' ? await this.whisperCpp(wav, model, language, hint) : engine === 'whisper' ? await this.whisperPython(wav, dir, model, language, hint) : await this.openai(audio, language, hint);
      return { text: cleanTranscript(text), engine };
    } finally {
      void rm(dir, { recursive: true, force: true });
    }
  }

  private async whisperCpp(wav: string, model: string, language: string | null, hint: string | null): Promise<string> {
    const bin = onPath('whisper-cli') ?? onPath('whisper-cpp')!;
    const ggml = (await findGgml(model, this.userData))!;
    return run(bin, ['-m', ggml, '-f', wav, '-l', language ?? 'auto', '-nt', '-np', ...(hint ? ['--prompt', hint] : [])], 180_000);
  }

  private async whisperPython(wav: string, dir: string, model: string, language: string | null, hint: string | null): Promise<string> {
    // The first use of a model downloads it (to ~/.cache/whisper), which can take a minute.
    const args = [wav, '--model', model, '--output_format', 'txt', '--output_dir', dir, '--fp16', 'False', '--verbose', 'False', ...(language ? ['--language', language] : []), ...(hint ? ['--initial_prompt', hint] : [])];
    await run(onPath('whisper')!, args, 10 * 60_000);
    return readFile(join(dir, 'voice.txt'), 'utf8');
  }

  private async openai(audio: Uint8Array, language: string | null, hint: string | null): Promise<string> {
    const key = (await this.secrets.get(OPENAI_KEY)) ?? process.env.OPENAI_API_KEY;
    if (!key) throw new Error('unavailable:openai');
    const send = async (model: string) => {
      const form = new FormData();
      form.append('file', new Blob([audio as Uint8Array<ArrayBuffer>], { type: 'audio/wav' }), 'voice.wav');
      form.append('model', model);
      if (language) form.append('language', language);
      if (hint) form.append('prompt', hint);
      return fetch('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form, signal: AbortSignal.timeout(120_000) });
    };
    let res = await send('gpt-4o-mini-transcribe');
    // An account or region without the newer model still has Whisper.
    if (res.status === 404 || res.status === 400) res = await send('whisper-1');
    if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return String(((await res.json()) as { text?: unknown }).text ?? '');
  }
}
