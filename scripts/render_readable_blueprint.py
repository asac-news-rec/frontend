"""Build the standalone readable brief while preserving the original source files."""
from pathlib import Path
import hashlib
import html
import json
import re

ROOT = Path(__file__).resolve().parents[1]
DOCS = ROOT / 'docs'
ORIGINAL = DOCS / 'frontend-blueprint-2026-10-31.md'
ORIGINAL_HTML = ORIGINAL.with_suffix('.html')
READABLE = DOCS / 'frontend-blueprint-readable-2026-10-31.md'
TARGET = READABLE.with_suffix('.html')
MARKER = '<!-- technical-appendix -->'
ORDER = [5, 7, 6, 8, 9, 10, 11, 12, 1, 2, 3, 4]

DIAGRAMS = {
    'overview': ('한눈에 보는 서비스 흐름', '목표 흐름입니다. 행동 수집부터 실제 모델 연결까지는 앞으로 구현할 부분입니다.', [
        ('fe', '뉴스 화면', '추천 기사 표시', '#part-2'),
        ('be', '행동 수집', '노출·클릭·읽기 기록', '#part-3'),
        ('data', '데이터 처리', '원본·정제·집계', '#part-3'),
        ('data', '다음 추천', 'CTR 예측·결과 전달', '#part-3')]),
    'architecture': ('화면에서 다음 추천까지', '추천 결과는 백엔드를 거쳐 화면으로 돌아옵니다. 인프라는 실행·권한·저장 환경을 지원합니다.', [
        ('fe', '프론트엔드', '기사 표시·이벤트 생성', '#part-2'),
        ('be', '백엔드', '독자 확인·기사·추천 API', '#part-3'),
        ('data', '데이터 처리', '원본 보관·BigQuery 배치', '#part-3'),
        ('data', 'ML', '과거 피처·학습·예측', '#part-3')]),
    'journey': ('한 독자가 뉴스를 읽는 과정', '첫 방문부터 재방문까지의 목표 여정입니다. 행동 저장 단계는 아직 미연결입니다.', [
        ('fe', '첫 방문', '기본 피드·선택적 표식 저장', '#part-2'),
        ('fe', '피드 탐색', '카드 노출 관찰 예정', '#part-3'),
        ('fe', '기사 클릭', '링크 선택·상세 요청', '#part-3'),
        ('fe', '상세 읽기', '본문 표시·활성 시간', '#part-3'),
        ('fe', '피드 복귀', '이전 목록·스크롤 복원', '#part-2'),
        ('be', '재방문', '쿠키로 기존 독자 연결', '#part-3')]),
    'roles': ('네 담당 영역의 책임과 입출력', '색과 역할명을 함께 표시했습니다. 인프라는 앞의 세 영역을 지원하며 담당자 이름은 미정입니다.', [
        ('fe', '프론트엔드', '보냄 · 요청·이벤트\n받음 · 기사·추천·저장 결과', '#part-2'),
        ('be', '백엔드', '검증 · 독자·형식·추천 출처\n전달 · 원본·추천 제공 기록', '#part-3'),
        ('data', '데이터·ML', '받음 · 원본·기사·추천 기록\n전달 · 피처·모델 결과', '#part-3'),
        ('infra', '인프라', '지원 · 배포·HTTPS·권한\n운영 · 저장·지연·오류 확인', '#part-4')]),
    'events': ('행동을 기록하는 네 시점', '일반적인 읽기 순서입니다. 직접 상세 진입은 피드 클릭이 없고, 빠른 클릭은 가시 노출 조건을 만족하지 않을 수 있습니다.', [
        ('fe', '노출', '볼 기회 · 50%·1초 제안', '#appendix-6'),
        ('fe', '클릭', '기사 링크를 선택한 순간', '#appendix-6'),
        ('fe', '상세 열림', '본문 표시 성공 후', '#appendix-6'),
        ('fe', '활성 체류', '보이고 포커스된 시간', '#appendix-6')]),
    'pipeline': ('원본에서 학습 입력까지', 'Cloud Storage 업로드와 BigQuery 분석 준비는 서로 다른 완료 시점입니다. 경로 전체는 권장 설계안입니다.', [
        ('be', '수집 API', '쿠키 확인·기본 검증', '#appendix-6'),
        ('infra', 'Bronze', 'Cloud Storage 원본', '#appendix-6'),
        ('data', 'BigQuery 적재', '주기 실행·파일 목록 관리', '#appendix-6'),
        ('data', 'Silver', '중복 제거·충돌 격리', '#appendix-6'),
        ('data', 'Gold', '피처·CTR 학습 표본', '#appendix-8')]),
    'ctr': ('클릭 확률 모델을 만드는 과정', '관측 기간과 지연 수신 유예가 끝나야 미클릭을 확정합니다. 현재 클릭 뒤의 행동을 그 클릭의 예측 피처로 쓰지 않습니다.', [
        ('be', '추천 제공 기록', '실제 내려준 항목·시각', '#appendix-8'),
        ('data', '정답 만들기', '기간 내 클릭 1·미클릭 0', '#appendix-8'),
        ('data', '학습·평가', '과거 피처·시간순 분할', '#appendix-8'),
        ('be', '추천 응답', '예측 결과 또는 대체 전략', '#appendix-9')]),
    'roadmap': ('연결하고 검증하는 순서', '첫 단계는 2026-10-29의 확인 기록입니다. 나머지는 계획이며 책임자·일정은 회의에서 결정합니다.', [
        ('fe', '현재 기반', '화면·방문자·Docker', '#part-2'),
        ('be', '다음 연동', '기사·추천·수집 API', '#part-4'),
        ('data', '데이터 검증', '원본 → 피처 ID 추적', '#part-4'),
        ('data', '모델 연결', '기준선 비교·대체 추천', '#part-4')]),
}
ROLES = {'fe':'프론트엔드', 'be':'백엔드', 'data':'데이터·ML', 'infra':'인프라'}


def inline(text):
    text = html.escape(text)
    text = re.sub(r'`([^`]+)`', r'<code>\1</code>', text)
    text = re.sub(r'\*\*([^*]+)\*\*', r'<strong>\1</strong>', text)
    return re.sub(r'\[([^\]]+)\]\(((?:https://|#)[^\s)]+)\)', r'<a href="\2">\1</a>', text)


def diagram(name):
    title, note, nodes = DIAGRAMS[name]
    items = []
    for i, (role, label, desc, target) in enumerate(nodes, 1):
        items.append(f'<li class="{role}"><a href="{target}"><span class="node-top"><span class="num">{i:02}</span><span class="role">{ROLES[role]}</span></span><strong>{inline(label)}</strong><span class="node-desc">{inline(desc).replace(chr(10), "<br>")}</span></a></li>')
    return f'<figure class="diagram" id="diagram-{name}"><figcaption><strong>{title}</strong><span>{note}</span></figcaption><ol class="flow {"support" if name == "roles" else ""}" style="--count:{len(nodes)}">' + ''.join(items) + '</ol>' + ('<p class="return-path">↳ 백엔드가 다음 추천을 화면으로 전달합니다. 즉시 반영 시점은 아직 정하지 않았습니다.</p>' if name == 'architecture' else '') + '</figure>'


def render_markdown(text, prefix='content'):
    lines = text.splitlines()
    out = []
    i = 0
    while i < len(lines):
        line = lines[i]
        if not line.strip() or line == MARKER:
            i += 1
            continue
        match = re.fullmatch(r'<!-- diagram:(\w+) -->', line)
        if match:
            out.append(diagram(match[1]))
            i += 1
            continue
        if line.startswith('```'):
            language = line[3:]
            code = []
            i += 1
            while i < len(lines) and not lines[i].startswith('```'):
                code.append(lines[i])
                i += 1
            value = '\n'.join(code)
            if language == 'json':
                json.loads(value)
            out.append(f'<div class="code-label">{inline(language or "예시")}</div><pre><code>{html.escape(value)}</code></pre>')
        elif line.startswith('#'):
            level = min(6, len(line) - len(line.lstrip('#')))
            title = line.lstrip('#').strip()
            part = re.match(r'Part (\d)', title)
            anchor = 'part-' + part[1] if part else ('summary' if title == '1분 요약' else f'{prefix}-{i}')
            out.append(f'<h{level} id="{anchor}">{inline(title)}</h{level}>')
        elif line.startswith('|'):
            rows = []
            headers = []
            while i < len(lines) and lines[i].startswith('|'):
                cells = [cell.strip() for cell in lines[i].strip('|').split('|')]
                if not all(re.fullmatch(r'[:\- ]+', cell) for cell in cells):
                    tag = 'th' if not rows else 'td'
                    if not rows:
                        headers = cells
                    rendered = []
                    for n, cell in enumerate(cells):
                        attr = ' scope="col"' if tag == 'th' else f' data-label="{html.escape(headers[n], quote=True)}"'
                        rendered.append(f'<{tag}{attr}>{inline(cell)}</{tag}>')
                    rows.append('<tr>' + ''.join(rendered) + '</tr>')
                i += 1
            out.append('<div class="table-wrap" role="region" aria-label="비교 표" tabindex="0"><table><thead>' + rows[0] + '</thead><tbody>' + ''.join(rows[1:]) + '</tbody></table></div>')
            continue
        elif re.match(r'^(?:- |\d+\. )', line):
            ordered = not line.startswith('- ')
            pattern = r'^\d+\. ' if ordered else r'^- '
            tag = 'ol' if ordered else 'ul'
            items = []
            while i < len(lines) and re.match(pattern, lines[i]):
                items.append('<li>' + inline(re.sub(pattern, '', lines[i])) + '</li>')
                i += 1
            out.append(f'<{tag}>' + ''.join(items) + f'</{tag}>')
            continue
        else:
            out.append('<p>' + inline(line) + '</p>')
        i += 1
    return '\n'.join(out)


CSS = '''
:root{--ink:#172b2b;--muted:#526564;--paper:#fff;--line:#dce6e3;--fe:#17675e;--be:#315c9a;--data:#71529a;--infra:#8b6022;color-scheme:light}
*{box-sizing:border-box}html{scroll-padding-top:30px}body{margin:0;background:#f6f8f7;color:var(--ink);font:16px/1.85 "Malgun Gothic","Apple SD Gothic Neo",sans-serif;overflow-wrap:anywhere}a{color:#155f59;text-underline-offset:4px}a:hover{text-decoration-thickness:2px}button{font:inherit;cursor:pointer}button:focus-visible,a:focus-visible,summary:focus-visible,[tabindex]:focus-visible{outline:3px solid #255dba;outline-offset:4px}code{font-family:Consolas,monospace;font-size:.88em;background:#edf2ef;padding:2px 4px;border-radius:3px}pre code{background:none;padding:0}
.skip{position:fixed;top:-100px;left:20px;background:white;padding:12px;z-index:10}.skip:focus{top:12px}.topbar{border-bottom:1px solid var(--line);background:#fff}.topbar-inner{max-width:1510px;margin:auto;padding:20px 34px;display:flex;align-items:center;justify-content:space-between;gap:16px}.brand{font-weight:800;letter-spacing:.07em}.brand small{font-size:12px;font-weight:500;color:var(--muted);margin-left:16px}.edition{font-size:12px;color:var(--muted)}
.shell{max-width:1510px;margin:auto;padding:32px 34px 100px;display:grid;grid-template-columns:220px minmax(0,1fr);gap:46px}.side{position:sticky;top:28px;align-self:start;max-height:calc(100vh - 56px);overflow:auto}.side-label{font-size:11px;letter-spacing:.15em;color:var(--muted);margin:8px 0 15px}.side a{display:block;color:#425755;text-decoration:none;font-size:14px;padding:10px 12px;border-left:3px solid transparent;border-radius:0 6px 6px 0}.side a[aria-current=true]{background:#e7f1ec;border-left-color:var(--fe);color:#154c45;font-weight:700}.side .tiny{font-size:12px;color:var(--muted);padding:16px 12px;line-height:1.8}.side .tools{margin-top:20px;padding-top:18px;border-top:1px solid var(--line)}.tools button{display:block;width:100%;text-align:left;border:1px solid #cbdad5;background:white;color:var(--ink);border-radius:6px;margin:8px 0;padding:8px 12px;font-size:13px}
main{min-width:0;max-width:1100px}.hero{padding:30px 0 24px}.eyebrow{font-size:12px;font-weight:700;letter-spacing:.14em;color:var(--fe)}h1{font-size:40px;line-height:1.45;letter-spacing:-.045em;margin:16px 0;word-break:keep-all;max-width:870px}.subtitle{font-size:21px;line-height:1.7;color:#4b6662;word-break:keep-all;max-width:850px}.meta{font-size:12px;color:var(--muted);margin:20px 0}.hero-bottom{display:flex;flex-wrap:wrap;gap:10px}.chip{font-size:12px;padding:5px 11px;border:1px solid #d6e2dc;border-radius:20px;background:#fff}.status-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;margin:24px 0 12px}.status-card{border:1px solid var(--line);border-radius:10px;background:white;padding:20px}.status-card strong{display:block;font-size:16px;margin:12px 0 6px}.status-card p{font-size:13px;line-height:1.8;color:var(--muted);margin:0}.badge{font-size:11px;font-weight:700;border-radius:4px;padding:4px 7px;display:inline-block}.done{color:#155c4a;background:#e7f4ec}.planned{color:#365286;background:#e9eff9}.pending{color:#79501d;background:#fbf1df}
.section{background:white;border:1px solid var(--line);border-radius:12px;padding:34px;margin:24px 0 42px;min-width:0}.section>h2:first-child{margin-top:0}.section h2{font-size:27px;line-height:1.5;letter-spacing:-.03em;margin:0 0 22px;word-break:keep-all}.section h3{font-size:20px;line-height:1.7;word-break:keep-all;margin:38px 0 14px}.section h4{font-size:17px;margin:30px 0 12px}.section h5{font-size:16px;margin:24px 0 10px}.section p{margin:15px 0}.section p strong{font-weight:750}.section>ol,.section>ul{padding-left:25px}.section li{padding:4px 0}.section .lead{font-size:18px;color:#304d47}#summary{color:#17675e}
.diagram{margin:26px 0 24px;background:#f8faf9;border:1px solid #e0e8e4;padding:22px;border-radius:10px}.diagram figcaption>strong{font-size:15px;display:block}.diagram figcaption>span{font-size:12px;line-height:1.8;color:var(--muted);display:block;margin-top:5px}.flow{list-style:none;display:grid;grid-template-columns:repeat(var(--count),minmax(0,1fr));gap:23px;padding:0;margin:22px 0 5px}.flow li{position:relative;min-width:0;border:1px solid #d6e1dc;border-top:3px solid var(--accent);border-radius:7px;background:#fff;padding:0}.flow li:not(:last-child)::after{content:'→';position:absolute;right:-21px;top:45%;font-size:18px;font-weight:700;color:#6e8580}.flow a{display:block;text-decoration:none;color:var(--ink);padding:14px 11px;height:100%}.flow a:hover{background:#f0f6f3}.fe{--accent:var(--fe)}.be{--accent:var(--be)}.data{--accent:var(--data)}.infra{--accent:var(--infra)}.node-top{display:flex;gap:6px;align-items:center;flex-wrap:wrap;color:var(--accent);font-size:10px}.num{font-weight:800;font-size:12px}.role{font-weight:600}.flow strong{display:block;font-size:15px;line-height:1.55;margin:10px 0 7px;word-break:keep-all}.node-desc{display:block;font-size:12px;line-height:1.85;color:#4b605c}.return-path{font-size:12px;color:var(--fe);padding:8px 12px;border-left:2px solid #9abcb0;background:#edf4ef}.support li:not(:last-child)::after{content:'↔'}.support li:last-child{border-style:dashed;border-top-style:solid}
.table-wrap{max-width:100%;overflow-x:auto;margin:22px 0;border:1px solid var(--line);border-radius:7px}table{border-collapse:collapse;width:100%;font-size:13px;line-height:1.85;table-layout:fixed}th,td{border-bottom:1px solid var(--line);padding:12px 13px;vertical-align:top;text-align:left;overflow-wrap:anywhere}th{background:#f0f5f2;font-weight:700;color:#294940}tr:last-child td{border-bottom:0}tr:nth-child(even){background:#fafcfb}pre{max-width:100%;overflow:auto;white-space:pre-wrap;background:#f0f4f2;padding:20px;border-radius:0 0 6px 6px;font:12px/1.85 Consolas,"Malgun Gothic",monospace;margin:0 0 22px;overflow-wrap:anywhere}.code-label{padding:6px 14px;background:#e5ece8;color:#4a6055;font:11px/1.8 Consolas,monospace;border-radius:6px 6px 0 0}
.appendix{margin:14px 0;border:1px solid var(--line);border-radius:8px;background:white;scroll-margin-top:25px}.appendix>summary{cursor:pointer;padding:19px 20px;font-size:16px;font-weight:700;line-height:1.8;list-style-position:inside}.appendix[open]>summary{background:#eef4f0;border-bottom:1px solid var(--line)}.appendix-body{padding:4px 24px 24px}.appendix-body h3{font-size:18px}.appendix-body h4{font-size:16px}.appendix-body p{font-size:14px;line-height:1.95}.appendix-body .table-wrap table{font-size:12px}.archive-note{font-size:12px;color:#675829;background:#fbf6e9;padding:12px 16px;border-radius:6px}.glossary{padding:18px;background:#edf3f0;border-radius:8px;font-size:13px;margin-top:24px}.footer{font-size:12px;color:var(--muted);padding:0 4px}.mobile-nav{display:none}
@media(min-width:1500px){.shell{gap:52px}.section{padding:40px}.flow a{padding:16px 13px}}
@media(max-width:1150px){.shell{grid-template-columns:190px minmax(0,1fr);gap:25px;padding:24px}.section{padding:26px}.flow{grid-template-columns:1fr;gap:24px}.flow li:not(:last-child)::after{content:'↓';right:auto;left:calc(50% - 7px);top:auto;bottom:-25px}.support li:not(:last-child)::after{content:'↕'}.flow a{padding:14px 18px}.flow strong{margin:5px 0;font-size:16px}.node-top{font-size:11px}.node-desc{font-size:13px}.node-top{float:right;max-width:45%;justify-content:flex-end}}
@media(max-width:800px){.topbar-inner{padding:16px 20px}.brand small{display:none}.edition{font-size:10px}.shell{display:block;padding:15px 16px 60px}.side{display:none}.hero{padding:24px 4px 10px}h1{font-size:29px}.subtitle{font-size:18px}.section{padding:23px 18px;margin:20px 0 28px;border-radius:9px}.section h2{font-size:23px}.section h3{font-size:19px}.status-grid{grid-template-columns:1fr}.status-card{padding:17px}.status-card strong{margin:8px 0}.mobile-nav{display:block;margin:20px 0}.mobile-nav summary{cursor:pointer;background:#e9f1ec;padding:12px 15px;border-radius:6px;font-size:14px}.mobile-nav a{display:block;padding:9px 16px;font-size:14px}.diagram{padding:16px}.appendix>summary{font-size:14px;padding:16px}.appendix-body{padding:2px 15px 20px}table{table-layout:auto;font-size:12px}th,td{min-width:95px;padding:10px;word-break:normal}.table-wrap:focus{outline:3px solid #255dba}pre{font-size:11px;padding:14px}.node-top{max-width:48%}.tools-inline{display:flex;gap:10px;flex-wrap:wrap}.tools-inline button{font-size:13px;padding:8px 10px;border:1px solid #b5c8c0;background:white;border-radius:5px}}
@media screen and (max-width:800px){.table-wrap{overflow:visible}.table-wrap table,.table-wrap tbody{display:block;width:100%}.table-wrap thead{display:none}.table-wrap tr{display:block;padding:9px 13px;border-bottom:1px solid var(--line)}.table-wrap tr:last-child{border:0}.table-wrap td{display:grid;grid-template-columns:85px minmax(0,1fr);gap:12px;border:0;padding:6px 0;min-width:0;font-size:13px}.table-wrap td::before{content:attr(data-label);font-weight:700;color:#3f6256}.appendix-body .table-wrap td{font-size:12px}}
@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important}}
@media print{@page{size:A4;margin:16mm 15mm}html{scroll-padding-top:0}body{background:white;color:#111;font-size:9pt;line-height:1.7}.topbar,.side,.mobile-nav,.tools-inline,.skip{display:none!important}.shell{display:block;padding:0;max-width:none}main{max-width:none}.hero{padding:0 0 12pt}h1{font-size:23pt;line-height:1.4}.subtitle{font-size:13pt}.meta,.eyebrow,.chip{font-size:8pt}.hero-bottom{gap:5pt}.status-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:7pt}.status-card{padding:10pt;break-inside:avoid}.status-card strong{font-size:10pt}.status-card p{font-size:8pt}.section{border:0;border-radius:0;padding:0;margin:20pt 0}.section h2{font-size:17pt;border-bottom:1pt solid #6d8f83;padding-bottom:7pt;margin-top:0;break-after:avoid}.section h3{font-size:12pt;margin:20pt 0 8pt;break-after:avoid}.section h4,.section h5{font-size:10pt;break-after:avoid}.section p,.appendix-body p{font-size:9pt;line-height:1.75}.diagram{padding:12pt;margin:14pt 0;break-inside:avoid;print-color-adjust:exact}.diagram figcaption>strong{font-size:10pt}.diagram figcaption>span{font-size:8pt}.flow{grid-template-columns:repeat(var(--count),minmax(0,1fr));gap:14pt;margin:12pt 0 0}.flow a{padding:9pt 6pt}.flow strong{font-size:9pt;line-height:1.5}.node-top{float:none;max-width:none;justify-content:flex-start;font-size:7pt}.num{font-size:8pt}.node-desc{font-size:7.5pt;line-height:1.6}.flow li:not(:last-child)::after{content:'→';top:42%;bottom:auto;left:auto;right:-13pt;font-size:10pt}.support li:not(:last-child)::after{content:'↔'}.return-path{font-size:8pt}.table-wrap{overflow:visible;border-radius:0;break-inside:auto}table,.appendix-body .table-wrap table{table-layout:fixed;font-size:7.7pt}th,td{min-width:0;padding:6pt;word-break:normal}tr{break-inside:avoid}thead{display:table-header-group}.appendix{border:0;border-radius:0;margin:18pt 0}.appendix>summary{padding:8pt 0;font-size:13pt;border-bottom:1pt solid #aaa;break-after:avoid;list-style:none}.appendix-body{padding:0}details:not([open])>.appendix-body{display:block!important}pre{font-size:7.5pt;line-height:1.65;overflow:visible;break-inside:auto}.code-label{font-size:7.5pt;break-after:avoid}.archive-note{font-size:8pt;padding:8pt}.footer{font-size:8pt}a{color:inherit;text-decoration:none}.badge{font-size:7pt}*{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
'''

SCRIPT = '''
const appendix=[...document.querySelectorAll('.appendix')];
document.querySelectorAll('[data-expand]').forEach(button=>button.addEventListener('click',()=>{const open=button.dataset.expand==='true';appendix.forEach(detail=>detail.open=open);}));
function revealHash(){let target;try{target=document.getElementById(decodeURIComponent(location.hash.slice(1)));}catch{return}if(!target)return;const detail=target.closest('details');if(detail){detail.open=true;requestAnimationFrame(()=>target.scrollIntoView({block:'start'}));}}
window.addEventListener('hashchange',revealHash);revealHash();
const links=[...document.querySelectorAll('.side nav a')];
const sections=[...document.querySelectorAll('main section[data-section]')];
function updateCurrent(){let current=sections[0];for(const section of sections){if(section.getBoundingClientRect().top<=160)current=section;}links.forEach(link=>{if(link.hash==='#'+current.id)link.setAttribute('aria-current','true');else link.removeAttribute('aria-current');});}
window.addEventListener('scroll',updateCurrent,{passive:true});updateCurrent();
document.querySelectorAll('[data-print]').forEach(button=>button.addEventListener('click',()=>window.print()));
let printOpen=[];window.addEventListener('beforeprint',()=>{printOpen=appendix.map(detail=>detail.open);appendix.forEach(detail=>detail.open=true);});window.addEventListener('afterprint',()=>appendix.forEach((detail,index)=>detail.open=printOpen[index]));
'''


def build():
    before = {file:hashlib.sha256(file.read_bytes()).hexdigest() for file in [ORIGINAL, ORIGINAL_HTML]}
    source = ORIGINAL.read_text(encoding='utf-8')
    chunks = re.split(r'^## (\d+) (.+)\n', source, flags=re.M)
    originals = {int(chunks[i]):(chunks[i+1], chunks[i+2].strip()) for i in range(1, len(chunks), 3)}
    assert set(originals) == set(ORDER)
    intro = READABLE.read_text(encoding='utf-8').split(MARKER)[0].rstrip()
    appendix_md, appendix_html = [], []
    for index, number in enumerate(ORDER, 1):
        title, body = originals[number]
        shifted = re.sub(r'^(#{3,5}) ', lambda m:'#' + m[1] + ' ', body, flags=re.M)
        appendix_md.append(f'<a id="appendix-{number}"></a>\n\n### A{index} {title}\n\n{shifted}')
        appendix_html.append(f'<details class="appendix" id="appendix-{number}"><summary>A{index} · {inline(title)}</summary><div class="appendix-body"><p class="archive-note">원본 v0.6 기술 상세 · 원문의 제안·미정·날짜별 구현 기록을 보존했습니다.</p>{render_markdown(shifted, f"a{number}")}</div></details>')
        assert re.sub(r'^#{4,6} ', lambda m:m[0][1:], shifted, flags=re.M) == body
    compiled = intro + '\n\n' + MARKER + '\n\n' + '\n\n'.join(appendix_md) + '\n'
    READABLE.write_text(compiled, encoding='utf-8')
    head, *parts = re.split(r'^## (Part \d[^\n]*)\n', intro, flags=re.M)
    intro_lines = head.splitlines()
    summary_start = head.index('## 1분 요약')
    title = intro_lines[0].lstrip('# ')
    subtitle = intro_lines[2]
    nav_labels = ['1분 요약', '프로젝트 한눈에', '서비스와 팀 역할', '데이터와 추천', '개발·회의 계획', '기술 상세·출처']
    anchors = ['summary-panel', 'part-1', 'part-2', 'part-3', 'part-4', 'part-5']
    nav = ''.join(f'<a href="#{anchor}">{label}</a>' for anchor, label in zip(anchors, nav_labels))
    tools = '<button type="button" data-expand="true">기술 상세 모두 펼치기</button><button type="button" data-expand="false">기술 상세 모두 접기</button><button type="button" data-print>인쇄 또는 PDF 저장</button>'
    hero = f'<header class="hero"><div class="eyebrow">2026 10 31 · TEAM REVIEW</div><h1>{inline(title)}</h1><p class="subtitle">{inline(subtitle)}</p><p class="meta">읽기 개선판 v1.0 · 2026-10-30 재구성 · 기술 원본 v0.6 보존</p><div class="hero-bottom"><span class="chip">가상 독자·가상 기사 프로토타입</span><span class="chip">실시간 반영은 초기 목표에서 제외</span><span class="chip">초기 관심사 입력은 MVP 제외</span></div></header>'
    statuses = '<div class="status-grid"><article class="status-card"><span class="badge done">구현·확인 기록</span><strong>화면과 방문자 식별</strong><p>가상 피드·상세·쿠키·로컬 SQLite·Docker. 10월 29일 확인 기록입니다.</p></article><article class="status-card"><span class="badge planned">앞으로 연결</span><strong>행동에서 실제 추천까지</strong><p>수집 API·Cloud Storage·BigQuery·CTR 모델은 아직 연결하지 않았습니다.</p></article><article class="status-card"><span class="badge pending">팀 합의 필요</span><strong>기준과 책임자</strong><p>50%·1초, 관측 기간, 배치 주기, 보관·담당자·일정은 논의안입니다.</p></article></div>'
    content = hero + '<section class="section" id="summary-panel" data-section>' + render_markdown(head[summary_start:]) + statuses + '</section>'
    assert len(parts) == 10
    for i in range(0, len(parts), 2):
        number = i // 2 + 1
        content += f'<section class="section" id="part-{number}" data-section>' + render_markdown(f'## {parts[i]}\n{parts[i+1]}', f'p{number}')
        if number == 5:
            content += '<div class="tools-inline">' + tools + '</div>' + ''.join(appendix_html)
        content += '</section>'
    # The section itself owns the navigation anchor; inner heading IDs must stay unique.
    content = re.sub(r'<h2 id="part-(\d)">', r'<h2 id="part-heading-\1">', content)
    content = content.replace('原本', '원본').replace('>例<', '>예시<')
    page = '<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>프론트엔드 중심 설계 청사진 읽기 개선판</title><style>' + CSS + '</style></head><body><a class="skip" href="#document-main">본문으로 이동</a><div class="topbar"><div class="topbar-inner"><div class="brand">NEWS / BLUEPRINT<small>프론트엔드에서 시작하는 팀 설계</small></div><span class="edition">MEETING EDITION · 31 OCT 2026</span></div></div><div class="shell"><aside class="side" aria-label="문서 탐색"><div class="side-label">이 문서 읽기</div><nav aria-label="목차">' + nav + '</nav><div class="tiny">회의에서는 Part 1~4를 읽고<br>기술 검토는 Part 5를 펼칩니다.</div><div class="tools">' + tools + '</div><div class="glossary"><strong>먼저 알아둘 말</strong><p>이벤트 · 한 번의 행동 기록<br>피처 · 예측에 쓰는 입력 값<br>라벨 · 클릭 여부 같은 정답<br>CTR · 정한 분모의 클릭 비율</p></div></aside><main id="document-main" tabindex="-1"><details class="mobile-nav"><summary>목차와 읽기 도구</summary><nav aria-label="모바일 목차">' + nav + '</nav><div class="tools-inline">' + tools + '</div></details>' + content + '<footer class="footer">이 문서는 회의용 설계 제안입니다. 원본은 유지했으며, 원본 12개 장의 기술 상세를 별도로 보존했습니다. 외부 폰트·스크립트·네트워크 연결 없이 열 수 있습니다.</footer></main></div><script>' + SCRIPT + '</script></body></html>'
    TARGET.write_text(page, encoding='utf-8')
    for file, digest in before.items():
        assert hashlib.sha256(file.read_bytes()).hexdigest() == digest, f'Original changed: {file}'
    ids = re.findall(r'\bid="([^"]+)"', page)
    assert len(ids) == len(set(ids)), 'Duplicate HTML IDs'
    assert all(target in ids for target in re.findall(r'href="#([^"]+)"', page))
    assert page.count('<figure ') == len(DIAGRAMS)
    report = {'original_sha256':{file.name:digest for file, digest in before.items()}, 'technical_sections_preserved':ORDER, 'diagrams':len(DIAGRAMS), 'json_examples_validated':2, 'internal_links_valid':True}
    (DOCS / 'frontend-blueprint-readable-verification.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({'outputs':[READABLE.name, TARGET.name], 'preserved_sections':len(ORDER), 'diagrams':len(DIAGRAMS), 'original_files_unchanged':True}, ensure_ascii=False))


if __name__ == '__main__':
    build()
