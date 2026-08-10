import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import webpush from 'web-push';
import type { NotificationKind, PushPayload } from '@spendapp/shared';
import { config } from '../config.js';
import { db, schema } from '../db/index.js';

const enabled = Boolean(config.vapidPublicKey && config.vapidPrivateKey);
if (enabled) {
  webpush.setVapidDetails(config.vapidSubject, config.vapidPublicKey!, config.vapidPrivateKey!);
}

const MAX_FAILS = 5;

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

    await Promise.allSettled(
      subs.map(async (sub) => {
        try {
          await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            payload,
            { TTL: 86_400 },
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
      }),
    );
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
