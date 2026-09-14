---
name: moka-transcript-getter
description: 为 HR 配置并运行 Moka 面试转写采集并写入飞书多维表格。用于用户明确调用 moka-transcript-getter、要求安装 Node.js/OpenCLI/lark-cli/Moka 插件并登录授权，或收到"定时任务，调用moka-transcript-getter skill，抓取今日默认模式转写。"或"定时任务，调用moka-transcript-getter skill，抓取今日社招和校招所有转写。"时；支持环境安装、Moka CDP 登录、本地登录态持久化、飞书用户授权、可选创建默认模式(纯 HTTP、无需 CDP 常驻)或全模式(需 CDP 常驻切换校招/社招)的定时任务并批量写入飞书 Base 后自动去重。
---

# Moka Transcript Getter

只处理用户有权访问的 Moka 和飞书数据。通过本机 CDP Chrome 的已登录会话读取 Moka，通过 lark-cli 用户身份写入飞书 Base。

**凭证边界**：
- Agent 层（对话回复、日志摘要、错误信息、临时文件名、脚本 stdout）**不得读取、复制、回显或持久化**任何 Cookie、JWT、access token、密码、验证码。
- CLI 插件（`opencli moka`）**内部**为了支持默认模式定时任务在 Chrome 被关闭时也能采集，允许把 `.mokahr.com` 域下的 Moka session cookie 明文落盘到 `~/.opencli/mokaData/moka-cookies.json`（仅当前 OS 用户账户可读）。该文件由 CLI 内部读写，Agent 不得读取、cat、上传、转发或在对话/日志中回显该文件内容。

## 路由

根据请求选择且只执行一个入口：

1. 用户要求"配置环境并登录"或同义表达：执行"首次配置入口"。
2. 请求内容为或明确表达"定时任务，调用moka-transcript-getter skill，抓取今日默认模式转写。"：执行"定时采集入口 · 默认模式"。
3. 请求内容为或明确表达"定时任务，调用moka-transcript-getter skill，抓取今日社招和校招所有转写。"：执行"定时采集入口 · 全模式"。

## 固定配置

- OpenCLI 插件仓库：`github:NeverlandzZ1/Moka-cli`
- lark-cli 官方包：`@larksuite/cli`
- CDP 默认端口：`9222`
- 逻辑输出路径：`~/.opencli/mokaData/transcript.json`
- Windows 实际路径：`$env:USERPROFILE\.opencli\mokaData\transcript.json`
- macOS/Linux 实际路径：`$HOME/.opencli/mokaData/transcript.json`
- CLI 内部 Moka cookie 缓存：`~/.opencli/mokaData/moka-cookies.json`（仅 CLI 读写，Agent 不得读取）
- CLI 内部 interviewList 请求体模板缓存：`~/.opencli/mokaData/moka-interview-list-payload.json`
- 定时任务名称（默认模式）：`Moka转写抓取-默认模式`
- 定时任务指令（默认模式）：`定时任务，调用moka-transcript-getter skill，抓取今日默认模式转写。`
- 定时任务名称（全模式）：`Moka转写抓取-全模式`
- 定时任务指令（全模式）：`定时任务，调用moka-transcript-getter skill，抓取今日社招和校招所有转写。`
- 时区：`Asia/Shanghai`
- 执行 Agent：`当前助手自身`
- 飞书 Base：首次配置时由用户提供（支持新建、指定或使用已有配置），存入 `~/.opencli/moka-config.json` 的 `feishu_base_url` 字段；后续从该配置读取
- 飞书同步脚本：`scripts/sync-lark-base.mjs`（内置 Windows 命令行长度保护：JSON > 3000 字符时自动切换为 `@./file.json` 临时文件模式）
- 飞书去重脚本：`scripts/deduplicate-lark-base.mjs`（逐条删除策略，非 batch delete；同样内置 @file 保护）
- 面试官(人员)回填脚本：`scripts/backfill-interviewer-user.mjs`（dedup 之后运行,用「面试官」text 列 + 同表已有映射 + `contact +search-user` 兜底,把姓名解析为 open_id 写入「面试官(人员)」user 列）
- 逐字稿量化脚本：`scripts/transcript_stats.py`（读取纯文本逐字稿，输出面试官/候选人时长、追问轮次等统计 JSON）
- 报告一键生成脚本：`scripts/generate-report.mjs`（封装"复制模板 → 替换 18 个 token → 跑 transcript_stats.py → 跑 inline-badge-icon → 校验 → 输出 HTML"全流程；Agent 只需打分+传参,不要手写 HTML 或临时脚本）
- Badge PNG base64 内联脚本:`scripts/inline-badge-icon.mjs`(把 HTML 里 `<img src="icon/xxx.png">` 和 `<img src="logo.png">` 的 `src` 就地替换为 `data:image/png;base64,...`,让 artifact 发布后浏览器不再依赖旁边的 icon/ 目录;由 `generate-report.mjs` 自动调用,Agent 无需单独调)
- 报告模板:`assets/report-template.html`(六维复盘 HTML,含 18 个 `{{TOKEN}}`;logo 和 badge icon 均引用 `.png` 文件,由 `inline-badge-icon.mjs` 内联为 base64)
- 模板 Logo:`assets/logo.png`
- 复盘称号图标目录:`assets/icon/`(7 个极小的 PNG:`破冰高手.png`、`灵魂提问官.png`、`最佳听众.png`、`追问达人.png`、`分寸感在线.png`、`暖心体验官.png`、`本场请注意.png`;`{{BADGE_ICON}}` 只能从这 7 个文件名里选)
- 脚本契约：`references/lark-base-write.md`
- 评分与报告执行契约：`references/interviewer-review-workflow.md`
- 评分锚点与话术：`references/evaluation-guide.md`、`references/interview-toolkit.md`、`references/red-lines.md`

始终先解析出绝对输出路径再传给 `--output`；不要把未展开的 `~` 直接交给 OpenCLI。

## 首次配置入口

**⚠️ 交互原则:选择尽量一次性收齐,不要一步问一次。** 首次配置涉及 4 个用户选择:
1. 飞书 Base URL 来源(使用已有 config / 新建 / 手动指定)
2. Moka 登录态处理(本地有 cookie 时:继续用 / 重新登录;本地无 cookie 时:无选项,必须重新登录)
3. 采集模式(默认模式 / 全模式)
4. 是否创建定时任务(是 / 否,若是则问执行时机)

**执行顺序**:
- 第 1、3、4 项**可以合并成一次多问选项框**,在 lark-cli 授权通过后一并向用户提问,一次拿齐再往下走。第 2 项**必须先做磁盘 cookie 存在性探测**才能决定要不要给选项(本地无 cookie 时没有选项可选),所以放在探测之后紧接着单独问——不能提前混进"一次性选项框",否则用户看到的"继续用"选项在本地无 cookie 时是无效的。
- 若宿主的选项框工具不支持一次收多个问题,退化为顺序问,但**每个问题的选项要一次给全**,不要中途插入其他步骤打断用户。
- **本 Skill 只负责 Moka 相关配置**——lark-cli 的授权二维码、系统软件的安装审批等属于其他子步骤的必要交互,该问还要问,不合并进上述 4 选项。

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

若更新后 `opencli moka export-transcripts --help` 里看不到 `--offline` 参数,说明 OpenCLI 缓存了旧命令注册,手动重装一次:

```text
opencli plugin uninstall moka-transcripts
opencli plugin install github:NeverlandzZ1/Moka-cli
opencli plugin list
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

从输出提取授权 URL，保持 URL 原样；调用 `lark-cli auth qrcode <URL> --output "./lark-config-auth.svg"` 生成二维码，同时把 URL 和二维码展示给用户，并暂停等待用户完成配置。不要要求用户提供 App Secret。

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

### 3. 收集飞书 Base URL

lark-cli 授权通过后,用**选项框**让用户明确选择本次要用哪个飞书多维表格作为写入目标——**即使 `~/.opencli/moka-config.json` 已有 `feishu_base_url`,也必须问一次**,不要静默沿用,让用户能显式确认或换目标。config 有值时把已有 URL 作为"使用已有配置"选项的提示直接展示出来,方便用户核对(URL 是同租户内已授权 Base,不算敏感,可以直接放到选项描述里)。

| 选项 | 说明 |
|------|------|
| 📂 使用已有配置(默认) | 从 `~/.opencli/moka-config.json` 读取 `feishu_base_url` 继续用;config 无值或为空时**不出这个选项**,让用户从下面两个里选 |
| ✨ 让智能体新建 | 使用 `lark-cli base +app-table-create` 在已授权的飞书租户下创建新的多维表格,表名默认 `Moka面试转写记录`,创建后打开面试转写表并把带 `?table=<id>` 的完整 URL 写入配置 |
| 🔗 用户指定 URL | 用户手动粘贴飞书 Base URL(格式:`https://xxx.feishu.cn/base/<app_token>?table=<table_id>`,必须包含 `?table=<id>` 参数——即在多维表格中选中目标面试转写表后再复制 URL),Agent 验证可访问后写入配置 |

用户提供或新建后,写入 `~/.opencli/moka-config.json`:

```json
{ "feishu_base_url": "<用户提供或新建的URL>" }
```

后续**首次配置的所有飞书写入操作**都从该文件读取 `feishu_base_url`。用户选"使用已有"时保留原值不重写。

**⚠️ 定时采集入口不会再问这个选项**——定时任务直接读 `~/.opencli/moka-config.json` 里的 `feishu_base_url`,不弹选项框、不再交互(无人值守场景没法交互)。要换写入目标只能来首次配置入口重新走这一步。

### 4. 确保本地 Moka 登录态存在且有效

**登录态的定义就一个：**本地磁盘上有一份 Moka cookie 文件（`~/.opencli/mokaData/moka-cookies.json`,由 CLI 内部维护,Agent 只探存在性、不读文件内容)。**它和 CDP Chrome 是不是活着完全无关**——即使 Chrome 完全关闭,只要磁盘 cookie 文件在,`--offline` 采集就能跑;CDP 只是全模式切换校招/社招时才需要。所以本步骤只判断"cookie 文件在不在",CDP 的状态不参与决策。

**⚠️ 不要用 `opencli moka status` 来判断"本地是否有登录态"**——那条命令是探 CDP 连接和 Moka 页面可达性的,反映的是"CDP 活着且能访问 Moka",和"磁盘上 cookie 文件在不在"是两回事(即使 CDP 没连,只要磁盘 cookie 在,`--offline` 采集依然能跑)。本步骤专门用文件系统的存在性探测。

**第一步：对 cookie 文件做只读存在性探测**

只探存在性、不读文件内容、不 echo 路径或结果到对话/日志(红线 #1)。跨平台命令：

- Windows PowerShell：`Test-Path "$env:USERPROFILE\.opencli\mokaData\moka-cookies.json"`
- macOS / Linux / Git Bash：`test -f "$HOME/.opencli/mokaData/moka-cookies.json" && echo yes || echo no`

只取"存在 / 不存在"这一个布尔结果进入分支判断,**绝不 cat、Read、打印文件内容**。

**第二步：按存在性结果分支处理**

- **本地有 cookie 文件**(不论文件里的 cookie 是否已过期)：**不要**擅自跳过,也**不要**擅自拉 Chrome,用**选项框**让用户拍板:

  | 选项 | 后续行为 |
  |------|---------|
  | ✅ 使用现有登录态,跳过 CDP 登录（推荐） | 不打开 CDP Chrome,直接进入下一步选择采集模式;后面选默认模式完全用不上 Chrome,选全模式时到那一步再单独拉 |
  | 🔄 重新登录（换账号或强制刷新） | 走下面的"强制登录流程"(cookie 已过期时也走这条) |

  cookie 是否已过期,由后面的采集步骤在真实调用时暴露(采集报错 → 让用户手动回来走强制登录);本步不做"过期与否"的预判——那需要读文件内容,违反红线 #1。

- **本地无 cookie 文件**(首次配置,从未登录过)：**没有可选项**,必须走强制登录流程——唯一出路就是拉起 CDP 让用户扫码登录,不给"跳过"选项。

**强制登录流程**（仅在"本地无 cookie 文件",或用户在"本地有"分支主动选择重新登录时执行）：

```text
opencli moka login -f json
```

该命令打开使用独立用户数据目录的 CDP Chrome 并进入 Moka。告诉用户在这个窗口中完成登录，然后回复"登录好了"。到这里必须暂停并等待用户回复；不要索要账号、密码、验证码或 Cookie，也不要替用户登录。

用户回复完成后再对 cookie 文件做一次存在性探测(方法同第一步)确认已落盘。**必须**在本步骤退出前拿到一次"存在"结果,不能带着空目录进入下一步。

登录完成后 cookie 已落盘到 CLI 的 user data 目录。此时 Chrome 可以继续开着（后面选全模式时正好复用），也可以关掉（后面选默认模式时不需要，磁盘 cookie 仍然在）——不要在本步骤主动关闭 Chrome，交给下一步根据采集模式决定。

### 5. 选择采集模式并（可选）创建定时任务

本地登录态确认有效后，先问采集模式：

| 选项 | 说明 | 对 CDP 的要求 |
|------|------|---------------|
| 默认模式（推荐日常使用） | 只抓取当前 Moka 账号默认模式下的转写数据，采集期间**不需要 CDP 常驻**，Chrome 可完全关闭 | 采集时无需 Chrome 运行；靠磁盘 cookie 直接走 HTTP |
| 全模式（校招 + 社招） | 依次切换到校招模式和社招模式各导出一次，覆盖两类岗位 | 采集时**必须 CDP 常驻**——模式切换需要通过 DOM 点击完成 |

用户选择后：

- **选默认模式**：告知用户 Chrome 可以关闭（保留 user data 目录即可），随后进入下一步询问是否创建定时任务。
- **选全模式**：告知用户不能关闭当前 CDP Chrome，需要在后续定时任务运行期间保持 Chrome 进程存活；若 HR 关闭了它，全模式定时任务运行时会中断并提示。

无论选哪种模式，都问一次："是否创建对应的定时任务？"

- 用户选择否：简洁确认环境和登录已配置，结束。
- 用户选择是：再单独询问执行时机。接受"每隔 N 小时""每天 HH:mm""工作日每天 HH:mm"等自然语言。

将时间转换为 Cron；至少支持：

- 每隔 N 小时：`0 */N * * *`
- 每天 HH:mm：`mm HH * * *`
- 工作日每天 HH:mm：`mm HH * * 1-5`

若用户表达无法无歧义映射为 Cron，先澄清，不要猜测。创建前向用户复述时间和 Cron。

根据步骤开头的采集模式选择对应字段：

**默认模式**：

```text
任务名称：Moka转写抓取-默认模式
任务指令：定时任务，调用moka-transcript-getter skill，抓取今日默认模式转写。
Cron：<根据用户执行时机生成>
时区：Asia/Shanghai
执行 Agent：当前助手自身
```

**全模式**：

```text
任务名称：Moka转写抓取-全模式
任务指令：定时任务，调用moka-transcript-getter skill，抓取今日社招和校招所有转写。
Cron：<根据用户执行时机生成>
时区：Asia/Shanghai
执行 Agent：当前助手自身
```

使用宿主 Agent 的定时任务/自动化创建能力创建任务。只有工具明确返回创建成功后才能汇报成功；若当前宿主没有定时任务能力，明确说明无法创建，不要伪造结果。

若用户选择全模式且创建了定时任务，在最终汇报中额外提醒："全模式定时任务运行期间 CDP Chrome 必须保持开启，否则任务会中断"。

## 定时采集入口 · 默认模式

该入口面向无人值守运行，只抓取当前 Moka 账号默认模式下的转写数据。**不检测 CDP、不检查 Moka 登录态、不检查 lark-cli 授权**——首次配置入口已经确保这些落地了，进入本入口时默认它们仍然有效。**飞书 Base URL 直接从 `~/.opencli/moka-config.json` 的 `feishu_base_url` 字段读取,不弹选项框、不问用户——无人值守场景无法交互;要换写入目标必须回首次配置入口重新走。** 异常时（导出报未登录、写入报授权失败、config 里 `feishu_base_url` 缺失等）中断并汇报，让 HR 回到首次配置入口处理。

### 1. 覆盖导出今日全量 JSON

解析默认 JSON 的绝对路径，执行：

```text
opencli moka export-transcripts --offline --output "<绝对输出路径>" --overwrite -f json
```

`--offline` 跳过 CDP Chrome，直接用磁盘上的 Moka cookie 发 HTTP 请求，Chrome 关闭也能采集。`--overwrite` 覆盖旧文件，得到今天默认模式的全量 JSON。

若导出报错为"未登录 / 登录态失效"，中断本次采集，汇报"Moka 登录态失效，需要 HR 重新执行首次配置入口的登录步骤"，不要在定时任务里尝试自动打开 Chrome。

### 2. 共用后处理

导出成功后，走 [`## 共用后处理`](#共用后处理) 的四段流程（评分 + 报告 + artifact 发布 + 单次 sync + 去重）。汇总时**只汇报默认模式一份导出结果**，不区分校招/社招。

## 定时采集入口 · 全模式

该入口面向无人值守运行，依次抓取校招和社招两类岗位的转写数据。**依赖 CDP Chrome 常驻**——切换校招/社招模式必须通过 DOM 点击完成。不检查 lark-cli 授权和 Moka 登录态本身（首次配置入口已保证），但**必须检测 CDP 是否连接**——CDP 断开时直接中断。**飞书 Base URL 直接从 `~/.opencli/moka-config.json` 的 `feishu_base_url` 字段读取,不弹选项框、不问用户——无人值守场景无法交互;要换写入目标必须回首次配置入口重新走。**

### 1. 检测 CDP 是否可用

执行：

```text
opencli moka status -f json
```

- 输出包含 `mokaLogin: authenticated` 且 CDP 已连接：继续。
- CDP 未连接或 Chrome 已被关闭：**中断本次采集**，汇报"全模式定时任务需要 CDP Chrome 常驻，当前 Chrome 未运行；请 HR 重新执行 `opencli moka login` 拉起 CDP 后再等待下次触发"。**不要**在定时任务里尝试自动 `opencli moka login`——那会弹出 Chrome 窗口，无人值守场景下没有意义。
- Moka 登录态失效：中断并汇报"Moka 登录态失效，需要 HR 回到首次配置入口重新登录"。

lark-cli 授权失效的场景不在本步骤主动预检，交给 sync/dedup 脚本自然报错后中断。

**lark-cli 路径定位**：定时任务运行环境中 `lark-cli` 可能不在默认 PATH 中。若直接执行 `lark-cli` 失败，通过 `where lark-cli`（Windows）或 `which lark-cli`（macOS/Linux）定位真实可执行文件路径，后续所有 sync、dedup 等脚本调用都通过 `--lark-cli "<路径>"` 参数传递。不要修改用户的全局 PATH。

确认当前 Skill 目录存在 `scripts/sync-lark-base.mjs`、`scripts/deduplicate-lark-base.mjs`、`scripts/backfill-interviewer-user.mjs`、`scripts/inline-badge-icon.mjs`。飞书记录的写入由 sync 脚本执行，去重清理由 dedup 脚本执行，面试官(人员)回填由 backfill 脚本执行,报告 HTML 的 badge PNG base64 内联由 inline-badge-icon 脚本执行；Agent 禁止自行调用 `lark-cli base +record-upsert`、`+record-batch-create`、`+record-batch-update` 写面试转写表。HTML 报告不再走飞书云盘,改由当前 Claude 就地打包成自包含单文件 artifact 并发布,拿到公开 URL 后写入 `record.reviewReportUrl`。维护脚本时才读取 `references/lark-base-write.md`。

### 2. 校招：覆盖导出

依次执行：

```text
opencli moka mode campus -f json
opencli moka export-transcripts --output "<绝对输出路径>" --overwrite -f json
```

`opencli moka mode campus` 通过 CDP 执行 DOM 点击切换到校招模式——这是本入口需要 Chrome 常驻的唯一原因。若该命令报 CDP 断开或 DOM 元素找不到，中断并汇报。

`--overwrite` 保证 JSON 只包含本次校招结果，覆盖昨天遗留内容。**本步骤不写飞书**——校招 JSON 先落在 `<绝对输出路径>` 中,等社招合并后再一次性同步。

### 3. 社招：合并导出到同一 JSON

仅在校招导出成功后执行：

```text
opencli moka mode social -f json
opencli moka export-transcripts --output "<同一绝对输出路径>" -f json
```

**注意此处不传 `--overwrite`**——`export-transcripts` 默认行为是增量合并：以 `applicationId + interviewId` 为联合键，新记录追加,重复联合键覆盖旧值,校招 records 保留。合并完成后 `<绝对输出路径>` 里 records 数 = 校招条数 + 社招条数（去重后）。

若社招导出失败，保留当前 JSON，报告失败,便于人工排查;不得声称全流程成功。

### 4. 共用后处理

校招+社招合并后的 JSON 就位后，走 [`## 共用后处理`](#共用后处理) 的四段流程（评分 + 报告 + artifact 发布 + 单次 sync + 去重）。汇总时分别标注校招/社招导出条数、合并后总数。

## 共用后处理

两个定时入口在拿到「今天全量 JSON」后，共享以下四段流程。**只调一次 sync-lark-base.mjs、只调一次 deduplicate-lark-base.mjs**，避免旧全模式 sync 两次的问题。

### 后处理-1. 逐条评分并生成 HTML 报告

严格按 [`references/interviewer-review-workflow.md`](references/interviewer-review-workflow.md) 遍历 `<绝对输出路径>` 的 `records[]`:

- 跳过 `transcriptStatus !== "available"` 或 `transcript` 去空后为空的记录。
- 处理的记录:Agent 读逐字稿打 6 维分(精度 0.5,红线维度记 0) → 把评分数据传给 `generate-report.mjs`,脚本自动完成:写临时 txt → 跑 `transcript_stats.py` → 复制模板 → 替换全部 18 个 `{{TOKEN}}` → 跑 `inline-badge-icon.mjs` 把 PNG 换成 base64 data URI → 校验无残留 → 输出 HTML 路径。**禁止手写 HTML 片段、手写 JSON 配置、手写临时 Node 脚本来生成报告**。
- 评分/报告完成后,把六维分数和 `hallmarkBadge` / `redLineHits` 挂到 `record.reviewScores`(字段名见 workflow 文件),供下一步和 sync 消费。
- 单条评分失败: 记 `record.reviewError = "<简短原因>"`,不生成报告,不阻断整批。

**必须原样引用** `interviewer-review` 的脚本(transcript_stats.py)与模板(report-template.html);**严禁**自行改写打分算法或 HTML 模板结构。

### 后处理-2. 把 HTML 发布为自包含 artifact,回填 URL

对每条**已生成 HTML** 且已完成 badge base64 内联的 record:

- 当前 Claude 直接把 HTML 文件全文作为**自包含单文件 artifact 发布**,拿到公开访问 URL。**不走飞书云盘**——云盘上传不稳定,已经放弃。
- 发布前再校验一遍:HTML 里已经不含任何 `<img src="icon/`(全部替换为 data URL)、不含未替换的 `{{TOKEN}}`(header 注释里的字面量除外)。
- 成功: 把 URL 写入 `record.reviewReportUrl`。
- 失败: 记 `record.reviewError = "artifact publish failed: <简短原因>"`,`reviewReportUrl` 不写,该 record 的本地 HTML 保留供人工排查,继续下一条。

所有 record 处理完成后,把扩充了 `reviewScores` / `reviewReportUrl` / (可选)`reviewError` 的 records **只重写一次** 到 `<绝对输出路径>`(顶层 CollectionResult 的 `generatedAt` / `source` / `errors` / `stats` 保留原值)。

### 后处理-3. 单次批量写入飞书

```text
node "<Skill目录>/scripts/sync-lark-base.mjs" --input "<绝对输出路径>"
```

若 `lark-cli` 不在 PATH,追加 `--lark-cli "<路径>"`。

**成功判定**(缺一不可):

1. 退出码为 0
2. stdout JSON 的 `ok === true`
3. stdout JSON 的 `created === deduplicatedRecords`(所有去重后的 record 都写入了)
4. stdout JSON 的 `failed === 0`

**任何一条不满足**就必须在汇报里写"sync 未完全成功",并附上 `stats.errors` 或 stdout 中的失败详情(不含逐字稿正文)。**不要**因为 ok:true 就直接判定通过——旧脚本在有失败时会误报 ok:true,新脚本已收紧,但若字段缺失说明脚本还没更新。

sync 脚本自动带上「面试官复盘-开场与流程 / 提问质量 / 倾听 / 追问深度 / 尺度把控 / 反馈体验」6 列数值、「面试复盘报告」文本 URL 列,以及「是否标红」「是否已通知」两列单选状态——「是否标红」由 `reviewScores.redLineHits` 是否非空派生,命中红线写「是」、否则写「否」;「是否已通知」本流水线固定写「否」,后续通知动作由其他流程处理,不在本 skill 职责范围内。两个单选列必须写严格字面量「是」/「否」,不带空格、不改字符,飞书按选项名精确匹配。评分或 URL 缺失的 record 对应字段自动为空,不影响其他列。「处理状态」列本流水线不管。「面试官(人员)」列由后置的 `backfill-interviewer-user.mjs` 在 dedup 之后自动回填(见下文 后处理-5),失败时该列留空,不影响本步已写入的其他列。

「面试复盘报告」列**必须是文本或超链接类型**——若飞书 Base 上是附件类型,OpenAPI 不允许写附件单元格,整条 record 会被拒(实测走这个坑)。当前 Base 已经由用户手动改成文本列,直接写字符串 URL。

sync 脚本不查飞书是否已有记录,直接批量写入,重复交给下一步去重清理。若写入报错为 lark-cli 未授权或缺 scope,中断本次采集并汇报"飞书授权失效,需要 HR 重新执行首次配置入口的 lark-cli 授权步骤"。

**失败时的正确反应**:在汇报里如实说明失败原因,不重跑整个流水线,不删除任何飞书记录,不重装工具——交给 HR 判断。

### 后处理-4. 飞书去重清理

无论是否有重复都执行:

```text
node "<Skill目录>/scripts/deduplicate-lark-base.mjs"
```

去重规则:

- 面试转写表: 按「面试ID + 申请ID」联合键去重,**保留每组最新一条**(record_id 倒序遍历下先命中的一条),删除其余。
- **为什么保留最新**: 每天 sync 会追加当天带评分和 HTML URL 的新记录,如果保留最旧,反而会删掉刚生成的评分把无评分的旧记录留下。
- 面试ID 或申请ID 为 null 的空行跳过,不参与去重。

删除策略(关键设计):

- **逐条删除**: 脚本逐条调用 `lark-cli base +record-delete --record-id <id> --yes`,不使用批量删除接口。
- **不用 batch delete 的原因**: 飞书 batch delete 命令在实测中会静默失败(报错 `batch delete N records failed`),即使同一用户在同一张表上 `batch-create` 完全成功。这不是权限问题,是批量删除接口本身的限制或不稳定。
- **并发控制**: 默认 3 并发(可配 `--concurrency`),保守值防止飞书 API 限流。
- **独立反馈**: 每条删除都有独立的成功/失败反馈,某条失败不影响其他条目。

只有脚本退出码为 0 且输出 JSON 的 `ok == true` 才算去重成功。输出中 `deleted` 记录成功删除数,`failed` 记录失败数,`errors` 含失败详情。

去重失败不阻塞本次采集结果汇报,但在汇报中标注"去重未完成,需手动处理"并附上 `failed` 和 `errors` 信息。大多数失败是飞书 API 限流导致的暂时性问题,稍后重跑脚本即可恢复。

脚本自行清理 lark-cli 临时请求文件。Agent 不删除默认导出文件。

### 后处理-5. 回填「面试官(人员)」列

```text
node "<Skill目录>/scripts/backfill-interviewer-user.mjs"
```

若 `lark-cli` 不在 PATH,追加 `--lark-cli "<路径>"`。

**为什么放在 dedup 之后**: 先去重再回填,只处理留下的最新一条,不浪费 API 调用去填马上要被删的旧记录。

**脚本做什么**(4 步):

1. 拿「面试官」text 列 / 「面试官(人员)」user 列 / 「面试ID」三列的 field_id;人员列显示名支持半/全角括号与括号内外空格的容错匹配。
2. `+record-list --field-id ...` 按行投影拉全表,挑出「面试官 text 有值,但 面试官(人员) user 为空」的记录。
3. 建 `name → open_id` 映射:先从同表已填充记录里按顺序拆解(要求名字数量 = 人员数量,不匹配的行跳过);缺失的姓名再用 `lark-cli contact +search-user --query <name>` 兜底。
4. 逐条 `+record-upsert --record-id X --json {"面试官(人员)":[{id:openId}, ...]}`,默认 3 并发。

**成功判定**:退出码 0 且 stdout JSON `ok === true` 且 `failed === 0`。`unresolvedNames` 可以非空——`search-user` 找不到的姓名会挂在里面,不算 fatal,该 record 若还有其他姓名解析成功,人员列会**部分回填**;所有姓名都解析不上的 record 会归到 `skipped`,人员列继续留空。

**失败/部分失败时的处置**:回填失败**不阻塞本次采集结果汇报**,把 stdout 的 `unresolvedNames` 和 `errors` 摘要附到 后处理-6 汇总里,让 HR 判断是否人工补录。**不要**因为回填失败而重跑整个流水线,也不要重装工具或改脚本。

### 后处理-6. 汇总本次结果

不要在对话中输出 `transcript`、`evaluationSummary`、`questionAnalysis` 等长文本(逐字稿正文过长会挤爆对话上下文,不是隐私问题)。

每条本次处理的记录只汇报:

```text
候选人:<candidateName>｜面试官:<interviewerNames,以顿号连接;缺失时写"未记录">｜岗位:<jobTitle>｜复盘:<有|无|失败>
```

姓名原文直接汇报,不做处理——本 skill 的数据源是 HR 自己登录 Moka 后台采集,写入的是 HR 自己配置的飞书 Base,同租户内已授权。手机号、邮箱、身份证号仍不出现在对话摘要里(那些不是姓名字段)。

最后汇报:

- 校招、社招分别是否导出成功、合并后总条数(默认模式入口只汇报默认模式一份)
- 本次评分成功/失败/跳过的记录数,HTML artifact 发布成功/失败数
- 新增面试记录数、batch-create 是否降级
- 去重结果: 面试转写表删除数/失败数
- 面试官(人员)回填结果: `backfilled` / `skipped` / `failed`,若有 `unresolvedNames` 逐个列出(仅姓名,不带 open_id)
- 上述每条简要信息
- JSON 的绝对保存路径
- 飞书 Base 链接
- 若有错误,列出阶段和简短错误原因

不要汇报逐字稿正文或红线原文(长文本挤对话)。评分细节可以直接说。没有今日记录时明确说"今日没有可导出的面试记录",仍报告采集状态、JSON 路径和 Base 链接。

## 成功路径 Runbook(定时任务作业模板)

以下是**一次成功的定时任务**从头到尾的骨架命令。**变更任何一步之前先对着这里核对**——真实定时任务的问题基本都是偏离了这套骨架。

**共同前置**(每次入口第一件事就做,不能省):

1. 解析并保存 Skill 绝对路径:所有后续命令用 `<Skill目录>/scripts/xxx.mjs`,**不用**相对路径 `scripts/xxx.mjs`(宿主 shell 的 cwd 不在 skill 目录)。
2. 解析 lark-cli 绝对路径:Windows `where lark-cli`,macOS/Linux `which lark-cli`。所有 `.mjs` 都追加 `--lark-cli "<路径>"`。
3. Windows 上执行 Node/Python 前设 `chcp 65001` 并注入 `PYTHONIOENCODING=utf-8`。禁止在 PowerShell 里用 `&&` 串命令,一行一条。
4. **禁止 Agent 直接调 `lark-cli` 写入/上传/删除**。只允许调 skill 自带的 `.mjs` 包装脚本——它们已经内嵌了字段类型兼容、@file 相对路径、失败降级、错误汇总。

**默认模式骨架**:

```text
# 1. 覆盖导出
opencli moka export-transcripts --offline --output "<PATH>" --overwrite -f json

# 2. 遍历 records[] 评分 + 生成报告(generate-report.mjs 一键完成) + 发布 artifact + 回填 JSON
#    Agent 读逐字稿打分,把 scores/highlights/improves/advice 传给脚本
node "<Skill目录>/scripts/generate-report.mjs" \
  --json "<PATH>" --interview-id "<id>" \
  --scores-file "<scores.json>" --badge-line "..." \
  --highlights-file "<highlights.json>" --improves-file "<improves.json>" --advice-file "<advice.json>"

# 3. 单次批量写入(整个流水线只调一次)
node "<Skill目录>/scripts/sync-lark-base.mjs" --input "<PATH>" --lark-cli "<lark-cli 绝对路径>"

# 4. 去重(保留最新)
node "<Skill目录>/scripts/deduplicate-lark-base.mjs" --lark-cli "<lark-cli 绝对路径>"

# 5. 回填「面试官(人员)」列(dedup 之后, 只填留下的最新一条)
node "<Skill目录>/scripts/backfill-interviewer-user.mjs" --lark-cli "<lark-cli 绝对路径>"
```

**全模式骨架**:

```text
# 1. CDP 自检
opencli moka status -f json

# 2. 校招覆盖(不 sync)
opencli moka mode campus -f json
opencli moka export-transcripts --output "<PATH>" --overwrite -f json

# 3. 社招合并(不加 --overwrite,不 sync)
opencli moka mode social -f json
opencli moka export-transcripts --output "<PATH>" -f json

# 4~7 = 默认模式 2~5
```

**成功判定**(每一步必须核对,不能只看"命令有输出"):

| 步骤 | 判定 |
|---|---|
| export-transcripts | 退出码 0 且 JSON 顶层 `ok:true` 且 `records.length > 0`(为 0 时汇报"今日无记录",不算失败) |
| generate-report.mjs | 退出码 0 且 stdout JSON `ok:true` 且 `remainingTokens === 0` 且 `hasIconSrc === false` |
| artifact 发布 | 拿到 `https://` 开头的公开 URL 且 HTML 里已完成 badge PNG base64 内联(不再依赖外部 `icon/`) |
| sync-lark-base.mjs | 退出码 0 且 stdout JSON `ok:true` **并且** `created === deduplicatedRecords` **并且** `failed === 0`。**旧版本 sync 会在有失败时误报 ok:true,新版本已收紧;若字段缺失说明脚本没更新。** |
| deduplicate-lark-base.mjs | 退出码 0 且 stdout JSON `ok:true`(失败不阻塞汇报,但要在汇总里带上 `failed`/`errors`) |
| backfill-interviewer-user.mjs | 退出码 0 且 stdout JSON `ok:true` 且 `failed===0`。`unresolvedNames` 可以非空(search-user 找不到的姓名),`skipped` 也可以非空(所有姓名都解析不上的 record),都不算 fatal;把摘要附到汇总即可 |

## 错误速查表(先查表,不要瞎猜)

以下是定时任务实跑踩过的坑,按现象直接对到根因和处置。**看到就照单执行,不要临场发挥。**

### 数据读取阶段

| 现象 | 根因 | 处置 |
|---|---|---|
| `grep "candidateName" transcript.json` 返 0 行,但文件明明有数据 | Grep 工具跨大 JSON 命中窗口有限 | 换 `node -e "console.log(Object.keys(JSON.parse(require('fs').readFileSync(...))))"` 或 `python -c "import json; print(...)"`,不要靠 grep 探大 JSON 结构 |
| `Read` 大 JSON 被截断,后半段拿不到 | 单次 Read 有行数上限 | 不要用 Read 全量看大 JSON;结构化查询用 `node -e` / `python -c`,只查关键字段 |

### 脚本执行阶段

| 现象 | 根因 | 处置 |
|---|---|---|
| `python transcript_stats.py` 报 `UnicodeDecodeError` / stdout 空 | Windows 默认 GBK,脚本 stdout 是 GBK,Python 强解 UTF-8 崩 | 执行前 `chcp 65001`;或在 spawn 时设 `PYTHONIOENCODING=utf-8`。**skill 内的 .mjs 已经处理**,只有 Agent 手动调 Python 才踩 |
| `python -c "f'{...}'"` 单行崩 SyntaxError | PowerShell 引号转义与 Python f-string 冲突 | **禁止 `python -c` 单行运行任何含 f-string 或多语句的代码**;写到 `.py` 临时文件再跑 |
| `node "scripts/xxx.mjs"` 找不到脚本 | 宿主 execScript 的 cwd 不在 skill 目录 | **一律用绝对路径** `node "<Skill目录>/scripts/xxx.mjs"`。共同前置第 1 步就是干这个的 |
| 手误 `D:` 打成 `E:` | 无 | 每一次 execScript 之前肉眼核对盘符 |

### Artifact 发布阶段

| 现象 | 根因 | 处置 |
|---|---|---|
| 报告文件名带 `**` 或中文,`Errno 22 Invalid argument` | Windows 文件名禁用 `**`,中文在部分 Node/Python 版本上编码不稳 | 报告/临时文件名**只用 ASCII**:`review-<interviewId>.html`、`transcript-<interviewId>.txt`。候选人姓名放在 **HTML 内容里**即可,不进文件名(纯技术原因,不是脱敏要求) |
| 打开 artifact URL 后 badge 图标是"图片破损" | 生成 HTML 时忘了调 `inline-badge-icon.mjs`,`<img src="icon/xxx.png">` 没被换成 `data:image/png;base64,...` | artifact 是自包含单文件,取不到旁边的 `icon/` 目录。**必须**在发布前跑 `node "<Skill目录>/scripts/inline-badge-icon.mjs" --file "<HTML>"`;**不要**用 Read + 手工拼 base64——Read 拿到的是图像内容,不是 base64 文本,历史踩坑就是这个 |
| HTML 里残留 `{{TOKEN}}` | 有 token 未替换 | 发布前 grep `{{[A-Z_]+}}`,除模板 header 注释里的字面量,不应有剩余;有剩余就补齐再发布 |

### Base 写入阶段(最容易掉链子)

| 现象 | 根因 | 处置 |
|---|---|---|
| `sync-lark-base.mjs` 输出 `ok:true` 但 `created === 0` 或 `failed > 0` | 旧脚本 ok 语义太宽;新脚本已收紧为 "created==deduplicatedRecords && failed==0" | **必须核对 `created`/`failed`/`deduplicatedRecords` 三个字段**,不能只看 ok。有 failed 直接把 `errors` 抄进汇报,不重跑,交给 HR |
| 每条 record `operation:"failed"` | 通常是某个列类型不匹配 | 打开 stdout 中的 `errors[].message`;若报"字段类型不匹配",跑 `lark-cli base +field-list --base-token <a> --table-id <t> --as user -f json` 查实际类型对比 `references/lark-base-write.md` |
| 「面试复盘报告」列写入报错 | 该列曾是附件类型(OpenAPI 不能写附件) | 用户已手动改为**文本列**。若飞书 Base 上又改回附件,skill 会再度失败:去 Base 把该列改回**文本或超链接**类型,不要改 sync 脚本 |
| `+record-batch-create` 全部失败降级 upsert 仍失败 | 一般是同一个字段类型不匹配问题 | 同上,先 `+field-list` 诊断,不要重跑 |
| `+record-update` / `+record-batch-update` 命令不存在 | lark-cli 里根本没这个动词 | 只用脚本封装好的 `+record-batch-create` / `+record-upsert` / `+record-delete`。**动手前先 `lark-cli base --help` 查一下动词是否存在** |
| dedup 删除了带评分的新记录,留下无评分旧记录 | 旧脚本按顺序保留"第一条"(=最旧) | 新脚本已改成**倒序保留最新一条**。若又踩到,确认 dedup 脚本里 `deduplicateTranscripts` 是倒序遍历 |
| dedup 输出 `ok:true` 但 sync 后飞书上仍有重复 | 飞书 record-list 的顺序不稳定 | 目前依赖 `record-list` 默认顺序,若飞书改了默认顺序需要改成显式按 `created_time` 排序——追加 `--sort-by created_time` 或类似参数 |

### 工具选择

| 现象 | 根因 | 处置 |
|---|---|---|
| `lark-cli.cmd` 直接调,中文字段名走 `\uXXXX` 转义后 field_not_found | Windows 命令行 UTF-8 传参编码链条太脆 | **禁止 Agent 直接调 lark-cli 写数据**。所有写入/删除/上传统一走 skill 提供的 `.mjs` 脚本;它们已经封好了编码、@file、字段兼容 |
| Python `subprocess.run(lark_cli, encoding='utf-8')` stdout 是空的 | lark-cli 输出是 GBK,Python 强解 UTF-8 报错并把 stdout 吞了 | 别自己起 Python 调 lark-cli;直接调本 skill 的 `.mjs`(内部用 `spawn` + `setEncoding('utf8')` 已经处理) |

### 汇报

| 现象 | 处置 |
|---|---|
| 汇总时说"sync 全部成功",但实际每条都 failed | **必须**看 `created`/`failed`/`deduplicatedRecords` 三个字段。 `ok:true` 是必要非充分条件 |

## Agent 自查清单(每次入口开跑前默念)

进入任一定时入口前,**必须**在心里过一遍下面这份清单;违背任何一条基本都会踩坑:

- [ ] Skill 绝对路径已解析,后续 `.mjs` 全部用绝对路径调用。
- [ ] lark-cli 绝对路径已解析,所有 `.mjs` 都追加 `--lark-cli "<绝对路径>"`。
- [ ] **不直接调 `lark-cli`** 写入、删除——只调 skill 提供的 5 个 `.mjs`(generate-report / inline-badge-icon / sync / dedup / backfill-interviewer-user)。HTML 报告不再走飞书云盘,改为当前 Claude 就地发布 artifact;`generate-report.mjs` 内部已自动调 `inline-badge-icon.mjs`。
- [ ] Windows 上已 `chcp 65001`,Python 子进程环境含 `PYTHONIOENCODING=utf-8`。
- [ ] 报告与临时文件名**只用 ASCII**(`review-<id>.html`、`transcript-<id>.txt`),姓名放在 HTML 内容里(纯技术兼容要求,不是脱敏)。
- [ ] 大 JSON 结构探查用 `.cjs` 脚步文件,不用 `grep` / `Read` / `node -e` / `python -c` 硬碰。
- [ ] sync 判成功用 `ok:true && created===deduplicatedRecords && failed===0`,不是只看 `ok`。
- [ ] 单次流水线**只调一次** sync-lark-base.mjs,不为校招/社招各调一次。
- [ ] backfill-interviewer-user.mjs 在 dedup 之后执行,失败/`unresolvedNames`不阻塞汇报,把摘要附到汇总即可。
- [ ] 出现任何写入失败**不重跑整个流水线**——把 `errors` 附到汇总,让 HR 决定。



- 只访问当前登录账号有权查看的数据。
- 不使用 mitmproxy 完成日常采集；不要求用户提供抓包或凭证。
- 不把 JSON 数据文件写进插件仓库或 Skill 目录。
- 只把候选人数据写入本 Skill 固定配置的飞书 Base；不上传或发送到其他位置。
- 对话汇报、自动化摘要、错误信息和调试日志中**不要输出**手机号、邮箱、身份证号或逐字稿正文。候选人及面试官**姓名可直接原文使用**——数据源是授权 HR 采集,姓名不做处理。
- 不因定时任务失败而重新安装工具、删除 Chrome Profile、删除飞书记录或清空 Base。
- 不直接重试脚本内部失败的写入操作；重新运行整个脚本即可。
- sync 脚本不保证无重复——重复由 dedup 脚本统一清理。
- dedup 脚本使用逐条删除（`+record-delete --record-id`），不使用 batch delete 接口——后者在实测中会静默失败。
- 不写入或维护面试官信息表（已废弃）；面试官姓名作为 text 写入面试转写表的「面试官」列，dedup 之后由 `backfill-interviewer-user.mjs` 通过 `contact +search-user` 解析出 open_id 回填「面试官(人员)」user 列。
- 默认 JSON 是单次中转文件，不承担历史存储。
