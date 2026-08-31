# Moka 转写写入飞书 Base：脚本契约

本文件只用于维护 `../scripts/sync-lark-base.mjs`。正常采集必须运行脚本，禁止让 Agent 根据本文手工拼接写入命令。

## 固定目标

| 项目 | 值 |
|---|---|
| Base Token | `TeB3bU3ltak2MWsD8I0cdoxPnSf` |
| 面试官信息 Table ID | `tblyYe2fDhI0Lluv` |
| 面试转写 Table ID | `tblUYL6KszcCEzuw` |
| 业务联合键 | `applicationId + interviewId` |
| 关联字段 | 面试转写表的 `面试官（关联）` |

## 调用

```text
node "<Skill目录>/scripts/sync-lark-base.mjs" --input "<transcript.json绝对路径>"
```

可选参数：

- `--state-dir <目录>`：checkpoint、锁和临时文件目录；默认使用输入 JSON 所在目录。
- `--lark-cli <路径>`：当前 PATH 找不到 lark-cli 时指定真实可执行文件。
- `--base-token`、`--interviewer-table-id`、`--transcript-table-id`：仅用于测试或明确迁移目标表时覆盖固定值。

脚本只使用 lark-cli user 身份。成功条件同时满足：进程退出码为 0、输出 JSON 的 `ok == true`。

## 输入

输入必须是 JSON 对象并包含 `records` 数组。每条记录使用：

| 飞书字段 | 输入字段 | 写入格式 |
|---|---|---|
| 候选人姓名 | `candidateName` | text |
| 岗位名称 | `jobTitle` | text |
| 面试官 | `interviewerNames` | 数组以 `, ` 拼接 |
| 面试轮次 | `roundName` | text |
| 面试开始时间 | `startTime` | 毫秒时间戳转 UTC `YYYY-MM-DD HH:mm:ss` |
| 转写状态 | `transcriptStatus` | text |
| 逐字稿 | `transcript` | text |
| 评估总结 | `evaluationSummary` | text |
| 问题分析 | `questionAnalysis` | JSON 字符串 |
| Moka码 | `mokaCode` | text |
| Moka消息 | `mokaMessage` | text |
| 申请ID | `applicationId` | JSON number |
| 岗位ID | `jobId` | text |
| 面试ID | `interviewId` | JSON number |
| 轮次序号 | `round` | JSON number 或 null |
| 转写类型 | `transcriptType` | JSON number 或 null |
| 面试官（关联） | 由面试官表查询得到 | `[{"id":"<record_id>"}]` 或 null |

`applicationId` 和 `interviewId` 必须能无损转换为非负安全整数，否则整次脚本失败且不写该条记录。

## 强制幂等规则

1. 输入去重：先规范化两个 ID，再以 `<applicationId>:<interviewId>` 建 Map；同一输入中重复时只保留最后一条。
2. 全程持有 `lark-sync.lock`。另一实例已经运行时直接失败，不并发写入。
3. 每条记录串行处理，不使用 `record-batch-create`。
4. 创建前用两个 number 字段精确查询：

```json
{"logic":"and","conditions":[["申请ID","==",825605224],["面试ID","==",48113316]]}
```

5. 查询到 1 条时，用返回的真实 `record_id` 更新。
6. 查询到多条时，按 `record_id` 排序后只更新 canonical 第一条；记录全部重复 `record_id` 到 `duplicateConflicts`，不新增、不删除。
7. 查询到 0 条时，只允许一次创建尝试。
8. 创建命令超时、退出非 0、返回无法解析或 `ok != true` 时，禁止重放创建；先重复只读查询。查到记录即记为 `recoveredCreate`，仍查不到则失败并等待下次完整运行。
9. 创建返回成功后仍进行回查；回查短暂未命中时允许只重试读取，禁止重试创建。
10. 每条完成后把联合键、阶段和 `record_id` 原子写入 `lark-sync-state.json`。checkpoint 不保存姓名、逐字稿或其他候选人正文。
11. 下一次运行不信任 checkpoint 作为唯一事实来源，仍以飞书精确查询为准，因此脚本崩溃后可以安全恢复。

面试官信息使用同样规则：按完整姓名精确查询，创建结果不明确时先回查，禁止盲目重放。面试官姓名只存在于授权 Base 和短生命周期请求文件；摘要仅输出脱敏姓名。

## 单条写入事务

对每条去重后的输入依次执行：

1. 精确查询或安全创建所有面试官，得到关联 `record_id`。
2. 组装 16 个普通字段和 `面试官（关联）`。
3. 精确查询面试转写联合键。
4. 已存在则带 `--record-id` 更新；不存在则尝试创建一次。
5. 创建无论成功或结果不明确都执行回查。
6. 写 checkpoint，随后处理下一条。

关联字段与普通字段放在同一次 `record-upsert` 中，避免“普通字段已经创建、关联步骤失败”造成 Agent 重放整条创建。

## 状态和临时文件

- `lark-sync.lock`：跨进程互斥锁。正常退出自动删除；发现所属 PID 已不存在时可恢复陈旧锁。
- `lark-sync-state.json`：只保存联合键、阶段、record_id 和时间。
- `.moka-lark-sync-*`：短生命周期请求目录。脚本启动时清理上次异常退出残留，结束时再次删除。

不得让 Agent 手动删除这些文件来绕过正在运行的锁。不得把状态和临时请求文件写进仓库或 Skill 目录。

## 输出

脚本 stdout 是脱敏 JSON 摘要，主要字段：

```json
{
  "ok": true,
  "inputRecords": 2,
  "deduplicatedRecords": 1,
  "inputDuplicatesDropped": 1,
  "created": 1,
  "recoveredCreates": 0,
  "updated": 0,
  "createdInterviewers": 1,
  "recoveredInterviewerCreates": 0,
  "duplicateConflicts": [],
  "interviewerDuplicateConflicts": [],
  "records": []
}
```

`records` 中姓名已经脱敏，不包含逐字稿、评估总结、问题分析、手机号、邮箱或凭证。错误输出不得复制 lark-cli 原始 payload 或可能包含姓名的上游响应。

## 明确不做

- 不清理飞书表内历史重复记录。
- 不删除任何 Base 记录。
- 不把 `record-upsert` 当作按业务键自动 upsert；不带 `--record-id` 就是创建。
- 不在脚本失败后由 Agent 手工补写或重放 create。
