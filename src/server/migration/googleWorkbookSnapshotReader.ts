import 'server-only';
import { Readable } from 'node:stream';
import type { EphemeralMigrationAuthorization } from './googleSheetsConsent';
import { captureSheetsSnapshot, type WorkbookSnapshotReader } from './sheetsSnapshot';
import { isSensitiveTabName } from './sensitiveRedaction';
import { canonicalJson } from './validators';

const METADATA_BYTES = 128_000;
const VALUES_BYTES = 1_000_000;
const TOTAL_BYTES = 8_000_000;
const REQUEST_MS = 10_000;
const ACQUISITION_MS = 60_000;
type Metadata = {sheetId:number;title:string;sheetType:'GRID';gridProperties:{rowCount:number;columnCount:number}};
type Pass = {metadata:Metadata[];rows:Record<string,readonly (readonly unknown[])[]>};

/** Server composition only. Drive File.version reflects every server-side file
 * change (Drive v3 File documentation); unlike headRevisionId it covers Sheets.
 * Two complete equal passes plus equal real versions are bounded stability checks,
 * NOT cross-API atomicity, writer exclusion, consent or final-freeze authority.
 */
export function createGoogleWorkbookSnapshotReader(authorization: EphemeralMigrationAuthorization, spreadsheetId: string): WorkbookSnapshotReader {
  const {auth,expiresAt} = authorization;
  if (!/^[A-Za-z0-9_-]{1,512}$/.test(spreadsheetId)) refused();
  const id = encodeURIComponent(spreadsheetId);
  const deadline = Date.now()+ACQUISITION_MS;
  let totalBytes = 0;
  let initial: Promise<{version:string;pass:Pass}> | undefined;
  let revisionReads = 0;
  function current() {
    if (!Number.isSafeInteger(expiresAt) || Date.now() >= expiresAt! || Date.now() >= deadline) refused();
  }
  async function json(url:string, params:Readonly<Record<string,unknown>>, limit:number):Promise<Record<string,unknown>> {
    current();
    if (!auth.request) refused();
    const controller = new AbortController();
    let stream: Readable | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timedOut = new Promise<never>((_,reject) => {
        timer=setTimeout(()=>{controller.abort();stream?.destroy();reject(Error('Workbook read refused.'));},Math.min(REQUEST_MS,deadline-Date.now(),expiresAt!-Date.now()));
      });
      const read = async () => {
        const response = await auth.request!({url,method:'GET',params,responseType:'stream',timeout:REQUEST_MS,
          retry:false,maxRedirects:0,validateStatus:()=>true,signal:controller.signal});
        if (!(response.data instanceof Readable)) refused();
        stream = response.data;
        if (controller.signal.aborted) {stream.destroy();refused();}
        if (response.status !== 200) refused();
        // SDK streams are decoded; Content-Length still describes encoded wire bytes.
        // Accept only codings decoded by node-fetch, retaining conservative wire caps
        // and independent per-response/aggregate decoded streaming limits below.
        const encoding = response.headers?.get('content-encoding') ?? 'identity';
        if (!['identity','gzip','deflate','br'].includes(encoding)) refused();
        const contentLength = response.headers?.get('content-length');
        if (contentLength !== undefined && contentLength !== null && (!/^(0|[1-9][0-9]*)$/.test(contentLength)
          || BigInt(contentLength)>BigInt(limit) || BigInt(contentLength)>BigInt(TOTAL_BYTES-totalBytes))) refused();
        let bytes=0;
        const chunks:Buffer[]=[];
        for await (const chunk of stream) {
          current();
          if (!(typeof chunk==='string' || chunk instanceof Uint8Array)) refused();
          const buffer=Buffer.from(chunk);
          bytes+=buffer.byteLength;totalBytes+=buffer.byteLength;
          if(bytes>limit || totalBytes>TOTAL_BYTES) refused();
          chunks.push(buffer);
        }
        current();
        if(encoding==='identity' && contentLength && BigInt(contentLength)!==BigInt(bytes)) refused();
        return object(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      };
      return await Promise.race([read(),timedOut]);
    } catch { return refused(); }
    finally {if(timer)clearTimeout(timer);controller.abort();stream?.destroy();}
  }
  async function version():Promise<string> {
    const v=await json(`https://www.googleapis.com/drive/v3/files/${id}`,{fields:'id,mimeType,trashed,version',supportsAllDrives:true},METADATA_BYTES);
    if(v.id!==spreadsheetId || v.mimeType!=='application/vnd.google-apps.spreadsheet' || v.trashed!==false
      || typeof v.version!=='string' || !/^(0|[1-9][0-9]{0,18})$/.test(v.version) || BigInt(v.version)>BigInt('9223372036854775807')) refused();
    return v.version;
  }
  async function pass(revision:string):Promise<Pass> {
    const value=await json(`https://sheets.googleapis.com/v4/spreadsheets/${id}`,{includeGridData:false,
      fields:'spreadsheetId,sheets(properties(sheetId,title,sheetType,gridProperties(rowCount,columnCount)))'},METADATA_BYTES);
    if(value.spreadsheetId!==spreadsheetId || !Array.isArray(value.sheets) || value.sheets.length>64) refused();
    const titles=new Set<string>();const ids=new Set<number>();
    const metadata:Metadata[]=value.sheets.map(sheet=>{
      const p=object(object(sheet).properties);const grid=object(p.gridProperties);
      if(!Number.isSafeInteger(p.sheetId) || (p.sheetId as number)<0 || ids.has(p.sheetId as number)
        || typeof p.title!=='string' || !p.title || p.title.length>200 || titles.has(p.title) || p.sheetType!=='GRID'
        || !Number.isSafeInteger(grid.rowCount) || (grid.rowCount as number)<1
        || !Number.isSafeInteger(grid.columnCount) || (grid.columnCount as number)<1) refused();
      ids.add(p.sheetId as number);titles.add(p.title);
      return {sheetId:p.sheetId as number,title:p.title,sheetType:'GRID',gridProperties:{rowCount:grid.rowCount as number,columnCount:grid.columnCount as number}};
    });
    const rows:Pass['rows']=Object.create(null);
    for(const m of metadata) {
      if(isSensitiveTabName(m.title))continue;
      const range=encodeURIComponent(`'${m.title.replace(/'/g,"''")}'`);
      const result=await json(`https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${range}`,
        {majorDimension:'ROWS',valueRenderOption:'FORMATTED_VALUE',dateTimeRenderOption:'FORMATTED_STRING'},VALUES_BYTES);
      if (result.majorDimension!==undefined && result.majorDimension!=='ROWS') refused();
      const values=result.values===undefined?[]:result.values;
      if(!Array.isArray(values) || values.length>250_000) refused();
      for(const row of values) {
        if(!Array.isArray(row))refused();
        for(const cell of row)if(cell!==null && !['string','number','boolean'].includes(typeof cell))refused();
      }
      rows[m.title]=values;
      // Apply the existing acquisition limits while retaining each pass, not only
      // after buffering both passes. No credentials or rows are logged on failure.
      await enforceBudget(metadata,rows,revision,false);
    }
    await enforceBudget(metadata,rows,revision,true);
    return {metadata,rows};
  }
  async function enforceBudget(metadata:Metadata[], rows:Pass['rows'], revision:string, complete:boolean) {
    // Match the original snapshot's UTF-8 accounting exactly; a blanket reserve
    // would reject otherwise valid acquisitions immediately below its boundary.
    const capturedAt = new Date().toISOString();
    const credentialReserve = Buffer.byteLength(`adminPasswordHash${'scrypt$16384$8$1$'}${'a'.repeat(32)}$${'b'.repeat(64)}recoveryCodeHash${'c'.repeat(64)}`);
    let cells=0,bytes=Buffer.byteLength(spreadsheetId)+Buffer.byteLength(capturedAt)+Buffer.byteLength(revision)+credentialReserve;
    for(const m of metadata) {
      bytes+=64+Buffer.byteLength(m.title);
      for(const row of rows[m.title]??[]) {
        bytes+=96;cells+=row.length;
        for(const cell of row) {const text=String(cell??'');if(text.length>100_000)refused();bytes+=3+Buffer.byteLength(text);}
      }
    }
    if(cells>2_000_000||bytes>750_000)refused();
    if(complete)await captureSheetsSnapshot({spreadsheetId,capturedAt:new Date().toISOString(),reader:{
      getRevision:async()=>revision,listSheetNames:async()=>metadata.map(m=>m.title),getRows:async name=>rows[name]??[],
    }});
  }
  async function load() {
    try {
      const v0=await version();const a=await pass(v0);const v1=await version();
      if(v0!==v1)refused();
      const b=await pass(v0);const v2=await version();
      if(v0!==v2 || canonicalJson(a)!==canonicalJson(b))refused();
      return {version:v0,pass:a};
    } catch {return refused();}
  }
  const ready=()=>initial??=load();
  return {
    async getRevision(){
      const data=await ready();
      if(revisionReads++>0 && await version()!==data.version)refused();
      current();return data.version;
    },
    async listSheetNames(){current();return (await ready()).pass.metadata.map(m=>m.title);},
    async getRows(name){current();const rows=(await ready()).pass.rows[name];if(!rows)refused();return structuredClone(rows);},
  };
}
function object(v:unknown):Record<string,unknown> {if(!v||typeof v!=='object'||Array.isArray(v))refused();return v as Record<string,unknown>;}
function refused():never {throw Error('Workbook read refused.');}
