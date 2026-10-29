#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把「自考冲刺资料」的 HTML 成品解析成 App 可直接消费的题库 JSON。

用法：
    python scripts/build-quiz-banks.py                     # 默认读 D:/自考题目
    python scripts/build-quiz-banks.py --src "D:/自考题目"  # 指定资料目录

输出：shared/banks/*.json（再由 scripts/sync-shared.js 同步到 web/shared/banks/）

为什么用脚本而不是手抄：
  1. 题库 100+ 题，手抄必错字；
  2. 资料以后还会增补（新考期重新出题），改 HTML 后重跑即可，保证「资料=题库」同源；
  3. 解析规则集中在 parse_* 函数里，格式一变只改一处。
"""
import argparse
import json
import os
import re
import sys

# ---------- 通用清洗 ----------

def strip_tags(s):
    s = re.sub(r'<br\s*/?>', '\n', s)
    s = re.sub(r'<[^>]+>', '', s)
    return s.replace('&nbsp;', ' ').replace('&lt;', '<').replace('&gt;', '>').replace('&amp;', '&').strip()


# 简答题答案保留结构化排版，但只允许白名单标签（防注入）
SAFE = re.compile(r'</?(p|b|br|ol|ul|li|span)\b[^>]*>', re.I)

def clean_html(s):
    # 「采分点（5句）」这类标签块连内容一起去掉（答案正文从下一行开始）
    s = re.sub(r'<span class="ans-label".*?</span>', '', s, flags=re.S)
    s = re.sub(r'<span class="(k|addnote)"[^>]*>', '', s)
    s = re.sub(r'<br\s*/?>', '<br>', s)
    # 只保留白名单标签，其余标签剥掉
    def keep(m):
        tag = m.group(1).lower()
        closing = m.group(0).startswith('</')
        return f'</{tag}>' if closing else f'<{tag}>'
    s = SAFE.sub(keep, s)
    s = re.sub(r'<(?!/?(?:p|b|br|ol|ul|li)\b)[^>]+>', '', s)
    s = re.sub(r'\s(class|style|id|on\w+)="[^"]*"', '', s)
    return s.strip()


def load(path):
    with open(path, encoding='utf-8') as f:
        return f.read()


# ---------- 解析器 1：冲刺 100 题（答案随题） ----------
# 结构：<h2>第N天 …｜科目 · 单选</h2> 之后是
#   <div class="q"><p class="stem">1. 题干</p><div class="opts"><p>A. …</p>…</div>
#   <p class="ans">答案：A ｜ 考点：…</p></div>

Q100 = re.compile(
    r'<p class="stem">(.*?)</p>\s*<div class="opts">(.*?)</div>\s*<p class="ans">(.*?)</p>',
    re.S)
OPT = re.compile(r'<p>([A-E])\.\s*(.*?)</p>', re.S)


def parse_100(src):
    html = load(src)
    # 按 h2 切段，记住每段属于哪一科
    parts = re.split(r'(<h2[^>]*>.*?</h2>)', html, flags=re.S)
    section, buckets = None, []          # [(course, [q…])]
    for part in parts:
        m = re.match(r'<h2[^>]*>(.*?)</h2>', part, re.S)
        if m:
            section = strip_tags(m.group(1))
            continue
        if not section:
            continue
        if '押题卡' in section or '清单' in section or '刷题计划' in section:
            continue
        course = None
        if '习概' in section:
            course = ('15040', '习近平新时代中国特色社会主义思想概论')
        elif '软件工程' in section:
            course = ('13005', '软件工程')
        elif '综合热身' in section:
            course = ('MIX', '综合热身')

        qs = Q100.findall(part)
        if not qs:
            continue
        parsed = []
        for stem, opts, ans in qs:
            opt_list = [f'{k}. {strip_tags(v)}' for k, v in OPT.findall(opts)]
            ans_m = re.search(r'答案：([A-E]{1,5})', ans)
            kp_m = re.search(r'考点：(.+?)$', strip_tags(ans))
            if not opt_list or not ans_m:
                continue
            answer = ans_m.group(1)
            parsed.append({
                'type': 'multi' if len(answer) > 1 else 'single',
                'stem': re.sub(r'^\d+\.\s*', '', strip_tags(stem)),
                'options': opt_list,
                'answer': answer,
                'kp': kp_m.group(1).strip() if kp_m else '',
            })
        if course and course[0] == 'MIX':
            # 综合热身：前 10 题习概、后 10 题软工（与资料声明「两科各10题」一致）
            half = len(parsed) // 2
            buckets.append((('15040', '习近平新时代中国特色社会主义思想概论'), parsed[:half], section + '（习概）'))
            buckets.append((('13005', '软件工程'), parsed[half:], section + '（软件工程）'))
        elif course:
            buckets.append((course, parsed, section))
    return buckets


# ---------- 解析器 2：软工 13005 考前终极押题 ----------
# 单选：<div class="q"><div class="q-head"><span class="no">1</span>
#        <span class="qt">题干</span><span class="stars">★★★</span></div>
#        <div class="opts">…</div><div class="ans">…<span class="k">A</span> ｜ 考点：…</div></div>
# 填空：<table>…<tr><td class="n">1</td><td>题目</td><td class="a">答案</td></tr>
# 简答：<div class="q"><div class="q-head"><span class="no">S1</span>…

QY_HEAD = re.compile(
    r'<span class="no">([^<]+)</span><span class="qt">(.*?)</span>(?:<span class="stars">(.*?)</span>)?',
    re.S)
QY_OPTS = re.compile(r'<div class="opts">(.*?)</div>', re.S)
QY_ANS = re.compile(r'<div class="ans">(.*?)</div>', re.S)
FILL_ROW = re.compile(
    r'<td class="n">\s*(\d+)\s*</td>\s*<td>(.*?)</td>\s*<td class="a">(.*?)</td>', re.S)


def parse_yati(src):
    html = load(src)
    # 只取「二、单选题」与「四、简答题」之间的 q 块，避免把简答当单选
    sec2 = html.find('单选题冲刺')
    sec3 = html.find('填空题必背')
    sec4 = html.find('简答题押题池')
    sec5 = html.find('综合应用大题')
    single_html = html[sec2:sec3]
    short_html = html[sec4:sec5]

    singles = []
    for blk in re.split(r'<div class="q">', single_html)[1:]:
        head = QY_HEAD.search(blk)
        opts = QY_OPTS.search(blk)
        ansbox = QY_ANS.search(blk)
        if not (head and opts and ansbox):
            continue
        opt_list = [f'{k}. {strip_tags(v)}' for k, v in OPT.findall(opts.group(1))]
        ans_txt = ansbox.group(1)
        k_m = re.search(r'<span class="k">([A-E]{1,5})</span>', ans_txt)
        kp_m = re.search(r'考点：(.+?)(?:</p>|$)', strip_tags(ans_txt), re.S)
        if not opt_list or not k_m:
            continue
        answer = k_m.group(1)
        singles.append({
            'type': 'multi' if len(answer) > 1 else 'single',
            'stem': strip_tags(head.group(2)),
            'options': opt_list,
            'answer': answer,
            'kp': kp_m.group(1).strip() if kp_m else '',
            'stars': head.group(3).count('★') if head.group(3) else 0,
        })

    fills = []
    for no, q, a in FILL_ROW.findall(html[sec3:sec4]):
        stem = strip_tags(q)
        ans = strip_tags(a)
        if not stem or not ans:
            continue
        fills.append({'type': 'fill', 'stem': stem, 'answerText': ans,
                      'kp': '', 'stars': 0})

    shorts = []
    for blk in re.split(r'<div class="q">', short_html)[1:]:
        head = QY_HEAD.search(blk)
        ansbox = QY_ANS.search(blk)
        if not (head and ansbox):
            continue
        shorts.append({
            'type': 'short',
            'stem': strip_tags(head.group(2)),
            'answerHtml': clean_html(ansbox.group(1)),
            'kp': '简答题押题池',
            'stars': head.group(3).count('★') if head.group(3) else 0,
        })
    return singles, fills, shorts


# ---------- 组装 ----------

def bank(bid, title, subtitle, course, course_name, groups, source, note=''):
    total = sum(len(g['questions']) for g in groups)
    b = {
        'id': bid,
        'title': title,
        'subtitle': subtitle,
        'course': course,
        'courseName': course_name,
        'total': total,
        'groups': groups,
        'source': source,
        'declaration': '自编预测题，非当次考试真题；仅用于考点覆盖练习，政策以官方为准。',
    }
    if note:
        b['note'] = note
    return b


def group_title(sec, n, code):
    """把资料里的原始小标题（带旧考期日期）规整成 App 内可长期使用的分组名。"""
    d = re.search(r'第(\d+)天', sec)
    if '综合热身' in sec:
        base = '综合热身'
    elif code == '15040':
        base = '习概单选'
    else:
        base = '软工单选'
    head = f'第{d.group(1)}天 · ' if d else ''
    return f'{head}{base}（{n} 题）'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--src', default='D:/自考题目')
    ap.add_argument('--out', default=None)
    args = ap.parse_args()

    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    outdir = args.out or os.path.join(here, 'shared', 'banks')
    os.makedirs(outdir, exist_ok=True)

    f100 = os.path.join(args.src, '1-刷题与模考卷',
                        '自考冲刺高频考点预测题_10月24-25考试版_100题_答案随题.html')
    fyati = os.path.join(args.src, '2-押题与考情报告',
                         '自考软件工程13005_考前终极押题_2026-10-25.html')
    for p in (f100, fyati):
        if not os.path.exists(p):
            sys.exit(f'✗ 找不到资料文件：{p}')

    buckets = parse_100(f100)
    by_course = {}
    for (code, name), qs, sec in buckets:
        by_course.setdefault((code, name), []).append((sec, qs))

    banks = []
    # 习概 / 软工 各自成库，题库内按「天」分组
    for (code, name), secs in by_course.items():
        groups = []
        n = 0
        for sec, qs in secs:
            if not qs:
                continue
            groups.append({'title': group_title(sec, len(qs), code), 'questions': qs})
            for q in qs:
                n += 1
                q['id'] = f'{code}-s{n}'
        short = '习概' if code == '15040' else '软件工程'
        banks.append(bank(
            f'{code}-sprint',
            f'{short} · 冲刺预测 {sum(len(g["questions"]) for g in groups)} 题',
            f'{code}｜2026年10月考期高频考点',
            code, name, groups,
            '自考星冲刺资料（2026-10-24/25 考期，5天刷题计划）'))

    # 软工终极押题：单选 + 填空 + 简答
    singles, fills, shorts = parse_yati(fyati)
    for i, q in enumerate(singles, 1):
        q['id'] = f'13005-yati-s{i}'
    for i, q in enumerate(fills, 1):
        q['id'] = f'13005-yati-f{i}'
    for i, q in enumerate(shorts, 1):
        q['id'] = f'13005-yati-w{i}'
    banks.append(bank(
        '13005-yati',
        '软工 · 考前终极押题',
        f'13005｜单选 {len(singles)} · 填空 {len(fills)} · 简答 {len(shorts)}',
        '13005', '软件工程',
        [
            {'title': f'一、单选题冲刺（{len(singles)} 题）', 'questions': singles},
            {'title': f'二、填空题必背（{len(fills)} 空）', 'questions': fills},
            {'title': f'三、简答题押题池（{len(shorts)} 题）', 'questions': shorts},
        ],
        '自考星 · 2026-10-25 考前终极押题（勘误版）'))

    manifest = []
    for b in banks:
        fn = f"{b['id']}.json"
        with open(os.path.join(outdir, fn), 'w', encoding='utf-8') as f:
            json.dump(b, f, ensure_ascii=False, indent=1)
        manifest.append({'id': b['id'], 'file': fn, 'title': b['title'],
                         'course': b['course'], 'total': b['total'],
                         'subtitle': b['subtitle']})
        print(f"  ✓ {fn}  {b['total']} 题  ({b['course']})")

    with open(os.path.join(outdir, 'index.json'), 'w', encoding='utf-8') as f:
        json.dump({'banks': manifest, 'builtAt': '2026-10-28'}, f,
                  ensure_ascii=False, indent=1)
    print(f"✅ 共 {len(banks)} 个题库 / {sum(m['total'] for m in manifest)} 题 → {outdir}")
    print('   下一步：node scripts/sync-shared.js 同步到 web/shared/banks/')


if __name__ == '__main__':
    main()
