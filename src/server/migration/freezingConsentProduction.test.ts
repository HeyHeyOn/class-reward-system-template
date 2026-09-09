// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import * as production from './freezingConsentProduction';
vi.mock('server-only',()=>({}));
vi.mock('@/server/db/client',()=>({getDatabaseClient:()=>{throw Error('must not access database during configuration validation');}}));
afterEach(()=>vi.unstubAllEnvs());
it.each(['missing','origin','storage','registration','extra-registration','duplicate'])('production factory fails closed for %s configuration without fallback',mode=>{
 vi.stubEnv('CLASS_STORE_STORAGE','postgresql');vi.stubEnv('MIGRATION_GOOGLE_OAUTH_ORIGIN','https://store.example');vi.stubEnv('MIGRATION_GOOGLE_SHEET_REGISTRATIONS',JSON.stringify([{tenantId:'10000000-0000-4000-8000-000000000001',sourceId:'sheet',spreadsheetId:'raw-sheet'}]));
 if(mode==='missing')vi.stubEnv('MIGRATION_GOOGLE_SHEET_REGISTRATIONS','');if(mode==='origin')vi.stubEnv('MIGRATION_GOOGLE_OAUTH_ORIGIN','https://store.example/path');if(mode==='storage')vi.stubEnv('CLASS_STORE_STORAGE','sheets');if(mode==='registration')vi.stubEnv('MIGRATION_GOOGLE_SHEET_REGISTRATIONS','{}');if(mode==='extra-registration')vi.stubEnv('MIGRATION_GOOGLE_SHEET_REGISTRATIONS','[{"tenantId":"bad","sourceId":"sheet","spreadsheetId":"raw-sheet","authorized":true}]');if(mode==='duplicate'){const r=JSON.parse(process.env.MIGRATION_GOOGLE_SHEET_REGISTRATIONS!)[0];vi.stubEnv('MIGRATION_GOOGLE_SHEET_REGISTRATIONS',JSON.stringify([r,r]));}
 expect(()=>production.getProductionFreezingConsentHandlers()).toThrow('Freezing consent configuration refused.');
});
