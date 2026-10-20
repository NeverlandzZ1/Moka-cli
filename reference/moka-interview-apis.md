# Moka 面试逐字稿接口说明

本文记录当前登录 HR 识别、面试逐字稿采集所需的四个读取接口、一个招聘模式切换接口，以及它们之间的调用关系。

## 共同前提

- 首次准备时，用户在专用 CDP Chrome 中登录 `https://app.mokahr.com`，再执行 `capture-payload`。
- 调用账号拥有相应候选人和面试数据的查看权限。
- 日常 `--offline` 导出使用 CLI 保存的 Cookie 和 `interviewList` 请求体模板发 HTTP 请求；采集阶段不依赖 Chrome 或 CDP。
- Cookie、JWT、`moka-token`、`csrfCk`、`connect.sid` 等会话凭据只允许由 CLI 内部维护，不写入导出 JSON，也不得在命令输出或日志中展示。
- 四个读取接口均为 `POST`；模式切换接口为 `PUT`。带 JSON 请求体的接口使用 `Content-Type: application/json`；`getCurrent` 发送空请求体。
- HTTP `200` 仅表示请求到达服务端，还要检查响应中的 `code`、`success` 和 `msg`。

---

## 0. 获取当前登录 HR：`getCurrent`

```http
POST https://app.mokahr.com/api/outer/ats-warden/businessUnit/users/getCurrent
```

该接口请求体为空。插件将 `data.users[]` 规范化为以下字段：

| 目标字段 | 响应路径 |
| --- | --- |
| `userId` | `data.users[].userId` |
| `name` | `data.users[].name` |
| `email` | `data.users[].email` |

`name` 是当前 Moka 登录账号的 HR 展示姓名。`export-transcripts` 在正式采集前调用该接口，并把 `name` 写入导出 JSON 顶层的 `面试安排HR` 字段。在线模式和 `--offline` 模式调用同一个接口，不从页面文字、面试官列表或逐字稿推断 HR 身份。

---

## 1. 切换招聘模式：`update_currenthiremode_fields`

```http
PUT https://app.mokahr.com/api/users/update_currenthiremode_fields
Content-Type: application/json
```

请求体：

```json
{ "currentHireMode": 2 }
```

- `1`：社招（`social`）
- `2`：校招（`campus`）

该接口切换当前账号的招聘模式。切换后，后续三个读取接口的路径不变，但返回数据立即跟随当前模式。`export-transcripts` 使用同一个 HTTP client 依次切到校招、抓取数据，再切到社招、抓取数据，不需要刷新页面或连接 CDP。手动 `mode` 命令仍会刷新 Moka 单页应用，使当前页面的菜单和内存状态同步；页面刷新只服务于 UI，不是纯 HTTP 导出的前提。不得在命令或文档中硬编码 Cookie/Token。

---

## 2. 获取候选人及应聘岗位：`interviewList`

### 请求

```http
POST https://app.mokahr.com/api/outer/ats-interview/interview/hr/interviewList
Content-Type: application/json
```

对应页面：

```text
https://app.mokahr.com/interviews/overview
```

请求体包含分页和筛选条件。当前已确认响应中的 `currentPage`、`pageSize` 和 `totalPage`，但请求 Payload 的完整字段仍应以浏览器 Network 中的实际请求为准。

当前插件不会猜测完整 Payload。首次登录后运行 `opencli moka capture-payload -f json`：命令在需要时以 CDP 鼠标点击侧栏“面试安排”进入总览，监听 `Network.requestWillBeSent`，点击“加载更多”，捕获前端发出的 `interviewList` POST 请求体。模板保存到 `~/.opencli/mokaData/moka-interview-list-payload.json`；当前标签页的 `sessionStorage` 仅供在线捕获辅助复用。`applications` 或 `export-transcripts` 会优先读取磁盘模板；在线模式缺失时可尝试 CDP 捕获，离线模式缺失时应重新登录并运行 `capture-payload`。实际采集会覆盖模板里的时间范围、排序和页码，固定查询北京时间今天；其他可复用字段沿用模板。

默认调用时，插件以捕获的请求体作为字段模板，动态按北京时间生成今天的完整查询范围：

- `today`：`order=asc`，包含当天 00:00:00 至 23:59:59.000。
- 不请求 `beforeToday` 或 `afterToday`。

以北京时间 2026-08-25 为例，第一页请求体为：

```json
{
  "jobPreference": "all",
  "countType": "today",
  "order": "asc",
  "minStartDate": 1787587200000,
  "maxStartDate": 1787673599000,
  "currentPage": 1,
  "pageSize": 10
}
```

`minStartDate` 和 `maxStartDate` 每天动态计算，后续页只修改 `currentPage`。

插件根据响应中的分页信息拉完今天的全部页，再按 `applicationId` 去重，随后对每个唯一应聘记录请求 `interviewCard`。`export-transcripts` 在两个内部采集阶段分别执行上述过程，最终按 `applicationId + interviewId` 合并记录。显式传入 `--request-json` 时，每个采集阶段都使用用户提供的查询模板，不生成默认的今天范围。

### 主要响应结构

```text
data
├─ currentPage
├─ pageSize
├─ totalPage
└─ rows[]
   └─ applicationEntities[]
      ├─ id                  应聘记录 ID，即 applicationId
      ├─ name                候选人姓名
      └─ job
         ├─ id               岗位 ID
         └─ title            岗位名称
```

### 需要提取的字段

| 目标字段 | 响应路径 |
| --- | --- |
| `applicationId` | `data.rows[].applicationEntities[].id` |
| 候选人姓名 | `data.rows[].applicationEntities[].name` |
| 岗位名称 | `data.rows[].applicationEntities[].job.title` |

`applicationEntities[]` 是候选人资料字典，不保证与页面的面试时间顺序一致。真正的列表顺序来自同一行的 `restinterviews[]`；每个面试通过 `applicationIds[]` 或 `validApplicationIds[]` 关联候选人，并携带 `id`、`startTime` 等字段。解析时应先按 `restinterviews[]` 顺序遍历，再查找对应的 `applicationEntities[]`，不能直接把资料字典顺序当作列表顺序。

`applicationId` 表示一次应聘记录，不等同于候选人的永久人员 ID。同一个人投递多个岗位时，可能有多个不同的 `applicationId`，因此后续关联必须使用 `applicationId`，不能只依赖姓名。

发现今天的全部候选人时，需要按照 `totalPage` 遍历今天范围内的所有分页。

---

## 3. 获取候选人的全部面试：`interviewCard`

### 请求

```http
POST https://app.mokahr.com/api/outer/ats-interview/interview/interviewCard
Content-Type: application/json
```

对应候选人面试详情页面：

```text
https://app.mokahr.com/interviews/overview/application/{applicationId}/interviews
```

打开该页面后，前端会调用 `interviewCard`。已捕获请求的 `Content-Length` 为 32，对应的请求体样例为：

```json
{
  "applicationIds": ["123456789"]
}
```

实现时仍应以浏览器 Network 中实际看到的 Payload 为准，并保留 `applicationId` 的原始类型。

### 主要响应结构

```text
data[]
├─ application
│  ├─ id                         applicationId
│  ├─ name                       候选人姓名
│  └─ job.title                  岗位名称
└─ entities[]                    面试列表；有几场面试通常就有几个 entity
   ├─ id                         面试 ID，即后续使用的 interviewId
   ├─ groupInterviewId           面试分组 ID，不作为本链路的 interviewId
   ├─ round                      面试轮次序号
   ├─ roundName                  面试轮次名称
   ├─ startTime                  面试开始时间，毫秒时间戳
   ├─ showSummary                页面是否显示面试总结
   ├─ summaryEnable              是否启用总结能力
   └─ interviewerFeedbacks[]
      └─ interviewer
         ├─ id                   面试官 ID
         └─ name                 面试官姓名
```

### 需要提取的字段

| 目标字段 | 响应路径 |
| --- | --- |
| `applicationId` | `data[].application.id` |
| `interviewId` | `data[].entities[].id` |
| 面试官姓名 | `data[].entities[].interviewerFeedbacks[].interviewer.name` |
| 面试轮次 | `data[].entities[].roundName`，或 `round` |
| 面试时间 | `data[].entities[].startTime` |
| 是否展示总结 | `data[].entities[].showSummary` |

按照最新实测结果，`getMeetingSummary` 的 `interviewId` 使用 `entities[].id`。不要使用 `groupInterviewId`，也不要从邮件正文、页面 URL 或姓名推断 ID。

一场面试可能有多位面试官，因此面试官姓名应保存为数组并去重。同一候选人可能有多轮面试，因此必须遍历全部 `data[].entities[]`，不能只取第一项。

建议按 `(applicationId, interviewId)` 二元组去重。

---

## 4. 获取会议逐字稿：`getMeetingSummary`

### 请求

```http
POST https://app.mokahr.com/api/outer/ats-interview/interview/meeting/getMeetingSummary
Content-Type: application/json
```

请求体：

```json
{
  "applicationId": 123456789,
  "interviewId": 98765432
}
```

参数来源：

| 请求参数 | 来源 |
| --- | --- |
| `applicationId` | `interviewCard.data[].application.id` |
| `interviewId` | `interviewCard.data[].entities[].id` |

### 主要响应结构

```json
{
  "code": 0,
  "success": true,
  "msg": "成功",
  "data": {
    "transcript": "...",
    "transcriptType": 1,
    "evaSummary": "...",
    "evaQuestionAnalysis": "{...}"
  }
}
```

### 需要提取的字段

| 字段 | 含义 |
| --- | --- |
| `data.transcript` | 完整会议逐字稿，通常包含说话人及时间戳 |
| `data.transcriptType` | 逐字稿类型 |
| `data.evaSummary` | AI 生成的面试总结和评价 |
| `data.evaQuestionAnalysis` | JSON 字符串形式的逐题分析；使用时需要再次 `JSON.parse` |

已观察到的无数据响应：

```json
{
  "code": 103,
  "msg": "数据不存在"
}
```

这表示 HTTP 请求成功，但当前 `(applicationId, interviewId)` 没有可用会议数据、尚未生成总结，或当前账号无权访问。批量采集时应记录该状态并继续处理其他面试，不应终止整个任务。

---

## 完整调用链路（今日全部面试）

```text
1. 用户通过 CDP Chrome 登录 Moka，运行 capture-payload 保存 Cookie 与 interviewList 模板
   ↓
2. export-transcripts --offline 调用 getCurrent 一次，得到顶层「面试安排HR」
   ↓
3. CLI 依次切换招聘模式；每个模式按北京时间查询今天，并分页调用 interviewList 直至最后一页
   ↓
   获得：applicationId + 候选人姓名 + 岗位名称
   ↓
4. 对每个 applicationId 调用 interviewCard
   ↓
   遍历所有 entities[]
   获得：interviewId + 面试官姓名数组 + 面试轮次 + 面试时间
   ↓
5. 对每个 (applicationId, interviewId) 调用 getMeetingSummary
   ↓
   获得：transcript + AI 总结 + 逐题分析
   ↓
6. 按 (applicationId, interviewId) 合并两个采集阶段并输出
```

建议每场面试输出一条标准记录：

```json
{
  "applicationId": 123456789,
  "interviewId": 98765432,
  "candidateName": "候选人姓名",
  "jobTitle": "岗位名称",
  "interviewerNames": ["面试官 A", "面试官 B"],
  "round": 1,
  "roundName": "第一轮面试",
  "startTime": 1787223600000,
  "transcript": "...",
  "transcriptType": 1,
  "evaluationSummary": "...",
  "questionAnalysis": {}
}
```

## 实现注意事项

- 首次登录由浏览器完成；CLI 内部保存 Cookie 和请求体模板以支持离线采集，不保存密码或验证码，也不在导出 JSON 中写入 Cookie 或 Token。
- `interviewList` 只查询今天，并且必须遍历今天范围内的全部分页。
- `interviewCard` 必须遍历全部 `data[]` 和 `entities[]`。
- 多位面试官保存为数组并去重。
- 同名候选人的数据使用 `applicationId` 区分。
- 同一面试使用 `(applicationId, interviewId)` 去重。
- 响应文本按 UTF-8 解析，避免中文乱码。
- 仅采集当前账号有权访问的数据，并遵守组织对候选人个人信息的存储和使用要求。
