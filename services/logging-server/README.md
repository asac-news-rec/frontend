# 독립 뉴스 로깅 서버 · 로컬 파일 저장까지

현재는 GCS 직전의 로컬 HTTP·영속 수신함·JSONL 내보내기를 구현한 개발 버전입니다. 별도 포트와 Docker 이미지로 실행하며 프론트엔드 코드를 import하지 않습니다. Node.js 24.19 이상, 외부 npm 패키지 없이 동작합니다. 서비스 분리·로컬 검증 완료가 운영 배포 완료를 뜻하지는 않습니다.

## 1. 단독 실행

저장소 루트 PowerShell에서 실행합니다. 토큰은 예시 문자열을 복사하지 말고 생성합니다.

```powershell
$env:LOGGING_TOKEN=[guid]::NewGuid().ToString()+[guid]::NewGuid().ToString()
npm --prefix services/logging-server start
```

기본 주소 http://127.0.0.1:4195. data/inbox.sqlite와 data/objects는 서비스 폴더 아래에 생성됩니다. data는 Git에 포함하지 않습니다. 동일 DB의 main 프로세스 중복 실행을 lock으로 거절하며, 종료된 PID의 stale lock은 재실행 시 복구합니다. 컨테이너 여러 개가 같은 볼륨을 쓰는 구조는 지원하지 않습니다.

| 환경변수 | 기본값·역할 |
|---|---|
| LOGGING_TOKEN | 필수 24자 이상. 웹 프록시·내부 호출 인증. 브라우저에 전달 금지 |
| LOGGING_HOST / LOGGING_PORT | 127.0.0.1 / 4195 |
| LOGGING_DB | 서비스 data/inbox.sqlite |
| LOGGING_EXPORT_DIR | 서비스 data/objects |
| LOGGING_FLUSH_MS | 30000, 최소 100. 주기 검사 |
| LOGGING_MAX_RECORDS | 100000. 전체 보관 행 수 도달 시 수락 503 |

FLUSH는 30초 주기 및 미배정 1,000건 도달 시 시도합니다. 내보낸 행도 DB에 유지하므로 총 보관 제한은 FLUSH로 해소되지 않습니다. 자동 보관 정책·디스크 quota는 아직 없고 운영 전 확정해야 합니다. 저장 실패는 503이며 성공으로 숨기지 않습니다.

## 2. HTTP 계약

GET /health는 프로세스 생존만 공개합니다. GET /ready와 모든 POST는 Authorization: Bearer 토큰이 필요합니다. /ready는 DB 조회·대기 기록·작업·마지막 내보내기 상태를 반환하며, 파일 디스크 여유 전체를 보장하지 않습니다.

- POST /internal/served: {records:[반환 메타데이터]}. 뉴스 서버만 호출.
- POST /events: {events:[행동]}. 신뢰한 호출자가 x-news-reader와 x-collection-enabled:true를 설정. 합성 에이전트는 추가로 x-news-source:simulator를 설정.
- POST /internal/flush: {}. 재시도 대기 시간도 무시하고 로컬 내보내기 시도.
- POST /internal/delete-user: {reader_id:string}. 철회 표식 저장 후 그 사용자의 로컬 파일·manifest·DB 원본 삭제. 실패 시 재요청 가능.

직접 브라우저 요청은 허용하지 않습니다. 브라우저는 같은 출처 웹 프록시를 사용합니다. 내부 bearer 토큰을 가진 호출자는 신뢰 경계 안에 있으므로 이 포트를 공개 인터넷에 노출하지 않습니다. 별도 배포 시 TLS·네트워크 제한·키 교체를 구성해야 합니다.

행동 형식은 목록 exposure/article_open/article_close/like/unlike이며 목록 exposure만 duration_ms·ended_at을 가집니다. article_close는 상세 화면 이탈 시각만 기록합니다. 서버는 impression_id 소유자를 검증합니다. 미등록 건은 retryable입니다. ACK는 {results:[{event_id,status,code?}]}이며 accepted는 SQLite 커밋, duplicate는 같은 ID·내용 수락 이력입니다. GCS 완료가 아닙니다. rejected는 영구 입력 오류, retryable은 이후 동일 내용 재시도가 가능합니다.

본문 상한 256KiB, 이벤트 1~100개, 이벤트별 4KiB. JSON/MIME/크기 오류는 400/415/413, 인증 401, 수집 불허 403, 저장 장애·총량 제한은 503입니다. 아직 요청률 기반 429는 구현하지 않았습니다.

## 3. 실제 프론트 HTTP 시연

같은 저장소의 웹 서버를 별도 터미널에서 켭니다. 앞서 생성한 토큰과 같은 값을 환경으로 전달해야 합니다. 토큰을 공개 문서·프론트 코드·브라우저 입력에 넣지 않습니다.

```powershell
$env:LOGGING_TOKEN='<로깅 프로세스와 같은 로컬 토큰>'
$env:LOGGING_DEMO_URL='http://127.0.0.1:4195'
$env:PORT='4196'
npm start
```

http://127.0.0.1:4196/?feed=logging 에서 상단 시험 행동 측정을 켭니다. 가상 기사와 시험 사용자만 사용합니다. 웹 서버가 served를 먼저 커밋하고 카드 ID를 반환하며, 브라우저 events는 프록시가 인증한 뒤 로깅 서버로 보냅니다. API 키는 서버에만 있습니다. LOGGING_DEMO_URL/TOKEN을 설정하지 않으면 시연 경로는 열리지 않습니다.

브라우저 reader_id는 localStorage에 유지합니다. 로깅의 서버 독자 ID는 news_logging_demo HttpOnly 쿠키와 기존 visitors SQLite 테이블로 확인하며 고정 유효기간은 30일입니다. 서버 재시작 후 cursor는 첫 목록부터 다시 받아야 하지만, 유효 쿠키와 DB가 남아 있으면 같은 서버 독자로 연결합니다. 브라우저 UUID는 시연 문맥이고 권한은 서버가 쿠키로 확인합니다. 기본 news_visitor 쿠키와는 별도이므로 기본 화면의 좋아요 독자와 자동 통합하지 않습니다. 로깅 연결 화면의 좋아요도 같은 쿠키 독자의 visitors SQLite에 저장합니다. /api/v1/logging-demo/likes의 POST는 200 객체, DELETE는 본문 없는 204, GET ?reader_id=...는 객체 배열을 반환합니다. liked_at은 서버 시각이며 중복 등록은 기존 시각을 유지합니다. 측정을 켠 경우 성공 후에만 like/unlike를 보냅니다. 조회·복원·실패에는 새 행동을 만들지 않습니다.

?feed=mock는 인메모리 수락만, ?feed=logging는 실제 HTTP·SQLite·로컬 파일 저장입니다. actual logging 모드의 장애 스위치도 클라이언트 장애 시뮬레이션입니다. 실제 뉴스 백엔드의 UUID·쿠키·권한 전환은 아직 미연결입니다.

## 4. 파일과 복구

```text
data/objects/
  served/date=YYYY-MM-DD/hour=HH/minute=00/part-{job_id}.jsonl
  actions/date=YYYY-MM-DD/hour=HH/minute=00/part-{job_id}.jsonl
  manifests/{job_id}.json
```

KST 5분 경로이며 UTC 입력 시각은 원본에 보존합니다. 하나의 작업은 stream·사용자·5분 경로별로 최대 1,000행입니다. 사용자별로 파일을 나눠 로컬 삭제를 단순화했습니다. 사용자가 많으면 작은 파일이 늘어나므로 GCS 연결 전 규모·병합·삭제 정책을 다시 평가합니다.

SQLite schema v4: served_records/action_records, export_jobs/export_members, revoked_users. 마이그레이션은 이전 데이터를 보존하고 미래 버전은 거절합니다. prepared 파일 작업의 구성원·내용·hash·객체명을 고정합니다. 동일 이름·같은 내용은 재사용하고 다른 내용은 충돌로 거절합니다. 파일은 임시 쓰기·fsync·rename, POSIX에서는 부모 디렉터리도 fsync합니다. Windows/호스트 디스크 손실까지 완전한 내구성을 보장하지는 않습니다.

파일·manifest 완료 후 DB uploaded로 바꿉니다. 중간 실패 시 지수 재시도하고 다음 프로세스에서 같은 이름으로 복구합니다. manifest의 prepared_at은 작업 준비 시각이며 실제 업로드 완료 시각이 아닙니다. 로컬에는 GCS generation이 없습니다. 파일 하나의 manifest는 전체 5분 구간의 최종 완료 표시가 아닙니다.

삭제는 revoke를 먼저 저장해 새 수락과 추가 export를 막습니다. 파일 삭제 실패 후 다시 호출하면 이어서 정리합니다. 로컬 이외 BQ·GCS·백업 삭제는 구현하지 않았습니다. 기존 방문자 UI의 삭제 버튼과 운영 사용자 삭제 API도 아직 연결하지 않았습니다.

## 5. 독립 Docker

```powershell
# 서비스 디렉터리에서, LOGGING_TOKEN 설정 후
cd services/logging-server
docker compose up -d --build --wait
docker compose down
```

기본 호스트 포트 4195가 이미 사용 중이면 LOGGING_PORT를 다른 값으로 지정합니다. 전용 logging-data 볼륨을 사용합니다. down -v는 기록 삭제이므로 일반 종료에 쓰지 않습니다. .dockerignore는 로컬 DB·환경 파일을 제외합니다. 프론트 이미지와 독립 빌드·재시작 가능합니다.

## 6. 검증과 남은 범위

```powershell
npm --prefix services/logging-server run check
npm --prefix services/logging-server test
npm test
```

임시 DB로 HTTP 인증·ACK·중복, 주기 FLUSH, 파티션·manifest, 파일 저장 후 상태 갱신 전 실패 복구, 파일 충돌, 사용자 삭제·늦은 수락 차단을 검증합니다. 브라우저 시험 이벤트 ID를 실제 JSONL에서 확인했습니다.

GCS SDK·계정·버킷·업로드, Airflow DAG·BQ 적재, 운영 인증·동의·보관·외부 삭제 전파·다중 인스턴스·대용량 성능은 미구현입니다. 로컬에서는 동기 SQLite·파일 I/O를 사용하므로 대량 내보내기가 API 지연을 만들 수 있습니다. 운영 배포 전 worker 분리와 공유 영속 저장소 선택을 별도로 검토해야 합니다. 이번 범위의 마지막 저장 경계는 local-sink이며 GCS adapter는 아직 만들지 않았습니다.

## reader_id 통일과 기존 DB 이전

프론트 목록 요청·반환 메타데이터·삭제 본문은 reader_id, 내부 사용자 문맥은 readerId, 신뢰한 프록시 헤더는 x-news-reader를 사용합니다. 이전 user_id 요청 키는 받지 않습니다. /internal/delete-user 경로는 유지하지만 본문 키는 reader_id입니다.

SQLite schema v4는 시작 시 이전 v1~v3 DB의 독자 컬럼과 반환 기록의 정규화 JSON·해시를 트랜잭션으로 이전합니다. 독자 ID·이벤트·철회 기록과 재전송 중복 판정을 유지합니다. 새 파일은 reader_id를 사용합니다. 이미 준비·저장된 작업의 파일 내용·이름·해시는 재시작 복구를 위해 그대로 유지하므로 과거 파일에는 이전 키가 남을 수 있습니다. 실행 중인 서버는 기존 코드를 계속 사용하므로 재시작·Docker 재빌드 후 적용됩니다.

## 목록 유효 노출의 로컬 분석 단계

원본에는 1초 미만 목록 구간과 짧은 상세 잔여도 남깁니다. exposure-analysis.mjs는 목록 연속 구간 1000ms 이상을 유효 노출로 분류합니다. 저장소 루트의 `node scripts/classify-exposures.mjs <actions.jsonl> <analysis.jsonl>`로 파생 필드를 가진 별도 JSONL을 생성합니다. 상세·클릭은 목록 판정 필드가 null이며 제거하지 않습니다. 원본을 덮어쓰지 않고 떨어진 구간을 합치지 않습니다. 중복 제거·CTR 집계·Airflow·BigQuery 자동 실행은 별도입니다.
