import { describe, expect, it } from 'vitest';
import { fromBase64Url, generateGroupKey, open, seal, toBase64Url, type Mutation } from '@spendapp/shared';
import { resealMutation, type KeyLookup } from './reseal';

/**
 * Moving a queued write onto the current epoch.
 *
 * The entry in the outbox is the only copy — it is not on the server, which is
 * the whole reason it is queued. So the interesting cases here are not the
 * happy path but the ones where re-sealing must decline and leave the original
 * alone.
 */

const GROUP = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ACTIVITY = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const utf8 = (s: string) => new TextEncoder().encode(s);
const expenseAad = (id: string, g: string, e: number) => utf8(`expense|${id}|${g}|${e}`);
const snapshotAad = (a: string, g: string, e: number) => utf8(`snapshot|${a}|${g}|${e}`);

const KEYS = new Map<number, Uint8Array>([
  [2, generateGroupKey()],
  [3, generateGroupKey()],
]);
const keyFor: KeyLookup = async (e) => KEYS.get(e) ?? null;

async function sealAt(key: Uint8Array, aad: Uint8Array, plain: string) {
  const s = await seal(key, utf8(plain), aad);
  return { iv: toBase64Url(s.iv), ct: toBase64Url(s.ciphertext) };
}

const CONTENT = '{"amountMinor":1234,"splits":[{"userId":"u1","owed":1234}]}';
const SNAP = '{"version":1}';

async function queuedExpense(epoch = 2): Promise<Mutation> {
  const key = KEYS.get(epoch)!;
  return {
    id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    v: 1,
    type: 'expense.upsert',
    groupId: GROUP,
    clientTs: '2026-08-12T10:00:00.000Z',
    data: {
      id: ID,
      groupId: GROUP,
      keyEpoch: epoch,
      ...(await sealAt(key, expenseAad(ID, GROUP, epoch), CONTENT)),
      snapshot: {
        activityId: ACTIVITY,
        ...(await sealAt(key, snapshotAad(ACTIVITY, GROUP, epoch), SNAP)),
      },
    },
  } as unknown as Mutation;
}

const readAt = async (key: Uint8Array, aad: Uint8Array, env: { iv: string; ct: string }) =>
  new TextDecoder().decode(await open(key, { iv: fromBase64Url(env.iv), ciphertext: fromBase64Url(env.ct) }, aad));

describe('moving a queued write onto the current epoch', () => {
  it('re-seals the entry and its snapshot, content unchanged', async () => {
    const next = (await resealMutation(await queuedExpense(2), 3, keyFor))!;
    expect(next).not.toBeNull();
    const d = next.data as unknown as {
      keyEpoch: number;
      iv: string;
      ct: string;
      snapshot: { activityId: string; iv: string; ct: string };
    };
    expect(d.keyEpoch).toBe(3);

    // Opens under the new key, and says exactly what it said before.
    expect(await readAt(KEYS.get(3)!, expenseAad(ID, GROUP, 3), d)).toBe(CONTENT);
    expect(await readAt(KEYS.get(3)!, snapshotAad(ACTIVITY, GROUP, 3), d.snapshot)).toBe(SNAP);
    // The snapshot keeps its log row; the mutation still names it.
    expect(d.snapshot.activityId).toBe(ACTIVITY);
  });

  it('no longer opens under the key of the epoch it left', async () => {
    // The point of the exercise: whoever held epoch 2 cannot read this.
    const next = (await resealMutation(await queuedExpense(2), 3, keyFor))!;
    const d = next.data as unknown as { iv: string; ct: string };
    await expect(readAt(KEYS.get(2)!, expenseAad(ID, GROUP, 2), d)).rejects.toThrow();
    await expect(readAt(KEYS.get(2)!, expenseAad(ID, GROUP, 3), d)).rejects.toThrow();
  });

  it('leaves everything else about the mutation alone', async () => {
    const before = await queuedExpense(2);
    const after = (await resealMutation(before, 3, keyFor))!;
    expect(after.id).toBe(before.id);
    expect(after.type).toBe(before.type);
    expect(after.groupId).toBe(before.groupId);
    // Same mutation id, so the server still deduplicates a replay.
    expect((after as { clientTs: string }).clientTs).toBe((before as { clientTs: string }).clientTs);
  });

  it('declines when the key for the old epoch is gone', async () => {
    // Nothing can be opened, so nothing can be moved. Keeping the original is
    // the only safe answer: it is the only copy of this write.
    const orphan: KeyLookup = async (e) => (e === 3 ? KEYS.get(3)! : null);
    expect(await resealMutation(await queuedExpense(2), 3, orphan)).toBeNull();
  });

  it('declines when the new epoch is not held yet', async () => {
    const noTarget: KeyLookup = async (e) => (e === 2 ? KEYS.get(2)! : null);
    expect(await resealMutation(await queuedExpense(2), 3, noTarget)).toBeNull();
  });

  it('declines rather than corrupting when the blob will not open', async () => {
    // The failure that would actually lose data. A tampered or mis-keyed
    // envelope must come back null, never a half-built mutation.
    const broken = await queuedExpense(2);
    (broken.data as unknown as { ct: string }).ct = toBase64Url(new Uint8Array(48).fill(7));
    expect(await resealMutation(broken, 3, keyFor)).toBeNull();
  });

  it('declines when only the snapshot is unreadable', async () => {
    // Partial success is the worst outcome: an entry that uploads with a
    // snapshot nobody can open would break revert silently.
    const broken = await queuedExpense(2);
    (broken.data as unknown as { snapshot: { ct: string } }).snapshot.ct = toBase64Url(new Uint8Array(48).fill(9));
    expect(await resealMutation(broken, 3, keyFor)).toBeNull();
  });

  it('does nothing when the write is already current', async () => {
    expect(await resealMutation(await queuedExpense(3), 3, keyFor)).toBeNull();
  });

  it('does nothing to a mutation that carries no sealed content', async () => {
    const del = {
      id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      v: 1,
      type: 'expense.delete',
      groupId: GROUP,
      clientTs: '2026-08-12T10:00:00.000Z',
      data: { expenseId: ID },
    } as unknown as Mutation;
    expect(await resealMutation(del, 3, keyFor)).toBeNull();
  });

  it('moves an attachment by epoch alone, re-encrypting no image', async () => {
    // The bytes are sealed at upload from the mirror row's epoch, so there is
    // no ciphertext in the mutation to move — only the number.
    const att = {
      id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      v: 1,
      type: 'attachment.upsert',
      groupId: GROUP,
      clientTs: '2026-08-12T10:00:00.000Z',
      data: { id: ID, expenseId: ID, groupId: GROUP, keyEpoch: 2 },
    } as unknown as Mutation;
    const next = (await resealMutation(att, 3, keyFor))!;
    expect((next.data as unknown as { keyEpoch: number }).keyEpoch).toBe(3);
  });
});
