import { parseBoardTicketRequest } from '@/lib/boardLinkApi';
import { boardEnterUrl, boardTicket } from '@/server/ddanssaem/boardClient';
import { requestBoardLinks } from '@/server/repositories/configuredBoardLinks';
import { createConfiguredStudentBankReader } from '@/server/repositories/configuredStudentBank';
import { authenticateStudentBankRequest, confirmStudentBankStudent, studentBankJson, studentBankUnavailable } from '@/server/studentBankSession';
import { getOptionalTrustedTenantRequestContext } from '@/server/trustedTenantRequestContext';

export const dynamic = 'force-dynamic';

/**
 * App links 8-3: the student in this bank opens the 딴쌤 board their task links to, without signing in there.
 * The class signs a 60-second ticket for this student; the board checks it and lets them in as themselves.
 */
export async function POST(request: Request) {
  const auth = authenticateStudentBankRequest(request);
  if (!auth.ok) return auth.response;
  let taskId: string;
  try {
    if (request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') throw new Error('type');
    ({ taskId } = parseBoardTicketRequest(JSON.parse(await request.text())));
  } catch {
    return studentBankJson({ error: '요청 형식이 올바르지 않아요.', code: 'INVALID_REQUEST' }, { status: 400 });
  }
  try {
    const checked = await confirmStudentBankStudent(auth, await createConfiguredStudentBankReader(request));
    if (!checked.ok) return checked.response;
    const links = requestBoardLinks();
    const context = getOptionalTrustedTenantRequestContext();
    const board = links?.service.enabled() ? await links.service.boardForTask(taskId) : null;
    if (!links || !context || !board) return studentBankJson({ error: '연결된 보드를 찾지 못했어요.', code: 'BOARD_NOT_FOUND' }, { status: 404 });
    const ticket = boardTicket({ classId: context.tenant.id, studentId: checked.student.studentId, boardId: board.boardId });
    return studentBankJson({ url: boardEnterUrl(board.code, ticket) });
  } catch {
    return studentBankUnavailable();
  }
}
