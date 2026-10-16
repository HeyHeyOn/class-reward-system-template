import { answerLinkCall, getProductionLinkStore } from '@/server/ddanssaem/linkRoute';

export const dynamic = 'force-dynamic';

/** App links 2-2: the students in use of one of the teacher's classes; groups stay empty until 모둠 exist. */
export async function POST(request: Request) {
  return answerLinkCall(request, 'roster', ({ sub, classId }) => getProductionLinkStore().roster(sub, classId!));
}
