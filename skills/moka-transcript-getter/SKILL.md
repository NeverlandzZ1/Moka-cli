---
name: moka-transcript-getter
description: 为 HR 配置并运行 Moka 面试转写采集并写入飞书多维表格。用于用户明确调用 moka-transcript-getter、要求安装 Node.js/OpenCLI/lark-cli/Moka 插件并登录授权，或收到“定时任务，调用moka-transcript-getter skill，抓取今日社招和校招所有转写。”时；支持环境安装、Moka CDP 登录、飞书用户授权、可选创建定时任务，以及定时分别覆盖导出校招和社招 JSON 后去重写入飞书 Base。
---

# Moka Transcript Getter

只处理用户有权访问的 Moka 和飞书数据。通过本机 CDP Chrome 的已登录会话读取 Moka，通过 lark-cli 用户身份写入飞书 Base；绝不读取、复制、输出或持久化 Cookie、JWT、access token、密码、验证码等凭证。

## 路由

根据请求选择且只执行一个入口：

1. 用户要求“配置环境并登录”或同义表达：执行“首次配置入口”。
2. 请求内容为或明确表达“定时任务，调用moka-transcript-getter skill，抓取今日社招和校招所有转写。”：执行“定时采集入口”。

## 固定配置

- OpenCLI 插件仓库：`github:NeverlandzZ1/Moka-cli`
- lark-cli 官方包：`@larksuite/cli`
- CDP 默认端口：`9222`
- 逻辑输出路径：`~/.opencli/mokaData/transcript.json`
- Windows 实际路径：`$env:USERPROFILE\.opencli\mokaData\transcript.json`
- macOS/Linux 实际路径：`$HOME/.opencli/mokaData/transcript.json`
- 定时任务名称：`Moka转写抓取`
- 定时任务指令：`定时任务，调用moka-transcript-getter skill，抓取今日社招和校招所有转写。`
- 时区：`Asia/Shanghai`
- 执行 Agent：`Tripyoyo`
- 飞书 Base：https://trip.larkenterprise.com/base/TeB3bU3ltak2MWsD8I0cdoxPnSf
- 飞书同步脚本：`scripts/sync-lark-base.mjs`
- 脚本契约：`references/lark-base-write.md`
- 同步状态：与 `transcript.json` 同目录的 `lark-sync-state.json` 和 `lark-sync.lock`

始终先解析出绝对输出路径再传给 `--output`；不要把未展开的 `~` 直接交给 OpenCLI。

## 首次配置入口

### 1. 探测并补齐环境

识别操作系统，依次检查 Chrome、Node.js、npm、Git、OpenCLI、Moka 插件和 lark-cli。已有且可用时跳过安装，不要重复破坏现有环境。

最低要求：

- Google Chrome
- Node.js 20 以上；新装时优先 Node.js 22 LTS
- npm
- Git
- `@jackwener/opencli@latest`
- Moka 插件
- `@larksuite/cli@latest`

先执行只读检查：

```text
node --version
npm --version
git --version
opencli --version
opencli plugin list -f json
lark-cli --version
lark-cli auth status --json --verify
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

安装 lark-cli：

```text
npx @larksuite/cli@latest install
```

lark-cli 已存在时使用 `lark-cli update` 更新，不要用不明来源的同名 npm 包替换。

最后验证：

```text
opencli plugin list -f json
opencli moka login --help
opencli moka export-transcripts --help
lark-cli --version
lark-cli doctor
```

若某个安装步骤失败，先诊断并尝试安全的替代安装方式；仍失败则明确报告失败项和人工处理方法，不要继续假装环境可用。

### 2. 配置并授权 lark-cli

先执行 `lark-cli auth status --json --verify`。只有 user 身份已验证且能访问目标 Base 才可跳过配置与授权。

若尚未初始化配置，在后台启动：

```text
lark-cli config init --new
```

从输出提取授权 URL，保持 URL 原样；调用 `lark-cli auth qrcode <URL> --output "./lark-config-auth.png"` 生成二维码，同时把 URL 和二维码展示给用户，并暂停等待用户完成配置。不要要求用户提供 App Secret。

配置完成但 user 身份未授权时，使用 split-flow：

```text
lark-cli auth login --domain base --no-wait --json
```

提取 `verification_url` 和 `device_code`，用 `lark-cli auth qrcode` 生成二维码，将原始 URL 与二维码展示给用户，然后暂停。用户回复已授权后，由 Agent 执行：

```text
lark-cli auth login --device-code <本次流程返回的device_code>
lark-cli auth status --json --verify
```

所有飞书操作使用 `--as user`。判断 lark-cli 成功必须使用退出码 0 或 JSON 的 `ok == true`，不能用旧式 `code == 0`。如返回缺失 scope，按错误中的 `missing_scopes` 发起最小增量授权；不得输出 access token。

### 3. 打开 Moka 登录窗口并暂停

执行：

```text
opencli moka login -f json
```

该命令应打开使用独立用户目录的 CDP Chrome 并进入 Moka。告诉用户在这个窗口中完成登录，然后回复“登录好了”。到这里必须暂停并等待用户回复；不要索要账号、密码、验证码或 Cookie，也不要替用户登录。

### 4. 用户回复 Moka 登录完成后验证

执行：

```text
opencli moka status -f json
```

只有输出包含 `mokaLogin: authenticated` 才算成功。否则让用户继续在已打开的 Chrome 中完成登录并再次回复；不要进入定时任务步骤。

### 5. 询问是否创建定时任务

Moka 登录和飞书 user 授权都验证成功后，只问：“是否创建 Moka 转写抓取定时任务？”

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

该入口面向无人值守运行。不要重复安装环境；检查 Moka CDP 登录态、lark-cli user 授权和目标 Base，然后按“单模式覆盖导出 → 立即写飞书”的事务顺序采集。

### 1. 检查 Moka 和飞书状态

执行：

```text
opencli moka status -f json
lark-cli auth status --json --verify
```

- Moka 已认证且 lark-cli user 身份 `verified == true` 时继续。
- 若 CDP 未连接，执行一次 `opencli moka login -f json` 尝试恢复专用 Chrome，再检查状态。
- 若 Moka 仍未连接或登录失效，停止本次采集并汇报“需要 HR 在 Moka 专用 Chrome 中重新登录”。
- 若 lark-cli 未配置、user 授权失效或 Base 无权访问，停止本次采集并汇报需要 HR 重新完成飞书授权。
- 定时任务中不要等待用户，不要创建空结果或声称写入成功。

确认当前 Skill 目录存在 `scripts/sync-lark-base.mjs`。飞书记录的去重、查询、创建、更新、关联、失败回查、断点和锁全部由该脚本执行；Agent 禁止自行调用 `lark-cli base +record-upsert`、`+record-batch-create` 或 `+record-batch-update` 写这两张表。维护脚本时才读取 `references/lark-base-write.md`。

### 2. 校招：覆盖导出后立即写飞书

解析默认 JSON 的绝对路径，依次执行：

```text
opencli moka mode campus -f json
opencli moka export-transcripts --output "<绝对输出路径>" --overwrite -f json
```

确认导出成功后，解析当前 Skill 目录和 JSON 绝对路径，执行：

```text
node "<Skill目录>/scripts/sync-lark-base.mjs" --input "<绝对输出路径>"
```

如果 `lark-cli` 已安装但不在当前 PATH，先定位真实可执行文件，再增加 `--lark-cli "<可执行文件路径>"`；不要修改用户的全局 PATH。只有脚本退出码为 0 且输出 JSON 的 `ok == true` 才算校招落库成功。不得在脚本失败后绕过脚本手工重放任何飞书创建命令。

如果校招导出或写飞书失败，保留当前校招 JSON，停止本次流程，不要继续社招并覆盖该文件。记录失败阶段和错误。

### 3. 社招：再次覆盖后立即写飞书

仅在校招已成功写入飞书后执行：

```text
opencli moka mode social -f json
opencli moka export-transcripts --output "<同一绝对输出路径>" --overwrite -f json
```

此时 JSON 只包含本次社招结果，校招 JSON 被覆盖是预期行为，因为校招数据已经进入飞书。随后再次执行同一个 `sync-lark-base.mjs --input "<绝对输出路径>"`。脚本使用持久 checkpoint 和联合键回查，因此可安全接续校招运行。

若社招写入失败，保留当前社招 JSON，报告失败，便于人工重试；不得声称全流程成功。

脚本自行清理 lark-cli 临时请求文件。Agent 不删除默认导出文件、checkpoint 或锁文件；锁文件由脚本在正常退出时释放。

### 4. 汇总本次结果

分别记录校招和社招导出结果、飞书新增/更新结果及涉及的面试记录。不要在对话中输出 `transcript`、`evaluationSummary`、`questionAnalysis` 等长文本。

每条本次处理的记录只汇报：

```text
候选人：<脱敏后的 candidateName>｜面试官：<脱敏后的 interviewerNames，以顿号连接；缺失时写“未记录”>｜岗位：<jobTitle>
```

姓名脱敏规则：

- 中文姓名保留姓氏，其余字符替换为 `*`：`张三` → `张*`，`王小明` → `王**`；单字姓名显示 `*`。
- 英文姓名的每个单词只保留首字母，其余字符替换为 `*`：`Alice Smith` → `A**** S****`。
- 中英文组合姓名分别按上述规则处理。
- 真实姓名只允许写入本 Skill 固定配置且用户已授权的飞书 Base。不得在聊天回复、定时任务摘要、错误信息、调试日志或临时请求文件名中输出真实姓名。

最后汇报：

- 校招、社招分别是否导出成功、是否写入飞书成功
- 本次去重后的记录数
- 飞书新增面试官数、新增面试记录数、从不明确创建结果中回查恢复数、更新面试记录数
- 表内已有重复冲突数；若大于 0，列出每组 `applicationId + interviewId` 和全部重复 `record_id`，并说明未自动删除
- 上述每条简要信息
- JSON 的绝对保存路径，并说明该文件只保留最后一次成功导出的单模式数据
- 飞书 Base 链接
- 若有错误，列出阶段和简短错误原因

不要汇报逐字稿正文。没有今日记录时明确说“今日没有可导出的面试记录”，仍报告两个模式状态、JSON 路径和 Base 链接。

## 安全与边界

- 只访问当前登录账号有权查看的数据。
- 不使用 mitmproxy 完成日常采集；不要求用户提供抓包或凭证。
- 不把 JSON 数据文件写进插件仓库或 Skill 目录。
- 只把候选人数据写入本 Skill 固定配置的飞书 Base；不上传或发送到其他位置。
- 对话汇报、自动化摘要、错误信息和调试日志中的候选人及面试官姓名必须脱敏；不得输出手机号、邮箱、身份证号或逐字稿正文。
- 不因定时任务失败而重新安装工具、删除 Chrome Profile、删除飞书记录或清空 Base。
- 不直接重试脚本内部失败的创建操作；重新运行整个脚本即可，脚本会先按联合键回查。
- 默认 JSON 是单次中转文件，不再承担历史存储；历史去重与覆盖由同步脚本的输入去重、进程锁、checkpoint、双字段精确查询、创建失败回查和逐条串行写入共同保证。
