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
| `backfill-interviewer-user.mjs` | dedup 之后运行,把「面试官」text 列的姓名解析为 open_id,回填「面试官(人员)」user 列 | `node backfill-interviewer-user.mjs` |

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
| 面试复盘报告 | `reviewReportUrl` | 文本 URL 字符串,非 `https?://` 开头传 null |
| 是否标红 | 由 `reviewScores.redLineHits` 派生 | 单选选项名字符串,严格「是」/「否」,不带空格。`redLineHits` 数组非空 → 「是」,否则 → 「否」;评分未跑(无 `reviewScores` 与 `reviewError`)时传 null,不占列 |
| 是否已通知 | 由本流水线固定值 | 单选选项名字符串,固定写「否」;后续人工/其他流程负责翻为「是」,不在本流水线职责内。评分未跑时传 null |

> 六维复盘字段的评分锚点见 [`interviewer-review-workflow.md`](interviewer-review-workflow.md)。命中红线的维度记 **0 分**;评分/上传失败的 record 上述字段自动传 null,飞书 Base 数字列与文本列允许空,不影响其他列写入。
> **「是否标红」「是否已通知」是飞书单选列**(不是复选/多选)。写入值必须与 Base 上选项名**逐字节相等**——多一个空格或写成半角字母都会被飞书拒收或落成新选项。当前脚本硬编码「是」/「否」两个字面量,若有人在 Base 上把选项名改了,先在 Base 侧改回来,不改脚本。
> **「面试复盘报告」列在飞书 Base 里必须是「文本」或「超链接」类型**(不能是「附件」)。当前 `asOptionalUrl()` 把合法 URL 直接返回**裸字符串**,`+record-batch-create` payload 里作为文本值写入,飞书文本列/超链接列都接受该格式。若真实写入报"URL 列类型不匹配",先在飞书 Base 界面把该列类型改为「文本」而不是回来改脚本。
> 「处理状态」列不在本流水线的写入范围内。「面试官(人员)」列由 `backfill-interviewer-user.mjs` 在 dedup 之后自动回填,失败或姓名解析不上时该列留空,不影响 sync 本步已写入的其他列。

### 输出

```json
{
  "ok": true,
  "inputRecords": 2,
  "deduplicatedRecords": 1,
  "inputDuplicatesDropped": 1,
  "created": 1,
  "failed": 0,
  "errors": [],
  "batchCreateFallback": false,
  "records": []
}
```

`records` 只用于概览，不含逐字稿、评估总结、问题分析（长文本挤日志）。候选人姓名字段直接原文，不做处理。

**成功判定 4 要素**（4 个必须全部满足，缺一即视为失败重跑）：

1. 退出码 `0`
2. stdout JSON 中 `ok === true`
3. `created === deduplicatedRecords`（没有静默失败的 record）
4. `failed === 0`（`errors` 数组为空）

只看 `ok:true` 是不够的——之前 `ok` 的语义包含"部分成功就算 ok",现已收紧,只有上述四条都过才是真通过。

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

1. **面试转写表**：按「面试ID + 申请ID」联合键去重（两个值同时相同才算重复），**保留每组最新一条**（record_id 倒序遍历下先命中的那条），删除其余
2. **为什么保留最新**：每天 sync 会追加当天带评分和 HTML URL 的新记录，如果保留最旧反而会删掉当天新增的评分数据；倒序保留最新等价于保留"最近一次带评分的完整记录"
3. **空行跳过**：面试ID 或申请ID 为 null 的记录不参与去重，不会被删除

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

## backfill-interviewer-user.mjs

### 调用

```text
node "<Skill目录>/scripts/backfill-interviewer-user.mjs"
```

可选参数:

- `--lark-cli <路径>`:指定 lark-cli 可执行文件路径(同 sync 脚本)
- `--config <路径>`:指定配置文件路径(默认 `~/.opencli/moka-config.json`)
- `--feishu-base-url <url>`:不读 config,直接指定目标 Base URL
- `--base-token <token>` / `--transcript-table-id <id>`:分别覆盖解析结果
- `--dry-run`:只分析不写入
- `--timeout-ms <n>`:单次操作超时(默认 60000)
- `--concurrency <n>`:并发 upsert 进程数(默认 3;过高可能触发飞书 API 限流)

### 执行时机

**必须在 dedup 之后运行**:

1. 先 dedup 保留最新一条,再 backfill 只填留下的这条,避免为马上要删除的旧记录浪费 API 调用。
2. sync 每天会追加当天带评分的新记录,若 backfill 在 dedup 之前跑,可能填的是即将被删除的旧记录。

### 4 步算法

1. **field-list**:拿「面试官」text 列 / 「面试官(人员)」user 列 / 「面试ID」三列的 field_id。人员列显示名支持容错匹配:
   - 精确匹配 `INTERVIEWER_USER_FIELD_NAME` 常量(当前是「面试官 (人员 )」,带括号内外空格)。
   - 归一化匹配:剥掉所有 ASCII/全角空格 + 把全角括号 `（）` 转成半角 `()`,归一化后匹配到 `面试官(人员)` 就认。
   - 归一化后同时匹配到多列:直接报错,让人先在飞书 Base 上把重复列改掉,不猜。
2. **record-list --field-id ...**:按行投影只拉三个字段(不带逐字稿正文),分页拉全量。得到每行的 `(record_id, 面试官 text, 面试官(人员) users, 面试ID)` 元组。挑出「面试官 text 有值 & 面试官(人员) user 为空」的行入 `needing[]`。
3. **建 `name → open_id` 映射**(两个来源,合并):
   - **来源 A(同表已填充记录)**:遍历所有行,若「面试官」= "张三、李四" 且「面试官(人员)」= `[{id:ou_A},{id:ou_B}]`,且两侧数量一致,按顺序拆解出 `张三→ou_A`、`李四→ou_B`。**数量不一致的行跳过**,记入 `existingSkipped` 但不算 fatal;这防止用户手动改过某一侧导致对不齐。
   - **来源 B(contact +search-user)**:`needing[]` 里所有姓名去重后,凡是来源 A 里没有的,用 `lark-cli contact +search-user --query <name>` 兜底,取第一条 `open_id`。串行,不并发——contact API 一般不慢,并发太高容易限流。
4. **逐条 upsert**:`+record-upsert --record-id X --json '{"面试官(人员)":[{id:openId1},{id:openId2},...]}'`。默认 3 并发。**不用** `+record-batch-update` — 那是同值批量更新,每条 record 的人员不同,必须逐条。

### 姓名拆分

按 `/[、,，/;；]+/` 拆分(顿号、中英文逗号、正/反斜杠、中英文分号)。sync 脚本目前用 `, ` 拼接,但同表既往人工录入可能混用中英文符号,这里一律容错。

### 单元格形态兼容

- 文本单元格:接受纯字符串 / 字符串数组 / `[{text}]` / `[{value}]` / `[{name}]` / `{text}` / `{value}` 各种飞书返回的形态。
- 人员单元格:接受 `[{id/open_id/openId, name}]` 数组。**只取 `ou_` 开头的 id**,避免误把其他类型 id 计入。

### 输出

```json
{
  "ok": true,
  "dryRun": false,
  "scanned": 102,
  "needsBackfill": 12,
  "backfilled": 11,
  "skipped": 1,
  "failed": 0,
  "namesResolvedFromExisting": 8,
  "namesResolvedFromSearch": 3,
  "unresolvedNames": [{ "name": "李某某", "reason": "no result" }],
  "errors": []
}
```

### 成功判定

**必要条件**(缺一即算失败):

1. 退出码 `0`
2. stdout JSON 中 `ok === true`
3. `failed === 0`

**允许非空,不算 fatal**:

- `unresolvedNames`:`contact +search-user` 找不到的姓名(过滤条件、离职、飞书 contact 索引未收录等常见原因)。
- `skipped`:某 record 的所有姓名都解析不上,该 record 「面试官(人员)」保持为空。
- `errors[].phase === "partial-fill"`:某 record 只解析到一部分姓名,人员列部分回填,已尽力。
- `errors[].phase === "build-name-map"`:某些同表已填充记录 名字数量 ≠ 人员数量,被跳过;不影响 needing[] 处理。

`failed > 0` 出现在 `errors[].phase === "upsert"`(飞书写入失败)或 `errors[].phase === "resolve-names"`(所有姓名都解析不上但也没归到 skipped——不应该发生,发生了要看 stdout)。

### 预期失败模式与处置

| 现象 | 根因 | 处置 |
|---|---|---|
| `unresolvedNames` 里有姓名 | 该员工不在同表已填充记录里,`contact +search-user` 也查不到 | 常见于外部面试官、离职人员、同名筛不出唯一结果。不阻塞流水线,把姓名列出交给 HR 决定是否人工在飞书 Base 上手动回填 |
| `existingSkipped` 有条目 | 同表某行「面试官」文本数量 ≠「面试官(人员)」人员数量 | 通常是有人手动改过一侧但没同步另一侧。脚本主动跳过这类行(不敢信任对齐),不影响本次 needing[] 处理;若长期无法收敛,回飞书 Base 手工把不对齐的行改一致 |
| 人员列显示名找不到唯一列 | Base 上有多列同时归一化到「面试官(人员)」 | 脚本直接报错。回飞书 Base 把重复列改掉,不改脚本 |
| `+record-upsert` 报"字段类型不匹配" | 有人把「面试官(人员)」列改成了 text 类型 | 回飞书 Base 把该列改回 user(人员)类型,不改脚本 |
| 大批量姓名走 `contact +search-user` 触发限流 | contact API 有 QPS 限制 | 脚本内部已经串行调用 contact,若仍限流,把 `--concurrency` 降到 1(只影响 upsert 阶段);实在解决不了拆分批次跑 |



- sync 脚本不查面试转写表是否已有记录（直接写入，去重交给 dedup 脚本）
- sync 脚本不删除任何 Base 记录
- sync 脚本不写「面试官(人员)」列(由 backfill 脚本 dedup 后回填)
- dedup 脚本不创建新记录
- dedup 脚本不使用 batch delete 接口（逐条删除更可靠）
- backfill 脚本不改写「面试官」text 列,也不动人员列已有值的记录
- backfill 脚本不新建 record;只对现有 record 做 `+record-upsert`
- 不写入或维护面试官信息表（已废弃）
- Agent 不手工重放脚本内部失败的写入操作；重新运行整个脚本即可
