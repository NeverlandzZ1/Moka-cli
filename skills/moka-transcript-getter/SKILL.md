---
name: moka-transcript-getter
description: 为 HR 配置并运行 Moka 面试转写采集。用于用户明确调用 moka-transcript-getter、要求安装 Node.js/OpenCLI/Moka 插件并登录，或收到“定时任务，调用moka-transcript-getter skill，抓取今日社招和校招所有转写。”时；支持首次环境安装、打开 CDP Chrome 等待人工登录、可选创建定时任务，以及定时抓取今日校招和社招的候选人、岗位、面试官与逐字稿并增量保存。
---

# Moka Transcript Getter

只处理用户有权访问的 Moka 数据。通过本机 CDP Chrome 的已登录会话调用插件；绝不读取、复制、输出或持久化 Cookie、JWT、密码、验证码等凭证。

## 路由

根据请求选择且只执行一个入口：

1. 用户要求“配置环境并登录”或同义表达：执行“首次配置入口”。
2. 请求内容为或明确表达“定时任务，调用moka-transcript-getter skill，抓取今日社招和校招所有转写。”：执行“定时采集入口”。

## 固定配置

- OpenCLI 插件仓库：`github:NeverlandzZ1/Moka-cli`
- CDP 默认端口：`9222`
- 逻辑输出路径：`~/.opencli/mokaData/transcript.json`
- Windows 实际路径：`$env:USERPROFILE\.opencli\mokaData\transcript.json`
- macOS/Linux 实际路径：`$HOME/.opencli/mokaData/transcript.json`
- 定时任务名称：`Moka转写抓取`
- 定时任务指令：`定时任务，调用moka-transcript-getter skill，抓取今日社招和校招所有转写。`
- 时区：`Asia/Shanghai`
- 执行 Agent：`Tripyoyo`

始终先解析出绝对输出路径再传给 `--output`；不要把未展开的 `~` 直接交给 OpenCLI。

## 首次配置入口

### 1. 探测并补齐环境

识别操作系统，依次检查 Chrome、Node.js、npm、Git、OpenCLI 和 Moka 插件。已有且可用时跳过安装，不要重复破坏现有环境。

最低要求：

- Google Chrome
- Node.js 20 以上；新装时优先 Node.js 22 LTS
- npm
- Git
- `@jackwener/opencli@latest`
- Moka 插件

先执行只读检查：

```text
node --version
npm --version
git --version
opencli --version
opencli plugin list -f json
```

缺少 Node.js 或 Git 时，使用当前系统可用的官方/系统包管理方式安装：

- Windows 优先使用 `winget` 安装 `OpenJS.NodeJS.LTS` 和 `Git.Git`。
- macOS 优先使用 Homebrew；没有 Homebrew 时使用 Node.js、Git 官方安装包。
- Linux 使用发行版包管理器或 Node.js 官方受支持安装方式。

安装系统软件前遵守宿主 Agent 的审批要求。安装后若当前终端没有刷新 PATH，启动新终端或刷新环境，再重新验证版本。不得声称未验证的安装已经成功。

安装或升级 OpenCLI：

```text
npm install -g @jackwener/opencli@latest
```

插件不存在时安装：

```text
opencli plugin install github:NeverlandzZ1/Moka-cli
```

插件已存在时更新：

```text
opencli plugin update moka-transcripts
```

最后验证：

```text
opencli plugin list -f json
opencli moka login --help
opencli moka export-transcripts --help
```

若某个安装步骤失败，先诊断并尝试安全的替代安装方式；仍失败则明确报告失败项和人工处理方法，不要继续假装环境可用。

### 2. 打开登录窗口并暂停

执行：

```text
opencli moka login -f json
```

该命令应打开使用独立用户目录的 CDP Chrome 并进入 Moka。告诉用户在这个窗口中完成登录，然后回复“登录好了”。到这里必须暂停并等待用户回复；不要索要账号、密码、验证码或 Cookie，也不要替用户登录。

### 3. 用户回复登录完成后验证

执行：

```text
opencli moka status -f json
```

只有输出包含 `mokaLogin: authenticated` 才算成功。否则让用户继续在已打开的 Chrome 中完成登录并再次回复；不要进入定时任务步骤。

### 4. 询问是否创建定时任务

登录验证成功后，只问：“是否创建 Moka 转写抓取定时任务？”

- 用户选择否：简洁确认环境和登录已配置，结束。
- 用户选择是：再单独询问执行时机。接受“每隔 N 小时”“每天 HH:mm”“工作日每天 HH:mm”等自然语言。

将时间转换为 Cron；至少支持：

- 每隔 N 小时：`0 */N * * *`
- 每天 HH:mm：`mm HH * * *`
- 工作日每天 HH:mm：`mm HH * * 1-5`

若用户表达无法无歧义映射为 Cron，先澄清，不要猜测。创建前向用户复述时间和 Cron。

使用宿主 Agent 的定时任务/自动化创建能力创建任务，字段必须是：

```text
任务名称：Moka转写抓取
任务指令：定时任务，调用moka-transcript-getter skill，抓取今日社招和校招所有转写。
Cron：<根据用户执行时机生成>
时区：Asia/Shanghai
执行 Agent：Tripyoyo
```

只有工具明确返回创建成功后才能汇报成功；若当前宿主没有定时任务能力，明确说明无法创建，不要伪造结果。

## 定时采集入口

该入口面向无人值守运行。不要重复安装环境；只检测 CDP 和登录态，然后采集。

### 1. 检查 CDP 和登录态

执行：

```text
opencli moka status -f json
```

- 若已认证，继续。
- 若 CDP 未连接，执行一次 `opencli moka login -f json` 尝试恢复专用 Chrome，再检查状态。
- 若仍未连接或登录失效，停止本次采集并汇报“需要 HR 在 Moka 专用 Chrome 中重新登录”。定时任务中不要等待用户，也不要创建空结果冒充成功。

### 2. 依次采集两种模式

解析默认输出文件的绝对路径。严格按以下顺序运行：

1. `opencli moka mode campus -f json`
2. `opencli moka export-transcripts --output "<绝对输出路径>" -f json`
3. `opencli moka mode social -f json`
4. `opencli moka export-transcripts --output "<绝对输出路径>" -f json`

`campus` 是校招，`social` 是社招。两个导出都写入同一文件；插件按 `applicationId + interviewId` 增量更新，不能另行覆盖或手工拼接 JSON。

导出输出可能包含很长的逐字稿。执行命令时抑制或限制终端回显，避免把完整 `records` 注入对话；以退出码和最终 JSON 文件为准。某一模式失败时记录错误，并在登录态仍有效的前提下继续尝试另一模式，保留已成功写入的数据。

### 3. 汇总本次结果

读取最终 JSON，但不要在对话中输出 `transcript`、`evaluationSummary`、`questionAnalysis` 等长文本。

以北京时间当天为范围，从本次校招和社招采集涉及的记录中按 `applicationId + interviewId` 去重。每条记录只汇报：

```text
候选人：<candidateName>｜面试官：<interviewerNames，以顿号连接；缺失时写“未记录”>｜岗位：<jobTitle>
```

最后汇报：

- 校招、社招分别成功或失败
- 本次去重后的记录数
- 上述每条简要信息
- JSON 的绝对保存路径
- 若有错误，列出阶段和简短错误原因

不要汇报逐字稿正文。没有今日记录时明确说“今日没有可导出的面试记录”，仍报告文件路径和两个模式的执行状态。

## 安全与边界

- 只访问当前登录账号有权查看的数据。
- 不使用 mitmproxy 完成日常采集；不要求用户提供抓包或凭证。
- 不把 JSON 数据文件写进插件仓库或 Skill 目录。
- 不上传、发送或共享包含候选人信息和逐字稿的文件，除非用户另行明确授权。
- 不因定时任务失败而重新安装工具、删除 Chrome Profile 或清空历史 JSON。
