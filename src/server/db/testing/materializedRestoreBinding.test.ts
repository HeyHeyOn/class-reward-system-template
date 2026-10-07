// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DisposablePostgres } from './disposablePostgres';
import type { LocalCandidateBinding } from '@/server/migration/localCandidateMaterialization';
import { allocateRestoreTarget, backupMaterializedDatabase } from './materializedRestore';
import { inspectArchiveDatabase } from './ownedPgArchive';
vi.mock('server-only', () => ({}));
vi.mock('./ownedPgArchive', () => ({inspectArchiveDatabase:vi.fn(async () => { throw new Error('INFRASTRUCTURE_REACHED'); })}));
afterEach(() => vi.clearAllMocks());
const binding = ():LocalCandidateBinding => ({tenantId:'20000000-0000-4000-8000-000000000001',migrationJobId:'job',
  generationId:'generation',expectedStateVersion:'4',sourceFingerprint:'a'.repeat(64),manifestDigest:'b'.repeat(64)});
const db = {} as DisposablePostgres;
const entrypoints = {backup:(raw:LocalCandidateBinding) => backupMaterializedDatabase(db,randomUUID(),raw),
  destination:(raw:LocalCandidateBinding) => allocateRestoreTarget(db,randomUUID(),raw)};
for (const [name,invoke] of Object.entries(entrypoints)) describe(`archive binding ${name}`,() => {
  it.each(['prepared-label','symbol','inherited','array','null','accessor','proxy','boxed-digest','numeric-version','zero-version','unsafe-version'])
    ('refuses %s before infrastructure or caller code',async kind => {
      let raw:unknown = binding(), invoked = 0;
      const value = raw as LocalCandidateBinding;
      if (kind==='prepared-label') raw = {...value,status:'RECONCILING',stateVersion:'3',preparation:'PREPARED_STOP_REQUIRED'};
      if (kind==='symbol') raw = {...value,[Symbol('hidden')]:true};
      if (kind==='inherited') raw = Object.create(value);
      if (kind==='array') raw = Object.assign([],value);
      if (kind==='null') raw = null;
      if (kind==='accessor') Object.defineProperty(value,'manifestDigest',{enumerable:true,get() { invoked++; return invoked===1 ? 'b'.repeat(64) : 'c'.repeat(64); }});
      if (kind==='proxy') raw = new Proxy(value,{get(target,key,receiver) {invoked++; return Reflect.get(target,key,receiver);},ownKeys(target) {invoked++; return Reflect.ownKeys(target);}});
      if (kind==='boxed-digest') raw = {...value,manifestDigest:{toString() {invoked++; return 'b'.repeat(64);}}};
      if (kind==='numeric-version') raw = {...value,expectedStateVersion:4};
      if (kind==='zero-version') raw = {...value,expectedStateVersion:'04'};
      if (kind==='unsafe-version') raw = {...value,expectedStateVersion:'9007199254740992'};
      await expect(invoke(raw as LocalCandidateBinding)).rejects.toThrow('Local disposable PostgreSQL restore refused.');
      expect(inspectArchiveDatabase).not.toHaveBeenCalled(); expect(invoked).toBe(0);
    });
  it('admits the exact six-field binding through to infrastructure',async () => {
    await expect(invoke(binding())).rejects.toThrow('INFRASTRUCTURE_REACHED');
    expect(inspectArchiveDatabase).toHaveBeenCalledTimes(1);
  });
});
