import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { WebContentsView, type BrowserWindow, type Rectangle } from 'electron';
import type { SessionMcpServer } from '@alchemist-coder/core';
import type { BrowserState } from '../shared/api';
import { clickScript, focusScript, formatSnapshot, KEYS, keyScript, locateScript, normalizeUrl, SNAPSHOT_SCRIPT, type Key, type PageSnapshot } from './browser-page';

export type { BrowserState };

export const SERVER_NAME = 'alchemist_browser';
const PARTITION = 'persist:alchemist-browser';
/** Its own isolated world: a page's scripts never see ours. */
const WORLD = 1919;
const DRIVING_MS = 6000;

const TOOLS = [
  {
    name: 'browser_open',
    description:
      "Opens a web address (or searches for words) in Alchemist Coder's built-in browser, which the user can watch next to the conversation. Then read the page with browser_read.",
    inputSchema: { type: 'object', properties: { url: { type: 'string', description: 'A web address, a domain, or words to search for' } }, required: ['url'] },
  },
  {
    name: 'browser_read',
    description:
      'Reads the page in the built-in browser: its address, its visible text, and everything you can click or type into, each with a number to use with browser_click and browser_type. Read again after the page changes; numbers change with it.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'browser_click',
    description: 'Clicks the element with this number (from browser_read). Before buying, paying, deleting something or sending a form with personal data, ask the user first.',
    inputSchema: { type: 'object', properties: { ref: { type: 'number' } }, required: ['ref'] },
  },
  {
    name: 'browser_type',
    description: 'Types text into the field with this number (from browser_read), replacing what it had; with submit, presses Enter after. Never type passwords or payment details: ask the user to do it.',
    inputSchema: { type: 'object', properties: { ref: { type: 'number' }, text: { type: 'string' }, submit: { type: 'boolean' } }, required: ['ref', 'text'] },
  },
  {
    name: 'browser_press',
    description: `Presses a key in the page: ${KEYS.join(', ')}.`,
    inputSchema: { type: 'object', properties: { key: { type: 'string', enum: [...KEYS] } }, required: ['key'] },
  },
  {
    name: 'browser_scroll',
    description: 'Scrolls the page up or down by about one screen.',
    inputSchema: { type: 'object', properties: { direction: { type: 'string', enum: ['up', 'down'] } }, required: ['direction'] },
  },
  { name: 'browser_back', description: 'Goes back to the previous page.', inputSchema: { type: 'object', properties: {} } },
  { name: 'browser_screenshot', description: 'A picture of what the browser shows right now (for layouts, images and anything the text misses).', inputSchema: { type: 'object', properties: {} } },
] as const;

type Reply = { text?: string; content?: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>; isError?: boolean };

/**
 * The browser inside the app: one page view that sits exactly over the pane the renderer lays out
 * (it never opens windows of its own, and links that would open one load in place), its own
 * cookies (`persist:alchemist-browser`, apart from the app's), and the tools agents use to drive it
 * through `browser-bridge.ts`. You watch everything live and can take it over at any time.
 */
export class BrowserHost {
  private view: WebContentsView | null = null;
  private bounds: Rectangle | null = null;
  private attachedTo: BrowserWindow | null = null;
  private server: Server | null = null;
  private port = 0;
  /** Each run's token: which agent it is ("Claude Code") and, once started, which run. */
  private readonly tokens = new Map<string, { label: string; runId: string | null }>();
  private driver: { label: string; runId: string | null; at: number } | null = null;
  private userControl = false;
  private driverTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly window: () => BrowserWindow | null,
    private readonly bridge: { command: string; script: string },
    private readonly onState: (state: BrowserState) => void,
  ) {}

  /** The local endpoint the bridges call (random port, loopback only). */
  async start(): Promise<void> {
    if (this.server) return;
    this.server = createServer((req, res) => void this.onRequest(req, res));
    this.server.requestTimeout = 0;
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    const addr = this.server.address();
    this.port = typeof addr === 'object' && addr ? addr.port : 0;
  }

  stop(): void {
    this.server?.close();
    this.server = null;
    this.view?.webContents.close();
    this.view = null;
  }

  /** The browser tools for one run of an agent (`label` names it in the pane: "Claude Code"). */
  mcpServer(label: string): SessionMcpServer | null {
    if (!this.port) return null;
    const token = randomBytes(24).toString('hex');
    this.tokens.set(token, { label, runId: null });
    return {
      name: SERVER_NAME,
      command: this.bridge.command,
      args: [this.bridge.script],
      env: { ELECTRON_RUN_AS_NODE: '1', AC_BROWSER_URL: `http://127.0.0.1:${this.port}`, AC_BROWSER_TOKEN: token },
      trusted: true,
    };
  }

  /** Ties a run's browser tools to the run once it has started, so the pane can name its conversation. */
  bindRun(server: SessionMcpServer, runId: string): void {
    const who = this.tokens.get(server.env?.AC_BROWSER_TOKEN ?? '');
    if (who) who.runId = runId;
  }

  /** What the pane shows right now, with where it is in the window (captures), or null when it's closed. */
  async snapshot(): Promise<{ image: Electron.NativeImage; bounds: Rectangle } | null> {
    if (!this.view || !this.bounds || !this.attachedTo) return null;
    // A view just put on screen may not have painted yet: a few tries.
    for (let attempt = 0; ; attempt++) {
      try {
        return { image: await this.view.webContents.capturePage(), bounds: this.bounds };
      } catch (error) {
        if (attempt >= 8) throw error;
        await new Promise((r) => setTimeout(r, 400));
      }
    }
  }

  state(): BrowserState {
    const wc = this.view?.webContents;
    const driving = !!this.driver && Date.now() - this.driver.at < DRIVING_MS;
    return {
      url: wc?.getURL() ?? '',
      title: wc?.getTitle() ?? '',
      loading: wc?.isLoading() ?? false,
      canGoBack: wc?.navigationHistory.canGoBack() ?? false,
      canGoForward: wc?.navigationHistory.canGoForward() ?? false,
      driver: driving ? this.driver!.label : null,
      driverRunId: driving ? this.driver!.runId : null,
      userControl: this.userControl,
    };
  }

  private emit() {
    this.onState(this.state());
  }

  private ensure(): WebContentsView {
    if (this.view && !this.view.webContents.isDestroyed()) return this.view;
    const view = new WebContentsView({ webPreferences: { partition: PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false } });
    const wc = view.webContents;
    // Never a second window: what would open one opens here.
    wc.setWindowOpenHandler(({ url }) => {
      const next = normalizeUrl(url);
      if (next) void wc.loadURL(next);
      return { action: 'deny' };
    });
    // Only web pages: no file:, no custom schemes.
    wc.on('will-navigate', (e, url) => {
      if (!/^(https?:|about:blank)/i.test(url)) e.preventDefault();
    });
    for (const event of ['did-navigate', 'did-navigate-in-page', 'page-title-updated', 'did-start-loading', 'did-stop-loading'] as const) {
      wc.on(event as 'did-navigate', () => this.emit());
    }
    this.view = view;
    this.place();
    return view;
  }

  /**
   * Where the pane is in the window (null: hidden). The page view follows it exactly, so it never
   * moves on its own; it's only on screen while the pane is.
   */
  setBounds(bounds: Rectangle | null): void {
    this.bounds = bounds && bounds.width > 0 && bounds.height > 0 ? bounds : null;
    this.place();
  }

  private place() {
    const win = this.window();
    const view = this.view;
    if (!view) return;
    if (this.attachedTo && (this.attachedTo !== win || !this.bounds)) {
      if (!this.attachedTo.isDestroyed()) this.attachedTo.contentView.removeChildView(view);
      this.attachedTo = null;
    }
    if (win && this.bounds) {
      if (this.attachedTo !== win) {
        win.contentView.addChildView(view);
        this.attachedTo = win;
      }
      view.setBounds(this.bounds);
    }
  }

  // ---------- what you do in the pane ----------

  async open(input: string): Promise<void> {
    const url = normalizeUrl(input);
    if (!url) throw new Error('That is not a web address');
    await this.ensure().webContents.loadURL(url).catch(() => {});
    this.emit();
  }

  back(): void {
    const h = this.view?.webContents.navigationHistory;
    if (h?.canGoBack()) h.goBack();
  }

  forward(): void {
    const h = this.view?.webContents.navigationHistory;
    if (h?.canGoForward()) h.goForward();
  }

  stopLoading(): void {
    this.view?.webContents.stop();
  }

  reload(): void {
    this.view?.webContents.reload();
  }

  /** You take the browser (agents' tools wait) or hand it back. */
  setUserControl(on: boolean): void {
    this.userControl = on;
    this.emit();
  }

  // ---------- what agents do (browser-bridge.ts) ----------

  private async onRequest(req: IncomingMessage, res: ServerResponse) {
    const reply = (status: number, body: Reply | { tools: unknown }) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const who = this.tokens.get(String(req.headers['x-browser-token'] ?? ''));
    if (req.method !== 'POST' || req.url !== '/mcp' || !who) return reply(403, { text: 'Not allowed', isError: true });
    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 200_000) return reply(413, { text: 'Too large', isError: true });
    }
    let body: { method?: string; params?: { name?: string; arguments?: Record<string, unknown> } };
    try {
      body = JSON.parse(raw);
    } catch {
      return reply(400, { text: 'Bad request', isError: true });
    }
    if (body.method === 'tools/list') return reply(200, { tools: TOOLS });
    if (body.method !== 'tools/call') return reply(400, { text: 'Unknown method', isError: true });
    try {
      reply(200, await this.call(who, String(body.params?.name ?? ''), body.params?.arguments ?? {}));
    } catch (error) {
      reply(200, { text: error instanceof Error ? error.message : String(error), isError: true });
    }
  }

  /**
   * Marks who is driving, for a few seconds. It never opens the pane: you may be somewhere else. The
   * title bar says an agent is browsing, and its pages work the same with the pane closed.
   */
  private acting(who: { label: string; runId: string | null }) {
    this.driver = { ...who, at: Date.now() };
    this.emit();
    if (this.driverTimer) clearTimeout(this.driverTimer);
    this.driverTimer = setTimeout(() => this.emit(), DRIVING_MS + 100);
  }

  private async call(who: { label: string; runId: string | null }, name: string, args: Record<string, unknown>): Promise<Reply> {
    if (this.userControl) throw new Error('The user is using the browser right now. Wait for them to hand it back, or ask them what they need.');
    this.acting(who);
    const wc = this.ensure().webContents;
    const settle = () => new Promise((r) => setTimeout(r, 400));
    switch (name) {
      case 'browser_open': {
        await this.open(String(args.url ?? ''));
        return { text: formatSnapshot(await this.read()) };
      }
      case 'browser_read':
        if (!wc.getURL()) return { text: 'The browser is empty: open a page with browser_open first.' };
        return { text: formatSnapshot(await this.read()) };
      case 'browser_click': {
        const ref = Number(args.ref);
        if (this.onScreen()) {
          // A real click, as a person's: pages that ignore scripted clicks still get it.
          const at = await this.locate(ref);
          wc.sendInputEvent({ type: 'mouseDown', x: at.x, y: at.y, button: 'left', clickCount: 1 });
          wc.sendInputEvent({ type: 'mouseUp', x: at.x, y: at.y, button: 'left', clickCount: 1 });
        } else {
          // Off screen, mouse events go nowhere: click from inside the page.
          const ok = (await wc.executeJavaScriptInIsolatedWorld(WORLD, [{ code: clickScript(ref) }])) as boolean;
          if (!ok) throw new Error(`There is no [${ref}] on the page any more: read it again.`);
        }
        await settle();
        await this.waitLoad();
        return { text: `Clicked [${ref}]. Now at ${wc.getURL()}. Read the page again before the next step.` };
      }
      case 'browser_type': {
        const ok = (await wc.executeJavaScriptInIsolatedWorld(WORLD, [{ code: focusScript(Number(args.ref), true) }])) as boolean;
        if (!ok) throw new Error(`There is no [${Number(args.ref)}] on the page any more: read it again.`);
        wc.insertText(String(args.text ?? ''));
        if (args.submit === true) {
          this.press('Enter');
          await settle();
          await this.waitLoad();
        }
        return { text: `Typed into [${Number(args.ref)}]${args.submit === true ? ' and pressed Enter' : ''}.` };
      }
      case 'browser_press': {
        const key = String(args.key ?? '') as Key;
        if (!KEYS.includes(key)) throw new Error(`Unknown key: ${key}`);
        this.press(key);
        await settle();
        return { text: `Pressed ${key}.` };
      }
      case 'browser_scroll': {
        const down = args.direction !== 'up';
        await wc.executeJavaScriptInIsolatedWorld(WORLD, [{ code: `window.scrollBy(0, ${down ? '' : '-'}Math.round(window.innerHeight * 0.85))` }]);
        await settle();
        return { text: `Scrolled ${down ? 'down' : 'up'}.` };
      }
      case 'browser_back': {
        this.back();
        await settle();
        await this.waitLoad();
        return { text: `Back at ${wc.getURL() || 'the start'}.` };
      }
      case 'browser_screenshot': {
        if (!this.bounds) throw new Error('The browser pane is hidden; ask the user to open it (Browser in the title bar) and try again.');
        const image = await wc.capturePage();
        const size = image.getSize();
        const shot = size.width > 1280 ? image.resize({ width: 1280 }) : image;
        return { content: [{ type: 'image', data: shot.toPNG().toString('base64'), mimeType: 'image/png' }, { type: 'text', text: `${wc.getURL()} — ${wc.getTitle()}` }] };
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  /** The page is in a window you can see (then it takes real mouse and key events). */
  private onScreen(): boolean {
    return !!this.attachedTo && !this.attachedTo.isDestroyed() && this.attachedTo.isVisible() && this.attachedTo.getOpacity() > 0;
  }

  private async read(): Promise<PageSnapshot> {
    await this.waitLoad();
    const wc = this.ensure().webContents;
    return (await wc.executeJavaScriptInIsolatedWorld(WORLD, [{ code: SNAPSHOT_SCRIPT }])) as PageSnapshot;
  }

  private async locate(ref: number): Promise<{ x: number; y: number }> {
    if (!Number.isInteger(ref) || ref < 1) throw new Error('Give the number of an element from browser_read.');
    const wc = this.ensure().webContents;
    const at = (await wc.executeJavaScriptInIsolatedWorld(WORLD, [{ code: locateScript(ref) }])) as { x: number; y: number } | null;
    if (!at) throw new Error(`There is no [${ref}] on the page any more: read it again.`);
    await new Promise((r) => setTimeout(r, 120)); // after scrolling it into view
    return at;
  }

  private press(key: Key) {
    const wc = this.ensure().webContents;
    if (!this.onScreen()) {
      void wc.executeJavaScriptInIsolatedWorld(WORLD, [{ code: keyScript(key) }]).catch(() => {});
      return;
    }
    const keyCode = key === 'Space' ? ' ' : key;
    wc.sendInputEvent({ type: 'keyDown', keyCode });
    if (key === 'Enter' || key === 'Space') wc.sendInputEvent({ type: 'char', keyCode: key === 'Enter' ? '\r' : ' ' });
    wc.sendInputEvent({ type: 'keyUp', keyCode });
  }

  /** Until the page stops loading, for at most 15 s. */
  private waitLoad(): Promise<void> {
    const wc = this.view?.webContents;
    if (!wc || !wc.isLoading()) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        wc.off('did-stop-loading', done);
        resolve();
      };
      const timer = setTimeout(done, 15_000);
      wc.on('did-stop-loading', done);
    });
  }
}
