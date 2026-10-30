"""Render the meeting Markdown as a self-contained printable HTML document."""
import html
import json
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'docs' / 'frontend-blueprint-2026-10-31.md'
TARGET = SOURCE.with_suffix('.html')


def inline(value):
    value = html.escape(value)
    return re.sub(r'\[([^\]]+)\]\((https://[^\s)]+)\)', r'<a href="\2">\1</a>', value)


def render():
    lines = SOURCE.read_text(encoding='utf-8').splitlines()
    blocks, toc, examples = [], [], []
    i = 0
    while i < len(lines):
        line = lines[i]
        if not line.strip():
            i += 1
            continue
        if line.startswith('```'):
            language, content = line[3:], []
            i += 1
            while i < len(lines) and not lines[i].startswith('```'):
                content.append(lines[i])
                i += 1
            if language == 'json':
                examples.append(json.loads('\n'.join(content)))
            blocks.append('<pre><code>' + html.escape('\n'.join(content)) + '</code></pre>')
        elif line.startswith('#'):
            level = len(line) - len(line.lstrip('#'))
            title = line[level:].strip()
            anchor = 'section-' + str(len(blocks))
            blocks.append(f'<h{level} id="{anchor}">{inline(title)}</h{level}>')
            if level == 2:
                toc.append(f'<a href="#{anchor}">{inline(title)}</a>')
        elif line.startswith('|'):
            rows = []
            while i < len(lines) and lines[i].startswith('|'):
                cells = [c.strip() for c in lines[i].strip('|').split('|')]
                if not all(re.fullmatch(r'[:\- ]+', c) for c in cells):
                    tag = 'th' if not rows else 'td'
                    rows.append('<tr>' + ''.join(f'<{tag}>{inline(c)}</{tag}>' for c in cells) + '</tr>')
                i += 1
            blocks.append('<div class="table"><table><thead>' + rows[0] + '</thead><tbody>' + ''.join(rows[1:]) + '</tbody></table></div>')
            continue
        elif re.match(r'^(?:- |\d+\. )', line):
            ordered = not line.startswith('- ')
            tag = 'ol' if ordered else 'ul'
            items = []
            pattern = r'^\d+\. ' if ordered else r'^- '
            while i < len(lines) and re.match(pattern, lines[i]):
                items.append('<li>' + inline(re.sub(pattern, '', lines[i])) + '</li>')
                i += 1
            blocks.append(f'<{tag}>' + ''.join(items) + f'</{tag}>')
            continue
        else:
            blocks.append('<p>' + inline(line) + '</p>')
        i += 1
    assert len(toc) == 12
    assert len(examples) == 2
    assert examples[0]['data']['items'][0]['article']['article_id'] == examples[1]['article_id']
    css = '''
    :root{color-scheme:light}*{box-sizing:border-box}body{margin:0;background:#edf2ef;color:#202c27;font:16px/1.85 "Malgun Gothic",Arial,sans-serif}
    main{max-width:1100px;margin:36px auto;background:white;padding:60px 64px;box-shadow:0 8px 40px #203c2710}
    h1{font-size:32px;line-height:1.45;word-break:keep-all;color:#172c22;margin:0 0 18px}h2{font-size:24px;margin:64px 0 20px;padding-top:16px;border-top:2px solid #257056;scroll-margin-top:20px}h3{font-size:19px;margin-top:32px}
    p{margin:16px 0}a{color:#17634d;text-underline-offset:3px}nav{background:#f1f7f3;padding:24px;margin:30px 0}nav a{display:block;line-height:2}
    .table{overflow-x:auto;margin:22px 0}table{border-collapse:collapse;width:100%;font-size:14px;line-height:1.75}th,td{border:1px solid #d7e2db;text-align:left;padding:12px;vertical-align:top;overflow-wrap:anywhere}th{background:#eaf3ed;font-weight:700}tr:nth-child(even){background:#fafcfb}
    pre{background:#f3f6f4;border-left:3px solid #257056;padding:20px;overflow:auto;font:13px/1.7 Consolas,"Malgun Gothic",monospace;white-space:pre-wrap;overflow-wrap:anywhere}li{padding:5px 0}
    .tag{font-size:13px;letter-spacing:2px;color:#3d705c;margin-bottom:18px}.note{font-size:13px;color:#607368;margin-bottom:30px}
    @media(max-width:700px){main{margin:0;padding:28px 20px}h1{font-size:26px}th,td{min-width:110px;padding:8px}}
    @media print{@page{size:A4;margin:18mm}body{background:white;font-size:10pt}main{padding:0;margin:0;max-width:none;box-shadow:none}h1{font-size:23pt}h2{font-size:16pt;margin-top:28pt;break-after:avoid}h3{break-after:avoid}table{font-size:8.5pt}th,td{padding:6pt}tr,pre{break-inside:avoid}thead{display:table-header-group}nav{display:none}pre{font-size:8pt}a{color:inherit}.table{overflow:visible}}
    '''
    page = '<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>개인화 뉴스 플랫폼 회의 자료</title><style>' + css + '</style><main><div class="tag">FRONTEND DESIGN REVIEW · 2026 10 31</div><div class="note">팀 논의용 초안 · 브라우저에서 인쇄하면 PDF로 저장할 수 있습니다.</div>'
    page += blocks[0] + '<nav aria-label="목차"><strong>목차</strong>' + ''.join(toc) + '</nav>' + ''.join(blocks[1:]) + '</main></html>'
    TARGET.write_text(page, encoding='utf-8')
    print(f'Created {TARGET.name}; {len(toc)} sections; {len(examples)} valid JSON examples')


if __name__ == '__main__':
    render()
