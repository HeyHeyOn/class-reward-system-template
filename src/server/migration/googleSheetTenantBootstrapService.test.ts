import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import type { GoogleSession } from '@/server/googleOAuth';
import { createGoogleSheetTenantBootstrapService } from '@/server/migration/googleSheetTenantBootstrapService';

const NOW = Date.parse('2026-09-04T03:00:00.000Z');
const sourceFingerprint = 'a'.repeat(64);
const session: GoogleSession = {
  subject: 'google-subject-owner',
  email: 'Teacher@Example.com',
  name: 'Teacher',
  issuedAt: NOW - 60_000,
};

function ownerEvidence(overrides: Record<string, unknown> = {}) {
  return {
    id: 'selected-sheet',
    mimeType: 'application/vnd.google-apps.spreadsheet',
    trashed: false,
    owners: [{ emailAddress: 'teacher@example.com' }],
    permissions: [{
      type: 'user',
      role: 'owner',
      emailAddress: 'teacher@example.com',
      deleted: false,
      pendingOwner: false,
    }],
    ...overrides,
  };
}

type DriveRequest = (options: {
  url: string;
  method?: string;
  params?: Readonly<Record<string, unknown>>;
}) => PromiseLike<{ data: unknown }>;

function migrationAuth(request: DriveRequest) {
  return {
    request,
    getToken: vi.fn(async () => ({ tokens: {} })),
    setCredentials: vi.fn(),
    revokeToken: vi.fn(async () => undefined),
  };
}

function bootstrapInput(auth: ReturnType<typeof migrationAuth>) {
  return {
    selectedSheetId: 'selected-sheet',
    session,
    slug: 'alpha-class',
    displayName: 'Alpha Class',
    sourceFingerprint,
    credentialHashes: { recoveryCodeHash: 'b'.repeat(64) },
    authorization: { auth, expiresAt: NOW + 60_000 },
  };
}

function successfulConnection(timeline: string[]) {
  const release = vi.fn(() => { timeline.push('release'); });
  const query = vi.fn(async (text: string) => {
    timeline.push(text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK'
      ? text
      : text.includes("set_config('app.tenant_id'")
        ? 'tenant-context'
        : text.match(/INSERT INTO (\w+)/)?.[1] ?? 'query');
    if (text.includes('INSERT INTO users')) {
      return {
        rows: [{
          id: 'user-one',
          google_subject: session.subject,
          canonical_email: session.email.toLowerCase(),
        }],
      };
    }
    return { rows: [] };
  });
  return { query, release };
}

describe('production Google Sheet tenant bootstrap composition', () => {
  it('reads and verifies the exact selected Sheet before opening the atomic bootstrap transaction', async () => {
    const timeline: string[] = [];
    const auth = migrationAuth(
      vi.fn(async (request: { url: string }) => {
        timeline.push(`drive:${request.url}`);
        return { data: ownerEvidence() };
      }),
    );
    const connection = successfulConnection(timeline);
    const pool = {
      connect: vi.fn(async () => {
        timeline.push('connect');
        return connection;
      }),
    };
    let nextId = 0;
    const service = createGoogleSheetTenantBootstrapService({
      pool,
      now: () => NOW,
      createId: () => `00000000-0000-4000-8000-${String(++nextId).padStart(12, '0')}`,
    });

    const result = await service(bootstrapInput(auth));

    expect(result).toMatchObject({
      slug: 'alpha-class',
      externalSourceId: 'selected-sheet',
      userId: 'user-one',
    });
    expect(timeline.slice(0, 4)).toEqual([
      'drive:https://www.googleapis.com/drive/v3/files/selected-sheet',
      'connect',
      'BEGIN',
      'tenant-context',
    ]);
    expect(timeline.at(-2)).toBe('COMMIT');
    expect(timeline.at(-1)).toBe('release');
    expect(connection.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO migration_sources'),
      expect.arrayContaining(['selected-sheet']),
    );
    expect(connection.query).toHaveBeenCalledWith(
      `SELECT set_config('app.tenant_id', $1, true)`,
      [result.tenantId],
    );
    expect(result).not.toHaveProperty('authorization');
    expect(result).not.toHaveProperty('accessToken');
    expect(result).not.toHaveProperty('refreshToken');
  });

  it.each([
    ['writer evidence', ownerEvidence({ permissions: [{ type: 'user', role: 'writer', emailAddress: 'teacher@example.com' }] })],
    ['mismatched file evidence', ownerEvidence({ id: 'different-sheet' })],
  ])('does not bootstrap when Drive returns %s', async (_label, data) => {
    const auth = migrationAuth(vi.fn(async () => ({ data })));
    const pool = { connect: vi.fn() };
    const service = createGoogleSheetTenantBootstrapService({ pool, now: () => NOW });

    await expect(service(bootstrapInput(auth))).rejects.toThrow(/verified Google Sheet control/i);

    expect(auth.request).toHaveBeenCalledWith(expect.objectContaining({
      url: 'https://www.googleapis.com/drive/v3/files/selected-sheet',
    }));
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it('rolls back and releases while preserving the bootstrap error when cleanup also fails', async () => {
    const primaryError = new Error('tenant insert failed');
    const release = vi.fn();
    const statements: string[] = [];
    const connection = {
      query: vi.fn(async (text: string) => {
        statements.push(text);
        if (text.includes('INSERT INTO users')) {
          return {
            rows: [{
              id: 'user-one',
              google_subject: session.subject,
              canonical_email: session.email.toLowerCase(),
            }],
          };
        }
        if (text.includes('INSERT INTO tenants')) throw primaryError;
        if (text === 'ROLLBACK') throw new Error('rollback failed');
        return { rows: [] };
      }),
      release,
    };
    const auth = migrationAuth(vi.fn(async () => ({ data: ownerEvidence() })));
    const service = createGoogleSheetTenantBootstrapService({
      pool: { connect: async () => connection },
      now: () => NOW,
    });

    await expect(service(bootstrapInput(auth))).rejects.toBe(primaryError);

    expect(statements.at(0)).toBe('BEGIN');
    expect(statements.at(-1)).toBe('ROLLBACK');
    expect(statements).not.toContain('COMMIT');
    expect(release).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledWith(true);
  });
});
