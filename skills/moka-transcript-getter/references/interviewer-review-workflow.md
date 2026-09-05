# 面试复盘评分与报告生成 — 当前 Claude 循环执行 workflow

本文件供 `moka-transcript-getter` skill 的定时入口第 2 段(每场评分 + 生成 HTML + 上传云盘 + 回填 JSON)使用。当前 Claude 在这一段里对每条 `record` 直接评分与生成报告,不启动 headless 子进程。

- 评分与写作的**详细 rubric、锚点、话术**在同目录 [`evaluation-guide.md`](evaluation-guide.md)、[`interview-toolkit.md`](interview-toolkit.md)、[`red-lines.md`](red-lines.md);本文件不重复,只列执行契约。
- 模板文件:[`../assets/report-template.html`](../assets/report-template.html) 与 [`../assets/logo.png`](../assets/logo.png)。
- 统计脚本:[`../scripts/transcript_stats.py`](../scripts/transcript_stats.py)。
- 上传脚本:[`../scripts/upload-html-to-drive.mjs`](../scripts/upload-html-to-drive.mjs)。

## 1. 遍历 records[] 的判定与准备

- 采集脚本产出的 `transcript.json` 顶层是 `CollectionResult`:`{ generatedAt, source, records[], errors, stats }`。评分只处理 `records[]`。
- 跳过条件(不评分、不生成报告、`reviewScores` 与 `reviewReportUrl` 均保持不存在):
  - `record.transcriptStatus !== "available"`
  - `record.transcript` 缺失或去空白后为空
- 处理条件下,取 `record.transcript`(逐字稿正文,已解码),按下面步骤依次执行。
- 报告目录:`<transcript.json 所在目录>/reports/`,不存在则创建。**不要**把报告写进本 skill 目录或插件仓库。

## 2. 逐字稿量化(transcript_stats.py)

- 把 `record.transcript` 写入 OS 临时目录的 `.txt`(文件名 **纯 ASCII**:`transcript-<interviewId>.txt`,评分完成后删除)。**脱敏候选人姓名只放 HTML 内容和日志文本,不进文件名**——文件名一律用 `interviewId` 唯一标识,规避 Windows PowerShell/GBK 环境下中文文件名 `spawn ENOENT`、`lark-cli drive +upload` 上传报错、跨端路径不可预测。
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
| `{{CANDIDATE}}` | 脱敏候选人姓名(中文姓氏保留 / 英文首字母保留) | 「候选人」 |
| `{{INTERVIEWER}}` | 脱敏面试官姓名 | 「面试官」 |
| `{{INTERVIEWER_INITIAL}}` | 面试官名字首字符(脱敏后) | 「?」 |
| `{{DATE}}` | 面试日期 `YYYY-MM-DD`(取 `record.startTime` 转北京时间) | `record.generatedAt` 或今日 |
| `{{ROUND}}` | 面试轮次(`record.roundName`) | 「未记录」 |
| `{{DIRECTION}}` | 岗位方向短标签(如「产品」「后端」) | `record.jobTitle` |
| `{{DIRECTION_FULL}}` | 完整岗位(`record.jobTitle`) | 「未记录」 |
| `{{DURATION_CN}}` | 中文时长(如「56 分钟」),从 stats 的 `span.duration_min` 换算 | 「未记录时长」 |
| `{{BADGE_SHORT}}` | 图标字符,固定 6 维 → `⚑ ? ≈ ◎ ⚖ ♥`;命中红线 → `▦` | 见 evaluation-guide §3 |
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

## 5. 上传飞书云盘 + 回填 JSON

- 执行 `node <skill目录>/scripts/upload-html-to-drive.mjs --file <html绝对路径>`。
- 需要额外传 lark-cli 路径时(定时任务里 PATH 缺失),用 `--lark-cli "<绝对路径>"`。
- 只要脚本退出码 0 且 stdout JSON `ok == true`,把 `url` 写入 `record.reviewReportUrl`。
- 上传失败:记录 `record.reviewError = <错误摘要>`,`reviewReportUrl` 不写,该 record 的报告本地保留供人工排查。
- 单条评分/上传失败不阻断其余 records。

## 6. 写回 JSON

- 处理完所有 records 后,**只重写一次** `<transcript.json>`,保留 `generatedAt` / `source` / `errors` / `stats` 原样,只在 `records[]` 中扩充新字段。
- `sync-lark-base.mjs` 通过 `record.reviewScores?.*` 与 `record.reviewReportUrl` 读入,无值时自动跳过对应飞书列。

## 7. 安全约束(与 SKILL.md 一致)

- **报告与临时文件名一律纯 ASCII**(`review-<interviewId>.html` / `transcript-<interviewId>.txt`),候选人和面试官姓名不进文件名。姓名只出现在 HTML 内容和日志文本里,且必须脱敏。不得输出手机/邮箱/身份证/逐字稿正文。
- 临时 `.txt` 和临时 HTML 只落 OS 临时目录或 `<json 目录>/reports/`,**不进** skill 目录、不进插件仓库。
- 云盘上传视为同租户内已授权 Base 相关流程,不视为新增外发;不上传到租户外的任何位置。
- 不为评分/上传失败重新安装工具、删除 Chrome Profile、清空 Base——按 SKILL.md 「安全与边界」处理。
