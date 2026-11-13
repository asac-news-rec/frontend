# 행동 로깅 서버: FastAPI + PostgreSQL + GCS

현재 기본 실행 경로는 아래와 같습니다. PostgreSQL 테이블을 5분 단위로 나누지 않습니다.

1. 실제 백엔드 화면에서 목록 노출·기사 열기·좋아요/취소를 생성합니다.
2. 같은 출처 `/api/behavior/events` 프록시가 서명한 HttpOnly 쿠키로 독자를 확인하고 내부 Bearer 인증으로 FastAPI에 전달합니다.
3. FastAPI가 형식·소유자·중복을 검사하고 PostgreSQL 트랜잭션 커밋 후 ACK합니다.
4. Airflow DAG가 실행 구간의 PostgreSQL 로그를 조회해 gzip JSONL 작업을 고정합니다.
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

Compose는 PostgreSQL, GCS 에뮬레이터, 버킷 초기화와 API를 실행합니다. 내보내기는 별도 Airflow 환경에서 실행합니다. 실제 GCS 계정 없이 검증하며 실제 클라우드 저장 완료를 의미하지 않습니다. 기본 로컬 PG 포트는 55432, 에뮬레이터는 4443입니다. 초기화 도구는 STORAGE_EMULATOR_HOST가 없으면 실행을 거절하며 실제 버킷을 생성하지 않습니다.

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
| LOGGING_FLUSH_MS | SQLite 로컬 시험의 내보내기 주기. 기본 30000, 최소 100 |
| LOGGING_MAX_RECORDS | served+actions 총 보관 행 수. 기본 100000 |

`LOGGING_STORE` 기본값은 postgres이며 DSN이 없으면 시작을 거절합니다. 운영 환경에서 STORAGE_EMULATOR_HOST는 설정하지 않습니다. Cloud SQL은 인프라의 Auth Proxy/보안 접속 경로를 이용하며 공용 허용 네트워크를 자동 개방하지 않습니다.

인프라의 objectCreator만으로는 업로드 결과 유실 후 기존 객체를 읽어 같은 내용인지 확인할 수 없습니다. Airflow 태스크에 `storage.objects.get` 권한(예: 버킷 범위 objectViewer 추가)이 필요합니다. 삭제 기능에는 별도의 `storage.objects.delete`도 필요합니다. 권한 부족을 성공으로 숨기지 않고 작업을 prepared로 남겨 재시도합니다. IAM을 자동 변경하지 않았습니다. 구체적인 요청은 [인프라 연동 메모](../../docs/logging-server/postgresql-gcs-integration.md)를 참고합니다.

## Airflow DAG 배포

Airflow 2.10 또는 3의 DAG 폴더에 `dags/export_behavior_logs.py`를 배포합니다. 태스크 실행 환경의 Python 경로에 이 디렉터리의 `logging_service` 패키지를 설치하거나 마운트하고 `requirements.txt`의 psycopg와 google-cloud-storage 의존성을 설치합니다. 실행 환경에 LOGGING_DATABASE_URL, GCS_BUCKET, GOOGLE_CLOUD_PROJECT, 선택 GCS_PREFIX, GCS 자격 증명을 주입합니다. 로컬 에뮬레이터를 쓰려면 Airflow 실행 환경에서 접근 가능한 STORAGE_EMULATOR_HOST를 설정합니다. 로깅 API가 PostgreSQL 스키마를 먼저 초기화해야 합니다.

자동 실행 주기가 확정되면 DAG 파서에 `BEHAVIOR_EXPORT_CRON`(UTC cron)과 `BEHAVIOR_EXPORT_START`(첫 데이터 구간을 포함하도록 맞춘 UTC ISO 8601 시각)를 설정하고 DAG를 활성화합니다. catchup이 켜져 있으므로 시작일은 필요한 이력 범위에 맞춥니다. cron 설정 전에는 자동 실행 없이 수동 run의 conf에 아래처럼 실제 처리 범위를 입력합니다.

```json
{"interval_start":"2026-11-13T00:00:00Z","interval_end":"2026-11-13T00:15:00Z"}
```

정기 실행은 Airflow의 data_interval_start와 data_interval_end를 사용합니다. 조회 범위는 UTC PostgreSQL received_at 기준 시작 이상, 끝 미만입니다. 지연 수신 이벤트는 수신된 구간으로 들어가며 served_at/event_time은 그대로 보존합니다. 이미 내보낸 행은 export_members로 제외하고 동일 구간 실패 작업은 같은 객체명으로 재시도합니다.

기존 worker를 실행 중인 환경은 이전 worker로 prepared 작업을 먼저 마무리한 뒤 중지하고 DAG를 활성화합니다. 과거 미처리 행을 옮길 때는 첫 구간 또는 수동 실행 범위에 해당 수신 시각을 포함합니다. 이미 내보낸 과거 .jsonl 객체는 기존 경로에 남습니다. 다운스트림 소비자는 새 interval_start/interval_end 경로와 .jsonl.gz를 읽도록 배포 전에 맞춰야 합니다.

API는 PostgreSQL 커밋 후 ACK합니다. Airflow 태스크는 GCS 업로드 중 수신 트랜잭션 잠금을 잡지 않습니다.

같은 DAG의 `prune_postgresql` 태스크는 업로드 태스크와 별도로 실행합니다. 수신 시각과 발생 시각 모두 24시간이 지난 행 중 GCS 업로드 및 manifest 저장이 완료되고 generation이 기록된 행만 PostgreSQL에서 정리합니다. 미배정·실패·재시도 대기 행은 24시간이 지나도 보존합니다. 남은 행동이 참조하는 served 행도 유지합니다. 정리는 DAG 실행 시점에 수행하므로 실제 보관 시간은 실행 간격과 업로드 상태에 따라 24시간을 넘을 수 있습니다. 업로드한 작업의 원본이 모두 정리되면 DB의 작업 본문도 비우고, GCS 사용자 삭제에 필요한 객체명과 업로드 영수증을 남깁니다.

PostgreSQL `behavior_logging` 스키마에 served_records, action_records, export_jobs, export_members, revoked_users와 스키마 버전을 만듭니다. DB 사용자는 이 스키마를 생성할 권한이 필요합니다. 뉴스 테이블을 수정하지 않습니다. 초기 구현은 수신·용량·철회 판정을 짧은 트랜잭션 advisory lock으로 직렬화합니다. Airflow 태스크는 별도 session advisory lock으로 한 번에 하나만 export하며, 프로세스 종료 시 PostgreSQL이 잠금을 해제합니다. 부하 증가 시 수신 lock·전체 count·준비 작업량 최적화가 필요합니다.

## 같은 출처 프록시와 독자 문맥

뉴스 독자 ID의 단일 기준은 `src/reader-identity.ts`의 localStorage입니다. 기존 `sai-news.backend-reader-id`를 우선 사용하고, 이전 `sai-news.backend-user-id` 키가 있으면 같은 값으로 이전합니다. 둘 다 없을 때만 기존 `/api/user/anonymous`를 호출합니다. 피드·좋아요는 수집 활성 여부나 `behaviorReader()`를 확인하지 않고 항상 이 ID를 사용합니다.

게이트웨이는 `/api/user/anonymous`의 성공 응답을 직접 관찰한 경우에만 해당 ID의 서명 HttpOnly `news_reader` 증명을 발급합니다. 수집 세션 API는 `{reader_id:기존ID}`를 받아 같은 ID의 유효한 `news_reader` 또는 기존 `news_behavior` 증명이 있는지 확인하고, `news_behavior` 수집 쿠키만 발급합니다. 이 API는 새 독자를 생성하지 않습니다. 두 쿠키의 서명 목적을 분리해 서로 바꿔 쓸 수 없게 했습니다. Origin·소유자·내부 토큰 검증도 유지합니다.

기존 localStorage ID에 서버 발급 증명이 없으면 임의로 쿠키에 바인딩하거나 다른 독자를 발급하지 않습니다. 수집만 비활성화하고 같은 ID로 피드·좋아요를 유지합니다. UUID 형식이나 ID를 알고 있다는 사실만으로 소유권을 증명할 수 없기 때문입니다. 기존 사용자도 모두 수집하려면 백엔드의 소유권 검증/안전한 연결 계약이 추가로 필요합니다. 서로 다른 독자의 이력을 자동 병합하지 않습니다.

수집 쿠키만 삭제하거나 만료돼도 독자 ID는 바뀌지 않습니다. 아직 유효한 reader 증명이 있으면 같은 ID로 수집 쿠키만 재발급합니다. reader 증명까지 없거나 만료되면 수집을 끄며, 새 독자를 생성하지 않습니다. 수집 해제·로깅 장애·키 교체도 독자 ID와 좋아요 소유자를 바꾸지 않습니다. localStorage 자체를 삭제했을 때만 원래 익명 독자 정책에 따라 새 ID를 발급합니다. 이전 버전에서 이미 덮어쓴 ID·분리된 이력을 이 변경이 임의 추정해 복원하지는 않습니다.

이후 피드 요청의 reader_id가 수집 쿠키와 같은 경우에만 최종 응답의 served 저장을 시도합니다. 저장 ACK를 확인한 응답에는 collection_enabled=true, 세션 불일치·저장 장애에는 collection_enabled=false를 붙입니다. 뉴스 백엔드의 정상 응답은 두 경우 모두 화면에 반환합니다. 이 수집 문맥은 익명 뉴스 API 전체에 대한 계정 인증을 의미하지 않습니다.

served는 화면에 제공하려던 후보 기록이며 실제 노출의 증거가 아닙니다. 100행씩 전송하므로 후속 배치 실패 시 앞서 커밋한 배치는 남습니다. 피드 전체를 원자적으로 커밋하거나 완료 표시를 저장하지 않습니다. 모든 배치 ACK를 받아야 해당 응답의 행동 수집을 켭니다. 새 피드 요청에는 백엔드가 새 request_id·impression_id를 발급하며, 동일 ID·동일 내용의 전송 재시도만 duplicate입니다. served에 대응하는 exposure가 없어도 미노출·비선호로 단정할 수 없습니다. 화면 표시 전 종료와 수집 손실도 구분되지 않으므로 분석에서는 미확인으로 취급합니다.

pagehide에서 beacon 전송을 요청해도 ACK가 아니므로 큐를 제거하지 않습니다. fetch와 beacon이 겹치면 같은 불변 event_id·본문을 보내며 서버는 최초 커밋에 accepted, 동일 재전송에 duplicate를 반환합니다. pageshow에서 남은 큐를 재시도하고 accepted/duplicate ACK 후 제거합니다. 노출은 pagehide/visibilitychange에서 현재 구간을 한 번 종료하고 복귀 시 새 구간을 시작하므로, 보이지 않던 시간과 이전 구간을 합산하지 않습니다. 브라우저 테스트는 persisted=true 수명주기 이벤트를 직접 발생시켜 이 계약을 검사하며 실제 BFCache 채택 여부를 보장하지 않습니다.

화면은 카드 50% 이상 표시·탭 visible·스크롤 정지 상태의 연속 구간을 exposure로 기록합니다. 구간 종료 시 전송하며 빠른 노출도 원본에 남깁니다. 클릭은 목록 링크 활성화 시 article_open, 좋아요/취소는 백엔드가 changed=true로 성공한 뒤에만 전송합니다. 조회·복원·실패는 좋아요 이벤트를 생성하지 않습니다. 상세 체류시간을 목록 노출에 합치지 않습니다.

브라우저는 고정 event_id·내용으로 지수 재시도하며 탭 sessionStorage 큐를 새로고침 뒤 복원합니다. 401·403을 영구 입력 오류로 일괄 폐기하지 않습니다. SESSION_REQUIRED는 같은 canonical reader_id로 수집 세션을 복구한 뒤 원래 ID·본문을 재전송합니다. 동시 실패는 하나의 복구 요청을 공유하고 이미 복구한 뒤 도착한 이전 403은 중복 세션 발급을 만들지 않습니다. 복구에는 유효한 reader 증명이 필요하며 새 익명 ID를 만들지 않습니다. 증명이 없으면 30초간 세션 복구 재호출을 제한하고 기존 이벤트를 큐/TTL 범위 안에서 보류합니다. Origin·인증 설정 오류 등 다른 401·403도 보류·재시도하며 세션 재발급을 반복하지 않습니다. online/focus 또는 retryBehaviorEvents()로 재시도할 수 있습니다.

behavior-queue-changed에는 pending, dropped, retrying, lastError, sessionState를 보고합니다. 화면의 role=status 안내에도 대기·폐기 건수를 표시합니다. 영구 입력 오류(400/409/413/415), 개별 rejected ACK, TTL 만료, 큐 상한, 수집 비활성화로 큐를 비울 때에는 폐기 건수를 증가시킵니다. accepted/duplicate는 폐기로 집계하지 않습니다. 큐는 500건·약512KiB·30분 이내입니다. pagehide의 sendBeacon도 같은 ID를 사용하며 수신 ACK를 보장하지 않습니다. 강제 종료·큐 만료에서는 손실 가능성이 있습니다. 수집은 열람에 대해 선택적 기능입니다. 상태 조회·세션 발급이 실패하거나 응답 형식이 잘못되면 readerId=null, 수집 비활성 상태로 기존 뉴스 독자 발급·localStorage 경로를 사용합니다. 각 초기화 요청과 제공 기록 전체 저장 시도의 대기 시간은 1.5초로 제한합니다. served 저장 실패·거절·세션 불일치 시에도 피드·상세·다음 페이지·좋아요는 유지하고 해당 응답의 행동 수집만 비활성화합니다. 이미 확인한 독자 ID는 수집 활성 상태와 분리해 유지하므로 좋아요 소유자가 바뀌지 않습니다. 수집 비활성 시 미확인 큐를 비우며 새 노출·클릭·좋아요 이벤트를 만들지 않습니다. 후속 피드에서 served ACK를 확인하면 수집을 다시 켤 수 있습니다.

이 정책은 뉴스 가용성을 우선하며, 장애 구간의 제공·행동 데이터 완전성은 보장하지 않습니다. 커밋한 기록을 성공으로 되돌리거나 허위 ACK를 만들지 않습니다. 장애 중에도 모든 원본을 보존해야 한다면 별도로 영속 outbox와 검증 대기 수신을 구현해야 합니다. 실제 뉴스 백엔드 자체의 장애는 기존과 같이 오류로 표시합니다.

GCP의 정적 프런트엔드는 기존 Nginx를 유지합니다. 같은 출처 행동 경로·피드 경로·익명 독자 발급 경로를 별도 Node 게이트웨이로 전달합니다. 예시는 [Nginx include](../../docs/logging-server/behavior-proxy-nginx.conf)입니다. `docker build --target behavior-proxy`를 이용할 수 있습니다. NEWS_BACKEND_URL이 같은 피드 프록시로 돌아오는 순환 구조가 되지 않게 합니다. 이 프록시의 production Nginx/서비스 배포는 아직 실행하지 않았습니다.

## 수신 API

문서 `/docs`, 생존 `/health`, 인증된 상태 `/ready`를 제공합니다. 내부 API는 Bearer 키가 필요합니다.

- POST /internal/served: `{records:[...]}`
- POST /events: `{events:[...]}`와 검증된 x-news-reader, x-collection-enabled:true, x-news-source:browser|simulator
- POST /internal/served-file: file(JSONL), request_id, expected_item_count multipart. 전체 검증·원자 커밋 후에만 200

두 served 경로 모두 추천 메타데이터 `score`(유한 JSON 숫자 또는 fallback의 null), `model_version`(문자열 또는 null), `features_as_of`(시간대가 있는 ISO 8601 문자열 또는 null)를 선택적으로 받습니다. 기존 필드만 있는 레코드도 수락합니다. 전달된 값과 명시적 null은 원본 저장 JSON과 내보내기 JSONL에 보존합니다. 프록시는 기사별 점수를 전달하고, 모델 버전과 피처 기준 시각은 기사별 값이 없을 때 피드 공통 값을 사용합니다. 백엔드가 생략한 값은 생략합니다.
- POST /internal/flush: PostgreSQL에서는 202로 Airflow 모드를 알림. 즉시 실행은 구간을 지정한 DAG 수동 실행
- POST /internal/delete-user: `{reader_id:string}`. 철회 후 GCS 원본·manifest·DB 삭제. 읽기·삭제 권한 필요

JSON ACK는 accepted/duplicate/rejected/retryable을 유지합니다. accepted는 PostgreSQL 커밋이며 GCS 저장 완료가 아닙니다. 본문 전체 256KiB, 배치 1~100행, 행동 4KiB입니다. event_time/served_at은 과거24시간~미래5분 이내입니다. HTTP 400/401/403/413/415/503과 개별 rejected를 구분합니다. 본문에 reader_id/source를 넣어 신뢰 문맥을 우회할 수 없습니다.

백엔드 app/log_sender.py의 파일 형식도 받지만 해당 전송기는 현재 Bearer 헤더를 설정하지 않습니다. 실제 사용 시 담당자가 인증을 추가해야 합니다. 현재 일반 화면 경로는 프록시가 served JSON을 전달하므로 해당 전송기 변경 없이 화면부터의 흐름을 시험할 수 있습니다.

## 5분 구간과 중복 없는 GCS 저장

```text
served/interval_start={UTC start}/interval_end={UTC end}/part-{job_id}.jsonl.gz
actions/interval_start={UTC start}/interval_end={UTC end}/part-{job_id}.jsonl.gz
manifests/{job_id}.json
```

실행 구간별로 독자와 스트림에 따라 여러 gzip 파일을 생성할 수 있습니다. DB에는 조회용 received_at 인덱스를 추가합니다.

작업은 stream·독자·DAG 실행 구간별 최대1000행입니다. DB 트랜잭션으로 job_id·구성원·객체명·내용·SHA-256을 고정합니다. GCS는 if_generation_match=0으로 새 객체만 생성합니다. 기존 객체가 있으면 동일 generation을 읽고 실제 내용 hash를 비교합니다. 다르면 덮어쓰지 않고 오류로 남깁니다. 객체와 manifest 성공 뒤에만 uploaded와 GCS generation receipt를 커밋합니다. 업로드 뒤 DB 갱신 전 종료해도 같은 객체를 확인해 복구합니다.

업로드 실패는 Airflow 태스크를 실패 처리합니다. 재시도마다 DB 연결을 새로 열어 해당 구간의 미완료 작업만 처리합니다. API의 다음 수신도 끊긴 연결을 복구합니다. 미내보내기 행은 보관량 상한을 계속 사용하므로 장기간 실패한 구간은 Airflow에서 복구해야 합니다. 대량 성능 검증은 후속입니다.

session advisory lock은 DB 연결이 살아 있는 동안만 유효합니다. Airflow 태스크는 외부 쓰기 전후와 상태 갱신 전에 같은 연결·미철회 작업을 확인하며, 연결을 잃은 export 안에서는 자동 재접속하지 않습니다. 삭제 시 객체·manifest 이름을 deletion_targets에 영구 기록하고, 다음 DAG 실행마다 이 목록의 잔여 객체를 삭제합니다. 원본과 작업을 삭제한 뒤에도 철회 표시와 이 정리 목록은 유지합니다. 이미 시작한 GCS 요청은 DB 잠금 유실 후에도 완료될 수 있어 삭제 응답 후 파일이 일시적으로 다시 나타날 수 있습니다. 후속 정리가 성공해야 사라지며 DAG 중단·삭제 권한 부족 동안은 남을 수 있습니다. 즉시 부활 방지를 보장하지 않으며 Airflow 태스크에 읽기·생성·삭제 권한이 필요합니다. PostgreSQL 연결 강제 종료 → 사용자 삭제 → 지연 업로드 완료 → 후속 내보내기 정리 순서를 통합 시험합니다. 목록 전체 재검사의 비용 최적화는 후속입니다.

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

PG/GCS 시험 환경변수가 있으면 일반 화면 브라우저 테스트가 노출·클릭·좋아요·취소, 응답 유실 후 재시도, 서명 없는 요청 차단, DAG 태스크 함수 실행과 GCS 원본의 event_id 대조까지 검증합니다. 가상 기사·시험 사용자만 사용합니다. 에뮬레이터는 IAM·실제 Cloud SQL·GCS 운영 배포를 검증하지 않습니다.

## 이전 SQLite 구현

LOGGING_STORE=sqlite를 명시하면 이전 SQLite·로컬 파일 경로로 회귀 시험할 수 있습니다. 기본 경로가 아니며 PostgreSQL이나 GCS 성공으로 해석하지 않습니다. 기존 SQLite DB·로컬 파일은 자동 삭제·이전하지 않습니다. 과거 DB v1~v5 마이그레이션과 Node hash 호환 시험은 유지합니다. 과거 Node `.mjs`는 fixture이며 npm 서비스 start는 Python을 실행합니다.

공식 근거: [GCS 조건부 업로드](https://docs.cloud.google.com/python/docs/reference/storage/latest/google.cloud.storage.blob.Blob), [psycopg 트랜잭션](https://www.psycopg.org/psycopg3/docs/basic/transactions.html), [GCS 에뮬레이터](https://github.com/fsouza/fake-gcs-server).

### 저장 대상 변경 시 주의

prepared 작업이 남아 있는 동안 GCS_BUCKET/GCS_PREFIX를 바꾸지 않습니다. 작업 내용과 객체명은 DB에 고정하지만 bucket/prefix는 Airflow 태스크 환경에서 주입합니다. 저장 대상 이전은 기존 작업 처리와 객체 대조를 마친 뒤 별도 절차로 진행합니다.
