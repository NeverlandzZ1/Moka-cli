# Moka Transcript Getter 开发与测试

本文只面向插件开发者，包含本地构建、OpenCLI 注册、真实 Moka 回归和发布前检查。普通 HR 请阅读 [README.md](README.md)。

## 1. 开发环境

- Node.js 20 或更高版本，推荐 Node.js 22 LTS
- npm
- Git
- Google Chrome
- OpenCLI 1.8.6 或更高版本

进入克隆后的仓库：

```powershell
Set-Location "<插件仓库目录>"
```

安装依赖：

```powershell
npm install
npm install -g @jackwener/opencli@1.8.6
```

## 2. 项目结构

```text
opencli-plugin.json          OpenCLI 插件清单
package.json                构建、测试和版本信息
moka.js                     OpenCLI 实际加载的构建产物
src/                        TypeScript 源码
tests/                      Vitest 单元测试
reference/                  Moka 接口说明
README.md                   HR 使用文档
TESTING.md                  开发测试文档
```

Skill 不属于本仓库，应在独立仓库中开发和发布。

## 3. 构建与单元测试

完整检查：

```powershell
npm run check
```

该命令依次执行：

1. `tsc --noEmit`
2. `vitest run`
3. esbuild 打包
4. 更新根目录 `moka.js`

只重新构建：

```powershell
npm run build
```

修改 `src` 后必须重新构建并提交 `moka.js`。OpenCLI 从插件根目录加载 `moka.js`，不会直接运行 `src/plugin.ts`。

## 4. 本地安装插件

如果已经安装过 GitHub 版本或旧的本地版本，先卸载：

```powershell
opencli plugin uninstall moka-transcripts
```

从当前仓库安装：

```powershell
opencli plugin install .
```

验证：

```powershell
opencli plugin list -f json
opencli moka login --help
opencli moka status --help
opencli moka mode --help
opencli moka applications --help
opencli moka interviews --help
opencli moka transcript --help
opencli moka export-transcripts --help
```

本地插件通过目录链接加载。修改源码并执行 `npm run build` 后，通常不需要重新安装插件。

如果安装插件后 `tsc`、`vitest` 或 `esbuild` 消失，重新执行：

```powershell
npm install
```

## 5. 登录与 Chrome 回归

启动专用 Chrome：

```powershell
opencli moka login -f json
```

首次冷启动应满足：

- 使用默认 CDP 端口 `9222`。
- 创建或复用独立 Chrome Profile。
- 打开 Moka 面试总览。
- 新启动 Chrome 时自动补刷新一次。
- 返回 `launched: true` 和 `refreshedAfterLaunch: true`。

重复执行登录命令应满足：

- 复用现有 Moka 页面。
- 不创建重复标签页。
- 不刷新已登录页面。
- 返回 `launched: false`、`reusedMokaTab: true` 和 `refreshedAfterLaunch: false`。

检查登录状态：

```powershell
opencli moka status -f json
```

通过标准：

```json
{
  "browser": "connected",
  "mokaLogin": "authenticated"
}
```

如果需要其他端口，所有命令必须使用相同端口：

```powershell
opencli moka login --port 9223 -f json
opencli moka status --port 9223 -f json
opencli moka applications --port 9223 -f json
```

## 6. 候选人发现回归

```powershell
opencli moka applications -f json -v
```

检查：

- 只查询北京时间今天，不查询今天之前或今天之后。
- 自动遍历今天的全部分页。
- 按面试开始时间升序返回。
- `applicationId`、候选人姓名和岗位正确关联。
- 同一 `applicationId` 只出现一次。
- 今天没有面试时允许返回空数组。
- 首次执行可以捕获并缓存 Moka 的 `interviewList` 请求体模板。
- 命令不得刷新或破坏已登录的 Moka 页面。

再次执行相同命令，确认直接复用当前标签页的请求体缓存。

## 7. 面试列表回归

从 `applications` 输出选择一个真实 `applicationId`：

```powershell
$applicationId = "REPLACE_WITH_APPLICATION_ID"
opencli moka interviews $applicationId -f json -v
```

检查：

- 位置参数能够正确传入，不出现“application-id 不能为空”。
- 返回该应聘记录下的全部 `entities`。
- `interviewId` 使用 `entities[].id`，不是 `groupInterviewId`。
- 多位面试官保存到 `interviewerNames` 数组并去重。
- 候选人和岗位信息正确。

## 8. 单场逐字稿回归

从 `interviews` 输出选择一个真实 `interviewId`：

```powershell
$interviewId = "REPLACE_WITH_INTERVIEW_ID"
opencli moka transcript $applicationId $interviewId -f json -v
```

有逐字稿时检查：

```json
{
  "transcriptStatus": "available",
  "transcript": "...",
  "evaluationSummary": "...",
  "questionAnalysis": {}
}
```

没有逐字稿时允许：

```json
{
  "transcriptStatus": "not_available",
  "mokaCode": 103,
  "mokaMessage": "数据不存在"
}
```

单场无逐字稿不得导致整个批量任务失败。

## 9. 完整导出回归

先选择一个今天有面试的候选人：

```powershell
$candidateOutput = Join-Path ([System.IO.Path]::GetTempPath()) "moka-candidate-test.json"

opencli moka export-transcripts `
  --candidate "<候选人姓名>" `
  --output $candidateOutput `
  -f json `
  -v
```

检查：

- `records` 中候选人、岗位、面试官和逐字稿关联正确。
- `stats.applications` 是应聘记录数。
- `stats.interviews` 是合并后保存的面试数。
- 无逐字稿记录计入 `transcriptsUnavailable`。
- 单项错误进入 `errors`，已成功记录仍然保留。

再执行今天全量导出：

```powershell
$fullOutput = Join-Path ([System.IO.Path]::GetTempPath()) "moka-transcripts-test.json"

opencli moka export-transcripts `
  --output $fullOutput `
  -f json
```

## 10. 增量合并回归

使用同一个 `$fullOutput` 再导出一次：

```powershell
opencli moka export-transcripts `
  --output $fullOutput `
  -f json

$result = Get-Content -Raw -Encoding utf8 $fullOutput | ConvertFrom-Json
$duplicates = $result.records |
  Group-Object { "$($_.applicationId):$($_.interviewId)" } |
  Where-Object Count -gt 1
$duplicates
```

通过标准：

- `$duplicates` 没有输出。
- 相同 `(applicationId, interviewId)` 被新记录更新。
- 新联合键追加到 `records`。
- `stats` 按合并后的记录重新计算。
- `errors` 反映本次导出的错误。

还应使用隔离测试文件验证：

- Windows 盘符根目录不会对已存在的盘符执行 `mkdir`。
- 不存在的普通父目录会自动创建。
- macOS/Linux 路径能够正常解析。
- 已有文件不是合法 JSON 时停止写入，不覆盖原文件。

## 11. 覆盖导出回归

先确保 `$fullOutput` 中存在历史记录，再执行：

```powershell
opencli moka export-transcripts `
  --output $fullOutput `
  --overwrite `
  -f json
```

通过标准：

- 文件只包含这次命令获取的记录。
- 旧文件中、本次未获取的 `applicationId + interviewId` 不再存在。
- `generatedAt`、`errors` 和 `stats` 都来自本次结果。
- 即使同名文件已存在也直接覆盖。
- 不带 `--overwrite` 再运行时仍执行增量合并。

## 12. 请求体捕获故障排查

如果提示找不到“加载更多”或捕获超时：

1. 确认专用 Chrome 已登录并正常显示面试总览。
2. 在总览页调整一个只读筛选条件以触发列表请求。
3. 重新执行 `applications -v`。
4. 检查 Network 中是否出现 `interviewList`。

仅在自动捕获失效时使用 `--request-json`：

```powershell
$body = '{"currentPage":1,"pageSize":10,"其他字段":"以实际请求为准"}'
opencli moka applications --request-json $body -f json -v
```

不得复制、记录或提交请求头中的 Cookie、`moka-jwt`、`moka-token`、`csrfCk` 或 `connect.sid`。

## 13. 最短回归流程

```powershell
npm run check
opencli moka status -f json
opencli moka applications -f json -v
$applicationId = "REPLACE_WITH_APPLICATION_ID"
$interviewId = "REPLACE_WITH_INTERVIEW_ID"
opencli moka interviews $applicationId -f json -v
opencli moka transcript $applicationId $interviewId -f json -v
```

最后用一位今天有面试的候选人执行一次 `export-transcripts`。

## 14. 发布前检查

```powershell
npm run check
git diff --check
git status --short
```

确认：

- `package.json` 与 `opencli-plugin.json` 版本一致。
- 根目录 `moka.js` 是最新构建结果并已提交。
- 仓库中不存在 `skills/` 目录。
- 没有真实逐字稿、候选人导出 JSON、Cookie 或 Token。
- README 中的 GitHub 安装地址与当前 `origin` 一致。
- 没有个人电脑绝对路径、用户名或公司内部临时目录。

从 GitHub 安装做最终验证：

```powershell
opencli plugin uninstall moka-transcripts
opencli plugin install github:NeverlandzZ1/Moka-cli
opencli plugin list
opencli moka login -f json
```

插件更新回归：

```powershell
opencli plugin update moka-transcripts
```

## 15. 安全要求

- 只使用测试账号有权查看的数据。
- 不让脚本填写账号、密码或验证码。
- 测试输出必须写入获授权位置并在验证后安全处理。
- 不要提交导出的 JSON、日志、Trace 或浏览器 Profile。
- 发布公开仓库前检查当前文件和 Git 历史，确保都没有个人路径或敏感信息。

接口结构与字段来源见 [reference/moka-interview-apis.md](reference/moka-interview-apis.md)。
