import { logoutAdministrator } from '@/server/adminLogout';

export async function POST(request: Request) {
  return logoutAdministrator(request);
}
