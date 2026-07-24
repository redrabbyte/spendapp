import type { SplitMeta } from '@spendapp/shared';

export interface Me {
  id: string;
  email: string | null;
  displayName: string;
}

export interface GroupInfo {
  id: string;
  name: string;
  defaultCurrency: string;
  members: { userId: string; displayName: string }[];
}

export interface ExpenseDto {
  id: string;
  groupId: string;
  description: string;
  category: string;
  note: string;
  expenseDate: string;
  currency: string;
  amountMinor: number;
  splitMeta: SplitMeta;
  createdBy: string;
  updatedAt: string;
  splits: { userId: string; paidMinor: number; owedMinor: number }[];
}
