# Moka 转写写入飞书 Base：脚本契约

本文件用于维护 `../scripts/sync-lark-base.mjs` 和 `../scripts/deduplicate-lark-base.mjs`。Agent 应调用脚本，不手工拼接写入命令。

## 固定目标

| 项目 | 值 |
|---|---|
| Base Token | `TeB3bU3ltak2MWsD8I0cdoxPnSf` |
| 面试官信息 Table ID | `tblyYe2fDhI0Lluv` |
| 面试转写 Table ID | `tblUYL6KszcCEzuw` |
| 业务联合键 | `applicationId + interviewId` |
| 关联字段 | 面试转写表的 `面试官（关联）` |

## 脚本概览

| 脚本 | 职责 | 调用方式 |
|---|---|---|
| `sync-lark-base.mjs` | 输入去重 → 批量写入面试官+面试转写 | `node sync-lark-base.mjs --input <json>` |
| `deduplicate-lark-base.mjs` | 飞书端去重清理：拉全表 → 找重复 → 删除 → 修复关联 | `node deduplicate-lark-base.mjs` |

## sync-lark-base.mjs

### 调用

```text
node "<Skill目录>/scripts/sync-lark-base.mjs" --input "<transcript.json绝对路径>"
```

可选参数：

- `--lark-cli <路径>`：指定 lark-cli 可执行文件路径
- `--dry-run`：只分析不写入
- `--timeout-ms <n>`：单次操作超时（默认 60000）
- `--concurrency <n>`：并发进程数（默认 5）

脚本使用 lark-cli user 身份。成功条件：退出码 0 且输出 JSON 的 `ok == true`。

### 设计原则

1. **不查飞书**：输入数据在内存中去重（`applicationId + interviewId` 联合键），直接批量写入
2. **先查面试官再创建**：先查已有面试官避免重复，不存在的才创建
3. **批量创建**：使用 `record-batch-create` 批量写入面试转写，一批最多 200 条
4. **并发**：面试官创建和查询并发执行（默认 5 并发）
5. **降级**：batch-create 失败时自动降级为逐条创建

### 输入

输入必须是 JSON 对象，包含 `records` 数组。字段映射：

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

### 输出

```json
{
  "ok": true,
  "inputRecords": 2,
  "deduplicatedRecords": 1,
  "inputDuplicatesDropped": 1,
  "created": 1,
  "createdInterviewers": 1,
  "batchCreateFallback": false,
  "records": []
}
```

`records` 中姓名已脱敏，不包含逐字稿、评估总结、问题分析。

## deduplicate-lark-base.mjs

### 调用

```text
node "<Skill目录>/scripts/deduplicate-lark-base.mjs"
```

可选参数：

- `--dry-run`：只分析不删除
- `--lark-cli <路径>`：指定 lark-cli 可执行文件
- `--timeout-ms <n>`：单次操作超时（默认 60000）

### 去重规则

1. **面试官信息表**：按「姓名」字段去重，保留每组第一条，删除其余
2. **面试转写表**：按「面试ID + 申请ID」联合键去重，保留每组第一条，删除其余
3. **关联修复**：删除重复记录后，双向 link 关系自动清理

### 输出

```json
{
  "ok": true,
  "dryRun": false,
  "interviewers": { "before": 57, "after": 9, "deleted": 48 },
  "transcripts": { "before": 102, "after": 16, "deleted": 86 },
  "linksFixed": 0
}
```

## 明确不做

- sync 脚本不查面试转写表是否已有记录（直接写入，去重交给 dedup 脚本）
- sync 脚本不删除任何 Base 记录
- dedup 脚本不创建新记录
- Agent 不手工重放脚本内部失败的写入操作；重新运行整个脚本即可
