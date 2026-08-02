import { randomUUID } from 'node:crypto';
import { test as base, type BrowserContext, type Route } from '@playwright/test';
import {
  createGroupSchema,
  syncRequestSchema,
  type GroupChanges,
  type MemberDto,
  type Mutation,
} from '@spendapp/shared';
import { z } from 'zod';

/**
 * A stand-in for the API.
 *
 * Request bodies are checked with the *same* zod schemas the server parses
 * with, and rejected the same way. A stub that accepts whatever the client
 * sends only tests the client against itself: that is exactly how a missing
 * client-generated group id reached production once already.
 *
 * It does not replace running against the real server — it cannot tell you
 * that a handler behaves correctly, only that the request was well formed.
 */

export const ME = { id: '11111111-1111-4111-8111-111111111111', email: 'me@example.com', displayName: 'Lukas' };

// Mirrors the server's own body schema for adding a placeholder member.
const addMemberSchema = z.object({ displayName: z.string().trim().min(1).max(80) });

export interface ApiState {
  signedIn: boolean;
  groups: Map<string, { id: string; name: string; defaultCurrency: string; version: number }>;
  members: Map<string, MemberDto[]>;
  activity: GroupChanges['activity'];
  /** Every mutation the client pushed, in order. */
  mutations: Mutation[];
  /** Bodies rejected by schema validation — a non-empty list is a failure. */
  rejected: { url: string; error: string }[];
}

export function createState(overrides: Partial<ApiState> = {}): ApiState {
  return {
    signedIn: true,
    groups: new Map(),
    members: new Map(),
    activity: [],
    mutations: [],
    rejected: [],
    ...overrides,
  };
}

export function seedGroup(
  state: ApiState,
  id: string,
  name: string,
  members: Pick<MemberDto, 'userId' | 'displayName' | 'isPlaceholder'>[],
): void {
  state.groups.set(id, { id, name, defaultCurrency: 'EUR', version: 1 });
  state.members.set(
    id,
    members.map((m) => ({ groupId: id, leftAt: null, version: 1, ...m })),
  );
}

function changesFor(state: ApiState): Record<string, GroupChanges> {
  const changes: Record<string, GroupChanges> = {};
  for (const [id, group] of state.groups) {
    changes[id] = {
      group,
      members: state.members.get(id) ?? [],
      expenses: [],
      payments: [],
      attachments: [],
      activity: state.activity.filter((a) => a.groupId === id),
      nextCursor: 0,
    };
  }
  return changes;
}

export async function installApi(context: BrowserContext, state: ApiState): Promise<void> {
  const json = (route: Route, body: unknown, status = 200): Promise<void> =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

  // Registering an empty service worker keeps precaching out of the tests;
  // a stale precache would serve a previous build's bundle.
  await context.route('**/sw.js', (r) => r.fulfill({ status: 200, contentType: 'text/javascript', body: '' }));

  await context.route('**/api/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    const method = req.method();
    const body = (): unknown => {
      const data = req.postData();
      return data ? (JSON.parse(data) as unknown) : {};
    };

    // Generic over the schema, not its output: zod defaults make a schema's
    // input and output types differ, and `ZodType<T>` collapses them.
    /** Reject like the server does, and record it so a test can assert on it. */
    const check = <S extends z.ZodTypeAny>(schema: S, value: unknown): z.output<S> | null => {
      const parsed = schema.safeParse(value);
      if (parsed.success) return parsed.data;
      const error = parsed.error.issues[0]?.message ?? 'invalid input';
      state.rejected.push({ url: path, error });
      void json(route, { error }, 400);
      return null;
    };

    if (path === '/api/me') {
      return state.signedIn ? json(route, ME) : json(route, { error: 'authentication required' }, 401);
    }
    if (path === '/api/auth/login' || path === '/api/auth/register') {
      state.signedIn = true;
      return json(route, ME);
    }
    if (path === '/api/auth/logout') {
      state.signedIn = false;
      return json(route, { ok: true });
    }

    if (path === '/api/groups' && method === 'POST') {
      const data = check(createGroupSchema, body());
      if (!data) return;
      seedGroup(state, data.id, data.name, [
        { userId: ME.id, displayName: ME.displayName, isPlaceholder: false },
      ]);
      state.groups.get(data.id)!.defaultCurrency = data.defaultCurrency;
      return json(route, data);
    }

    const memberMatch = /^\/api\/groups\/([^/]+)\/members$/.exec(path);
    if (memberMatch && method === 'POST') {
      const data = check(addMemberSchema, body());
      if (!data) return;
      const groupId = memberMatch[1]!;
      const list = state.members.get(groupId) ?? [];
      // A real uuid: split rows reference this id and the sync schema
      // requires uuids, so a made-up shape would be rejected downstream.
      const userId = randomUUID();
      list.push({ groupId, userId, displayName: data.displayName, leftAt: null, isPlaceholder: true, version: 1 });
      state.members.set(groupId, list);
      return json(route, { userId });
    }

    if (/^\/api\/groups\/[^/]+\/invites$/.test(path)) {
      return json(route, { token: 'tok', path: '/invite/tok' });
    }
    if (/^\/api\/invites\/[^/]+$/.test(path)) {
      const [groupId] = [...state.groups.keys()];
      const claimable = (state.members.get(groupId ?? '') ?? [])
        .filter((m) => m.isPlaceholder && m.leftAt === null)
        .map((m) => ({ userId: m.userId, displayName: m.displayName }));
      // The server withholds this list from anonymous callers.
      return json(route, {
        groupName: state.groups.get(groupId ?? '')?.name ?? 'Group',
        inviterName: 'Someone',
        claimable: state.signedIn ? claimable : [],
      });
    }

    if (path === '/api/sync') {
      const data = check(syncRequestSchema, body());
      if (!data) return;
      state.mutations.push(...data.mutations);
      // Mirror the server: import bookkeeping becomes an activity row.
      for (const m of data.mutations) {
        if (m.type === 'import.record') {
          state.activity.push({
            id: m.data.id,
            groupId: m.groupId,
            version: state.activity.length + 2,
            actorId: ME.id,
            type: 'import.created',
            entityType: 'import',
            entityId: m.data.id,
            payload: {
              source: m.data.source,
              expenseIds: m.data.expenseIds,
              paymentIds: m.data.paymentIds,
              count: m.data.expenseIds.length + m.data.paymentIds.length,
            },
            createdAt: new Date().toISOString(),
          });
        }
        if (m.type === 'import.revert') {
          state.activity.push({
            id: `revert-${state.activity.length}`,
            groupId: m.groupId,
            version: state.activity.length + 2,
            actorId: ME.id,
            type: 'import.reverted',
            entityType: 'import',
            entityId: m.data.importId,
            payload: {},
            createdAt: new Date().toISOString(),
          });
        }
      }
      return json(route, {
        protocol: { current: 1, minSupported: 1 },
        results: data.mutations.map((m) => ({ id: m.id, status: 'applied' as const })),
        changes: changesFor(state),
      });
    }

    return json(route, {});
  });
}

export const test = base.extend<{ api: ApiState }>({
  api: async ({ context }, use) => {
    const state = createState();
    await installApi(context, state);
    await use(state);
    // A body the server would have refused is a bug in the client, always.
    if (state.rejected.length > 0) {
      throw new Error(`API rejected ${state.rejected.length} request(s): ${JSON.stringify(state.rejected)}`);
    }
  },
});

export { expect } from '@playwright/test';
