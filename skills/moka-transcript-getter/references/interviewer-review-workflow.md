# 面试复盘评分与报告生成 — 当前 Claude 循环执行 workflow

本文件供 `moka-transcript-getter` skill 的定时入口第 2 段(每场评分 + 生成 HTML + 发布 artifact + 回填 JSON)使用。当前 Claude 在这一段里对每条 `record` 直接评分、生成报告、把 HTML 打包为自包含单文件 artifact 并发布,不启动 headless 子进程,不再走飞书云盘。

- 评分与写作的**详细 rubric、锚点、话术**在同目录 [`evaluation-guide.md`](evaluation-guide.md)、[`interview-toolkit.md`](interview-toolkit.md)、[`red-lines.md`](red-lines.md);本文件不重复,只列执行契约。
- 模板文件:[`../assets/report-template.html`](../assets/report-template.html) 与 [`../assets/logo.png`](../assets/logo.png)。
- 统计脚本:[`../scripts/transcript_stats.py`](../scripts/transcript_stats.py)。
- **报告生成脚本(一键)**:[`../scripts/generate-report.mjs`](../scripts/generate-report.mjs)。

## 0. 核心原则:用脚本,不要手写

**禁止 Agent 手写 HTML 片段、手写 JSON 配置文件、手写临时 Node 脚本来生成报告。** 所有"复制模板 → 替换 token → 跑 inline-badge-icon → 输出 HTML"的逻辑已封装在 `scripts/generate-report.mjs` 中。Agent 只需:

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

## 4. 生成 HTML(一键脚本)

调用 `generate-report.mjs`,脚本自动完成:复制模板 → 替换 18 个 token → 跑 inline-badge-icon → 校验无残留 → 输出 HTML 路径。

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
| `{{BADGE_ICON}}` | 图标 PNG 文件名 | 从 7 个 PNG 里选,脚本自动确定 |
| `{{BADGE_LABEL}}` | 「本场获得称号」或「本场请注意」 | 脚本自动确定 |
| `{{BADGE_NAME}}` | 称号名或「涉及XX问题」 | 脚本自动确定 |
| `{{BADGE_LINE}}` | 20–35 字亮点/红线陈述 | Agent 通过 `--badge-line` 传入 |
| `{{KPI_CARDS}}` | 4 张 KPI 卡片 | 脚本从 stats 自动生成 |
| `{{RADAR_DIMS_JSON}}` | 雷达图 6 维数据 | 脚本从 scores 自动生成 |
| `{{RADAR_SUMMARY_ROWS}}` | 6 行小结 | 脚本从 scores 自动生成 |
| `{{HIGHLIGHT_CARDS}}` | 3 张亮点卡片 | Agent 通过 `--highlights` 传入 |
| `{{IMPROVE_ROWS}}` | 「可以更好的地方」 | Agent 通过 `--improves` 传入 |
| `{{ADVICE_CARDS}}` | 4 张 next-step 建议 | Agent 通过 `--advice` 传入 |

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

## 5. 打包为 artifact 并发布 + 回填 JSON

- 当前 Claude 直接把 `generate-report.mjs` 输出的 HTML 文件全文作为**自包含单文件 artifact 发布**,拿到公开访问 URL。
- **不走飞书云盘**——旧方案不稳定,已弃用;URL 依旧写入 `record.reviewReportUrl`,与之前的 Base 「面试复盘报告」列语义一致。
- `generate-report.mjs` 已在内部调了 `inline-badge-icon.mjs`,HTML 里已无 `src="icon/`、无未替换的 `{{TOKEN}}`。
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
