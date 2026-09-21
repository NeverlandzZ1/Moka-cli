---
name: moka-transcript
description: 为 HR 配置并运行 Moka 面试转写采集并写入飞书多维表格。用于用户明确调用 moka-transcript、要求安装 Node.js/OpenCLI/lark-cli/Moka 插件并登录授权，或收到"定时任务，调用moka-transcript skill，抓取今日默认模式转写。"或"定时任务，调用moka-transcript skill，抓取今日社招和校招所有转写。"时；支持环境安装、Moka CDP 登录、本地登录态持久化、飞书用户授权、可选创建默认模式(纯 HTTP、无需 CDP 常驻)或全模式(需 CDP 常驻切换校招/社招)的定时任务并批量写入飞书 Base 后自动去重。
---

# Moka Transcript

只处理用户有权访问的 Moka 和飞书数据。首次登录及全模式切换使用本机 CDP Chrome；默认模式采集使用 CLI 持久化的登录态走纯 HTTP，并通过 lark-cli 用户身份写入飞书 Base。

**凭证边界**：
- Agent 层（对话回复、日志摘要、错误信息、临时文件名、脚本 stdout）**不得读取、复制、回显或持久化**任何 Cookie、JWT、access token、密码、验证码。
- CLI 插件（`opencli moka`）**内部**为了支持默认模式定时任务在 Chrome 被关闭时也能采集，允许把 Moka 应用与 Passport 登录 cookie 明文落盘到 `~/.opencli/mokaData/moka-cookies.json`（仅当前 OS 用户账户可读）。应用 session 失效时，插件会用同一文件中的 Passport cookie 走 ticket + uniLogin 静默续期并写回新 cookie；全程无需 CDP。该文件由 CLI 内部读写，Agent 不得读取、cat、上传、转发或在对话/日志中回显该文件内容。

## 路由

根据请求选择且只执行一个入口：

1. 用户要求"配置环境并登录"或同义表达：执行"首次配置入口"。
2. 请求内容为或明确表达"定时任务，调用moka-transcript skill，抓取今日默认模式转写。"：执行"定时采集入口 · 默认模式"。
3. 请求内容为或明确表达"定时任务，调用moka-transcript skill，抓取今日社招和校招所有转写。"：执行"定时采集入口 · 全模式"。

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
- 定时任务指令（默认模式）：`定时任务，调用moka-transcript skill，抓取今日默认模式转写。`
- 定时任务名称（全模式）：`Moka转写抓取-全模式`
- 定时任务指令（全模式）：`定时任务，调用moka-transcript skill，抓取今日社招和校招所有转写。`
- 时区：`Asia/Shanghai`
- 执行 Agent：`当前助手自身`
- 飞书 Base：首次配置时由用户提供（支持新建、指定或使用已有配置），存入 `~/.opencli/moka-config.json` 的 `feishu_base_url` 字段；后续从该配置读取
- 飞书同步脚本：`scripts/sync-lark-base.mjs`（内置 Windows 命令行长度保护：JSON > 3000 字符时自动切换为 `@./file.json` 临时文件模式）
- 已通知预筛脚本：`scripts/filter-notified-records.mjs`（只读 Base；在评分前按「申请ID + 面试ID」过滤 `是否已通知=是` 的记录）
- 飞书去重脚本：`scripts/deduplicate-lark-base.mjs`（逐条删除策略，非 batch delete；同样内置 @file 保护）
- 面试官(人员)回填脚本：`scripts/backfill-interviewer-user.mjs`（dedup 之后运行,用「面试官」text 列 + 同表已有映射 + `contact +search-user` 兜底,把姓名解析为 open_id 写入「面试官(人员)」user 列；**已修复两个 Windows 兼容问题**：① `search-user` 从括号中提取中文名搜索,避免空格导致位置参数错误；② `runLarkCli` 对所有 JSON payload 强制走 `@file` 模式,避免中文字段名在 cmd.exe 编码链路中被破坏）
- 脚本契约：`references/lark-base-write.md`
- 定时报告引擎（必需的独立 skill）：`interviewer-review`。它是评分规范、统计、渲染、校验与 HTML 模板的**唯一真源**；本 skill 不保留副本，不得降级回手写 HTML 或旧 `generate-report.mjs`。
- 定时报告云盘目录：`https://trip.larkenterprise.com/drive/folder/NY5IfFoh5lQmIaddwoSc6oJznBc`，folder token 为 `NY5IfFoh5lQmIaddwoSc6oJznBc`。报告上传后使用飞书返回的真实文件 URL 写入 `record.reviewReportUrl`。

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

**本步骤对登录态只做一个安全判断：**本地磁盘是否有 Moka cookie 文件（`~/.opencli/mokaData/moka-cookies.json`,由 CLI 内部维护,Agent 只探存在性、不读文件内容)。**它和 CDP Chrome 是不是活着完全无关**——即使 Chrome 完全关闭,只要磁盘 cookie 文件存在,`--offline` 就会先尝试现有应用 session，失效时再自动使用 Passport cookie 静默续期；CDP 只是首次登录和全模式切换校招/社招时需要。所以本步骤只判断"cookie 文件在不在",CDP 的状态不参与决策。

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
  | ✅ 使用现有登录态,跳过 CDP 登录（推荐） | 不打开 CDP Chrome,直接进入下一步选择采集模式；默认模式会在需要时自动用 Passport cookie 静默续期，选全模式时到那一步再单独拉 CDP |
  | 🔄 重新登录（换账号或强制刷新） | 走下面的"强制登录流程"(cookie 已过期时也走这条) |

  cookie 是否仍能续期,由后面的真实采集验证：应用 session 失效不算失败，CLI 会先自动走 Passport ticket + uniLogin；只有 Passport 也失效、被服务端撤销或文件不完整时，才让用户手动回来走强制登录。本步不读取 cookie 内容做预判，遵守红线 #1。

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
任务指令：定时任务，调用moka-transcript skill，抓取今日默认模式转写。
Cron：<根据用户执行时机生成>
时区：Asia/Shanghai
执行 Agent：当前助手自身
```

**全模式**：

```text
任务名称：Moka转写抓取-全模式
任务指令：定时任务，调用moka-transcript skill，抓取今日社招和校招所有转写。
Cron：<根据用户执行时机生成>
时区：Asia/Shanghai
执行 Agent：当前助手自身
```

使用宿主 Agent 的定时任务/自动化创建能力创建任务。只有工具明确返回创建成功后才能汇报成功；若当前宿主没有定时任务能力，明确说明无法创建，不要伪造结果。

若用户选择全模式且创建了定时任务，在最终汇报中额外提醒："全模式定时任务运行期间 CDP Chrome 必须保持开启，否则任务会中断"。

## 定时采集入口 · 默认模式

该入口面向无人值守运行，只抓取当前 Moka 账号默认模式下的转写数据。**不检测 CDP、不主动读取或检查 Moka cookie 内容、不检查 lark-cli 授权**——`opencli moka` 会在真实请求中验证应用 session，并在需要时自动通过 Passport 静默续期。**飞书 Base URL 直接从 `~/.opencli/moka-config.json` 的 `feishu_base_url` 字段读取,不弹选项框、不问用户——无人值守场景无法交互;要换写入目标必须回首次配置入口重新走。** 只有自动续期也失败、写入报授权失败或 config 里 `feishu_base_url` 缺失等异常才中断并汇报，让 HR 回到首次配置入口处理。

### 1. 覆盖导出今日全量 JSON

解析默认 JSON 的绝对路径，执行：

```text
opencli moka export-transcripts --offline --output "<绝对输出路径>" --overwrite -f json
```

`--offline` 跳过 CDP Chrome，直接用磁盘上的 Moka cookie 发 HTTP 请求，Chrome 关闭也能采集。若应用 session 已失效，CLI 会自动使用同一文件里的 Passport cookie 获取 ticket、调用 uniLogin、写回新 session 并重试原请求。`--overwrite` 覆盖旧文件，得到今天默认模式的全量 JSON。

若命令最终仍报"Passport 登录态无法换取 ticket / 应用会话和 Passport 登录态均无法恢复 / 登录态失效"，说明 CLI 已经尝试过静默续期但 Passport 本身也过期、被服务端撤销，或 cookie 文件不完整。此时中断本次采集，汇报"Moka Passport 登录态无法自动恢复，需要 HR 重新执行首次配置入口的登录步骤或替换完整 moka-cookies.json"，不要在定时任务里尝试自动打开 Chrome，也不要由 Agent 读取或拼装 cookie。

### 2. 共用后处理

导出成功后，走 [`## 共用后处理`](#共用后处理) 的七段流程（已通知预筛 + 原版报告引擎 + 飞书云盘上传 + 单次 sync + 去重 + 人员回填）。汇总时**只汇报默认模式一份导出结果**，不区分校招/社招。

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

确认当前 Skill 目录存在 `scripts/sync-lark-base.mjs`、`scripts/deduplicate-lark-base.mjs`、`scripts/backfill-interviewer-user.mjs`，且宿主已安装可访问的 `interviewer-review` skill。飞书记录的写入由 sync 脚本执行，去重清理由 dedup 脚本执行，面试官(人员)回填由 backfill 脚本执行；Agent 禁止自行调用 `lark-cli base +record-upsert`、`+record-batch-create`、`+record-batch-update` 写面试转写表。HTML 必须由 `interviewer-review` 生成并上传到固定飞书云盘目录，返回 URL 写入 `record.reviewReportUrl`。维护 Base 脚本时才读取 `references/lark-base-write.md`。

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

校招+社招合并后的 JSON 就位后，走 [`## 共用后处理`](#共用后处理) 的七段流程（已通知预筛 + 原版报告引擎 + 飞书云盘上传 + 单次 sync + 去重 + 人员回填）。汇总时分别标注校招/社招导出条数、合并后总数。

## 共用后处理

两个定时入口在拿到「今天全量 JSON」后，共享以下七段流程。**只调一次 sync-lark-base.mjs、只调一次 deduplicate-lark-base.mjs**，避免全模式重复写入。

### 后处理-0. 已通知记录预筛（必须先执行）

在调用 `interviewer-review` 前，先执行：

```text
node "<Skill目录>/scripts/filter-notified-records.mjs" --input "<绝对输出路径>"
```

若 `lark-cli` 不在 PATH，追加 `--lark-cli "<路径>"`。

该脚本只读目标 Base 的「申请ID」「面试ID」「是否已通知」三列：本次 JSON 中任一 record 只要与 Base 内一行的 **申请ID 和面试ID都相同**，且该行「是否已通知」严格为「是」，便从 JSON 的 `records[]` 直接移除。被移除的 record **不得**进入评分、HTML 渲染、Drive 上传、sync、dedup 或人员回填；这是防止通知工作流对同一面试再次发信的第一道保护。

- 以脚本 stdout 的 `skippedAlreadyNotified` 作为本次预筛跳过数；`remainingRecords` 为后续唯一允许处理的 records 数。
- `申请ID` 或 `面试ID` 缺失的 record 不匹配任何已通知记录，保留并按原流程处理。
- Base 缺少任一所需字段、lark-cli 查询失败、或脚本输出 `ok !== true` 时，**立即中断本次定时任务**；不得跳过预筛、不得依赖后置 dedup 补救。
- 预筛只在两个定时入口执行。普通配置入口不读取 Base 历史记录，也不调用本脚本。

### 后处理-1. 调用原版 `interviewer-review` 生成并校验本地 HTML

这是定时任务的**唯一**报告生成路径。先定位已安装的 `interviewer-review` skill；若宿主未安装、当前 Agent 无法读取其 `SKILL.md`、或其 `scripts/transcript_stats.py` / `render_report.py` / `validate_report.py` / `assets/report-template.html` 缺失，则中断本次任务，明确报“interviewer-review 报告引擎不可用”，不得改用旧生成器、手写 HTML 或简化模板。

遍历已完成后处理-0 预筛的 `<绝对输出路径>` 的 `records[]`：

- 跳过 `transcriptStatus !== "available"` 或 `transcript` 去空后为空的记录。
- **批量执行策略**：多条记录时，可将"读逐字稿 → 统计(`transcript_stats.py`) → 分析 → 写 `analysis.json`"分派给子代理**并行**处理，每条一个子代理。但 `render_report.py` + `validate_report.py` + 修错重试由本 Agent **串行**执行——渲染校验是确定性脚本调用，串行跑只需一两分钟，且修错时 Agent 对校验器报错模式已熟悉，效率更高。子代理返回后**必须检查 `analysis.json` 是否存在且内容完整**（含 `radar`、`highlights`、`improvements`、`evidence_turn_indices`）；空结果或缺失文件时自行接管该条的全链路，不停顿。
- 对每条处理记录，按 `interviewer-review/SKILL.md` 和其 `references/` 完成：逐字稿统计 → 阅读逐字稿 → 产出符合 `report-contract.md` 的 `analysis.json` → 调用**原版** `render_report.py` → 调用**原版** `validate_report.py`。
- **脚本和模板必须通过 `execScript` 调用**（`execScript` 会自动提供 skill 资源并以 skill 目录为 cwd）。不要用 `runCommand` + 本地绝对路径绕过——本地可能存在多个 skill 副本，版本不可靠。遇到 Windows PowerShell `&&` 报错时用 `cmd /c` 或 `;` 替代，不要切换工具。
- 时间戳倒退不再阻断报告生成：`transcript_stats.py` 现在用 `raw_ts`（绝对时间）作为 `display_ts`，时间线倒退不再报 warning，`span.valid` 始终为 `true`，不需要前置检查。
- **面试官说话人绑定**：Moka 的 `interviewerNames` 是展示姓名（如 `Jiahui Ji （季家晖）`），但转录里的 speaker 标签可能是缩写/昵称（如 `J`、`GYF`、`小雨`）。先拿 Moka 展示姓名跑一次统计，若 `binding_warnings` 非空，需从 `stats.speakers` 的 keys 里找到提问最多（`questions` 最高）的说话人作为面试官标签，用该标签重新跑统计，直到 `binding_warnings` 为空。`interviewer_speakers` 必须写转录统计 JSON 中存在的 speaker 标签，不是 Moka 展示姓名。
- 原始字段映射固定为：`candidateName → metadata.candidate`，`interviewerNames（按「、」连接）→ metadata.interviewer`，`jobTitle → metadata.position`，`roundName → metadata.round`，`startTime → metadata.date`，`transcript → 统计输入`。候选人和面试官展示姓名必须直接取 record 的结构化字段，**不得**从转录内容猜测。`interviewer_speakers` 则必须使用统计结果中出现的 speaker 标签，只用于角色绑定、KPI 与证据校验，不得用真实展示姓名替代。
- 只有校验退出码为 0 的 HTML 才能进入上传阶段。生成报告一律写入 `<transcript.json 所在目录>/reports/面试复盘报告-<面试官>-<候选人>.html`；面试官与候选人使用上述 record 真名，遇到 Windows 非法文件名字符 `\\ / : * ? " < > |` 时替换为安全字符，空值写“未记录”。
- 从 `analysis.json.radar` 写入 `record.reviewScores`：`openingFlow`、`questionQuality`、`listening`、`followUpDepth`、`scaleControl`、`feedbackExperience`；同时写入 `redLineHits`（由已确认 `redlines` 派生），以保持现有 Base 字段契约不变。
- 单条评分、渲染或校验失败：写 `record.reviewError = "interviewer-review failed: <简短原因>"`，保留本地中间文件供排查，不阻断其他记录。

### 后处理-2. 上传校验通过的 HTML 到飞书云盘并写回 URL

对每条已通过原版校验的 HTML：

- 使用 lark-cli **user 身份**上传到固定 folder token `NY5IfFoh5lQmIaddwoSc6oJznBc`。先确认当前用户具有 Drive 上传权限；缺少 Drive scope 时中断并汇报“飞书 Drive 授权失效，需要在首次配置入口补充 Drive 用户授权”，定时任务中不得发起交互授权。
- 用 `drive +upload` 上传本地 HTML。因 lark-cli 文件参数只允许 cwd 内的相对路径，先将 cwd 切换到报告文件所在目录，再传 `--file ./面试复盘报告-<面试官>-<候选人>.html --folder-token NY5IfFoh5lQmIaddwoSc6oJznBc --as user`。逐份**串行**上传到同一目录，不并发上传。
- 仅使用飞书上传成功响应返回的真实、可访问 URL 写入 `record.reviewReportUrl`；绝不拼接或猜测 URL。若响应没有可用 URL，视为上传失败，不写 URL。
- 上传失败：写 `record.reviewError = "drive upload failed: <简短原因>"`，保留本地 HTML，继续下一条。不得把报告上传到其他目录。
- **上传成功后立即转移 owner**：每份 HTML 上传成功后，立即调用 `drive permission.members transfer_owner` 把 owner 转给 HR 指定接收人（固定 open_id: `ou_0f7d6f3c5c579945fae70cb2348e6091`，即 Julia Tian（田颖），tianying@trip.com）。参数固定：`--params '{"token":"<file_token>","type":"file","remove_old_owner":false,"old_owner_perm":"full_access","need_notification":false}' --data '{"member_type":"openid","member_id":"ou_0f7d6f3c5c579945fae70cb2348e6091"}' --yes --as user`。`remove_old_owner=false` 保留上传者 full_access，`need_notification=false` 不打扰接收人。转移失败不阻塞该条记录（URL 已写入），但在汇报中标注"owner 转移失败"让 HR 手动处理。

所有 record 处理完成后，把扩充了 `reviewScores` / `reviewReportUrl` / (可选)`reviewError` 的 records **只重写一次** 到 `<绝对输出路径>`；顶层 `generatedAt` / `source` / `errors` / `stats` 保留原值。

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

- 面试转写表: 按「面试ID + 申请ID」联合键去重。若组内有「是否已通知=是」，优先保留已通知行（多个已通知行时保留其中最新一条）；只有全为「否」时才保留最新一条。
- 预筛已经避免把已通知面试再次写入；本步骤仍保留该优先级，作为 Base 历史重复数据的安全兜底，绝不能让新写入的「否」覆盖已通知的「是」。
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
4. 逐条 `+record-upsert --record-id X --json @./payload-file.json`,默认 3 并发。

**Windows 兼容修复**(2026-09-14 验证通过,已写入脚本):

- **`search-user` 查询词提取中文名**:Moka 导出的面试官姓名格式为 `Iris Cheng （程冬芳）`,直接传给 `--query` 会因空格被 lark-cli 拆成位置参数报错。脚本现在从括号中提取中文名(如 `程冬芳`)搜索,避免空格问题。无括号时提取连续中文字符。
- **`runLarkCli` 强制走 @file 模式**:所有 JSON payload(含中文字段名如 `面试官 (人员 )`)一律写入临时文件用 `@./file.json` 引用,不走命令行内联。Windows `spawn` + `shell:true` 会经过 cmd.exe 编码链路,把 UTF-8 中文字段名转成 GBK 导致 `invalid character` 解析错误。

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

- 校招、社招分别是否导出成功、合并后总条数(默认模式入口只汇报默认模式一份)，以及因「是否已通知=是」预筛跳过数
- 本次评分成功/失败/跳过的记录数，HTML Drive 上传成功/失败数
- 新增面试记录数、batch-create 是否降级
- 去重结果: 面试转写表删除数/失败数
- 面试官(人员)回填结果: `backfilled` / `skipped` / `failed`,若有 `unresolvedNames` 逐个列出(仅姓名,不带 open_id)
- 上述每条简要信息
- JSON 的绝对保存路径
- 飞书 Base 链接
- 若有错误,列出阶段和简短错误原因

不要汇报逐字稿正文或红线原文(长文本挤对话)。评分细节可以直接说。没有今日记录时明确说"今日没有可导出的面试记录",仍报告采集状态、JSON 路径和 Base 链接。

## 成功路径 Runbook(定时任务作业模板)

以下是一次成功的定时任务骨架。定时提示词只需调用本 skill；报告阶段由本 skill 强制调用 `interviewer-review`，不需要也不得在定时提示词中再选第二个 skill。

1. 解析本 skill 与 `interviewer-review` 的绝对目录，确认后者的原版 `SKILL.md`、统计、渲染、校验和模板均存在。
2. 定位 lark-cli；Windows 上设 `chcp 65001` 与 `PYTHONIOENCODING=utf-8`。
3. 默认模式执行 `opencli moka export-transcripts --offline --output "<PATH>" --overwrite -f json`；全模式依次 CDP 自检、校招覆盖、社招合并，期间不写飞书。
4. 先运行 `filter-notified-records.mjs`，仅保留 Base 中不存在相同「申请ID + 面试ID」且「是否已通知=是」历史行的 records；预筛失败立即中断。
5. 遍历预筛后的 records，严格执行 `interviewer-review` 的“统计 → analysis.json → 原版渲染 → 原版校验”流程；不通过校验的记录不得上传或回填 URL。
6. 按 record 串行将通过校验的 `面试复盘报告-<面试官>-<候选人>.html` 上传到固定 Drive folder，并把飞书真实 URL 写回同一条 record。
7. 仅在所有 record 完成上述处理后，调用一次 `sync-lark-base.mjs`，然后 `deduplicate-lark-base.mjs`，最后 `backfill-interviewer-user.mjs`。

**成功判定**：导出、报告校验、每份 Drive 上传、sync、dedup、人员回填均须分别判断；其中报告必须以原版 `validate_report.py` 退出码 0 为准，上传必须取得飞书返回的真实 URL。没有今日记录不算失败；单条报告或上传失败不阻断其他记录，但必须在汇总中体现。

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
| `interviewer-review` 的 Python 脚本输出乱码或 JSON 为空 | Windows 默认编码与 Python 输出编码不一致 | 执行前设 `chcp 65001` 与 `PYTHONIOENCODING=utf-8`，再按原版 skill 的命令重跑；不得改写其统计或渲染脚本 |
| `python3` 命令不存在，报 `exit code 9009` | Windows 上可执行文件名是 `python` 不是 `python3` | 用 `python` 替代 `python3`；SKILL.md 命令模板写 `python3`（跨平台兼容），Windows 实跑时换成 `python` |
| PowerShell `>` 重定向生成的 JSON 带 UTF-16 BOM，`json.loads` 报 `Unexpected UTF-8 BOM` | PowerShell 5.1 的 `>` 默认用 UTF-16 编码 | **禁止用 PowerShell `>` 重定向保存 Python stdout**；改用 Python 子进程 `capture_output=True, text=True, encoding='utf-8'` 捕获后用 `open(path,'w',encoding='utf-8')` 写文件 |
| `Set-Content -Encoding UTF8` 生成的 JSON 带 BOM，`json.loads` 报 `JSONDecodeError` | PS 5.1 的 `-Encoding UTF8` 会加 BOM | **禁止用 `Set-Content -Encoding UTF8` 写 JSON**；改用 `writeFile` 工具或 Node.js `fs.writeFileSync(path, content, 'utf-8')`，两者都不加 BOM |
| PowerShell `&&` 链接失败，报 `ParserError` | PowerShell 5.1 不支持 `&&` | 用 `;` 或 `if ($?) { ... }` 替代，或分成多次 execScript 调用 |
| `python -c "f'{...}'"` 单行崩 SyntaxError | PowerShell 引号转义与 Python f-string 冲突 | **禁止 `python -c` 单行运行任何含 f-string 或多语句的代码**;写到 `.py` 临时文件再跑 |
| `node "scripts/xxx.mjs"` 找不到脚本 | 宿主 execScript 的 cwd 不在 skill 目录 | **一律用绝对路径** `node "<Skill目录>/scripts/xxx.mjs"`。共同前置第 1 步就是干这个的 |
| 手误 `D:` 打成 `E:` | 无 | 每一次 execScript 之前肉眼核对盘符 |

### 报告与云盘阶段

| 现象 | 根因 | 处置 |
|---|---|---|
| 原版校验脚本失败 | `analysis.json`、证据或 HTML 结构不符合 `interviewer-review` 契约 | 修正 analysis 后重新调用原版渲染和校验；校验未通过不得上传或写 URL |
| 校验报"雷达强项「XX」缺少对应亮点证据" | 雷达分数 ≥3.5 的维度必须有对应 `highlights` 条目 | 给该维度补一条亮点（含 2-3 段证据），或把分数降到 3.0 以下 |
| 校验报"证据 turn_index 跨判断重复使用" | 同一段原话 `turn_index` 同时出现在亮点和改进项里，或跨卡重复 | 每条 `turn_index` 只能用在一个 `claim_id` 里；亮点和改进项必须引用不同的轮次 |
| 校验报"亮点 N 的原话过短或为空" | 选了"对。""Ok."等极短回复作为证据 | 换一段内容足够长的面试官轮次作为证据 |
| 校验报"改进项 N 评价开场，evidence_basis 必须是 opening_boundary" | 改进项引用了开场区域轮次但 `evidence_basis` 写成了 `direct` | 改为 `opening_boundary`，且 `single_event:true`，证据必须含面试官第一轮原话 |
| 校验报"改进项 N 的追问证据必须展示至少 3 轮完整问答链" | 追问不足的改进项只给了 2 个或不相邻的 `turn_index` | 必须给 3 个**局部相邻**的轮次：面试官提问 → 候选人回答 → 面试官下一步 |
| 校验报"badge_line 必须为 20–35 字" | `badge_line` 超长或过短 | 精简到 20-35 个中文字符（不含 `<em>` 标签） |
| 校验报"改进项 N 的开场证据必须包含面试官第一轮原话" | `opening_boundary` 改进项的 `evidence_turn_indices` 没包含 turn_index=面试官第一轮 | 必须在证据里加上面试官第一轮的 `turn_index`，可以再补一个前 3 轮内的其他轮次 |
| 校验报"改进项 N 评价收尾，evidence_basis 必须是 closing_boundary" | 改进项引用了收尾区域轮次但 `evidence_basis` 写成了 `direct` | 改为 `closing_boundary`，且 `single_event:true`，证据用面试官最后一轮原话 |
| Drive 上传失败或缺少 scope | lark-cli 用户身份没有 Drive 上传权限，或目标目录无权限 | 中断后续写入并汇报，需要 HR 在首次配置入口补充 Drive 用户授权；定时任务不弹授权二维码 |
| 上传响应没有真实 URL | 上传结果不完整或 Agent 未能提取可访问链接 | 视为该条失败，保留本地 HTML，不猜测或拼接 URL |

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
| 用 lark-cli 内联 JSON 写 Base 字段时 field_not_found | Windows 命令行 UTF-8 传参编码链条太脆 | **禁止 Agent 直接调 lark-cli 写 Base 数据或删除记录**；只调 skill 提供的 `.mjs` 脚本。唯一例外是本流程规定的 `drive +upload`，它只传 ASCII 文件名和 folder token，不传中文 JSON 字段 |
| Python `subprocess.run(lark_cli, encoding='utf-8')` stdout 是空的 | lark-cli 输出是 GBK,Python 强解 UTF-8 报错并把 stdout 吞了 | 别自己起 Python 调 lark-cli;直接调本 skill 的 `.mjs`(内部用 `spawn` + `setEncoding('utf8')` 已经处理) |
| `backfill-interviewer-user.mjs` 的 `search-user` 报 `positional arguments are not supported` | 姓名格式 `Iris Cheng （程冬芳）` 中的空格被 lark-cli 拆成位置参数 | **已修复**:脚本从括号中提取中文名搜索,不再用完整姓名 |
| `backfill-interviewer-user.mjs` 的 `record-upsert` 报 `invalid character 'é'` | Windows `spawn` + `shell:true` 经 cmd.exe 编码链路,中文字段名 `面试官 (人员 )` 被转成 GBK | **已修复**:脚本对所有 JSON payload 强制走 `@file` 模式 |

### 汇报

| 现象 | 处置 |
|---|---|
| 汇总时说"sync 全部成功",但实际每条都 failed | **必须**看 `created`/`failed`/`deduplicatedRecords` 三个字段。 `ok:true` 是必要非充分条件 |

## Agent 自查清单(每次入口开跑前默念)

进入任一定时入口前,**必须**在心里过一遍下面这份清单;违背任何一条基本都会踩坑:

- [ ] Skill 绝对路径已解析,后续 `.mjs` 全部用绝对路径调用。**注意 moka-transcript 和 interviewer-review 是两个不同的 skill 目录**,各自的 `.mjs`/`.py` 用各自目录的绝对路径。
- [ ] lark-cli 绝对路径已解析,所有 `.mjs` 都追加 `--lark-cli "<绝对路径>"`。
- [ ] 已确认 `interviewer-review` skill 可访问；只用其原版统计、渲染、校验与模板，不使用旧 Moka HTML 生成器。
- [ ] 已在报告前运行 `filter-notified-records.mjs`；仅将 `remainingRecords` 交给后续链路。任何同「申请ID + 面试ID」且 Base「是否已通知=是」的 record 必须完全跳过。
- [ ] HTML 仅在原版校验通过后，使用 lark-cli user 身份串行上传至固定 Drive 目录；只接受上传响应返回的真实 URL。上传成功后立即转移 owner 给 Julia Tian（open_id: `ou_0f7d6f3c5c579945fae70cb2348e6091`）。
- [ ] Windows 上已 `chcp 65001`,Python 子进程环境含 `PYTHONIOENCODING=utf-8`。Windows 上用 `python` 而非 `python3`。
- [ ] **禁止用 PowerShell `>` 或 `Set-Content -Encoding UTF8` 保存 Python stdout 生成的 JSON**（会加 BOM）；用 Python 子进程 `capture_output` + `open('w',encoding='utf-8')` 或 Node.js `fs.writeFileSync('utf-8')`。
- [ ] **禁止用 PowerShell `&&`**；用 `;` 或 `if ($?)` 替代。
- [ ] 报告文件名为 `面试复盘报告-<面试官>-<候选人>.html`，姓名来自 record 的结构化字段；只替换 Windows 非法字符。统计临时文件仍使用 ASCII 名称。
- [ ] 时间戳倒退不再阻断报告生成，`display_ts` 等于 `raw_ts`（绝对时间），无需前置检查 `span.valid`。
- [ ] **面试官说话人绑定**：Moka 展示姓名匹配失败时，从 `stats.speakers` 里找提问最多的说话人标签重新跑统计。`interviewer_speakers` 写转录 speaker 标签，不是 Moka 展示姓名。
- [ ] **analysis.json 校验器常见坑**：① 雷达 ≥3.5 的维度必须有对应亮点；② `turn_index` 不可跨判断重复；③ 证据原话不可过短（避免"对。""Ok."）；④ 开场改进须 `opening_boundary`+面试官第一轮原话；⑤ 收尾改进须 `closing_boundary`+面试官最后一轮原话；⑥ 追问改进须 3 轮局部相邻问答链（面试官→候选人→面试官）；⑦ `badge_line` 限 20-35 字。在写 analysis 时一次性满足，避免报错循环。
- [ ] 大 JSON 结构探查用 `.cjs` 脚步文件,不用 `grep` / `Read` / `node -e` / `python -c` 硬碰。
- [ ] sync 判成功用 `ok:true && created===deduplicatedRecords && failed===0`,不是只看 `ok`。
- [ ] 单次流水线**只调一次** sync-lark-base.mjs,不为校招/社招各调一次。
- [ ] backfill-interviewer-user.mjs 在 dedup 之后执行,失败/`unresolvedNames`不阻塞汇报,把摘要附到汇总即可。
- [ ] 出现任何写入失败**不重跑整个流水线**——把 `errors` 附到汇总,让 HR 决定。
- [ ] **批量报告生成策略**：子代理只承担"读逐字稿→分析→写 analysis.json"，渲染和校验由自己串行跑。子代理返回后必须检查 analysis.json 完整性，空结果则自行接管，不停顿。
- [ ] **interviewer-review 的脚本和模板必须通过 `execScript` 调用**，不用 `runCommand` + 本地路径。Windows `&&` 报错用 `cmd /c` 或 `;` 替代，不换工具。



- 只访问当前登录账号有权查看的数据。
- 不使用 mitmproxy 完成日常采集；不要求用户提供抓包或凭证。
- 不把 JSON 数据文件写进插件仓库或 Skill 目录。
- 候选人结构化数据只写入本 Skill 固定配置的飞书 Base；最终校验通过的 HTML 仅上传到固定 Drive folder `NY5IfFoh5lQmIaddwoSc6oJznBc`，不上传或发送到其他位置。
- 对话汇报、自动化摘要、错误信息和调试日志中**不要输出**手机号、邮箱、身份证号或逐字稿正文。候选人及面试官**姓名可直接原文使用**——数据源是授权 HR 采集,姓名不做处理。
- 不因定时任务失败而重新安装工具、删除 Chrome Profile、删除飞书记录或清空 Base。
- 不直接重试脚本内部失败的写入操作；重新运行整个脚本即可。
- sync 脚本不保证无重复——重复由 dedup 脚本统一清理。
- dedup 脚本使用逐条删除（`+record-delete --record-id`），不使用 batch delete 接口——后者在实测中会静默失败。
- 不写入或维护面试官信息表（已废弃）；面试官姓名作为 text 写入面试转写表的「面试官」列，dedup 之后由 `backfill-interviewer-user.mjs` 通过 `contact +search-user` 解析出 open_id 回填「面试官(人员)」user 列。
- 默认 JSON 是单次中转文件，不承担历史存储。
