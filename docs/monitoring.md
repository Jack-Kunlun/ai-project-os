# 运行监控基线

本基线覆盖本地或单节点 Compose 部署的应用、数据库与自动化 Worker。它提供可采集信号，不替代业务功能、外部连接或备份恢复验收。

## 健康信号

- `postgres` 容器健康检查证明数据库接受连接。
- `app` 容器健康检查要求 `/api/health` 返回 HTTP 2xx、`status: ok` 和 `database: up`。
- `worker` 容器健康检查要求数据库中的当前部署心跳为 `up`，且不超过 45 秒。
- `/api/health` 的 `worker.status` 可能是 `up`、`starting`、`degraded`、`stopping`、`stale` 或 `missing`。应用可用并不自动代表 Worker 可用。

建议至少每 30 秒采集一次容器状态和 `/api/health`，连续两次非健康后告警。维护窗口中的 `starting` 与 `stopping` 应与变更记录关联，不能长期静默忽略。

## Worker 结构化日志

Worker 把每个运行事件写为一行 JSON，固定包含：

- `timestamp`：UTC ISO 8601 时间。
- `level`：`info`、`warn` 或 `error`。
- `component`：固定为 `automation-worker`。
- `event`：稳定事件名。
- `worker`：部署级名称，不含随机进程标识或凭据。

主要事件包括 `worker.started`、`worker.stopped`、`worker.recovered`、`worker.action_cycle_completed`、`worker.automation_cycle_completed` 以及相应的 `*_failed`。完成事件只包含领取、成功、失败和恢复等计数；错误事件只包含稳定安全错误码，不写异常正文、请求正文、Cookie、Authorization 或外部服务凭据。

生产采集器应把每行作为独立 JSON 解析。无法解析的行、任一 `error` 事件、持续 `degraded`、心跳 `stale`、容器重启增长都应告警。业务动作失败仍需在产品的动作审计或自动化运行记录中处理；日志不是审计账本。

## 快速检查

```bash
docker compose ps --all
curl --fail http://127.0.0.1:3000/api/health
docker compose logs --tail=100 worker
```

健康检查脚本不会输出数据库地址、Worker 随机实例标识或密钥。若监控平台需要更详细信息，应从只读数据库副本或受保护的内部采集器获取，不要扩大公开健康接口的数据范围。
