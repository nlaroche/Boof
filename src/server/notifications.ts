/**
 * Web Push notifications.
 *
 * VAPID keys are read from env (`VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY`) when
 * set, otherwise generated once at first boot and persisted to `.vapid-keys.json`
 * next to the DB. Subscriptions are persisted in the `push_subscriptions` table
 * (see db.ts) and loaded into memory at boot. Dead subscriptions (404/410) are
 * pruned from both the in-memory map and the DB on send.
 *
 * The `PUSH_DISABLED=1` env var is a kill switch: init still runs (so the VAPID
 * public key is available for the client) but no pushes are actually sent.
 */
import webPush from 'web-push';
import fs from 'fs';
import { getDb, runQuery, getAll } from './db.js';

const VAPID_FILE = '.vapid-keys.json';

interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

/** Payload for a push message. `data.url` drives notificationclick through. */
export interface PushPayload {
  title: string;
  body: string;
  tag?: string;
  data?: { url?: string; [k: string]: unknown };
}

let vapidKeys: VapidKeys | null = null;

// In-memory subscription set, keyed by endpoint so re-subscribes dedupe cleanly.
const subscriptions = new Map<string, webPush.PushSubscription>();

function pushDisabled(): boolean {
  return process.env.PUSH_DISABLED === '1' || process.env.PUSH_DISABLED === 'true';
}

// ── Persistence (guarded — no-ops when the DB isn't initialized, e.g. unit tests) ──

function persistSubscription(sub: webPush.PushSubscription): void {
  if (!getDb()) return;
  try {
    runQuery(
      `INSERT OR REPLACE INTO push_subscriptions (endpoint, keys, created_at) VALUES (?, ?, ?)`,
      [sub.endpoint, JSON.stringify(sub.keys || {}), new Date().toISOString()]
    );
  } catch (e: any) {
    console.error('[notifications] persistSubscription failed:', e?.message || e);
  }
}

function deleteSubscription(endpoint: string): void {
  if (!getDb()) return;
  try {
    runQuery(`DELETE FROM push_subscriptions WHERE endpoint = ?`, [endpoint]);
  } catch (e: any) {
    console.error('[notifications] deleteSubscription failed:', e?.message || e);
  }
}

function loadSubscriptionsFromDb(): void {
  if (!getDb()) return;
  try {
    const rows = getAll<{ endpoint: string; keys: string }>('SELECT endpoint, keys FROM push_subscriptions', []);
    for (const row of rows) {
      try {
        const keys = JSON.parse(row.keys || '{}');
        subscriptions.set(row.endpoint, { endpoint: row.endpoint, keys } as webPush.PushSubscription);
      } catch { /* skip malformed row */ }
    }
    if (rows.length > 0) console.log(`[notifications] Loaded ${rows.length} push subscription(s) from DB`);
  } catch (e: any) {
    console.error('[notifications] loadSubscriptionsFromDb failed:', e?.message || e);
  }
}

// ── Init ──

export function initNotifications(): VapidKeys | null {
  try {
    const envPub = process.env.VAPID_PUBLIC_KEY;
    const envPriv = process.env.VAPID_PRIVATE_KEY;

    if (envPub && envPriv) {
      // Env-provided keys take precedence and are never written to disk.
      vapidKeys = { publicKey: envPub, privateKey: envPriv };
    } else if (fs.existsSync(VAPID_FILE)) {
      vapidKeys = JSON.parse(fs.readFileSync(VAPID_FILE, 'utf-8'));
    } else {
      const keys = webPush.generateVAPIDKeys();
      vapidKeys = { publicKey: keys.publicKey, privateKey: keys.privateKey };
      fs.writeFileSync(VAPID_FILE, JSON.stringify(vapidKeys, null, 2));
    }

    if (vapidKeys) {
      const subject = process.env.VAPID_SUBJECT || 'mailto:boof@localhost';
      webPush.setVapidDetails(subject, vapidKeys.publicKey, vapidKeys.privateKey);
      console.log(`[notifications] VAPID public key: ${vapidKeys.publicKey}`);
      if (pushDisabled()) console.log('[notifications] PUSH_DISABLED set — pushes will NOT be sent');
    }

    loadSubscriptionsFromDb();

    return vapidKeys;
  } catch (error) {
    console.error('Failed to initialize notifications:', error);
    return null;
  }
}

export function getVapidPublicKey(): string | null {
  return vapidKeys?.publicKey || null;
}

export function addSubscription(subscription: webPush.PushSubscription): void {
  if (!subscription?.endpoint) return;
  subscriptions.set(subscription.endpoint, subscription);
  persistSubscription(subscription);
}

export function removeSubscription(endpoint: string): void {
  if (!endpoint) return;
  subscriptions.delete(endpoint);
  deleteSubscription(endpoint);
}

export function getSubscriptionCount(): number {
  return subscriptions.size;
}

// ── Sending ──

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 500;

async function sendWithRetry(
  sub: webPush.PushSubscription,
  payload: string,
  attempt = 1
): Promise<void> {
  try {
    await webPush.sendNotification(sub, payload);
  } catch (err: any) {
    // Subscription is gone (404 Not Found / 410 Gone) — don't retry; caller prunes.
    if (err?.statusCode === 410 || err?.statusCode === 404) {
      throw err;
    }
    if (attempt < MAX_RETRIES) {
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS * attempt));
      return sendWithRetry(sub, payload, attempt + 1);
    }
    throw err;
  }
}

/**
 * Send a push to every registered subscription. Prunes subscriptions the push
 * service reports as gone (404/410) from memory AND the DB. Respects the
 * PUSH_DISABLED kill switch. Never throws.
 */
export async function sendPushToAll(payload: PushPayload): Promise<void> {
  if (pushDisabled() || !vapidKeys) return;
  if (subscriptions.size === 0) return;

  const body = JSON.stringify(payload);
  await Promise.all(
    [...subscriptions.values()].map(async (sub) => {
      try {
        await sendWithRetry(sub, body);
      } catch (err: any) {
        if (err?.statusCode === 410 || err?.statusCode === 404) {
          removeSubscription(sub.endpoint);
        }
        // transient failures after retries: leave the sub in place, log quietly
      }
    })
  );
}

/** Back-compat title/body sender (used by tests + goal-completed helper). */
export async function sendNotification(title: string, body: string): Promise<void> {
  await sendPushToAll({ title, body, tag: 'boof' });
}

export async function sendGoalCompletedNotification(
  goalName: string,
  nextGoalName?: string
): Promise<void> {
  const body = nextGoalName
    ? `Cycling to next goal: "${nextGoalName}"`
    : 'No more active goals — proposing new goals.';

  await sendPushToAll({
    title: `Goal completed: "${goalName}"`,
    body,
    tag: 'boof-goal',
    data: { url: '/goals' },
  });
}
