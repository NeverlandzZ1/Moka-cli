# Moka Transcript Getter 本地测试流程

本文用于开发和联调 `Moka-transcript-getter`。建议严格按顺序执行，不要在基础步骤失败时直接进行全量导出。

## 1. 进入项目

```powershell
cd D:\Users\jingboma\proj\bossHr\Moka-transcript-getter
```

检查运行环境：

```powershell
node --version
opencli --version
```

要求：

- Node.js 20 或更高版本。
- OpenCLI 1.8.6 或更高版本。
- 已安装 Google Chrome。

## 2. 首次安装

安装 OpenCLI：

```powershell
npm install -g @jackwener/opencli@1.8.6
```

安装项目开发依赖并构建：

```powershell
npm install
npm run check
```

安装本地 OpenCLI 插件：

```powershell
opencli plugin install "D:\Users\jingboma\proj\bossHr\Moka-transcript-getter"
```

确认插件存在：

```powershell
opencli plugin list -f json
```

结果中应该包含：

```json
{
  "name": "moka-transcripts",
  "source": "local:D:\\Users\\jingboma\\proj\\bossHr\\Moka-transcript-getter"
}
```

> 注意：`opencli plugin install` 可能执行生产依赖安装并清理开发依赖。首次安装插件后，如果 `npm run check` 提示找不到 `tsc`、`vitest` 或 `esbuild`，重新执行一次 `npm install`。

## 3. 日常修改代码后的检查

每次修改 `src/*.ts` 后执行：

```powershell
npm run check
```

它会依次完成：

1. TypeScript 类型检查。
2. Vitest 单元测试。
3. esbuild 插件打包。
4. 更新根目录 `moka.js`。

通过标准：

```text
Test Files  3 passed
Tests       6 passed
moka.js 构建成功
```

OpenCLI 实际加载的是根目录的 `moka.js`，不是直接加载 `src/*.ts`。修改源码后必须重新执行：

```powershell
npm run build
```

一般不需要重复执行 `opencli plugin install`。

## 4. 检查命令注册

```powershell
opencli moka login --help
opencli moka status --help
opencli moka applications --help
opencli moka interviews --help
opencli moka transcript --help
opencli moka export-transcripts --help
```

如果提示找不到 `moka` 命令：

```powershell
npm run build
opencli plugin list -f json
```

插件确实不存在时，再重新安装：

```powershell
opencli plugin install "D:\Users\jingboma\proj\bossHr\Moka-transcript-getter"
npm install
```

## 5. 启动 Moka 登录窗口

```powershell
opencli moka login -f json
```

期望行为：

1. 启动或复用 CDP 端口为 `9222` 的 Chrome。
2. 已有 Moka 总览页或登录页时，直接复用并聚焦，不重复打开标签页。
3. 没有 Moka 页面时才打开 `https://app.mokahr.com/interviews/overview`。
4. 未登录时进入 Moka 登录页。

未登录时的期望结果：

```json
[
  {
    "browser": "connected",
    "mokaLogin": "waiting_for_user",
    "message": "请在打开的 Chrome 窗口中完成 Moka 登录"
  }
]
```

在打开的 Chrome 中自行完成账号、密码和验证码登录。不要关闭这个 Chrome。

## 6. 检查登录状态

```powershell
opencli moka status -f json
```

通过标准：

```json
[
  {
    "browser": "connected",
    "mokaLogin": "authenticated",
    "message": "Moka 登录成功，可以开始获取面试记录"
  }
]
```

如果仍然是 `waiting_for_user`：

1. 确认登录发生在 CDP Chrome，而不是普通 Chrome 或其他浏览器。
2. 确认浏览器能够正常打开 Moka 面试总览。
3. 不要复制 Cookie、JWT、Token 或 CSRF。

## 7. 检查 CDP 端口

当命令提示无法连接 Chrome 时执行：

```powershell
Invoke-RestMethod `
  -Uri "http://127.0.0.1:9222/json" `
  -TimeoutSec 3 |
  Select-Object title, url
```

结果中应该存在 `app.mokahr.com` 页面。

如果使用其他端口，例如 `9223`，所有命令都必须显式传递同一个端口：

```powershell
opencli moka login --port 9223 -f json
opencli moka status --port 9223 -f json
opencli moka applications --port 9223 --max-pages 1 -f json
```

## 8. 测试候选人列表

第一次只读取一页：

```powershell
opencli moka applications `
  --max-pages 1 `
  -f json `
  -v
```

第一次执行时，插件会：

1. 在当前正常的 Moka 总览页开启 CDP Network 监听。
2. 只读点击一次列表底部的“加载更多”。
3. 捕获 Moka 自己发出的 `interviewList` POST 请求体。
4. 将请求体缓存在当前标签页的专用 `sessionStorage` 键中。
5. 使用捕获的请求体读取第一页。

这个动作只会让页面多显示一批候选人，不会修改 Moka 数据，也不会刷新当前页面。

通过标准：

```json
[
  {
    "applicationId": 813749158,
    "candidateName": "李龙一",
    "jobTitle": "增长产品经理Growth Product Manager",
    "jobId": "aecae375-ee47-4af1-87fe-bc1b73b755c0"
  }
]
```

实际结果通常不止一条。重点检查：

- `applicationId` 存在。
- 候选人姓名正确。
- 岗位名称正确。
- 命令没有刷新或破坏 Moka 页面。

## 9. 测试请求体缓存

第一次候选人列表成功后，立即再次执行：

```powershell
opencli moka applications `
  --candidate "李龙一" `
  --max-pages 1 `
  -f json
```

第二次会直接复用标签页中的请求体缓存，不再点击“加载更多”。

通过标准：

```json
[
  {
    "applicationId": 813749158,
    "candidateName": "李龙一",
    "jobTitle": "增长产品经理Growth Product Manager"
  }
]
```

关闭 Moka 标签页或 Chrome 后，`sessionStorage` 缓存可能消失。下次首次调用会重新执行一次安全捕获。

## 10. 测试一个候选人的全部面试

从 `applications` 结果中复制真实的 `applicationId`：

```powershell
opencli moka interviews 813749158 -f json -v
```

通过标准：

```json
[
  {
    "applicationId": 813749158,
    "interviewId": 真实面试ID,
    "candidateName": "李龙一",
    "jobTitle": "增长产品经理Growth Product Manager",
    "interviewerNames": [
      "面试官姓名"
    ],
    "roundName": "面试轮次"
  }
]
```

重点检查：

- 一个人有多场面试时，结果包含多个对象。
- `interviewId` 来自 `interviewCard.data[].entities[].id`。
- 不要使用 `groupInterviewId`。
- 多位面试官保存在数组中并去重。
- 候选人和岗位与 `applicationId` 对应。

## 11. 测试单场逐字稿

从 `interviews` 结果复制真实的 `interviewId`：

```powershell
opencli moka transcript `
  813749158 `
  <真实interviewId> `
  -f json `
  -v
```

有逐字稿时的通过标准：

```json
[
  {
    "applicationId": 813749158,
    "interviewId": 真实面试ID,
    "transcriptStatus": "available",
    "transcript": "...",
    "transcriptType": 1,
    "evaluationSummary": "...",
    "questionAnalysis": {}
  }
]
```

没有逐字稿时可能返回：

```json
[
  {
    "applicationId": 813749158,
    "interviewId": 真实面试ID,
    "transcriptStatus": "not_available",
    "mokaCode": 103,
    "mokaMessage": "数据不存在"
  }
]
```

`code: 103` 表示当前面试没有可用逐字稿，不代表插件整体失败。应继续测试同一候选人的其他面试。

## 12. 小范围完整导出

不要直接从全量导出开始。先测试一个候选人：

```powershell
opencli moka export-transcripts `
  --candidate "李龙一" `
  --max-pages 1 `
  --output "D:\tmp\moka-debug-李龙一.json" `
  -f json `
  -v
```

查看文件：

```powershell
Get-Content -Raw -Encoding utf8 "D:\tmp\moka-debug-李龙一.json"
```

重点检查输出结构：

```json
{
  "generatedAt": "...",
  "source": "https://app.mokahr.com/interviews/overview",
  "records": [],
  "errors": [],
  "stats": {
    "applications": 1,
    "interviews": 0,
    "transcriptsAvailable": 0,
    "transcriptsUnavailable": 0,
    "errors": 0
  }
}
```

数字以实际数据为准。确认：

- `records` 中候选人、岗位、面试官和逐字稿关联正确。
- `applications` 与筛选到的应聘记录数量一致。
- `interviews` 是面试总数。
- 暂无逐字稿计入 `transcriptsUnavailable`。
- 单项错误记录在 `errors`，不会丢失已经成功的记录。

## 13. 全量导出

小范围导出确认无误后，再执行：

```powershell
opencli moka export-transcripts `
  --output "D:\tmp\moka-transcripts.json" `
  -f json
```

全量任务当前按顺序调用接口，候选人和面试较多时可能需要较长时间。执行期间：

- 不要关闭 CDP Chrome。
- 不要退出 Moka。
- 不要切换到另一个 Moka 账号。
- 可以正常查看其他标签页。

完成后检查：

```powershell
$result = Get-Content -Raw -Encoding utf8 "D:\tmp\moka-transcripts.json" | ConvertFrom-Json
$result.stats | Format-List
$result.errors | Format-List
```

## 14. 调试时使用真实 Request Payload

只有自动捕获失效时才使用本节。

在 Chrome DevTools Network 中找到：

```text
/api/outer/ats-interview/interview/hr/interviewList
```

复制它的 Request Payload，然后执行：

```powershell
$body = '{"currentPage":1,"pageSize":10,"其他字段":"以实际Payload为准"}'

opencli moka applications `
  --request-json $body `
  --max-pages 1 `
  -f json `
  -v
```

不要复制或保存请求头中的：

- Cookie
- `moka-jwt`
- `moka-token`
- `csrfCk`
- `connect.sid`

## 15. 常见错误处理

### 无法连接 CDP Chrome

表现：

```text
无法连接 Moka 专用 Chrome
```

处理：

```powershell
opencli moka login -f json
opencli moka status -f json
```

### Moka 登录状态失效

表现：

```text
mokaLogin: waiting_for_user
```

处理：在同一个 CDP Chrome 中重新登录，然后执行：

```powershell
opencli moka status -f json
```

### 找不到“加载更多”且没有请求体缓存

表现：

```text
未找到可触发 interviewList 的“加载更多”按钮
```

处理：

1. 确认当前页面是 Moka 面试总览。
2. 在页面中调整任意只读筛选条件，让列表重新请求。
3. 立即重新执行 `applications`。
4. 仍然失败时使用 `--request-json`。

### `interviewList` 捕获超时

处理：

1. 确认总览页面已经正常显示候选人列表。
2. 确认点击“加载更多”时 Network 中能看到 `interviewList`。
3. 执行命令时增加 `-v`。
4. 必要时使用 `--request-json`。

### `getMeetingSummary` 返回 `code: 103`

这不是程序错误。表示当前 `(applicationId, interviewId)` 没有可用会议数据、尚未生成逐字稿或当前账号无权查看。继续测试其他面试。

### 修改源码后命令行为没有变化

```powershell
npm run build
Get-Item .\moka.js | Select-Object LastWriteTime, Length
```

确认 `moka.js` 更新时间已经变化，再重新运行 OpenCLI 命令。

### `npm run check` 提示找不到 `tsc`

```powershell
npm install
npm run check
```

## 16. 推荐的最短回归流程

日常修改代码后，执行下面这组命令即可完成主要回归：

```powershell
cd D:\Users\jingboma\proj\bossHr\Moka-transcript-getter

npm run check

opencli moka status -f json

opencli moka applications `
  --candidate "李龙一" `
  --max-pages 1 `
  -f json `
  -v

opencli moka interviews 813749158 -f json -v
```

从 `interviews` 输出复制一个真实 `interviewId`：

```powershell
opencli moka transcript 813749158 <真实interviewId> -f json -v

opencli moka export-transcripts `
  --candidate "李龙一" `
  --max-pages 1 `
  --output "D:\tmp\moka-regression.json" `
  -f json `
  -v
```

全部通过后，才进行全量导出。

## 17. 安全要求

- 只操作当前 Moka 账号有权查看的数据。
- 不读取、打印、复制或持久化登录 Cookie 和 Token。
- 不让脚本填写密码或验证码。
- 测试输出包含候选人个人信息和面试逐字稿，只能保存到获授权的位置。
- 不要把真实导出文件提交到 Git。
- 提交代码前检查 `git status`，确保没有误加入候选人数据文件。
