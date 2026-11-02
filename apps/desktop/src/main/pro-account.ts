import { randomBytes } from 'node:crypto';
import type { ProActivation } from '../shared/api';

export interface AccountModule {
  accountUrl?(): string | null;
  deviceId?(host: { userData: string }): string;
  activate?(host: { userData: string }, code: string): Promise<ProActivation>;
}

/** A browser login never gives this app a Firebase credential. Only a signed, device-bound license returns. */
export class ProAccountFlow {
  private pending: { state: string; until: number } | null = null;
  private accepting = false;
  constructor(private readonly pro: AccountModule | null, private readonly userData: string, private readonly now = Date.now) {}

  start(): string | null {
    if (!this.pro?.activate || !this.pro.deviceId || !this.pro.accountUrl) return null;
    const device = this.pro.deviceId({ userData: this.userData });
    if (!/^[\w-]{16,64}$/.test(device)) return null;
    let url: URL;
    try { url = new URL(this.pro.accountUrl() ?? ''); } catch { return null; }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !/\/(?:account)\/$/.test(url.pathname)) return null;
    const state = randomBytes(32).toString('hex');
    this.pending = { state, until: this.now() + 30 * 60_000 };
    url.searchParams.set('device', device);
    url.searchParams.set('state', state);
    return url.href;
  }

  /** Ignores unsolicited, expired and replayed callbacks, without logging the license or URL. */
  async accept(raw: string): Promise<ProActivation | null> {
    if (!this.pending || this.accepting || this.pending.until < this.now() || raw.length > 12_000) return null;
    let url: URL;
    try { url = new URL(raw); } catch { return null; }
    const fragment = new URLSearchParams(url.hash.slice(1));
    if (url.protocol !== 'alchemistcoder:' || url.host !== 'auth' || url.pathname !== '/pro' || url.username || url.password ||
      url.searchParams.getAll('state').length !== 1 || url.searchParams.get('state') !== this.pending.state ||
      [...url.searchParams.keys()].some((k) => k !== 'state') || [...fragment.keys()].some((k) => k !== 'license') || fragment.getAll('license').length !== 1) return null;
    const token = fragment.get('license') ?? '';
    if (token.length > 8192 || !/^[\w-]+\.[\w-]+\.[\w-]+$/.test(token)) return null;
    this.accepting = true;
    try {
      const result = await this.pro!.activate!({ userData: this.userData }, token);
      if (result.ok) this.pending = null;
      return result;
    } catch { return { ok: false, reason: 'other' }; }
    finally { this.accepting = false; }
  }
}
