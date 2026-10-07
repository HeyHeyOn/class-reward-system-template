import { handleClassCreation } from '@/server/classCreation';
import { getProductionClassCreationCommand } from '@/server/repositories/database/classCreation';
export const runtime = 'nodejs';
export async function POST(request: Request) {
  return handleClassCreation(request, getProductionClassCreationCommand());
}
