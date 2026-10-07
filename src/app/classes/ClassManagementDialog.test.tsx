import { fireEvent, render, screen, waitFor, cleanup } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ClassManagementDialog } from './ClassManagementDialog';
import type { ClassMembershipPageItem } from '@/server/classMembershipPageAccess';
const item:ClassMembershipPageItem={slug:'my-class',displayName:'우리 반',roleLabel:'소유자',lifecycleLabel:'사용 중',selectable:true,href:'/c/my-class',dashboard:{role:'OWNER',lifecycle:'ACTIVE',deletedAt:null,managementVersion:'1',createdAt:'2026-01-01T00:00:00Z',studentCount:24,productCount:5,taskCount:3}};
beforeAll(()=>{HTMLDialogElement.prototype.showModal=function(){this.open=true;};HTMLDialogElement.prototype.close=function(){this.open=false;};});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
describe('class management dialog',()=>{
  it('requires exact class name before moving to trash',async()=>{
    const fetcher=vi.fn().mockResolvedValue(new Response(JSON.stringify({action:'DELETE',slug:'my-class',managementVersion:'2',lifecycle:'SUSPENDED',displayName:'우리 반',replayed:false}),{status:200}));vi.stubGlobal('fetch',fetcher);const success=vi.fn();
    render(<ClassManagementDialog item={item} action="DELETE" onClose={()=>{}} onSuccess={success}/>);
    const button=screen.getByRole('button',{name:'휴지통으로 이동'}) as HTMLButtonElement;expect(button.disabled).toBe(true);
    fireEvent.change(screen.getByRole('textbox'),{target:{value:'다른 반'}});expect(button.disabled).toBe(true);
    fireEvent.change(screen.getByRole('textbox'),{target:{value:'우리 반'}});fireEvent.click(button);
    await waitFor(()=>expect(success).toHaveBeenCalledOnce());expect(JSON.parse(fetcher.mock.calls[0][1].body)).toMatchObject({action:'DELETE',name:'우리 반',expectedVersion:'1'});
  });
  it('retries an unknown outcome with the same operation and blocks double submission',async()=>{
    const fetcher=vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(new Response(JSON.stringify({action:'DUPLICATE',slug:'new-class',managementVersion:'1',lifecycle:'ACTIVE',displayName:'우리 반 복사본',replayed:true}),{status:200}));vi.stubGlobal('fetch',fetcher);const success=vi.fn();
    render(<ClassManagementDialog item={item} action="DUPLICATE" onClose={()=>{}} onSuccess={success}/>);
    const button=screen.getByRole('button',{name:'새 학급으로 복제'});fireEvent.click(button);fireEvent.click(button);
    await screen.findByRole('alert');expect(fetcher).toHaveBeenCalledTimes(1);expect((screen.getByRole('textbox') as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button',{name:'같은 요청으로 다시 확인'}));await waitFor(()=>expect(success).toHaveBeenCalledOnce());
    expect(fetcher.mock.calls[0][1].body).toBe(fetcher.mock.calls[1][1].body);
  });
});
