import { assertOrThrow } from '../core/errors'; import { TwinStore } from '../domain/store'; import { Incident } from '../domain/types';
// 只允许向前收敛的 incident 状态机：open -> investigating -> contained -> resolved（允许跨步前进，禁止回退）
const incidentTransitions:Record<Incident['status'],Incident['status'][]>= {open:['investigating','contained','resolved'],investigating:['contained','resolved'],contained:['resolved'],resolved:[]};
export interface IncidentTransitionResult { incident:Incident; changed:boolean }
export class IncidentService {
 constructor(private store:TwinStore){}
 transition(id:string,next:Incident['status']):IncidentTransitionResult{
  const incident=this.store.incidents.get(id);
  assertOrThrow(!!incident,'INCIDENT_NOT_FOUND',`incident ${id} not found`);
  if(incident!.status===next) return {incident:incident!,changed:false}; // 幂等：目标状态已达成时不产生变更
  const allowed=incidentTransitions[incident!.status];
  assertOrThrow(Array.isArray(allowed)&&allowed.includes(next),'INVALID_INCIDENT_TRANSITION',`${incident!.status} -> ${next}`);
  incident!.status=next;
  return {incident:incident!,changed:true};
 }
 resolve(id:string){ return this.transition(id,'resolved'); }
}
