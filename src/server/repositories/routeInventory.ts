export type TenantRouteInventoryEntry = Readonly<{
  route: string;
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  scope: 'tenant-data' | 'platform' | 'unsupported';
  effect: 'read' | 'mutation' | 'none';
}>;

const tenantRead = (route: string, method: 'GET' | 'POST' = 'GET'): TenantRouteInventoryEntry =>
  ({ route, method, scope: 'tenant-data', effect: 'read' });
const tenantMutation = (
  route: string,
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE',
): TenantRouteInventoryEntry => ({ route, method, scope: 'tenant-data', effect: 'mutation' });
const platform = (
  route: string,
  method: TenantRouteInventoryEntry['method'],
  effect: 'read' | 'mutation',
): TenantRouteInventoryEntry => ({ route, method, scope: 'platform', effect });

export const TENANT_ROUTE_INVENTORY: readonly TenantRouteInventoryEntry[] = [
  platform('/admin/login', 'POST', 'mutation'),
  platform('/admin/logout', 'POST', 'mutation'),
  tenantRead('/bank/balance'),
  tenantRead('/bank/student'),
  tenantRead('/bank/tasks'),
  tenantMutation('/checkout', 'POST'),
  tenantRead('/checkout/preview', 'POST'),
  platform('/generator/create', 'POST', 'mutation'),
  platform('/google/callback', 'GET', 'read'),
  platform('/google/login', 'GET', 'read'),
  platform('/google/logout', 'POST', 'mutation'),
  platform('/google/session', 'GET', 'read'),
  tenantMutation('/products/[productId]', 'DELETE'),
  tenantMutation('/products/[productId]', 'PATCH'),
  tenantMutation('/products/batch', 'DELETE'),
  tenantMutation('/products/batch', 'PATCH'),
  tenantRead('/products'),
  tenantMutation('/products', 'POST'),
  tenantMutation('/promotions/[promotionId]', 'DELETE'),
  tenantMutation('/promotions/[promotionId]', 'PATCH'),
  tenantRead('/promotions/active'),
  tenantRead('/promotions'),
  tenantMutation('/promotions', 'POST'),
  platform('/qrcode', 'GET', 'read'),
  tenantRead('/settings'),
  { route: '/settings', method: 'PATCH', scope: 'unsupported', effect: 'none' },
  tenantMutation('/settings', 'POST'),
  tenantMutation('/students/[studentId]', 'DELETE'),
  tenantRead('/students/[studentId]'),
  tenantMutation('/students/[studentId]', 'PATCH'),
  tenantMutation('/students/batch', 'DELETE'),
  tenantMutation('/students/batch', 'PATCH'),
  tenantMutation('/students/bulk', 'PATCH'),
  tenantRead('/students'),
  tenantMutation('/students', 'POST'),
  tenantRead('/tasks/[taskId]/assignments'),
  tenantMutation('/tasks/[taskId]/assignments', 'PATCH'),
  tenantMutation('/tasks/[taskId]/complete', 'POST'),
  tenantRead('/tasks/[taskId]/history'),
  tenantMutation('/tasks/[taskId]', 'DELETE'),
  tenantRead('/tasks/[taskId]'),
  tenantMutation('/tasks/[taskId]', 'PATCH'),
  tenantMutation('/tasks/assignments/batch', 'POST'),
  tenantMutation('/tasks/batch', 'DELETE'),
  tenantMutation('/tasks/batch', 'PATCH'),
  tenantMutation('/tasks/completions/reset', 'POST'),
  tenantRead('/tasks'),
  tenantMutation('/tasks', 'POST'),
  tenantMutation('/tasks/schedules/batch', 'POST'),
  tenantMutation('/transactions/[transactionId]/cancel', 'POST'),
  tenantRead('/transactions'),
];
