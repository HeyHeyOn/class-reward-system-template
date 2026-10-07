import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminManagePage } from './AdminManagePage';
import { findNotice, findTaskRow, openAdminMenu, openTaskEditor } from './testing/adminUi';
let bodies: string[];
const rows = [
  { taskId:'T1', taskInstanceId:'instance:T1', taskVersion:3, title:'Save One', description:'', reward:10, isActive:true, sortOrder:1, allowedStudentIds:[], createdAt:'2026-09-30T00:00:00.000Z' },
  { taskId:'T2', taskInstanceId:'instance:T2', taskVersion:8, title:'Save Two', description:'', reward:20, isActive:false, sortOrder:2, allowedStudentIds:[], createdAt:'2026-09-30T00:00:00.000Z' },
];
const schedule={recurrence:{type:'NONE'},timeZone:'Asia/Seoul',resetCompletionOnCycle:false,resetAssignmentOnCycle:false,ruleVersion:1,effectiveFrom:'2026-09-30T00:00:00.000Z'};
beforeEach(()=>{
  sessionStorage.clear(); bodies=[];
  window.history.replaceState(null,'','/admin');
  vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
    const url=String(input);
    if(url.endsWith('/tasks/batch')&&init?.method==='PATCH'){bodies.push(String(init.body));return Response.json(rows);}
    if(url.endsWith('/tasks?includeInactive=1'))return Response.json(rows.map(t=>({...t,schedule})));
    if(url.includes('/products'))return Response.json({products:[],mutationPreconditions:[]});
    return Response.json(url.includes('/settings')?{}:[]);
  }));
});
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();window.history.replaceState(null,'','/');});
/** The definition save is the `기본 정보` tab's `저장` (one task). The panel may be inert while saving, hence hidden. */
function save(){fireEvent.click(screen.getByRole('button',{name:'저장',hidden:true}));}
// PostgreSQL (tenant) classes use the stage ledger instead (see AdminManagePage.taskLedger.test.tsx).
describe('Sheets task definition save',()=>{
  it('unscoped legacy save remains its array/body contract',async()=>{
    render(<AdminManagePage/>);await openAdminMenu('과제');await findTaskRow('Save One');await openTaskEditor('Save One');
    fireEvent.change(screen.getByLabelText('T1 과제명'),{target:{value:'Legacy edit'}});save();
    await findNotice('과제 1개 저장 완료');expect(Object.keys(JSON.parse(bodies[0]))).toEqual(['tasks']);expect(JSON.parse(bodies[0]).tasks).toHaveLength(1);
  });
});
