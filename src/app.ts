import Fastify from 'fastify';
import { TwinStore } from './domain/store';
import { AuditService } from './services/audit-service';
import { IncidentService } from './services/incident-service';
import { registerRoutes } from './routes/app-routes';

export function buildApp(store:TwinStore=new TwinStore(),audit=new AuditService()){
  const app=Fastify({logger:false});
  const incidents=new IncidentService(store,audit);
  registerRoutes(app,store,audit,incidents);
  return app;
}
