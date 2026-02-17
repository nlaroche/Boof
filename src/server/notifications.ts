import webPush from 'web-push';
import fs from 'fs';
import path from 'path';

const VAPID_FILE = '.vapid-keys.json';

interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

let vapidKeys: VapidKeys | null = null;
const subscriptions: Set<webPush.PushSubscription> = new Set();

export function initNotifications(): VapidKeys | null {
  try {
    if (fs.existsSync(VAPID_FILE)) {
      vapidKeys = JSON.parse(fs.readFileSync(VAPID_FILE, 'utf-8'));
    } else {
      const keys = webPush.generateVAPIDKeys();
      vapidKeys = {
        publicKey: keys.publicKey,
        privateKey: keys.privateKey,
      };
      fs.writeFileSync(VAPID_FILE, JSON.stringify(vapidKeys, null, 2));
    }

    if (vapidKeys) {
      webPush.setVapidDetails(
        'mailto:boof@localhost',
        vapidKeys.publicKey,
        vapidKeys.privateKey
      );
    }

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
  subscriptions.add(subscription);
}

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
    // If subscription is gone (410 Gone), don't retry
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

export async function sendNotification(title: string, body: string): Promise<void> {
  const payload = JSON.stringify({ title, body });

  for (const sub of subscriptions) {
    try {
      await sendWithRetry(sub, payload);
    } catch {
      subscriptions.delete(sub);
    }
  }
}

export async function sendGoalCompletedNotification(
  goalName: string,
  nextGoalName?: string
): Promise<void> {
  const body = nextGoalName
    ? `Cycling to next goal: "${nextGoalName}"`
    : 'No more active goals — proposing new goals.';

  await sendNotification(`Goal completed: "${goalName}"`, body);
}
