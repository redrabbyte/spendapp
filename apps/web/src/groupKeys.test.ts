import { describe, expect, it } from 'vitest';
import {
  commitmentAad,
  deriveCommitmentKey,
  deriveEpochSas,
  deriveKeyringSas,
  generateGroupKey,
  generateIdentityKeyPair,
  keyFingerprint,
  open,
  seal,
  toBase64Url,
  wrapKeyTo,
  SAS_DIGITS,
  type WrappedKeyDto,
} from '@spendapp/shared';
import { absorbInto, ringsUniformIn, toRing, type HeldKey, type Keyring } from './groupKeys';

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
const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-00000000000a';
const OTHER_USER = 'aaaaaaaa-aaaa-4aaa-8aaa-00000000000b';
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
/**
 * The epochs a delivery added, which is what most of these assert on. The
 * rejections that come with a commitment are checked on the full result below.
 */
const absorb = async (...args: Parameters<typeof absorbInto>): Promise<number[]> =>
  (await absorbInto(...args)).added;
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
    const added = await absorb(r, GROUP, me.privateKey, [
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
    const added = await absorb(r, GROUP, me.privateKey, [await delivery(7, key)]);
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
    const added = await absorb(held, GROUP, me.privateKey, [await delivery(0, held.get(0)!.key)]);
    expect(added).toEqual([]);
    expect(writable(held)).toBe(2);
  });

  it('adopts a rotation that chains to the epoch it replaces', async () => {
    const epoch2 = generateGroupKey();
    const r = ring([[2, { key: epoch2, trusted: true }]]);
    const epoch3 = generateGroupKey();
    await absorb(r, GROUP, me.privateKey, [await delivery(3, epoch3, epoch2)]);
    expect(r.get(3)!.trusted).toBe(true);
    expect(writable(r)).toBe(3);
  });

  it('will not write under an epoch the server invented', async () => {
    // The attack. The server wraps its own key to us at max+1 with no proof,
    // because it cannot make one without epoch 2.
    const epoch2 = generateGroupKey();
    const r = ring([[2, { key: epoch2, trusted: true }]]);
    const serverKey = generateGroupKey();
    const added = await absorb(r, GROUP, me.privateKey, [await delivery(3, serverKey)]);

    expect(added).toEqual([3]); // held, so anything sealed under it stays readable
    expect(r.get(3)!.trusted).toBe(false);
    // The half that matters: nothing new is sealed under the server's key.
    expect(writable(r)).toBe(2);
  });

  it('drops an epoch whose proof names a different key', async () => {
    const epoch2 = generateGroupKey();
    const r = ring([[2, { key: epoch2, trusted: true }]]);
    const added = await absorb(r, GROUP, me.privateKey, [
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
    const added = await absorb(r, GROUP, me.privateKey, [
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
    const added = await absorb(r, GROUP, me.privateKey, [relabelled]);
    // It cannot even be unwrapped into epoch 9's slot with a valid proof.
    expect(r.get(9)?.trusted ?? false).toBe(false);
    expect(writable(r)).toBe(2);
    expect(added.length).toBeLessThanOrEqual(1);
  });

  it('still reads an unproved epoch, it just will not write under it', async () => {
    const epoch2 = generateGroupKey();
    const r = ring([[2, { key: epoch2, trusted: true }]]);
    const stray = generateGroupKey();
    await absorb(r, GROUP, me.privateKey, [await delivery(3, stray)]);
    // Entries a peer sealed under epoch 3 are still legible — refusing to hold
    // the key would turn a warning into missing data.
    expect(r.get(3)!.key).toEqual(stray);
  });

  it('recovers once a real member chains past the invented epoch', async () => {
    const epoch2 = generateGroupKey();
    const r = ring([[2, { key: epoch2, trusted: true }]]);
    await absorb(r, GROUP, me.privateKey, [await delivery(3, generateGroupKey())]);
    expect(writable(r)).toBe(2);

    // A member holding epoch 3? No — they hold 2, so their rotation is 3 for
    // them too. Once a proved 4 arrives chained to a proved 3, writing moves on.
    const real3 = generateGroupKey();
    const r2 = ring([[2, { key: epoch2, trusted: true }]]);
    await absorb(r2, GROUP, me.privateKey, [await delivery(3, real3, epoch2)]);
    const real4 = generateGroupKey();
    await absorb(r2, GROUP, me.privateKey, [await delivery(4, real4, real3)]);
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

  it('takes the epochs a returning member missed while they were away', async () => {
    // They left holding 0-1, the group rotated twice without them, and now the
    // whole ring is re-shared. The two they still hold are skipped server-side;
    // these two are the ones that decide whether they can see anything since.
    const held0 = generateGroupKey();
    const held1 = generateGroupKey();
    const r = ring([
      [0, { key: held0, trusted: true }],
      [1, { key: held1, trusted: true }],
    ]);
    const missed2 = generateGroupKey();
    const missed3 = generateGroupKey();
    const added = await absorb(r, GROUP, me.privateKey, [
      await delivery(2, missed2, held1),
      await delivery(3, missed3, missed2),
    ]);

    expect(added.sort()).toEqual([2, 3]);
    // Proved against the key they kept, so they may write again — without this
    // they would read the backlog and still post under a stale epoch.
    expect(r.get(2)!.trusted).toBe(true);
    expect(r.get(3)!.trusted).toBe(true);
    expect(writable(r)).toBe(3);
  });

  it('seals under the epoch it last held, until a newer one arrives', async () => {
    // An offline device does not know an epoch was minted, so this is what it
    // writes under at the time. It is not what finally goes up: the outbox is
    // re-sealed to the current epoch on the way out (see reseal.ts), so the
    // boundary is when the entry leaves the device, not when it was typed.
    const stale = generateGroupKey();
    const offline = ring([[2, { key: stale, trusted: true }]]);
    expect(writable(offline)).toBe(2);

    // The group moved on without them; until this arrives, 2 is still what
    // they write under.
    const rotated = generateGroupKey();
    await absorb(offline, GROUP, me.privateKey, [await delivery(3, rotated, stale)]);
    expect(writable(offline)).toBe(3);
  });
});

/**
 * The hole the chain does not cover: the *first* delivery to a device.
 *
 * Chaining proves an epoch came from someone holding the epoch before it, and
 * that is airtight once a ring exists. It says nothing when the ring is empty
 * — and an empty ring is not rare. It is every new device, every cleared
 * cache, and every re-unlock of an account that has been in the group for
 * years. Until commitments existed, all of those took whatever arrived first.
 *
 * A commitment is the account's own note about what a key was, sealed under
 * its KEK — derived from the password, never sent to the server. So the server
 * can store one, cannot read one, and above all cannot write one. These check
 * that the note wins.
 */
describe('the first delivery to an empty ring', () => {
  const commit = async (epoch: number, key: Uint8Array): Promise<[number, Uint8Array]> => [
    epoch,
    await keyFingerprint(key),
  ];

  it('refuses a key that contradicts what this account recorded holding', async () => {
    // The exploit, exactly: a second device asks for its keys, and the server
    // answers with epochs wrapped to the real public key — which it has — but
    // holding keys it generated itself.
    const real = [generateGroupKey(), generateGroupKey()];
    const forged = [generateGroupKey(), generateGroupKey()];
    const committed = new Map(await Promise.all([commit(0, real[0]!), commit(1, real[1]!)]));

    const r = ring();
    const { added, tampered } = await absorbInto(
      r,
      GROUP,
      me.privateKey,
      [await delivery(0, forged[0]!), await delivery(1, forged[1]!, forged[0])],
      committed,
    );

    // Not held at all, let alone written under. Holding it would leave the
    // forged key opening anything the server re-sealed under it.
    expect(added).toEqual([]);
    expect(r.size).toBe(0);
    expect(writable(r)).toBe(null);
    // And said out loud, rather than surfacing later as missing entries.
    expect(tampered.sort()).toEqual([0, 1]);
  });

  it('accepts the genuine keys on that same second device', async () => {
    // The other half: the check must not break the ordinary case it guards.
    const real = [generateGroupKey(), generateGroupKey()];
    const committed = new Map(await Promise.all([commit(0, real[0]!), commit(1, real[1]!)]));

    const r = ring();
    const { added, tampered } = await absorbInto(
      r,
      GROUP,
      me.privateKey,
      [await delivery(0, real[0]!), await delivery(1, real[1]!, real[0])],
      committed,
    );

    expect(added.sort()).toEqual([0, 1]);
    expect(tampered).toEqual([]);
    expect(writable(r)).toBe(1);
  });

  it('trusts a committed epoch that has no chain to stand on', async () => {
    // A history-scoped member holds epoch 7 and no predecessor, so there is
    // never a proof to check. Their own commitment is the better anchor
    // anyway: it was written while they held the key.
    const key = generateGroupKey();
    const committed = new Map([await commit(7, key)]);
    const r = ring();
    const { added } = await absorbInto(r, GROUP, me.privateKey, [await delivery(7, key)], committed);
    expect(added).toEqual([7]);
    expect(writable(r)).toBe(7);
  });

  it('will not let one forged epoch cost the member the rest of their ring', async () => {
    // Refusing the whole delivery on one bad row would hand the server a way
    // to lock somebody out of a group by tampering with a single epoch.
    const real = generateGroupKey();
    const committed = new Map([await commit(0, real), await commit(1, generateGroupKey())]);
    const r = ring();
    const { added, tampered } = await absorbInto(
      r,
      GROUP,
      me.privateKey,
      [await delivery(0, real), await delivery(1, generateGroupKey())],
      committed,
    );
    expect(added).toEqual([0]);
    expect(tampered).toEqual([1]);
    expect(writable(r)).toBe(0);
  });

  it('falls back to trusting the hand-over only where nothing was committed', async () => {
    // A genuine first join to a group this account has never held a key for.
    // There is nothing to check against and the approval is the anchor — the
    // pre-existing behaviour, kept, because the alternative is a new member
    // who cannot write.
    const keys = [generateGroupKey(), generateGroupKey()];
    const r = ring();
    const { added, tampered } = await absorbInto(
      r,
      GROUP,
      me.privateKey,
      [await delivery(0, keys[0]!), await delivery(1, keys[1]!, keys[0])],
      new Map(),
    );
    expect(added.sort()).toEqual([0, 1]);
    expect(tampered).toEqual([]);
    expect(writable(r)).toBe(1);
  });

  it('is not fooled by a commitment moved to another epoch or another user', async () => {
    // The AAD's job. The server stores these rows, so relabelling one is the
    // first thing it would try — and a commitment that opened under the wrong
    // label would vouch for a key it never saw.
    const key = generateGroupKey();
    const ck = await deriveCommitmentKey(me.privateKey);
    const sealed = await seal(ck, await keyFingerprint(key), commitmentAad(GROUP, 1, USER));

    await expect(open(ck, sealed, commitmentAad(GROUP, 2, USER))).rejects.toThrow();
    await expect(open(ck, sealed, commitmentAad(GROUP, 1, OTHER_USER))).rejects.toThrow();
    // And opens under its own label, so the check above is about the label.
    await expect(open(ck, sealed, commitmentAad(GROUP, 1, USER))).resolves.toBeDefined();
  });

  it('keeps its anchor across a password change', async () => {
    // The reason the commitment key comes from the identity private key and
    // not the KEK. Changing a password mints a new KEK but deliberately keeps
    // the keypair — every group key is wrapped to it — so a KEK-sealed
    // commitment would become unopenable, and unreplaceable, on the day
    // somebody changed their password. Silently: nothing would break until a
    // fresh device needed the anchor and found none.
    const before = await deriveCommitmentKey(me.privateKey);
    const after = await deriveCommitmentKey(me.privateKey);
    expect(after).toEqual(before);
    // And it is nobody else's: the server holds the public half only.
    expect(await deriveCommitmentKey(generateIdentityKeyPair().privateKey)).not.toEqual(before);
  });
});

describe('confirming a keyring out of band', () => {
  it('gives different digits for a different key', async () => {
    // What the join SAS cannot say. It authenticates the joiner's public key
    // to the admin; nothing authenticates the keys sent back, and on a first
    // join there is no commitment either. Reading these aloud is what closes
    // that, so two different keyrings must not produce the same number.
    const real = generateGroupKey();
    const mine = await deriveKeyringSas(GROUP, [[0, real]]);
    const theirs = await deriveKeyringSas(GROUP, [[0, generateGroupKey()]]);
    expect(mine).not.toBe(theirs);
    expect(mine).toHaveLength(SAS_DIGITS);
    expect(/^\d+$/.test(mine)).toBe(true);
  });

  it('does not depend on the order the epochs happen to arrive in', async () => {
    const a = generateGroupKey();
    const b = generateGroupKey();
    expect(await deriveKeyringSas(GROUP, [[0, a], [1, b]])).toBe(await deriveKeyringSas(GROUP, [[1, b], [0, a]]));
  });

  it('is scoped to its group, so one group cannot vouch for another', async () => {
    const key = generateGroupKey();
    expect(await deriveKeyringSas(GROUP, [[0, key]])).not.toBe(
      await deriveKeyringSas('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', [[0, key]]),
    );
  });
});

describe('confirming one epoch out of band', () => {
  it('gives different digits for a different key', async () => {
    // The case with nothing else behind it: on a hand-over `absorbInto` trusts
    // what arrives, so a server that substitutes the key at that moment is
    // caught by these digits or by nothing.
    const mine = await deriveEpochSas(GROUP, 3, generateGroupKey());
    const theirs = await deriveEpochSas(GROUP, 3, generateGroupKey());
    expect(mine).not.toBe(theirs);
    expect(mine).toHaveLength(SAS_DIGITS);
    expect(/^\d+$/.test(mine)).toBe(true);
  });

  it('is scoped to its epoch and its group', async () => {
    const key = generateGroupKey();
    // The same key at a different epoch is a different statement, so it must
    // not be possible to read one epoch's digits and accept them for another.
    expect(await deriveEpochSas(GROUP, 3, key)).not.toBe(await deriveEpochSas(GROUP, 4, key));
    expect(await deriveEpochSas(GROUP, 3, key)).not.toBe(
      await deriveEpochSas('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 3, key),
    );
  });

  it('cannot be confused with the keyring digits over the same single epoch', async () => {
    // Both derive from one key at one epoch. Without domain separation they
    // would be the same number, and a member could be walked into comparing a
    // keyring against an epoch and calling it a match.
    const key = generateGroupKey();
    expect(await deriveEpochSas(GROUP, 0, key)).not.toBe(await deriveKeyringSas(GROUP, [[0, key]]));
  });

  it('matches across members whose history differs, where the keyring digits cannot', async () => {
    // The bug this replaced. Everyone holds the newest epoch because rotation
    // wraps it to every member, so the epoch digits agree — while a from-today
    // member's keyring digits disagree with a founder's for a reason that is
    // not an attack, which is the false alarm that made the old check useless
    // to exactly the people most exposed.
    const older = generateGroupKey();
    const newest = generateGroupKey();
    const founder: [number, Uint8Array][] = [
      [0, older],
      [1, newest],
    ];
    const joinedToday: [number, Uint8Array][] = [[1, newest]];

    expect(await deriveEpochSas(GROUP, 1, newest)).toBe(await deriveEpochSas(GROUP, 1, newest));
    expect(await deriveKeyringSas(GROUP, founder)).not.toBe(await deriveKeyringSas(GROUP, joinedToday));
  });
});

describe('choosing which check to offer', () => {
  const held = (epoch: number, holders: number) => ({ epoch, holders, mine: true });

  it('offers the keyring digits when every member holds every epoch', () => {
    expect(ringsUniformIn([held(0, 3), held(1, 3)], 3)).toBe(true);
  });

  it('refuses them when somebody is missing an epoch', () => {
    // A from-today member: epoch 1 is wrapped to all three, epoch 0 to two.
    // This is the shape that made the old check misfire.
    expect(ringsUniformIn([held(0, 2), held(1, 3)], 3)).toBe(false);
  });

  it('refuses them when this device is not itself a holder', () => {
    expect(ringsUniformIn([{ epoch: 0, holders: 3, mine: false }, held(1, 3)], 3)).toBe(false);
  });

  it('refuses them when the epochs do not run from zero', () => {
    // Everyone agrees, but nobody holds epoch 0 any more — the history is not
    // whole, so digits claiming to cover it would overstate what was checked.
    expect(ringsUniformIn([held(1, 2), held(2, 2)], 2)).toBe(false);
    // And a gap in the middle is not whole either.
    expect(ringsUniformIn([held(0, 2), held(2, 2)], 2)).toBe(false);
  });

  it('is not fooled by a duplicated row standing in for a missing epoch', () => {
    // The server writes this payload. Counting rows alone would read two
    // copies of epoch 0 as covering epochs 0 and 1.
    expect(ringsUniformIn([held(0, 2), held(0, 2)], 2)).toBe(false);
  });

  it('refuses them when there is nothing to compare against', () => {
    expect(ringsUniformIn([], 3)).toBe(false);
    expect(ringsUniformIn([held(0, 0)], 0)).toBe(false);
  });
});
