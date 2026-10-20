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
skills/moka-transcriptV2/  与插件同仓维护的定时任务 Skill
skills/pack.py              Skill ZIP 打包脚本
README.md                   HR 使用文档
TESTING.md                  开发测试文档
```

Skill 与插件在同一仓库维护，但 OpenCLI 插件名仍是 `moka-transcripts`；只修改 Skill 文件夹名不改变插件注册名。

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

修改源码后先重新构建；注册信息变化或本地/GitHub 安装来源切换时，按以下流程重新安装：

```powershell
# 1) 重新构建 moka.js(OpenCLI 只加载根目录 moka.js,不会跑 src/plugin.ts)
npm run build

# 2) 卸载旧版本(不管是 GitHub 装的还是本地装的,都用同一个名字卸载)
opencli plugin uninstall moka-transcripts

# 3) 从当前仓库重新安装(OpenCLI 不接受 "." 相对路径,必须传绝对路径或 file:// URL)
#    Windows PowerShell:
opencli plugin install "$PWD"
#    或显式绝对路径,例如:
#    opencli plugin install "D:\Users\jingboma\proj\bossHr\Moka-transcript-getter"
#    或 file:// URL(注意三个斜杠):
#    opencli plugin install "file:///D:/Users/jingboma/proj/bossHr/Moka-transcript-getter"
#    macOS/Linux:
#    opencli plugin install "$(pwd)"

# 4) 验证命令都注册上了(新增 --offline 请在 export-transcripts --help 里确认)
opencli plugin list -f json
opencli moka login --help
opencli moka capture-payload --help
opencli moka status --help
opencli moka mode --help
opencli moka applications --help
opencli moka interviews --help
opencli moka transcript --help
opencli moka export-transcripts --help
```

本地路径安装采用目录链接方式，后续仅修改实现时执行 `npm run build` 覆盖 `moka.js` 即可生效。当以下任一情况发生时**必须**完整重装（重新走一遍上面 1~3 步）：

- 修改了 `opencli-plugin.json`(命令元信息、参数、别名等)
- 从 GitHub 版本切到本地开发版本,或反过来
- 之前用 `--offline` 等新参数报"unknown argument"——说明 OpenCLI 缓存了旧命令注册

如果安装插件后 `tsc`、`vitest` 或 `esbuild` 消失,重新执行:

```powershell
npm install
```

## 4.1 内部缓存文件

插件运行后会在用户主目录写入以下 CLI 内部缓存(**这些文件由 CLI 内部读写,Agent 严禁 cat / 打印 / 上传**):

```text
~/.opencli/mokaData/moka-cookies.json                    Moka `.mokahr.com` 域下的 session cookie 缓存
~/.opencli/mokaData/moka-interview-list-payload.json     interviewList 请求体模板
~/.opencli/mokaData/transcript.json                      默认逐字稿输出路径(HR 数据)
```

- `moka-cookies.json` 在 `login`/`status`/`mode`/`capture-payload` 命令成功后自动刷新；`export-transcripts --offline` 发现应用 session 失效时，会用其中的 Passport cookie 调用 ticket + uniLogin 静默续期，把响应中的 `Set-Cookie` 合并落盘后重试原请求。增强后的导出会在同一 HTTP client 中依次切换校招、社招并合并结果，不连接 CDP。
- `moka-interview-list-payload.json` 由 `capture-payload` 在登录完成后点击总览中的“加载更多”并捕获，不刷新页面；后续 `--offline` 直接从此文件复用。带 CDP 的 `applications` / `export-transcripts` 在缓存缺失时仍可兼容捕获。

**首次使用必须执行 `opencli moka login`，登录完成后再执行一次 `opencli moka capture-payload -f json`**。只有返回 `offlineReady: true` 后，HR 才关闭 Chrome，之后依靠这两个缓存走纯 HTTP。若人工切换账号，重新执行这两个步骤；不要只替换应用 session cookie。

## 5. 登录与 Chrome 回归

启动专用 Chrome：

```powershell
opencli moka login -f json
```

完成登录后执行：

```powershell
opencli moka capture-payload -f json
```

检查返回 `offlineReady: true`、`payloadSaved: true`，且 `currentUserName` 是当前登录的 HR；命令不得输出 payload 正文或 Cookie。成功后可以关闭 Chrome。

登录后即使当前停在仪表盘或其他 Moka 页面，`capture-payload` 也应通过 CDP 原生鼠标点击侧栏“面试安排”进入 `/interviews/overview`，等待“加载更多”出现后再捕获；不得为捕获动作使用 `Page.reload` 或 `page.goto`，也不要求用户手动切换页面。

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

- 当前 HR 用户接口只调用一次，顶层 `面试安排HR` 只写一次。
- 模式切换顺序固定为校招（`currentHireMode=2`）后社招（`currentHireMode=1`）。
- 校招和社招记录按 `applicationId + interviewId` 合并，重复联合键只保留一条。
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
2. 确认总览列表的“加载更多”按钮可用；必要时人工进入面试安排页检查账号权限。
3. 重新执行 `opencli moka capture-payload -f json`，只以该命令成功结果确认离线准备完成。
4. 若仍失败，检查 Network 中点击“加载更多”后是否出现 `interviewList`。

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
- `skills/moka-transcriptV2/SKILL.md` 的 `name` 与目录名一致，且 `python skills/pack.py` 生成 `skills/moka-transcriptV2.zip`；ZIP 内包含 Skill、references 与 scripts。
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
