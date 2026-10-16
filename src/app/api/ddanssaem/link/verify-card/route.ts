import { answerLinkCall, getProductionLinkStore, resolveLinkCard } from '@/server/ddanssaem/linkRoute';

export const dynamic = 'force-dynamic';

/** App links 2-3: whose student QR card this is in the class, by the store and bank rule; a reissued card is 404. */
export async function POST(request: Request) {
  return answerLinkCall(request, 'card', async ({ sub, classId, card }) => {
    const student = await getProductionLinkStore().cardStudent(sub, classId!, card!, resolveLinkCard);
    return student ? { student } : null;
  });
}
