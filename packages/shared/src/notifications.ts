/**
 * What a push notification is *about*, rather than what it says.
 *
 * The server used to compose the sentence, which meant it decided the reader's
 * language — and it has no idea what that is. It sends a kind plus the names
 * involved now, and the service worker writes the words in whatever language
 * the reader chose. Nothing new is revealed: the group and actor names were
 * already in the payload, and everything about the entry itself is still
 * absent by design (§3.3).
 */
export const NOTIFICATION_KINDS = [
  'expense.saved',
  'expense.deleted',
  'payment.recorded',
  'comment.added',
  'member.joined',
  'member.left',
  'member.removed',
  'join.requested',
  'join.approved',
  'you.removed',
  'you.promoted',
  'you.promoted.lastAdminLeft',
] as const;

export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/** The wire form of a push payload. */
export interface PushPayload {
  kind: NotificationKind;
  /** Group name — the notification title. */
  group: string;
  /** Who did it, for the kinds that name somebody. */
  actor?: string;
  /** In-app path the notification opens. */
  url: string;
}

export const isNotificationKind = (v: unknown): v is NotificationKind =>
  typeof v === 'string' && (NOTIFICATION_KINDS as readonly string[]).includes(v);
