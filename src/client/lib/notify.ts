import { toast } from 'sonner';

type Severity = 'error' | 'warning' | 'info';

// The server `notify` event carries only title/body, so infer a severity from
// the wording to drive toast styling and (later) badge urgency.
export function notifySeverity(title: string, body: string): Severity {
  const text = `${title} ${body}`.toLowerCase();
  if (/fail|error|crash|exceed|dead|budget|blocked|conflict/.test(text)) return 'error';
  if (/pause|review|warn|needs|attention|stuck|retry|revis/.test(text)) return 'warning';
  return 'info';
}

export function notificationsSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

export function notificationPermission(): NotificationPermission | 'unsupported' {
  if (!notificationsSupported()) return 'unsupported';
  return Notification.permission;
}

export async function requestNotificationPermission(): Promise<NotificationPermission | 'unsupported'> {
  if (!notificationsSupported()) return 'unsupported';
  try {
    return await Notification.requestPermission();
  } catch (e) {
    console.error('[notify] permission request failed:', (e as Error).message);
    return Notification.permission;
  }
}

/**
 * Surface a server notification: always a severity-mapped in-app toast, plus a
 * native Web Notification when the page is hidden (phone in pocket / tab away)
 * and permission was granted from the settings affordance.
 */
export function showServerNotify(title: string, body: string): void {
  const severity = notifySeverity(title, body);
  const opts = { description: body } as const;
  if (severity === 'error') toast.error(title, opts);
  else if (severity === 'warning') toast.warning(title, opts);
  else toast.info(title, opts);

  if (
    notificationsSupported() &&
    Notification.permission === 'granted' &&
    typeof document !== 'undefined' &&
    document.hidden
  ) {
    try {
      new Notification(title, { body, tag: 'boof' });
    } catch (e) {
      console.error('[notify] Notification failed:', (e as Error).message);
    }
  }
}
