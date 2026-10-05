import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TwinStore } from '../domain/store';
import { Incident } from '../domain/types';
import { AuditService } from '../services/audit-service';
import { IncidentService, IncidentLifecyclePort, ResolutionContext } from '../services/incident-service';
import { WorkflowService } from '../services/workflow-service';

function seed(incidentStatus:Incident['status']='open') {
  const store=new TwinStore();
  const incident:Incident={id:'inc_1',severity:'high',status:incidentStatus,assetIds:['pump_1'],detectedAt:100,evidence:[]};
  store.incidents.set(incident.id,incident);
  // 一张“其他 incident”，任何路径都不应误关闭它
  const other:Incident={id:'inc_other',severity:'low',status:'open',assetIds:['pump_2'],detectedAt:100,evidence:[]};
  store.incidents.set(other.id,other);
  const audit=new AuditService();
  const incidents=new IncidentService(store,audit);
  const workflows=new WorkflowService(store,incidents,audit);
  const wo=workflows.create('inc_1',['repair']);
  workflows.transition(wo.id,'approved');
  workflows.transition(wo.id,'executing');
  return {store,audit,incidents,workflows,wo,incident,other};
}

/** 可按次数制造关闭失败的 incident 端口装饰器，用于验证补偿重试 */
function flakyPort(inner:IncidentLifecyclePort,failTimes:number,errorCode='INCIDENT_DOWNSTREAM_FAILURE'):IncidentLifecyclePort&{failuresLeft:number} {
  return {
    failuresLeft:failTimes,
    find:(id)=>inner.find(id),
    resolve(id:string,ctx:ResolutionContext){
      if(this.failuresLeft>0){this.failuresLeft--;throw Object.assign(new Error('incident system unavailable'),{code:errorCode});}
      return inner.resolve(id,ctx);
    },
  };
}

test('正常完成：工单与关联 incident 同步收敛，审计共享 correlationId',()=>{
  const {store,audit,workflows,wo,incident}=seed();
  const result=workflows.complete(wo.id);

  assert.equal(result.status,'converged');
  assert.equal(result.idempotent,false);
  const reloaded=store.workOrders.get(wo.id)!;
  assert.equal(reloaded.state,'completed');
  assert.equal(store.incidents.get('inc_1')!.status,'resolved');
  assert.ok(store.incidents.get('inc_1')!.resolvedAt);
  assert.equal(reloaded.compensationRequired,false);

  // 跨模块审计：工单与 incident 的记录带同一个 correlationId
  const chain=audit.list({correlationId:result.correlationId});
  const actions=chain.map(e=>e.action).sort();
  assert.ok(actions.includes('workorder.completed'));
  assert.ok(actions.includes('incident.resolved'));
  assert.equal(new Set(chain.map(e=>e.metadata.correlationId)).size,1);
  const incidentEntry=chain.find(e=>e.entityId==='inc_1')!;
  assert.equal(incidentEntry.metadata.sourceWorkOrderId,wo.id);
});

test('重复完成：幂等返回，不产生新的状态变更或虚假关闭记录',()=>{
  const {audit,workflows,wo,incident}=seed();
  const first=workflows.complete(wo.id);
  const resolvedAt=incident.resolvedAt;
  const auditCountAfterFirst=audit.list().length;

  const again=workflows.complete(wo.id);
  assert.equal(again.status,'converged');
  assert.equal(again.idempotent,true);
  assert.equal(again.correlationId,first.correlationId);
  assert.equal(incident.status,'resolved');
  assert.equal(incident.resolvedAt,resolvedAt,'不得重复写 resolvedAt');
  assert.equal(audit.list().length,auditCountAfterFirst,'重复完成不得追加任何审计记录');

  // 补偿入口重复调用同样幂等
  const retry=workflows.retryIncidentClosure(wo.id);
  assert.equal(retry.status,'converged');
  assert.equal(retry.idempotent,true);
  assert.equal(audit.list().length,auditCountAfterFirst);
});

test('关联 incident 缺失：工单保持 executing，绝不关闭其他 incident，结果可继续处理',()=>{
  const {store,audit,workflows,wo,other}=seed();
  store.incidents.delete('inc_1');

  const result=workflows.complete(wo.id);
  assert.equal(result.status,'incident_not_found');
  assert.equal(store.workOrders.get(wo.id)!.state,'executing','工单不得完成');
  assert.equal(store.workOrders.get(wo.id)!.compensationRequired,false);
  assert.equal(other.status,'open','其他 incident 不得被误关闭');
  assert.ok(result.correlationId,'缺失场景同样分配可追踪关联标识');

  const chain=audit.list({correlationId:result.correlationId});
  assert.ok(chain.some(e=>e.action==='incident.not_found'));
  assert.ok(chain.some(e=>e.action==='workorder.completion_blocked'));
  assert.ok(!chain.some(e=>e.action==='incident.resolved'));

  // 关联恢复后可用同一业务链继续完成（补偿）
  store.incidents.set('inc_1',{id:'inc_1',severity:'high',status:'open',assetIds:['pump_1'],detectedAt:100,evidence:[]});
  const recovered=workflows.complete(wo.id);
  assert.equal(recovered.status,'converged');
  assert.equal(recovered.correlationId,result.correlationId,'沿用同一 correlationId');
  assert.equal(store.incidents.get('inc_other')!.status,'open');
});

test('incident 关闭失败：工单完成但挂起补偿，incident 保持 open 且无虚假关闭记录',()=>{
  const store=new TwinStore();
  const incident:Incident={id:'inc_1',severity:'high',status:'open',assetIds:['pump_1'],detectedAt:100,evidence:[]};
  store.incidents.set(incident.id,incident);
  const audit=new AuditService();
  const incidents=new IncidentService(store,audit);
  const port=flakyPort(incidents,1);
  const workflows=new WorkflowService(store,port,audit);
  const wo=workflows.create('inc_1',['repair']);
  workflows.transition(wo.id,'approved');
  workflows.transition(wo.id,'executing');

  const result=workflows.complete(wo.id);
  assert.equal(result.status,'pending_incident_closure');
  assert.equal(result.errorCode,'INCIDENT_DOWNSTREAM_FAILURE');
  const w=store.workOrders.get(wo.id)!;
  assert.equal(w.state,'completed');
  assert.equal(w.compensationRequired,true);
  assert.equal(incident.status,'open');
  assert.equal(incident.resolvedAt,undefined,'失败时不得写 resolvedAt');

  const chain=audit.list({correlationId:result.correlationId});
  assert.ok(chain.some(e=>e.action==='incident.close_failed'));
  assert.ok(chain.some(e=>e.action==='workorder.completed_pending'));
  assert.ok(!chain.some(e=>e.action==='incident.resolved'),'失败不得产生虚假关闭记录');
});

test('补偿重试：下游恢复后同 correlationId 收敛，清除补偿标记并留补偿审计',()=>{
  const store=new TwinStore();
  const incident:Incident={id:'inc_1',severity:'high',status:'open',assetIds:['pump_1'],detectedAt:100,evidence:[]};
  store.incidents.set(incident.id,incident);
  const audit=new AuditService();
  const incidents=new IncidentService(store,audit);
  const port=flakyPort(incidents,1);
  const workflows=new WorkflowService(store,port,audit);
  const wo=workflows.create('inc_1',['repair']);
  workflows.transition(wo.id,'approved');
  workflows.transition(wo.id,'executing');

  const failed=workflows.complete(wo.id);
  assert.equal(failed.status,'pending_incident_closure');

  const retried=workflows.retryIncidentClosure(wo.id);
  assert.equal(retried.status,'converged');
  assert.equal(retried.compensated,true);
  assert.equal(retried.correlationId,failed.correlationId,'重试沿用同一关联标识');
  assert.equal(retried.attempt,2);
  assert.equal(incident.status,'resolved');
  const w=store.workOrders.get(wo.id)!;
  assert.equal(w.compensationRequired,false);

  // 同一 correlationId 串起 失败 -> 补偿成功 的完整链路
  const chain=audit.list({correlationId:failed.correlationId});
  const ordered=chain.map(e=>e.action);
  assert.ok(ordered.indexOf('incident.close_failed')<ordered.indexOf('incident.resolved'));
  assert.ok(ordered.includes('workorder.compensated'));
  // 重试成功只产生一条 incident.resolved
  assert.equal(chain.filter(e=>e.action==='incident.resolved').length,1);

  // 再次重复完成回到纯幂等
  const again=workflows.complete(wo.id);
  assert.equal(again.status,'converged');
  assert.equal(again.idempotent,true);
});

test('已完成但 incident 由其他路径 resolved：不重复写关闭记录即可收敛',()=>{
  const {store,audit,workflows,incidents,wo}=seed('open');
  // 工单执行期间 incident 先被外部收敛
  incidents.transition('inc_1','resolved');
  const auditBefore=audit.list().length;

  const result=workflows.complete(wo.id);
  assert.equal(result.status,'converged');
  assert.equal(store.workOrders.get(wo.id)!.state,'completed');
  const chain=audit.list({correlationId:result.correlationId});
  assert.ok(!chain.some(e=>e.action==='incident.resolved'),'已 resolved 不得重复关闭');
  assert.ok(chain.some(e=>e.action==='workorder.completed'));
  assert.ok(audit.list().length>=auditBefore);
});

test('审计查询：按 entity / correlationId / action 过滤都能重建业务链',()=>{
  const {audit,workflows,wo}=seed();
  const result=workflows.complete(wo.id);

  const byCorrelation=audit.list({correlationId:result.correlationId});
  const byEntity=audit.list({entityId:wo.id});
  const byAction=audit.list({action:'incident.resolved'});

  assert.ok(byCorrelation.length>=2);
  assert.ok(byEntity.some(e=>e.action==='workorder.completed'));
  assert.equal(byAction[0].entityId,'inc_1');
  assert.equal(byAction[0].metadata.correlationId,result.correlationId);
});

test('合法状态机不被削弱：非 executing/completed 状态完成仍被拒绝；非法 incident 迁移仍被拒绝',()=>{
  const {workflows,incidents,store}=seed();
  // 新建工单处于 draft，不能直接 complete
  const fresh=workflows.create('inc_1',['x']);
  assert.throws(()=>workflows.complete(fresh.id),(e:any)=>e.code==='INVALID_TRANSITION');
  // 通用 transition 的既有非法迁移依然拒绝
  assert.throws(()=>workflows.transition(fresh.id,'executing'),(e:any)=>e.code==='INVALID_TRANSITION');
  // resolved 是终态，不能再迁移
  incidents.transition('inc_1','contained');
  incidents.transition('inc_1','resolved');
  assert.throws(()=>incidents.transition('inc_1','open'),(e:any)=>e.code==='INVALID_INCIDENT_TRANSITION');
});
