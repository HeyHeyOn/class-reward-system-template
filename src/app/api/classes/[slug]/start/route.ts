import { handleClassStart } from '@/server/classStart';
import { getProductionClassStartRepository } from '@/server/repositories/database/classStart';

export const runtime = 'nodejs';
export async function POST(request: Request, context: { params: Promise<{ slug: string }> }) {
  const { slug } = await context.params;
  return handleClassStart(request, slug, getProductionClassStartRepository());
}
