import { newId } from '../core/id';
export interface AuditEntry {id:string;action:string;entityId:string;at:number;metadata:Record<string,unknown>}
export interface AuditQuery {entityId?:string;correlationId?:string;action?:string}

export class AuditService {
  entries:AuditEntry[]=[];

  record(action:string,entityId:string,metadata:Record<string,unknown>={}){
    const e:AuditEntry={id:newId('audit'),action,entityId,at:Date.now(),metadata};
    this.entries.push(e);
    return e;
  }

  /**
   * 查询审计记录。三种过滤条件可组合使用：
   *  - entityId：按业务实体（工单 / incident 等）
   *  - correlationId：跨模块串联同一条业务链上的全部记录（完成、失败、补偿重试）
   *  - action：按动作类型
   */
  list(query:AuditQuery={}):AuditEntry[]{
    return this.entries.filter(e=>
      (query.entityId===undefined||e.entityId===query.entityId)&&
      (query.correlationId===undefined||e.metadata.correlationId===query.correlationId)&&
      (query.action===undefined||e.action===query.action)
    );
  }
}
