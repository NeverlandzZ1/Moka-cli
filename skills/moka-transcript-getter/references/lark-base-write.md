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
| 姓名 | text | 面试官姓名（含英文名和中文名），如 "Interviewer A（示例面试官）" |
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
      "candidateName": "示例候选人",
      "jobTitle": "运营实习生（本地化方向）",
      "jobId": "e27c4530-518b-4a6e-a759-29b919a7ea1a",
      "interviewId": 48346354,
      "interviewerNames": ["Interviewer A（示例面试官）"],
      "round": 1,
      "roundName": "第一轮面试",
      "startTime": 1787711400000,
      "transcriptStatus": "available",
      "transcript": "<完整逐字稿示例省略>",
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

1. 先对输入 JSON 自身去重。将 `applicationId`、`interviewId` 都规范化为 JSON number，再以 `String(Number(applicationId)) + ":" + String(Number(interviewId))` 作为联合键构建 Map；同一输入中联合键重复时只保留最后一条。缺少 ID、不是有限数字或无法无损转成整数的记录停止写入并报错。

2. 对每条去重后的输入记录，在「面试转写」表（`tblUYL6KszcCEzuw`）用两个 number 字段同时精确查询。不要用关键词搜索，不要只查其中一个 ID：

```bash
lark-cli base +record-list \
  --base-token TeB3bU3ltak2MWsD8I0cdoxPnSf \
  --table-id tblUYL6KszcCEzuw \
  --filter-json '{"logic":"and","conditions":[["申请ID","==",832847768],["面试ID","==",48371949]]}' \
  --field-id 申请ID \
  --field-id 面试ID \
  --limit 20 \
  --as user --format json
```

将示例数字替换为当前记录的规范化 number。若 `has_more=true`，继续分页直到读完所有精确匹配。

3. 按精确查询结果分流：
   - **0 条**：暂列为 `toCreate`。
   - **1 条**：列为 `toUpdate`，保存真实 `record_id`。
   - **超过 1 条**：这是表内已有脏重复。禁止继续创建；选择最早返回的一条作为 canonical `toUpdate`，记录其余重复 `record_id` 到 `duplicateConflicts` 并明确报告。定时任务不得未经用户授权删除记录。

4. 真正执行 create 前，对每个 `toCreate` 联合键再执行一次相同的双字段精确查询：
   - 二次查询仍为 0 条才允许创建。
   - 已出现 1 条则改入 `toUpdate`。
   - 已出现多条则进入 `duplicateConflicts`，不再创建。

5. 最终得到三个列表：
   - `toUpdate`：需要更新的记录（含旧 record_id）
   - `toCreate`：经过二次查询仍不存在、需要新增的记录
   - `duplicateConflicts`：表内已经存在多个相同联合键的异常记录

6. 每成功创建一条，立即把联合键和新 `record_id` 加入本轮内存索引；后续不得再次创建该联合键。禁止并发执行同一 Base 的创建批次。

### 第2步：处理面试官（新增或匹配）

对每条面试记录中的 `interviewerNames` 数组的每个面试官名：

1. 在「面试官信息」表（`tblyYe2fDhI0Lluv`）中按 `姓名` text 字段精确筛选：

```bash
lark-cli base +record-list \
  --base-token TeB3bU3ltak2MWsD8I0cdoxPnSf \
  --table-id tblyYe2fDhI0Lluv \
  --filter-json '{"logic":"and","conditions":[["姓名","==","<面试官名>"]]}' \
  --field-id 姓名 \
  --limit 20 \
  --as user --format json
```

2. **如果精确命中 1 条**：记录该面试官的 `record_id`，后面用于关联。命中多条时不得再创建，使用 canonical 记录并报告已有重复。

3. **如果没搜到**：在「面试官信息」表中新增一条记录，`姓名` 字段填面试官全名：

```bash
lark-cli base +record-batch-create \
  --base-token TeB3bU3ltak2MWsD8I0cdoxPnSf \
  --table-id tblyYe2fDhI0Lluv \
  --json '{"create_records":[{"姓名":"<面试官名>"}]}' \
  --as user --format json
```

记录返回的新 `record_id`。

4. 最终构建一个 `面试官名 → record_id` 的映射表。

### 第3步：写入面试转写记录

#### 3a. 批量新增记录（toCreate）

1. 将 `toCreate` 列表转换为当前 `+record-batch-create` 所需的 `create_records` 格式：

```json
{
  "create_records": [
    {
      "候选人姓名": "示例候选人",
      "岗位名称": "运营实习生（本地化方向）",
      "面试官": "Interviewer A（示例面试官）",
      "面试轮次": "第一轮面试",
      "面试开始时间": "2026-08-26 02:30:00",
      "转写状态": "available",
      "逐字稿": "逐字稿全文...",
      "评估总结": "评估总结全文...",
      "问题分析": "{JSON字符串}",
      "Moka码": "",
      "Moka消息": "成功",
      "申请ID": 832453033,
      "岗位ID": "e27c4530-518b-4a6e-a759-29b919a7ea1a",
      "面试ID": 48346354,
      "轮次序号": 1,
      "转写类型": 1
    }
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
  "候选人姓名": "示例候选人",
  "岗位名称": "运营实习生（本地化方向）",
  "面试官": "Interviewer A（示例面试官）",
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
   - 表内已有重复冲突：X 组（逐组列出 `applicationId + interviewId` 以及全部重复 `record_id`）

2. 给用户 Base 的链接：https://trip.larkenterprise.com/base/TeB3bU3ltak2MWsD8I0cdoxPnSf

---

## 重要注意事项

1. **去重逻辑**：先把两个 ID 规范化为整数并对输入 JSON 自身去重；再用 `applicationId AND interviewId` 两个 number 字段对飞书执行精确查询。只有两个值同时相同才算同一面试，只要有一个不同就是新记录。真正创建前必须再次执行同样的云端精确查询，不能只依赖流程开始时读取的快照。

2. **覆盖逻辑**：重复记录不是跳过，而是用新数据覆盖旧数据（新覆盖旧）。

3. **面试官匹配**：按 `interviewerNames` 中的完整字符串匹配，包括英文名和中文名。如 "Interviewer A（示例面试官）" 是完整匹配，不做模糊搜索。

4. **关联字段**：`面试官（关联）` 是 link 类型，不能在 `+record-batch-create` 中写入，必须在创建记录后用 `+record-upsert` 单独更新。

5. **questionAnalysis**：是嵌套对象，必须用 `JSON.stringify()` 转为字符串后写入 text 字段。

6. **startTime**：是毫秒时间戳，需转为 `YYYY-MM-DD HH:mm:ss` 格式字符串写入 datetime 字段。

7. **interviewerNames**：是字符串数组，写入「面试官」文本字段时用 `", "` 拼接；但在关联时每个面试官单独匹配。

8. **大数据量**：`+record-batch-create` 单次最多 200 条，超过需分批；请求体使用 `{"create_records":[...]}`。`--json` 内容过大时用 `@文件名` 方式传入（文件需放在 CLI 的工作目录下）。同一个 Base 的创建批次不得并发执行。

9. **空值处理**：空单元格在 batch-create 的 `create_records` 字段对象中用 `null` 填充。

10. **已有脏重复**：精确查询返回多条时，禁止继续创建。选择一条 canonical 记录覆盖更新，并报告该联合键及所有重复 `record_id`；定时任务不得自行删除已有记录。

11. **授权**：所有 CLI 命令都要加 `--as user`，确保以用户身份操作。

---

## CellValue 格式速查

| 字段类型 | CellValue 格式 | 示例 |
|---|---|---|
| text | 字符串 | `"示例候选人"` |
| number | JSON number | `832453033` |
| datetime | "YYYY-MM-DD HH:mm:ss" | `"2026-08-26 02:30:00"` |
| link | 对象数组 | `[{"id":"recvttC25dY6DI"}]` |

---

## 完整示例（单条记录处理）

假设输入 JSON 中有一条记录：

```json
{
  "applicationId": 832453033,
  "candidateName": "示例候选人",
  "jobTitle": "运营实习生（本地化方向）",
  "jobId": "e27c4530-518b-4a6e-a759-29b919a7ea1a",
  "interviewId": 48346354,
  "interviewerNames": ["Interviewer A（示例面试官）"],
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

1. ✅ 将 ID 规范化为 number，并按 `(832453033, 48346354)` 对输入 JSON 自身去重
2. ✅ 用「申请ID = 832453033 AND 面试ID = 48346354」精确查询飞书 → 假设不存在
3. ✅ 搜索面试官 "Interviewer A（示例面试官）" → 假设已存在，record_id = `recvttC25dY6DI`
4. ✅ 创建前再次用两个 number 字段精确查询 → 仍不存在
5. ✅ 用 `create_records` 批量写入面试转写记录，返回新 record_id = `recvXXXXX`
6. ✅ upsert 关联：`{"面试官（关联）":[{"id":"recvttC25dY6DI"}]}`
7. ✅ 将联合键和 `recvXXXXX` 加入本轮内存索引，完成
