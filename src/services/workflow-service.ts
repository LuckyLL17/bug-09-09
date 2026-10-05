import { assertOrThrow } from '../core/errors';
import { newId } from '../core/id';
import { TwinStore } from '../domain/store';
import { WorkOrder } from '../domain/types';
import { AuditService } from './audit-service';
import { IncidentLifecyclePort } from './incident-service';

const transitions:Record<WorkOrder['state'],WorkOrder['state'][]> = {
  draft:['approved','cancelled'],
  approved:['executing','cancelled'],
  executing:['completed','cancelled'],
  completed:[],
  cancelled:[],
};

/**
 * 完成动作的编排结果。任一分支都是明确、可继续处理的：
 *  - converged：工单与关联 incident 已同时收敛到终态
 *  - pending_incident_closure：工单已完成，incident 关闭失败，等待补偿重试
 *  - incident_not_found：关联对象缺失，工单保持原态，未触碰任何其他 incident
 */
export type CompleteOutcome =
  | { status:'converged'; workOrder:WorkOrder; incidentId:string; correlationId:string; attempt:number; idempotent:boolean; compensated:boolean }
  | { status:'pending_incident_closure'; workOrder:WorkOrder; incidentId:string; correlationId:string; attempt:number; errorCode:string; error:string }
  | { status:'incident_not_found'; workOrder:WorkOrder; incidentId:string; correlationId:string; attempt:number };

export class WorkflowService {
  constructor(
    private store:TwinStore,
    private incidents:IncidentLifecyclePort,
    private audit?:AuditService,
  ){}

  create(incidentId:string,steps:string[]):WorkOrder {
    assertOrThrow(this.store.incidents.has(incidentId),'INCIDENT_NOT_FOUND','incident not found');
    const w:WorkOrder={id:newId('wo'),incidentId,state:'draft',steps:[...steps],compensationRequired:false};
    this.store.workOrders.set(w.id,w);
    this.audit?.record('workorder.created',w.id,{incidentId});
    return w;
  }

  /**
   * 纯状态机迁移（draft/approved/executing/cancelled 之间的既有合法迁移）。
   * -> completed 的迁移必须走 complete()，以便同步收敛 incident 生命周期。
   */
  transition(id:string,next:WorkOrder['state']):WorkOrder {
    const w=this.requireWorkOrder(id);
    assertOrThrow(transitions[w.state].includes(next),'INVALID_TRANSITION',`${w.state} -> ${next}`);
    const from=w.state;
    w.state=next;
    this.audit?.record('workorder.transition',w.id,{from,to:next});
    return w;
  }

  /**
   * 完成工单，并按关联关系把同一条业务链上的 incident 同步收敛到 resolved。
   *
   * 幂等性：
   *  - 已 completed 且 incident 已 resolved：原样返回 converged，不写任何记录
   *  - 已 completed 但 incident 仍 open（补偿未完成）：本次调用即补偿重试
   *  - incident 侧 resolve 本身幂等，不会重复写关闭时间或关闭审计
   */
  complete(id:string):CompleteOutcome {
    return this.orchestrate(id);
  }

  /** 补偿入口：对 completed 但 incident 关闭失败 / 关联暂时缺失的工单重试收敛 */
  retryIncidentClosure(id:string):CompleteOutcome {
    return this.orchestrate(id);
  }

  private requireWorkOrder(id:string):WorkOrder {
    const w=this.store.workOrders.get(id);
    assertOrThrow(!!w,'WORK_ORDER_NOT_FOUND','work order not found');
    return w as WorkOrder;
  }

  private nextAttempt(w:WorkOrder):number {
    const attempt=(w.compensationAttempts??0)+1;
    w.compensationAttempts=attempt;
    return attempt;
  }

  private orchestrate(id:string):CompleteOutcome {
    const w=this.requireWorkOrder(id);

    // 已收敛：纯幂等返回，不产生任何状态变更或虚假关闭记录
    if(w.state==='completed' && !w.compensationRequired){
      const incident=this.incidents.find(w.incidentId);
      if(incident && incident.status==='resolved'){
        return {status:'converged',workOrder:w,incidentId:w.incidentId,correlationId:w.correlationId as string,attempt:w.compensationAttempts??0,idempotent:true,compensated:false};
      }
    }

    // 只有 executing 可以完成；completed 走补偿/幂等路径；draft/approved/cancelled 不允许完成
    assertOrThrow(w.state==='executing'||w.state==='completed','INVALID_TRANSITION',`${w.state} -> completed`);

    // 首次尝试即分配稳定的 correlationId，此后所有审计（含补偿重试）共享
    if(!w.correlationId) w.correlationId=newId('corr');
    const correlationId=w.correlationId;

    const wasCompleted=w.state==='completed';
    const attempt=this.nextAttempt(w);

    // 仅按关联 id 查找；缺失时绝不关闭其他 incident
    const incident=this.incidents.find(w.incidentId);
    if(!incident){
      // executing 阶段：保持 executing，修复关联后可重试；completed 阶段：保留补偿标记
      this.audit?.record('incident.not_found',w.incidentId,{correlationId,workOrderId:w.id,attempt});
      this.audit?.record(wasCompleted?'workorder.compensation_blocked':'workorder.completion_blocked',w.id,
        {correlationId,incidentId:w.incidentId,attempt,reason:'incident not found'});
      if(wasCompleted) w.compensationRequired=true;
      return {status:'incident_not_found',workOrder:w,incidentId:w.incidentId,correlationId,attempt};
    }

    if(incident.status==='resolved'){
      // incident 已由其他路径关闭：resolve 侧不重复写关闭记录，这里只需收敛工单自身
      if(!wasCompleted){
        w.state='completed';
        this.audit?.record('workorder.completed',w.id,{correlationId,incidentId:w.incidentId,attempt});
      }
      return this.convergedResult(w,attempt,correlationId,false);
    }

    try {
      this.incidents.resolve(w.incidentId,{
        correlationId,reason:'work_order_completed',attempt,sourceWorkOrderId:w.id,
      });
    }catch(e:any){
      // incident 关闭失败：工单仍可完成，但必须留下显式补偿状态与失败审计
      w.state='completed';
      w.compensationRequired=true;
      this.audit?.record('incident.close_failed',w.incidentId,{
        correlationId,workOrderId:w.id,attempt,errorCode:e?.code??'INCIDENT_CLOSE_FAILED',error:e?.message??String(e),
      });
      this.audit?.record('workorder.completed_pending',w.id,{correlationId,incidentId:w.incidentId,attempt});
      return {
        status:'pending_incident_closure',workOrder:w,incidentId:w.incidentId,correlationId,attempt,
        errorCode:e?.code??'INCIDENT_CLOSE_FAILED',error:e?.message??String(e),
      };
    }

    const compensated=wasCompleted && w.compensationRequired;
    if(!wasCompleted){
      w.state='completed';
      this.audit?.record('workorder.completed',w.id,{correlationId,incidentId:w.incidentId,attempt});
    }
    if(compensated){
      w.compensationRequired=false;
      this.audit?.record('workorder.compensated',w.id,{correlationId,incidentId:w.incidentId,attempt});
    }
    return this.convergedResult(w,attempt,correlationId,compensated);
  }

  private convergedResult(w:WorkOrder,attempt:number,correlationId:string,compensated:boolean):CompleteOutcome {
    return {status:'converged',workOrder:w,incidentId:w.incidentId,correlationId,attempt,idempotent:false,compensated};
  }
}
