---
name: moka-transcriptV2
description: 为 HR 配置 Moka 离线采集环境，或在定时任务中抓取今日全部面试转写、生成面试官复盘报告并回填飞书。首次登录后用 capture-payload 验证离线材料；定时任务只运行一次全量导出与后处理，不让用户选择采集模式。
---

# Moka Transcript V2

只处理用户有权访问的 Moka 和飞书数据。首次登录使用本机 CDP Chrome；定时采集使用 CLI 持久化的登录态，以纯 HTTP 依次切换校招、社招并合并结果，通过 lark-cli 用户身份写入飞书 Base。

**凭证边界**：
- Agent 层（对话回复、日志摘要、错误信息、临时文件名、脚本 stdout）**不得读取、复制、回显或持久化**任何 Cookie、JWT、access token、密码、验证码。
- CLI 插件（`opencli moka`）**内部**为了支持定时任务在 Chrome 被关闭时也能采集，允许把 Moka 应用与 Passport 登录 cookie 明文落盘到 `~/.opencli/mokaData/moka-cookies.json`（仅当前 OS 用户账户可读）。应用 session 失效时，插件会用同一文件中的 Passport cookie 走 ticket + uniLogin 静默续期并写回新 cookie；全程无需 CDP。该文件由 CLI 内部读写，Agent 不得读取、cat、上传、转发或在对话/日志中回显该文件内容。

**执行工具边界**：
- 依赖本机状态的命令必须用 `lobe-local-system/runCommand` 在用户电脑执行，包括 `opencli moka`、CDP/Chrome、`lark-cli`，以及本 skill 自带且需要访问 `~/.opencli` 配置或本地授权的 `.mjs` 脚本；这样才能使用本机 PATH、CLI、Cookie 文件和用户配置。Cookie 仍只能由 `opencli moka` 内部读取，Agent 不得把 Cookie 内容作为命令参数或传给其他执行器。
- 仅 `interviewer-review` 随 skill 分发的统计、证据提取、渲染和校验脚本使用 `lobe-skills/execScript`，由它提供对应版本的 skill 资源；这些脚本只接收明确传入的本地逐字稿、stats、analysis 和 HTML 路径，不负责调用 `opencli moka`、获取登录态或读取 Cookie。
- `runtime: server` 只表示 Agent 推理运行位置，不能据此判断命令执行位置。当前流程必须同时具备本地系统执行器和可访问本地输入输出路径的 skill 执行器；缺少任一执行器时中断并汇报，不把抓取流程迁到云端重试。

## 路由

根据请求选择且只执行一个入口：

1. 用户要求配置、检查环境、登录、更新离线采集材料，或在进行中的首次配置里回复「登录好了」：执行「首次配置入口」，从上次暂停处继续。
2. 定时任务明确调用 `moka-transcriptV2` 抓取今日全部面试转写：执行「定时采集入口」。只调用一次全量导出；不向用户询问、也不在提示词中指定招聘模式。

## 固定配置

- OpenCLI 插件仓库：`github:NeverlandzZ1/Moka-cli`
- lark-cli 官方包：`@larksuite/cli`
- CDP 默认端口：`9222`
- 逻辑输出路径：`~/.opencli/mokaData/transcript.json`
- Windows 实际路径：`$env:USERPROFILE\.opencli\mokaData\transcript.json`
- macOS/Linux 实际路径：`$HOME/.opencli/mokaData/transcript.json`
- CLI 内部 Moka cookie 缓存：`~/.opencli/mokaData/moka-cookies.json`（仅 CLI 读写，Agent 不得读取）
- CLI 内部 interviewList 请求体模板缓存：`~/.opencli/mokaData/moka-interview-list-payload.json`
- 定时任务名称：`Moka面试转写与复盘`
- 定时任务指令：`定时任务，调用 moka-transcriptV2 skill，抓取今日全部面试转写，生成复盘报告并回填飞书。`
- 已有定时任务若仍引用旧 Skill 名或旧提示词，须在普通配置入口更新为上述指令；改名不会自动迁移宿主定时任务。
- 时区：`Asia/Shanghai`
- 执行 Agent：`当前助手自身`
- 飞书 Base：首次配置时由用户提供（支持新建、指定或使用已有配置），存入 `~/.opencli/moka-config.json` 的 `feishu_base_url` 字段；后续从该配置读取
- 定时报告云盘目录：首次配置时由用户提供飞书云盘文件夹 URL，存入同一配置的 `report_folder_url`；定时任务只从该 URL 解析 folder token，**没有固定目录或旧目录回退**。解析与安全校验使用 `scripts/report-targets.mjs`。
- 报告文件 owner：本次导出 JSON 顶层 `面试安排HR`（Moka 当前登录账号）经飞书通讯录唯一匹配得到的 open_id；不是 `record.interviewerNames`，也不是固定 HR open_id。
- 飞书同步脚本：`scripts/sync-lark-base.mjs`（Windows 上所有 JSON 均用 `@./file.json` 临时文件传参；其他平台超过 3000 字符时切换）
- 已通知预筛脚本：`scripts/filter-notified-records.mjs`（只读 Base；在评分前按「申请ID + 面试ID」过滤 `是否已通知=是` 的记录）
- 飞书去重脚本：`scripts/deduplicate-lark-base.mjs`（逐条删除策略，非 batch delete；同样内置 @file 保护）
- 人员字段回填脚本：`scripts/backfill-interviewer-user.mjs`（dedup 之后运行；面试官从每行「面试官」text 解析，面试安排 HR 从本次 JSON 顶层 `面试安排HR` 解析并按联合键限定本次记录；两者分别写入对应 user 列。**已修复两个 Windows 兼容问题**：① `search-user` 从括号中提取中文名搜索,避免空格导致位置参数错误；② `runLarkCli` 对所有 JSON payload 强制走 `@file` 模式,避免中文字段名在 cmd.exe 编码链路中被破坏）
- 脚本契约：`references/lark-base-write.md`
- 飞书目标配置辅助脚本：`scripts/report-targets.mjs`（读取本机 `moka-config.json` 的 `feishu_base_url` 做同租户校验，仅修改其中的 `report_folder_url`，并从完整通讯录搜索结果严格匹配本次 Moka HR；不调用飞书 CLI、不读取登录凭据）
- 定时报告引擎（必需的独立 skill）：`interviewer-review`。它是评分规范、统计、渲染、校验与 HTML 模板的**唯一真源**；本 skill 不保留副本，不得降级回手写 HTML 或旧 `generate-report.mjs`。
- 报告上传后使用飞书返回的真实文件 URL 写入 `record.reviewReportUrl`；`report_folder_url` 仅由用户在普通配置入口确认或更换。

始终先解析出绝对输出路径再传给 `--output`；不要把未展开的 `~` 直接交给 OpenCLI。

## 首次配置入口

**⚠️ 交互原则:选择尽量一次性收齐,不要一步问一次。** 首次配置涉及 4 个用户选择:
1. 飞书 Base URL 来源(使用已有 config / 新建 / 手动指定)
2. 面试报告飞书云盘文件夹(使用已有 `report_folder_url` / 用户提供新 URL；无已有值时必须提供)
3. Moka 登录态处理(本地有 cookie 时:继续用 / 重新登录;本地无 cookie 时:无选项,必须重新登录)
4. 是否创建定时任务(是 / 否,若是则问执行时机)

**执行顺序**:
- 第 1、2、4 项**可以合并成一次多问选项框**,在 lark-cli 授权通过后一并向用户提问,一次拿齐再往下走。第 3 项**必须先做磁盘 cookie 存在性探测**才能决定要不要给选项(本地无 cookie 时没有选项可选),所以放在探测之后紧接着单独问——不能提前混进"一次性选项框",否则用户看到的"继续用"选项在本地无 cookie 时是无效的。
- 若宿主的选项框工具不支持一次收多个问题,退化为顺序问,但**每个问题的选项要一次给全**,不要中途插入其他步骤打断用户。
- **本 Skill 只负责 Moka 相关配置**——lark-cli 的授权二维码、系统软件的安装审批等属于其他子步骤的必要交互,该问还要问,不合并进上述 4 个选项。

### 1. 探测并补齐环境

识别操作系统，依次检查 Chrome、Node.js、npm、Git、OpenCLI、Moka 插件和 lark-cli。已有且可用时跳过安装，不要重复破坏现有环境。这里必须区分 OpenCLI 主程序和 Moka 插件：**OpenCLI 主程序只检查兼容性和可用性，不做例行升级；Moka 插件则必须检查是否与 GitHub 最新提交一致，不能因为本机已经安装就跳过更新检查。**

最低要求：

- Google Chrome
- Node.js 20 以上；新装时优先 Node.js 22 LTS
- npm
- Git
- `@jackwener/opencli`，版本满足 `>=1.8.6 <2`
- Moka 插件，来源为 `github:NeverlandzZ1/Moka-cli` 且安装提交与该仓库远端 `HEAD` 一致
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

OpenCLI 主程序处理规则：

- 未安装时才执行安装：

```text
npm install -g @jackwener/opencli@1.8.6
```

- 已安装、版本满足 `>=1.8.6 <2` 且上述命令可以正常运行时，**保留当前版本，不执行 `npm update`，也不为了更新 Moka 插件而升级 OpenCLI**。
- 只有版本不兼容或程序损坏时才修复/重装 OpenCLI，并在操作前说明原因。

#### Moka 插件 GitHub 一致性检查（普通配置入口强制执行）

每次在普通对话中执行首次配置或环境检测，都必须完成以下检查。`opencli plugin list` 只证明“装过插件”，**不能**证明插件是最新版本。

1. 执行 `git ls-remote https://github.com/NeverlandzZ1/Moka-cli.git HEAD`，取得 GitHub 当前 `HEAD` 的完整 commit hash。远端查询失败时不得假装一致；明确汇报网络/GitHub 检查失败并停止后续配置。
2. 执行 `opencli plugin list -f json`，确认插件名为 `moka-transcripts`；同时只读取 `~/.opencli/plugins.lock.json` 中该插件的 `source` 和 `commitHash` 元数据。不得输出该目录下 cookie 等登录凭据。
3. 插件不存在时安装：

```text
opencli plugin install github:NeverlandzZ1/Moka-cli
```

4. 插件来自 GitHub，但本地 `commitHash` 缺失或与远端 `HEAD` 不同，则更新：

```text
opencli plugin update moka-transcripts
```

5. 更新或安装后必须重新读取 `plugins.lock.json`，再次比较 commit hash。若仍不一致，允许重装一次以清除旧命令缓存：

```text
opencli plugin uninstall moka-transcripts
opencli plugin install github:NeverlandzZ1/Moka-cli
```

重装后再比较一次；仍不一致就停止配置并如实汇报，不进入登录、飞书授权或定时任务创建。

6. 若 `source.kind` 为 `local`，说明这是开发者本地源码绑定：读取 `source.path` 对应 Git 仓库的当前 `HEAD`，与 GitHub 远端 `HEAD` 比较。完全一致时可继续；不一致或工作区存在未提交改动时，**不得自动 pull、reset、卸载或覆盖本地源码**，应说明这是本地开发版本并让用户先处理或明确选择改装 GitHub 版。

7. commit 一致后，执行 `opencli moka capture-payload --help` 与 `opencli moka export-transcripts --help`；确认前者已注册，后者至少包含 `--offline`、`--output`、`--overwrite`。任一缺失都视为插件注册仍旧，按上面的“一次重装”规则处理。

该强制更新检查**只属于普通对话的首次配置/环境检测入口**。定时采集入口不得联网检查 GitHub、不得执行插件更新或重装；若导出结果缺少新版必需的顶层 `面试安排HR`，定时任务应中断并要求用户回到普通配置入口更新插件。

安装 lark-cli：

```text
npx @larksuite/cli@latest install
```

lark-cli 已存在时使用 `lark-cli update` 更新，不要用不明来源的同名 npm 包替换。

最后验证：

```text
opencli plugin list -f json
opencli moka login --help
opencli moka capture-payload --help
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

用户提供或新建后,更新 `~/.opencli/moka-config.json` 中的 `feishu_base_url`，**保留文件里的其他配置项**（尤其已有的 `report_folder_url`）；用户选"使用已有"时保留原值不重写。后续首次配置的飞书写入均使用该 Base URL。

### 3.1 收集报告上传文件夹 URL

同样让用户确认本次 HTML 的飞书云盘目标目录。若配置已有 `report_folder_url`，展示完整 URL 并提供"使用已有目录"和"指定新目录 URL"；没有该字段时只让用户提供 URL，不得暗中沿用原先的固定目录。用户给的是**文件夹链接**，格式如 `https://<当前飞书租户>/drive/folder/<folder_token>`，不是单个文件、Base 或 Wiki 页面链接。

确认 Base URL 已写入配置后，先**只读检查**用户提供的 URL 格式：

```text
node "<Skill目录>/scripts/report-targets.mjs" check-folder --url "<用户提供的文件夹URL>"
```

用返回的 `folderToken` 通过飞书**当前用户身份**查询真实元数据，核对确为用户指定的文件夹；协作者列表可辅助判断当前身份是否有编辑权限，但 `permission-get-setting` 可能只允许 owner 调用，**不能把读取公共设置失败直接判成无上传权限**。确认目标真实可访问后才保存，并回读：

```text
node "<Skill目录>/scripts/report-targets.mjs" set-folder --url "<用户提供的文件夹URL>"
node "<Skill目录>/scripts/report-targets.mjs" get-folder
```

选"使用已有目录"时只运行 `get-folder` 并核对真实元数据。辅助脚本要求 HTTPS、路径为 `/drive/folder/<token>` 且与已配置 Base 同一租户；保存 `report_folder_url` 时保留其他配置项，不额外持久化 token。元数据查询失败或明确无上传权限则停止配置并请用户更换目录或联系文件夹所有者授权，不能换到别的目录；已验证的旧配置也不因新 URL 无效被覆盖。只读验证不能证明上传权限，最终以真实上传响应为准。

**⚠️ 定时采集入口不会再问 Base 或报告目录**——直接读配置中的 `feishu_base_url` 和 `report_folder_url`，缺失或失效时不上传、更不回退到旧目录；换目标必须在普通配置入口重新确认。

### 4. 确保本地 Moka 离线采集材料就绪

离线采集需要两个本地文件：CLI 管理的 Cookie 文件 `~/.opencli/mokaData/moka-cookies.json`，以及 interviewList 请求体模板 `~/.opencli/mokaData/moka-interview-list-payload.json`。Agent 只探测二者是否存在，不得读取内容。两个文件存在仅表示材料齐备；登录态和请求体是否仍可用，由实际 `--offline` 请求验证。CDP 用于首次登录、主动重新登录或重新捕获 payload。

**⚠️ 不要用 `opencli moka status` 来判断"离线采集是否就绪"**——那条命令只反映 CDP 是否活着且能访问 Moka，不证明磁盘上的 Cookie 与 payload 两个文件都存在。本步骤专门用文件系统的存在性探测；重新准备时使用 `capture-payload`。

**第一步：对两个文件做只读存在性探测**

只探存在性、不读文件内容、不 echo 路径或结果到对话/日志(红线 #1)。跨平台命令：

- Windows PowerShell：分别执行 `Test-Path "$env:USERPROFILE\.opencli\mokaData\moka-cookies.json"` 与 `Test-Path "$env:USERPROFILE\.opencli\mokaData\moka-interview-list-payload.json"`
- macOS / Linux / Git Bash：分别执行 `test -f "$HOME/.opencli/mokaData/moka-cookies.json"` 与 `test -f "$HOME/.opencli/mokaData/moka-interview-list-payload.json"`

只取"存在 / 不存在"这一个布尔结果进入分支判断,**绝不 cat、Read、打印文件内容**。

**第二步：按存在性结果分支处理**

- **Cookie 与 payload 文件都存在**：**不要**擅自跳过,也**不要**擅自拉 Chrome,用**选项框**让用户拍板:

  | 选项 | 后续行为 |
  |------|---------|
  | ✅ 使用现有登录态,跳过 CDP 登录（推荐） | 不打开 CDP Chrome,直接进入下一步；定时采集会在需要时自动用 Passport cookie 静默续期，取得今日全量数据 |
  | 🔄 重新登录（换账号或强制刷新） | 走下面的"强制登录流程"(cookie 已过期时也走这条) |

  Cookie 是否仍能续期,由后面的真实采集验证：应用 session 失效不算失败，CLI 会先自动走 Passport ticket + uniLogin；只有 Passport 也失效、被服务端撤销或文件不完整时，才让用户手动回来走强制登录。本步不读取文件内容做预判，遵守红线 #1。

- **Cookie 存在但 payload 缺失**：不能直接进入定时任务。执行下面的准备流程；若 `opencli moka login` 复用的 Chrome 已登录，可直接运行捕获命令，无需用户再次登录。
- **本地无 Cookie 文件**(首次配置,从未登录过)：**没有可选项**,必须走下面的准备流程——唯一出路就是拉起 CDP 让用户登录,不给"跳过"选项。

**登录并准备离线采集流程**（本地缺 Cookie、缺 payload，或用户主动选择重新登录时执行）：

```text
opencli moka login -f json
```

该命令打开或复用独立用户数据目录的 CDP Chrome 并进入 Moka。若返回尚未登录，告诉用户在这个窗口中完成登录，然后回复"登录好了"；到这里必须暂停并等待用户回复，不要索要账号、密码、验证码或 Cookie，也不要替用户登录。若返回已登录，可直接继续。

确认页面已登录后，在 Chrome 仍开启时执行：

```text
opencli moka capture-payload -f json
```

登录时若使用了非默认 CDP `--port`，这里也传同一个端口。

用户回复「登录好了」后，立即在同一 CDP 端口执行上述 `capture-payload`；不能以 `status`、Cookie 文件存在或一次普通导出代替验证。命令会在需要时以 CDP 原生鼠标点击侧栏「面试安排」进入总览，再点击「加载更多」捕获 `interviewList`；不得手动执行 `Page.reload` 或 `page.goto`。命令落盘最新 payload、保存 Cookie，并通过 `getCurrent` 验证当前 HR；不得把 payload 或 Cookie 正文输出到对话。只有退出码为 0，且返回 `offlineReady: true`、`payloadSaved: true`、`currentUserName` 非空，再只读确认两个文件存在，才告诉用户可以关闭 Chrome。捕获失败时保留 Chrome，说明错误并检查总览权限或重新运行捕获；不得宣称离线材料已就绪。

### 5. （可选）创建定时任务

本地离线材料确认后，定时任务使用 `export-transcripts --offline` 一次取得今日全部面试转写；不提供采集模式选项。

问一次：「是否创建每日面试转写与复盘定时任务？」

- 用户选择否：简洁确认环境和登录已配置，结束。
- 用户选择是：再单独询问执行时机。接受"每隔 N 小时""每天 HH:mm""工作日每天 HH:mm"等自然语言。

将时间转换为 Cron；至少支持：

- 每隔 N 小时：`0 */N * * *`
- 每天 HH:mm：`mm HH * * *`
- 工作日每天 HH:mm：`mm HH * * 1-5`

若用户表达无法无歧义映射为 Cron，先澄清，不要猜测。创建前向用户复述时间和 Cron。

```text
任务名称：Moka面试转写与复盘
任务指令：定时任务，调用 moka-transcriptV2 skill，抓取今日全部面试转写，生成复盘报告并回填飞书。
Cron：<根据用户执行时机生成>
时区：Asia/Shanghai
执行 Agent：当前助手自身
```

使用宿主 Agent 的定时任务/自动化创建能力创建任务。只有工具明确返回创建成功后才能汇报成功；若当前宿主没有定时任务能力，明确说明无法创建，不要伪造结果。

## 定时采集入口

该入口面向无人值守运行。**不检测 CDP、不主动读取或检查 Moka cookie 内容、不检查 lark-cli 授权**。调用一次 `opencli moka export-transcripts --offline` 获取今日全量 JSON；CLI 在真实请求中验证应用 session、必要时通过 Passport 静默续期，并完成内部采集与合并。**飞书 Base URL 与报告目录 URL 分别从 `~/.opencli/moka-config.json` 的 `feishu_base_url`、`report_folder_url` 读取，不弹选项框、不问用户。** 自动续期、飞书写入或配置失败时按对应阶段中断并汇报，让 HR 回普通配置入口处理。

**lark-cli 路径定位**：定时任务运行环境中 `lark-cli` 可能不在默认 PATH 中。若直接执行 `lark-cli` 失败，通过 `where lark-cli`（Windows）或 `which lark-cli`（macOS/Linux）定位真实可执行文件路径，后续所有 sync、dedup 等脚本调用都通过 `--lark-cli "<路径>"` 参数传递。不要修改用户的全局 PATH。

确认当前 Skill 目录存在 `scripts/sync-lark-base.mjs`、`scripts/deduplicate-lark-base.mjs`、`scripts/backfill-interviewer-user.mjs`、`scripts/report-targets.mjs`，且宿主已安装可访问的 `interviewer-review` skill。飞书记录的写入由 sync 脚本执行，去重清理由 dedup 脚本执行，两类人员字段由 backfill 脚本执行；Agent 禁止自行调用 `lark-cli base +record-upsert`、`+record-batch-create`、`+record-batch-update` 写面试转写表。HTML 必须由 `interviewer-review` 生成，只上传到配置指定的飞书云盘文件夹，返回 URL 写入 `record.reviewReportUrl`。维护 Base 脚本时才读取 `references/lark-base-write.md`。

### 1. 覆盖导出今日全量 JSON

解析默认 JSON 的绝对路径，执行一次：

```text
opencli moka export-transcripts --offline --output "<绝对输出路径>" --overwrite -f json
```

`--offline` 跳过 CDP Chrome，读取本地 Cookie 和请求体模板发 HTTP 请求。CLI 只调用一次当前账号接口取得顶层 `面试安排HR`，内部依次采集两类招聘数据，再按 `applicationId + interviewId` 合并去重并重算统计；重复联合键以较后采集的记录为准。应用 session 失效时会尝试 Passport ticket + uniLogin 续期并写回新 session。`--overwrite` 使输出文件只包含本次今日全量结果。Agent 不另行调用 `mode`、`applications`、`interviews` 或 `transcript` 拼接采集结果。

导出成功后，确认 JSON 顶层存在非空的 `面试安排HR`，其值由 CLI 从当前 Moka 登录账号的 `getCurrent` 接口取得。缺失或为空说明插件版本过旧或身份接口异常，应中断并要求更新插件后重新导出；不得从面试官姓名、逐字稿或飞书登录用户猜测负责 HR。

若命令最终仍报"Passport 登录态无法换取 ticket / 应用会话和 Passport 登录态均无法恢复 / 登录态失效"，说明 CLI 已经尝试过静默续期但 Passport 本身也过期、被服务端撤销，或 cookie 文件不完整。此时中断本次采集，汇报"Moka Passport 登录态无法自动恢复，需要 HR 重新执行首次配置入口的登录步骤或替换完整 moka-cookies.json"，不要在定时任务里尝试自动打开 Chrome，也不要由 Agent 读取或拼装 cookie。

### 2. 共用后处理

导出成功后，走 [`## 共用后处理`](#共用后处理) 的七段流程（已通知预筛 + 原版报告引擎 + 飞书云盘上传 + 单次 sync + 去重 + 人员回填）。CLI 只输出合并后的总统计，按合并后的总数汇报。

## 共用后处理

统一定时入口拿到「今日全量 JSON」后，执行以下七段流程。**只调一次 sync-lark-base.mjs、只调一次 deduplicate-lark-base.mjs**。

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
- 预筛只在定时采集入口执行。普通配置入口不读取 Base 历史记录，也不调用本脚本。

### 后处理-1. 调用原版 `interviewer-review` 生成并校验本地 HTML

这是定时任务的**唯一**报告生成路径。先定位已安装的 `interviewer-review` skill；若宿主未安装、当前 Agent 无法读取其 `SKILL.md`、或其 `scripts/transcript_stats.py` / `scripts/extract_evidence.cjs` / `render_report.py` / `validate_report.py` / `assets/report-template.html` 缺失，则中断本次任务，明确报“interviewer-review 报告引擎不可用”，不得改用旧生成器、手写 HTML 或简化模板。

遍历已完成后处理-0 预筛的 `<绝对输出路径>` 的 `records[]`：

- 跳过 `transcriptStatus !== "available"` 或 `transcript` 去空后为空的记录。
- **批量执行策略**：多条记录时，可将"读逐字稿 → 统计(`transcript_stats.py`) → 分析 → 写 `analysis.json`"分派给子代理**并行**处理，每条一个子代理。但 `render_report.py` + `validate_report.py` + 修错重试由本 Agent **串行**执行——渲染校验是确定性脚本调用，串行跑只需一两分钟，且修错时 Agent 对校验器报错模式已熟悉，效率更高。子代理返回后**必须检查 `analysis.json` 是否存在且内容完整**（含 `radar`、`highlights`、`improvements`、`evidence_turn_indices`）；空结果或缺失文件时自行接管该条的全链路，不停顿。**子代理不可用时（如套餐额度上限）**，由本 Agent **串行**处理每条记录，**不得因此降低质量标准或跳过任何步骤**——尤其是"通读逐字稿"这步，无论串行还是并行，都是**强制前置**，不可省略。
- 对每条处理记录，严格按以下**成功路径**逐步执行（不得跳步、不得边写边修）：

#### 步骤 A：统计 + 面试官绑定

1. 将逐字稿写入本地 `.txt` 临时文件（路径如 `<stats目录>/transcript_<idx>.txt`）。
2. 用 `interviewer-review` 的 `transcript_stats.py` 跑统计，传入 Moka 结构化面试官名，并始终传入 `--round "<record.roundName>"`。Windows 用 `python` 而非 `python3`，且设 `chcp 65001` + `PYTHONIOENCODING=utf-8`。**仅这个随 `interviewer-review` skill 分发的脚本通过 `execScript` 调用**（由执行器提供对应版本的 skill 资源，并读写明确传入的本地路径）。不要用本地 `runCommand` + 某个仓库副本的绝对路径绕过——本地可能存在多个 skill 副本，版本不可靠；这条限制不适用于前面的 `opencli moka`、`lark-cli` 和 Moka 自带 `.mjs`。遇到 Windows PowerShell `&&` 报错时用 `cmd /c` 或 `;` 替代，不要切换工具。
3. 若 `binding_warnings` 非空，从 `stats.speakers` 的 keys 里找到 `questions` 最高的说话人作为面试官标签，用该标签重新跑统计，直到 `binding_warnings` 为空。**多面试官时**：所有可识别的面试官 speaker 都要传入 `--interviewer`（可重复传参），确保 `stats.roles` 里所有面试官都被标为 `interviewer`。
4. 统计 JSON 保存到 `<stats目录>/stats_<idx>.json`。后续所有 turn_index、speaker 标签、share_pct 均从该文件取。

#### 步骤 B：通读逐字稿（强制前置，不可跳过）

1. 用 `readFile` **分批读取完整逐字稿**（如果文件超过200行，分多次读取直到读完）。**不得**仅看统计摘要的首尾5轮就写 analysis——首尾轮次往往是问候和告别，内容太短，不能当证据。
2. 通读时**在脑中标记**不同面试行为发生的位置：哪几轮做了开场介绍、哪几轮做了 STAR 追问、哪几轮是情景化提问、哪几轮面试官长段输出拉高了说话占比等。
3. 时间戳倒退不再阻断报告生成：`transcript_stats.py` 现在用 `raw_ts`（绝对时间）作为 `display_ts`，时间线倒退不再报 warning，`span.valid` 始终为 `true`，不需要前置检查。

#### 步骤 C：证据预分配（在写 analysis.json 之前完成）

通读逐字稿后、写 analysis.json 之前，**必须先做一次证据预分配**——确保每个 claim_id 用哪些 turn_index 在写之前就规划好，而不是写完再靠校验器报错去修：

1. 通过 `interviewer-review` 的 `execScript` 对当前单个本地 `stats_<idx>.json` 运行 `node scripts/extract_evidence.cjs "<stats_<idx>.json>"`。使用输出的 `round`、`redline_policy`、`eligible_interviewer_turns`、`opening_interviewer_turns`、`closing_interviewer_turns`、`speakers`、`process_signals` 与 `redline_signals`。`redline_policy.enabled=false` 时本场为 HR面试：不分配 R 类证据，不扫描或生成红线。每次只处理一个 stats JSON；**不得**临时生成 `check-stats.cjs` 等辅助脚本，也不得改用本地 `runCommand` 调用某个仓库副本。
2. 从这些轮次中选出 **每个轮次只能分配给一个 claim_id** 的证据池。规划时满足：
   - 每个亮点（H1-H5）分到 2-3 个不重复的面试官轮次，每个 `chars ≥ 40`（避免"你好""拜拜"等极短轮次）。
   - 每个普通改进项分到 2-3 个不重复的轮次（`single_event:true` 的可以只给1个）；`dialogue_chain` 必须包含局部相邻的面试官→候选人→面试官三轮。`process_signal` 必须引用信号指定的空档前后两轮，即使边界是候选人短句也必须保留原文；短句不得被通用长度门槛排除。
   - 仅 `redline_policy.enabled=true` 时，红线证据（R1-R2）分到 1-2 个轮次；HR面试不分配 R 类证据。
   - **所有 claim_id 的证据 turn_index 全局不重复**——同一个 turn_index 不能出现在两个 claim_id 里。
3. 如果面试官轮次不够分配（如面试官说话太少、太短），说明这场面试官行为证据不足，应降低亮点数量到 3 条、改进项数量到 3 条，或降低雷达分数（避免 ≥3.5 维度需要对应亮点）。**不得复用同一个 turn_index 凑数**。

#### 步骤 D：写 analysis.json（一次性写对）

原始字段映射固定为：`candidateName → metadata.candidate`，`interviewerNames（按「、」连接）→ metadata.interviewer`，`jobTitle → metadata.position`，`roundName → metadata.round`，`startTime → metadata.date`（UTC 转为本地时间格式如 "2026-09-23 10:00"），`transcript → 统计输入`。`metadata.direction_full` 写 "<岗位> · <轮次>"。候选人和面试官展示姓名必须直接取 record 的结构化字段，**不得**从转录内容猜测。`interviewer_speakers` 则必须使用统计结果中出现的 speaker 标签，只用于角色绑定、KPI 与证据校验，不得用真实展示姓名替代。

写 analysis.json 时**逐条对照以下自检清单**，写完即提交渲染，不做"先写后修"：

**analysis.json 事前自检清单（写完后、调 render_report.py 之前逐条确认）：**

- [ ] **通读逐字稿已完成**——不是只看统计摘要的首尾5轮，是完整读了一遍。
- [ ] **证据预分配已完成**——每个 claim_id 的 turn_index 在写之前就规划好，全局不重复。
- [ ] **逐个核对 turn_index 的角色**——普通面试官行为证据属于 `stats.roles` 中的 `interviewer`；`dialogue_chain` 必须含候选人回答，`process_signal` 的前后边界也可能含候选人轮次，按原始信号引用。
- [ ] **每个亮点 2-3 段证据**，每段 `chars ≥ 40`——避免"你好""拜拜""清蒸""在上海，"等极短轮次。
- [ ] **每个普通改进项 2-3 段证据**（`single_event:true` 的可1段）；`process_signal` 前后边界原话允许短于通用门槛，但必须非空、真实、不可改写；`dialogue_chain` 按三轮问答链约束。
- [ ] **所有 turn_index 全局不重复**——一个 turn_index 只能出现在一个 claim_id 里。亮点和改进项不能共用同一段原话。
- [ ] **雷达 ≥3.5 的维度都有对应 highlight**——如果打了提问质量 4.0，必须有 dimension="提问质量" 的亮点条目。
- [ ] **雷达低分的维度都有对应 improvement**——如果倾听打了 2.0，必须有 dimension="倾听" 的改进项条目。
- [ ] **倾听占比 KPI 校验**：只有 `stats.speakers` 里**单个面试官**的 `share_pct > 30` 或候选人 `share_pct < 70` 时，才能写 `evidence_basis="quantitative_pattern"` 的倾听改进项。**多面试官场景**：校验器从 stats.json 取的是 `--interviewer` 参数传入的那个说话人的 `share_pct`，不是合计值——**不要手算合计占比写进 summary**。使用 `extract_evidence.cjs` 输出的 `speakers` 核对实际 share_pct，不再另起 `node -e` 或临时脚本。
- [ ] **不写"最佳听众"称号当面试官占比 >30%**。
- [ ] **claim 和 summary 文本不含隐式触发词**——校验器用正则匹配 claim+summary 文本强制 evidence_basis 类型（见下表），写之前确认你的 claim 措辞和 evidence_basis 类型一致。
- [ ] **process_signals 已处理**——如果 stats.json 输出了 `process_signals`（如会前长空档），必须在同一条「开场与流程」且 `evidence_basis="process_signal"` 的改进项中引用空档前后的 `before_turn_index` 和 `after_turn_index`，边界原话可短但不可省略。
- [ ] **badge_line 去掉 `<em>` 标签后 20-35 字**（标点也算字数）。
- [ ] **红线策略已执行**——`redline_policy.enabled=true` 时逐条处理 redline_signals；`enabled=false` 时 `redlines=[]`、`dismissed_redline_signals=[]`、无 R 类证据、无「本场请注意」称号和红线区块。HR面试若低于正职 20 分钟/实习 15 分钟，必须写为「开场与流程」普通改进项，`evidence_basis="duration_boundary"`，引用面试官首尾轮次，KPI 显示黄色「偏短」。
- [ ] **advice 恰好 4 条**。

**claim 文本 → evidence_basis 隐式触发表（校验器源码 render_report.py 第 126-133 行）：**

| claim 或 summary 中包含 | 校验器强制要求 | 附加要求 |
|---|---|---|
| "开场""开头""开局" | `evidence_basis="opening_boundary"` | `single_event:true`，`dimension="开场与流程"`，证据含面试官第一轮原话，且不超出前3个面试官轮次 |
| "收尾""结尾""结束环节" | `evidence_basis="closing_boundary"` | `single_event:true`，证据含面试官最后一轮原话，且不超出后3个面试官轮次 |
| `dimension="倾听"` 且含"占比""比例""说话过多""发言过多" | `evidence_basis="quantitative_pattern"` | 面试官占比 >30% 或候选人 <70%，证据 2-3 段面试官长段发言 |
| `dimension="追问深度"` | `evidence_basis="dialogue_chain"` | 至少3轮局部相邻的「面试官→候选人→面试官」链路，turn_index 间隔 ≤2 |

**如果你不想触发这些强制类型**（比如你的改进项虽然提到开场但不想用 opening_boundary 的严格约束），改写 claim 和 summary 的措辞，避免出现上表中的关键词。但这不是推荐做法——如果内容确实是关于开场/收尾/追问/倾听占比的，就应该用对应的 evidence_basis 并满足其要求。

#### 步骤 E：渲染 + 校验（串行）

1. 调用 `render_report.py` 生成 HTML：
```bash
python scripts/render_report.py --analysis "<analysis.json>" --stats "<stats.json>" --template assets/report-template.html --output "<报告.html>"
```
2. 调用 `validate_report.py` 校验：
```bash
python scripts/validate_report.py "<报告.html>" --template assets/report-template.html --stats "<stats.json>" --interviewer "<转录中的面试官speaker标签>" --analysis "<analysis.json>"
```
**注意**：`--interviewer` 参数传的是 **stats.json 中 `speakers` 对象的 key**（即转录 speaker 标签），不是 Moka 展示名。多面试官时可重复传 `--interviewer`。
3. 校验退出码为 0 才算通过。校验失败时**修改 analysis.json 后重新渲染+校验**，不要修改 HTML 或模板。
4. 只有校验通过的 HTML 才能进入上传阶段。生成报告一律写入 `<transcript.json 所在目录>/reports/面试复盘报告-<面试官>-<候选人>.html`；面试官与候选人使用上述 record 真名，遇到 Windows 非法文件名字符 `\\ / : * ? " < > |` 时替换为安全字符，空值写"未记录"。
5. 从 `analysis.json.radar` 写入 `record.reviewScores`：`openingFlow`、`questionQuality`、`listening`、`followUpDepth`、`scaleControl`、`feedbackExperience`；同时写入 `redLineHits`（由已确认 `redlines` 派生；HR面试固定为空数组），以保持现有 Base 字段契约不变。
6. 单条评分、渲染或校验失败：写 `record.reviewError = "interviewer-review failed: <简短原因>"`，保留本地中间文件供排查，不阻断其他记录。**但校验失败率超过 50% 时应在汇报中明确标注"analysis.json 质量需人工排查"**——不应将系统性失败当作偶发失败处理。

### 后处理-2. 上传校验通过的 HTML 到用户指定的飞书云盘并写回 URL

先运行 `node "<Skill目录>/scripts/report-targets.mjs" get-folder`，从 `~/.opencli/moka-config.json` 取得已验证格式的 `folderToken` 和 `folderUrl`。缺失、格式错误或与 Base 不同租户时**停止上传并报告配置错误**，不得使用旧目录、根目录或临时创建目录。对目标文件夹做真实元数据查询；目录不可访问或无上传权限时不换目录，汇报权限阻断。

再从**本次导出 JSON 顶层**读取非空的 `面试安排HR`（Moka 登录账号姓名），为本次任务解析一次 owner：优先用括号内中文名作为 `contact +search-user --query <中文名> --as user --format json` 的查询词，无中文名或中文名搜索无结果时用英文别名/原文补查；若返回 `has_more`，继续分页直到全部获取，合并去重候选人。将完整搜索结果中的 `users`、`has_more:false` 保存为工作目录里的小 JSON，不包含逐字稿或凭据，执行：

```text
node "<Skill目录>/scripts/report-targets.mjs" resolve-owner --name "<本次JSON顶层面试安排HR>" --contacts "<完整搜索结果JSON绝对路径>"
```

只使用返回的唯一 `openId`。辅助脚本按完整姓名、括号内中文名与英文别名交叉核对；同名多人、结果未拉全、找不到或权限错误均**不得取第一条、猜 ID、复用上次的 owner 或改用面试官/飞书当前用户**。解析失败不影响已通过校验的 HTML 上传及其真实 URL 写回，但本次每份报告均记为 owner 未转移并汇报原因；不得声称端到端成功。

对每条已通过原版校验的 HTML：

- 使用飞书**当前用户身份**上传到本次配置解析出的 `folderToken`。先确认当前身份具有 Drive 上传 scope；缺 scope 时中断并汇报，定时任务中不得交互授权。目标文件夹权限不足时停止后续上传，不改投其他位置。
- 用 `drive +upload` 上传本地 HTML。因文件参数只允许 cwd 内的相对路径，先将 cwd 切换到报告文件所在目录（宿主若要求工作目录内上传，则先复制已校验 HTML），再传 `--file ./面试复盘报告-<面试官>-<候选人>.html --folder-token <folderToken> --as user`。逐份**串行**上传到同一目录，不并发上传。
- 仅使用飞书上传成功响应返回的真实、可访问 URL 写入 `record.reviewReportUrl`；绝不拼接或猜测 URL。若响应没有可用 URL，视为上传失败，不写 URL。
- 上传失败：写 `record.reviewError = "drive upload failed: <简短原因>"`，保留本地 HTML，继续下一条；目标文件夹权限错误视为本次上传阶段阻断。不得把报告上传到其他目录。
- **上传成功后立即转移 owner 给本次 Moka `面试安排HR`**：使用本次唯一匹配的飞书 `openId` 与上传响应中的真实 `file_token`，调用 `drive permission.members transfer_owner --params '{"token":"<file_token>","type":"file","remove_old_owner":false,"old_owner_perm":"full_access","need_notification":false}' --data '{"member_type":"openid","member_id":"<本次HR的openId>"}' --yes --as user`。不要用 Base 面试官人员列、结构化 `interviewerNames` 或固定历史 open_id。`remove_old_owner=false` 保留上传者权限；`need_notification=false` 不打扰接收人。转移后回读该文件的 metadata，核对真实 owner_id 等于该 openId；接口成功但回读不符仍算失败。失败不抹掉已取得的 URL、不重复上传，但逐份标注 owner 转移失败及原因，让 HR 手动处理。

所有 record 处理完成后，把扩充了 `reviewScores` / `reviewReportUrl` / (可选)`reviewError` 的 records **只重写一次** 到 `<绝对输出路径>`；顶层 `generatedAt` / `面试安排HR` / `source` / `errors` / `stats` 保留原值。不得在报告后处理阶段丢失或改写 `面试安排HR`。

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

sync 脚本自动写入「面试官」文本列、「面试官复盘-开场与流程 / 提问质量 / 倾听 / 追问深度 / 尺度把控 / 反馈体验」6 列数值、「面试复盘报告」文本 URL 列,以及「是否标红」「是否已通知」两列单选状态——「是否标红」由 `reviewScores.redLineHits` 是否非空派生,命中红线写「是」、否则写「否」;「是否已通知」本流水线固定写「否」,后续通知动作由其他流程处理,不在本 skill 职责范围内。两个单选列必须写严格字面量「是」/「否」,不带空格、不改字符,飞书按选项名精确匹配。评分或 URL 缺失的 record 对应字段自动为空,不影响其他列。「处理状态」列本流水线不管。

JSON 顶层 `面试安排HR` **不作为文本列写入**。目标 Base 不需要、也不应依赖「面试安排HR」文本字段；它只作为后处理-5 的人员解析来源，最终写入「面试安排HR(人员)」人员列。

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

### 后处理-5. 回填「面试官(人员)」与「面试安排HR(人员)」列

```text
node "<Skill目录>/scripts/backfill-interviewer-user.mjs" --input "<绝对输出路径>"
```

若 `lark-cli` 不在 PATH,追加 `--lark-cli "<路径>"`。

**为什么放在 dedup 之后**: 先去重再回填,只处理留下的最新一条,不浪费 API 调用去填马上要被删的旧记录。

**两类人员字段必须区分来源**:

- 「面试官(人员)」：继续读取每一行已有的「面试官」文本列，逐行解析人员。
- 「面试安排HR(人员)」：没有对应文本列。直接读取本次 JSON 顶层 `面试安排HR`，并按 `申请ID + 面试ID` 只回填本次 JSON `records[]` 对应的行，绝不能把当前账号 HR 批量写到历史其他记录。

**脚本做什么**(4 步):

1. 拿「面试官」text / 「面试官(人员)」user / 「面试安排HR(人员)」user / 「申请ID」/「面试ID」五列的 field_id;人员列显示名支持半/全角括号与括号内外空格的容错匹配。
2. `+record-list --field-id ...` 按行投影拉全表：面试官按文本列找待回填行；HR 按本次 JSON 的联合键找待回填行。两类人员列已有值时均尊重现有数据，不覆盖。
3. 建 `name → open_id` 映射：面试官先复用同表已有映射，再用 contact 搜索；面试安排 HR 直接用 JSON 顶层姓名单独搜索一次。
4. 逐条 `+record-upsert --record-id X --json @./payload-file.json`,默认 3 并发；同一行同时缺两类人员时合并成一次写入。人员字段值固定为 `[{"id":"ou_xxx"}]`。

**Windows 兼容修复**(2026-09-14 验证通过,已写入脚本):

- **`search-user` 查询词提取中文名**:Moka 导出的面试官姓名格式为 `Iris Cheng （程冬芳）`,直接传给 `--query` 会因空格被 lark-cli 拆成位置参数报错。脚本现在从括号中提取中文名(如 `程冬芳`)搜索,避免空格问题。无括号时提取连续中文字符。
- **`runLarkCli` 强制走 @file 模式**:所有 JSON payload(含中文字段名如 `面试官 (人员 )`)一律写入临时文件用 `@./file.json` 引用,不走命令行内联。Windows `spawn` + `shell:true` 会经过 cmd.exe 编码链路,把 UTF-8 中文字段名转成 GBK 导致 `invalid character` 解析错误。

**成功判定**:退出码 0 且 stdout JSON `ok === true`、`failed === 0` 且 `schedulingHr.failed === 0`。`unresolvedNames` 或 `schedulingHr.unresolved` 可以非空——找不到的姓名不会猜 open_id，对应人员列保持空并在汇总中明确列出。

**失败/部分失败时的处置**:回填失败**不阻塞本次采集结果汇报**,把 stdout 的 `unresolvedNames` 和 `errors` 摘要附到 后处理-6 汇总里,让 HR 判断是否人工补录。**不要**因为回填失败而重跑整个流水线,也不要重装工具或改脚本。

### 后处理-6. 汇总本次结果

不要在对话中输出 `transcript`、`evaluationSummary`、`questionAnalysis` 等长文本(逐字稿正文过长会挤爆对话上下文,不是隐私问题)。

每条本次处理的记录只汇报:

```text
候选人:<candidateName>｜面试官:<interviewerNames,以顿号连接;缺失时写"未记录">｜岗位:<jobTitle>｜复盘:<有|无|失败>
```

姓名原文直接汇报,不做处理——本 skill 的数据源是 HR 自己登录 Moka 后台采集,写入的是 HR 自己配置的飞书 Base,同租户内已授权。手机号、邮箱、身份证号仍不出现在对话摘要里(那些不是姓名字段)。

最后汇报:

- 今日全量导出是否成功、合并后总条数，以及因「是否已通知=是」预筛跳过数
- 本次评分成功/失败/跳过的记录数
- 本次 HTML 实际上传目录 URL、上传成功/失败数，以及 owner 转移成功/失败/未解析数；失败列出面试安排 HR 姓名与简短原因，不输出 open_id
- 新增面试记录数、batch-create 是否降级
- 去重结果: 面试转写表删除数/失败数
- 面试官(人员)回填结果: `backfilled` / `skipped` / `failed`,若有 `unresolvedNames` 逐个列出(仅姓名,不带 open_id)
- 面试安排HR(人员)回填结果: `schedulingHr.backfilled` / `skipped` / `failed`,若有 `unresolved` 列出姓名与简短原因(不带 open_id)
- 上述每条简要信息
- JSON 的绝对保存路径
- 飞书 Base 链接
- 若有错误,列出阶段和简短错误原因

不要汇报逐字稿正文或红线原文(长文本挤对话)。评分细节可以直接说。没有今日记录时明确说"今日没有可导出的面试记录",仍报告采集状态、JSON 路径和 Base 链接。

## 成功路径 Runbook(定时任务作业模板)

以下是一次成功的定时任务骨架。定时提示词只需调用本 skill；报告阶段由本 skill 强制调用 `interviewer-review`，不需要也不得在定时提示词中再选第二个 skill。

1. 解析本 skill 与 `interviewer-review` 的绝对目录，确认后者的原版 `SKILL.md`、统计、渲染、校验和模板均存在。
2. 定位 lark-cli；Windows 上设 `chcp 65001` 与 `PYTHONIOENCODING=utf-8`。
3. 执行一次 `opencli moka export-transcripts --offline --output "<PATH>" --overwrite -f json`，取得今日全量 JSON。导出后确认顶层 `面试安排HR` 非空。
4. 先运行 `filter-notified-records.mjs`，仅保留 Base 中不存在相同「申请ID + 面试ID」且「是否已通知=是」历史行的 records；预筛失败立即中断。
5. 遍历预筛后的 records，严格执行 `interviewer-review` 的“统计 → analysis.json → 原版渲染 → 原版校验”流程；不通过校验的记录不得上传或回填 URL。
6. 读取配置中的报告文件夹 URL 并验证目标；根据本次顶层 `面试安排HR` 查询飞书通讯录且唯一匹配 owner。按 record 串行将通过校验的 `面试复盘报告-<面试官>-<候选人>.html` 上传到该目录，把真实 URL 写回同一条 record，并立即转移每份文件 owner 给本次面试安排 HR、回读核验。
7. 仅在所有 record 完成上述处理后，调用一次 `sync-lark-base.mjs`，然后 `deduplicate-lark-base.mjs`，最后以同一 JSON 路径调用 `backfill-interviewer-user.mjs --input "<PATH>"`；最后一步分别回填面试官人员与面试安排 HR 人员。

**成功判定**：导出、报告校验、每份 Drive 上传、每份文件 owner 转移与回读、sync、dedup、人员回填均须分别判断；其中报告必须以原版 `validate_report.py` 退出码 0 为准，上传必须取得飞书返回的真实 URL。没有今日记录不算失败；单条报告、上传或 owner 转移失败不阻断其他记录，但必须在汇总中体现。

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
| PowerShell `&&` 链接失败，报 `ParserError` | PowerShell 5.1 不支持 `&&` | 用 `;` 或 `if ($?) { ... }` 替代；本机 CLI/本 skill `.mjs` 仍走本地 `runCommand`，只有 `interviewer-review` 资源走 `execScript` |
| `python -c "f'{...}'"` 单行崩 SyntaxError | PowerShell 引号转义与 Python f-string 冲突 | **禁止 `python -c` 单行运行任何含 f-string 或多语句的代码**;写到 `.py` 临时文件再跑 |
| `node "scripts/xxx.mjs"` 找不到脚本 | 混用了两类执行器或未解析 Moka skill 路径 | Moka skill 自带 `.mjs` 用本地 `runCommand` + 已解析的绝对路径；`interviewer-review` 资源只通过其 `execScript` 调用，不指向本地仓库副本 |
| UI 长时间停在 `node ...extract_evidence.cjs` 且没有工具结果 | skill 执行器未返回，不代表本地 `opencli` 或 Cookie 异常 | 不生成替代脚本、不切到本地 `runCommand` 调用仓库副本；将本次报告阶段标记为工具执行失败并结束。重新触发任务时可复用已有 stats，但外部写入仍按正常去重规则执行 |
| 手误 `D:` 打成 `E:` | 无 | 每次向任一执行器传本地路径前肉眼核对盘符 |

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
| 配置缺少 `report_folder_url` 或 URL 不是当前租户的 Drive folder | 未选择报告目录/复制了文件、Wiki 或跨租户链接 | 中断上传并请 HR 在普通配置入口重新指定；绝不回退旧目录 |
| Drive 上传失败或缺少 scope | 当前飞书用户身份没有 Drive 上传权限，或用户指定目录未授予编辑权限 | 中断本次上传阶段并汇报，需 HR 补充用户授权或联系目录所有者授予编辑权限；定时任务不弹授权二维码、不换目标目录 |
| Moka `面试安排HR` 的飞书搜索无唯一匹配 | 通讯录同名/别名冲突、查不到或查询分页不完整 | 不猜 open_id、不改成面试官或历史接收人；保留已上传真实 URL，每份标记 owner 未转移 |
| owner 转移返回成功但回读文件 owner 不符 | 接口响应不足以证明转移已生效 | 视为 owner 转移失败单独汇报，保留文件 URL，不重复上传 |
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
| 用 lark-cli 内联 JSON 写 Base 字段时 field_not_found | Windows 命令行 UTF-8 传参编码链条太脆 | **禁止 Agent 直接调 lark-cli 写 Base 数据或删除记录**；只调 skill 提供的 `.mjs` 脚本。报告上传与 owner 转移按后处理-2 的飞书命令执行，参数中的 JSON 结构需保持正确编码 |
| Python `subprocess.run(lark_cli, encoding='utf-8')` stdout 是空的 | lark-cli 输出是 GBK,Python 强解 UTF-8 报错并把 stdout 吞了 | 别自己起 Python 调 lark-cli;直接调本 skill 的 `.mjs`(内部用 `spawn` + `setEncoding('utf8')` 已经处理) |
| `backfill-interviewer-user.mjs` 的 `search-user` 报 `positional arguments are not supported` | 姓名格式 `Iris Cheng （程冬芳）` 中的空格被 lark-cli 拆成位置参数 | **已修复**:脚本从括号中提取中文名搜索,不再用完整姓名 |
| `backfill-interviewer-user.mjs` 的 `record-upsert` 报 `invalid character 'é'` | Windows `spawn` + `shell:true` 经 cmd.exe 编码链路,中文字段名 `面试官 (人员 )` 被转成 GBK | **已修复**:脚本对所有 JSON payload 强制走 `@file` 模式 |

### 汇报

| 现象 | 处置 |
|---|---|
| 汇总时说"sync 全部成功",但实际每条都 failed | **必须**看 `created`/`failed`/`deduplicatedRecords` 三个字段。 `ok:true` 是必要非充分条件 |

## Agent 自查清单(每次入口开跑前默念)

进入任一定时入口前,**必须**在心里过一遍下面这份清单;违背任何一条基本都会踩坑:

- [ ] Skill 绝对路径已解析,后续 `.mjs` 全部用绝对路径调用。**注意 moka-transcriptV2 和 interviewer-review 是两个不同的 skill 目录**,各自的 `.mjs`/`.py` 用各自目录的绝对路径。
- [ ] lark-cli 绝对路径已解析,所有 `.mjs` 都追加 `--lark-cli "<绝对路径>"`。
- [ ] 已确认 `interviewer-review` skill 可访问；只用其原版统计、渲染、校验与模板，不使用旧 Moka HTML 生成器。
- [ ] 导出 JSON 顶层 `面试安排HR` 非空，且报告处理后仍原样保留；不得从面试官或逐字稿推断该值。
- [ ] 已在报告前运行 `filter-notified-records.mjs`；仅将 `remainingRecords` 交给后续链路。任何同「申请ID + 面试ID」且 Base「是否已通知=是」的 record 必须完全跳过。
- [ ] HTML 仅在原版校验通过后，使用当前飞书用户身份串行上传至用户配置且已核对的 Drive 文件夹；只接受上传响应返回的真实 URL。上传成功后立即转移 owner 给本次导出顶层 `面试安排HR` 唯一匹配的飞书用户，并回读验证 owner；不可使用面试官或固定 open_id。
- [ ] Windows 上已 `chcp 65001`,Python 子进程环境含 `PYTHONIOENCODING=utf-8`。Windows 上用 `python` 而非 `python3`。
- [ ] **禁止用 PowerShell `>` 或 `Set-Content -Encoding UTF8` 保存 Python stdout 生成的 JSON**（会加 BOM）；用 Python 子进程 `capture_output` + `open('w',encoding='utf-8')` 或 Node.js `fs.writeFileSync('utf-8')`。
- [ ] **禁止用 PowerShell `&&`**；用 `;` 或 `if ($?)` 替代。
- [ ] 报告文件名为 `面试复盘报告-<面试官>-<候选人>.html`，姓名来自 record 的结构化字段；只替换 Windows 非法字符。统计临时文件仍使用 ASCII 名称。
- [ ] 时间戳倒退不再阻断报告生成，`display_ts` 等于 `raw_ts`（绝对时间），无需前置检查 `span.valid`。
- [ ] **面试官说话人绑定**：Moka 展示姓名匹配失败时，从 `stats.speakers` 里找提问最多的说话人标签重新跑统计。`interviewer_speakers` 写转录 speaker 标签，不是 Moka 展示名。**多面试官时所有面试官 speaker 都要传入 `--interviewer`**。
- [ ] **每条记录必须通读逐字稿后再写 analysis.json**——不是只看统计摘要的首尾5轮。这是强制前置步骤,不可省略,不可因为串行处理就跳过。
- [ ] **写 analysis.json 前先做证据预分配**——从 stats.json 提取所有面试官轮次(chars≥40),规划每个 claim_id 用哪些 turn_index,全局不重复。不要先写后修。
- [ ] **analysis.json 事前自检清单**（写完后、调 render_report.py 之前逐条确认）：
  - 普通面试官行为证据属于面试官；`dialogue_chain` 包含候选人回答，`process_signal` 按信号引用前后边界
  - 每个亮点 2-3 段证据,每段 chars≥40
  - 普通改进项默认 2-3 段证据；`single_event` 可1段，`process_signal` 的真实边界短句允许低于长度门槛
  - 所有 turn_index 全局不重复(跨 claim_id 不复用)
  - 雷达≥3.5 的维度有对应 highlight;低分维度有对应 improvement
  - 倾听占比改进项只在面试官单人 share_pct>30 时写,多面试官不要手算合计
  - claim 和 summary 不含隐式触发词("开场""收尾""追问深度"等,见后处理-1 步骤D 的隐式触发表)
  - process_signals 里的每条 signal 都在改进项里被引用
  - badge_line 去 <em> 后 20-35 字
  - 红线策略已执行:enabled=true 时逐条处理 strong/weak；enabled=false 时 redlines/dismissed 均为空，短时长改用 duration_boundary
  - advice 恰好 4 条
- [ ] **--interviewer 参数传的是 stats.json speakers 的 key**(转录 speaker 标签),不是 Moka 展示名。多面试官可重复传。
- [ ] stats 证据摘要只用 `interviewer-review/scripts/extract_evidence.cjs`，每次一个本地 stats JSON，通过该 skill 的 `execScript` 调用；不临时生成 `.cjs`，不用本地 `runCommand` 指向仓库副本，也不用 `node -e` / `python -c`。
- [ ] sync 判成功用 `ok:true && created===deduplicatedRecords && failed===0`,不是只看 `ok`。
- [ ] 单次流水线只导出一次，**只调一次** sync-lark-base.mjs 和 deduplicate-lark-base.mjs。
- [ ] backfill-interviewer-user.mjs 在 dedup 之后执行且必须传 `--input <本次JSON>`；面试官从行内文本解析，面试安排 HR 从 JSON 顶层解析并只匹配本次联合键。失败/未解析姓名不阻塞汇报,把两类摘要附到汇总即可。
- [ ] 出现任何写入失败**不重跑整个流水线**——把 `errors` 附到汇总,让 HR 决定。
- [ ] **批量报告生成策略**：子代理只承担"读逐字稿→分析→写 analysis.json"，渲染和校验由自己串行跑。子代理返回后必须检查 analysis.json 完整性，空结果则自行接管，不停顿。**子代理不可用时由本 Agent 串行处理,不得降低质量标准。**
- [ ] **执行器边界正确**：`opencli moka`、CDP、`lark-cli` 和 Moka 自带 `.mjs` 使用本地 `lobe-local-system/runCommand`；只有 `interviewer-review` 随 skill 分发的脚本和模板通过 `execScript` 调用。Cookie 只由本地 `opencli` 内部读取。



- 只访问当前登录账号有权查看的数据。
- 不使用 mitmproxy 完成日常采集；不要求用户提供抓包或凭证。
- 不把 JSON 数据文件写进插件仓库或 Skill 目录。
- 候选人结构化数据只写入本 Skill 配置的飞书 Base；最终校验通过的 HTML 仅上传到用户在 `report_folder_url` 指定且当前身份可访问的 Drive folder，不上传或发送到其他位置。
- 对话汇报、自动化摘要、错误信息和调试日志中**不要输出**手机号、邮箱、身份证号或逐字稿正文。候选人及面试官**姓名可直接原文使用**——数据源是授权 HR 采集,姓名不做处理。
- 不因定时任务失败而重新安装工具、删除 Chrome Profile、删除飞书记录或清空 Base。
- 不直接重试脚本内部失败的写入操作；重新运行整个脚本即可。
- sync 脚本不保证无重复——重复由 dedup 脚本统一清理。
- dedup 脚本使用逐条删除（`+record-delete --record-id`），不使用 batch delete 接口——后者在实测中会静默失败。
- 不写入或维护面试官信息表（已废弃）；面试官姓名作为 text 写入「面试官」列，再解析回填「面试官(人员)」。面试安排 HR 没有 text 列，只从 JSON 顶层 `面试安排HR` 解析并回填「面试安排HR(人员)」。
- 默认 JSON 是单次中转文件，不承担历史存储。
