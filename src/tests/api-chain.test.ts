import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../app';

test('端到端：遥测 -> 异常 -> 工单 -> 完成收敛 -> 审计链查询', async () => {
  const app = buildApp();

  await app.inject({ method: 'POST', url: '/telemetry', payload: { assetId: 'pump-1', metric: 'vibration', value: 9.5, unit: 'mm/s', observedAt: 1000, quality: 'good' } });
  const detectRes = await app.inject({ method: 'POST', url: '/anomalies/detect', payload: { assetId: 'pump-1', metric: 'vibration', threshold: 5 } });
  const incident = detectRes.json();
  assert.equal(incident.status, 'open');

  const createRes = await app.inject({ method: 'POST', url: '/work-orders', payload: { incidentId: incident.id, steps: ['inspect'] } });
  const wo = createRes.json();
  for (const state of ['approved', 'executing']) {
    const r = await app.inject({ method: 'POST', url: `/work-orders/${wo.id}/transition`, payload: { state } });
    assert.equal(r.statusCode, 200);
  }

  const completeRes = await app.inject({ method: 'POST', url: `/work-orders/${wo.id}/transition`, payload: { state: 'completed' } });
  assert.equal(completeRes.statusCode, 200);
  const completion = completeRes.json();
  assert.equal(completion.converged, true);
  assert.equal(completion.workOrder.state, 'completed');
  assert.equal(completion.incident.status, 'resolved');
  assert.ok(completion.traceId);

  // 重复完成幂等
  const again = await app.inject({ method: 'POST', url: `/work-orders/${wo.id}/complete` });
  assert.equal(again.json().converged, true);

  // 审计查询：按 traceId 还原同一条业务链
  const auditRes = await app.inject({ method: 'GET', url: `/audit?traceId=${completion.traceId}` });
  const chain = auditRes.json();
  assert.deepEqual(chain.map((e: any) => e.action), ['work_order.completed', 'incident.resolved']);
  assert.ok(chain.every((e: any) => e.metadata.traceId === completion.traceId));

  const byIncident = await app.inject({ method: 'GET', url: `/audit?entityId=${incident.id}` });
  assert.deepEqual(byIncident.json().map((e: any) => e.action), ['incident.resolved']);

  const auditCount = (await app.inject({ method: 'GET', url: '/audit' })).json().length;
  await app.inject({ method: 'POST', url: `/work-orders/${wo.id}/complete` });
  const auditCountAfter = (await app.inject({ method: 'GET', url: '/audit' })).json().length;
  assert.equal(auditCountAfter, auditCount, 'idempotent completion must not append audit entries');

  await app.close();
});
