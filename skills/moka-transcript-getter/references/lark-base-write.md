# Moka 转写写入飞书 Base：脚本契约

本文件用于维护 `../scripts/sync-lark-base.mjs` 和 `../scripts/deduplicate-lark-base.mjs`。Agent 应调用脚本，不手工拼接写入命令。

## 目标 Base

目标飞书多维表格**不再硬编码**，由用户在首次配置时写入：

```json
// ~/.opencli/moka-config.json
{ "feishu_base_url": "https://xxx.feishu.cn/base/<app_token>?table=<table_id>" }
```

两个脚本启动时都会读取该配置：

1. 优先级：`--base-token`/`--transcript-table-id` 显式参数 > `--feishu-base-url` 参数 > `--config` 指定文件 > 默认 `~/.opencli/moka-config.json`。
2. 从 `feishu_base_url` 中解析：路径段 `/base/<app_token>` 得到 Base app_token，query 参数 `?table=<table_id>` 得到面试转写表 table_id。
3. URL 必须同时包含 `/base/<app_token>` 与 `?table=<table_id>`，否则脚本报错 `feishu_base_url must include ?table=<table_id>`。

因此首次配置时若走"用户指定 URL"路径，务必让用户复制**已选中面试转写表的完整 URL**，不能只给 Base 首页 URL。若走"智能体新建"路径，创建 Base 后需追加打开面试转写表并取当前 URL。

| 项目 | 值 |
|---|---|
| Base app_token | 从 `feishu_base_url` 路径 `/base/<app_token>` 解析 |
| 面试转写 Table ID | 从 `feishu_base_url` query `?table=<id>` 解析 |
| 业务联合键 | `applicationId + interviewId` |
| 去重键字段（按显示名解析） | 面试转写表必须包含名为「面试ID」「申请ID」的字段；dedup 脚本启动时按字段名调 `+field-list` 拿到当前表的真实 `field_id` 再拉数据，不再硬编码 `field_id` |

> 面试官信息表已废弃，不再写入或去重。面试官姓名仅作为 text 字段写入面试转写表的「面试官」列，不另建关联。
> 字段显示名固定为「面试ID」「申请ID」，两个名字变了就要同步改 dedup 脚本顶部的 `INTERVIEW_ID_FIELD_NAME` / `APPLICATION_ID_FIELD_NAME` 常量。字段内部 `field_id` 允许每张 Base 各不相同——首次配置走"智能体新建"路径新建的 Base，只要含这两个字段名就能直接跑。

## 脚本概览

| 脚本 | 职责 | 调用方式 |
|---|---|---|
| `sync-lark-base.mjs` | 输入去重 → 批量写入面试转写 | `node sync-lark-base.mjs --input <json>` |
| `deduplicate-lark-base.mjs` | 飞书端去重清理：拉全表 → 找重复 → 逐条删除 | `node deduplicate-lark-base.mjs` |

## sync-lark-base.mjs

### 调用

```text
node "<Skill目录>/scripts/sync-lark-base.mjs" --input "<transcript.json绝对路径>"
```

可选参数：

- `--lark-cli <路径>`：指定 lark-cli 可执行文件路径。定时任务中 lark-cli 可能不在默认 PATH，需通过 `where lark-cli`（Windows）或 `which lark-cli`（macOS/Linux）定位后传递
- `--config <路径>`：指定配置文件路径（默认 `~/.opencli/moka-config.json`）
- `--feishu-base-url <url>`：不读 config，直接指定目标 Base URL
- `--base-token <token>` / `--transcript-table-id <id>`：分别覆盖解析结果；两个同时传时完全跳过 URL 解析
- `--dry-run`：只分析不写入
- `--timeout-ms <n>`：单次操作超时（默认 60000）

脚本使用 lark-cli user 身份。成功条件：退出码 0 且输出 JSON 的 `ok == true`。

### 设计原则

1. **不查飞书**：输入数据在内存中去重（`applicationId + interviewId` 联合键），直接批量写入
2. **批量创建**：使用 `record-batch-create` 批量写入面试转写，一批最多 200 条
3. **降级**：batch-create 失败时自动降级为逐条创建
4. **Windows 命令行长度安全**：当 `--json` 参数超过 3000 字符时，自动将 JSON 写入当前工作目录下的临时文件，改用 lark-cli 的 `--json @./filename` 语法引用。lark-cli 要求 `@file` 路径必须是相对路径（相对于 cwd）。临时文件在命令执行后自动删除。

> **为什么需要 @file 机制**：Windows CreateProcess 命令行上限约 32767 字符，但 shell 层（`shell: true`）有额外开销。面试转写包含逐字稿正文，16 条记录的 batch-create JSON 约 480KB，远超限制。直接传参会导致 `spawn ENAMETOOLONG` 错误。lark-cli 的 `@file.json` 语法支持从文件读取 JSON，但要求文件路径是相对路径（`@./file.json`），不接受绝对路径。

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
| 面试官复盘-开场与流程 | `reviewScores.openingFlow` | JSON number(0~5,0.5 精度)或 null |
| 面试官复盘-提问质量 | `reviewScores.questionQuality` | JSON number(0~5,0.5 精度)或 null |
| 面试官复盘-倾听 | `reviewScores.listening` | JSON number(0~5,0.5 精度)或 null |
| 面试官复盘-追问深度 | `reviewScores.followUpDepth` | JSON number(0~5,0.5 精度)或 null |
| 面试官复盘-尺度把控 | `reviewScores.scaleControl` | JSON number(0~5,0.5 精度)或 null |
| 面试官复盘-反馈体验 | `reviewScores.feedbackExperience` | JSON number(0~5,0.5 精度)或 null |
| 面试复盘报告 | `reviewReportUrl` | URL 超链接对象 `{ link, text: "点击查看" }`,非 `https?://` 开头传 null |

> 六维复盘字段的评分锚点见 [`interviewer-review-workflow.md`](interviewer-review-workflow.md)。命中红线的维度记 **0 分**;评分/上传失败的 record 上述字段自动传 null,飞书 Base 数字列与超链接列允许空,不影响其他列写入。
> 飞书 Base 的 URL/超链接列在 `+record-batch-create` payload 里接收 `{ link, text }` 对象;`asOptionalUrl()` 会把合法 `https?://` URL 包成该对象,非法或空值直接返回 `null` 让脚本跳过此列。若真实写入报"URL 列类型不匹配",在 `asOptionalUrl` 里改成返回裸字符串重试即可(飞书两种格式接受度视 field 类型而定)。
> 「面试官(人员)」列与「处理状态」列不在本流水线的写入范围内——用户明确不管,飞书 Base 中允许为空。

### 输出

```json
{
  "ok": true,
  "inputRecords": 2,
  "deduplicatedRecords": 1,
  "inputDuplicatesDropped": 1,
  "created": 1,
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
- `--lark-cli <路径>`：指定 lark-cli 可执行文件路径（同 sync 脚本）
- `--config <路径>`：指定配置文件路径（默认 `~/.opencli/moka-config.json`）
- `--feishu-base-url <url>`：不读 config，直接指定目标 Base URL
- `--base-token <token>` / `--transcript-table-id <id>`：分别覆盖解析结果
- `--timeout-ms <n>`：单次操作超时（默认 60000）
- `--concurrency <n>`：并发删除进程数（默认 3；过高可能触发飞书 API 限流）

### 删除策略：逐条删除（关键设计决策）

**不使用** `+record-delete --json '{"record_id_list":[...]}'` 批量删除接口。

**原因**：批量删除接口在实测中会静默失败（报错 `batch delete N records failed`），即使写入操作使用相同凭证完全成功。这不是权限问题 — 同一用户在同一张表上 `batch-create` 成功但 `batch delete` 失败，说明是飞书批量删除接口本身的限制或不稳定。

**实际做法**：逐条调用 `+record-delete --record-id <id> --yes`，每次只删一条。实测 4 条重复记录一次全部删除成功，无任何失败。

**并发控制**：默认 3 并发（可配 `--concurrency`），保守值以避免飞书 API 限流。每条删除都有独立的成功/失败反馈，某条失败不影响其他条目。

### 去重规则

1. **面试转写表**：按「面试ID + 申请ID」联合键去重（两个值同时相同才算重复），保留每组第一条，删除其余
2. **空行跳过**：面试ID 或申请ID 为 null 的记录不参与去重，不会被删除

### 输出

```json
{
  "ok": true,
  "dryRun": false,
  "transcripts": {
    "before": 102,
    "after": 16,
    "deleted": 86,
    "failed": 0,
    "errors": []
  }
}
```

**失败处理**：如果有任何一条删除失败，`ok` 设为 `false`，但 `deleted` 仍记录成功删除的数量，`failed` 和 `errors` 记录失败详情。Agent 可据此决定是否重试。

### 错误恢复

如果 `ok == false`：
- 检查 `errors` 数组中的 `recordId` 和错误信息
- 大多数失败是暂时性的（飞书 API 限流），稍后重跑脚本即可
- 也可以使用 `--dry-run` 先分析当前重复情况，再决定是否删除

## 明确不做

- sync 脚本不查面试转写表是否已有记录（直接写入，去重交给 dedup 脚本）
- sync 脚本不删除任何 Base 记录
- dedup 脚本不创建新记录
- dedup 脚本不使用 batch delete 接口（逐条删除更可靠）
- 不写入或维护面试官信息表（已废弃）
- Agent 不手工重放脚本内部失败的写入操作；重新运行整个脚本即可
