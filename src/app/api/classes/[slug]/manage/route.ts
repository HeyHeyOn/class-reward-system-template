import { handleClassManagement } from '@/server/classManagement';
import { getProductionClassManagementCommand } from '@/server/repositories/database/classDashboard';
export const runtime = 'nodejs';
export async function POST(request: Request, context: { params: Promise<{ slug: string }> }) {
  return handleClassManagement(request, (await context.params).slug, getProductionClassManagementCommand());
}
