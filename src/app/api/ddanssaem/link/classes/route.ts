import { answerLinkCall, getProductionLinkStore } from '@/server/ddanssaem/linkRoute';

export const dynamic = 'force-dynamic';

/** App links 2-1: the classes a teacher can connect a board to (not in the trash). */
export async function POST(request: Request) {
  return answerLinkCall(request, 'classes', async ({ sub }) => ({ classes: await getProductionLinkStore().classes(sub) }));
}
