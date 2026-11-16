# 독립 뉴스 로깅 서버 · FastAPI

Python 3.11 이상, FastAPI/Uvicorn으로 실행하는 독립 서비스입니다. 수신한 제공 기록·행동을 SQLite에 커밋한 뒤 ACK를 반환하고, 로컬 JSONL과 manifest로 내보냅니다. GCS·BigQuery 운영 연결은 아직 없습니다.

## 실행

프런트엔드 저장소 루트 PowerShell:

```powershell
cd services/logging-server
python -m venv .venv
.\.venv\Scripts\python -m pip install -r requirements-dev.txt
$env:LOGGING_TOKEN=[guid]::NewGuid().ToString()+[guid]::NewGuid().ToString()
.\.venv\Scripts\python -m logging_service
```

주소는 `http://127.0.0.1:4195`, API 문서는 `/docs`, OpenAPI는 `/openapi.json`입니다. 문서의 Authorize에 서버 토큰을 넣어 시험합니다. 문서에 예시로 쓰인 식별자는 가상 값입니다.

기존 `npm --prefix services/logging-server start`도 Python 서비스를 실행합니다. Python 환경은 `LOGGING_PYTHON`으로 지정할 수 있습니다. 직접 Python 실행을 권장합니다. 프런트의 `npm start`는 기존 개발 프록시를 실행하며 로깅 서버와 별도입니다.

| 환경변수 | 기본값·역할 |
|---|---|
| LOGGING_TOKEN | 필수, 24자 이상. 내부 인증이며 브라우저에 전달 금지 |
| LOGGING_HOST / LOGGING_PORT | 127.0.0.1 / 4195 |
| LOGGING_DB | 서비스 폴더의 data/inbox.sqlite |
| LOGGING_EXPORT_DIR | 서비스 폴더의 data/objects |
| LOGGING_FLUSH_MS | 30000, 최소 100. 주기 검사 |
| LOGGING_MAX_RECORDS | 100000. DB의 served+actions 보관 행 수 상한 |
| LOGGING_PYTHON | npm 호환 실행기와 Node 통합 테스트에서 사용할 Python 경로 |

30초마다 또는 미배정 원본 1,000건 이상에서 내보내기를 시도합니다. 수신과 worker의 DB 접근을 직렬화하며, 동기 DB·파일 작업은 이벤트 루프 밖에서 실행합니다. 단일 프로세스·영속 디스크가 초기 범위입니다. 대량 내보내기는 수신을 지연시킬 수 있습니다. 여러 인스턴스·다중 worker·공유 볼륨 확장은 지원하지 않습니다.

## HTTP 계약

`GET /health`만 생존 상태를 공개합니다. `/ready`와 모든 POST는 `Authorization: Bearer <LOGGING_TOKEN>`이 필요합니다. `/docs`와 OpenAPI는 계약 설명만 공개하며 데이터는 반환하지 않습니다. 브라우저는 같은 출처 프록시를 이용하고, 프록시가 검증한 독자 문맥을 내부 호출에 전달해야 합니다. 이 포트를 공개 인터넷에 직접 노출하지 않습니다.

| 경로 | 입력·의미 |
|---|---|
| GET /ready | DB counts·미배정 행·재시도 작업·최근 내보내기 상태 |
| POST /internal/served | JSON `{records:[제공 기록]}`. 기존 클라이언트 호환 |
| POST /events | JSON `{events:[행동]}`. x-news-reader, x-collection-enabled:true 필요 |
| POST /internal/served-file | JSONL 파일 multipart 업로드. 아래 계약 참고 |
| POST /internal/flush | JSON `{}`. 재시도 대기 시간을 무시하고 내보내기 |
| POST /internal/delete-user | JSON `{reader_id:string}`. 철회 후 로컬 원본·파일 삭제 |

제공 기록 필드: request_id, impression_id, reader_id, article_id, position(1 이상 정수), served_at(시간대 포함 ISO). 행동 필드: event_id(UUID), event_type, event_time, impression_id, page_type.

행동은 exposure/article_open/article_close/like/unlike입니다. exposure는 list만 허용하며 duration_ms(1~86400000 정수), ended_at을 추가합니다. article_open은 list, article_close는 detail입니다. 다른 행동에는 duration_ms·ended_at을 넣지 않습니다. article_close는 이탈 신호이며 독서 완료나 실제 체류를 보장하지 않습니다. 입력 시각은 과거 24시간·미래 5분 이내이며 UTC 밀리초로 정규화합니다.

source는 신뢰한 호출자의 x-news-source(browser 또는 simulator, 기본 browser)로 기록합니다. 일반 이용자와 합성 에이전트를 분석에서 구분합니다. 신뢰 헤더를 외부 요청에서 그대로 전달하면 안 됩니다.

기존 ACK `{results:[{event_id,status,code?}]}`를 유지합니다. served 응답의 키는 impression_id입니다. accepted는 SQLite 커밋, duplicate는 동일 ID·내용·행동 source의 기존 수락입니다. GCS나 분석 처리 완료가 아닙니다. rejected는 영구 입력 오류, retryable/IMPRESSION_NOT_READY는 제공 기록 도착 후 같은 내용으로 재시도할 수 있습니다.

커밋 직후 내보내기 알림이 실패하면 경고를 기록하고 주기 실행에서 저장된 행을 처리합니다. 제공 기록이 없어도 독자가 철회되면 철회 검사가 먼저 실행되어 403 USER_REVOKED를 반환합니다. 이 응답을 받은 호출자는 같은 독자의 전송을 중단합니다.

JSON은 envelope 단위 오류 시 400, 개별 원본 오류 시 결과별 rejected입니다. JSON/MIME/본문 상한 오류는 400/415/413, 인증은 401, 수집 불허·철회는 403, 저장 장애·보관량 초과는 503입니다. 본문 전체 상한은 256KiB(파일 업로드의 multipart overhead 포함), 배치 1~100행, 행동 1건 최대 4KiB입니다. FastAPI validation 오류는 기존 계약에 맞게 400으로 반환하며 입력 원문은 오류 응답에 포함하지 않습니다. 자동 보관 정리와 요청률 기반 429는 아직 없습니다.

POST의 `Content-Length`가 256KiB를 초과하면 본문을 읽기 전에 413을 반환합니다. 실제로 읽은 바이트에도 같은 상한을 적용하며, 헤더 수신 후 15초 안에 본문 읽기가 끝나지 않으면 408 BODY_TIMEOUT을 반환합니다. 본문을 수신한 뒤 라우트에서 인증하므로 로깅 포트는 내부에 두고, 외부에서 접근 가능한 프록시를 붙이는 경우 헤더 수신 시간과 본문 크기를 프록시에서도 제한합니다. 수신 서버의 본문 상한과 읽기 시간 제한은 프록시 설정과 독립적으로 적용됩니다.

## 백엔드 JSONL 파일 업로드

`POST /internal/served-file`은 백엔드 `app/log_sender.py`의 전송 형식을 받습니다.

- file: UTF-8 JSONL, 각 행은 제공 기록
- request_id: 파일의 모든 행과 같은 요청 ID
- expected_item_count: 1~100의 행 수
- Authorization: Bearer 토큰 필수

파일은 건수·요청 ID·중복 impression_id·각 행을 검사합니다. 모든 행이 유효하면 200을 반환합니다. 이전에 같은 ID와 동일한 내용으로 저장된 행은 `duplicate`로 반환하고, 새 행은 `accepted`로 한 번만 추가합니다. 형식 오류나 같은 ID의 내용 충돌은 400, 철회된 독자가 포함되면 전체 트랜잭션을 롤백하고 403 `USER_REVOKED`를 반환합니다.

전송기는 200에서 대기 파일을 지웁니다. 503 `INBOX_CAPACITY`는 파일을 유지하고 `Retry-After`에 맞춰 재시도할 응답입니다. 잘못된 형식이나 ID 충돌은 격리하고, 403 `USER_REVOKED`는 해당 독자의 전송 및 자동 재시도를 중단해야 합니다. 401은 인증 설정을 바로잡고 413은 배치 크기를 조정해야 합니다. 확인한 백엔드 전송기는 400·422만 격리하고 나머지 실패는 다음 주기에 재시도하므로, 403 분기와 `Retry-After` 적용은 백엔드 후속 작업입니다.

현재 백엔드 전송기는 인증 헤더를 자동 설정하지 않습니다. 실제 연결 시 백엔드 담당자가 세션에 동일 LOGGING_TOKEN의 Bearer 헤더를 설정해야 합니다. URL은 `/internal/served-file`로 지정합니다. 무인증 수신으로 우회하지 않습니다. 이 변경에서는 백엔드 저장소를 수정하지 않았습니다. 파일 수신 기능 검증과 운영 백엔드 연결 완료를 구분합니다.

## 기존 Node DB 이전

1. 기존 Node 로깅 프로세스를 정상 종료합니다. Node와 Python을 같은 DB에 동시에 실행하지 않습니다.
2. 종료한 DB와 objects 디렉터리를 함께 안전하게 백업합니다. WAL이 남아 있으면 SQLite backup API를 사용하거나 WAL/SHM까지 포함해야 합니다.
3. 기존 LOGGING_DB·LOGGING_EXPORT_DIR을 그대로 지정해 Python을 실행합니다.
4. `/ready`와 시험 이벤트의 duplicate ACK, 기존 파일 복구를 확인합니다.

SQLite schema v1~v4를 v5로 올리며, v5는 그대로 엽니다. 미래 버전은 거절합니다. Node의 JSON 정규화·SHA-256 중복 판정과 기존 prepared 작업의 파일명·내용·hash를 유지합니다. 과거 파일에 user_id가 남아 있어도 이미 준비한 파일은 재작성하지 않습니다.

Python은 OS advisory lock을 사용하므로 비정상 종료 후에도 OS가 잠금을 해제합니다. `.service.lock` 파일 자체는 남을 수 있습니다. 기존 Node의 `.lock`이 있으면 시작을 거절합니다. Node가 실제 종료됐는지 확인한 뒤 운영자가 stale PID lock만 정리해야 합니다. DB나 로컬 기록을 자동 삭제하지 않습니다. Windows/호스트 디스크 손실까지 완전한 내구성을 보장하지 않습니다.

## 원본 파일과 삭제

```text
data/objects/
  served/date=YYYY-MM-DD/hour=HH/minute=00/part-{job_id}.jsonl
  actions/date=YYYY-MM-DD/hour=HH/minute=00/part-{job_id}.jsonl
  manifests/{job_id}.json
```

KST 5분 경로이며 원본 시각은 UTC입니다. 작업은 stream·독자·5분 구간별 최대 1,000행입니다. 작업 구성·내용·hash를 DB에 먼저 고정하고, 임시 파일 쓰기·fsync·rename 후 manifest와 DB uploaded 상태를 기록합니다. 같은 이름·같은 내용은 재사용하며 다른 내용은 충돌입니다. 중간 실패는 지수 재시도하고 재시작 후 같은 객체명으로 복구합니다. manifest는 작업별 기록이며 전체 5분 구간 완료 표시는 아닙니다.

삭제는 파일 내보내기와 직렬화합니다. 철회 표식을 먼저 커밋한 뒤 prepared·uploaded 상태 모두에서 원본, manifest, 임시 파일이 있으면 정리합니다. 파일 정리를 마친 다음 DB의 제공 기록·행동·내보내기 작업을 삭제합니다. 중간에 실패하거나 재시작하면 철회 표식과 삭제 대상 작업이 남아 새 수락과 내보내기를 막습니다. 같은 독자로 `/internal/delete-user`를 재요청하면 이미 지운 파일은 건너뛰고 남은 삭제를 마칩니다. 정상 인증과 수집 헤더가 붙은 철회 독자의 `/events`에는 403 `USER_REVOKED`를 반환합니다. GCS·BigQuery·백업 삭제 전파, 화면 삭제 버튼 연결, 자동 보관 정책은 후속 범위입니다. 내보낸 행도 DB에 남으므로 flush만으로 보관량 상한은 해소되지 않습니다.

## Docker

서비스 폴더에서 LOGGING_TOKEN을 설정한 뒤:

```powershell
docker compose up -d --build --wait
docker compose down
```

Python 이미지에서 독립 빌드·테스트·실행하며 별도 logging-data 볼륨을 사용합니다. 기존 node 이미지와 동일 UID 1000을 사용합니다. 기존 볼륨 권한과 DB 백업을 확인한 뒤 교체합니다. 일반 종료에서 `down -v`를 사용하지 않습니다. healthcheck는 Python HTTP 요청을 사용합니다.

## 검증

```powershell
# 서비스 폴더
.\.venv\Scripts\python -m compileall -q logging_service
.\.venv\Scripts\python -m pytest python_tests -q
# 저장소 루트. Python 경로를 지정하면 Node 통합 테스트도 해당 환경 사용
$env:LOGGING_PYTHON=(Resolve-Path services/logging-server/.venv/Scripts/python.exe).Path
npm run check
npm test
node --test tests/integration/fastapi-logging.test.mjs
npm run test:browser
npm run build
```

Python 테스트는 인증·ACK·중복·소유자·한도·파일 전체 롤백·주기 FLUSH·재시작·삭제·export 실패 복구·DB v1~v5 이전과 Node DB hash 호환을 확인합니다. Node가 없는 Python 컨테이너에서는 Node DB 생성 상호운용 테스트 1개만 skip합니다. GitHub Python CI는 Node도 설치해 이 테스트를 실행합니다.

Node의 이전 `.mjs` 저장소·HTTP 모듈과 tests는 기존 테스트의 기준 구현 및 DB 호환 fixture로 남겨 둡니다. 운영 실행·Docker는 사용하지 않습니다. `npm run test:legacy`로 이전 모듈 테스트만 실행할 수 있습니다. 목록 유효 노출 분류 CLI는 기존 `exposure-analysis.mjs`를 유지합니다. 실제 브라우저 클릭 회귀 테스트는 새 FastAPI 프로세스를 실행합니다.

공식 참고: [FastAPI lifespan](https://fastapi.tiangolo.com/advanced/events/), [파일 업로드](https://fastapi.tiangolo.com/tutorial/request-files/), [테스트](https://fastapi.tiangolo.com/tutorial/testing/).
