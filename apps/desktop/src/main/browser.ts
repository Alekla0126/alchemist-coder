import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { app, session, WebContentsView, type BrowserWindow, type Rectangle, type Session, type WebContents } from 'electron';
import type { SessionMcpServer } from '@alchemist-coder/core';
import { BROWSER_MAX_TABS, type BrowserState } from '../shared/api';
import { clickScript, focusScript, formatSnapshot, KEYS, keyScript, locateScript, normalizeUrl, SNAPSHOT_SCRIPT, type Key, type PageSnapshot } from './browser-page';
import {
  acceptLanguages,
  activeAfterClose,
  AGENT_MAX_TABS,
  browserUserAgent,
  keepsAsPopup,
  mayUse,
  partitionFor,
  projectPartitions,
  readSignInChoices,
  SHARED_PARTITION,
  signInPlan,
  siteOf,
  tabAt,
  tabsText,
  tabToReclaim,
  TAB_IDLE_MS,
  type StoredCookie,
} from './browser-tabs';
import { CHROMIUM_BROWSERS, installedBrowsers, readChromiumCookies } from './chrome-cookies';

export type { BrowserState };

export const SERVER_NAME = 'alchemist_browser';
/** Its own isolated world: a page's scripts never see ours. */
const WORLD = 1919;
const DRIVING_MS = 6000;
/**
 * How often sign-ins are written to disk. Chromium keeps recent cookie changes in memory for a while,
 * and Google rotates its session cookies every few minutes: if the app is force-quit or crashes before
 * they're written, the next launch sends a stale one and Google signs you out.
 */
const FLUSH_MS = 2 * 60_000;
const POPUP_SIZE = { width: 520, height: 700 };
/** How long another browser's sign-ins wait for your answer before they're forgotten. */
const EXTERNAL_MS = 10 * 60_000;

const TOOLS = [
  {
    name: 'browser_open',
    description:
      "Opens a web address (or searches for words) in your tab of Alchemist Coder's built-in browser for this project (its sign-ins are the project's; other agents have tabs of their own), which the user can watch next to the conversation. With new_tab, in another tab of yours, leaving this one as it is. Then read the page with browser_read, ideally with find.",
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'A web address, a domain, or words to search for' }, new_tab: { type: 'boolean', description: 'Open it in a new tab' }, find: { type: 'string', description: 'Only what mentions these words, alternatives separated by | (e.g. "Publish|Send for review"): a few lines instead of the whole page. Numbers stay the same.' } },
      required: ['url'],
    },
  },
  {
    name: 'browser_read',
    description:
      'Reads the page in the built-in browser: its address, its visible text, and everything you can click or type into, each with a number to use with browser_click and browser_type. With find, only the parts that mention it (much cheaper on long pages). Read again after the page changes; numbers change with it.',
    inputSchema: { type: 'object', properties: { find: { type: 'string', description: 'Only what mentions these words, alternatives separated by | (e.g. "Publish|Send for review"): a few lines instead of the whole page. Numbers stay the same.' } } },
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
  { name: 'browser_tabs', description: "Lists this project's browser tabs, numbered: which one is yours (the one the other tools use), which are other agents', and which one the user sees.", inputSchema: { type: 'object', properties: {} } },
  {
    name: 'browser_switch_tab',
    description: "Works in the tab with this number (from browser_tabs) from now on: one of yours, one the user opened and isn't looking at, or one another agent left a while ago.",
    inputSchema: { type: 'object', properties: { tab: { type: 'number' } }, required: ['tab'] },
  },
  {
    name: 'browser_close_tab',
    description: "Closes the tab with this number (from browser_tabs): yours, or another agent's it left a while ago (never the user's). Close the ones you no longer need: each one is a page kept in memory.",
    inputSchema: { type: 'object', properties: { tab: { type: 'number' } }, required: ['tab'] },
  },
] as const;

type Reply = { text?: string; content?: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>; isError?: boolean };
/**
 * A run's tools: which agent it is ("Claude Code", a bot's name), its run once started, its project's
 * browser, its token (`key`) and the tab it works in, so agents of one project don't drive each other's pages.
 */
type Who = { label: string; runId: string | null; project: string; key: string; tab: string | null };

interface Tab {
  id: string;
  view: WebContentsView;
  /** The agent whose tab it is, and its run's token; null for a tab you opened. */
  owner: string | null;
  token: string | null;
  /** When an agent last used it (ms). */
  usedAt: number;
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
 * browser of the project you're on: its front tab is a native view laid exactly over the pane (what
 * would open a window opens a tab, except a sign-in popup while you're the one looking at that page:
 * it stays a small window so it can hand the sign-in back to the page that opened it). Agents use
 * their own project's browser through `browser-bridge.ts`, whether it's on screen or not. You watch it
 * live and can take it over at any time.
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
  /** The partitions whose session is set up (user agent, languages), to write their sign-ins to disk. */
  private readonly sessions = new Set<string>();
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * Per project's partition, the sites whose sign-ins it could bring from the other projects' browsers
   * (or the one the app had before 1.3.1), which the pane offers, or null: none to bring, or you chose.
   */
  private readonly offers = new Map<string, { sites: string[]; earlierOnly: boolean; browser?: string } | null>();
  /**
   * Per partition, the cookies read from another browser you use, while its offer waits for your answer.
   * Kept in memory only, and dropped as soon as you answer.
   */
  private readonly external = new Map<string, { browser: string; cookies: StoredCookie[] }>();
  /** The other browsers on this Mac whose sign-ins the pane can bring. */
  private readonly importable = installedBrowsers().map(({ id, name }) => ({ id, name }));
  private externalTimer: ReturnType<typeof setTimeout> | undefined;

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
    this.flushTimer = setInterval(() => void this.flush(), FLUSH_MS);
    this.flushTimer.unref?.();
  }

  /** Writes every browser's cookies to disk now, so a crash or a force-quit keeps the sign-ins. */
  async flush(): Promise<void> {
    await Promise.all([...this.sessions].map((p) => session.fromPartition(p).cookies.flushStore().catch(() => {})));
  }

  /** A partition's session, set up once: Chrome's user agent without the embedded-app tokens, the system's languages. */
  private sessionFor(partition: string): Session {
    const ses = session.fromPartition(partition);
    if (!this.sessions.has(partition)) {
      ses.setUserAgent(browserUserAgent(ses.getUserAgent()), acceptLanguages(app.getPreferredSystemLanguages()));
      this.sessions.add(partition);
    }
    return ses;
  }

  private choicesFile(): string {
    return join(app.getPath('userData'), 'browser-sign-ins.json');
  }

  private readChoices() {
    let raw: string | null = null;
    try {
      raw = readFileSync(this.choicesFile(), 'utf8');
    } catch {}
    return readSignInChoices(raw);
  }

  /**
   * The other browsers a project's browser could bring sign-ins from: every project's kept on disk, and
   * the one shared by all projects until 1.3.1 (unless you already answered about it for this project).
   */
  private async signInSources(partition: string, withEarlier: boolean) {
    let dirs: string[] = [];
    try {
      dirs = readdirSync(join(app.getPath('userData'), 'Partitions'));
    } catch {}
    const names = new Set([...projectPartitions(dirs), ...this.sessions]);
    names.delete(partition);
    names.delete(SHARED_PARTITION);
    const list = [...(withEarlier ? [SHARED_PARTITION] : []), ...names];
    return Promise.all(list.map(async (p) => ({ partition: p, cookies: await session.fromPartition(p).cookies.get({}).catch(() => []) })));
  }

  /**
   * Each project has a browser of its own, so signing in to Google or your Apple ID in one project
   * doesn't sign its other projects in. Bringing sign-ins gives that project's agents those accounts, so
   * the pane asks, project by project: this finds the sites another browser of the app is signed in to
   * and this one isn't, leaving out the ones it already offered here (a new sign-in elsewhere is offered).
   */
  private async findOffer(project: string): Promise<void> {
    const partition = partitionFor(project);
    if (partition === SHARED_PARTITION || this.offers.has(partition)) return;
    this.offers.set(partition, null);
    const choices = this.readChoices();
    const answeredEarlier = choices.brought.includes(partition) || choices.skipped.includes(partition);
    const offered = new Set(choices.offered[partition] ?? []);
    const sources = await this.signInSources(partition, !answeredEarlier);
    const existing = await this.sessionFor(partition).cookies.get({}).catch(() => []);
    const plan = signInPlan(sources, existing, Date.now() / 1000);
    const sites = [...plan.keys()].filter((site) => !offered.has(site));
    if (!sites.length) return;
    this.offers.set(partition, { sites, earlierOnly: sites.every((site) => plan.get(site)!.partition === SHARED_PARTITION) });
    this.emit();
  }

  /**
   * Your answer for the shown project's browser: bring the offered sign-ins, all of them or only one
   * site's (then reload its page), or none. One site at a time keeps the rest of that project's
   * sign-ins away from this project's agents.
   */
  async chooseSignIns(bring: boolean, site?: string): Promise<void> {
    const partition = partitionFor(this.shown);
    if (partition === SHARED_PARTITION) return;
    const offer = this.offers.get(partition) ?? null;
    if (site && !offer?.sites.includes(site)) return;
    const sites = site ? [site] : (offer?.sites ?? []);
    const external = this.external.get(partition);
    if (bring && sites.length) {
      const target = this.sessionFor(partition);
      const sources = external ? [{ partition: `external:${external.browser}`, cookies: external.cookies }] : await this.signInSources(partition, true);
      const plan = signInPlan(sources, await target.cookies.get({}), Date.now() / 1000);
      for (const s of sites) for (const c of plan.get(s)?.cookies ?? []) await target.cookies.set(c).catch(() => {});
      await target.cookies.flushStore().catch(() => {});
    }
    if (external) {
      // Another browser's sign-ins are offered only while you're answering: what you didn't bring is forgotten.
      const rest = site && offer ? offer.sites.filter((s) => s !== site) : [];
      if (rest.length && offer) this.offers.set(partition, { ...offer, sites: rest });
      else this.dropExternal(partition);
      const wc = this.shownWc();
      if (bring && wc && wc.getURL() && wc.getURL() !== 'about:blank') wc.reload();
      this.emit();
      return;
    }
    const choices = this.readChoices();
    if (!site) {
      const list = bring ? choices.brought : choices.skipped;
      if (!list.includes(partition)) list.push(partition);
    }
    choices.offered[partition] = [...new Set([...(choices.offered[partition] ?? []), ...sites])];
    writeFileSync(this.choicesFile(), JSON.stringify(choices));
    const rest = site && offer ? offer.sites.filter((s) => s !== site) : [];
    this.offers.set(partition, rest.length && offer ? { ...offer, sites: rest } : null);
    const wc = this.shownWc();
    if (bring && wc && wc.getURL() && wc.getURL() !== 'about:blank') wc.reload();
    this.emit();
  }

  /**
   * You asked to bring the sign-ins of another browser you use into the shown project's browser: read
   * them (macOS asks you to allow it) and offer, site by site, the ones this browser doesn't have. Nothing
   * is brought until you pick sites in the pane; agents never call this.
   */
  async importFrom(browserId: string): Promise<{ sites: number } | { error: string }> {
    const partition = partitionFor(this.shown);
    if (partition === SHARED_PARTITION) return { error: 'Open a project first: each project has its own browser and sign-ins.' };
    const browser = CHROMIUM_BROWSERS.find((b) => b.id === browserId);
    if (!browser) return { error: 'Unknown browser.' };
    let cookies: StoredCookie[];
    try {
      cookies = await readChromiumCookies(browser);
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      return { error: /not permitted|EPERM|EACCES/i.test(why) ? `macOS didn't let Alchemist Coder read ${browser.name}'s data. Allow it in System Settings → Privacy & Security, then try again.` : /security|keychain|SecKeychain|exit code|status 5[0-9]/i.test(why) ? `The keychain didn't give ${browser.name}'s key: choose "Allow" when macOS asks.` : why };
    }
    const plan = signInPlan([{ partition: `external:${browser.id}`, cookies }], await this.sessionFor(partition).cookies.get({}).catch(() => []), Date.now() / 1000);
    const sites = [...plan.keys()];
    if (!sites.length) {
      this.emit();
      return { sites: 0 };
    }
    // Only the offered sites' cookies are kept, and only while you answer (at most 10 minutes).
    const offered = new Set(sites);
    this.external.set(partition, { browser: browser.name, cookies: cookies.filter((c) => offered.has(siteOf(c.domain ?? '') ?? '')) });
    this.offers.set(partition, { sites, earlierOnly: false, browser: browser.name });
    clearTimeout(this.externalTimer);
    this.externalTimer = setTimeout(() => this.dropExternal(partition), EXTERNAL_MS);
    this.externalTimer.unref?.();
    this.emit();
    return { sites: sites.length };
  }

  /** Forgets another browser's sign-ins still waiting for an answer, and lets the project offers come back. */
  private dropExternal(partition: string) {
    if (!this.external.delete(partition)) return;
    this.offers.delete(partition);
    if (partitionFor(this.shown) === partition) void this.findOffer(this.shown);
    this.emit();
  }

  stop(): void {
    this.external.clear();
    clearTimeout(this.externalTimer);
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flushTimer = null;
    void this.flush();
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
    this.tokens.set(token, { label, runId: null, project, key: token, tab: null });
    return {
      name: SERVER_NAME,
      command: this.bridge.command,
      args: [this.bridge.script],
      env: { ELECTRON_RUN_AS_NODE: '1', AC_BROWSER_URL: `http://127.0.0.1:${this.port}`, AC_BROWSER_TOKEN: token },
      trusted: true,
    };
  }

  /** A run ended: its token stops working, and its tabs are anyone's to take or close once idle. */
  release(server: SessionMcpServer): void {
    this.tokens.delete(server.env?.AC_BROWSER_TOKEN ?? '');
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
    const recent = (x: ProjectBrowser) => this.driven(x);
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
      signInsFrom: this.shown ? (this.offers.get(partitionFor(this.shown))?.sites ?? null) : null,
      signInsEarlier: this.shown ? (this.offers.get(partitionFor(this.shown))?.earlierOnly ?? false) : false,
      signInsBrowser: this.shown ? (this.offers.get(partitionFor(this.shown))?.browser ?? null) : null,
      importable: this.importable,
      tabsFull: !!b && b.tabs.length >= BROWSER_MAX_TABS && !tabToReclaim(b.tabs, b.active, Date.now()),
      tabs: (b?.tabs ?? []).map((t) => ({ id: t.id, title: t.view.webContents.getTitle(), url: t.view.webContents.getURL(), loading: t.view.webContents.isLoading(), active: t.id === b!.active, owner: t.owner })),
      driving: [...this.browsers.values()].filter(recent).map((x) => ({ project: x.project, label: x.driver!.label, runId: x.driver!.runId })),
    };
  }

  private emit() {
    this.onState(this.state());
  }

  /** An agent used this browser in the last few seconds. */
  private driven(b: ProjectBrowser): boolean {
    return !!b.driver && Date.now() - b.driver.at < DRIVING_MS;
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

  /**
   * A new tab in a project's browser, on `url` if given. Yours comes to the front. An agent's (`who`) is
   * its own: it comes to the front only when the pane has nothing else to show or shows that agent's page,
   * so one agent never takes the screen from you or from another agent. When the browser is full, the tab
   * an agent left the longest ago makes room.
   */
  private newTab(b: ProjectBrowser, url?: string, who?: Who, adopt = true): Tab {
    if (who && b.tabs.filter((t) => t.token === who.key).length >= AGENT_MAX_TABS) {
      throw new Error(`You already have ${AGENT_MAX_TABS} tabs: close one you no longer need with browser_close_tab.`);
    }
    if (b.tabs.length >= BROWSER_MAX_TABS) {
      const idle = tabToReclaim(b.tabs, this.attachedView ? (b.tabs.find((t) => t.view === this.attachedView)?.id ?? null) : null, Date.now());
      if (!idle) throw new Error(`This browser already has ${BROWSER_MAX_TABS} tabs: close one first.`);
      this.closeTab(b, idle);
    }
    const partition = partitionFor(b.project);
    this.sessionFor(partition);
    void this.findOffer(b.project);
    const webPreferences = { partition, sandbox: true, contextIsolation: true, nodeIntegration: false };
    const view = new WebContentsView({ webPreferences });
    const tab: Tab = { id: `tab-${this.nextTab++}`, view, owner: who?.label ?? null, token: who?.key ?? null, usedAt: Date.now() };
    const wc = view.webContents;
    // A sign-in popup stays a small window over the app, with the same cookies, so it can hand the
    // sign-in back through window.opener and close itself: only while you're looking at this page and
    // no agent is driving it, so a page an agent drives never puts a window over your work. Anything
    // else that would open a window opens a tab (or here, once the browser is full).
    wc.setWindowOpenHandler(({ url: next, disposition }) => {
      if (keepsAsPopup(disposition, next) && this.attachedView === view && (b.userControl || !this.driven(b))) {
        return { action: 'allow', overrideBrowserWindowOptions: { ...POPUP_SIZE, parent: this.window() ?? undefined, autoHideMenuBar: true, webPreferences } };
      }
      const target = normalizeUrl(next);
      if (target) {
        // A page an agent drives opens its new tab for that agent, which goes on there.
        const opener = tab.token ? this.tokens.get(tab.token) : undefined;
        try {
          // The agent goes on in the new tab only when it opened from the tab it works in.
          this.newTab(b, target, opener, opener?.tab === tab.id);
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
    wc.on('did-create-window', (popup) => {
      const pwc = popup.webContents;
      pwc.on('will-navigate', (e, to) => {
        if (!/^(https?:|about:blank)/i.test(to)) e.preventDefault();
      });
      // A popup never opens more windows: it goes there itself.
      pwc.setWindowOpenHandler(({ url: next }) => {
        const target = normalizeUrl(next);
        if (target) void pwc.loadURL(target).catch(() => {});
        return { action: 'deny' };
      });
    });
    for (const event of ['did-navigate', 'did-navigate-in-page', 'page-title-updated', 'did-start-loading', 'did-stop-loading'] as const) {
      wc.on(event as 'did-navigate', () => this.emit());
    }
    b.tabs.push(tab);
    const front = this.front(b);
    if (!who || !front || front.token === who.key) b.active = tab.id;
    if (who && adopt) who.tab = tab.id;
    if (url) void wc.loadURL(url).catch(() => {});
    this.place();
    this.emit();
    return tab;
  }

  /** The tab a run works in, while it's still open. */
  private tabOf(b: ProjectBrowser, who: Who): Tab | undefined {
    // Only while it's still this run's: another agent may have taken it after it sat idle.
    return who.tab ? b.tabs.find((t) => t.id === who.tab && t.token === who.key) : undefined;
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
    // Another browser's sign-ins are offered to the project you asked from, only while you're on it.
    for (const partition of [...this.external.keys()]) this.dropExternal(partition);
    this.shown = project;
    void this.findOffer(project);
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
    const b = this.browserFor(this.shown);
    const front = this.front(b);
    // An agent's tab in use stays that agent's: what you type opens in a tab of yours.
    if (front?.token && Date.now() - front.usedAt < TAB_IDLE_MS) this.newTab(b, url);
    else await this.ensureFront(b).view.webContents.loadURL(url).catch(() => {});
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
        const mine = this.tabOf(b, who);
        const tab = args.new_tab === true || !mine ? this.newTab(b, undefined, who) : mine;
        tab.usedAt = Date.now();
        await tab.view.webContents.loadURL(url).catch(() => {});
        this.emit();
        return { text: formatSnapshot(await this.read(tab), typeof args.find === 'string' ? args.find : '') };
      }
      case 'browser_tabs':
        return { text: tabsText(b.tabs.map((t) => ({ id: t.id, title: t.view.webContents.getTitle(), url: t.view.webContents.getURL(), owner: t.owner })), b.active, this.tabOf(b, who)?.id ?? null) };
      case 'browser_switch_tab': {
        const tab = tabAt(b.tabs, args.tab);
        if (!mayUse(tab, who.key, Date.now())) throw new Error(`Tab ${String(args.tab)} is ${tab.owner}'s right now: open your own with browser_open.`);
        if (!tab.token && tab.view === this.attachedView) throw new Error(`The user is looking at tab ${String(args.tab)}: open your own with browser_open.`);
        tab.owner = who.label;
        tab.token = who.key;
        tab.usedAt = Date.now();
        who.tab = tab.id;
        return { text: `You now work in tab ${String(args.tab)}: ${tab.view.webContents.getURL() || 'about:blank'}. Read it with browser_read.` };
      }
      case 'browser_close_tab': {
        const tab = tabAt(b.tabs, args.tab);
        if (!tab.token) throw new Error(`Tab ${String(args.tab)} is the user's: only they close it.`);
        if (!mayUse(tab, who.key, Date.now())) throw new Error(`Tab ${String(args.tab)} is ${tab.owner}'s: only it or the user can close it.`);
        if (who.tab === tab.id) who.tab = null;
        this.closeTab(b, tab.id);
        return { text: `Closed tab ${String(args.tab)}. ${b.tabs.length ? `${b.tabs.length} left.` : 'No tabs left.'}` };
      }
    }
    const tab = this.tabOf(b, who);
    if (!tab) return { text: 'You have no tab open: open a page with browser_open first.' };
    tab.usedAt = Date.now();
    const wc = tab.view.webContents;
    switch (name) {
      case 'browser_read':
        if (!wc.getURL()) return { text: 'The browser is empty: open a page with browser_open first.' };
        return { text: formatSnapshot(await this.read(tab), typeof args.find === 'string' ? args.find : '') };
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
        if (this.attachedView !== tab.view || !this.bounds) throw new Error("Your tab isn't on screen (the pane is closed, or shows another tab or project): a picture needs it there. Read the page with browser_read instead, or ask the user to show your tab.");
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
