import 'server-only';
import { createHash } from 'node:crypto';
import { withTenantSnapshot, withTenantTransaction, type TenantTransaction } from '@/server/db/transaction';
import { hasSameOrigin } from '@/server/classMutationRequest';
import { getProductionClassStartRepository, type NewClassSetup } from '@/server/repositories/database/classStart';
import { getOptionalTrustedTenantRequestContext, type TrustedTenantRequestContext } from '@/server/trustedTenantRequestContext';
import {
  executeXlsxImportPlan, isEmptyXlsxImportTarget, readXlsxImportTargetCounts, XlsxImportConflictError, type XlsxImportCounts,
} from './xlsxImportExecutor';
import { buildXlsxImportPlan, type XlsxImportPlan } from './xlsxImportPlan';
import { readXlsxWorkbookGrid, XLSX_MAX_BYTES, XlsxImportInputError } from './xlsxWorkbook';

type Run = <T>(tenantId: string, callback: (tx: TenantTransaction) => Promise<T>) => Promise<T>;
export type XlsxImportDependencies = Readonly<{
  runTenantTransaction: Run;
  runTenantSnapshot: Run;
  getNewClassSetup: (slug: string, subject: string) => Promise<NewClassSetup | null>;
  getContext?: () => TrustedTenantRequestContext | undefined;
  now?: () => Date;
}>;
export type XlsxImportMode = 'start' | 'import';

const MAX_REQUEST_BYTES = XLSX_MAX_BYTES + 256 * 1024;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const PREVIEW_LIST_LIMIT = 500;
const NOT_EMPTY_MESSAGE = '이미 학생·상품·과제가 있는 학급이라 가져올 수 없어요. 새 학급을 만들어 그곳에서 가져와 주세요.';
const UNCERTAIN_MESSAGE = '가져오기 결과를 확인하지 못했어요. 같은 파일로 [가져오기]를 다시 누르면 이어서 확인해요.';

function reply(status: number, body: unknown): Response {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
}

class RequestRefusal extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

/** A step failed inside the import transaction, which therefore rolled back. */
class XlsxImportStepFailure extends Error {
  constructor(cause: unknown) {
    super('Xlsx import step failed.', { cause });
    this.name = 'XlsxImportStepFailure';
  }
}

type Admission = Readonly<{ context: TrustedTenantRequestContext; mode: XlsxImportMode; subject: string }>;

async function admit(request: Request, dependencies: XlsxImportDependencies): Promise<Admission> {
  const context = (dependencies.getContext ?? getOptionalTrustedTenantRequestContext)();
  if (!context) throw new RequestRefusal(404, 'Not found.');
  const { tenant, session, membership } = context;
  if (!session || !membership || membership.tenantId !== tenant.id || membership.googleSubject !== session.subject
    || (membership.role !== 'OWNER' && membership.role !== 'ADMIN')) {
    throw new RequestRefusal(403, '학급 관리자(구글 계정 로그인)만 자료를 가져올 수 있어요.');
  }
  const url = new URL(request.url);
  if (request.method !== 'POST' || url.search || !hasSameOrigin(request, url)
    || request.headers.get('sec-fetch-site') !== 'same-origin') {
    throw new RequestRefusal(403, '같은 사이트의 학급 화면에서 올려 주세요.');
  }
  if (tenant.lifecycle === 'DRAFT') {
    const setup = membership.role === 'OWNER' ? await dependencies.getNewClassSetup(tenant.slug, session.subject) : null;
    if (!setup || setup.lifecycle !== 'DRAFT') throw new RequestRefusal(403, '새 학급을 만든 선생님만 사용을 시작할 수 있어요.');
    return { context, mode: 'start', subject: session.subject };
  }
  if (tenant.lifecycle !== 'ACTIVE') throw new RequestRefusal(409, '지금은 이 학급에 자료를 가져올 수 없어요.');
  return { context, mode: 'import', subject: session.subject };
}

type Upload = Readonly<{ bytes: Uint8Array; fileName: string; fields: Readonly<Record<string, string>> }>;

async function readUpload(request: Request): Promise<Upload> {
  const contentType = request.headers.get('content-type') ?? '';
  if (!/^multipart\/form-data;\s*boundary=/i.test(contentType) || request.headers.has('content-encoding')) {
    throw new RequestRefusal(415, '파일을 다시 선택해 주세요.');
  }
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_REQUEST_BYTES)) {
    throw new RequestRefusal(413, '파일이 너무 커요. 10MB 이하의 .xlsx 파일만 올릴 수 있어요.');
  }
  const reader = request.body?.getReader();
  if (!reader) throw new RequestRefusal(400, '파일을 다시 선택해 주세요.');
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_REQUEST_BYTES) {
        await reader.cancel().catch(() => {});
        throw new RequestRefusal(413, '파일이 너무 커요. 10MB 이하의 .xlsx 파일만 올릴 수 있어요.');
      }
      parts.push(value);
    }
  } finally { reader.releaseLock(); }
  let form: FormData;
  try {
    form = await new Response(Buffer.concat(parts), { headers: { 'content-type': contentType } }).formData();
  } catch { throw new RequestRefusal(400, '파일을 다시 선택해 주세요.'); }
  const file = form.get('file');
  if (!file || typeof file === 'string') throw new RequestRefusal(400, '가져올 .xlsx 파일을 선택해 주세요.');
  if (!/\.xlsx$/i.test(file.name)) {
    throw new RequestRefusal(415, '엑셀(.xlsx) 파일만 올릴 수 있어요. 구글 시트에서 [파일 → 다운로드 → Microsoft Excel(.xlsx)]로 저장해 주세요.');
  }
  if (file.size > XLSX_MAX_BYTES) throw new RequestRefusal(413, '파일이 너무 커요. 10MB 이하의 .xlsx 파일만 올릴 수 있어요.');
  const fields: Record<string, string> = {};
  for (const [key, value] of form.entries()) if (key !== 'file' && typeof value === 'string') fields[key] = value;
  return { bytes: new Uint8Array(await file.arrayBuffer()), fileName: file.name.slice(0, 200), fields };
}

function digestOf(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function planFor(upload: Upload, now: Date): Promise<XlsxImportPlan> {
  const grid = await readXlsxWorkbookGrid(upload.bytes);
  return buildXlsxImportPlan(grid, { now: now.toISOString(), fileDigest: digestOf(upload.bytes) });
}

function scheduleLabel(task: XlsxImportPlan['tasks'][number]): string {
  const recurrence = task.schedule.recurrence;
  if (recurrence.type === 'NONE') return '반복 없음';
  if (recurrence.type === 'DAILY') return `매일 ${recurrence.time}`;
  if (recurrence.type === 'WEEKLY') return `매주 ${recurrence.weekdays.map(day => '월화수목금토일'[day - 1]).join('·')} ${recurrence.time}`;
  return `매월 ${recurrence.dayOfMonth}일 ${recurrence.time}`;
}

/** The teacher's own file content, echoed back for the confirmation step. */
export function projectXlsxImportPreview(plan: XlsxImportPlan, input: Readonly<{
  mode: XlsxImportMode; fileName: string; slug: string; target?: XlsxImportCounts;
}>) {
  const blocked = input.target && !isEmptyXlsxImportTarget(input.target) ? 'NOT_EMPTY' as const : null;
  return {
    ok: true as const, mode: input.mode, slug: input.slug, fileName: input.fileName, fileDigest: plan.fileDigest,
    canImport: plan.canImport && !blocked, blocked, ...(blocked ? { blockedMessage: NOT_EMPTY_MESSAGE } : {}),
    summary: plan.summary, issues: plan.issues,
    students: plan.students.slice(0, PREVIEW_LIST_LIMIT).map(({ studentId, name, balance, status }) => ({ studentId, name, balance, status })),
    products: plan.products.slice(0, PREVIEW_LIST_LIMIT).map(({ productId, name, price, stock, isActive }) => ({ productId, name, price, stock, isActive })),
    promotions: plan.promotions.slice(0, PREVIEW_LIST_LIMIT).map(({ promotionId, definition, productIds }) => ({
      promotionId, name: definition.name, isActive: definition.isActive, products: productIds.length })),
    tasks: plan.tasks.slice(0, PREVIEW_LIST_LIMIT).map(task => ({ taskId: task.taskId, title: task.title, reward: task.reward,
      isActive: task.isActive, schedule: scheduleLabel(task), ready: task.readyStudentIds.length, completed: task.completedStudentIds.length,
      prerequisiteTaskId: task.prerequisiteTaskId, availableFrom: task.availableFrom, dueAt: task.dueAt })),
  };
}

function refusalResponse(error: unknown): Response | null {
  if (error instanceof RequestRefusal) return reply(error.status, { error: error.message });
  if (error instanceof XlsxImportInputError) {
    return reply(error.code === 'TOO_LARGE' || error.code === 'TOO_MANY_CELLS' ? 413 : error.code === 'NOT_XLSX' ? 415 : 400,
      { error: error.message, code: error.code });
  }
  if (error instanceof XlsxImportConflictError) {
    if (error.code === 'NOT_EMPTY') return reply(409, { error: NOT_EMPTY_MESSAGE, code: error.code });
    if (error.code === 'START_REFUSED') return reply(403, { error: '새 학급을 만든 선생님만 사용을 시작할 수 있어요.', code: error.code });
    if (error.code === 'START_CONFLICT') {
      return reply(409, { error: '학급 상태가 바뀌었어요. 내 학급 목록에서 학급을 다시 열어 주세요.', code: error.code });
    }
    return reply(409, { error: '지금은 이 학급에 자료를 가져올 수 없어요.', code: error.code });
  }
  return null;
}

export type XlsxImportHandlers = Readonly<{
  preview(request: Request): Promise<Response>;
  commit(request: Request): Promise<Response>;
}>;

/**
 * Self-service "current state" import of a saved CRS Google Sheets workbook (.xlsx):
 * preview parses and validates without writing; commit re-reads the same file (its digest
 * must match the previewed one) and writes everything in ONE tenant transaction — for a new
 * DRAFT class together with the existing start function, so a failure leaves it untouched.
 */
export function createXlsxImportHandlers(dependencies: XlsxImportDependencies): XlsxImportHandlers {
  const now = () => dependencies.now?.() ?? new Date();
  return {
    async preview(request) {
      try {
        const admission = await admit(request, dependencies);
        const upload = await readUpload(request);
        const plan = await planFor(upload, now());
        const tenant = admission.context.tenant;
        const target = admission.mode === 'import'
          ? await dependencies.runTenantSnapshot(tenant.id, tx => readXlsxImportTargetCounts(tx, tenant.id)) : undefined;
        return reply(200, projectXlsxImportPreview(plan, { mode: admission.mode, fileName: upload.fileName, slug: tenant.slug, target }));
      } catch (error) {
        const refused = refusalResponse(error);
        if (refused) return refused;
        console.error('[xlsx-import] preview failed', error instanceof Error ? error.name : 'non-error throw');
        return reply(500, { error: '파일을 확인하지 못했어요. 잠시 후 다시 시도해 주세요.' });
      }
    },
    async commit(request) {
      let admission: Admission;
      let plan: XlsxImportPlan;
      let operationId: string;
      try {
        admission = await admit(request, dependencies);
        const upload = await readUpload(request);
        operationId = upload.fields.operationId ?? '';
        const expectedDigest = upload.fields.fileDigest ?? '';
        if (!UUID_V4.test(operationId) || !SHA256.test(expectedDigest)) throw new RequestRefusal(400, '가져오기 요청을 확인해 주세요. 파일을 다시 선택해 주세요.');
        if (digestOf(upload.bytes) !== expectedDigest) {
          throw new RequestRefusal(409, '미리보기한 파일과 다른 파일이에요. 파일을 다시 선택해 미리보기부터 해 주세요.');
        }
        plan = await planFor(upload, now());
        if (!plan.canImport) {
          return reply(422, { error: '파일에 고쳐야 할 내용이 있어 가져오지 않았어요.', issues: plan.issues });
        }
      } catch (error) {
        const refused = refusalResponse(error);
        if (refused) return refused;
        console.error('[xlsx-import] commit admission failed', error instanceof Error ? error.name : 'non-error throw');
        return reply(500, { error: '파일을 확인하지 못했어요. 잠시 후 다시 시도해 주세요.' });
      }
      const { tenant } = admission.context;
      try {
        const result = await dependencies.runTenantTransaction(tenant.id, async tx => {
          try {
            return await executeXlsxImportPlan(tx, { tenantId: tenant.id, plan, operationId,
              ...(admission.mode === 'start' ? { start: { slug: tenant.slug, subject: admission.subject } } : {}) });
          } catch (error) {
            if (error instanceof XlsxImportConflictError) throw error;
            throw new XlsxImportStepFailure(error);
          }
        });
        return reply(200, { ok: true, replayed: result.replayed, summary: plan.summary, adminHref: `/c/${tenant.slug}/admin`,
          message: '가져오기를 마쳤어요. 잔액은 그대로 옮겼고, 이전 거래 내역은 원본 파일에 남아 있어요.' });
      } catch (error) {
        const refused = refusalResponse(error);
        if (refused) return refused;
        // Internal guard messages carry no student data; never log the workbook or rows.
        const cause = error instanceof XlsxImportStepFailure ? error.cause : error;
        console.error('[xlsx-import] commit failed', cause instanceof Error ? `${cause.name}: ${cause.message.slice(0, 200)}` : 'non-error throw');
        if (error instanceof XlsxImportStepFailure) {
          return reply(500, { error: '가져오는 중에 문제가 생겨 아무것도 바꾸지 않았어요. 잠시 후 다시 시도하고, 계속되면 파일 내용을 확인해 주세요.', code: 'IMPORT_FAILED' });
        }
        return reply(503, { error: UNCERTAIN_MESSAGE, retryable: true });
      }
    },
  };
}

export function createConfiguredXlsxImport(): XlsxImportHandlers {
  return createXlsxImportHandlers({
    runTenantTransaction: withTenantTransaction,
    runTenantSnapshot: withTenantSnapshot,
    getNewClassSetup: (slug, subject) => getProductionClassStartRepository().getSetup(slug, subject),
  });
}
