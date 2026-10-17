import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { WebContentsView, type BrowserWindow, type Rectangle, type WebContents } from 'electron';
import type { SessionMcpServer } from '@alchemist-coder/core';
import { BROWSER_MAX_TABS, type BrowserState } from '../shared/api';
import { clickScript, focusScript, formatSnapshot, KEYS, keyScript, locateScript, normalizeUrl, SNAPSHOT_SCRIPT, type Key, type PageSnapshot } from './browser-page';
import { activeAfterClose, partitionFor, tabAt, tabsText } from './browser-tabs';

export type { BrowserState };

export const SERVER_NAME = 'alchemist_browser';
/** Its own isolated world: a page's scripts never see ours. */
const WORLD = 1919;
const DRIVING_MS = 6000;

const TOOLS = [
  {
    name: 'browser_open',
    description:
      "Opens a web address (or searches for words) in Alchemist Coder's built-in browser for this project (its own tabs and sign-ins), which the user can watch next to the conversation. With new_tab, in a new tab, leaving the current one as it is. Then read the page with browser_read.",
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'A web address, a domain, or words to search for' }, new_tab: { type: 'boolean', description: 'Open it in a new tab' } },
      required: ['url'],
    },
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
  { name: 'browser_tabs', description: "Lists this project's browser tabs, numbered, and which one is in front (the one the other tools use).", inputSchema: { type: 'object', properties: {} } },
  {
    name: 'browser_switch_tab',
    description: 'Brings the tab with this number (from browser_tabs) to the front: the other tools then use it.',
    inputSchema: { type: 'object', properties: { tab: { type: 'number' } }, required: ['tab'] },
  },
  {
    name: 'browser_close_tab',
    description: 'Closes the tab with this number (from browser_tabs).',
    inputSchema: { type: 'object', properties: { tab: { type: 'number' } }, required: ['tab'] },
  },
] as const;

type Reply = { text?: string; content?: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>; isError?: boolean };
/** A run's tools: which agent it is ("Claude Code"), its run once started, and its project's browser. */
type Who = { label: string; runId: string | null; project: string };

interface Tab {
  id: string;
  view: WebContentsView;
}

/** A project's browser: its own cookies and sign-ins (partitionFor), its tabs, who drives it, whether you have it. */
interface ProjectBrowser {
  project: string;
  tabs: Tab[];
  active: string | null;
  userControl: boolean;
  driver: (Who & { at: number }) | null;
}

/**
 * The browser inside the app: a browser per project, each with its own cookies and sign-ins and its
 * own tabs, so an agent of one project never sees another's pages or logins. The pane shows the
 * browser of the project you're on: its front tab is a native view laid exactly over the pane (it
 * never opens windows of its own; what would open one opens a tab). Agents use their own project's
 * browser through `browser-bridge.ts`, whether it's on screen or not. You watch it live and can take
 * it over at any time.
 */
export class BrowserHost {
  private readonly browsers = new Map<string, ProjectBrowser>();
  /** The project whose browser the pane shows (the one you're on; '' outside any). */
  private shown = '';
  private bounds: Rectangle | null = null;
  private attachedTo: BrowserWindow | null = null;
  private attachedView: WebContentsView | null = null;
  private server: Server | null = null;
  private port = 0;
  /** Each run's token: which agent it is, its run once started, and its project. */
  private readonly tokens = new Map<string, Who>();
  private driverTimer: ReturnType<typeof setTimeout> | null = null;
  private nextTab = 1;

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
    for (const b of this.browsers.values()) for (const tab of b.tabs) tab.view.webContents.close();
    this.browsers.clear();
    this.attachedView = null;
  }

  /** The browser tools for one run of an agent (`label` names it in the pane) in the project at `project`. */
  mcpServer(label: string, project = ''): SessionMcpServer | null {
    if (!this.port) return null;
    const token = randomBytes(24).toString('hex');
    this.tokens.set(token, { label, runId: null, project });
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
    const view = this.attachedView;
    if (!view || !this.bounds || !this.attachedTo) return null;
    // A view just put on screen may not have painted yet: a few tries.
    for (let attempt = 0; ; attempt++) {
      try {
        return { image: await view.webContents.capturePage(), bounds: this.bounds };
      } catch (error) {
        if (attempt >= 8) throw error;
        await new Promise((r) => setTimeout(r, 400));
      }
    }
  }

  state(): BrowserState {
    const b = this.browsers.get(this.shown);
    const wc = b ? this.front(b)?.view.webContents : undefined;
    const recent = (x: ProjectBrowser) => !!x.driver && Date.now() - x.driver.at < DRIVING_MS;
    return {
      url: wc?.getURL() ?? '',
      title: wc?.getTitle() ?? '',
      loading: wc?.isLoading() ?? false,
      canGoBack: wc?.navigationHistory.canGoBack() ?? false,
      canGoForward: wc?.navigationHistory.canGoForward() ?? false,
      driver: b && recent(b) ? b.driver!.label : null,
      driverRunId: b && recent(b) ? b.driver!.runId : null,
      userControl: b?.userControl ?? false,
      project: this.shown,
      tabs: (b?.tabs ?? []).map((t) => ({ id: t.id, title: t.view.webContents.getTitle(), url: t.view.webContents.getURL(), loading: t.view.webContents.isLoading(), active: t.id === b!.active })),
      driving: [...this.browsers.values()].filter(recent).map((x) => ({ project: x.project, label: x.driver!.label, runId: x.driver!.runId })),
    };
  }

  private emit() {
    this.onState(this.state());
  }

  private browserFor(project: string): ProjectBrowser {
    let b = this.browsers.get(project);
    if (!b) {
      b = { project, tabs: [], active: null, userControl: false, driver: null };
      this.browsers.set(project, b);
    }
    return b;
  }

  private front(b: ProjectBrowser): Tab | undefined {
    return b.tabs.find((t) => t.id === b.active);
  }

  /** A new tab in a project's browser, in front, on `url` if given. */
  private newTab(b: ProjectBrowser, url?: string): Tab {
    if (b.tabs.length >= BROWSER_MAX_TABS) throw new Error(`This browser already has ${BROWSER_MAX_TABS} tabs: close one first.`);
    const view = new WebContentsView({ webPreferences: { partition: partitionFor(b.project), sandbox: true, contextIsolation: true, nodeIntegration: false } });
    const tab: Tab = { id: `tab-${this.nextTab++}`, view };
    const wc = view.webContents;
    // Never a second window: what would open one opens a tab (or here, once the browser is full).
    wc.setWindowOpenHandler(({ url: next }) => {
      const target = normalizeUrl(next);
      if (target) {
        try {
          this.newTab(b, target);
        } catch {
          void wc.loadURL(target);
        }
      }
      return { action: 'deny' };
    });
    // Only web pages: no file:, no custom schemes.
    wc.on('will-navigate', (e, to) => {
      if (!/^(https?:|about:blank)/i.test(to)) e.preventDefault();
    });
    for (const event of ['did-navigate', 'did-navigate-in-page', 'page-title-updated', 'did-start-loading', 'did-stop-loading'] as const) {
      wc.on(event as 'did-navigate', () => this.emit());
    }
    b.tabs.push(tab);
    b.active = tab.id;
    if (url) void wc.loadURL(url).catch(() => {});
    this.place();
    this.emit();
    return tab;
  }

  /** The tab in front, or a new one when the browser has none. */
  private ensureFront(b: ProjectBrowser): Tab {
    return this.front(b) ?? this.newTab(b);
  }

  private closeTab(b: ProjectBrowser, id: string) {
    const tab = b.tabs.find((t) => t.id === id);
    if (!tab) return;
    b.active = activeAfterClose(b.tabs.map((t) => t.id), b.active, id);
    b.tabs = b.tabs.filter((t) => t !== tab);
    if (this.attachedView === tab.view) this.detach();
    tab.view.webContents.close();
    this.place();
    this.emit();
  }

  private switchTab(b: ProjectBrowser, id: string) {
    if (!b.tabs.some((t) => t.id === id)) return;
    b.active = id;
    this.place();
    this.emit();
  }

  /**
   * Where the pane is in the window (null: hidden). The front tab of the shown project's browser
   * follows it exactly, so it never moves on its own; it's only on screen while the pane is.
   */
  setBounds(bounds: Rectangle | null): void {
    this.bounds = bounds && bounds.width > 0 && bounds.height > 0 ? bounds : null;
    this.place();
  }

  /** The project you're on: the pane shows its browser (its tabs and sign-ins). */
  setProject(project: string): void {
    if (project === this.shown) return;
    this.shown = project;
    this.place();
    this.emit();
  }

  private detach() {
    if (this.attachedTo && this.attachedView && !this.attachedTo.isDestroyed()) this.attachedTo.contentView.removeChildView(this.attachedView);
    this.attachedTo = null;
    this.attachedView = null;
  }

  private place() {
    const win = this.window();
    const b = this.browsers.get(this.shown);
    const view = win && this.bounds && b ? this.front(b)?.view ?? null : null;
    if (this.attachedView && (this.attachedView !== view || this.attachedTo !== win)) this.detach();
    if (win && view && this.bounds) {
      if (this.attachedView !== view) {
        win.contentView.addChildView(view);
        this.attachedTo = win;
        this.attachedView = view;
      }
      view.setBounds(this.bounds);
    }
  }

  // ---------- what you do in the pane (the shown project's browser) ----------

  async open(input: string): Promise<void> {
    const url = normalizeUrl(input);
    if (!url) throw new Error('That is not a web address');
    await this.ensureFront(this.browserFor(this.shown)).view.webContents.loadURL(url).catch(() => {});
    this.emit();
  }

  /** A new tab, in front (empty, or on an address). */
  openTab(input?: string): void {
    const url = input ? normalizeUrl(input) : null;
    if (input && !url) throw new Error('That is not a web address');
    this.newTab(this.browserFor(this.shown), url ?? undefined);
  }

  showTab(id: string): void {
    this.switchTab(this.browserFor(this.shown), id);
  }

  dropTab(id: string): void {
    this.closeTab(this.browserFor(this.shown), id);
  }

  private shownWc(): WebContents | undefined {
    const b = this.browsers.get(this.shown);
    return b ? this.front(b)?.view.webContents : undefined;
  }

  back(): void {
    const h = this.shownWc()?.navigationHistory;
    if (h?.canGoBack()) h.goBack();
  }

  forward(): void {
    const h = this.shownWc()?.navigationHistory;
    if (h?.canGoForward()) h.goForward();
  }

  stopLoading(): void {
    this.shownWc()?.stop();
  }

  reload(): void {
    this.shownWc()?.reload();
  }

  /** You take the shown project's browser (its agents' tools wait) or hand it back. */
  setUserControl(on: boolean): void {
    this.browserFor(this.shown).userControl = on;
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
   * Marks who is driving a project's browser, for a few seconds. It never opens the pane: you may be
   * somewhere else. The title bar says an agent is browsing, and its pages work the same off screen.
   */
  private acting(b: ProjectBrowser, who: Who) {
    b.driver = { ...who, at: Date.now() };
    this.emit();
    if (this.driverTimer) clearTimeout(this.driverTimer);
    this.driverTimer = setTimeout(() => this.emit(), DRIVING_MS + 100);
  }

  private async call(who: Who, name: string, args: Record<string, unknown>): Promise<Reply> {
    const b = this.browserFor(who.project);
    if (b.userControl) throw new Error('The user is using the browser right now. Wait for them to hand it back, or ask them what they need.');
    this.acting(b, who);
    const settle = () => new Promise((r) => setTimeout(r, 400));
    switch (name) {
      case 'browser_open': {
        const url = normalizeUrl(String(args.url ?? ''));
        if (!url) throw new Error('That is not a web address');
        const tab = args.new_tab === true || !this.front(b) ? this.newTab(b) : this.front(b)!;
        await tab.view.webContents.loadURL(url).catch(() => {});
        this.emit();
        return { text: formatSnapshot(await this.read(tab)) };
      }
      case 'browser_tabs':
        return { text: tabsText(b.tabs.map((t) => ({ id: t.id, title: t.view.webContents.getTitle(), url: t.view.webContents.getURL() })), b.active) };
      case 'browser_switch_tab': {
        const tab = tabAt(b.tabs, args.tab);
        this.switchTab(b, tab.id);
        return { text: `Tab ${String(args.tab)} is in front: ${tab.view.webContents.getURL() || 'about:blank'}. Read it with browser_read.` };
      }
      case 'browser_close_tab': {
        const tab = tabAt(b.tabs, args.tab);
        this.closeTab(b, tab.id);
        return { text: `Closed tab ${String(args.tab)}. ${b.tabs.length ? `${b.tabs.length} left.` : 'No tabs left.'}` };
      }
    }
    const tab = this.front(b);
    if (!tab) return { text: 'The browser is empty: open a page with browser_open first.' };
    const wc = tab.view.webContents;
    switch (name) {
      case 'browser_read':
        if (!wc.getURL()) return { text: 'The browser is empty: open a page with browser_open first.' };
        return { text: formatSnapshot(await this.read(tab)) };
      case 'browser_click': {
        const ref = Number(args.ref);
        if (this.onScreen(tab)) {
          // A real click, as a person's: pages that ignore scripted clicks still get it.
          const at = await this.locate(tab, ref);
          wc.sendInputEvent({ type: 'mouseDown', x: at.x, y: at.y, button: 'left', clickCount: 1 });
          wc.sendInputEvent({ type: 'mouseUp', x: at.x, y: at.y, button: 'left', clickCount: 1 });
        } else {
          // Off screen, mouse events go nowhere: click from inside the page.
          const ok = (await wc.executeJavaScriptInIsolatedWorld(WORLD, [{ code: clickScript(ref) }])) as boolean;
          if (!ok) throw new Error(`There is no [${ref}] on the page any more: read it again.`);
        }
        await settle();
        await this.waitLoad(wc);
        return { text: `Clicked [${ref}]. Now at ${wc.getURL()}. Read the page again before the next step.` };
      }
      case 'browser_type': {
        const ok = (await wc.executeJavaScriptInIsolatedWorld(WORLD, [{ code: focusScript(Number(args.ref), true) }])) as boolean;
        if (!ok) throw new Error(`There is no [${Number(args.ref)}] on the page any more: read it again.`);
        wc.insertText(String(args.text ?? ''));
        if (args.submit === true) {
          this.press(tab, 'Enter');
          await settle();
          await this.waitLoad(wc);
        }
        return { text: `Typed into [${Number(args.ref)}]${args.submit === true ? ' and pressed Enter' : ''}.` };
      }
      case 'browser_press': {
        const key = String(args.key ?? '') as Key;
        if (!KEYS.includes(key)) throw new Error(`Unknown key: ${key}`);
        this.press(tab, key);
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
        if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
        await settle();
        await this.waitLoad(wc);
        return { text: `Back at ${wc.getURL() || 'the start'}.` };
      }
      case 'browser_screenshot': {
        if (this.attachedView !== tab.view || !this.bounds) throw new Error("The browser pane is closed or shows another project's browser; ask the user to open it (the globe in the title bar) and try again.");
        const image = await wc.capturePage();
        const size = image.getSize();
        const shot = size.width > 1280 ? image.resize({ width: 1280 }) : image;
        return { content: [{ type: 'image', data: shot.toPNG().toString('base64'), mimeType: 'image/png' }, { type: 'text', text: `${wc.getURL()} — ${wc.getTitle()}` }] };
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  /** The tab is the one in a window you can see (then it takes real mouse and key events). */
  private onScreen(tab: Tab): boolean {
    const win = this.attachedTo;
    return this.attachedView === tab.view && !!win && !win.isDestroyed() && win.isVisible() && win.getOpacity() > 0;
  }

  private async read(tab: Tab): Promise<PageSnapshot> {
    const wc = tab.view.webContents;
    await this.waitLoad(wc);
    return (await wc.executeJavaScriptInIsolatedWorld(WORLD, [{ code: SNAPSHOT_SCRIPT }])) as PageSnapshot;
  }

  private async locate(tab: Tab, ref: number): Promise<{ x: number; y: number }> {
    if (!Number.isInteger(ref) || ref < 1) throw new Error('Give the number of an element from browser_read.');
    const at = (await tab.view.webContents.executeJavaScriptInIsolatedWorld(WORLD, [{ code: locateScript(ref) }])) as { x: number; y: number } | null;
    if (!at) throw new Error(`There is no [${ref}] on the page any more: read it again.`);
    await new Promise((r) => setTimeout(r, 120)); // after scrolling it into view
    return at;
  }

  private press(tab: Tab, key: Key) {
    const wc = tab.view.webContents;
    if (!this.onScreen(tab)) {
      void wc.executeJavaScriptInIsolatedWorld(WORLD, [{ code: keyScript(key) }]).catch(() => {});
      return;
    }
    const keyCode = key === 'Space' ? ' ' : key;
    wc.sendInputEvent({ type: 'keyDown', keyCode });
    if (key === 'Enter' || key === 'Space') wc.sendInputEvent({ type: 'char', keyCode: key === 'Enter' ? '\r' : ' ' });
    wc.sendInputEvent({ type: 'keyUp', keyCode });
  }

  /** Until the page stops loading, for at most 15 s. */
  private waitLoad(wc: WebContents): Promise<void> {
    if (!wc.isLoading()) return Promise.resolve();
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
