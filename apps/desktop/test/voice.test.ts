import { describe, expect, it } from 'vitest';
import { encodeWav, speechLanguage, VOICE_DEFAULTS } from '../src/renderer/src/voice';
import { cleanTranscript, pickGgml, speechHint } from '../src/main/voice';
import { tidySpeech } from '../src/renderer/src/voice-tidy';

describe('the recording sent to the engines', () => {
  it('is a 16 kHz mono 16-bit WAV', () => {
    const wav = encodeWav(new Float32Array([0, 1, -1, 0.5, 2]));
    const view = new DataView(wav.buffer);
    const text = (at: number, n: number) => String.fromCharCode(...wav.slice(at, at + n));
    expect([text(0, 4), text(8, 4), text(12, 4), text(36, 4)]).toEqual(['RIFF', 'WAVE', 'fmt ', 'data']);
    expect([view.getUint16(22, true), view.getUint32(24, true), view.getUint16(34, true)]).toEqual([1, 16_000, 16]);
    expect(view.getUint32(40, true)).toBe(10);
    // Clipped to the range, full scale both ways.
    expect([0, 1, 2, 3, 4].map((i) => view.getInt16(44 + i * 2, true))).toEqual([0, 32767, -32768, 16383, 32767]);
  });

  it('says the language you speak: the app’s by default, or lets the engine tell', () => {
    expect(speechLanguage(VOICE_DEFAULTS, 'pt-BR')).toBe('pt');
    expect(speechLanguage(VOICE_DEFAULTS, 'es')).toBe('es');
    expect(speechLanguage({ ...VOICE_DEFAULTS, language: 'auto' }, 'es')).toBeNull();
  });
});

describe('the local engines', () => {
  it('uses the whisper.cpp model size you picked, else the best one there', () => {
    const files = ['/m/ggml-base.bin', '/m/ggml-small.bin', '/m/ggml-large-v3-turbo.bin', '/m/notes.txt'];
    expect(pickGgml(files, 'small')).toBe('/m/ggml-small.bin');
    expect(pickGgml(files, 'turbo')).toBe('/m/ggml-large-v3-turbo.bin');
    expect(pickGgml(files, 'medium')).toBe('/m/ggml-large-v3-turbo.bin');
    expect(pickGgml(['/m/ggml-base.en.bin'], 'base')).toBe('/m/ggml-base.en.bin');
    expect(pickGgml(['/m/notes.txt'], 'base')).toBeNull();
  });

  it('keeps only what was said', () => {
    expect(cleanTranscript(' Hola, quiero un botón\n [BLANK_AUDIO]\n para grabar voz. \n')).toBe('Hola, quiero un botón para grabar voz.');
    expect(cleanTranscript('[MUSIC]\n')).toBe('');
  });
});

describe('optimizing what you dictated', () => {
  it('takes out hesitations and stutters, not words said on purpose', () => {
    const r = tidySpeech('Eh, quiero que que el botón, em, grabe la voz. No no, muy muy rápido.', 'es');
    expect(r.text).toBe('Quiero que el botón, grabe la voz. No no, muy muy rápido.');
    expect(r.removed).toBe(3);
    expect(tidySpeech('Um, so the the map shows, uh, tokens.', 'en').text).toBe('So the map shows, tokens.');
    // What Whisper wrote for a real recording (macOS voice, Whisper base): its hum is "M,".
    expect(tidySpeech('Quiero que el coordinador revise Soccer24 y Komodo hoy, M, y que el mapa muestre los tokens.', 'es').text).toBe('Quiero que el coordinador revise Soccer24 y Komodo hoy, y que el mapa muestre los tokens.');
  });

  it('never takes a word of another language for a hesitation', () => {
    // "um" is Portuguese for "a", "em" for "in".
    expect(tidySpeech('Quero um botão em cada conversa.', 'pt').text).toBe('Quero um botão em cada conversa.');
    expect(tidySpeech('Hum, quero um mapa.', 'pt').text).toBe('Quero um mapa.');
  });

  it('drops the lines Whisper makes up over silence, only at the end', () => {
    expect(tidySpeech('Renueva la plantilla. Subtítulos realizados por la comunidad de Amara.org', 'es').text).toBe('Renueva la plantilla.');
    expect(tidySpeech('Thanks for watching!', 'en').text).toBe('');
    expect(tidySpeech('Gracias por ver el mapa, ahora sigue.', 'es').text).toBe('Gracias por ver el mapa, ahora sigue.');
  });

  it('tells the engine the names to expect in one short line', () => {
    expect(speechHint(' The Alchemist Code,\n Soccer24 ,  Komodo, ')).toBe('The Alchemist Code, Soccer24 , Komodo.');
    expect(speechHint('Komodo?')).toBe('Komodo?');
    expect(speechHint('')).toBeNull();
    expect(speechHint('x'.repeat(1000))!.length).toBe(400);
  });
});
