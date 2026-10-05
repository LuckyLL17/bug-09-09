import { FastifyInstance } from 'fastify';
import { TwinStore } from '../domain/store';
import { TelemetryService } from '../services/telemetry-service';
import { AnomalyService } from '../services/anomaly-service';
import { TopologyService } from '../services/topology-service';
import { RootCauseService } from '../services/root-cause-service';
import { WorkflowService, CompleteOutcome } from '../services/workflow-service';
import { AuditService } from '../services/audit-service';
import { IncidentLifecyclePort, IncidentService } from '../services/incident-service';

function completionStatus(res:any,outcome:CompleteOutcome){
  switch(outcome.status){
    case 'converged': return res.code(200).send(outcome);
    case 'pending_incident_closure': return res.code(202).send(outcome);
    case 'incident_not_found': return res.code(424).send(outcome);
  }
}

export function registerRoutes(app:FastifyInstance,store:TwinStore,audit:AuditService,incidents:IncidentLifecyclePort){
  const telemetry=new TelemetryService(store);
  const anomalies=new AnomalyService(store);
  const topology=new TopologyService(store);
  const causes=new RootCauseService(store,topology);
  const workflows=new WorkflowService(store,incidents,audit);
  const incidentService=incidents instanceof IncidentService?incidents:undefined;

  app.get('/health',async()=>({ok:true}));

  app.post('/topology',async(req,res)=>{try{return topology.publish(req.body as any)}catch(e:any){return res.code(400).send({code:e.code,message:e.message})}});
  app.post('/telemetry',async(req)=>{const e=telemetry.ingest(req.body as any);audit.record('telemetry.ingest',e.id,{assetId:e.assetId});return e});
  app.get('/telemetry/replay',async(req)=>{const q=req.query as any;return telemetry.replay(Number(q.from),Number(q.to))});
  app.post('/anomalies/detect',async(req)=>{const b=req.body as any;return anomalies.detect(b.assetId,b.metric,Number(b.threshold))});
  app.get('/incidents/:id/root-cause',async(req,res)=>{try{return causes.analyze((req.params as any).id)}catch(e:any){return res.code(404).send({message:e.message})}});

  // incident 生命周期迁移（保留合法状态机）
  app.patch('/incidents/:id/transition',async(req,res)=>{
    try{return incidentService?.transition((req.params as any).id,(req.body as any).status)}
    catch(e:any){return res.code(e.code==='INCIDENT_NOT_FOUND'?404:400).send({code:e.code,message:e.message})}
  });

  app.post('/work-orders',async(req,res)=>{
    try{return workflows.create((req.body as any).incidentId,(req.body as any).steps||[])}
    catch(e:any){return res.code(400).send({code:e.code,message:e.message})}
  });

  // 纯状态机迁移；目标状态为 completed 时自动升级为“完成+incident 收敛”编排
  app.post('/work-orders/:id/transition',async(req,res)=>{
    try{
      const state=(req.body as any).state;
      if(state==='completed') return completionStatus(res,workflows.complete((req.params as any).id));
      return workflows.transition((req.params as any).id,state);
    }catch(e:any){return res.code(e.code==='WORK_ORDER_NOT_FOUND'?404:400).send({code:e.code,message:e.message})}
  });

  // 完成工单并同步收敛关联 incident
  app.post('/work-orders/:id/complete',async(req,res)=>{
    try{return completionStatus(res,workflows.complete((req.params as any).id))}
    catch(e:any){return res.code(e.code==='WORK_ORDER_NOT_FOUND'?404:400).send({code:e.code,message:e.message})}
  });

  // 补偿重试：重新收敛此前 incident 关闭失败 / 关联缺失的工单
  app.post('/work-orders/:id/retry-incident-closure',async(req,res)=>{
    try{return completionStatus(res,workflows.retryIncidentClosure((req.params as any).id))}
    catch(e:any){return res.code(e.code==='WORK_ORDER_NOT_FOUND'?404:400).send({code:e.code,message:e.message})}
  });

  // 审计查询：支持按实体、跨模块 correlationId、动作类型过滤
  app.get('/audit',async(req)=>audit.list(req.query as any));
}
