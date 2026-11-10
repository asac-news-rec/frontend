# 행동 로깅 서버: FastAPI + PostgreSQL + GCS

현재 기본 실행 경로는 아래와 같습니다. PostgreSQL 테이블을 5분 단위로 나누지 않습니다.

1. 실제 백엔드 화면에서 목록 노출·기사 열기·좋아요/취소를 생성합니다.
2. 같은 출처 `/api/behavior/events` 프록시가 서명한 HttpOnly 쿠키로 독자를 확인하고 내부 Bearer 인증으로 FastAPI에 전달합니다.
3. FastAPI가 형식·소유자·중복을 검사하고 PostgreSQL 트랜잭션 커밋 후 ACK합니다.
4. 별도 Python worker가 발생 시각 KST 5분 구간별로 JSONL 작업을 고정합니다.
5. GCS 업로드와 manifest 저장을 확인한 뒤 PostgreSQL 작업을 uploaded로 바꿉니다.
6. 실패 시 같은 작업 ID·객체명·내용으로 재시도합니다.

## 로컬 전체 실행

Python 3.11 이상, Node 24.19 이상, Docker Desktop을 사용합니다. 프런트 저장소에서 실행합니다. 예시의 기사·독자·이벤트는 시험 데이터입니다.

```powershell
# 영문·숫자 비밀번호를 생성하면 URI escaping 없이 사용할 수 있습니다.
$env:LOGGING_TOKEN=[guid]::NewGuid().ToString()+[guid]::NewGuid().ToString()
$env:LOCAL_POSTGRES_PASSWORD=[guid]::NewGuid().ToString('N')
docker compose -f services/logging-server/compose.local.yaml up -d --build --wait

# 뉴스 백엔드는 기존 실행 환경을 사용합니다.
$env:NEWS_BACKEND_URL='http://127.0.0.1:8080/'
$env:LOGGING_URL='http://127.0.0.1:4195'
# 위와 동일한 LOGGING_TOKEN을 프런트 프록시에 전달합니다.
npm start
```

기본 `http://127.0.0.1:4173/`에서 확인합니다. 쿼리스트링이나 모의 화면 전환은 없습니다. 일반 화면 수집은 LOGGING_URL과 LOGGING_TOKEN을 모두 설정했을 때 활성화합니다. 합성 에이전트 모드(SYNTHETIC_AGENT_TOKEN)는 별도 경로를 유지하며 일반 행동을 중복 생성하지 않습니다.

Compose는 PostgreSQL, GCS 에뮬레이터, 버킷 초기화, API, worker를 실행합니다. 실제 GCS 계정 없이 검증하며 실제 클라우드 저장 완료를 의미하지 않습니다. 기본 로컬 PG 포트는 55432, 에뮬레이터는 4443입니다. 초기화 도구는 STORAGE_EMULATOR_HOST가 없으면 실행을 거절하며 실제 버킷을 생성하지 않습니다.

종료는 `docker compose -f services/logging-server/compose.local.yaml down`입니다. DB·에뮬레이터 볼륨을 보존하며 `down -v`는 사용하지 않습니다. 이미 만들어진 DB의 비밀번호를 바꿀 때는 POSTGRES_PASSWORD 환경변수만 바꾸어서는 적용되지 않습니다. 기존 비밀번호를 사용하거나 DB 사용자 변경 절차를 따릅니다.

## 실제 GCP 설정

인프라 main `6131cae` 확인 결과:

- raw bucket 이름: `${project_id}-raw-logs`
- public access prevention·uniform bucket access·삭제 방지 설정
- logging-server 서비스 계정: `roles/storage.objectCreator`만 보유
- Cloud SQL: PostgreSQL 뉴스 DB `newsdb`, 암호·접속 정보는 저장소에 없음
- 실제 project_id는 커밋돼 있지 않고 tfvars.example에는 placeholder만 있음

실제 배포는 다음 환경변수를 Secret·Workload Identity/ADC로 주입합니다. 코드에서 키 파일을 생성하거나 브라우저로 전달하지 않습니다.

| 환경변수 | 역할 |
|---|---|
| LOGGING_TOKEN | 24자 이상 내부 Bearer 키. 동일 출처 프록시와 API가 공유 |
| LOGGING_DATABASE_URL | `postgresql://...` 또는 libpq DSN. 전용 로깅 DB 계정·DB 사용 권장 |
| GCS_BUCKET | 실제 `<project_id>-raw-logs` |
| GOOGLE_CLOUD_PROJECT | 실제 GCP 프로젝트 ID |
| GCS_PREFIX | 선택적 경로 prefix. 기본 빈 문자열 |
| LOGGING_HOST / LOGGING_PORT | API 기본 127.0.0.1 / 4195 |
| LOGGING_FLUSH_MS | worker poll 주기. 기본 30000, 최소 100 |
| LOGGING_MAX_RECORDS | served+actions 총 보관 행 수. 기본 100000 |

`LOGGING_STORE` 기본값은 postgres이며 DSN이 없으면 시작을 거절합니다. 운영 환경에서 STORAGE_EMULATOR_HOST는 설정하지 않습니다. Cloud SQL은 인프라의 Auth Proxy/보안 접속 경로를 이용하며 공용 허용 네트워크를 자동 개방하지 않습니다.

인프라의 objectCreator만으로는 업로드 결과 유실 후 기존 객체를 읽어 같은 내용인지 확인할 수 없습니다. worker에 `storage.objects.get` 권한(예: 버킷 범위 objectViewer 추가)이 필요합니다. 삭제 기능에는 별도의 `storage.objects.delete`도 필요합니다. 권한 부족을 성공으로 숨기지 않고 작업을 prepared로 남겨 재시도합니다. IAM을 자동 변경하지 않았습니다. 구체적인 요청은 [인프라 연동 메모](../../docs/logging-server/postgresql-gcs-integration.md)를 참고합니다.

Terraform의 JSONL.gz 주석과 달리 이번 요청에 따라 실제 객체는 압축하지 않은 `.jsonl`입니다. Airflow 담당자와 suffix를 맞춰야 합니다.

## Python 직접 실행 및 독립 worker

```powershell
cd services/logging-server
python -m venv .venv
.\.venv\Scripts\python -m pip install -r requirements-dev.txt
# LOGGING_TOKEN, LOGGING_DATABASE_URL, GCS_BUCKET, GOOGLE_CLOUD_PROJECT 설정 후
.\.venv\Scripts\python -m logging_service
# 같은 환경의 다른 터미널
.\.venv\Scripts\python -m logging_service.worker
# 한 번 내보내기. 실패를 종료 코드로 확인합니다.
.\.venv\Scripts\python -m logging_service.worker --once --force
```

API는 원본 수신만 담당합니다. GCS 업로드를 기다리지 않고 PostgreSQL 커밋 후 ACK합니다. API와 worker는 별도 프로세스·컨테이너로 실행합니다. 업로드 중에는 수신 트랜잭션 잠금을 잡지 않습니다.

PostgreSQL `behavior_logging` 스키마에 served_records, action_records, export_jobs, export_members, revoked_users와 스키마 버전을 만듭니다. DB 사용자는 이 스키마를 생성할 권한이 필요합니다. 뉴스 테이블을 수정하지 않습니다. 초기 구현은 수신·용량·철회 판정을 짧은 트랜잭션 advisory lock으로 직렬화합니다. worker는 별도 session advisory lock으로 한 번에 하나만 export하며, 프로세스 종료 시 PostgreSQL이 잠금을 해제합니다. 부하 증가 시 수신 lock·전체 count·준비 작업량 최적화가 필요합니다.

## 같은 출처 프록시와 독자 문맥

프록시가 백엔드 `/user/anonymous`에서 발급받은 독자 ID를 HMAC 서명 HttpOnly 쿠키에 30일간 연결합니다. 이후 피드 요청의 reader_id가 쿠키와 같은지 확인하고 최종 응답의 served를 PostgreSQL에 먼저 커밋한 뒤 화면에 반환합니다. 서버 토큰과 독자/source 내부 헤더는 브라우저에서 받지 않습니다. 다른 독자의 impression_id는 로깅 서버에서도 거절합니다.

처음 일반 로깅을 켜면 기존 localStorage UUID와 별도인 서버 검증 독자로 시작합니다. 이후 프록시 재시작·여러 replica에서도 같은 서명 키가 있으면 쿠키를 검증할 수 있습니다. 키 교체나 쿠키 만료 시 새 독자를 발급합니다. 기존 익명 독자의 좋아요를 자동 이전하지 않습니다. 뉴스 API가 UUID를 인증 수단으로 취급하는 기존 계약과 실제 계정 인증을 혼동하지 않습니다.

화면은 카드 50% 이상 표시·탭 visible·스크롤 정지 상태의 연속 구간을 exposure로 기록합니다. 구간 종료 시 전송하며 빠른 노출도 원본에 남깁니다. 클릭은 목록 링크 활성화 시 article_open, 좋아요/취소는 백엔드가 changed=true로 성공한 뒤에만 전송합니다. 조회·복원·실패는 좋아요 이벤트를 생성하지 않습니다. 상세 체류시간을 목록 노출에 합치지 않습니다.

브라우저는 고정 event_id·내용으로 지수 재시도하며 탭 sessionStorage 큐를 새로고침 뒤 복원합니다. 큐는 500건·약512KiB·30분 이내입니다. pagehide의 sendBeacon도 같은 ID를 사용하며 수신 ACK를 보장하지 않습니다. 강제 종료·큐 만료에서는 손실 가능성이 있습니다. served 저장 실패 시 목록은 오류를 표시합니다. 이를 숨기는 메모리 버퍼는 두지 않았습니다. 뉴스 조회와 완전한 장애 격리가 필요하면 후속으로 영속 outbox와 미등록 제공 건의 검증 대기 경로를 설계해야 합니다.

GCP의 정적 프런트엔드는 기존 Nginx를 유지합니다. 같은 출처 행동 경로와 피드 경로만 별도 Node 게이트웨이로 전달합니다. 예시는 [Nginx include](../../docs/logging-server/behavior-proxy-nginx.conf)입니다. `docker build --target behavior-proxy`를 이용할 수 있습니다. NEWS_BACKEND_URL이 같은 피드 프록시로 돌아오는 순환 구조가 되지 않게 합니다. 이 프록시의 production Nginx/서비스 배포는 아직 실행하지 않았습니다.

## 수신 API

문서 `/docs`, 생존 `/health`, 인증된 상태 `/ready`를 제공합니다. 내부 API는 Bearer 키가 필요합니다.

- POST /internal/served: `{records:[...]}`
- POST /events: `{events:[...]}`와 검증된 x-news-reader, x-collection-enabled:true, x-news-source:browser|simulator
- POST /internal/served-file: file(JSONL), request_id, expected_item_count multipart. 전체 검증·원자 커밋 후에만 200
- POST /internal/flush: PostgreSQL에서는 202로 외부 worker poll 방식을 알림. 즉시 실행은 worker --once --force
- POST /internal/delete-user: `{reader_id:string}`. 철회 후 GCS 원본·manifest·DB 삭제. 읽기·삭제 권한 필요

JSON ACK는 accepted/duplicate/rejected/retryable을 유지합니다. accepted는 PostgreSQL 커밋이며 GCS 저장 완료가 아닙니다. 본문 전체 256KiB, 배치 1~100행, 행동 4KiB입니다. event_time/served_at은 과거24시간~미래5분 이내입니다. HTTP 400/401/403/413/415/503과 개별 rejected를 구분합니다. 본문에 reader_id/source를 넣어 신뢰 문맥을 우회할 수 없습니다.

백엔드 app/log_sender.py의 파일 형식도 받지만 해당 전송기는 현재 Bearer 헤더를 설정하지 않습니다. 실제 사용 시 담당자가 인증을 추가해야 합니다. 현재 일반 화면 경로는 프록시가 served JSON을 전달하므로 해당 전송기 변경 없이 화면부터의 흐름을 시험할 수 있습니다.

## 5분 구간과 중복 없는 GCS 저장

```text
served/date=2026-11-10/hour=09/minute=00/part-{job_id}.jsonl
actions/date=2026-11-10/hour=09/minute=00/part-{job_id}.jsonl
manifests/{job_id}.json
```

발생 시각을 KST로 바꾸어 09:00:00 이상~09:05:00 미만을 minute=00으로 묶습니다. 수신 시각·worker 실행 시각으로 구간을 정하지 않습니다. 원본은 UTC로 보존합니다. poll 주기30초와 구간5분은 별개이며 한 구간에 여러 part 파일이 생길 수 있습니다. 늦게 도착한 기록은 같은 발생 구간의 새 part에 저장합니다. 테이블을 시간 파티션으로 만들지 않습니다.

작업은 stream·독자·5분 구간별 최대1000행입니다. DB 트랜잭션으로 job_id·구성원·객체명·내용·SHA-256을 고정합니다. GCS는 if_generation_match=0으로 새 객체만 생성합니다. 기존 객체가 있으면 동일 generation을 읽고 실제 내용 hash를 비교합니다. 다르면 덮어쓰지 않고 오류로 남깁니다. 객체와 manifest 성공 뒤에만 uploaded와 GCS generation receipt를 커밋합니다. 업로드 뒤 DB 갱신 전 종료해도 같은 객체를 확인해 복구합니다.

업로드 실패는 DB attempts·next_attempt_at으로 지수 재시도합니다. worker는 매 cycle 연결을 새로 열어 DB 재시작 후에도 다시 시도합니다. API의 다음 수신도 끊긴 연결을 복구합니다. 작업 content와 DB 원본은 업로드 후에도 유지하므로 보관량 상한을 자동 해소하지 않습니다. 자동 보관·아카이브와 대량 성능 검증은 후속입니다.

## 검증

서비스 폴더:

```powershell
python -m pytest python_tests -q
# 별도 시험 PostgreSQL + GCS 에뮬레이터가 있을 때
$env:TEST_POSTGRES_URL='postgresql://<시험접속정보>'
$env:STORAGE_EMULATOR_HOST='http://127.0.0.1:4443'
python -m pytest python_tests -q
```

PostgreSQL 시험은 고유 logging_test_* DB를 생성·삭제합니다. TEST_POSTGRES_URL 계정에 시험 DB 생성 권한이 필요하며 운영 접속 정보를 쓰지 않습니다. 입력 DB를 truncate하지 않습니다. 환경변수가 없으면 PG/GCS 통합 시험만 skip합니다.

프런트 저장소 루트:

```powershell
npm run check
npm test
npm run build
# Python 의존성 설치 후
$env:PLAYWRIGHT_CHANNEL='msedge' # Windows 설치 브라우저 예시. CI는 Chromium 사용
npm run test:browser
```

PG/GCS 시험 환경변수가 있으면 일반 화면 브라우저 테스트가 노출·클릭·좋아요·취소, 응답 유실 후 재시도, 서명 없는 요청 차단, worker 실행과 GCS 원본의 event_id 대조까지 검증합니다. 가상 기사·시험 사용자만 사용합니다. 에뮬레이터는 IAM·실제 Cloud SQL·GCS 운영 배포를 검증하지 않습니다.

## 이전 SQLite 구현

LOGGING_STORE=sqlite를 명시하면 이전 SQLite·로컬 파일 경로로 회귀 시험할 수 있습니다. 기본 경로가 아니며 PostgreSQL이나 GCS 성공으로 해석하지 않습니다. 기존 SQLite DB·로컬 파일은 자동 삭제·이전하지 않습니다. 과거 DB v1~v5 마이그레이션과 Node hash 호환 시험은 유지합니다. 과거 Node `.mjs`는 fixture이며 npm 서비스 start는 Python을 실행합니다.

공식 근거: [GCS 조건부 업로드](https://docs.cloud.google.com/python/docs/reference/storage/latest/google.cloud.storage.blob.Blob), [psycopg 트랜잭션](https://www.psycopg.org/psycopg3/docs/basic/transactions.html), [GCS 에뮬레이터](https://github.com/fsouza/fake-gcs-server).

### 저장 대상 변경 시 주의

prepared 작업이 남아 있는 동안 GCS_BUCKET/GCS_PREFIX를 바꾸지 않습니다. 작업 내용과 객체명은 DB에 고정하지만 bucket/prefix는 worker 환경에서 주입합니다. 저장 대상 이전은 기존 작업 처리와 객체 대조를 마친 뒤 별도 절차로 진행합니다.
