import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import webpush from 'web-push';
import type { NotificationKind, PushPayload } from '@spendapp/shared';
import { config } from '../config.js';
import { db, schema } from '../db/index.js';
import { isAllowedPushEndpoint } from './pushEndpoint.js';

const enabled = Boolean(config.vapidPublicKey && config.vapidPrivateKey);
if (enabled) {
  webpush.setVapidDetails(config.vapidSubject, config.vapidPublicKey!, config.vapidPrivateKey!);
}

const MAX_FAILS = 5;

/**
 * How many pushes are in flight at once.
 *
 * Without a cap this fans out one outbound request per subscription in a
 * group, all at the same moment. A slow or unresponsive endpoint then holds a
 * socket for the full timeout, and a large enough group is enough to exhaust
 * the process's outbound capacity while nothing looks wrong from outside.
 */
const MAX_IN_FLIGHT = 8;

/**
 * A hard wall-clock bound on one outbound push.
 *
 * `web-push`'s own `timeout` is a *socket* timeout — it fires on a connection
 * that goes quiet, which covers an endpoint that accepts and then says
 * nothing, but not one that dribbles a byte back just often enough to keep
 * resetting it. Both are things a registered endpoint can choose to do, so the
 * ceiling has to be on elapsed time as well.
 *
 * The push is not cancelled by this, because there is nothing here to cancel
 * it with; what it bounds is how long the slot is held, which is what turns a
 * slow endpoint into a denial of service against everybody else's
 * notifications.
 */
async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('push timed out')), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Run `work` over `items`, never more than `limit` at a time. */
async function pool<T>(items: T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++]!;
      await work(item).catch(() => {});
    }
  });
  await Promise.all(runners);
}

/**
 * Fire-and-forget push to an explicit set of users. Payloads are end-to-end
 * encrypted by the Web Push protocol. `url` is the in-app path the
 * notification opens; it must address the screen the notification is *about*,
 * since a tap that lands on the wrong tab makes the alert worthless. Dead
 * subscriptions (404/410 or repeated failures) are pruned.
 */
export function notifyUsers(
  userIds: string[],
  group: string,
  kind: NotificationKind,
  url: string,
  actor?: string,
): void {
  if (!enabled || userIds.length === 0) return;
  void (async () => {
    const subs = await db
      .select()
      .from(schema.pushSubscriptions)
      .where(inArray(schema.pushSubscriptions.userId, userIds));
    if (subs.length === 0) return;

    // A kind and the names, never a sentence: the server does not know what
    // language the reader picked, and the service worker does.
    const payload = JSON.stringify({ kind, group, actor, url } satisfies PushPayload);

    await pool(subs, MAX_IN_FLIGHT, async (sub) => {
      /**
       * Checked again on the way out, not only on the way in.
       *
       * Rows predating the allowlist are already in the table, and this is the
       * only place they turn into an actual outbound connection. Dropped
       * rather than skipped: the endpoint is one this server will never post
       * to again, so keeping the row would mean re-deciding this on every
       * notification for the life of the account.
       */
      if (!isAllowedPushEndpoint(sub.endpoint)) {
        await db.delete(schema.pushSubscriptions).where(eq(schema.pushSubscriptions.id, sub.id));
        return;
      }
      try {
        // Two bounds, because they catch different things: the socket timeout
        // below ends a connection that goes quiet, and the deadline around it
        // ends one that stays technically alive for longer than this is worth.
        await withDeadline(
          webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            payload,
            { TTL: 86_400, timeout: config.pushTimeoutMs },
          ),
          config.pushTimeoutMs * 2,
        );
        await db
          .update(schema.pushSubscriptions)
          .set({ lastSuccessAt: new Date(), failCount: 0 })
          .where(eq(schema.pushSubscriptions.id, sub.id));
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410 || sub.failCount + 1 >= MAX_FAILS) {
          await db.delete(schema.pushSubscriptions).where(eq(schema.pushSubscriptions.id, sub.id));
        } else {
          await db
            .update(schema.pushSubscriptions)
            .set({ failCount: sql`fail_count + 1` })
            .where(eq(schema.pushSubscriptions.id, sub.id));
        }
      }
    });
  })().catch(() => {});
}

/**
 * Fanout to every active group member except the actor. `path` defaults to the
 * group screen, but callers should pass the specific entity they are talking
 * about — a tap that lands on the wrong tab makes the alert worthless.
 */
export function notifyGroup(groupId: string, actorId: string, kind: NotificationKind, path?: string): void {
  if (!enabled) return;
  void (async () => {
    const groupRows = await db
      .select({ name: schema.groups.name })
      .from(schema.groups)
      .where(eq(schema.groups.id, groupId))
      .limit(1);
    const actorRows = await db
      .select({ displayName: schema.users.displayName })
      .from(schema.users)
      .where(eq(schema.users.id, actorId))
      .limit(1);
    const group = groupRows[0];
    if (!group) return;
    const actorName = actorRows[0]?.displayName ?? 'Someone';

    const members = await db
      .select({ userId: schema.groupMembers.userId })
      .from(schema.groupMembers)
      .where(
        and(
          eq(schema.groupMembers.groupId, groupId),
          isNull(schema.groupMembers.leftAt),
          ne(schema.groupMembers.userId, actorId),
        ),
      );
    if (members.length === 0) return;

    notifyUsers(members.map((m) => m.userId), group.name, kind, path ?? `/g/${groupId}`, actorName);
  })().catch(() => {});
}
