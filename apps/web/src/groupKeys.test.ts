import { describe, expect, it } from 'vitest';
import {
  generateGroupKey,
  generateIdentityKeyPair,
  seal,
  toBase64Url,
  wrapKeyTo,
  type WrappedKeyDto,
} from '@spendapp/shared';
import { absorbInto, toRing, type HeldKey, type Keyring } from './groupKeys';

/**
 * What a server may and may not talk this client into.
 *
 * The attack these exist for: the server holds every member's public key, so
 * it can wrap a key *it* generated to anyone. If a client adopts whatever
 * arrives with the highest epoch number, everything written afterwards is
 * sealed under a key the server chose. Chaining each epoch to the one before
 * it is what makes that impossible — the proof takes the previous key, which
 * the server has never held.
 */

const GROUP = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const chainAad = (groupId: string, epoch: number) =>
  new TextEncoder().encode(`spendapp/key-chain/v1|${groupId}|${epoch}`);

const me = generateIdentityKeyPair();

/** A wrap as it arrives from sync, optionally chained to `previous`. */
async function delivery(
  epoch: number,
  key: Uint8Array,
  previous?: Uint8Array,
  opts: { groupId?: string; corrupt?: boolean } = {},
): Promise<WrappedKeyDto> {
  const w = await wrapKeyTo(me.publicKey, key);
  const dto: WrappedKeyDto = {
    groupId: GROUP,
    epoch,
    epk: toBase64Url(w.epk),
    iv: toBase64Url(w.iv),
    ct: toBase64Url(w.ciphertext),
  };
  if (previous) {
    // Corrupt: a proof that opens but names a different key, which is what a
    // server splicing its own key into a real lineage would produce.
    const claimed = opts.corrupt ? generateGroupKey() : key;
    const chain = await seal(previous, claimed, chainAad(opts.groupId ?? GROUP, epoch));
    dto.chainIv = toBase64Url(chain.iv);
    dto.chainCt = toBase64Url(chain.ciphertext);
  }
  return dto;
}

const ring = (entries: [number, HeldKey][] = []): Keyring => new Map(entries);
const writable = (r: Keyring): number | null => {
  const t = [...r].filter(([, h]) => h.trusted).map(([e]) => e);
  return t.length ? Math.max(...t) : null;
};

describe('taking group keys from the server', () => {
  it('trusts the whole keyring a new member is handed', async () => {
    // Joining with full history: every epoch arrives at once and there is no
    // earlier key to chain the first one to. The approval is the anchor.
    const keys = [generateGroupKey(), generateGroupKey(), generateGroupKey()];
    const r = ring();
    const added = await absorbInto(r, GROUP, me.privateKey, [
      await delivery(0, keys[0]!),
      await delivery(1, keys[1]!, keys[0]),
      await delivery(2, keys[2]!, keys[1]),
    ]);
    expect(added.sort()).toEqual([0, 1, 2]);
    expect([...r.values()].every((h) => h.trusted)).toBe(true);
    expect(writable(r)).toBe(2);
  });

  it('trusts the single epoch a history-scoped invite grants', async () => {
    // They get epoch 7 and nothing before it — by design, so the ledger starts
    // from today. There is no predecessor and never will be, so requiring a
    // chain here would leave them unable to write at all.
    const key = generateGroupKey();
    const r = ring();
    const added = await absorbInto(r, GROUP, me.privateKey, [await delivery(7, key)]);
    expect(added).toEqual([7]);
    expect(r.get(7)!.trusted).toBe(true);
    expect(writable(r)).toBe(7);
  });

  it('keeps writing under keys held before chaining existed', async () => {
    // Backwards compatibility: a device that already has epochs 0-2 from the
    // old scheme must not suddenly have nothing it may write under.
    const held = ring([
      [0, { key: generateGroupKey(), trusted: true }],
      [1, { key: generateGroupKey(), trusted: true }],
      [2, { key: generateGroupKey(), trusted: true }],
    ]);
    expect(writable(held)).toBe(2);
    // And an unchanged sync of those same epochs changes nothing.
    const added = await absorbInto(held, GROUP, me.privateKey, [await delivery(0, held.get(0)!.key)]);
    expect(added).toEqual([]);
    expect(writable(held)).toBe(2);
  });

  it('adopts a rotation that chains to the epoch it replaces', async () => {
    const epoch2 = generateGroupKey();
    const r = ring([[2, { key: epoch2, trusted: true }]]);
    const epoch3 = generateGroupKey();
    await absorbInto(r, GROUP, me.privateKey, [await delivery(3, epoch3, epoch2)]);
    expect(r.get(3)!.trusted).toBe(true);
    expect(writable(r)).toBe(3);
  });

  it('will not write under an epoch the server invented', async () => {
    // The attack. The server wraps its own key to us at max+1 with no proof,
    // because it cannot make one without epoch 2.
    const epoch2 = generateGroupKey();
    const r = ring([[2, { key: epoch2, trusted: true }]]);
    const serverKey = generateGroupKey();
    const added = await absorbInto(r, GROUP, me.privateKey, [await delivery(3, serverKey)]);

    expect(added).toEqual([3]); // held, so anything sealed under it stays readable
    expect(r.get(3)!.trusted).toBe(false);
    // The half that matters: nothing new is sealed under the server's key.
    expect(writable(r)).toBe(2);
  });

  it('drops an epoch whose proof names a different key', async () => {
    const epoch2 = generateGroupKey();
    const r = ring([[2, { key: epoch2, trusted: true }]]);
    const added = await absorbInto(r, GROUP, me.privateKey, [
      await delivery(3, generateGroupKey(), epoch2, { corrupt: true }),
    ]);
    // Not merely unproved — a lineage was claimed and it was false.
    expect(added).toEqual([]);
    expect(r.has(3)).toBe(false);
    expect(writable(r)).toBe(2);
  });

  it('rejects a proof lifted from another group', async () => {
    const epoch2 = generateGroupKey();
    const r = ring([[2, { key: epoch2, trusted: true }]]);
    const epoch3 = generateGroupKey();
    const added = await absorbInto(r, GROUP, me.privateKey, [
      await delivery(3, epoch3, epoch2, { groupId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }),
    ]);
    expect(added).toEqual([]);
    expect(writable(r)).toBe(2);
  });

  it('rejects a proof relabelled onto a different epoch', async () => {
    // The epoch number is a plaintext column, so it is the server's to change.
    const epoch2 = generateGroupKey();
    const r = ring([[2, { key: epoch2, trusted: true }]]);
    const real = await delivery(3, generateGroupKey(), epoch2);
    const relabelled = { ...real, epoch: 9 };
    const added = await absorbInto(r, GROUP, me.privateKey, [relabelled]);
    // It cannot even be unwrapped into epoch 9's slot with a valid proof.
    expect(r.get(9)?.trusted ?? false).toBe(false);
    expect(writable(r)).toBe(2);
    expect(added.length).toBeLessThanOrEqual(1);
  });

  it('still reads an unproved epoch, it just will not write under it', async () => {
    const epoch2 = generateGroupKey();
    const r = ring([[2, { key: epoch2, trusted: true }]]);
    const stray = generateGroupKey();
    await absorbInto(r, GROUP, me.privateKey, [await delivery(3, stray)]);
    // Entries a peer sealed under epoch 3 are still legible — refusing to hold
    // the key would turn a warning into missing data.
    expect(r.get(3)!.key).toEqual(stray);
  });

  it('recovers once a real member chains past the invented epoch', async () => {
    const epoch2 = generateGroupKey();
    const r = ring([[2, { key: epoch2, trusted: true }]]);
    await absorbInto(r, GROUP, me.privateKey, [await delivery(3, generateGroupKey())]);
    expect(writable(r)).toBe(2);

    // A member holding epoch 3? No — they hold 2, so their rotation is 3 for
    // them too. Once a proved 4 arrives chained to a proved 3, writing moves on.
    const real3 = generateGroupKey();
    const r2 = ring([[2, { key: epoch2, trusted: true }]]);
    await absorbInto(r2, GROUP, me.privateKey, [await delivery(3, real3, epoch2)]);
    const real4 = generateGroupKey();
    await absorbInto(r2, GROUP, me.privateKey, [await delivery(4, real4, real3)]);
    expect(writable(r2)).toBe(4);
  });

  it('reads a keyring stored before chaining as trusted', async () => {
    // The literal backwards-compatibility guarantee: rows on disk today carry
    // no `trusted` field, and must not come back as unwritable.
    const legacy = toRing([
      { epoch: 0, key: generateGroupKey() },
      { epoch: 1, key: generateGroupKey() },
    ]);
    expect([...legacy.values()].every((h) => h.trusted)).toBe(true);
    expect(writable(legacy)).toBe(1);

    // And an explicit false still means false, so a distrusted epoch survives
    // a reload rather than quietly becoming writable again.
    expect(writable(toRing([{ epoch: 5, key: generateGroupKey(), trusted: false }]))).toBe(null);
  });
});
