// @vitest-environment node
import { readFileSync, writeFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { reconcileLocalPreparedTransition, type LocalPreparedTransitionIntent } from '@/server/migration/localCandidateMaterialization';
import { coldConnections, witness, denyWrites } from './task19MixedCold';
import type { MutableChildRequest } from './task19MutableFixture';
vi.mock('server-only', () => ({}));
vi.mock('@/server/db/client', () => ({ getDatabaseClient: () => { throw new Error('DEFAULT_DATABASE_FORBIDDEN'); } }));
const path = process.env.PREPARED_RECOVERY_REQUEST;
if (path && !/^\.task19-prepared-recovery\/[0-9a-f-]{36}-request\.json$/.test(path)) throw new Error('Invalid synthetic request');
it.skipIf(!path)('Task19 prepared recovery independent cold child', async () => {
  if (process.env.RUN_REAL_POSTGRES !== '1') throw new Error('Owned PG required');
  const q: MutableChildRequest & { intent: LocalPreparedTransitionIntent; accepted: boolean } = JSON.parse(readFileSync(path!, 'utf8'));
  const connections = coldConnections({ ...q, phase:'retry',tombstone:false });
  try {
    const source = await connections.connect(q.source,'SOURCE'), destination = await connections.connect(q.destination,'DESTINATION');
    await denyWrites(source); await denyWrites(destination);
    const before = {source:await witness(source),destination:await witness(destination)};
    const outcome = await reconcileLocalPreparedTransition(q.intent,source.lease,destination.lease)
      .then(value => ({accepted:true,value,frozen:Object.isFrozen(value) && Object.isFrozen(value.receipt) && Object.isFrozen(value.intent.binding)}),
        error => ({accepted:false,error:(error as Error).message}));
    const after = {source:await witness(source),destination:await witness(destination)};
    expect(after).toEqual(before);
    writeFileSync(path!.replace('-request.json','-result.json'),JSON.stringify({pid:process.pid,backends:connections.backends,before,after,outcome}));
    expect(outcome.accepted,JSON.stringify(outcome)).toBe(q.accepted);
    if (!q.accepted) expect(outcome).toEqual({accepted:false,error:'Local prepared reconciliation refused.'});
  } finally { await connections.close(); }
},120_000);
