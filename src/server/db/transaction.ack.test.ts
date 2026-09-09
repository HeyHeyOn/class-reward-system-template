// @vitest-environment node
import { expect,it,vi } from 'vitest';
import { createTenantTransactionRunner, type TenantTransaction } from './transaction';
vi.mock('server-only',()=>({}));
it('discards an uncertain COMMIT connection even when rollback acknowledges',async()=>{
 const failure=Error('local lost commit ACK');const release=vi.fn();const query=vi.fn(async(text:string)=>{if(text==='COMMIT')throw failure;return {rows:[]};});
 const run=createTenantTransactionRunner({pool:{connect:async()=>({query,release}) as never},createDatabase:()=>({}) as TenantTransaction},{maxAttempts:1});
 await expect(run('20000000-0000-4000-8000-000000000001',async()=>({privateHandle:true}))).rejects.toBe(failure);expect(release).toHaveBeenCalledWith(true);expect(query.mock.calls.filter(([q])=>q==='COMMIT')).toHaveLength(1);
});
