// @vitest-environment node
import { readFileSync, writeFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { inspectLocalPointerCheckedPreparation } from '@/server/migration/localPointerCheckedPreparation';
import { materializeLocalCandidate, reconcileLocalPreparedTransition, type LocalPreparedTransitionIntent,
  type LocalCandidateBinding } from '@/server/migration/localCandidateMaterialization';
import { createOwnedLocalMaterializationRunner } from '@/server/migration/localMaterializationRunner';
import type { FinalGenerationPreparationInput } from '@/server/migration/finalGeneration';
import { coldConnections, witness, type MixedColdRequest } from './task19MixedCold';
vi.mock('server-only', () => ({}));
vi.mock('@/server/db/client', () => ({ getDatabaseClient: () => { throw new Error('DEFAULT_DATABASE_FORBIDDEN'); } }));
const path = process.env.TASK19_FINAL_RECONCILE_REQUEST;
if (path && !/^\.task19-final-reconcile\/[0-9a-f-]{36}-request\.json$/.test(path)) throw new Error('Invalid synthetic request');
it.skipIf(!path)('Task19 final source reconciliation cold readback', async () => {
  if (process.env.RUN_REAL_POSTGRES !== '1') throw new Error('Owned PG required');
  const q: Omit<MixedColdRequest,'phase'|'tombstone'|'binding'> & {
    phase:'pointer'|'materialize'|'prepared'; binding?:LocalCandidateBinding; intent?:LocalPreparedTransitionIntent;
  } = JSON.parse(readFileSync(path!, 'utf8'));
  const connections = coldConnections({...q,phase:'retry',tombstone:false});
  let result:Record<string,unknown> | undefined;
  try {
    const source = await connections.connect(q.source,'SOURCE'), destination = await connections.connect(q.destination,'DESTINATION');
    const before = {source:await witness(source),destination:await witness(destination)};
    // Reconstruct only from actual persisted captures, never from the editable
    // source or a caller-supplied local snapshot/manifest/MATCH assertion.
    const determine = async () => {
      if (q.phase==='pointer') {
        const rows = (await source.owner.query("SELECT redacted_details FROM audit_events WHERE event_type LIKE 'MIGRATION_PREPARATION_%'")).rows;
        expect(rows).toHaveLength(3);
        const original = rows.find(row => row.redacted_details.phase==='ORIGINAL_PREFLIGHT')!.redacted_details;
        const candidate = rows.find(row => row.redacted_details.phase==='FINAL_CANDIDATE')!.redacted_details;
        const input:FinalGenerationPreparationInput = {
          tenantId:original.tenantId,migrationJobId:original.migrationJobId,
          expectedStateVersion:candidate.binding.expectedStateVersion,
          originalSnapshotId:original.originalSnapshotId,originalSourceId:original.originalSourceId,
          exclusionGenerationReference:candidate.exclusionGenerationReference,
          original:original.acquisition,candidate:candidate.acquisition,
        };
        return inspectLocalPointerCheckedPreparation(input,source.lease.runTransaction);
      }
      if (q.phase==='prepared') return reconcileLocalPreparedTransition(q.intent!,source.lease,destination.lease);
      return materializeLocalCandidate(q.binding!,createOwnedLocalMaterializationRunner(q.binding!.tenantId,
        q.binding!.migrationJobId,source.lease,destination.lease));
    };
    const outcome = await determine().then(value => ({accepted:true,value}),error => ({accepted:false,error:(error as Error).message}));
    const after = {source:await witness(source),destination:await witness(destination)};
    expect(after.source).toBe(before.source);
    if (q.phase!=='materialize' || !outcome.accepted) expect(after).toEqual(before);
    result = {pid:process.pid,backends:connections.backends,before,after,outcome};
  } finally {
    await connections.close();
    if (result) writeFileSync(path!.replace('-request.json','-result.json'),JSON.stringify({...result,poolsClosed:true}),{flag:'wx',mode:0o600});
  }
},120_000);
