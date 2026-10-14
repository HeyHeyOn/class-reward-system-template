import { legacyWriteFreezeResponse } from '@/server/legacyDeploymentMode';
import { legacyTaskWriterRefusal } from '@/server/legacyTaskWriters';

export const dynamic = 'force-dynamic';

// The signed-QR assignment only ever existed for PostgreSQL classes, which now use the task ledger
// (/api/task-ledger/qr). Sheets classes assign by QR through PATCH /api/tasks/{taskId}/assignments,
// so this path accepts nothing.
export async function POST() {
  const frozen = legacyWriteFreezeResponse();
  if (frozen) return frozen;
  const unsupported = legacyTaskWriterRefusal();
  if (unsupported) return unsupported;
  return Response.json({ code: 'ADMIN_REQUIRED', error: '학급 관리자 로그인이 필요해요.' }, { status: 401 });
}
