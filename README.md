# Moka Transcript Getter

项目地址：[NeverlandzZ1/Moka-cli](https://github.com/NeverlandzZ1/Moka-cli)

面向 HR 的 Moka 面试记录导出工具。登录 Moka 后，一条命令即可导出今天涉及候选人的：

- 候选人姓名和应聘岗位
- 全部面试轮次及面试官
- 面试逐字稿
- Moka AI 总结和逐题分析

工具只读取当前账号有权查看的数据，不要求复制 Cookie、Token、密码或验证码。

## 使用前准备

电脑需要安装：

- [Google Chrome](https://www.google.com/chrome/)
- [Node.js 22 LTS](https://nodejs.org/)
- [Git](https://git-scm.com/downloads)

不需要安装 Python，也不需要安装 Chrome 扩展。

打开终端并确认：

```text
node --version
git --version
```

## 第一次安装

### 1. 安装 OpenCLI

Windows PowerShell 或 macOS Terminal 均可执行：

```text
npm install -g @jackwener/opencli@1.8.6
```

确认安装成功：

```text
opencli --version
```

### 2. 安装 Moka 插件

```text
opencli plugin install github:NeverlandzZ1/Moka-cli
```

确认插件已安装：

```text
opencli plugin list
opencli moka export-transcripts --help
```

### 3. 登录 Moka

```text
opencli moka login -f json
```

命令会打开一个专用 Chrome 窗口。请在该窗口中自行登录 Moka，不要关闭窗口。

登录完成后，在线捕获后续离线导出所需的请求体：

```text
opencli moka capture-payload -f json
```

命令会在需要时以 CDP 鼠标点击 Moka 侧栏的“面试安排”进入总览，再点击“加载更多”捕获请求；不会强制刷新页面。退出码为 0，且返回 `offlineReady: true`、`payloadSaved: true`、非空 `currentUserName` 后，Cookie、payload 和当前 HR 用户均已验证，可以关闭专用 Chrome。也可以随时单独检查在线状态：

```text
opencli moka status -f json
```

```json
{
  "mokaLogin": "authenticated"
}
```

### 手动切换校招或社招

导出前可以切换 Moka 当前的招聘模式：

```powershell
opencli moka mode campus -f json   # 校招
opencli moka mode social -f json   # 社招
```

也可以直接使用 `校招` 或 `社招`。该命令只用于手动调整当前网页模式；`export-transcripts` 不依赖它，会在一次执行中通过 HTTP 自动抓取校招和社招并合并结果。

## 日常使用

登录完成后，日常只需要运行一次导出命令。

Windows PowerShell：

```powershell
opencli moka export-transcripts `
  --output "$HOME\Desktop\moka-transcripts.json" `
  -f json
```

macOS：

```bash
opencli moka export-transcripts \
  --output "$HOME/Desktop/moka-transcripts.json" \
  -f json
```

工具会：

1. 读取当前 Moka 登录账号的 HR 展示姓名。
2. 通过 HTTP 切换到校招，抓取北京时间今天的校招面试。
3. 通过 HTTP 切换到社招，抓取北京时间今天的社招面试。
4. 按 `applicationId + interviewId` 合并去重两类数据并重新计算统计。
5. 将结果写入指定 JSON 文件，并在 JSON 顶层只写一次 `面试安排HR`。

今天没有面试时，`records` 可以为空。

## 重复导出

可以始终保存到同一个 JSON 文件。工具不会简单覆盖旧记录，而是按照下面的联合标识增量更新：

```text
applicationId + interviewId
```

- 两个 ID 都相同：更新已有面试记录。
- 任意一个 ID 不同：追加一条新面试记录。
- `stats` 根据合并后的文件重新计算。
- 已有文件格式不正确时停止写入，避免破坏原文件。

## 只保存本次结果

如果不需要历史记录，增加 `--overwrite`：

```powershell
opencli moka export-transcripts `
  --output "$HOME\Desktop\moka-transcripts.json" `
  --overwrite `
  -f json
```

开启后不会读取或合并旧文件。每次执行都只保存本次获取的记录；目标路径存在同名 JSON 时直接覆盖。未增加 `--overwrite` 时，仍保持默认的增量去重更新。

## 无 CDP 采集(Chrome 已关闭时)

只要曾经用 `opencli moka login` 成功登录并执行一次 `capture-payload`，后续采集就可以关闭 Chrome、加 `--offline` 跑纯 HTTP：

```powershell
opencli moka export-transcripts --offline `
  --output "$HOME\Desktop\moka-transcripts.json" `
  -f json
```

`--offline` 会读取 `~/.opencli/mokaData/moka-cookies.json` 中的登录态和 `~/.opencli/mokaData/moka-interview-list-payload.json` 中的请求体模板，直接发 HTTP 请求，不再拉起 Chrome。命令内部会完成两类招聘数据的采集与合并；整个过程不需要 CDP。适用于定时任务无人值守场景。

如果 Moka 应用侧的短期 session 已失效，插件会自动使用同一文件中的 Passport cookie 换取一次性 ticket，静默登录并把新 session 写回原 cookie 文件，然后重试原请求。这个续期过程同样不连接 CDP。手动更换登录态时必须替换完整的 `moka-cookies.json`，不能只复制 `app.mokahr.com` 下的几个 cookie，否则缺少 Passport 登录态就无法静默续期。

只有当 Passport 登录态本身也过期或被服务端撤销时，`--offline` 才会要求更换完整 cookie 文件或重新执行一次 `opencli moka login`。Passport 登录态仍有效时，普通应用 session 失效会自动恢复。

## 更新插件

从 GitHub 更新到最新版:

```text
opencli plugin update moka-transcripts
```

如果更新后 `--offline` 之类新参数报"unknown argument",说明 OpenCLI 缓存了旧命令,手动重装一次:

```text
opencli plugin uninstall moka-transcripts
opencli plugin install github:NeverlandzZ1/Moka-cli
opencli plugin list
```

仅当 OpenCLI 主程序缺失或不满足插件要求的 `>=1.8.6 <2` 时，安装兼容版本：

```text
npm install -g @jackwener/opencli@1.8.6
```

## 常见问题

### 提示无法连接 Moka 专用 Chrome

重新打开登录窗口：

```text
opencli moka login -f json
```

### Moka 页面要求重新登录

请运行 `opencli moka login -f json`，在专用 Chrome 中重新登录，再运行 `opencli moka capture-payload -f json`。确认 `offlineReady: true` 后才关闭 Chrome 或运行 `export-transcripts --offline`。不要从浏览器开发者工具复制 Cookie 或 Token。

### 页面首次打开比较慢

首次启动会创建独立 Chrome 登录环境，可能比日常 Chrome 慢。工具会在首次启动时自动补刷新一次，后续会复用同一登录环境。

### 某些面试没有逐字稿

Moka 可能返回“数据不存在”。这通常表示该场面试尚未生成逐字稿、没有会议数据或当前账号无查看权限。其他面试仍会继续导出。

### 输出文件包含什么

每场面试在 `records` 中对应一条记录，主要字段包括：

```text
candidateName
jobTitle
applicationId
interviewId
interviewerNames
roundName
startTime
transcript
evaluationSummary
questionAnalysis
```

导出 JSON 顶层还包含：

```text
面试安排HR
```

该字段来自当前 Moka 登录账号的 HR 展示姓名。在线导出和 `--offline` 导出都会写入；增量合并时以本次登录账号为准。

## 数据安全

- 只导出当前 Moka 账号有权访问的数据。
- 密码、验证码、Cookie 和 Token 不会写入导出文件。
- 逐字稿包含候选人个人信息，请只保存到公司允许的位置。
- 不要把导出的 JSON 上传到公开网盘或提交到 GitHub。

开发、测试和发布说明见 [TESTING.md](TESTING.md)。接口字段说明见 [reference/moka-interview-apis.md](reference/moka-interview-apis.md)。配套定时工作流位于 [moka-transcriptV2 Skill](skills/moka-transcriptV2/SKILL.md)，打包产物为 `skills/moka-transcriptV2.zip`。
