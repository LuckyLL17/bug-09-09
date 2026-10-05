import { assertOrThrow } from '../core/errors'; import { newId } from '../core/id'; import { TwinStore } from '../domain/store'; import { Incident, WorkOrder } from '../domain/types'; import { AuditService } from './audit-service'; import { IncidentService } from './incident-service';
const transitions:Record<WorkOrder['state'],WorkOrder['state'][]>= {draft:['approved','cancelled'],approved:['executing','cancelled'],executing:['completed','cancelled'],completed:[],cancelled:[]};
export interface CompletionResult { workOrder:WorkOrder; incident:Incident|null; converged:boolean; compensationRequired:boolean; traceId:string; failure?:{code:string;message:string} }
export class WorkflowService {
 constructor(private store:TwinStore,private incidents:IncidentService,private audit:AuditService){}
 create(incidentId:string,steps:string[]){
  assertOrThrow(this.store.incidents.has(incidentId),'INCIDENT_NOT_FOUND','incident not found');
  const w:WorkOrder={id:newId('wo'),incidentId,state:'draft',steps:[...steps],compensationRequired:false};
  this.store.workOrders.set(w.id,w);
  this.audit.record('work_order.created',w.id,{incidentId});
  return w;
 }
 transition(id:string,next:WorkOrder['state']){
  if(next==='completed') return this.complete(id); // 完成动作必须走工单+incident 协同收敛
  const w=this.mustGet(id);
  assertOrThrow(transitions[w.state].includes(next),'INVALID_TRANSITION',`${w.state} -> ${next}`);
  const from=w.state; w.state=next;
  this.audit.record('work_order.transition',w.id,{from,to:next,incidentId:w.incidentId});
  return w;
 }
 complete(id:string):CompletionResult{
  const w=this.mustGet(id);
  if(w.state==='completed'){
   // 幂等：已收敛的工单重复完成不产生新状态或新审计；仍有待补偿时视为继续处理并重试补偿
   if(!w.compensationRequired) return {workOrder:w,incident:this.store.incidents.get(w.incidentId)??null,converged:true,compensationRequired:false,traceId:this.traceOf(w)};
   return this.convergeIncident(w,this.traceOf(w));
  }
  assertOrThrow(transitions[w.state].includes('completed'),'INVALID_TRANSITION',`${w.state} -> completed`);
  w.state='completed';
  w.traceId=newId('trace');
  this.audit.record('work_order.completed',w.id,{incidentId:w.incidentId,traceId:w.traceId});
  return this.convergeIncident(w,w.traceId);
 }
 retryCompensation(id:string):CompletionResult{
  const w=this.mustGet(id);
  assertOrThrow(w.state==='completed','INVALID_TRANSITION','compensation requires a completed work order');
  assertOrThrow(w.compensationRequired,'NO_COMPENSATION_PENDING','no compensation pending');
  return this.convergeIncident(w,this.traceOf(w));
 }
 // 按工单记录的 incidentId 精确收敛关联 incident；失败时落 compensationRequired 供继续处理，绝不波及其他 incident
 private convergeIncident(w:WorkOrder,traceId:string):CompletionResult{
  try{
   const {incident,changed}=this.incidents.resolve(w.incidentId);
   w.compensationRequired=false; w.lastFailure=undefined;
   if(changed) this.audit.record('incident.resolved',incident.id,{workOrderId:w.id,traceId}); // 已 resolved 时不写虚假关闭记录
   return {workOrder:w,incident,converged:true,compensationRequired:false,traceId};
  }catch(e:any){
   const failure={code:e?.code??'INCIDENT_RESOLVE_FAILED',message:e?.message??'incident resolve failed'};
   w.compensationRequired=true; w.lastFailure={...failure,at:Date.now()};
   this.audit.record('incident.resolve_failed',w.incidentId,{workOrderId:w.id,traceId,...failure});
   return {workOrder:w,incident:null,converged:false,compensationRequired:true,traceId,failure};
  }
 }
 private traceOf(w:WorkOrder){ if(!w.traceId) w.traceId=newId('trace'); return w.traceId; }
 private mustGet(id:string){ const w=this.store.workOrders.get(id); assertOrThrow(!!w,'WORK_ORDER_NOT_FOUND','work order not found'); return w as WorkOrder; }
}
