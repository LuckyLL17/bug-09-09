# 工业过程数字孪生与异常根因推理服务

纯后端 Node.js + TypeScript + Fastify 项目，使用内存状态运行，不依赖 Docker、数据库或消息队列。

## 运行

```bash
npm install
npm test
npm start
```

## 业务闭环

设备拓扑版本 → 遥测接入 → 时间序列重放 → 阈值异常检测 → 拓扑影响分析 → 根因候选 → 工单状态机 → 审计追踪。

关键不变量：拓扑版本连续且按生效时间选择；遥测事件按业务时间和序列号重放；工单只能沿合法状态机迁移；所有重要操作产生审计记录。

## 工单完成与 incident 收敛

工单完成（`POST /work-orders/:id/complete`，或 transition 到 `completed`）会按关联关系同步收敛 incident：

- 成功：工单 `completed` + 关联 incident `resolved`，两侧审计共享同一 `correlationId`（可用 `GET /audit?correlationId=...` 串联整条业务链）。
- incident 关闭失败：返回 `202 pending_incident_closure`，工单完成但置 `compensationRequired=true` 并记录失败原因，可用 `POST /work-orders/:id/retry-incident-closure` 补偿重试。
- 关联 incident 缺失：返回 `424 incident_not_found`，工单保持 `executing`，绝不关闭其他 incident；关联恢复后重试即可收敛。
- 重复完成幂等：已收敛的工单再次完成不产生任何状态变更或审计记录；incident 已被其他路径关闭时也不重复写关闭记录。
