// Trusted request context imports node:async_hooks, keeping this policy server-runtime-only.
// Like legacyDeploymentMode, it needs no application-policy mocks in direct route tests.
import { getOptionalTrustedTenantRequestContext } from './trustedTenantRequestContext';

/**
 * The per-cycle task writers under /api/tasks are kept for Google Sheets classes only.
 * PostgreSQL classes record task progress in the stage ledger (/api/task-ledger); the tenant
 * dispatcher does not route these writers for them (scope 'unsupported' in routeInventory).
 */
export class LegacyTaskWriterUnsupportedError extends Error {
  constructor() {
    super('Per-cycle task writers are Sheets-only; PostgreSQL classes use the task ledger.');
    this.name = 'LegacyTaskWriterUnsupportedError';
  }
}

/** In PostgreSQL mode answers like an unrouted tenant path; null keeps the Sheets writer running. */
export function legacyTaskWriterRefusal(): Response | null {
  if (!getOptionalTrustedTenantRequestContext()
    && process.env.CLASS_STORE_STORAGE?.trim().toLowerCase() !== 'postgresql') return null;
  return Response.json({ error: 'Not found.' }, { status: 404 });
}
