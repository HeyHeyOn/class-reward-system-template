// @vitest-environment node
import { issueTeacherTestSession } from '@/server/db/testing/teacherIdentity';
import { currentLegalRevision } from '@/lib/legalDocuments';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { Pool, type PoolClient } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { describe, expect, it, vi } from 'vitest';
import type { TenantTransaction } from '@/server/db/transaction';
import { createDatabaseAdminCommands } from '@/server/repositories/database/adminCommands';
import { createDatabaseTransactionCommands } from '@/server/repositories/database/transactionCommands';
import { createDatabaseCheckoutCommand } from '@/server/repositories/database/checkoutCommands';
import { createDatabaseSettingsCommands } from '@/server/repositories/database/settingsCommands';
import { createDatabaseTaskCompletionCommand } from '@/server/repositories/database/taskCompletionCommands';
import { createTaskLedgerCommands } from '@/server/repositories/database/taskLedger/commands';
import { readTaskLedgerHistory } from '@/server/repositories/database/taskLedger/history';
import { createDatabasePadletClaimRepository } from '@/server/repositories/database/padletClaims';
import { createCartPricingPreview } from '@/domain/checkout';
import { createCheckoutPayloadHash } from '@/server/checkoutService';
import { createDisposablePostgres, type DisposablePostgres } from '@/server/db/testing/disposablePostgres';
vi.mock('server-only', () => ({}));
const isolated = process.env.RUN_REAL_POSTGRES === '1';
const suite = isolated || process.env.RUN_MANAGED_TEST_POSTGRES === '1' ? describe : describe.skip;

// Explicitly opt in to an operator-provisioned TEST runtime URL. No owner URL,
// fixture activation or schema mutation. All synthetic business data rolls back
// in the outer transaction; this verifies deployed ACLs, not Google identity.
// RUN_REAL_POSTGRES instead provisions the same ACL in an owned, networkless
// PostgreSQL container. It never reads an environment file or external URL.
suite('managed PostgreSQL ordinary runtime ACL', () => {
  it('enforces role isolation and executes purchase, reward, negative cancellation and replay', async () => {
    expect(process.env.DATABASE_URL).toBeUndefined();
    let disposable: DisposablePostgres | undefined;
    let pool: Pool | undefined;
    let client: PoolClient | undefined;
    try {
      if (isolated) {
        disposable = await createDisposablePostgres();
        // Remove the general test harness's broad baseline privileges first.
        // Production provisioning names crs_app_runtime; only the isolated
        // fixture's role name differs, not the granted objects or privileges.
        await disposable.owner.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM app_runtime;
          REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM app_runtime;
          REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM app_runtime;
          REVOKE ALL ON SCHEMA public FROM app_runtime`);
        await disposable.owner.query(readFileSync('src/server/db/provisioning/runtimeGrants.sql', 'utf8')
          .replace(/\bcrs_app_runtime\b/g, 'app_runtime'));
        pool = disposable.runtime;
      } else {
        const file = process.env.MANAGED_TEST_RUNTIME_ENV_FILE;
        if (!file) throw new Error('Explicit TEST runtime environment file required');
        const env = parseEnv(readFileSync(file, 'utf8'));
        if (!env.DATABASE_URL) throw new Error('Missing TEST runtime URL');
        const url = new URL(env.DATABASE_URL);
        expect(url.username).toBe('crs_app_runtime');
        expect(url.hostname).toMatch(/-pooler\.[a-z0-9.-]+\.neon\.tech$/);
        expect(url.searchParams.get('sslmode')).toBe('verify-full');
        pool = new Pool({ connectionString: url.toString(), max: 1, connectionTimeoutMillis: 20000 });
      }
      client = await pool.connect();
      const role = (await client.query('SELECT rolsuper,rolbypassrls,rolcreaterole,rolcreatedb,rolinherit FROM pg_roles WHERE rolname=current_user')).rows[0];
      expect(Object.values(role)).toEqual([false, false, false, false, false]);
      expect((await client.query('SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=current_user)')).rowCount).toBe(0);
      await client.query('BEGIN');
      const subject = `acl-smoke-${randomUUID()}`;
      const identity = await issueTeacherTestSession(client,{subject,email:`${subject}@example.invalid`});
      const binding = [identity.accountGeneration,identity.sessionId,currentLegalRevision().version];
      const created = (await client.query('SELECT * FROM platform_create_draft_class_authenticated($1,$2,$3,$4,$5,$6,$7)',
        [randomUUID(), subject, `${subject}@example.invalid`, 'Rollback-only ACL test',...binding])).rows[0];
      const tenantId = (await client.query('SELECT id FROM platform_find_tenant_by_slug($1)', [created.slug])).rows[0].id as string;
      await client.query('SELECT * FROM platform_start_new_class_authenticated($1,$2,$3,$4,$5,$6)', [randomUUID(), created.slug, subject,...binding]);
      const other = (await client.query('SELECT * FROM platform_create_draft_class_authenticated($1,$2,$3,$4,$5,$6,$7)',
        [randomUUID(), subject, `${subject}@example.invalid`, 'Rollback-only other class',...binding])).rows[0];
      const otherId = (await client.query('SELECT id FROM platform_find_tenant_by_slug($1)', [other.slug])).rows[0].id as string;
      const runTenantTransaction = async <T>(id: string, callback: (tx: TenantTransaction) => Promise<T>): Promise<T> => {
        await client!.query('SAVEPOINT command');
        try {
          await client!.query("SELECT set_config('app.tenant_id',$1,true)", [id]);
          const result = await callback(drizzle(client!) as TenantTransaction);
          await client!.query('RELEASE SAVEPOINT command'); return result;
        } catch (error) { await client!.query('ROLLBACK TO SAVEPOINT command'); await client!.query('RELEASE SAVEPOINT command'); throw error; }
      };
      const dependency = { tenantId, runTenantTransaction, now: () => new Date() };
      await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
      expect((await client.query('SELECT id FROM tenants WHERE id=$1', [otherId])).rowCount).toBe(0);
      expect((await client.query('UPDATE tenants SET id=id WHERE id=$1 RETURNING id', [otherId])).rowCount).toBe(0);
      const denied = async (sql: string) => {
        await client!.query('SAVEPOINT denied');
        await expect(client!.query(sql)).rejects.toMatchObject({ code: '42501' });
        await client!.query('ROLLBACK TO SAVEPOINT denied'); await client!.query('RELEASE SAVEPOINT denied');
      };
      await denied('CREATE TABLE public.runtime_must_not_create(id integer)');
      await denied('TRUNCATE accounts');
      await denied('SELECT * FROM legacy_full_snapshot_archives');
      await denied('SELECT * FROM legacy_redis_snapshot_archives');
      await denied('SELECT * FROM users');
      await denied(isolated ? 'SET ROLE postgres' : 'SET ROLE neondb_owner');
      await denied('UPDATE task_ledger_checkpoints SET stage=stage');
      await denied("SELECT refresh_tenant_task_ledger_checkpoints(current_setting('app.tenant_id')::uuid)");
      await denied("UPDATE tenants SET lifecycle='ACTIVE'");
      await client.query("INSERT INTO students(tenant_id,student_id,name,status) VALUES($1,'S1','Synthetic student','ACTIVE')", [tenantId]);
      await client.query("INSERT INTO accounts(tenant_id,student_id,balance) VALUES($1,'S1',100)", [tenantId]);
      await client.query("INSERT INTO products(tenant_id,product_id,name,price,stock) VALUES($1,'P1','Synthetic product',20,3)", [tenantId]);
      const settings = createDatabaseSettingsCommands(dependency);
      const current = await settings.get();
      await settings.save({ operationId: randomUUID(), expectedSettingsVersion: current.settingsVersion,
        currencyUnit: '별', appTitle: '테스트 매점', bankTitle: '테스트 은행', themeColor: 'white', fontFamily: 'default', qrManualInputEnabled: true });
      const items = [{ productId: 'P1', quantity: 1 }];
      const expectedPricing = createCartPricingPreview({ products: [{ productId: 'P1', name: 'Synthetic product', price: 20, stock: 3, isActive: true, sortOrder: 0 }], cartItems: items, now: new Date() });
      if (!expectedPricing.ok) throw new Error('Invalid synthetic cart');
      const purchaseInput = { operationId: randomUUID(), studentId: 'S1', operator: 'kiosk', items, expectedPricing };
      const purchase = await createDatabaseCheckoutCommand(dependency).execute({ ...purchaseInput, payloadHash: createCheckoutPayloadHash(purchaseInput) });
      if (!purchase.ok) throw new Error(`Purchase refused: ${purchase.code}`);
      expect(purchase.balanceAfter).toBe(80);
      const cancel = createDatabaseTransactionCommands(dependency);
      const purchaseCancel = { operationId: randomUUID(), transactionId: purchase.transactionId };
      expect((await cancel.cancel(purchaseCancel)).balanceAfter).toBe(100);
      expect((await cancel.cancel(purchaseCancel)).balanceAfter).toBe(100);
      expect((await client.query("SELECT stock FROM products WHERE tenant_id=$1 AND product_id='P1'", [tenantId])).rows[0].stock).toBe('3');
      const admin = createDatabaseAdminCommands(dependency);
      const credit = await admin.adjust({ operationId: randomUUID(), studentIds: ['S1'], mode: 'add', amount: 20 });
      await admin.adjust({ operationId: randomUUID(), studentIds: ['S1'], mode: 'set', amount: 5 });
      const creditTransaction = credit.students[0].transactionId;
      if (!creditTransaction) throw new Error('Missing synthetic credit ledger');
      const creditCancel = { operationId: randomUUID(), transactionId: creditTransaction };
      expect((await cancel.cancel(creditCancel)).balanceAfter).toBe(-15);
      expect((await cancel.cancel(creditCancel)).balanceAfter).toBe(-15);
      await expect(cancel.cancel({ ...creditCancel, operationId: randomUUID() })).rejects.toMatchObject({ code: 'ALREADY_REVERSED' });
      const ledger = createTaskLedgerCommands(dependency);
      await ledger.createTask({ operationId: randomUUID(), task: { title: 'Synthetic task', description: '', reward: 20,
        isActive: true, sortOrder: 0, availableFrom: null, dueAt: null, prerequisiteTaskId: null },
      repeat: { recurrence: { type: 'NONE' }, resetStage: null }, students: [{ studentId: 'S1', stage: 'READY' }] }, { taskId: 'T1' });
      const reward = await createDatabaseTaskCompletionCommand({ ...dependency, padletClaims: createDatabasePadletClaimRepository() })
        .execute({ operationId: randomUUID(), taskId: 'T1', studentId: 'S1' });
      expect(reward.balanceAfter).toBe(5);
      const rewardCancel = { operationId: randomUUID(), transactionId: reward.transactionId };
      expect((await cancel.cancel(rewardCancel)).balanceAfter).toBe(-15);
      expect((await cancel.cancel(rewardCancel)).balanceAfter).toBe(-15);
      const [task] = await ledger.readTasks(['T1']);
      expect(task.students.find((row) => row.studentId === 'S1')?.stage).toBe('READY');
      const history = await runTenantTransaction(tenantId, tx => readTaskLedgerHistory(tx, tenantId, 'T1'));
      expect(history.entries.map(entry => entry.cause)).toEqual(['CANCELLED', 'BANK', 'TEACHER']);
      await client.query('ROLLBACK');
      expect((await client.query('SELECT * FROM platform_list_memberships_by_google_subject($1)', [subject])).rows).toEqual([]);
      expect((await client.query('SELECT * FROM accounts')).rows).toEqual([]);
    } finally {
      if (client) { await client.query('ROLLBACK').catch(() => {}); client.release(); }
      if (disposable) await disposable.close(); else await pool?.end();
    }
  }, 120000);
});
