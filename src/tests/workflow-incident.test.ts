import test from 'node:test';
import assert from 'node:assert/strict';
import { TwinStore } from '../domain/store';
import { Incident, WorkOrder } from '../domain/types';
import { AuditService } from '../services/audit-service';
import { IncidentService } from '../services/incident-service';
import { WorkflowService } from '../services/workflow-service';

function setup() {
  const store = new TwinStore();
  const audit = new AuditService();
  const incidents = new IncidentService(store);
  const workflows = new WorkflowService(store, incidents, audit);
  return { store, audit, incidents, workflows };
}

const throwsCode = (fn: () => unknown, code: string) =>
  assert.throws(fn, (err: any) => err?.code === code);

function addIncident(store: TwinStore, status: Incident['status'] = 'open'): Incident {
  const incident: Incident = { id: `inc_${store.incidents.size + 1}_${Math.random()}`, severity: 'high', status, assetIds: ['asset-1'], detectedAt: 1000, evidence: [] };
  store.incidents.set(incident.id, incident);
  return incident;
}

function driveToExecuting(workflows: WorkflowService, incidentId: string): WorkOrder {
  const w = workflows.create(incidentId, ['inspect', 'repair']);
  workflows.transition(w.id, 'approved');
  workflows.transition(w.id, 'executing');
  return w;
}

test('正常完成：工单与关联 incident 同步收敛，审计带同一 traceId', () => {
  const { store, audit, workflows } = setup();
  const incident = addIncident(store);
  const w = driveToExecuting(workflows, incident.id);

  const result = workflows.complete(w.id);

  assert.equal(result.converged, true);
  assert.equal(result.compensationRequired, false);
  assert.ok(result.traceId, 'completion must carry a correlation traceId');
  assert.equal(w.state, 'completed');
  assert.equal(w.compensationRequired, false);
  assert.equal(incident.status, 'resolved');
  assert.equal(result.incident?.id, incident.id);

  const chain = audit.list({ traceId: result.traceId });
  assert.deepEqual(chain.map(e => e.action), ['work_order.completed', 'incident.resolved']);
  const woEntry = chain.find(e => e.action === 'work_order.completed')!;
  const incEntry = chain.find(e => e.action === 'incident.resolved')!;
  assert.equal(woEntry.entityId, w.id);
  assert.equal(woEntry.metadata.incidentId, incident.id);
  assert.equal(incEntry.entityId, incident.id);
  assert.equal(incEntry.metadata.workOrderId, w.id);
});

test('重复完成：幂等，不产生重复审计或虚假关闭记录', () => {
  const { store, audit, workflows } = setup();
  const incident = addIncident(store);
  const w = driveToExecuting(workflows, incident.id);
  const first = workflows.complete(w.id);
  const auditCount = audit.entries.length;

  const second = workflows.complete(w.id);
  assert.equal(second.converged, true);
  assert.equal(second.traceId, first.traceId);
  assert.equal(w.state, 'completed');
  assert.equal(incident.status, 'resolved');
  assert.equal(audit.entries.length, auditCount, 'idempotent re-completion must not append audit entries');
  assert.equal(audit.list({ traceId: first.traceId }).filter(e => e.action === 'incident.resolved').length, 1);

  // 通过 transition 重复完成同样幂等
  const third = workflows.transition(w.id, 'completed') as any;
  assert.equal(third.converged, true);
  assert.equal(audit.entries.length, auditCount);
});

test('重复完成：incident 已被其他路径 resolved 时不写虚假关闭记录', () => {
  const { store, audit, workflows } = setup();
  const incident = addIncident(store);
  const w1 = driveToExecuting(workflows, incident.id);
  workflows.complete(w1.id);
  const w2 = driveToExecuting(workflows, incident.id);
  const before = audit.entries.length;

  const result = workflows.complete(w2.id);

  assert.equal(result.converged, true);
  assert.equal(w2.state, 'completed');
  const resolvedEntries = audit.entries.filter(e => e.action === 'incident.resolved');
  assert.equal(resolvedEntries.length, 1, 'second work order must not emit a duplicate incident.resolved');
  assert.ok(audit.entries.length > before, 'work order side of the chain is still audited');
  assert.equal(audit.list({ traceId: result.traceId }).some(e => e.action === 'incident.resolved'), false);
});

test('关联对象缺失：工单完成但标记补偿，绝不误关闭其他 incident', () => {
  const { store, audit, workflows } = setup();
  const missing = addIncident(store);
  const bystander = addIncident(store);
  const w = driveToExecuting(workflows, missing.id);
  store.incidents.delete(missing.id); // 关联对象在完成前丢失

  const result = workflows.complete(w.id);

  assert.equal(result.converged, false);
  assert.equal(result.compensationRequired, true);
  assert.equal(result.failure?.code, 'INCIDENT_NOT_FOUND');
  assert.equal(w.state, 'completed');
  assert.equal(w.compensationRequired, true);
  assert.ok(w.lastFailure);
  assert.equal(bystander.status, 'open', 'missing association must not close unrelated incidents');

  const chain = audit.list({ traceId: result.traceId });
  assert.deepEqual(chain.map(e => e.action), ['work_order.completed', 'incident.resolve_failed']);
  const failed = chain.find(e => e.action === 'incident.resolve_failed')!;
  assert.equal(failed.entityId, missing.id);
  assert.equal(failed.metadata.workOrderId, w.id);
  assert.equal(audit.entries.some(e => e.action === 'incident.resolved'), false);
});

test('incident 关闭失败：状态机拒绝时留下可补偿的明确结果', () => {
  const { store, audit, workflows } = setup();
  const incident = addIncident(store);
  const w = driveToExecuting(workflows, incident.id);
  (incident as any).status = 'corrupted-status'; // 关闭动作本身失败（非法状态机迁移）

  const result = workflows.complete(w.id);

  assert.equal(result.converged, false);
  assert.equal(result.compensationRequired, true);
  assert.equal(result.failure?.code, 'INVALID_INCIDENT_TRANSITION');
  assert.equal(w.state, 'completed');
  assert.equal(w.compensationRequired, true);
  assert.equal(w.lastFailure?.code, 'INVALID_INCIDENT_TRANSITION');
  assert.equal((incident as any).status, 'corrupted-status', 'failed close must not mutate incident state');
  assert.equal(audit.list({ traceId: result.traceId }).map(e => e.action).join(','), 'work_order.completed,incident.resolve_failed');
});

test('补偿重试：修复关联对象后重试收敛，沿用原 traceId', () => {
  const { store, audit, workflows } = setup();
  const incident = addIncident(store);
  const w = driveToExecuting(workflows, incident.id);
  store.incidents.delete(incident.id);
  const failed = workflows.complete(w.id);
  assert.equal(failed.compensationRequired, true);

  store.incidents.set(incident.id, incident); // 关联对象恢复
  const retried = workflows.retryCompensation(w.id);

  assert.equal(retried.converged, true);
  assert.equal(retried.compensationRequired, false);
  assert.equal(retried.traceId, failed.traceId, 'compensation retry keeps the original correlation id');
  assert.equal(incident.status, 'resolved');
  assert.equal(w.compensationRequired, false);
  assert.equal(w.lastFailure, undefined);

  const chain = audit.list({ traceId: failed.traceId });
  assert.deepEqual(chain.map(e => e.action), ['work_order.completed', 'incident.resolve_failed', 'incident.resolved']);

  // 补偿完成后再次重复完成：完全幂等
  const count = audit.entries.length;
  workflows.complete(w.id);
  assert.equal(audit.entries.length, count);
});

test('补偿重试：重复完成可继续处理待补偿工单；无待补偿时拒绝重试', () => {
  const { store, workflows } = setup();
  const incident = addIncident(store);
  const w = driveToExecuting(workflows, incident.id);
  store.incidents.delete(incident.id);
  workflows.complete(w.id);

  store.incidents.set(incident.id, incident);
  const continued = workflows.complete(w.id); // 重复完成视为继续处理
  assert.equal(continued.converged, true);
  assert.equal(incident.status, 'resolved');

  throwsCode(() => workflows.retryCompensation(w.id), 'NO_COMPENSATION_PENDING');
  const other = addIncident(store);
  const w2 = driveToExecuting(workflows, other.id);
  throwsCode(() => workflows.retryCompensation(w2.id), 'INVALID_TRANSITION');
});

test('审计查询：按 entityId 与 traceId 过滤同一条业务链', () => {
  const { store, audit, workflows } = setup();
  const incidentA = addIncident(store);
  const incidentB = addIncident(store);
  const wA = driveToExecuting(workflows, incidentA.id);
  const wB = driveToExecuting(workflows, incidentB.id);
  const resultA = workflows.complete(wA.id);
  workflows.complete(wB.id);

  const byTrace = audit.list({ traceId: resultA.traceId });
  assert.equal(byTrace.length, 2);
  assert.ok(byTrace.every(e => e.metadata.traceId === resultA.traceId));

  const byWorkOrder = audit.list({ entityId: wA.id });
  assert.ok(byWorkOrder.some(e => e.action === 'work_order.completed'));
  assert.ok(byWorkOrder.every(e => e.entityId === wA.id));

  const byIncident = audit.list({ entityId: incidentA.id });
  assert.deepEqual(byIncident.map(e => e.action), ['incident.resolved']);

  const all = audit.list();
  assert.ok(all.length >= byTrace.length);
  assert.ok(all.some(e => e.entityId === wB.id), 'other chains remain visible in unfiltered audit');
});

test('已有状态机不被削弱：非法迁移仍然拒绝', () => {
  const { store, workflows } = setup();
  const incident = addIncident(store);
  const w = workflows.create(incident.id, ['inspect']);

  throwsCode(() => workflows.transition(w.id, 'completed'), 'INVALID_TRANSITION'); // draft -> completed stays illegal
  throwsCode(() => workflows.transition(w.id, 'executing'), 'INVALID_TRANSITION');
  workflows.transition(w.id, 'approved');
  workflows.transition(w.id, 'executing');
  workflows.complete(w.id);
  throwsCode(() => workflows.transition(w.id, 'approved'), 'INVALID_TRANSITION');
  throwsCode(() => workflows.transition(w.id, 'cancelled'), 'INVALID_TRANSITION');

  const w2 = workflows.create(incident.id, []);
  workflows.transition(w2.id, 'approved');
  workflows.transition(w2.id, 'cancelled');
  throwsCode(() => workflows.transition(w2.id, 'executing'), 'INVALID_TRANSITION');
  throwsCode(() => workflows.complete(w2.id), 'INVALID_TRANSITION');
  assert.equal(incident.status, 'resolved', 'cancellation never touches the incident; only the first completion resolved it');

  throwsCode(() => workflows.complete('wo_missing'), 'WORK_ORDER_NOT_FOUND');
});
