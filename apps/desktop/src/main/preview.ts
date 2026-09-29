import { protocol, type Session, type WebContents } from 'electron';
import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { contentType, PREVIEW_CSP, PREVIEW_SCHEME, previewUrl, resolveRequest, rootToken } from './preview-files';

/** Must run before the app is ready. */
export function registerPreviewScheme() {
  protocol.registerSchemesAsPrivileged([{ scheme: PREVIEW_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: false, corsEnabled: false } }]);
}

/**
 * Serves agent-made HTML, SVG and images from the user's projects (and Arena worktrees) to the
 * preview pane, with a CSP that blocks the network.
 */
export class PreviewServer {
  private readonly roots = new Map<string, string>();

  constructor(private readonly resolveInside: (path: unknown) => string) {}

  start() {
    protocol.handle(PREVIEW_SCHEME, async (request) => {
      const url = new URL(request.url);
      const root = this.roots.get(url.hostname);
      const file = root ? resolveRequest(root, url.pathname) : null;
      if (!file) return new Response('Not found', { status: 404 });
      try {
        return new Response(await readFile(file), {
          headers: {
            'Content-Type': contentType(file),
            'Content-Security-Policy': PREVIEW_CSP,
            'X-Content-Type-Options': 'nosniff',
            'Cache-Control': 'no-store',
          },
        });
      } catch {
        return new Response('Not readable', { status: 403 });
      }
    });
  }

  /** A preview URL for `path`, rooted at `root` (defaults to the file's folder). */
  url(root: unknown, path: unknown): string {
    const file = this.resolveInside(path);
    const base = root == null ? dirname(file) : this.resolveInside(root);
    this.roots.set(rootToken(base), base);
    return previewUrl(base, file);
  }
}

const external = (url: string) => !url.startsWith(`${PREVIEW_SCHEME}://`) && url !== 'about:blank' && !url.startsWith('about:srcdoc') && !url.startsWith('chrome-error:');

/**
 * Preview frames may only show preview URLs: no navigating an iframe to the internet. The renderer
 * is told, so the pane can explain why it went blank.
 */
export function lockPreviewFrames(contents: WebContents, notify: (url: string) => void) {
  // WebRTC isn't covered by the CSP or webRequest: force it through the dead proxy (see below).
  contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
  contents.on('will-frame-navigate', (event) => {
    if (!event.isMainFrame && external(event.url)) {
      event.preventDefault();
      notify(event.url);
    }
  });
  contents.on('did-fail-load', (_event, _code, _description, url, isMainFrame) => {
    if (!isMainFrame && external(url)) notify(url);
  });
}

/**
 * Second wall behind the CSP: any network request made by a preview frame, or any attempt to load
 * a web page into a frame, is cancelled before it leaves the machine.
 */
export function blockPreviewNetwork(session: Session) {
  // Third wall, for what webRequest never sees (WebRTC, DNS prefetch): Chromium's own traffic goes
  // to a proxy that doesn't exist. The app's real network calls run in Node and are unaffected; the
  // renderer's CSP already limits it to the app itself (and the dev server on localhost).
  void session.setProxy({ mode: 'fixed_servers', proxyRules: 'http://127.0.0.1:9', proxyBypassRules: '<local>;localhost;127.0.0.1;[::1]' });
  session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (details, callback) => {
    let fromPreview = details.resourceType === 'subFrame';
    try {
      fromPreview ||= !!details.frame?.parent && details.frame.url.startsWith(`${PREVIEW_SCHEME}:`);
    } catch {
      // frame already gone
    }
    if (fromPreview) console.warn(`[preview] blocked ${details.resourceType} ${details.url.slice(0, 120)}`);
    callback({ cancel: fromPreview });
  });
}
