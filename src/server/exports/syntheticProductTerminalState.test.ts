// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { canonicalJson } from '@/server/migration/validators';
import { syntheticProductDeltaContract as c } from './syntheticProductDelta';
import { admitIntent, admitSeal, type ProductChainIntent } from './syntheticProductTerminalState';
import type { MaterializedArchiveExpectation } from '@/server/db/testing/materializedRestore';
vi.mock('server-only',() => ({}));
// Binding-parser unit witness only; the public API separately admits the full
// native expectation. Real source/parent admission is exercised in the PG suite.
const base={digest:c.sha('synthetic parser witness')} as MaterializedArchiveExpectation;
const pin={chainId:'20000000-0000-4000-8000-000000000001',parentIdentity:c.sha(canonicalJson(base))};
const intent:ProductChainIntent={profile:'SYNTHETIC_PRODUCT_INTENT_V1',...pin,sourceSystem:'12345678',counts:[2,2,2]};
describe('Task21 terminal state admission',() => {
  it('rejects a sparse plan before persisting an unrecoverable intent',() => {
    expect(() => admitIntent({...intent,counts:new Array<number>(2)},base,pin)).toThrow();
  });
  it.each([[],[0],[101],[1.5],Array(33).fill(1),[null]].map(counts => ({counts})))('rejects invalid bounded plan $counts',({counts}) => {
    expect(() => admitIntent({...intent,counts:counts as number[]},base,pin)).toThrow();
  });
  it('does not admit an internally coherent prefix seal against the original intent',() => {
    expect(() => admitSeal({profile:'SYNTHETIC_PRODUCT_TERMINAL_V1',intent,
      segments:[{segment:1,checkpoint:2,sha256:'a'.repeat(64)}]},base,pin)).toThrow();
  });
  it('admits a complete terminal only with exact planned cardinality and binding',() => {
    const seal={profile:'SYNTHETIC_PRODUCT_TERMINAL_V1' as const,intent,
      segments:[1,2,3].map(n => ({segment:n,checkpoint:n*2,sha256:c.sha(String(n))}))};
    expect(() => admitSeal(seal,base,pin)).not.toThrow();
    expect(() => admitSeal({...seal,segments:[...seal.segments,{segment:4,checkpoint:8,sha256:c.sha('4')}]},base,pin)).toThrow();
    expect(() => admitSeal(seal,base,{...pin,parentIdentity:'f'.repeat(64)})).toThrow();
  });
});
