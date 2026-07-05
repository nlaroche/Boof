import { useState } from 'react';
import { notificationPermission, requestNotificationPermission } from '../lib/notify';

/**
 * Small opt-in affordance for browser notifications. We deliberately do NOT
 * request permission on load (that's a hostile pattern and browsers penalise
 * it) — the user taps this to grant it.
 */
export function NotificationToggle({ className = '' }: { className?: string }) {
  const [perm, setPerm] = useState(() => notificationPermission());

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
      onClick={async () => {
        const result = await requestNotificationPermission();
        setPerm(result);
      }}
    >
      &#128276; Enable alerts
    </button>
  );
}
