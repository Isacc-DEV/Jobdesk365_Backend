# Notification Bell Integration

This backend exposes:
- `GET /notifications?limit=20&cursor=...`
- `POST /notifications/mark-all-read`
- `POST /notifications/create`

Use this React example in your frontend app.

```tsx
import { useCallback, useEffect, useMemo, useState } from 'react';

type NotificationItem = {
  id: string;
  type: string;
  title: string;
  message: string;
  redirect_url: string;
  is_read: boolean;
  created_at: string;
};

type NotificationResponse = {
  items: NotificationItem[];
  next_cursor: string | null;
  has_unread: boolean;
  unread_count: number;
};

export function useNotifications(apiBaseUrl: string, token: string) {
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [hasUnread, setHasUnread] = useState(false);

  const fetchNotifications = useCallback(async () => {
    const res = await fetch(`${apiBaseUrl}/notifications?limit=20`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!res.ok) return;
    const data = (await res.json()) as NotificationResponse;
    setItems(data.items);
    setHasUnread(data.has_unread);
  }, [apiBaseUrl, token]);

  const markAllRead = useCallback(async () => {
    await fetch(`${apiBaseUrl}/notifications/mark-all-read`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` }
    });
    setItems((prev) => prev.map((item) => ({ ...item, is_read: true })));
    setHasUnread(false);
  }, [apiBaseUrl, token]);

  useEffect(() => {
    void fetchNotifications();
  }, [fetchNotifications]);

  return { items, hasUnread, fetchNotifications, markAllRead };
}

export function NotificationBell({
  apiBaseUrl,
  token
}: {
  apiBaseUrl: string;
  token: string;
}) {
  const [open, setOpen] = useState(false);
  const { items, hasUnread, fetchNotifications, markAllRead } = useNotifications(apiBaseUrl, token);

  const sortedItems = useMemo(
    () =>
      [...items].sort(
        (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      ),
    [items]
  );

  const formatRelativeTime = (iso: string) => {
    const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
    if (seconds < 60) return 'just now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
  };

  const onBellClick = async () => {
    const next = !open;
    setOpen(next);
    if (next) {
      await fetchNotifications();
    }
  };

  const onNotificationClick = async (item: NotificationItem) => {
    await markAllRead();
    window.location.href = item.redirect_url;
  };

  return (
    <div style={{ position: 'relative' }}>
      <button onClick={onBellClick} aria-label="Notifications">
        Bell
        {hasUnread ? <span style={{ background: 'red', borderRadius: 999, width: 8, height: 8 }} /> : null}
      </button>
      {open ? (
        <div style={{ position: 'absolute', right: 0, width: 360, background: '#fff', border: '1px solid #ddd' }}>
          {sortedItems.length === 0 ? (
            <div>No notifications</div>
          ) : (
            sortedItems.map((item) => (
              <button
                key={item.id}
                onClick={() => onNotificationClick(item)}
                style={{ display: 'block', width: '100%', textAlign: 'left' }}
              >
                <div>{item.title}</div>
                <div>{item.message}</div>
                <small>{formatRelativeTime(item.created_at)}</small>
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
```

UI behavior included above:
- Shows red badge when `hasUnread` is true.
- Refetches when the bell opens.
- Notification cards are clickable.
- Clicking a card marks all as read, clears badge, then redirects.
