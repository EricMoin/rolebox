# Graph v3：执行限额、审批与存储恢复

本页记录当前 v3 操作约定。架构与平台限制见[协议说明](graph-outcome-protocol.md)，
具体检查证据与尚未覆盖的环境见[执行计划](graph-v3-execution-plan.md)。

## 运行级执行次数

在 v3 声明根部设置 `budget.max_executions`，值为非负安全整数：

```json
{
  "version": 3,
  "name": "bounded-work",
  "budget": { "max_executions": 8 },
  "nodes": [
    {
      "id": "work",
      "agent": "worker",
      "prompt": "Complete the assigned work.",
      "outcomes": [{ "id": "done" }]
    }
  ],
  "edges": []
}
```

额度属于一个 run，覆盖所有节点、循环轮次和新建的手动重试 attempt。派发效果、
attempt 与额度预留在同一个 SQLite 事务中提交。同一 attempt 的投递重试和恢复
不重复计数；结束、取消或对账不会返还已经预留的执行次数。终态图重新执行产生新 run，
从新 run 的额度开始计数。未声明该字段表示没有次数上限；`0` 阻止首次派发。

额度不足返回 `budget-exhausted`，不写入新 attempt、凭证或派发效果。如果一次接受
需要同时启动后继节点，而后继节点不能预留额度，该接受事务整体回滚。已经派发的
attempt 仍保留其身份；无需启动后继节点的终结结果可以在恰好用完额度时接受。
预算报告同时列出 `runLimits.max_executions` 和 `totals.executions`。

节点级 `max_retries` 尚未实现自动重试语义。当前解析器、编译器及运行时均明确拒绝
该字段，包括值 `0`；不能用它代替执行次数上限。

## 宿主授予审批权

Pi 与 dsh 均在启动时从 `ROLEBOX_GRAPH_APPROVAL_POLICY` 读取 JSON 策略。
这是操作者安装的可信配置，不是声明或工具参数：

```json
{
  "id": "review-policy",
  "revision": "1",
  "rules": [
    {
      "graphId": "review-flow",
      "nodeId": "review",
      "approverSessions": ["reviewer-session"],
      "mode": "independent-review"
    }
  ]
}
```

`graph_control` 的 `approval-request` 只能提名策略允许的审批会话，并且仍需指定
`expires_at`。`independent-review` 是默认模式，即使声明者出现在允许列表中也禁止
自批。只有显式配置 `operator-confirmation` 才允许确认自己发起的请求；该模式不提供
独立审查。重复作用于同一 graph/node 的策略规则会被拒绝。

请求保存策略 ID、revision、内容摘要和模式。`approve`/`reject` 必须来自请求记录的
会话，且宿主仍安装相同的策略内容。同名同 revision 的策略若内容变化，也不能决定
原来的待审批请求。配置缺失或无效时拒绝创建审批请求，不退回“声明者任选审批人”。

需要审批的 outcome 使用 `principal-approval@1` 验收原语。生产能力预检会在声明阶段
拒绝缺少对应审批策略的图。旧实验原语 `human-approval` 已移除：平台会话归属只能
证明主体身份，不能证明操作者是真人。当前配置与验收均不作真人操作来源保证。

## 存储身份与恢复

当前存储格式为 **9**。SQLite 元数据的 `store_id` 与同目录的
`graph-store.identity` 相互绑定。身份文件只保存版本和随机存储 ID，不保存图、
attempt、回执、凭证或策略；所有业务状态仍以 SQLite 为唯一权威。

首次初始化先独占创建并同步身份文件，再初始化数据库。只有两者都不存在、且没有
退役权威记录的目录才可首次初始化。后续行为如下：

| 情况 | 行为 |
| --- | --- |
| 身份存在，数据库缺失 | 返回存储错误，停止恢复，不重建数据库 |
| 初始化在身份创建后中断 | 明确阻塞；不把中断当成新工作区继续初始化 |
| 数据库为空、结构损坏或身份不匹配 | 拒绝读取和执行 |
| 数据库存在，身份文件缺失或损坏 | 拒绝重新绑定 |
| 正常备份恢复 | 停止宿主后恢复一致的数据库与匹配身份文件，再启动核对 |
| 旧存储格式 | 明确不支持，不迁移、不覆盖、不自动执行 |

已经打开的连接也会检查文件是否消失、被替换或身份改变。并发首次初始化只有
身份创建者可以写入；其他调用遇到初始化尚未完成时明确拒绝，待完整初始化后可重新打开。
失败初始化留下的记录不能自动删除或改绑。

数据库与全部外部身份记录若一起丢失，就无法从本地恢复历史。此时新建空存储不含
任何待恢复图，也不会凭空重新执行历史工作；应先恢复备份或人工核对宿主执行事实。
这些机制用于防止意外重建和状态改绑，不构成对同账号 worker 的操作系统权限隔离。
