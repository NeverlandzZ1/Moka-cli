# 面试复盘评分与报告生成 — 当前 Claude 循环执行 workflow

本文件供 `moka-transcript-getter` skill 的定时入口第 2 段(每场评分 + 生成 HTML + 发布 artifact + 回填 JSON)使用。当前 Claude 在这一段里对每条 `record` 直接评分、生成报告、把 HTML 打包为自包含单文件 artifact 并发布,不启动 headless 子进程,不再走飞书云盘。

- 评分与写作的**详细 rubric、锚点、话术**在同目录 [`evaluation-guide.md`](evaluation-guide.md)、[`interview-toolkit.md`](interview-toolkit.md)、[`red-lines.md`](red-lines.md);本文件不重复,只列执行契约。
- 模板文件:[`../assets/report-template.html`](../assets/report-template.html)。logo 和 badge 图标均为纯 CSS,无外部图片依赖。
- 统计脚本:[`../scripts/transcript_stats.py`](../scripts/transcript_stats.py)。
- **报告生成脚本(一键)**:[`../scripts/generate-report.mjs`](../scripts/generate-report.mjs)。

## 0. 核心原则:用脚本,不要手写

**禁止 Agent 手写 HTML 片段、手写 JSON 配置文件、手写临时 Node 脚本来生成报告。** 所有"复制模板 → 替换 token → 校验 → 输出 HTML"的逻辑已封装在 `scripts/generate-report.mjs` 中。Agent 只需:

1. 读逐字稿(用 `readFile` 分段读,或用 `node` 脚本提取)
2. 打六维分 + 判红线
3. 写亮点/可改进/建议的 HTML 片段数据(JSON 数组)
4. 把评分数据通过 `generate-report.mjs` 的参数传入,脚本自动完成剩余全部工作

**同样禁止在 PowerShell 里用 `node -e` 或 `python -c` 运行内联代码。** 一律用 `.cjs` / `.py` 脚本文件,或直接调 skill 自带的 `.mjs` 脚本。

## 1. 遍历 records[] 的判定与准备

- 采集脚本产出的 `transcript.json` 顶层是 `CollectionResult`:`{ generatedAt, source, records[], errors, stats }`。评分只处理 `records[]`。
- 跳过条件(不评分、不生成报告、`reviewScores` 与 `reviewReportUrl` 均保持不存在):
  - `record.transcriptStatus !== "available"`
  - `record.transcript` 缺失或去空白后为空
- 处理条件下,取 `record.transcript`(逐字稿正文,已解码),按下面步骤依次执行。
- 报告目录:`<transcript.json 所在目录>/reports/`,不存在则 `generate-report.mjs` 自动创建。**不要**把报告写进本 skill 目录或插件仓库。

## 2. 逐字稿量化(transcript_stats.py)

`generate-report.mjs` 内部自动完成:
- 把 `record.transcript` 写入 OS 临时目录的 `.txt`(文件名 **纯 ASCII**:`transcript-<interviewId>.txt`,评分完成后自动删除)。
- 执行 `python <skill目录>/scripts/transcript_stats.py <tmp.txt> --json`,拿到 JSON 统计。
- 若 turn 数为 0,脚本输出 `ok:false`,Agent 记 `record.reviewError`,不生成报告,继续下一条。

统计脚本不区分身份,面试官身份由脚本自动选取(questions 最多的说话人),Agent 无需手动判断。

## 3. 六维打分 + 红线检测

- 六维、锚点、精度全部按 [`evaluation-guide.md`](evaluation-guide.md) §2 执行。精度 0.5,范围 0–5。
- 红线库见 [`red-lines.md`](red-lines.md):命中任意一条红线时,对应维度记 **0 分**,不受其他表现影响;整份报告的 badge 状态切到「本场请注意」(见下)。
- Agent 打分后,把评分数据传给 `generate-report.mjs` 的 `--scores` 参数(或 `--scores-file` 从文件读取):

```json
{
  "openingFlow": 3.5,
  "questionQuality": 4,
  "listening": 4,
  "followUpDepth": 4,
  "scaleControl": 3.5,
  "feedbackExperience": 3.5,
  "hallmarkBadge": "灵魂提问官",
  "redLineHits": []
}
```

- `hallmarkBadge`、`redLineHits` 供本地日志与调试;飞书 Base 只消费前 6 个数值字段。
- **命中红线时必须额外产出 `redLineDetails` 富结构**——只给 `redLineHits` 字符串数组会让红线告警栏走"兜底文案",没有原话证据,违背 evaluation-guide.md §5 的"每一条判断都要挂原话证据"。契约见下节 §3.1。

### 3.1 命中红线时的富数据结构(`redLineDetails`)

命中任一红线时,除 `redLineHits: ["询问薪资", ...]` 外,再产出 `redLineDetails: [...]` 挂给 `record.reviewScores`。**每条红线一个对象**,结构:

```json
{
  "redLineHits": ["询问薪资"],
  "redLineDetails": [
    {
      "title": "涉及询问薪资问题",
      "desc": "面试官在中段主动询问期望薪资并试图压价,属于 red-lines.md §1 主动问薪红线。",
      "quotes": [
        {
          "ts": "00:15:40",
          "speaker": "张三",
          "context": [
            { "ts": "00:15:12", "speaker": "候选人", "text": "上一段主要负责风控策略这块。" },
            { "ts": "00:15:28", "speaker": "面试官", "text": "嗯这块之前聊过了。" },
            { "ts": "00:15:40", "speaker": "面试官", "text": "**你期望薪资是多少?我们好评估一下**,你上家公司给你开多少?", "hit": true },
            { "ts": "00:15:58", "speaker": "候选人", "text": "呃……方便先介绍下岗位职级吗?" }
          ]
        }
      ]
    }
  ]
}
```

- **`quotes[]` 每条 = 一个"证据段"**,一条红线可挂 1~3 段(避免同一措辞反复挂;性质上只出现一次的事件挂 1 段就够)。
- **`context[]` 是围绕触发句前后的 2~4 条相邻发言**(理想:前 1~2 条 + hit 行 + 后 1 条),让 HR 一眼看清"这话是在什么话头下说的",而不是孤零零一句。
  - 每条上下文必给 `ts`(时间戳) + `speaker`(说话人名) + `text`(原话)。
  - **恰好一条**打 `"hit": true` 标记触发红线的锚句,渲染成红色高亮块;其余为暗淡的上下文。
  - 触发句 `text` 里可用 `**...**` 语法把关键词包起来(如 `**期望薪资是多少**`),渲染为 `<mark>` 高亮;非 hit 行的 `**` 不参与高亮(照原文出)。
- **顶部 `ts` / `speaker`**:整段的锚定时间与面试官显示名,取 hit 行的值即可,便于卡头显示。
- **`title`**:一句话主题,格式建议"涉及 XX 问题",跟 badge 名对得上。
- **`desc`**:1~2 句客观陈述——命中了哪条 red-lines 类别、判定要点是什么。**不写"需要 HR 复核"这种把责任推给下一步流程的话**(见 evaluation-guide.md §0)。
- 兼容:`redLineHits` 仍然要写,`sync-lark-base.mjs` 的「是否标红」列继续从它派生;`redLineDetails` 缺失时 `{{REDLINE_ALERT}}` 会走兜底简版,不会报错但不推荐。

## 4. 生成 HTML(一键脚本)

调用 `generate-report.mjs`,脚本自动完成:复制模板 → 替换 18 个 token → 校验无残留 → 输出 HTML 路径。

### 18 个 token

| Token | 含义 | 数据来源 |
|---|---|---|
| `{{CANDIDATE}}` | 候选人姓名(原文) | `record.candidateName` |
| `{{INTERVIEWER}}` | 面试官姓名(原文) | `record.interviewerNames` join |
| `{{INTERVIEWER_INITIAL}}` | 面试官名字首字符 | 自动取首字符 |
| `{{DATE}}` | 面试日期时间 | `record.startTime` 转北京时间 |
| `{{ROUND}}` | 面试轮次 | `record.roundName` |
| `{{DIRECTION}}` | 岗位名称 | `record.jobTitle` |
| `{{DIRECTION_FULL}}` | 完整岗位 | `record.jobTitle` |
| `{{DURATION_CN}}` | 中文时长 | 从 stats 的 `span.duration_min` 换算 |
| `{{BADGE_ICON}}` | 图标 CSS 类名后缀 | 从 7 档 CSS 类中选,脚本自动确定 |
| `{{BADGE_LABEL}}` | 「本场获得称号」或「本场请注意」 | 脚本自动确定 |
| `{{BADGE_NAME}}` | 称号名或「涉及XX问题」 | 脚本自动确定 |
| `{{BADGE_LINE}}` | 20–35 字的具体亮点/红线陈述,**必须挂原话证据**,写这场里该维度**具体做对/触碰了什么**,带细节,不是套话 | Agent 通过 `--badge-line` 传入 |
| `{{KPI_CARDS}}` | 4 张 KPI 卡片 HTML 片段(时长 / 面试官占比 / 追问轮数 / 亮点+红线数量) | 脚本从 stats 自动生成 |
| `{{RADAR_DIMS_JSON}}` | 雷达图 6 维数据 JSON(不显示分数,只显示形状+档位词) | 脚本从 scores 自动生成 |
| `{{RADAR_SUMMARY_ROWS}}` | 6 行小结,每行「维度 + 档位词 + 一句证据」 | 脚本从 scores 自动生成 |
| `{{HIGHLIGHT_CARDS}}` | **3 张**亮点卡片,每张 1 个正向行为 + **原话证据(带时间戳)**,`title` 是行为标签、`rubric` 是对应的六维名、`desc` 是 1–2 句现象描述、`quotes` 至少 1 条原话切片 | Agent 通过 `--highlights` 传入 |
| `{{IMPROVE_ROWS}}` | **4 条**「可以更好的地方」,每条含**现象 / 影响 / 落地建议**三段式,措辞对事不对人;`title` 是可改进点、`desc` 展开现象+影响+建议、`rubric` 对应六维名、`ts`+`text` 挂**原话证据** | Agent 通过 `--improves` 传入 |
| `{{ADVICE_CARDS}}` | **4 张** next-step 建议卡,面向**下一场如何调整**,不是复述本场问题;`title` 是动作短句、`desc` 是具体做法(1–2 句可执行) | Agent 通过 `--advice` 传入 |

### 调用方式

```text
node "<Skill目录>/scripts/generate-report.mjs" \
  --json "<transcript.json 绝对路径>" \
  --interview-id "<interviewId>" \
  --scores '{"openingFlow":3.5,"questionQuality":4,...,"redLineHits":[]}' \
  --badge-line "运用 STAR 追问法,围绕核心胜任力层层深挖。" \
  --highlights '[{"mk":"★","title":"...","rubric":"...","desc":"...","quotes":[{"ts":"00:26:47","text":"..."}]}]' \
  --improves '[{"rmk":"1","title":"...","desc":"...","rubric":"...","ts":"00:05:12","text":"..."}]' \
  --advice '[{"ic":"1","title":"...","desc":"..."}]'
```

当参数过长时,改用 `--scores-file` / `--highlights-file` / `--improves-file` / `--advice-file` 从文件读取。

**成功判定**:退出码 0 且 stdout JSON `ok:true`。输出包含 `htmlPath`、`htmlSize`、`remainingTokens`(应为 0)、`hasIconSrc`(应为 false)。

- 「亮点/可改进」条数用户已定为 3 亮点 + 4 可改进 + 4 next-step;数量不足时也要凑齐,允许弱项复用同一原文证据,不允许空卡片。
- 打分低的维度必须在「可以更好的地方」有对应条目,打分高的必须在「亮点」有对应条目——雷达和正文互证。
- 红线情况:红线的原话证据全部放到 §3.1 的 `redLineDetails.quotes[].context` 里,由独立的 `{{REDLINE_ALERT}}` 区块渲染,**不再复述到 `{{IMPROVE_ROWS}}` 首条也不再灌到 `{{BADGE_LINE}}` 的上下文里**——独立区块已经在报告最醒目位置。`{{BADGE_*}}` 走"本场请注意"分支,`{{BADGE_LINE}}` 只给一句 20-35 字的陈述性总结(如"这场提到了候选人的婚育计划,出现了歧视性提问");红线维度对应的 `{{HIGHLIGHT_CARDS}}` 不发正向卡片,腾出来给其他维度;`{{IMPROVE_ROWS}}` 里放非红线的普通改进项。

## 5. 打包为 artifact 并发布 + 回填 JSON

- 当前 Claude 直接把 `generate-report.mjs` 输出的 HTML 文件全文作为**自包含单文件 artifact 发布**,拿到公开访问 URL。
- **不走飞书云盘**——旧方案不稳定,已弃用;URL 依旧写入 `record.reviewReportUrl`,与之前的 Base 「面试复盘报告」列语义一致。
- HTML 里已无未替换的 `{{TOKEN}}`。badge 和 logo 均为纯 CSS,无外部图片依赖。
- **Artifact 发布成功路径**(2026-09-14 验证通过):
  1. `generate-report.mjs` 产出的 HTML 是纯 CSS 自包含单文件(约 15-25KB),所有行均在 8000 字符以内,`readFile` 可完整读取。
  2. Agent 用 `readFile` 读取完整 HTML(若超过 200 行分两次读取拼接)。
  3. 在对话中用 `<lobeArtifact>` 标签输出完整 HTML(`type="text/html"`,`identifier="review-<interviewId>"`)。
  4. 调用 `publishArtifact` 工具发布,获得公开 URL。
  5. **多份报告可并行发布**:用 `callSubAgent` 派发子代理,每个子代理读一份 HTML + 输出 artifact + 发布,timeout 120s。
  6. **artifact URL 需单独回填飞书 Base**:sync 在 artifact 发布前就跑了,URL 不会自动写入。发布完成后用 `tripyoyo-feishu-cli` 的 `run` API(`base +record-upsert --json @./file.json`)逐条回填「面试复盘报告」列。
- 成功: `record.reviewReportUrl = <artifact 公开 URL>`。
- 失败: `record.reviewError = "artifact publish failed: <简短原因>"`,`reviewReportUrl` 不写,该 record 的本地 HTML 保留供人工排查,继续下一条。
- 单条评分/发布失败不阻断其余 records。

## 6. 写回 JSON

- 处理完所有 records 后,**只重写一次** `<transcript.json>`,保留 `generatedAt` / `source` / `errors` / `stats` 原样,只在 `records[]` 中扩充新字段。
- `sync-lark-base.mjs` 通过 `record.reviewScores?.*` 与 `record.reviewReportUrl` 读入,无值时自动跳过对应飞书列。

## 7. 安全约束(与 SKILL.md 一致)

- **报告与临时文件名一律纯 ASCII**(`review-<interviewId>.html` / `transcript-<interviewId>.txt`),候选人和面试官姓名不进文件名——**这是 Windows/编码/artifact 发布的技术兼容要求,不是脱敏**。姓名在 HTML 内容和日志文本里原文使用。不得输出手机/邮箱/身份证/逐字稿正文。
- 临时 `.txt` 和临时 HTML 只落 OS 临时目录或 `<json 目录>/reports/`,**不进** skill 目录、不进插件仓库。
- artifact 发布获得的公开 URL 允许在同租户内已授权范围传播;不额外发送到其他位置。
- 不为评分/发布失败重新安装工具、删除 Chrome Profile、清空 Base——按 SKILL.md 「安全与边界」处理。
