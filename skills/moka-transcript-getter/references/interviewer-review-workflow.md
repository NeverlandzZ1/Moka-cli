# 面试复盘评分与报告生成 — 当前 Claude 循环执行 workflow

本文件供 `moka-transcript-getter` skill 的定时入口第 2 段(每场评分 + 生成 HTML + 发布 artifact + 回填 JSON)使用。当前 Claude 在这一段里对每条 `record` 直接评分、生成报告、把 HTML 打包为自包含单文件 artifact 并发布,不启动 headless 子进程,不再走飞书云盘。

- 评分与写作的**详细 rubric、锚点、话术**在同目录 [`evaluation-guide.md`](evaluation-guide.md)、[`interview-toolkit.md`](interview-toolkit.md)、[`red-lines.md`](red-lines.md);本文件不重复,只列执行契约。
- 模板文件:[`../assets/report-template.html`](../assets/report-template.html) 与 [`../assets/logo.png`](../assets/logo.png)。
- 统计脚本:[`../scripts/transcript_stats.py`](../scripts/transcript_stats.py)。

## 1. 遍历 records[] 的判定与准备

- 采集脚本产出的 `transcript.json` 顶层是 `CollectionResult`:`{ generatedAt, source, records[], errors, stats }`。评分只处理 `records[]`。
- 跳过条件(不评分、不生成报告、`reviewScores` 与 `reviewReportUrl` 均保持不存在):
  - `record.transcriptStatus !== "available"`
  - `record.transcript` 缺失或去空白后为空
- 处理条件下,取 `record.transcript`(逐字稿正文,已解码),按下面步骤依次执行。
- 报告目录:`<transcript.json 所在目录>/reports/`,不存在则创建。**不要**把报告写进本 skill 目录或插件仓库。

## 2. 逐字稿量化(transcript_stats.py)

- 把 `record.transcript` 写入 OS 临时目录的 `.txt`(文件名 **纯 ASCII**:`transcript-<interviewId>.txt`,评分完成后删除)。**候选人姓名不进文件名**——文件名一律用 `interviewId` 唯一标识,原因是 Windows PowerShell/GBK 环境下中文文件名容易 `spawn ENOENT`、跨端路径不可预测,且 artifact 发布时也更倾向纯 ASCII。**这是纯技术兼容要求,与脱敏无关**;姓名会在 HTML 内容里原文显示。
- 执行:`python3 <skill目录>/scripts/transcript_stats.py <tmp.txt> --json`,拿到 JSON 统计。
- 若 turn 数为 0(脚本没识别到说话人,通常是逐字稿格式异常),视为评分失败,写 `record.reviewError = "transcript_stats parsed 0 turns"`,不生成报告,不 upload,继续下一条。
- 统计脚本不区分身份,面试官身份由当前 Claude 从内容判断(开场自称面试官 / 主要在问问题的一方)。

## 3. 六维打分 + 红线检测

- 六维、锚点、精度全部按 [`evaluation-guide.md`](evaluation-guide.md) §2 执行。精度 0.5,范围 0–5。
- 红线库见 [`red-lines.md`](red-lines.md):命中任意一条红线时,对应维度记 **0 分**,不受其他表现影响;整份报告的 badge 状态切到「本场请注意」(见下)。
- 记录到 `record.reviewScores`(字段名与飞书列一一对应):

```json
{
  "reviewScores": {
    "openingFlow": 0-5(0.5 精度),
    "questionQuality": 0-5,
    "listening": 0-5,
    "followUpDepth": 0-5,
    "scaleControl": 0-5,
    "feedbackExperience": 0-5,
    "hallmarkBadge": "追问达人 / … / 涉及XX问题",
    "redLineHits": ["隐私", …]
  }
}
```

- `hallmarkBadge`、`redLineHits` 供本地日志与调试;飞书 Base 只消费前 6 个数值字段。

## 4. 生成 HTML(模板 token 全部替换)

复制 `assets/report-template.html` 到 `reports/review-<interviewId>.html`(**纯 ASCII 文件名**,不带候选人姓名),替换 18 个 token:

| Token | 含义 | 空值兜底 |
|---|---|---|
| `{{CANDIDATE}}` | 候选人姓名(原文,不做处理) | 「候选人」 |
| `{{INTERVIEWER}}` | 面试官姓名(原文,不做处理) | 「面试官」 |
| `{{INTERVIEWER_INITIAL}}` | 面试官名字首字符(取姓名第一个字符即可) | 「?」 |
| `{{DATE}}` | 面试日期 `YYYY-MM-DD`(取 `record.startTime` 转北京时间) | `record.generatedAt` 或今日 |
| `{{ROUND}}` | 面试轮次(`record.roundName`) | 「未记录」 |
| `{{DIRECTION}}` | 岗位方向短标签(如「产品」「后端」) | `record.jobTitle` |
| `{{DIRECTION_FULL}}` | 完整岗位(`record.jobTitle`) | 「未记录」 |
| `{{DURATION_CN}}` | 中文时长(如「56 分钟」),从 stats 的 `span.duration_min` 换算 | 「未记录时长」 |
| `{{BADGE_ICON}}` | 图标 PNG 文件名(不含目录,模板里通过 `<img src="icon/{{BADGE_ICON}}">` 引用):`破冰高手.png` / `灵魂提问官.png` / `最佳听众.png` / `追问达人.png` / `分寸感在线.png` / `暖心体验官.png`;命中红线固定填 `本场请注意.png` | 见 evaluation-guide §3 |
| `{{BADGE_LABEL}}` | 「本场获得称号」或(红线)「本场请注意」 | — |
| `{{BADGE_NAME}}` | 6 维称号(见 evaluation-guide §3 表)或「涉及XX问题」 | — |
| `{{BADGE_LINE}}` | 20–35 字的具体亮点/红线陈述,必须挂原话证据 | — |
| `{{KPI_CARDS}}` | 4 张 KPI 卡片 HTML 片段(时长 / 面试官占比 / 追问轮数 / 亮点+红线数量) | — |
| `{{RADAR_DIMS_JSON}}` | 雷达图 6 维数据 JSON(不显示分数,只显示形状+档位词) | — |
| `{{RADAR_SUMMARY_ROWS}}` | 6 行小结,每行「维度 + 档位词 + 一句证据」 | — |
| `{{HIGHLIGHT_CARDS}}` | 3 张亮点卡片,每张 1 个正向行为 + 原话证据 | — |
| `{{IMPROVE_ROWS}}` | 4 条「可以更好的地方」,每条含现象 / 影响 / 落地建议,措辞对事不对人 | — |
| `{{ADVICE_CARDS}}` | 4 张 next-step 建议卡,面向下一场如何调整 | — |

- 「亮点/可改进」条数用户已定为 3 亮点 + 4 可改进 + 4 next-step;数量不足时也要凑齐,允许弱项复用同一原文证据,不允许空卡片。
- 打分低的维度必须在「可以更好的地方」有对应条目,打分高的必须在「亮点」有对应条目——雷达和正文互证。
- 红线情况:除了改 `{{BADGE_*}}` 外,红线告警区块由模板固有 `#redline-alert`(如存在)控制。若模板里没有独立区块,把红线陈述并入 `{{BADGE_LINE}}` 与 `{{IMPROVE_ROWS}}` 首条。
- 替换完成后 **grep `{{[A-Z_]+}}` 应无剩余 token**(HTML 顶部注释里如残留字面量示例除外)。
- **badge PNG 内联**:模板里写的是 `<img src="icon/{{BADGE_ICON}}">` 的相对路径,但 artifact 是**自包含单文件 HTML**——旁边拿不到 `icon/` 目录,不做内联就会图片破损。生成 HTML 时(替换 token 后、发布 artifact 前)必须把该 `<img>` 的 `src` 改写成 `data:image/png;base64,<...>`,PNG 源文件来自 `assets/icon/<BADGE_ICON>`。**不要**尝试用 Read 工具读 PNG 再手工拼 base64——Read 拿到的是图像内容不是文本,拼不回去,历史踩坑就是这个导致 icon 常年画不上。**统一走脚本**:

```text
node "<Skill目录>/scripts/inline-badge-icon.mjs" --file "<HTML绝对路径>"
```

  - 退出码 0 且 stdout JSON `ok:true` 才算成功;失败时 stdout 会打印 `error` 字段,直接把 `record.reviewError = "inline-badge-icon failed: <error>"`,不发布 artifact,进下一条。
  - 脚本用正则精确匹配 `<img ... src="icon/xxx.png" ...>`,读 `assets/icon/xxx.png` 转 base64 后**就地重写 HTML 文件**。执行完 HTML 里应再无 `icon/` 前缀。

## 5. 打包为 artifact 并发布 + 回填 JSON

- 当前 Claude 直接把已完成 token 替换 + badge base64 内联的单文件 HTML **打包为自包含单文件 artifact 并发布**,拿到公开访问 URL。
- **不走飞书云盘**——旧方案不稳定,已弃用;URL 依旧写入 `record.reviewReportUrl`,与之前的 Base 「面试复盘报告」列语义一致。
- 发布前再校验:HTML 里不含 `<img src="icon/`,不含未替换的 `{{TOKEN}}`(header 注释里的字面量除外)。
- 成功: `record.reviewReportUrl = <artifact 公开 URL>`。
- 失败: `record.reviewError = "artifact publish failed: <简短原因>"`,`reviewReportUrl` 不写,本地 HTML 保留供人工排查。
- 单条评分/发布失败不阻断其余 records。

## 6. 写回 JSON

- 处理完所有 records 后,**只重写一次** `<transcript.json>`,保留 `generatedAt` / `source` / `errors` / `stats` 原样,只在 `records[]` 中扩充新字段。
- `sync-lark-base.mjs` 通过 `record.reviewScores?.*` 与 `record.reviewReportUrl` 读入,无值时自动跳过对应飞书列。

## 7. 安全约束(与 SKILL.md 一致)

- **报告与临时文件名一律纯 ASCII**(`review-<interviewId>.html` / `transcript-<interviewId>.txt`),候选人和面试官姓名不进文件名——**这是 Windows/编码/artifact 发布的技术兼容要求,不是脱敏**。姓名在 HTML 内容和日志文本里原文使用。不得输出手机/邮箱/身份证/逐字稿正文。
- 临时 `.txt` 和临时 HTML 只落 OS 临时目录或 `<json 目录>/reports/`,**不进** skill 目录、不进插件仓库。
- artifact 发布获得的公开 URL 允许在同租户内已授权范围传播;不额外发送到其他位置。
- 不为评分/发布失败重新安装工具、删除 Chrome Profile、清空 Base——按 SKILL.md 「安全与边界」处理。
