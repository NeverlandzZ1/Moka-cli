# Moka 面试逐字稿接口说明

本文只记录完成面试逐字稿采集所需的三个接口，以及它们之间的调用关系。

## 共同前提

- 用户已经在浏览器中登录 `https://app.mokahr.com`。
- 调用账号拥有相应候选人和面试数据的查看权限。
- 建议通过 Chrome CDP 在已登录的 Moka 页面上下文中发起同源请求，让浏览器自动携带登录态。
- 不读取、导出或持久化 Cookie、JWT、`moka-token`、`csrfCk`、`connect.sid` 等会话凭据。
- 三个接口均为 `POST`，请求头至少使用 `Content-Type: application/json`。
- HTTP `200` 仅表示请求到达服务端，还要检查响应中的 `code`、`success` 和 `msg`。

---

## 1. 获取候选人及应聘岗位：`interviewList`

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

当前插件不会猜测完整 Payload。执行 `applications` 或 `export-transcripts` 时，先检查当前 Moka 标签页里是否已有插件自己缓存的请求体模板；没有缓存时，会监听 CDP 的 `Network.requestWillBeSent`，只读点击一次总览列表底部的“加载更多”，捕获 Moka 前端自己发出的 `interviewList` POST 请求体。捕获结果只缓存在当前标签页的专用 `sessionStorage` 键中。实际采集会覆盖模板里的时间范围、排序和页码，固定查询北京时间今天；岗位等其他可复用字段继续沿用模板。这个过程不会刷新 HR 当前页面。

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

插件根据响应中的分页信息自动拉完今天的全部页，再按 `applicationId` 去重，并且后续对每个唯一应聘记录只请求一次 `interviewCard`。显式传入 `--request-json` 时不生成默认的今天范围，而是只执行用户提供的单一查询。

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

## 2. 获取候选人的全部面试：`interviewCard`

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

## 3. 获取会议逐字稿：`getMeetingSummary`

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

## 完整调用链路（今天候选人）

```text
1. 用户登录 Moka
   ↓
2. 按北京时间查询今天，并分页调用 interviewList 直至最后一页
   ↓
   获得：applicationId + 候选人姓名 + 岗位名称
   ↓
3. 对每个 applicationId 调用 interviewCard
   或打开 /interviews/overview/application/{applicationId}/interviews 触发接口
   ↓
   遍历所有 entities[]
   获得：interviewId + 面试官姓名数组 + 面试轮次 + 面试时间
   ↓
4. 对每个 (applicationId, interviewId) 调用 getMeetingSummary
   ↓
   获得：transcript + AI 总结 + 逐题分析
   ↓
5. 按 (applicationId, interviewId) 合并并输出
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

- 全程复用浏览器现有登录态，不保存密码、Cookie 或 Token。
- `interviewList` 只查询今天，并且必须遍历今天范围内的全部分页。
- `interviewCard` 必须遍历全部 `data[]` 和 `entities[]`。
- 多位面试官保存为数组并去重。
- 同名候选人的数据使用 `applicationId` 区分。
- 同一面试使用 `(applicationId, interviewId)` 去重。
- 响应文本按 UTF-8 解析，避免中文乱码。
- 仅采集当前账号有权访问的数据，并遵守组织对候选人个人信息的存储和使用要求。
