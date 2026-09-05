#!/usr/bin/env python3
"""
transcript_stats.py —— 面试转录解析 + 量化统计

用法:
    python3 transcript_stats.py <转录文件>            # 打印干净文本 + JSON 统计
    python3 transcript_stats.py <转录文件> --json     # 只输出 JSON
    python3 transcript_stats.py <转录文件> --text     # 只输出解码后的干净文本

支持:
    - RTF (.rtf / 伪装成 .md 的 RTF，飞书 / 备忘录导出常见)：解码 \\uXXXX
    - 格式 A（单行）："说话人(HH:MM:SS): 内容"
    - 格式 B（Moka 导出常见，两行一组）："说话人 YYYY-MM-DD HH:MM:SS" 单独一行，
      内容紧跟在下一行（可能多行，直到下一个说话人行）。自动过滤
      "会议已开启/关闭实时转写" 系统提示行和 "### 分段N" 分段标记行。
    两种格式自动识别，不用手动指定。说话人姓名可以带括号里的中文名
    （如 "Olivia Chen (陈惠馨)"），不受字符数限制误伤。

输出的 JSON 里每个说话人给出：turns(轮次) / chars(字数) / questions(问号数) /
share(占比%) / longest(最长几段的时间戳+字数)，以及总时长 span.start/end/duration_min(分钟)。
**谁是面试官由你根据内容判断**（说"我是面试官/你先自我介绍"的那位），脚本不做身份归属。
"""
import sys, re, json


def decode_rtf(src: str) -> str:
    """把 RTF 里的 \\uXXXX 转义解码成可读文本，剥掉控制字。"""
    s = re.sub(r'\\uc0', '', src)
    s = re.sub(r'\\u(\d+)\s?', lambda m: chr(int(m.group(1))), s)   # \u23569 -> 字
    s = re.sub(r'\\[a-zA-Z]+-?\d* ?', '', s)                         # 剥控制字 \paperw...
    s = s.replace('\\\n', '\n').replace('{', '').replace('}', '')
    s = re.sub(r'\\', '', s)
    return s


NOISE_LINE = re.compile(
    r'^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\s+(会议已开启实时转写|主持人(关闭|开启)实时转写)'
)
SEGMENT_MARK = re.compile(r'^#+\s*分段\s*\d*\s*$')


def clean(src: str) -> str:
    if src.lstrip().startswith('{\\rtf'):
        src = decode_rtf(src)
    lines = [l.strip() for l in src.splitlines() if l.strip()]
    # 丢掉 RTF 残留的表头行（字体表 / 颜色表）
    lines = [l for l in lines if not re.match(r'^[\w\-]+;+$', l) and l not in (';;;', '*;;;')]
    lines = [l for l in lines if 'Times-Roman' not in l]
    # 丢掉 Moka/会议系统的转写开关提示行、分段标记行
    lines = [l for l in lines if not NOISE_LINE.match(l) and not SEGMENT_MARK.match(l)]
    return '\n'.join(lines)


# 格式 A："说话人(HH:MM:SS): 内容" 单行
LINE_A = re.compile(r'^(.{1,40}?)[\(（](\d\d:\d\d:\d\d)[\)）]\s*[:：]?\s*(.*)$')

# 格式 B 表头："说话人 YYYY-MM-DD HH:MM:SS"，独占一行，内容在后续行
HEADER_B = re.compile(r'^(.{1,40}?)\s+\d{4}-\d\d-\d\d\s+(\d\d:\d\d:\d\d)\s*$')


def parse_turns(text: str):
    """解析成 [{who, ts, text}]；先试格式 A，命中太少再试格式 B。"""
    lines = text.splitlines()

    turns_a = []
    for l in lines:
        m = LINE_A.match(l)
        if m:
            turns_a.append({"who": m.group(1).strip(), "ts": m.group(2), "text": m.group(3)})
    if len(turns_a) >= 2:
        return turns_a

    turns_b = []
    cur = None
    for l in lines:
        m = HEADER_B.match(l)
        if m:
            if cur is not None:
                turns_b.append(cur)
            cur = {"who": m.group(1).strip(), "ts": m.group(2), "text": ""}
        elif cur is not None:
            cur["text"] = (cur["text"] + " " + l).strip()
    if cur is not None:
        turns_b.append(cur)
    return turns_b


def sec(ts: str) -> int:
    h, m, s = ts.split(':')
    return int(h) * 3600 + int(m) * 60 + int(s)


def make_span(turns):
    if not turns:
        return None
    span = {"start": turns[0]["ts"], "end": turns[-1]["ts"]}
    span["duration_min"] = round((sec(span["end"]) - sec(span["start"])) / 60, 1)
    return span


def stats(text: str) -> dict:
    parsed = parse_turns(text)
    speakers = {}
    turns = []
    for t in parsed:
        who, ts, txt = t["who"], t["ts"], t["text"]
        s = speakers.setdefault(who, {"turns": 0, "chars": 0, "questions": 0})
        s["turns"] += 1
        s["chars"] += len(txt)
        s["questions"] += txt.count('?') + txt.count('？')
        turns.append({"who": who, "ts": ts, "chars": len(txt)})

    total = sum(s["chars"] for s in speakers.values()) or 1
    for who, s in speakers.items():
        s["share_pct"] = round(s["chars"] / total * 100, 1)
        s["longest"] = sorted(
            [{"ts": t["ts"], "chars": t["chars"]} for t in turns if t["who"] == who],
            key=lambda x: -x["chars"])[:5]

    return {
        "speakers": speakers,
        "total_chars": total,
        "span": make_span(turns),
        "turn_count": len(turns),
    }


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    flags = {a for a in sys.argv[1:] if a.startswith('--')}
    if not args:
        print(__doc__)
        sys.exit(1)
    raw = open(args[0], encoding='utf-8', errors='replace').read()
    text = clean(raw)
    if '--text' in flags:
        print(text)
        return
    data = stats(text)
    if '--json' in flags:
        print(json.dumps(data, ensure_ascii=False, indent=2))
        return
    print("===== 干净文本 =====")
    print(text)
    print("\n===== 量化统计 =====")
    print(json.dumps(data, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
