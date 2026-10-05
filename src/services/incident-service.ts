import { assertOrThrow } from '../core/errors';
import { newId } from '../core/id';
import { TwinStore } from '../domain/store';
import { Incident } from '../domain/types';
import { AuditService } from './audit-service';

/** incident 生命周期状态机：只能沿合法迁移推进，resolved 为终态 */
const incidentTransitions:Record<Incident['status'],Incident['status'][]> = {
  open:['investigating','contained','resolved'],
  investigating:['contained','resolved'],
  contained:['resolved'],
  resolved:[],
};

/**
 * WorkflowService 编排工单完成动作时依赖的 incident 侧端口。
 * 通过端口注入而非直接依赖具体实现，便于在 incident 关闭失败时模拟下游故障并验证补偿。
 */
export interface IncidentLifecyclePort {
  /** 仅按 id 解析关联 incident；缺失时返回 null，调用方绝不能据此关闭其他 incident */
  find(id:string):Incident|null;
  /**
   * 将 incident 收敛到 resolved。已是 resolved 时幂等返回。
   * 下游关闭失败时抛出异常，由编排方决定补偿策略。
   */
  resolve(id:string,ctx:ResolutionContext):Incident;
}

export interface ResolutionContext {correlationId:string;reason:string;attempt:number;sourceWorkOrderId:string}

export class IncidentService implements IncidentLifecyclePort {
  constructor(private store:TwinStore,private audit?:AuditService){}

  find(id:string):Incident|null {
    return this.store.incidents.get(id)??null;
  }

  get(id:string):Incident {
    const incident=this.find(id);
    assertOrThrow(!!incident,'INCIDENT_NOT_FOUND','incident not found');
    return incident as Incident;
  }

  /** incident 状态机迁移；不改变既有合法迁移规则 */
  transition(id:string,next:Incident['status']):Incident {
    const incident=this.get(id);
    const from=incident.status;
    assertOrThrow(incidentTransitions[from].includes(next),'INVALID_INCIDENT_TRANSITION',`${from} -> ${next}`);
    incident.status=next;
    if(next==='resolved') incident.resolvedAt=Date.now();
    this.audit?.record('incident.transition',incident.id,{from,to:next});
    return incident;
  }

  resolve(id:string,ctx:ResolutionContext):Incident {
    const incident=this.get(id);
    if(incident.status==='resolved'){
      // 幂等：不重复写 resolvedAt，也不产生新的关闭记录
      return incident;
    }
    assertOrThrow(incidentTransitions[incident.status].includes('resolved'),'INVALID_INCIDENT_TRANSITION',`${incident.status} -> resolved`);
    incident.status='resolved';
    incident.resolvedAt=Date.now();
    this.audit?.record('incident.resolved',incident.id,{
      correlationId:ctx.correlationId,
      sourceWorkOrderId:ctx.sourceWorkOrderId,
      reason:ctx.reason,
      attempt:ctx.attempt,
      resolvedAt:incident.resolvedAt,
    });
    return incident;
  }
}
