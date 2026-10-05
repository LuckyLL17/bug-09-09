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

关键不变量：拓扑版本连续且按生效时间选择；遥测事件按业务时间和序列号重放；工单只能沿合法状态机迁移；工单完成时按 `incidentId` 精确收敛关联 incident 为 `resolved`，跨模块操作以 `traceId` 贯穿审计（`GET /audit?traceId=` 可还原整条业务链）；incident 侧失败时工单落 `compensationRequired` 并可经 `POST /work-orders/:id/retry-compensation` 补偿重试，重复完成幂等且不产生虚假关闭记录；所有重要操作产生审计记录。
