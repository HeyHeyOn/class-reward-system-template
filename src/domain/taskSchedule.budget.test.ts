import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { Temporal } from '@js-temporal/polyfill';
import { parseTaskScheduleCells, validateTaskSchedule, normalizeLegacyTimeZone } from './taskSchedule';
import { BudgetExceededError, BudgetUnavailableError, createBudgetContext, type BudgetContext } from '@/lib/boundedWork';
import { createBoundedScheduleResult, parseRegisteredBoundedJson, registeredBoundedKeys } from '@/lib/boundedJson';

it.each(['nodes','slots','contentBytes','structuralBytes','work'] as const)('exact cumulative %s boundary for current/pending and extras', (key)=>{
  for(const f of [fixtures[0],fixtures[24],fixtures[25],fixtures[29]]){
    const probe=budget();const source=parseRegisteredBoundedJson(JSON.stringify(f.input),probe);const before=probe.usage()[key];invoke(f.kind,source,probe);const required=probe.usage()[key]-before;
    expect(required).toBeGreaterThan(0);
    for(const extra of [-1,0,1]){
      const b=budget();const admitted=parseRegisteredBoundedJson(JSON.stringify(f.input),b);
      const prefill=b.limits[key]-b.usage()[key]-required-extra;
      if(key==='work')b.spend(prefill);else b.reserve({[key]:prefill});
      if(extra<0)expect(()=>invoke(f.kind,admitted,b)).toThrow(BudgetExceededError);
      else {expect(JSON.stringify(outcome(f.kind,admitted,b))).toBe(JSON.stringify(f.outcome));expect(()=>invoke(f.kind,admitted,b)).toThrow(BudgetExceededError);}
    }
  }
});
it('closed schedule projection reserves before lazy input and rejects foreign sources',()=>{
  const lazy=vi.fn(()=>({}));expect(()=>createBoundedScheduleResult(lazy,createBudgetContext({limits:{nodes:0},now:()=>0}))).toThrow(BudgetExceededError);expect(lazy).not.toHaveBeenCalled();
  expect(()=>createBoundedScheduleResult(lazy,budget())).toThrow('Legacy bounded JSON is invalid.');
});
it('refuses weekday fanout before split, with admitted input and native sentinel',()=>{
  const f=structuredClone(fixtures[7].input) as {cells:Record<string,string>;legacy:object};f.cells.recurrenceWeekdays='1,'.repeat(5000);
  const b=budget();const x=parseRegisteredBoundedJson(JSON.stringify(f),b) as typeof f;
  b.reserve({slots:b.limits.slots-b.usage().slots-1000});const native=vi.spyOn(String.prototype,'split');
  expect(()=>parse(x.cells,x.legacy,b)).toThrow(BudgetExceededError);
  expect(native.mock.calls.some(args=>(args[0] as unknown)===',')).toBe(false);
});
it.each([false,true])('late toString success/exception is checked even in public validation: %s',(fail)=>{
  let clock=0;const b=createBudgetContext({now:()=>clock});const x=parseRegisteredBoundedJson(JSON.stringify(fixtures[29].input),b);
  const native=Temporal.Instant.prototype.toString;
  vi.spyOn(Temporal.Instant.prototype,'toString').mockImplementation(function(this:Temporal.Instant,options){const out=native.call(this,options);clock=5000;if(fail)throw new RangeError('native');return out;});
  expect(()=>validate(x,b)).toThrow(BudgetUnavailableError);
});
it('preserves no-budget native toString exceptions without converting them',()=>{
  vi.spyOn(Temporal.Instant.prototype,'toString').mockImplementation(()=>{throw new RangeError('native');});
  expect(()=>validate(fixtures[29].input)).toThrow('native');
});
it('shares context into pending timezone work',()=>{
  const b=budget();const x=parseRegisteredBoundedJson(JSON.stringify(fixtures[24].input),b) as {cells:object;legacy:object};
  const native=Temporal.ZonedDateTime.from;let calls=0;
  vi.spyOn(Temporal.ZonedDateTime,'from').mockImplementation((...args)=>{if(++calls===3)throw new BudgetUnavailableError();return native(...args);});
  expect(()=>parse(x.cells,x.legacy,b)).toThrow(BudgetUnavailableError);expect(calls).toBe(3);
});

it('reserves nested String array intermediates before Temporal is reached',()=>{
  let value: unknown = 'x'.repeat(1000);
  for(let i=0;i<32;i++)value=[value];
  const f=structuredClone(fixtures[29].input) as {effectiveFrom:unknown};f.effectiveFrom=value;
  const b=budget();const x=parseRegisteredBoundedJson(JSON.stringify(f),b);
  b.reserve({contentBytes:b.limits.contentBytes-b.usage().contentBytes-4000});
  const native=vi.spyOn(Temporal.Instant,'from');
  expect(()=>validate(x,b)).toThrow(BudgetExceededError);expect(native).not.toHaveBeenCalled();
});
it('reserves Temporal formatting options before formatting callback',()=>{
  const b=budget();const x=parseRegisteredBoundedJson(JSON.stringify(fixtures[29].input),b);
  const from=Temporal.Instant.from;const format=vi.spyOn(Temporal.Instant.prototype,'toString');
  vi.spyOn(Temporal.Instant,'from').mockImplementation((v)=>{const result=from(v);b.reserve({nodes:b.limits.nodes-b.usage().nodes});return result;});
  expect(()=>validate(x,b)).toThrow(BudgetExceededError);expect(format).not.toHaveBeenCalled();
});
it('precharges malformed numeric cell native array coercion',()=>{
  const f=structuredClone(fixtures[7].input) as {cells:Record<string,unknown>;legacy:object};
  f.cells.recurrenceType='MONTHLY';f.cells.recurrenceDayOfMonth=['1'.repeat(10000)];
  const b=budget();const x=parseRegisteredBoundedJson(JSON.stringify(f),b) as typeof f;
  b.reserve({contentBytes:b.limits.contentBytes-b.usage().contentBytes-2000});
  expect(()=>parse(x.cells,x.legacy,b)).toThrow(BudgetExceededError);
});
it('precharges the first numeric validator before its native boundary',()=>{
  const b=budget();const x=parseRegisteredBoundedJson(JSON.stringify(fixtures[29].input),b);
  b.spend(b.limits.work-b.usage().work-2);
  const integer=vi.spyOn(Number,'isInteger');
  expect(()=>validate(x,b)).toThrow(BudgetExceededError);expect(integer).not.toHaveBeenCalled();
});
const fixtures = JSON.parse(readFileSync('src/server/migration/__fixtures__/schedule-core-golden.json', 'utf8')) as {kind:string;input:unknown;outcome:unknown}[];
const edgeFixtures = JSON.parse(readFileSync('src/server/migration/__fixtures__/schedule-core-edge-golden.json', 'utf8')) as typeof fixtures;
it.each(edgeFixtures.map((fixture,index)=>({...fixture,index})))('original coercion oracle $index',({kind,input,outcome:expected})=>{
  expect(JSON.stringify(outcome(kind,input))).toBe(JSON.stringify(expected));
  const b=budget();const admitted=parseRegisteredBoundedJson(JSON.stringify(input),b);
  expect(JSON.stringify(outcome(kind,admitted,b))).toBe(JSON.stringify(expected));
});
const budget = () => createBudgetContext({now:()=>0});
const parse = parseTaskScheduleCells as (cells: object, legacy: object, b?:BudgetContext)=>ReturnType<typeof parseTaskScheduleCells>;
const validate = validateTaskSchedule as (value:unknown,b?:BudgetContext)=>ReturnType<typeof validateTaskSchedule>;
function invoke(kind:string, input:unknown,b?:BudgetContext) {
  if(kind==='cells'){const x=input as {cells:object;legacy:object};return parse(x.cells,x.legacy,b);}
  return validate(input,b);
}
function outcome(kind:string,input:unknown,b?:BudgetContext){try{return {value:invoke(kind,input,b)};}catch(e){const error=e as Error;return {error:{name:error.name,message:error.message}};}}
afterEach(()=>vi.restoreAllMocks());
it.each(fixtures.map((fixture,index)=>({...fixture,index})))('original oracle $index',({kind,input,outcome:expected})=>{
  expect(JSON.stringify(outcome(kind,input))).toBe(JSON.stringify(expected));
  const b=budget(); const admitted=parseRegisteredBoundedJson(JSON.stringify(input),b);
  expect(JSON.stringify(outcome(kind,admitted,b))).toBe(JSON.stringify(expected));
});
it('refuses foreign inputs without getters',()=>{
  const get=vi.fn(()=>{throw new Error('getter');});const value=new Proxy({},{get});
  expect(()=>parse(value,value,budget())).toThrow('Legacy bounded JSON is invalid.');
  expect(get).not.toHaveBeenCalled();
  expect(()=>validate(value,budget())).toThrow('Legacy bounded JSON is invalid.');expect(get).not.toHaveBeenCalled();
});
it('propagates exhausted work before legacy native/default allocation',()=>{
  const b=budget();const x=parseRegisteredBoundedJson('{"cells":{},"legacy":{"taskId":"x"}}',b) as {cells:object;legacy:object};
  b.spend(b.limits.work-b.usage().work);const native=vi.spyOn(Temporal.Instant,'from');
  expect(()=>parse(x.cells,x.legacy,b)).toThrow(BudgetExceededError);expect(native).not.toHaveBeenCalled();
});
it.each([BudgetExceededError,BudgetUnavailableError])('both catches rethrow %s',(ErrorType)=>{
  const b=budget();const x=parseRegisteredBoundedJson('{"cells":{},"legacy":{"taskId":"x"}}',b) as {cells:object;legacy:object};
  vi.spyOn(Temporal.Instant,'from').mockImplementation(()=>{throw new ErrorType();});
  expect(()=>parse(x.cells,x.legacy,b)).toThrow(ErrorType);
});
it('safeParseSchedule does not convert native budget failures into warnings',()=>{
  const f=fixtures.find(f=>f.kind==='cells'&&(f.input as {cells:Record<string,string>}).cells.ruleVersion)!;
  const b=budget();const x=parseRegisteredBoundedJson(JSON.stringify(f.input),b) as {cells:object;legacy:object};
  const native=Temporal.Instant.from;let calls=0;
  vi.spyOn(Temporal.Instant,'from').mockImplementation((value)=>{if(++calls===2)throw new BudgetExceededError();return native(value);});
  expect(()=>parse(x.cells,x.legacy,b)).toThrow(BudgetExceededError);
});
it('late native failures do not default',()=>{
  let clock=0;const b=createBudgetContext({now:()=>clock});const x=parseRegisteredBoundedJson('{"cells":{},"legacy":{"taskId":"x"}}',b) as {cells:object;legacy:object};
  vi.spyOn(Temporal.Instant,'from').mockImplementation(()=>{clock=5000;throw new RangeError();});
  expect(()=>parse(x.cells,x.legacy,b)).toThrow(BudgetUnavailableError);
});
it('budget enabled outputs remain mutable and uncertified including nonweekly recurrence',()=>{
  const b=budget();const input=parseRegisteredBoundedJson(JSON.stringify(fixtures.find(f=>f.kind==='validate'&&(f.input as {recurrence?:{type:string}})?.recurrence?.type==='NONE')!.input),b);
  const result=validate(input,b);expect(Object.isFrozen(result)).toBe(false);expect(Object.isFrozen(result.recurrence)).toBe(false);
  expect(()=>registeredBoundedKeys(result,b)).toThrow('Legacy bounded JSON is invalid.');
});
it('normalizes legacy zone with same budget',()=>{
  const normalize=normalizeLegacyTimeZone as (value:unknown,b?:BudgetContext)=>string;
  expect(()=>normalize('UTC',createBudgetContext({limits:{work:0},now:()=>0}))).toThrow(BudgetExceededError);
});
