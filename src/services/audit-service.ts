import { newId } from '../core/id';
export interface AuditEntry {id:string;action:string;entityId:string;at:number;metadata:Record<string,unknown>}
export interface AuditFilter {entityId?:string;traceId?:string}
export class AuditService {
  entries:AuditEntry[]=[];
  record(action:string,entityId:string,metadata:Record<string,unknown>={}){const e={id:newId('audit'),action,entityId,at:Date.now(),metadata};this.entries.push(e);return e;}
  list(filter:AuditFilter|string={}){
    const f:AuditFilter=typeof filter==='string'?{entityId:filter}:filter;
    return this.entries.filter(e=>(!f.entityId||e.entityId===f.entityId)&&(!f.traceId||e.metadata?.traceId===f.traceId));
  }
}
