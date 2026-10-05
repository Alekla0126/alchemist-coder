import { readFileSync } from 'node:fs';
import { app, nativeImage, type BrowserWindow, type NativeImage } from 'electron';
import workingIconFile from '../../build/icon-working.png?asset';
import waitingDotFile from '../../build/overlay-waiting.png?asset';
import workingDotFile from '../../build/overlay-working.png?asset';
import type { Attention } from '../shared/api';
import { dockLook, type DockLook } from './dock-look';

const images = new Map<string, NativeImage>();
// Read with fs, which also reads inside the app's archive (app.asar).
function image(file: string): NativeImage {
  let found = images.get(file);
  if (!found) images.set(file, (found = nativeImage.createFromBuffer(readFileSync(file))));
  return found;
}

let last: Attention | null = null;
let lastLook: DockLook = { badge: 0, dot: null, alert: false };

/**
 * The app's icon says what's going on while you're in another app. macOS: the Dock's badge counts what
 * waits for you, a green dot shows agents working, and the icon bounces once when something new needs you.
 * Windows: a dot over the taskbar button, which flashes. Linux: the launcher's count, where the desktop shows one.
 */
export function showAttention(win: BrowserWindow | null, next: Attention): void {
  const look = dockLook(last, next, !!win?.isFocused());
  if (process.platform !== 'win32' && look.badge !== lastLook.badge) app.setBadgeCount(look.badge);
  if (process.platform === 'darwin' && app.dock) {
    // Only the "working" dot changes the picture: the badge already stands for what waits for you.
    const working = next.working > 0;
    const wasWorking = (last?.working ?? 0) > 0;
    // An empty picture gives the app its own icon back.
    if (working !== wasWorking) app.dock.setIcon(working ? image(workingIconFile) : nativeImage.createEmpty());
    if (look.alert) app.dock.bounce('informational');
  }
  if (process.platform === 'win32' && win && !win.isDestroyed()) {
    if (look.dot !== lastLook.dot || next.label !== last?.label) win.setOverlayIcon(look.dot ? image(look.dot === 'waiting' ? waitingDotFile : workingDotFile) : null, look.dot ? next.label : '');
  }
  if (process.platform !== 'darwin' && look.alert && win && !win.isDestroyed()) {
    win.flashFrame(true);
    win.once('focus', () => !win.isDestroyed() && win.flashFrame(false));
  }
  last = next;
  lastLook = look;
}
