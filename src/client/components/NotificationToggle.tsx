import { useEffect, useState } from 'react';
import { notificationPermission, requestNotificationPermission } from '../lib/notify';
import { pushSupported, getPushState, subscribeToPush, unsubscribeFromPush, type PushState } from '../lib/push';

/**
 * Opt-in notification control with three levels:
 *   off          — no permission; tap to enable in-app + native alerts
 *   in-app       — permission granted (toasts + native alerts while page open);
 *                  tap to also enable background push (works when PWA is closed)
 *   in-app+push  — push subscribed; tap to turn push back off
 *
 * We never request permission on load (hostile pattern) — the user drives it.
 * When the browser can't do service-worker push we fall back to the old
 * in-app-only affordance.
 */
export function NotificationToggle({ className = '' }: { className?: string }) {
  const canPush = pushSupported();

  // Push-capable path: track the tri-state.
  const [state, setState] = useState<PushState>('off');
  const [busy, setBusy] = useState(false);

  // Non-push fallback path: mirror the previous permission-only behavior.
  const [perm, setPerm] = useState(() => notificationPermission());

  useEffect(() => {
    if (canPush) getPushState().then(setState).catch(() => setState('off'));
  }, [canPush]);

  // ── Fallback: browser without service-worker push ──
  if (!canPush) {
    if (perm === 'unsupported') return null;
    if (perm === 'granted') {
      return (
        <span className={`text-[10px] text-muted-foreground/60 ${className}`} title="Browser alerts enabled">
          &#128276; alerts on
        </span>
      );
    }
    if (perm === 'denied') {
      return (
        <span className={`text-[10px] text-muted-foreground/40 ${className}`} title="Alerts blocked in browser settings">
          &#128277; alerts blocked
        </span>
      );
    }
    return (
      <button
        className={`text-[10px] text-primary hover:underline ${className}`}
        onClick={async () => setPerm(await requestNotificationPermission())}
      >
        &#128276; Enable alerts
      </button>
    );
  }

  // ── Push-capable path ──
  if (Notification.permission === 'denied') {
    return (
      <span className={`text-[10px] text-muted-foreground/40 ${className}`} title="Alerts blocked in browser settings">
        &#128277; alerts blocked
      </span>
    );
  }

  if (state === 'in-app-push') {
    return (
      <button
        className={`text-[10px] text-primary hover:underline disabled:opacity-50 ${className}`}
        disabled={busy}
        title="Background push enabled — tap to turn push off (keeps in-app alerts)"
        onClick={async () => {
          setBusy(true);
          setState(await unsubscribeFromPush());
          setBusy(false);
        }}
      >
        &#128276; push on
      </button>
    );
  }

  // 'off' or 'in-app' — the next step is to enable background push
  // (subscribeToPush also requests permission if it isn't granted yet).
  const isInApp = state === 'in-app';
  return (
    <button
      className={`text-[10px] text-primary hover:underline disabled:opacity-50 ${className}`}
      disabled={busy}
      title={isInApp
        ? 'In-app alerts on — tap to also get push while the app is closed'
        : 'Enable alerts + background push'}
      onClick={async () => {
        setBusy(true);
        setState(await subscribeToPush());
        setBusy(false);
      }}
    >
      {isInApp ? <>&#128276; enable push</> : <>&#128276; Enable alerts</>}
    </button>
  );
}
