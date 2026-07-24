import { z } from 'zod';

/** Zod boundary shared by client and server. Unknown fields are stripped. */

export const uuid = z.string().uuid();
export const currencyCode = z.string().regex(/^[A-Z]{3}$/, 'ISO 4217 code');
const minorAmount = z.number().int().safe();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');

export const registerSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(10).max(200),
  displayName: z.string().trim().min(1).max(80),
});

export const loginSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(200),
});

export const createGroupSchema = z.object({
  id: uuid,
  name: z.string().trim().min(1).max(120),
  defaultCurrency: currencyCode,
});

export const splitEntrySchema = z.object({
  userId: uuid,
  paidMinor: minorAmount.nonnegative(),
  owedMinor: minorAmount.nonnegative(),
});

export const splitMetaSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('equal'), userIds: z.array(uuid).min(1).max(100) }),
  z.object({
    mode: z.literal('exact'),
    entries: z.array(z.object({ userId: uuid, amountMinor: minorAmount.nonnegative() })).min(1).max(100),
  }),
  z.object({
    mode: z.literal('percent'),
    entries: z.array(z.object({ userId: uuid, percentBp: z.number().int().min(0).max(10_000) })).min(1).max(100),
  }),
  z.object({
    mode: z.literal('shares'),
    entries: z.array(z.object({ userId: uuid, shares: z.number().int().min(0).max(1_000_000) })).min(1).max(100),
  }),
]);

export const upsertExpenseSchema = z.object({
  id: uuid,
  groupId: uuid,
  description: z.string().trim().min(1).max(200),
  category: z.string().trim().min(1).max(40),
  note: z.string().max(2000).default(''),
  expenseDate: isoDate,
  currency: currencyCode,
  amountMinor: minorAmount.positive(),
  splitMeta: splitMetaSchema,
  splits: z.array(splitEntrySchema).min(1).max(100),
});

export const upsertPaymentSchema = z
  .object({
    id: uuid,
    groupId: uuid,
    fromUser: uuid,
    toUser: uuid,
    currency: currencyCode,
    amountMinor: minorAmount.positive(),
    // Cross-currency settlement (design §5); dormant until the M4 UI.
    settlesCurrency: currencyCode.nullable().default(null),
    rate: z
      .string()
      .regex(/^\d{1,10}(\.\d{1,8})?$/, 'decimal rate')
      .nullable()
      .default(null),
    settledMinor: minorAmount.positive().nullable().default(null),
    paidOn: isoDate,
    note: z.string().max(2000).default(''),
  })
  .refine((p) => p.fromUser !== p.toUser, { message: 'payer and receiver must differ' })
  .refine(
    (p) =>
      (p.settlesCurrency === null) === (p.settledMinor === null) &&
      (p.settlesCurrency === null) === (p.rate === null),
    { message: 'cross-currency fields must be set together' },
  );

export const CATEGORIES = [
  'food', 'groceries', 'transport', 'housing', 'utilities',
  'entertainment', 'travel', 'health', 'shopping', 'other',
] as const;

export type Register = z.infer<typeof registerSchema>;
export type Login = z.infer<typeof loginSchema>;
export type CreateGroup = z.infer<typeof createGroupSchema>;
export type UpsertExpense = z.infer<typeof upsertExpenseSchema>;
export type UpsertPayment = z.infer<typeof upsertPaymentSchema>;
export type SplitMeta = z.infer<typeof splitMetaSchema>;
