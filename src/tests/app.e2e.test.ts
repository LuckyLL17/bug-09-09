import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../app';
import { TwinStore } from '../domain/store';
import { Incident } from '../domain/types';
import { AuditService } from '../services/audit-service';
import { FastifyInstance } from 'fastify';

function harness():{app:FastifyInstance;store:TwinStore;audit:AuditService} {
  const store=new TwinStore();
  const audit=new AuditService();
  const app=buildApp(store,audit);
  return {app,store,audit};
}

test('HTTP：完整链路（创建→执行→完成）后工单与 incident 同时结束，审计可按 correlationId 查',async()=>{
  const {app,store}=harness();
  after(()=>app.close());

  const inc:Incident={id:'inc_http_1',severity:'high',status:'open',assetIds:['a'],detectedAt:1,evidence:[]};
  store.incidents.set(inc.id,inc);

  const created=await app.inject({method:'POST',url:'/work-orders',payload:{incidentId:inc.id,steps:['go']}});
  assert.equal(created.statusCode,200);
  const wo=created.json();

  for(const state of ['approved','executing']){
    const r=await app.inject({method:'POST',url:`/work-orders/${wo.id}/transition`,payload:{state}});
    assert.equal(r.statusCode,200);
  }

  const completed=await app.inject({method:'POST',url:`/work-orders/${wo.id}/complete`});
  assert.equal(completed.statusCode,200);
  const body=completed.json();
  assert.equal(body.status,'converged');
  assert.ok(body.correlationId);
  assert.equal(store.incidents.get(inc.id)!.status,'resolved');

  // 旧入口（transition 到 completed）同样走收敛编排；approved 不能跳过 executing
  const inc2:Incident={id:'inc_http_2',severity:'low',status:'open',assetIds:['b'],detectedAt:1,evidence:[]};
  store.incidents.set(inc2.id,inc2);
  const c2=await app.inject({method:'POST',url:'/work-orders',payload:{incidentId:inc2.id,steps:[]}});
  const wo2=c2.json();
  await app.inject({method:'POST',url:`/work-orders/${wo2.id}/transition`,payload:{state:'approved'}});
  const skipExecuting=await app.inject({method:'POST',url:`/work-orders/${wo2.id}/transition`,payload:{state:'completed'}});
  assert.equal(skipExecuting.statusCode,400);
  await app.inject({method:'POST',url:`/work-orders/${wo2.id}/transition`,payload:{state:'executing'}});
  const viaLegacy=await app.inject({method:'POST',url:`/work-orders/${wo2.id}/transition`,payload:{state:'completed'}});
  assert.equal(viaLegacy.statusCode,200);
  assert.equal(viaLegacy.json().status,'converged');
  assert.equal(store.incidents.get(inc2.id)!.status,'resolved');

  // 按 correlationId 跨实体查询审计
  const auditRes=await app.inject({method:'GET',url:`/audit?correlationId=${body.correlationId}`});
  const entries=auditRes.json();
  assert.ok(entries.length>=2);
  assert.ok(entries.some((e:any)=>e.entityId===wo.id));
  assert.ok(entries.some((e:any)=>e.entityId===inc.id));
});

test('HTTP：重复完成幂等，审计不增长；关联缺失返回 424 且不误关其他 incident',async()=>{
  const {app,store}=harness();
  after(()=>app.close());

  const inc:Incident={id:'inc_http_3',severity:'high',status:'open',assetIds:['a'],detectedAt:1,evidence:[]};
  const other:Incident={id:'inc_http_other',severity:'low',status:'open',assetIds:['b'],detectedAt:1,evidence:[]};
  store.incidents.set(inc.id,inc);
  store.incidents.set(other.id,other);

  const wo=(await app.inject({method:'POST',url:'/work-orders',payload:{incidentId:inc.id,steps:[]}})).json();
  await app.inject({method:'POST',url:`/work-orders/${wo.id}/transition`,payload:{state:'approved'}});
  await app.inject({method:'POST',url:`/work-orders/${wo.id}/transition`,payload:{state:'executing'}});

  const first=(await app.inject({method:'POST',url:`/work-orders/${wo.id}/complete`})).json();
  assert.equal(first.status,'converged');
  const auditAfterFirst=(await app.inject({method:'GET',url:'/audit'})).json().length;

  const repeat=await app.inject({method:'POST',url:`/work-orders/${wo.id}/complete`});
  assert.equal(repeat.statusCode,200);
  assert.equal(repeat.json().idempotent,true);
  const auditAfterRepeat=(await app.inject({method:'GET',url:'/audit'})).json().length;
  assert.equal(auditAfterRepeat,auditAfterFirst,'重复完成不产生审计');

  // 另一个工单，关联 incident 在完成前被删除
  const orphan:Incident={id:'inc_http_4',severity:'high',status:'open',assetIds:['c'],detectedAt:1,evidence:[]};
  store.incidents.set(orphan.id,orphan);
  const wo2=(await app.inject({method:'POST',url:'/work-orders',payload:{incidentId:orphan.id,steps:[]}})).json();
  await app.inject({method:'POST',url:`/work-orders/${wo2.id}/transition`,payload:{state:'approved'}});
  await app.inject({method:'POST',url:`/work-orders/${wo2.id}/transition`,payload:{state:'executing'}});
  store.incidents.delete(orphan.id);

  const missing=await app.inject({method:'POST',url:`/work-orders/${wo2.id}/complete`});
  assert.equal(missing.statusCode,424);
  assert.equal(missing.json().status,'incident_not_found');
  assert.equal(store.workOrders.get(wo2.id)!.state,'executing');
  assert.equal(store.incidents.get(other.id)!.status,'open');

  // 恢复关联后补偿重试成功
  store.incidents.set(orphan.id,{...orphan});
  const retry=await app.inject({method:'POST',url:`/work-orders/${wo2.id}/retry-incident-closure`});
  assert.equal(retry.statusCode,200);
  assert.equal(retry.json().status,'converged');
  assert.equal(retry.json().correlationId,missing.json().correlationId);
  assert.equal(store.incidents.get(orphan.id)!.status,'resolved');
});

test('HTTP：incident 状态机迁移合法路径可用，终态与非法迁移被拒绝',async()=>{
  const {app,store}=harness();
  after(()=>app.close());
  const inc:Incident={id:'inc_http_5',severity:'high',status:'open',assetIds:['a'],detectedAt:1,evidence:[]};
  store.incidents.set(inc.id,inc);

  assert.equal((await app.inject({method:'PATCH',url:`/incidents/${inc.id}/transition`,payload:{status:'investigating'}})).statusCode,200);
  const bad=await app.inject({method:'PATCH',url:`/incidents/${inc.id}/transition`,payload:{status:'open'}});
  assert.equal(bad.statusCode,400);
  await app.inject({method:'PATCH',url:`/incidents/${inc.id}/transition`,payload:{status:'resolved'}});
  const terminal=await app.inject({method:'PATCH',url:`/incidents/${inc.id}/transition`,payload:{status:'contained'}});
  assert.equal(terminal.statusCode,400);
});
