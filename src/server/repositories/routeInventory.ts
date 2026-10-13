export type TenantRouteInventoryEntry = Readonly<{
  route: string;
  method: 'GET' | 'HEAD' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  // tenant-status is a concrete, membership-gated endpoint, not a tenant-data dispatcher route.
  scope: 'tenant-data' | 'tenant-status' | 'platform' | 'unsupported';
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
  // Google identity + current OWNER/ADMIN membership; read-only BLOCKED/UNKNOWN.
  // No configured data authority, compatibility fallback, or catch-all exposure.
  { route: '/migrations/status/[slug]', method: 'GET', scope: 'tenant-status', effect: 'read' },
  // Historical archive only; HEAD repeats membership checks without a body.
  { route: '/migrations/status/[slug]/preflight', method: 'GET', scope: 'tenant-status', effect: 'read' },
  { route: '/migrations/status/[slug]/preflight', method: 'HEAD', scope: 'tenant-status', effect: 'read' },
  { route: '/migrations/status/[slug]/preflight/download', method: 'GET', scope: 'tenant-status', effect: 'read' },
  { route: '/migrations/status/[slug]/preflight/download', method: 'HEAD', scope: 'tenant-status', effect: 'read' },
  // NONAUTHORITY historical LOCAL_CANDIDATE metadata; GET/HEAD recheck membership.
  { route: '/exports/[slug]/historical-local-generation-metadata.csv', method: 'GET', scope: 'tenant-status', effect: 'read' },
  { route: '/exports/[slug]/historical-local-generation-metadata.csv', method: 'HEAD', scope: 'tenant-status', effect: 'read' },
  tenantRead('/migrations/[jobId]/freezing/reacquisition/bootstrap'),
  tenantRead('/migrations/[jobId]/freezing/reacquisition/[attemptId]'),
  tenantMutation('/migrations/[jobId]/freezing/reacquisition/challenge', 'POST'),
  tenantMutation('/migrations/[jobId]/freezing/reacquisition', 'POST'),
  platform('/internal/migrations/final-bridge', 'POST', 'mutation'),
  platform('/internal/migrations/freezing-reacquisition', 'POST', 'mutation'),
  tenantMutation('/migrations/[jobId]/freezing/consent/challenge', 'POST'),
  tenantMutation('/migrations/[jobId]/freezing/consent', 'POST'),
  { route: '/migrations/[jobId]/freezing/start/challenge', method: 'GET', scope: 'tenant-data', effect: 'mutation' },
  tenantMutation('/migrations/[jobId]/freezing/start', 'POST'),
  tenantRead('/migrations/[jobId]/freezing/start/[attemptId]'),
  platform('/migrations/google-sheets/callback', 'GET', 'mutation'),
  tenantMutation('/admin/login', 'POST'),
  platform('/admin/logout', 'POST', 'mutation'),
  // Teacher account (Google identity or a sign-in waiting for agreement): terms agreement, profile, withdrawal.
  platform('/account/agreement', 'POST', 'mutation'),
  platform('/account/agreement', 'DELETE', 'mutation'),
  platform('/account/profile', 'POST', 'mutation'),
  platform('/account/withdraw', 'POST', 'mutation'),
  tenantRead('/bank/balance'),
  tenantRead('/bank/balance', 'POST'),
  tenantRead('/bank/student'),
  tenantRead('/bank/tasks'),
  // Personal bank: the student comes only from the sealed session cookie, never from the client.
  tenantRead('/bank/session'),
  tenantMutation('/bank/session', 'POST'),
  tenantMutation('/bank/session', 'DELETE'),
  tenantRead('/bank/me/transactions'),
  tenantRead('/bank/me/tasks'),
  tenantMutation('/bank/me/tasks/[taskId]/complete', 'POST'),
  tenantRead('/bank/me/tree'),
  tenantMutation('/bank/me/tree/water', 'POST'),
  tenantRead('/bank/me/bag'),
  platform('/classes', 'POST', 'mutation'),
  platform('/classes/[slug]/start', 'POST', 'mutation'),
  platform('/classes/[slug]/manage', 'POST', 'mutation'),
  // Class apple tree: teacher board and commands (PostgreSQL classes only).
  tenantRead('/class-tree'),
  tenantMutation('/class-tree/settings', 'POST'),
  tenantMutation('/class-tree/feed', 'POST'),
  tenantMutation('/class-tree/harvest', 'POST'),
  tenantRead('/bank/me/pet'),
  tenantRead('/bank/me/pet/dex'),
  tenantMutation('/bank/me/pet/adopt', 'POST'),
  tenantMutation('/bank/me/pet/care', 'POST'),
  tenantMutation('/bank/me/pet/graduate', 'POST'),
  tenantMutation('/bank/me/pet/decor/buy', 'POST'),
  tenantMutation('/bank/me/pet/decor/place', 'POST'),
  tenantMutation('/bank/me/pet/companions', 'POST'),
  tenantMutation('/bank/me/pet/rename', 'POST'),
  tenantRead('/pets'),
  tenantMutation('/pets/settings', 'POST'),
  tenantMutation('/pets/rename', 'POST'),
  tenantMutation('/pets/growth', 'POST'),
  // Student bags (PostgreSQL classes only).
  tenantRead('/bag/students/[studentId]'),
  tenantMutation('/bag/items/use', 'POST'),
  tenantMutation('/bag/items/give', 'POST'),
  tenantMutation('/bag/items/revoke', 'POST'),
  tenantRead('/bag/digital-products'),
  tenantMutation('/bag/digital-products', 'POST'),
  tenantMutation('/checkout', 'POST'),
  tenantRead('/checkout/preview', 'POST'),
  tenantRead('/checkout/vouchers', 'POST'),
  platform('/generator/create', 'POST', 'mutation'),
  platform('/generator/grant', 'GET', 'read'),
  platform('/google/callback', 'GET', 'read'),
  platform('/google/login', 'GET', 'read'),
  platform('/google/logout', 'POST', 'mutation'),
  platform('/google/session', 'GET', 'read'),
  tenantMutation('/products/[productId]', 'DELETE'),
  tenantMutation('/products/[productId]', 'PATCH'),
  tenantMutation('/products/batch', 'DELETE'),
  tenantMutation('/products/batch', 'PATCH'),
  // Bulk xlsx import: static template, write-free preview, transactional commit (PostgreSQL only).
  tenantRead('/products/import/template'),
  tenantRead('/products/import/preview', 'POST'),
  tenantMutation('/products/import/commit', 'POST'),
  tenantRead('/products'),
  tenantMutation('/products', 'POST'),
  tenantMutation('/promotions/[promotionId]', 'DELETE'),
  tenantMutation('/promotions/[promotionId]', 'PATCH'),
  tenantRead('/promotions/active'),
  tenantRead('/promotions'),
  tenantMutation('/promotions', 'POST'),
  { route: '/qrcode', method: 'GET', scope: 'unsupported', effect: 'none' },
  tenantRead('/qrcode', 'POST'),
  platform('/qrcode/link', 'POST', 'read'),
  tenantRead('/settings'),
  { route: '/settings', method: 'PATCH', scope: 'unsupported', effect: 'none' },
  tenantMutation('/settings', 'POST'),
  tenantMutation('/students/[studentId]', 'DELETE'),
  tenantRead('/students/[studentId]'),
  tenantMutation('/students/[studentId]', 'PATCH'),
  tenantMutation('/students/batch', 'DELETE'),
  tenantMutation('/students/batch', 'PATCH'),
  tenantMutation('/students/bulk', 'PATCH'),
  tenantRead('/students/import/template'),
  tenantRead('/students/import/preview', 'POST'),
  tenantMutation('/students/import/commit', 'POST'),
  tenantRead('/students'),
  tenantMutation('/students', 'POST'),
  // Per-cycle task writer: kept for Sheets installs only, not routed for PostgreSQL classes.
  { route: '/tasks/[taskId]/assignments', method: 'GET', scope: 'unsupported', effect: 'none' },
  // Per-cycle task writer: kept for Sheets installs only, not routed for PostgreSQL classes.
  { route: '/tasks/[taskId]/assignments', method: 'PATCH', scope: 'unsupported', effect: 'none' },
  tenantMutation('/tasks/[taskId]/complete', 'POST'),
  // Per-cycle task writer: kept for Sheets installs only, not routed for PostgreSQL classes.
  { route: '/tasks/[taskId]/history', method: 'GET', scope: 'unsupported', effect: 'none' },
  // Per-cycle task writer: kept for Sheets installs only, not routed for PostgreSQL classes.
  { route: '/tasks/[taskId]', method: 'DELETE', scope: 'unsupported', effect: 'none' },
  tenantRead('/tasks/[taskId]'),
  // Per-cycle task writer: kept for Sheets installs only, not routed for PostgreSQL classes.
  { route: '/tasks/[taskId]', method: 'PATCH', scope: 'unsupported', effect: 'none' },
  // Per-cycle task writer: kept for Sheets installs only, not routed for PostgreSQL classes.
  { route: '/tasks/assignments/batch', method: 'POST', scope: 'unsupported', effect: 'none' },
  // Per-cycle task writer: kept for Sheets installs only, not routed for PostgreSQL classes.
  { route: '/tasks/admin-completion', method: 'POST', scope: 'unsupported', effect: 'none' },
  // Per-cycle task writer: kept for Sheets installs only, not routed for PostgreSQL classes.
  { route: '/tasks/qr-assignment', method: 'POST', scope: 'unsupported', effect: 'none' },
  // Per-cycle task writer: kept for Sheets installs only, not routed for PostgreSQL classes.
  { route: '/tasks/batch', method: 'DELETE', scope: 'unsupported', effect: 'none' },
  // Per-cycle task writer: kept for Sheets installs only, not routed for PostgreSQL classes.
  { route: '/tasks/batch', method: 'PATCH', scope: 'unsupported', effect: 'none' },
  // Per-cycle task writer: kept for Sheets installs only, not routed for PostgreSQL classes.
  { route: '/tasks/completions/reset', method: 'POST', scope: 'unsupported', effect: 'none' },
  tenantRead('/tasks'),
  // Per-cycle task writer: kept for Sheets installs only, not routed for PostgreSQL classes.
  { route: '/tasks', method: 'POST', scope: 'unsupported', effect: 'none' },
  // Per-cycle task writer: kept for Sheets installs only, not routed for PostgreSQL classes.
  { route: '/tasks/schedules/batch', method: 'POST', scope: 'unsupported', effect: 'none' },
  tenantRead('/task-ledger'),
  tenantMutation('/task-ledger/tasks', 'POST'),
  tenantMutation('/task-ledger/tasks/delete', 'POST'),
  tenantMutation('/task-ledger/tasks/[taskId]', 'PATCH'),
  tenantRead('/task-ledger/tasks/[taskId]/history'),
  tenantMutation('/task-ledger/stages', 'POST'),
  tenantMutation('/task-ledger/reset', 'POST'),
  tenantMutation('/task-ledger/repeat', 'POST'),
  tenantMutation('/task-ledger/qr', 'POST'),
  tenantRead('/task-ledger/padlet'),
  tenantRead('/task-ledger/padlet/preview'),
  tenantMutation('/task-ledger/padlet/key', 'POST'),
  tenantMutation('/task-ledger/padlet/links', 'POST'),
  tenantMutation('/task-ledger/padlet/unlink', 'POST'),
  tenantMutation('/task-ledger/padlet/sync', 'POST'),
  tenantMutation('/transactions/[transactionId]/cancel', 'POST'),
  tenantRead('/transactions'),
  // Self-service CRS workbook (.xlsx) import: POST preview validates only; commit writes.
  tenantRead('/migrations/xlsx/preview', 'POST'),
  tenantMutation('/migrations/xlsx/commit', 'POST'),
];
