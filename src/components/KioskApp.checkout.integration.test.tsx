import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { KioskApp } from '@/components/KioskApp';
import { createCartPricingPreview } from '@/domain/checkout';
import { checkoutRecoveryKey } from '@/lib/checkoutRecovery';
import { createCheckoutPayloadHash } from '@/server/checkoutService';
import { createDatabaseCheckoutCommand } from '@/server/repositories/database/checkoutCommands';
import { createStudentBagCommands } from '@/server/repositories/database/studentBag';
import { createPgliteDatabaseHarness, type PgliteDatabaseHarness } from '@/server/db/testing/pglite';
vi.mock('server-only', () => ({}));
vi.mock('@/components/QrScanner', () => ({ QrScanner: ({ onScan }: { onScan: (value: string) => void }) => <button onClick={() => onScan('S001')}>합성 학생 QR 스캔</button> }));
let h: PgliteDatabaseHarness;
const products = [{ productId: 'P001', name: '연필', price: 300, stock: 20, isActive: true, sortOrder: 1 }];
const student = { studentId: 'S001', name: 'Synthetic student', status: 'ACTIVE', balance: 5000 };
const json = (body: unknown, status = 200) => Response.json(body, { status });
let requests: Array<Record<string, unknown>>;
let committed: Array<Record<string, unknown>>;
let loseFirst: boolean;
let failVouchers: boolean;
let lostOutcome: 'throw' | 'server-error' | 'invalid-success';
beforeEach(async () => {
  sessionStorage.clear();
  requests = []; committed = []; loseFirst = false; failVouchers = false; lostOutcome = 'throw';
  h = await createPgliteDatabaseHarness();
  for (const file of ['0044_class_tree.sql','0045_student_bag.sql','0046_vouchers.sql','0047_tree_name.sql','0048_pets.sql','0049_growth_goals_and_pet_company.sql','0050_teacher_growth_adjustments.sql']) {
    await h.database.exec(await readFile(resolve(process.cwd(), 'src/server/db/migrations', file), 'utf8'));
  }
  await h.database.exec('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_runtime');
  await h.database.exec('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_runtime');
  await h.database.query(`INSERT INTO students (tenant_id,student_id,name,status) VALUES ($1,'S001','Synthetic student','ACTIVE')`, [h.tenantOneId]);
  await h.database.query(`INSERT INTO accounts (tenant_id,student_id,balance) VALUES ($1,'S001',5000)`, [h.tenantOneId]);
  await h.database.query(`INSERT INTO products (tenant_id,product_id,name,price,stock,is_active,sort_order) VALUES ($1,'P001','연필',300,20,true,1)`, [h.tenantOneId]);
  const bag = createStudentBagCommands({ tenantId: h.tenantOneId, runTenantTransaction: h.runTenantTransaction });
  await bag.giveItems({ studentIds: ['S001'], productId:'P001', count:1, operationId: 'synthetic-gift' });
  const command = createDatabaseCheckoutCommand({ tenantId: h.tenantOneId, runTenantTransaction: h.runTenantTransaction });
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/products') return json(products);
    if (url === '/api/settings') return json({currencyUnit:'별',appTitle:'Synthetic store',themeColor:'pink',qrManualInputEnabled:true,source:'runtime'});
    if (url === '/api/promotions/active') return json([]);
    if (url === '/api/bag/digital-products') return json({products:[]});
    if (url === '/api/students/S001' || url === '/api/students/csq1.synthetic-bearer') return json(student);
    if (url === '/api/students/S002') return json({...student,studentId:'S002'});
    if (url === '/api/checkout/preview') return json(createCartPricingPreview({products,cartItems:JSON.parse(String(init?.body)).items}));
    if (url === '/api/checkout/vouchers') return failVouchers ? json({error:'Synthetic transient lookup failure'},500) : json({vouchers:await bag.checkoutVouchers('S001',['P001'])});
    if (url === '/api/checkout') {
      const body = JSON.parse(String(init?.body)); requests.push(body);
      const canonical = {...body,studentId:'S001',operator:'kiosk'};
      const result = await command.execute({...canonical,payloadHash:createCheckoutPayloadHash(canonical)});
      if (result.ok) committed.push(result);
      if (loseFirst && requests.length === 1) {
        if (lostOutcome === 'server-error') return json({error:'Synthetic gateway failure'},503);
        if (lostOutcome === 'invalid-success') return json({});
        throw new TypeError('Synthetic response loss after successful commit');
      }
      return json(result,result.ok ? 200 : 409);
    }
    return json({error:'not found'},404);
  }));
});
afterEach(async () => { cleanup(); sessionStorage.clear(); vi.unstubAllGlobals(); await h?.close(); });
async function scan(qrValue = 'S001') {
  fireEvent.change(screen.getByLabelText('QR 값 직접 입력'), {target:{value:qrValue}});
  fireEvent.click(screen.getByRole('button',{name:'QR 값으로 결제하기'}));
}
async function start(qrValue = 'S001') {
  render(<KioskApp />);
  fireEvent.click(await screen.findByRole('button',{name:'연필 300별 담기'}));
  fireEvent.click(screen.getByRole('button',{name:'연필 300별 담기'}));
  await waitFor(() => expect(screen.getByRole('button',{name:'QR 결제'})).toHaveProperty('disabled',false));
  fireEvent.click(screen.getByRole('button',{name:'QR 결제'}));
  await scan(qrValue);
}
it.each([
  { reopen: false, reload: false, outcome: 'throw' as const },
  { reopen: true, reload: false, outcome: 'throw' as const },
  { reopen: false, reload: false, outcome: 'server-error' as const },
  { reopen: false, reload: false, outcome: 'invalid-success' as const },
  { reopen: false, reload: true, outcome: 'throw' as const },
])('replays a committed voucher checkout exactly after $outcome (reopen=$reopen, reload=$reload)', async ({reopen,reload,outcome}) => {
  loseFirst = true;
  lostOutcome = outcome;
  await start(reload ? 'csq1.synthetic-bearer' : 'S001');
  const vouchers = await screen.findByRole('dialog',{name:'교환권 사용'});
  fireEvent.click(within(vouchers).getByRole('checkbox',{name:'연필 교환권 사용'}));
  fireEvent.click(within(vouchers).getByRole('button',{name:'사용 (1장)'}));
  let failure = await screen.findByRole('dialog',{name:'결제 상태 확인 필요'});
  if (reload) {
    const journal = sessionStorage.getItem(checkoutRecoveryKey());
    expect(journal).toContain(String(requests[0].operationId));
    expect(journal).not.toContain('csq1.synthetic-bearer');
    expect(journal).not.toContain(student.name);
    expect(journal).not.toContain('balance');
    cleanup();
    render(<KioskApp />);
    await screen.findByRole('heading', {name:'Synthetic store'});
    expect(screen.getByRole('button',{name:'연필 300별 담기'})).toHaveProperty('disabled',true);
    fireEvent.click(screen.getByRole('button',{name:'QR 결제'}));
    failure = await screen.findByRole('dialog',{name:'결제 상태 확인 필요'});
  }
  if (reopen) {
    fireEvent.click(within(failure).getByRole('button',{name:'닫기'}));
    expect(screen.getByRole('button',{name:'비우기'})).toHaveProperty('disabled',true);
    expect(screen.getByRole('button',{name:'새로고침'})).toHaveProperty('disabled',true);
    fireEvent.click(screen.getByRole('button',{name:'QR 결제'}));
    failure = await screen.findByRole('dialog',{name:'결제 상태 확인 필요'});
  }
  fireEvent.click(within(failure).getByRole('button',{name:'다시 시도'}));
  // Another student's scan must not replace the unresolved operation.
  fireEvent.change(screen.getByLabelText('QR 값 직접 입력'),{target:{value:'S002'}});
  fireEvent.click(screen.getByRole('button',{name:'QR 값으로 결제하기'}));
  failure = await screen.findByRole('dialog',{name:'결제 상태 확인 필요'});
  expect(requests).toHaveLength(1);
  fireEvent.click(within(failure).getByRole('button',{name:'다시 시도'}));
  fireEvent.click(screen.getByRole('button',{name:'합성 학생 QR 스캔'}));
  await screen.findByRole('dialog',{name:'결제 완료'});
  expect(requests).toHaveLength(2);
  expect(requests[1]).toEqual({...requests[0], studentId: 'S001'});
  expect(requests[0].voucherItemIds).toHaveLength(1);
  const checkoutCalls = vi.mocked(fetch).mock.calls.filter(([url]) => String(url)==='/api/checkout');
  if (!reload) expect(checkoutCalls[1][1]?.body).toBe(checkoutCalls[0][1]?.body);
  expect(sessionStorage.getItem(checkoutRecoveryKey())).toBeNull();
  expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url)==='/api/checkout/vouchers')).toHaveLength(1);
  expect(committed.map(result=>result.totalAmount)).toEqual([300,300]);
  expect(committed[0].transactionId).toBe(committed[1].transactionId);
  const state = (await h.database.query(`SELECT a.balance::int, p.stock::int, (SELECT count(*)::int FROM transactions WHERE tenant_id=$1 AND kind='CHECKOUT') AS checkouts FROM accounts a JOIN products p ON p.tenant_id=a.tenant_id WHERE a.tenant_id=$1 AND a.student_id='S001' AND p.product_id='P001'`,[h.tenantOneId])).rows[0];
  expect(state).toEqual({balance:4700,stock:18,checkouts:1});
});

it('does not submit a payment after voucher lookup failure and offers the voucher on retry', async () => {
  failVouchers = true;
  await start();
  const failure = await screen.findByRole('dialog',{name:'결제 실패'});
  expect(within(failure).getByText('교환권을 확인하지 못했어요. 결제는 되지 않았어요. 다시 시도해 주세요.')).toBeTruthy();
  expect(requests).toHaveLength(0);
  failVouchers = false;
  fireEvent.click(within(failure).getByRole('button',{name:'다시 시도'}));
  await scan();
  const vouchers = await screen.findByRole('dialog',{name:'교환권 사용'});
  fireEvent.click(within(vouchers).getByRole('checkbox',{name:'연필 교환권 사용'}));
  fireEvent.click(within(vouchers).getByRole('button',{name:'사용 (1장)'}));
  await screen.findByRole('dialog',{name:'결제 완료'});
  expect(requests).toHaveLength(1);
  expect(committed[0].totalAmount).toBe(300);
});
