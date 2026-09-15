#!/usr/bin/env node

/**
 * generate-report.mjs — 一键生成面试官复盘 HTML 报告
 *
 * 把"复制模板 → 替换 18 个 token → 校验 → 输出 HTML 路径"封装为一个脚本。
 * Agent 只需读逐字稿 + 打分,把评分数据通过 --scores JSON 传入,剩下全自动。
 *
 * 用法:
 *   node generate-report.mjs \
 *     --json "<transcript.json 绝对路径>" \
 *     --interview-id "<interviewId>" \
 *     --scores '{"openingFlow":3.5,"questionQuality":4,"listening":4,"followUpDepth":4,"scaleControl":3.5,"feedbackExperience":3.5,"hallmarkBadge":"灵魂提问官","redLineHits":[]}' \
 *     --badge-line "运用 STAR 追问法,围绕核心胜任力层层深挖。" \
 *     --highlights '<JSON数组>' \
 *     --improves '<JSON数组>' \
 *     --advice '<JSON数组>' \
 *     [--template "<模板路径>"] \
 *     [--output-dir "<输出目录>"]
 *
 * 或用 --scores-file <path> 从文件读取评分 JSON(避免命令行过长)。
 * --highlights / --improves / --advice 同理支持 --highlights-file / --improves-file / --advice-file。
 *
 * 脚本自动:
 *   1. 从 --json 读取 record 元数据(candidateName, interviewerNames, jobTitle, roundName, startTime)
 *   2. 把 transcript 写入临时 txt,调 transcript_stats.py 拿统计
 *   3. 复制模板,替换全部 18 个 token
 *   4. 校验:无残留 token
 *   5. 输出 JSON: { ok, htmlPath, stats }
 *
 * 退出码: 0 = 成功; 非 0 = 失败。
 */

import { promises as fs } from "node:fs";
import fsSync from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_TEMPLATE = path.resolve(__dirname, "..", "assets", "report-template.html");
const DEFAULT_PYTHON = process.platform === "win32" ? "python" : "python3";
const STATS_SCRIPT = path.resolve(__dirname, "transcript_stats.py");

// ─── 参数解析 ────────────────────────────────────────────────
function parseArgs(argv) {
  var out = {
    json: null,
    interviewId: null,
    scores: null,
    scoresFile: null,
    badgeLine: "",
    highlights: null,
    highlightsFile: null,
    improves: null,
    improvesFile: null,
    advice: null,
    adviceFile: null,
    template: DEFAULT_TEMPLATE,
    outputDir: null,
    pythonCmd: DEFAULT_PYTHON,
  };
  for (var i = 2; i < argv.length; i++) {
    var a = argv[i];
    if (a === "--json") out.json = argv[++i];
    else if (a === "--interview-id") out.interviewId = argv[++i];
    else if (a === "--scores") out.scores = argv[++i];
    else if (a === "--scores-file") out.scoresFile = argv[++i];
    else if (a === "--badge-line") out.badgeLine = argv[++i];
    else if (a === "--highlights") out.highlights = argv[++i];
    else if (a === "--highlights-file") out.highlightsFile = argv[++i];
    else if (a === "--improves") out.improves = argv[++i];
    else if (a === "--improves-file") out.improvesFile = argv[++i];
    else if (a === "--advice") out.advice = argv[++i];
    else if (a === "--advice-file") out.adviceFile = argv[++i];
    else if (a === "--template") out.template = argv[++i];
    else if (a === "--output-dir") out.outputDir = argv[++i];
    else if (a === "--python") out.pythonCmd = argv[++i];
    else if (a === "-h" || a === "--help") {
      console.log("Usage: node generate-report.mjs --json <path> --interview-id <id> --scores '<json>' --badge-line '...' --highlights '<json>' --improves '<json>' --advice '<json>'");
      process.exit(0);
    }
  }
  return out;
}

function fail(msg, extra) {
  process.stdout.write(JSON.stringify(Object.assign({ ok: false, error: msg }, extra || {})) + "\n");
  process.exit(1);
}

function readJsonArg(direct, fileVar, args, varName) {
  if (direct) {
    try { return JSON.parse(direct); }
    catch (e) { fail("Invalid JSON in --" + varName + ": " + e.message); }
  }
  if (fileVar) {
    try { return JSON.parse(fsSync.readFileSync(fileVar, "utf8")); }
    catch (e) { fail("Cannot read --" + varName + "-file: " + e.message); }
  }
  return null;
}

// ─── KPI / 雷达图 / 亮点等 HTML 片段生成 ────────────────────
function genKPI(durationMin, ivShare, ivQuestions, candQuestions, redLineCount, isIntern) {
  var minChip = durationMin >= (isIntern ? 15 : 20) ? "good" : "bad";
  var minLabel = durationMin >= (isIntern ? 15 : 20) ? "达标" : "不足";
  var shareChip = ivShare <= 20 ? "good" : (ivShare <= 30 ? "warn" : "bad");
  var shareLabel = ivShare <= 20 ? "良好" : (ivShare <= 30 ? "偏高" : "超标");
  var refMin = isIntern ? "实习参考 20–30min · 下限 15min" : "正职参考 40–60min · 下限 20min";
  var redChip = redLineCount === 0 ? "good" : "bad";
  var redLabel = redLineCount === 0 ? "0 条" : redLineCount + " 条";
  return [
    '<div class="card kpi"><div class="kh"><span class="chip ' + minChip + '">' + minLabel + '</span><span class="lb">面试总时长</span></div><div class="val num">' + Math.round(durationMin) + '<span class="u">min</span></div><div class="ft">' + refMin + '</div></div>',
    '<div class="card kpi"><div class="kh"><span class="chip ' + shareChip + '">' + shareLabel + '</span><span class="lb">面试官说话占比</span></div><div class="val num">' + ivShare + '<span class="u">%</span></div><div class="track"><i style="width:' + ivShare + '%;background:#0a84ff"></i><div class="goal" style="left:20%"></div></div><div class="ft">目标 ≤20% · 候选人占 ' + (100 - ivShare).toFixed(1) + '%</div></div>',
    '<div class="card kpi"><div class="kh"><span class="chip good">正常</span><span class="lb">追问轮数</span></div><div class="val num">' + ivQuestions + '<span class="u">问</span></div><div class="ft">面试官提问 ' + ivQuestions + ' 次 · 候选人提问 ' + candQuestions + ' 次</div></div>',
    '<div class="card kpi"><div class="kh"><span class="chip ' + redChip + '">' + redLabel + '</span><span class="lb">红线命中</span></div><div class="val num">' + redLineCount + '<span class="u">条</span></div><div class="ft">' + (redLineCount === 0 ? "未触碰任何合规红线" : "命中合规红线，需注意") + '</div></div>'
  ].join("");
}

function genRadarRows(scores) {
  var dims = [
    { name: "开场与流程", score: scores.openingFlow },
    { name: "提问质量", score: scores.questionQuality },
    { name: "倾听", score: scores.listening },
    { name: "追问深度", score: scores.followUpDepth },
    { name: "尺度把控", score: scores.scaleControl },
    { name: "反馈体验", score: scores.feedbackExperience }
  ];
  return dims.map(function (d) {
    var pct = (d.score / 5 * 100).toFixed(0);
    var tag, cls;
    if (d.score >= 4) { tag = "强项"; cls = "up"; }
    else if (d.score >= 3) { tag = "不错"; cls = "mid"; }
    else { tag = "偏弱"; cls = "low"; }
    return '<div class="ri"><span class="nm">' + d.name + '</span><div class="bar"><i style="width:' + pct + '%"></i></div><span class="tg ' + cls + '">' + tag + '</span></div>';
  }).join("");
}

function genRadarJSON(scores) {
  return JSON.stringify([
    { name: "开场与流程", score: scores.openingFlow },
    { name: "提问质量", score: scores.questionQuality },
    { name: "倾听", score: scores.listening },
    { name: "追问深度", score: scores.followUpDepth },
    { name: "尺度把控", score: scores.scaleControl },
    { name: "反馈体验", score: scores.feedbackExperience }
  ]);
}

function genHighlights(hls) {
  if (!hls) return "";
  return hls.map(function (h) {
    var qs = (h.quotes || []).map(function (q) {
      return '<div class="q"><span class="ts">' + q.ts + '</span>' + q.text + '</div>';
    }).join("");
    return '<div class="card hl"><div class="tp"><span class="mk">' + (h.mk || "★") + '</span><b>' + h.title + '</b></div><span class="rb">' + h.rubric + '</span><p>' + h.desc + '</p>' + qs + '</div>';
  }).join("");
}

function genImproves(imps) {
  if (!imps) return "";
  return imps.map(function (im) {
    return '<tr><td><div class="ti"><span class="rmk">' + im.rmk + '</span>' + im.title + '</div><div class="de">' + im.desc + '</div></td><td class="rub">' + im.rubric + '</td><td class="ev"><span class="ts">' + im.ts + '</span>' + im.text + '</td></tr>';
  }).join("");
}

function genAdvice(ads) {
  if (!ads) return "";
  return ads.map(function (a) {
    return '<div class="card adv"><div class="ic">' + a.ic + '</div><b>' + a.title + '</b><p>' + a.desc + '</p></div>';
  }).join("");
}

function escHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// 把 **word** 里的 word 转成 <mark>word</mark>,其余字符全部按 HTML 实体转义。
// 用于在红线上下文的原话里高亮触发词。
function escHtmlWithMark(s) {
  var raw = String(s == null ? "" : s);
  var parts = raw.split(/\*\*([^*]+)\*\*/g); // 偶数下标 = 普通文本, 奇数下标 = mark 内容
  return parts.map(function (chunk, idx) {
    return idx % 2 === 1
      ? "<mark>" + escHtml(chunk) + "</mark>"
      : escHtml(chunk);
  }).join("");
}

// 渲染单条 evidence:
// - 若 q.context 是数组(≥1 行),按"上下文块"渲染 → 顶部时间戳+说话人,下方多行,hit:true 的行高亮;
// - 否则退回单行 { ts, text } 老结构,保持向后兼容。
function renderRedlineEv(q) {
  if (q && Array.isArray(q.context) && q.context.length > 0) {
    var headTs = escHtml(q.ts || (q.context.find(function (l) { return l && l.hit; }) || q.context[0]).ts || "");
    var headWho = q.speaker ? escHtml(q.speaker) : "";
    var lines = q.context.map(function (ln) {
      if (!ln) return "";
      var cls = ln.hit ? "ln hit" : "ln";
      var sp = ln.speaker ? '<span class="sp">' + escHtml(ln.speaker) + ':</span>' : "";
      var txt = ln.hit ? escHtmlWithMark(ln.text || "") : escHtml(ln.text || "");
      return '<div class="' + cls + '">' + sp + txt + '</div>';
    }).join("");
    return '<div class="ev ctx">'
      + '<div class="ctx-head"><span class="ts">' + headTs + '</span>'
      + (headWho ? '<span class="who">面试官 ' + headWho + '</span>' : '')
      + '</div>'
      + lines
      + '</div>';
  }
  return '<div class="ev"><span class="ts">' + escHtml(q.ts || "") + '</span>' + escHtml(q.text || "") + '</div>';
}

// 生成合规红线告警区块。details 为详细数组时,每条按 goodcase 的 rl-top+p+ev 结构渲染;
// 否则退回只用 redLineHits 字符串,给一个简版卡片。都没有 → 返回空串,整块不出现。
function genRedlineAlert(redLineHits, details) {
  if (details && Array.isArray(details) && details.length > 0) {
    var cards = details.map(function (d) {
      var quotes = d.quotes || (d.ts || d.text || d.context ? [{ ts: d.ts, text: d.text, context: d.context }] : []);
      var evs = quotes
        .filter(function (q) { return q && (q.ts || q.text || (Array.isArray(q.context) && q.context.length)); })
        .map(renderRedlineEv).join("");
      return '<div class="card redline">'
        + '<div class="rl-top"><span class="rl-chip">红线</span><span class="rl-title">' + escHtml(d.title || "涉及合规问题") + '</span></div>'
        + (d.desc ? '<p>' + escHtml(d.desc) + '</p>' : '')
        + evs
        + '</div>';
    }).join("");
    return '<div class="sec" id="redline"><h3>合规红线告警</h3><span class="line"></span></div>' + cards;
  }
  if (redLineHits && redLineHits.length > 0) {
    var title = "涉及" + redLineHits.map(escHtml).join("、") + "问题";
    return '<div class="sec" id="redline"><h3>合规红线告警</h3><span class="line"></span></div>'
      + '<div class="card redline">'
      + '<div class="rl-top"><span class="rl-chip">红线</span><span class="rl-title">' + title + '</span></div>'
      + '<p>本场面试触碰上述合规红线,建议 HR 复核相关时段原文并跟进面试官改进。</p>'
      + '</div>';
  }
  return "";
}

function getBadgeInfo(scores, redLineHits) {
  if (redLineHits && redLineHits.length > 0) {
    return {
      icon: "本场请注意",
      label: "本场请注意",
      name: "涉及" + redLineHits.join("、") + "问题",
    };
  }
  var dims = [
    { key: "openingFlow", badge: "破冰高手", icon: "破冰高手" },
    { key: "questionQuality", badge: "灵魂提问官", icon: "灵魂提问官" },
    { key: "listening", badge: "最佳听众", icon: "最佳听众" },
    { key: "followUpDepth", badge: "追问达人", icon: "追问达人" },
    { key: "scaleControl", badge: "分寸感在线", icon: "分寸感在线" },
    { key: "feedbackExperience", badge: "暖心体验官", icon: "暖心体验官" }
  ];
  var best = dims[0];
  for (var i = 0; i < dims.length; i++) {
    if (scores[dims[i].key] > scores[best.key]) best = dims[i];
  }
  return { icon: best.icon, label: "本场获得称号", name: best.badge };
}

function toBJTime(ts) {
  var d = new Date(ts);
  var bj = new Date(d.getTime() + 8 * 3600 * 1000);
  return bj.toISOString().substring(0, 16).replace("T", " ");
}

// ─── 主流程 ────────────────────────────────────────────────
async function main() {
  var args = parseArgs(process.argv);
  if (!args.json) fail("missing --json <transcript.json path>");
  if (!args.interviewId) fail("missing --interview-id");

  // 读取 scores
  var scoresRaw = readJsonArg(args.scores, args.scoresFile, args, "scores");
  if (!scoresRaw) fail("missing --scores or --scores-file");
  var scores = scoresRaw.scores || scoresRaw;
  var redLineHits = scoresRaw.redLineHits || scores.redLineHits || [];
  var redLineDetails = scoresRaw.redLineDetails || scores.redLineDetails || null;
  var hallmarkBadge = scoresRaw.hallmarkBadge || scores.hallmarkBadge;

  // 读取 highlights / improves / advice
  var highlights = readJsonArg(args.highlights, args.highlightsFile, args, "highlights");
  var improves = readJsonArg(args.improves, args.improvesFile, args, "improves");
  var advice = readJsonArg(args.advice, args.adviceFile, args, "advice");

  // 读取 transcript.json, 找到对应 record
  var data = JSON.parse(await fs.readFile(args.json, "utf8"));
  var record = data.records.find(function (r) { return String(r.interviewId) === String(args.interviewId); });
  if (!record) fail("interviewId " + args.interviewId + " not found in " + args.json);

  // 跳过空 transcript
  if (!record.transcript || !record.transcript.trim()) {
    fail("record " + args.interviewId + " has empty transcript, skip");
  }

  // 写临时 txt, 跑 stats
  var tmpFile = path.join(os.tmpdir(), "transcript-" + args.interviewId + ".txt");
  await fs.writeFile(tmpFile, record.transcript, "utf8");

  var statsResult;
  try {
    var stdout = execFileSync(args.pythonCmd, [STATS_SCRIPT, tmpFile, "--json"], {
      encoding: "utf8",
      timeout: 30000,
      env: Object.assign({}, process.env, { PYTHONIOENCODING: "utf-8" })
    });
    statsResult = JSON.parse(stdout);
  } catch (e) {
    // 删除临时文件
    try { await fs.unlink(tmpFile); } catch (_) {}
    fail("transcript_stats.py failed: " + (e.stderr || e.message));
  }

  // 删除临时 txt
  try { await fs.unlink(tmpFile); } catch (_) {}

  // 判断面试官: questions 最多的说话人 (通常面试官问最多)
  var speakers = statsResult.speakers || {};
  var speakerNames = Object.keys(speakers);
  var ivName = record.interviewerNames ? record.interviewerNames.join("、") : "面试官";
  var ivShare = 0, ivQuestions = 0, candQuestions = 0;

  // 尝试从 stats 中找面试官 (questions 最多的)
  var bestSpeaker = null;
  var bestQ = -1;
  for (var i = 0; i < speakerNames.length; i++) {
    var s = speakers[speakerNames[i]];
    if (s.questions > bestQ) { bestQ = s.questions; bestSpeaker = speakerNames[i]; }
  }
  if (bestSpeaker) {
    ivShare = speakers[bestSpeaker].share_pct;
    ivQuestions = speakers[bestSpeaker].questions;
  }
  // 候选人 questions = 其他说话人 questions 之和
  for (var j = 0; j < speakerNames.length; j++) {
    if (speakerNames[j] !== bestSpeaker) {
      candQuestions += speakers[speakerNames[j]].questions;
    }
  }

  var durationMin = statsResult.span ? statsResult.span.duration_min : 0;
  var isIntern = (record.jobTitle || "").indexOf("实习") > -1;

  // 生成 badge 信息
  var badge = getBadgeInfo(scores, redLineHits);

  // 读取模板
  var tpl = await fs.readFile(args.template, "utf8");

  // 替换 token
  var ivInitial = ivName.charAt(0) || "?";
  var date = toBJTime(record.startTime);
  var jobTitle = record.jobTitle || "未记录";
  var round = record.roundName || "未记录";

  var html = tpl
    .replace(/\{\{CANDIDATE\}\}/g, record.candidateName || "候选人")
    .replace(/\{\{INTERVIEWER\}\}/g, ivName)
    .replace(/\{\{INTERVIEWER_INITIAL\}\}/g, ivInitial)
    .replace(/\{\{DATE\}\}/g, date)
    .replace(/\{\{ROUND\}\}/g, round)
    .replace(/\{\{DIRECTION\}\}/g, jobTitle)
    .replace(/\{\{DIRECTION_FULL\}\}/g, jobTitle)
    .replace(/\{\{DURATION_CN\}\}/g, Math.round(durationMin) + " 分钟")
    .replace(/\{\{BADGE_ICON\}\}/g, badge.icon)
    .replace(/\{\{BADGE_LABEL\}\}/g, badge.label)
    .replace(/\{\{BADGE_NAME\}\}/g, badge.name)
    .replace(/\{\{BADGE_LINE\}\}/g, args.badgeLine || "本场面试中该维度表现最为亮眼。")
    .replace(/\{\{RADAR_DIMS_JSON\}\}/g, genRadarJSON(scores))
    .replace(/\{\{RADAR_SUMMARY_ROWS\}\}/g, genRadarRows(scores))
    .replace(/\{\{KPI_CARDS\}\}/g, genKPI(durationMin, ivShare, ivQuestions, candQuestions, redLineHits.length, isIntern))
    .replace(/\{\{HIGHLIGHT_CARDS\}\}/g, genHighlights(highlights))
    .replace(/\{\{REDLINE_ALERT\}\}/g, genRedlineAlert(redLineHits, redLineDetails))
    .replace(/\{\{IMPROVE_ROWS\}\}/g, genImproves(improves))
    .replace(/\{\{ADVICE_CARDS\}\}/g, genAdvice(advice));

  // 确定输出目录
  var outputDir = args.outputDir || path.join(path.dirname(args.json), "reports");
  await fs.mkdir(outputDir, { recursive: true });
  var htmlPath = path.join(outputDir, "review-" + args.interviewId + ".html");

  // 写 HTML
  await fs.writeFile(htmlPath, html, "utf8");

  // 校验: 无残留 token (排除注释里的字面量)
  var finalHtml = await fs.readFile(htmlPath, "utf8");
  var tokenCheck = finalHtml.match(/\{\{[A-Z_]+\}\}/g);
  // 过滤掉 HTML 注释里的字面量
  var realTokens = tokenCheck ? tokenCheck.filter(function(t) {
    var idx = finalHtml.indexOf(t);
    var before = finalHtml.substring(Math.max(0, idx - 100), idx);
    return !before.includes("<!--");
  }) : [];

  // CSS 方案下不再有 src="icon/ 引用，校验保留为 false
  var hasIconSrc = false;

  process.stdout.write(JSON.stringify({
    ok: true,
    htmlPath: htmlPath,
    interviewId: args.interviewId,
    candidateName: record.candidateName,
    durationMin: durationMin,
    ivShare: ivShare,
    ivQuestions: ivQuestions,
    candQuestions: candQuestions,
    badgeIcon: badge.icon,
    badgeName: badge.name,
    redLineHits: redLineHits,
    remainingTokens: realTokens.length,
    hasIconSrc: hasIconSrc,
    htmlSize: finalHtml.length,
    stats: {
      duration_min: durationMin,
      iv_share: ivShare,
      iv_q: ivQuestions,
      cand_q: candQuestions,
      turn_count: statsResult.turn_count
    }
  }) + "\n");
}

main().catch(function (e) {
  fail("unexpected: " + (e && e.message ? e.message : String(e)));
});
