/**
 * Web Push client helpers (Task 1).
 *
 * Flow: request the VAPID public key from the server over WS, subscribe via the
 * service worker's PushManager, then hand the subscription back to the server
 * (`push:subscribe`) so it can push while the PWA is closed.
 *
 * The server's `push:vapid-key` reply isn't routed through the app's shared
 * socket (the store ignores unknown message types), so the request/reply
 * handshake uses its own short-lived socket. The `push:subscribe` /
 * `push:unsubscribe` messages are fire-and-forget and go through the app's
 * `send` so they queue if the socket is momentarily down.
 */
import type { WSClientMessage, WSServerMessage } from './types';

export type PushState = 'unsupported' | 'off' | 'in-app' | 'in-app-push';

type Send = (msg: WSClientMessage) => void;

/**
 * Deliver one fire-and-forget message over a dedicated short-lived socket.
 * Used when no app `send` is supplied (e.g. NotificationToggle has no access to
 * the shared socket). The server persists subscriptions independent of which
 * socket delivered them.
 */
function wsSendOneShot(msg: WSClientMessage): void {
  try {
    const ws = new WebSocket(wsUrl());
    ws.onopen = () => {
      try { ws.send(JSON.stringify(msg)); } finally { setTimeout(() => { try { ws.close(); } catch { /* ignore */ } }, 250); }
    };
    ws.onerror = () => { try { ws.close(); } catch { /* ignore */ } };
  } catch (e) {
    console.error('[push] one-shot send failed:', (e as Error).message);
  }
}

export function pushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

function wsUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws`;
}

/** One-shot WS request over a dedicated socket; resolves with the first reply of `replyType`. */
function wsRequest<T extends WSServerMessage['type']>(
  request: WSClientMessage,
  replyType: T,
  timeoutMs = 8000,
): Promise<Extract<WSServerMessage, { type: T }>> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const ws = new WebSocket(wsUrl());
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch { /* ignore */ }
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new Error('push WS request timed out'))), timeoutMs);
    ws.onopen = () => ws.send(JSON.stringify(request));
    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data) as WSServerMessage;
        if (msg.type === replyType) {
          clearTimeout(timer);
          finish(() => resolve(msg as Extract<WSServerMessage, { type: T }>));
        }
      } catch { /* ignore non-JSON / unrelated frames */ }
    };
    ws.onerror = () => {
      clearTimeout(timer);
      finish(() => reject(new Error('push WS error')));
    };
  });
}

/** Convert a base64url VAPID key to the Uint8Array PushManager expects. */
function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  // Back with a concrete ArrayBuffer so the result is a valid BufferSource.
  const output = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i);
  return output;
}

/** True if this browser currently holds a push subscription. */
export async function isPushSubscribed(): Promise<boolean> {
  if (!pushSupported()) return false;
  try {
    const reg = await navigator.serviceWorker.ready;
    return (await reg.pushManager.getSubscription()) !== null;
  } catch {
    return false;
  }
}

/** Current tri-state: off (no permission) / in-app (granted, no push) / in-app+push. */
export async function getPushState(): Promise<PushState> {
  if (!pushSupported()) return 'unsupported';
  if (Notification.permission !== 'granted') return 'off';
  return (await isPushSubscribed()) ? 'in-app-push' : 'in-app';
}

/**
 * Ensure notification permission, subscribe to push, and register the
 * subscription with the server. Returns the resulting state.
 */
export async function subscribeToPush(send?: Send): Promise<PushState> {
  if (!pushSupported()) return 'unsupported';
  const deliver: Send = send ?? wsSendOneShot;

  const perm = await Notification.requestPermission();
  if (perm !== 'granted') return 'off';

  let key: string | null;
  try {
    const reply = await wsRequest({ type: 'push:vapid-key' }, 'push:vapid-key');
    key = reply.key;
  } catch (e) {
    console.error('[push] failed to fetch VAPID key:', (e as Error).message);
    return 'in-app';
  }
  if (!key) {
    console.error('[push] server returned no VAPID key');
    return 'in-app';
  }

  try {
    const reg = await navigator.serviceWorker.ready;
    const existing = await reg.pushManager.getSubscription();
    const sub = existing ?? await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(key),
    });
    deliver({ type: 'push:subscribe', subscription: sub.toJSON() as PushSubscriptionJSON });
    return 'in-app-push';
  } catch (e) {
    console.error('[push] subscribe failed:', (e as Error).message);
    return 'in-app';
  }
}

/** Unsubscribe locally and tell the server to drop the subscription. */
export async function unsubscribeFromPush(send?: Send): Promise<PushState> {
  if (!pushSupported()) return 'unsupported';
  const deliver: Send = send ?? wsSendOneShot;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      deliver({ type: 'push:unsubscribe', endpoint: sub.endpoint });
      await sub.unsubscribe();
    }
  } catch (e) {
    console.error('[push] unsubscribe failed:', (e as Error).message);
  }
  return Notification.permission === 'granted' ? 'in-app' : 'off';
}
