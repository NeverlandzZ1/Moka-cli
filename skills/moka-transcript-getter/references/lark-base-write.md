将 Moka 转写 JSON 写入飞书多维表格

## 目标表格

| 项目 | 值 |
|---|---|
| **Base Token** | `TeB3bU3ltak2MWsD8I0cdoxPnSf` |
| **Base URL** | https://trip.larkenterprise.com/base/TeB3bU3ltak2MWsD8I0cdoxPnSf |
| **表1 - 面试官信息** | Table ID = `tblyYe2fDhI0Lluv` |
| **表2 - 面试转写** | Table ID = `tblUYL6KszcCEzuw` |
| **关联字段** | 「面试转写」表中的 `面试官（关联）` 字段（双向关联到「面试官信息」表） |

---

## 表结构

### 表1：面试官信息（字段列表）

| 字段名 | 类型 | 说明 |
|---|---|---|
| 姓名 | text | 面试官姓名（含英文名和中文名），如 "Olivia Chen （陈惠馨）" |
| 工号 | text | 工号（如有） |
| 部门 | text | 部门（如有） |
| 岗位 | text | 岗位（如有） |
| 邮箱 | text(email) | 邮箱（如有） |
| 电话 | text(phone) | 电话（如有） |
| 面试记录 | link（反向关联） | 系统自动创建的双向关联字段，不需手动写入 |

### 表2：面试转写（字段列表，按列顺序）

| 列序 | 字段名 | 类型 | CellValue 格式 | 来源字段 |
|---|---|---|---|---|
| 1 | 候选人姓名 | text | 字符串 | `records[].candidateName` |
| 2 | 岗位名称 | text | 字符串 | `records[].jobTitle` |
| 3 | 面试官 | text | 字符串，多人用逗号拼接 | `records[].interviewerNames`（数组 join ", "） |
| 4 | 面试轮次 | text | 字符串 | `records[].roundName` |
| 5 | 面试开始时间 | datetime | "YYYY-MM-DD HH:mm:ss" | `records[].startTime`（毫秒时间戳转 ISO 字符串） |
| 6 | 转写状态 | text | 字符串 | `records[].transcriptStatus` |
| 7 | 逐字稿 | text | 字符串 | `records[].transcript` |
| 8 | 评估总结 | text | 字符串 | `records[].evaluationSummary` |
| 9 | 问题分析 | text | JSON 字符串 | `records[].questionAnalysis`（用 `JSON.stringify()` 转为字符串） |
| 10 | Moka码 | text | 字符串 | `records[].mokaCode` |
| 11 | Moka消息 | text | 字符串 | `records[].mokaMessage` |
| 12 | 申请ID | number | 数字 | `records[].applicationId` |
| 13 | 岗位ID | text | 字符串 | `records[].jobId` |
| 14 | 面试ID | number | 数字 | `records[].interviewId` |
| 15 | 轮次序号 | number | 数字 | `records[].round` |
| 16 | 转写类型 | number | 数字 | `records[].transcriptType` |

> **注意**：`面试官（关联）` 是第 17 个字段（link 类型），不在批量创建时写入，需后续单独 upsert 关联。

---

## JSON 数据格式

输入 JSON 结构如下：

```json
{
  "generatedAt": "2026-08-26T06:00:56.491Z",
  "source": "https://app.mokahr.com/interviews/overview",
  "records": [
    {
      "applicationId": 832453033,
      "candidateName": "郭雨萱",
      "jobTitle": "运营实习生（本地化方向）",
      "jobId": "e27c4530-518b-4a6e-a759-29b919a7ea1a",
      "interviewId": 48346354,
      "interviewerNames": ["Olivia Chen （陈惠馨）"],
      "round": 1,
      "roundName": "第一轮面试",
      "startTime": 1787711400000,
      "transcriptStatus": "available",
      "transcript": "郭雨萱(00:01:14): 你好。\n\nOlivia Chen...(完整逐字稿)",
      "transcriptType": 1,
      "evaluationSummary": "### 综合评价\n...(完整评估)",
      "questionAnalysis": {
        "result": [
          {
            "duration": 226,
            "question": "请你打开携程小程序...",
            "topic": "翻译质量治理",
            "analysis": {
              "difficulty": "ENTRY",
              "basic_info": { "keywords": ["携程小程序"], "..." : "..." },
              "generality": "UNIVERSAL",
              "quality": { "effectiveness": 8, "clarity": 9, "..." : "..." }
            },
            "group": "实操评估"
          }
        ],
        "message": "",
        "status": "success"
      },
      "mokaCode": "",
      "mokaMessage": "成功"
    }
  ]
}
```

---

## 处理流程（严格按以下步骤执行）

### 第0步：前置检查

1. 调用 `status` 确认飞书已授权。如未授权，把授权链接发给用户，等待用户完成授权后再继续。
2. 确认 Base Token `TeB3bU3ltak2MWsD8I0cdoxPnSf` 可访问。
3. 如果用户提供了本地 JSON 文件路径（如 `D:\...\transcript.json`），读取该文件。如果是 JSON 文本，直接解析。

### 第1步：去重检查

**去重规则：`interviewId` 和 `applicationId` 同时完全相同才算重复。**

1. 从「面试转写」表（`tblUYL6KszcCEzuw`）读取现有所有记录：

```bash
lark-cli base +record-list \
  --base-token TeB3bU3ltak2MWsD8I0cdoxPnSf \
  --table-id tblUYL6KszcCEzuw \
  --as user --format json
```

如果记录较多（超过 500 条），分页读取直到 `has_more=false`。

2. 从返回结果中提取每条记录的 `面试ID` 和 `申请ID` 字段值，构建已有记录的 `(interviewId, applicationId)` 去重集合。

3. 遍历输入 JSON 的 `records` 数组，对每条记录检查其 `(interviewId, applicationId)` 是否已存在于去重集合中：
   - **如果已存在（两个值都相同）**：该条记录为重复，用新数据**覆盖**旧记录（先删旧记录或 upsert 更新）。
   - **如果不存在**：该条记录为新增，直接写入。

4. 最终得到两个列表：
   - `toUpdate`：需要更新的记录（含旧 record_id）
   - `toCreate`：需要新增的记录

### 第2步：处理面试官（新增或匹配）

对每条面试记录中的 `interviewerNames` 数组的每个面试官名：

1. 在「面试官信息」表（`tblyYe2fDhI0Lluv`）中按 `姓名` 字段搜索：

```bash
lark-cli base +record-search \
  --base-token TeB3bU3ltak2MWsD8I0cdoxPnSf \
  --table-id tblyYe2fDhI0Lluv \
  --filter '{"conjunction":"and","conditions":[{"field_name":"姓名","operator":"is","value":["<面试官名>"]}]}' \
  --as user --format json
```

2. **如果搜到**：记录该面试官的 `record_id`，后面用于关联。

3. **如果没搜到**：在「面试官信息」表中新增一条记录，`姓名` 字段填面试官全名：

```bash
lark-cli base +record-batch-create \
  --base-token TeB3bU3ltak2MWsD8I0cdoxPnSf \
  --table-id tblyYe2fDhI0Lluv \
  --json '{"fields":["姓名"],"rows":[["<面试官名>"]]}' \
  --as user --format json
```

记录返回的新 `record_id`。

4. 最终构建一个 `面试官名 → record_id` 的映射表。

### 第3步：写入面试转写记录

#### 3a. 批量新增记录（toCreate）

1. 将 `toCreate` 列表转换为 `+record-batch-create` 所需格式：

```json
{
  "fields": [
    "候选人姓名", "岗位名称", "面试官", "面试轮次",
    "面试开始时间", "转写状态", "逐字稿", "评估总结",
    "问题分析", "Moka码", "Moka消息", "申请ID",
    "岗位ID", "面试ID", "轮次序号", "转写类型"
  ],
  "rows": [
    [
      "郭雨萱",
      "运营实习生（本地化方向）",
      "Olivia Chen （陈惠馨）",
      "第一轮面试",
      "2026-08-26 02:30:00",
      "available",
      "逐字稿全文...",
      "评估总结全文...",
      "{JSON字符串}",
      "",
      "成功",
      832453033,
      "e27c4530-518b-4a6e-a759-29b919a7ea1a",
      48346354,
      1,
      1
    ]
  ]
}
```

2. 如果 JSON 内容很大（逐字稿可能很长），建议写入临时文件再通过 `@文件名` 方式传给 CLI。

3. 执行批量创建：

```bash
lark-cli base +record-batch-create \
  --base-token TeB3bU3ltak2MWsD8I0cdoxPnSf \
  --table-id tblUYL6KszcCEzuw \
  --json @batch-create.json \
  --as user --format json
```

4. 记录返回的 `record_id_list`，与 `toCreate` 按顺序对应。

#### 3b. 更新已有记录（toUpdate）

对每条需要更新的记录，用 `+record-upsert` 覆盖写入：

```bash
lark-cli base +record-upsert \
  --base-token TeB3bU3ltak2MWsD8I0cdoxPnSf \
  --table-id tblUYL6KszcCEzuw \
  --record-id <旧record_id> \
  --json '<字段映射JSON>' \
  --as user --format json
```

字段映射格式：

```json
{
  "候选人姓名": "郭雨萱",
  "岗位名称": "运营实习生（本地化方向）",
  "面试官": "Olivia Chen （陈惠馨）",
  "面试轮次": "第一轮面试",
  "面试开始时间": "2026-08-26 02:30:00",
  "转写状态": "available",
  "逐字稿": "逐字稿全文...",
  "评估总结": "评估总结全文...",
  "问题分析": "{JSON字符串}",
  "Moka码": "",
  "Moka消息": "成功",
  "申请ID": 832453033,
  "岗位ID": "e27c4530-...",
  "面试ID": 48346354,
  "轮次序号": 1,
  "转写类型": 1
}
```

### 第4步：建立面试官关联

对每条面试转写记录（新增的和更新的），用 `+record-upsert` 更新 `面试官（关联）` 字段：

```bash
lark-cli base +record-upsert \
  --base-token TeB3bU3ltak2MWsD8I0cdoxPnSf \
  --table-id tblUYL6KszcCEzuw \
  --record-id <面试转写record_id> \
  --json '{"面试官（关联）":[{"id":"<面试官record_id>"}]}' \
  --as user --format json
```

> 如果一条面试记录有多个面试官，关联字段写多个对象：
> `"面试官（关联）":[{"id":"<面试官1_record_id>"},{"id":"<面试官2_record_id>"}]`

### 第5步：确认结果

1. 汇总执行结果：
   - 新增面试官：X 人
   - 新增面试记录：X 条
   - 更新面试记录（覆盖）：X 条
   - 跳过（无变化）：X 条

2. 给用户 Base 的链接：https://trip.larkenterprise.com/base/TeB3bU3ltak2MWsD8I0cdoxPnSf

---

## 重要注意事项

1. **去重逻辑**：只有 `interviewId` AND `applicationId` 两个值同时完全相同才算重复。只要有一个不同，就视为新记录。

2. **覆盖逻辑**：重复记录不是跳过，而是用新数据覆盖旧数据（新覆盖旧）。

3. **面试官匹配**：按 `interviewerNames` 中的完整字符串匹配，包括英文名和中文名。如 "Olivia Chen （陈惠馨）" 是完整匹配，不做模糊搜索。

4. **关联字段**：`面试官（关联）` 是 link 类型，不能在 `+record-batch-create` 中写入，必须在创建记录后用 `+record-upsert` 单独更新。

5. **questionAnalysis**：是嵌套对象，必须用 `JSON.stringify()` 转为字符串后写入 text 字段。

6. **startTime**：是毫秒时间戳，需转为 `YYYY-MM-DD HH:mm:ss` 格式字符串写入 datetime 字段。

7. **interviewerNames**：是字符串数组，写入「面试官」文本字段时用 `", "` 拼接；但在关联时每个面试官单独匹配。

8. **大数据量**：`+record-batch-create` 单次最多 200 行，超过需分批。`--json` 内容过大时用 `@文件名` 方式传入（文件需放在 CLI 的工作目录下）。

9. **空值处理**：空单元格在 batch-create 的 rows 中用 `null` 填充。

10. **授权**：所有 CLI 命令都要加 `--as user`，确保以用户身份操作。

---

## CellValue 格式速查

| 字段类型 | CellValue 格式 | 示例 |
|---|---|---|
| text | 字符串 | `"郭雨萱"` |
| number | JSON number | `832453033` |
| datetime | "YYYY-MM-DD HH:mm:ss" | `"2026-08-26 02:30:00"` |
| link | 对象数组 | `[{"id":"recvttC25dY6DI"}]` |

---

## 完整示例（单条记录处理）

假设输入 JSON 中有一条记录：

```json
{
  "applicationId": 832453033,
  "candidateName": "郭雨萱",
  "jobTitle": "运营实习生（本地化方向）",
  "jobId": "e27c4530-518b-4a6e-a759-29b919a7ea1a",
  "interviewId": 48346354,
  "interviewerNames": ["Olivia Chen （陈惠馨）"],
  "round": 1,
  "roundName": "第一轮面试",
  "startTime": 1787711400000,
  "transcriptStatus": "available",
  "transcript": "...",
  "transcriptType": 1,
  "evaluationSummary": "...",
  "questionAnalysis": { "result": [], "status": "success" },
  "mokaCode": "",
  "mokaMessage": "成功"
}
```

处理步骤：

1. ✅ 检查 `(48346354, 832453033)` 是否已存在 → 假设不存在
2. ✅ 搜索面试官 "Olivia Chen （陈惠馨）" → 假设已存在，record_id = `recvttC25dY6DI`
3. ✅ 批量写入面试转写记录，返回新 record_id = `recvXXXXX`
4. ✅ upsert 关联：`{"面试官（关联）":[{"id":"recvttC25dY6DI"}]}`
5. ✅ 完成

