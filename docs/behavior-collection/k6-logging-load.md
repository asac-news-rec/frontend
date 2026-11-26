# k6 화면 API 기반 로그 입력·부하 실험

## 결정과 범위

2026-11-25, 이슈 #59. Python/Locust 초안을 k6로 교체했습니다. 전송기와 부하 도구를
따로 운영하지 않고 k6 하나로 쿠키·피드·이벤트 API를 호출하고 성능을 측정합니다.
로깅 서버에 직접 접속하지 않으며 클라이언트에 내부 Bearer/IAM 토큰이 필요하지 않습니다.

기존 AI 브라우저 실험에서 파생한 5개 페르소나·30세션·41클릭 패턴을 입력으로 사용합니다.
원본과 생성 JSON은 `data/`에 로컬 보존하며 커밋하지 않습니다. `patterns.json`의 논리 독자·기사
키와 `mapping.json`을 분리했습니다. 실제 독자는 실행 중 백엔드가 발급합니다.
원본 데이터 파일이 없는 환경에서는 아래 통합 시험의 작은 fixture로 동작을 검증할 수 있습니다.

## 요청 순서와 성공 의미

1. GET `/api/behavior/status`: enabled=true 확인. 꺼져 있으면 실행 중단.
2. POST `/api/v1/user/anonymous`: 각 VU의 쿠키 저장소로 UUID7 독자 발급.
3. POST `/api/behavior/session`: 발급받은 reader_id와 서버 서명 쿠키로 수집 세션 생성.
4. POST `/api/v1/news/feed`: 실제 제공 기사·impression_id 수신.
5. `collection_enabled=true` 확인 후 POST `/api/behavior/events`: article_open 전송.

모든 요청은 화면 서버 origin을 사용합니다. Origin 헤더를 보내고 리다이렉트를 따라가지 않습니다.
`noCookiesReset=true`로 한 실행 내 VU별 쿠키를 유지합니다. 반복 방문에서 익명 발급 API를 다시
호출했을 때 reader_id가 바뀌면 실패입니다. 여러 VU가 같은 페르소나를 참고할 수 있지만 각 VU는
별도 독자입니다. 프로세스 종료 후 쿠키를 보존하는 재접속 기능은 구현하지 않았습니다.

피드의 collection_enabled는 게이트웨이가 served 저장 ACK를 확인했다는 의미입니다.
이벤트는 HTTP 200뿐 아니라 정확히 일치하는 event_id의 accepted/duplicate를 확인합니다.
일시적 오류·불완전 ACK는 최대 3회 시도하며 같은 ID·시각·본문을 유지합니다.
SESSION_REQUIRED는 같은 독자로 수집 세션을 한 번 복구합니다. 영구 거절·최종 미확인은
실험 전체를 중단합니다. 응답 유실 후 duplicate는 성공입니다. 재시도는 실제 부하에 포함됩니다.
Retry-After를 존중하며 30초가 넘는 대기는 조기 재시도 대신 실패 처리합니다.
30초는 서버 계약이 아니라 이 실험의 대기 상한입니다. 더 긴 대기가 필요하면 실행을 중단하고
부하·실행 시간을 재설계합니다. 서버가 요청한 대기보다 일찍 재전송하지 않습니다.
현재 게이트웨이의 SESSION_REQUIRED 응답은 로깅 서버 전송 전에 반환되므로 **그 요청**은
저장되지 않습니다. 다만 앞선 시도에서 ACK가 유실되었다면 이미 저장됐을 수 있어 같은 event_id를
유지합니다. 복구 뒤 다시 403이면 fatal로 처리하고 event_unconfirmed를 기록한 뒤 전체 중단합니다.
세션 복구 자체가 실패하면 즉시 중단되므로 event_unconfirmed 없이 event_intent만 남을 수 있습니다.

ACK는 DB 커밋에 대한 서버 응답입니다. 독립적인 PostgreSQL 행 대조와 GCS 내보내기 검증은
별도 단계이며 결과 JSON의 database_verified/gcs_verified는 false입니다.

중단 후 대조는 로컬 감사 기록의 run_id로 실행을 고르고 reader_id/event_id를 추출하여,
권한 있는 환경에서 PostgreSQL 이벤트 행과 대조합니다. event_unconfirmed는 미저장 확정이 아니라
저장 여부 미확인입니다. event_intent 중 event_ack가 없는 항목도 모두 대조 대상입니다
(복구 실패·다른 VU의 중단·프로세스 종료로 최종 기록이 없을 수 있습니다).
같은 event_id의 행 존재 여부와 reader_id, impression_id, event_type, event_time을 비교하고,
행이 없거나 본문이 다르면 별도 미확인/불일치로 남깁니다. 자동 재전송·삭제는 하지 않습니다.
이 대조 절차는 후속 수동 검증이며 이번 실행 결과의 database_verified는 계속 false입니다.

## 데이터 패턴과 실제 기사 연결

- `SELECTION=rank`(기본): 원본 패턴의 클릭 횟수·클릭 위치를 현재 피드에 적용합니다.
  예를 들어 논리 목록의 세 번째 기사 클릭은 현재 피드의 세 번째 기사를 클릭합니다.
  같은 독자의 반복 방문·기사 겹침은 가능하지만 **원본 기사 의미나 관심사 선호는 재현하지 않습니다.**
- `SELECTION=mapped`: mapping.articles[].backend_article_id에 실제 기사 ID를 지정합니다.
  해당 기사가 현재 피드에 없으면 실패하며 다른 기사로 자동 대체하지 않습니다.
- 제공 목록은 백엔드가 결정합니다. 원본의 가상 기사 5개를 강제로 제공하거나 별도 served API로
  등록하지 않습니다. 피드가 20개라면 제공 기록도 20개입니다.
- 실제 화면을 렌더링하거나 노출·스크롤·체류를 측정하지 않습니다. 현재 행동은 article_open만입니다.
- 추천 모델의 호출 여부·모델 버전·기대 추천은 별도 검증 대상입니다. 피드 성공을 추론 성공으로
  판정하지 않으며 결과의 inference_verified는 false입니다.

### 출처와 테스트 식별

일반 화면 게이트웨이는 source를 **browser로 고정**합니다. k6가 simulator 헤더나 임의 reader_id를
넣어 이를 바꾸지 않습니다. 따라서 테스트 데이터 분리는 별도 실행 로그의 run_id 및 발급된
reader_id/event_id로 해야 합니다. 이 경로의 source=browser는 실제 사람이 사용했다는 증거가 아닙니다.
실제 서비스에서 수행한 실험의 ID는 학습·분석에서 제외할 목록으로 활용해야 합니다.
`AUDIT=1`은 쿠키·토큰 없이 독자 연결, 제공 기록, 전송 의도와 최종 ACK를 JSON 메시지로 남깁니다.
`--log-format raw --console-output data/<실행명>-audit.jsonl`과 함께 사용합니다.
고유한 파일명을 쓰고 이전 실행 결과를 덮어쓰지 않습니다. 원본 식별자는 공개 이슈·PR에 붙이지 않습니다.

reader_key는 페르소나/패턴 그룹 키이며 실제 독자 식별자가 아닙니다. VU 수가 그룹 수를 넘으면
같은 reader_key를 여러 VU가 공유하므로 reader_key:reader_id는 1:N입니다. 분석 시 실제 독자는
run_id + vu + reader_id로 구분하고 reader_key는 패턴별 집계에만 사용합니다.
execution.vu.iterationInScenario는 smoke와 load 모두 해당 VU의 시나리오 내 0부터 시작하는
반복 번호입니다. 각 VU는 sessions[visit % sessions.length]로 자신의 패턴을 순회하며,
load 도중 새로 할당된 VU도 첫 패턴부터 시작합니다. 시나리오 전체 번호는 별도 속성인
execution.scenario.iterationInTest입니다.

## 설치와 실행

공식 k6 실행 파일을 설치합니다. 개발 검증 버전은 **k6 v2.4.0 (Windows amd64)**입니다.
Python/Locust 설치는 필요하지 않습니다. 저장소 루트에서 실행합니다.
원격 대상은 smoke/load 모두 기본 차단합니다. 대상과 합성 데이터 제외 절차를 확인한 뒤
ALLOW_REMOTE_LOAD=1을 명시해야 HTTPS 원격 요청을 허용합니다. localhost, 127.0.0.1, [::1]은
확인 변수 없이 실행할 수 있습니다. 이 변수는 실수 방지 장치이며 운영 주소 판별/허용 목록은 아닙니다.

```powershell
$env:BASE_URL='https://<화면 서버 주소>'
$env:ALLOW_REMOTE_LOAD='1' # 대상과 합성 데이터 제외 절차 확인 후에만 설정
$env:PATTERNS=(Resolve-Path 'data/load-sample-12a31b39-patterns.json').Path
$env:MAPPING=(Resolve-Path 'data/load-sample-12a31b39-mapping.json').Path
$env:SELECTION='rank'
$env:MODE='smoke'
$env:VUS='1'
$env:VISITS='2'
$env:AUDIT='1'
$env:SUMMARY_PATH='data/k6-smoke-<고유 실행명>.json'
k6 run --log-format raw --console-output 'data/k6-smoke-<고유 실행명>-audit.jsonl' scripts/logging-load/browser-flow.k6.js
```

첫 실행은 1명·2회로 쿠키 재사용을 확인합니다. 원본 30세션을 순회하려면 VUS=5, VISITS=6입니다.
실행당 VU가 같은 페르소나 그룹의 세션을 순서대로 반복합니다. PAUSE_MS는 클릭 전·방문 종료의
대기 시간이며 기본 200ms입니다. 데이터의 옛 시각은 재사용하지 않고 전송 시각을 생성합니다.
스모크는 최대 10분이며 완료 방문 수가 VUS×VISITS에 못 미치면 실패입니다.

```powershell
# 스모크 성공 후 30초 동안 초당 1회 방문부터 단계적으로 증가
$env:MODE='load'
$env:RATE='1'
$env:DURATION_SECONDS='30'
$env:VUS='5'
$env:MAX_VUS='10'
$env:SUMMARY_PATH='data/k6-load-<고유 실행명>.json'
k6 run --log-format raw --console-output 'data/k6-load-<고유 실행명>-audit.jsonl' scripts/logging-load/browser-flow.k6.js
```

RATE는 **초당 방문 시작 수**이며 HTTP RPS가 아닙니다. 방문마다 독자 확인·세션·피드와
0~여러 클릭 요청이 발생합니다. 요청 RPS와 지연은 k6의 실제 http_reqs/http_req_duration을 봅니다.
MAX_VUS가 부족해 생긴 dropped_iterations는 서버 거절과 구분하며 0이 아니면 실패입니다.
기본 판정은 check 전부 성공, 흐름 실패 0건, HTTP p95 5초 미만입니다.
모든 ensure 실패는 즉시 전체 실행을 중단합니다. flow_failed의 rate==0은 결과 판정용이며
오류 허용 예산이나 지연 중단 조건이 아닙니다. 이벤트 하나라도 최종 ACK를 확인하지 못하면
측정의 신뢰성을 보장할 수 없어 중단하는 정책입니다.
인증·수집 비활성·최종 이벤트 미확인은 즉시 중단하며 이미 저장된 로그는 남습니다.
이벤트 재시도는 한 실행 안에서만 지원합니다. 중단된 실행의 디스크 재개 기능은 없습니다.

## 로컬 검증

```powershell
npm run check
npm test
# npm test의 사전 빌드 후, 설치한 k6 실행 파일 지정
$env:K6_BIN='C:\<k6 설치 위치>\k6.exe'
node --test tests/integration/k6-flow.test.mjs
```

통합 시험은 실제 k6와 저장소의 Node 게이트웨이를 사용하고 백엔드·로깅 서버는 엄격한
메모리 HTTP fixture로 대체합니다. 2명×2회에서 쿠키 재사용, 독자 간 격리, served 소유자,
수락 응답 유실 후 동일 이벤트 재시도, 수집 장애 시 클릭 중단을 검사합니다.
이는 실제 PostgreSQL·GCS·추론 서버 검증을 대체하지 않습니다.

## 진행 기록

- 원본 AI 결과 분석 및 논리 패턴·매핑 샘플 생성 완료.
- k6 화면 API 시나리오, 소량·일정 방문률 모드, 개별 ACK 검증 구현.
- 배포 화면 `/api/behavior/status`: HTTP 200, enabled=true 확인.
- 로컬 단위 시험 36개 통과. 실제 k6+게이트웨이 시험에서 2명×2회 쿠키 유지, 응답 유실 재시도,
  일정 방문률 모드와 수집 장애 중단을 검증했습니다.
- 배포 화면 소량 시험: 1명×2회, HTTP 9건, check 11개 성공, 제공 기록 40건 수락 표시,
  클릭 2건 accepted. HTTP p95 약 554ms는 이 작은 실행의 관측치이며 최대 처리량을 뜻하지 않습니다.
  DB 직접 대조·GCS·추론 결과는 아직 검증하지 않았습니다.
- 로컬 증거: `data/k6-deployed-smoke-20261125-01.json` 및 같은 이름의 `-audit.jsonl`.
- 후속: 단계별 부하 확대, PostgreSQL/GCS ID 대조, 실제 기사 매핑 후 추천 검증.

근거: [쿠키](https://grafana.com/docs/k6/latest/using-k6/cookies/),
[VU별 반복](https://grafana.com/docs/k6/latest/using-k6/scenarios/executors/per-vu-iterations/),
[실행 정보](https://grafana.com/docs/k6/latest/javascript-api/k6-execution/).
