# 로깅 서버 개발안과 분할 구현 순서

작성일: 2026-11-02 · 버전 0.1 · 상태: 설계 제안, 서버 미구현

## 배포 경계 · 사용자 확정 사항

로깅 서버는 프론트엔드·뉴스 서버와 별도 프로세스·컨테이너·배포 서비스로 실행한다. 개발 초기부터 독립 진입점, 포트, 환경변수, Dockerfile, health/readiness를 갖춘다. 기존 server/http.mjs 안에 로깅 저장·worker를 넣고 동일 배포로 운영하지 않는다.

같은 Git 저장소 안의 services/logging-server로 개발하는 안을 우선 제안한다. 저장소를 함께 쓰는 것과 함께 배포하는 것은 다르다. 별도 저장소 여부·배포 플랫폼은 아직 미정이다. 로깅 서비스만 독립 빌드·실행·테스트·재시작할 수 있어야 한다.

브라우저는 동일 출처 /api/v1/events를 호출하고 프록시·게이트웨이가 독립 로깅 서버로 전달하는 안이다. 독립 배포가 브라우저의 cross-origin 직접 호출을 반드시 의미하지 않는다. 별도 API 도메인 직접 호출을 선택하면 인증·CORS·쿠키 계약을 추가 확정한다. 뉴스 서버의 served는 인증된 내부 API로 전달한다.

## 1. 개발 목표와 범위

프론트엔드가 만든 행동과 뉴스 서버가 만든 반환 기록을 받아 안전하게 보관하고, 발생 시각별 5분 경로에 JSONL 원본 파일을 저장한다. 브라우저가 accepted를 확인한 기록은 로깅 서버 재시작만으로 사라지지 않게 한다.

사용자 지시에 따라 우리 담당 범위를 로깅 서버까지 확장한다. 기사 DB·추천 모델·Valkey·Airflow DAG·BigQuery 가공 구현은 별도 담당 영역으로 유지한다. 파일 생성과 적재를 연결할 인터페이스는 함께 정의한다. 이번 작업은 문서 작성이며 서버나 클라우드를 구축하지 않았다.

기준은 [첨부 인터페이스 규약](../meetings/2026-11-03/news_interface_contract.html)과 현재 src/event-transport.js다. 정상 행동은 events 배열 한 건으로 즉시 전송한다. 서버가 여러 기록을 모아 파일로 쓰는 FLUSH와 브라우저 전송 시점을 분리한다. 현재 모의 수락은 실제 로깅 서버 수락이 아니다.

## 2. 권장 구조와 기술 선택

초기 로컬 구현은 기존 저장소의 Node.js와 node:sqlite를 사용한다. 현재 런타임 기준 Node 24.19 이상을 유지한다. 언어는 기존 Node를 재사용하되 처음부터 독립 HTTP 서비스로 만든다. 순수 로깅 모듈과 HTTP 경계를 분리한다. 실제 팀의 서버 언어가 정해지면 wire 계약과 검증 사례를 유지하고 구현 언어를 조정한다.

```text
브라우저 → 동일 출처 POST /api/v1/events
                     ↓ 웹 백엔드: 식별·수집 허용·추천 건 소유 확인
                 Logging intake
뉴스 서버 → 인증된 내부 served 요청 ↗
                     ↓ 트랜잭션 커밋
           SQLite 영속 수신함 + 중복 인덱스 → ACK
                     ↓ 별도 FLUSH worker
           고정된 파일 작업과 구성원 확정
                     ↓
       로컬 파일 sink → 검증 후 GCS sink로 교체
                     ↓
            manifest → Airflow·BigQuery 담당자
```

SQLite는 운영용 수신함·중복 제거·업로드 작업 상태다. 기사 DB나 분석 DB를 새로 만드는 의미가 아니다. 메모리 버퍼만으로 성공 응답한 뒤 서버 재시작 시 잃는 문제를 줄이기 위해 추가한다. 초기 범위는 단일 수신 프로세스·단일 worker·영속 디스크다. 여러 인스턴스가 각자 임시 SQLite를 갖는 배포는 이 설계의 지원 범위 밖이다.

컨테이너 재생성 시 유지되는 볼륨과 디스크 백업·용량 관리가 필요하다. Cloud Run의 인스턴스 로컬 파일이나 GKE의 임시 디스크에 두고 영속 저장이라 부르지 않는다. 다중 인스턴스·관리형 배포가 요구되면 공유 DB 또는 영속 큐 기반 설계를 확정한 뒤 배포한다. 아직 배포 플랫폼·부하·비용은 확인하지 않았다.

## 3. 먼저 고정할 계약

### 행동 수집

브라우저 외부 경로 제안은 POST /api/v1/events다. 로깅 독립 서비스의 내부 경로는 POST /events로 매핑할 수 있다. MIME은 application/json, 브라우저는 동일 출처를 사용한다. 실제 서비스 간 인증은 내부 키 또는 서비스 인증으로 별도 설정하며 프론트에 비밀 키를 넣지 않는다.

```json
{
  "events": [{
    "event_id": "b2ff0121-743e-4f15-a4e5-f577970216a3",
    "event_type": "article_open",
    "event_time": "2026-11-02T00:00:04.000Z",
    "impression_id": "imp-001",
    "page_type": "list"
  }]
}
```

공통 필드는 event_id:UUID, event_type:exposure|article_open|like|unlike, event_time:시간대 포함 ISO, impression_id:string, page_type:list|detail이다. exposure만 duration_ms:양의 정수와 ended_at:시작 이후 또는 같은 ISO 시각을 갖는다. 다른 종류에 두 필드를 넣지 않는다. action 필드는 없다. article_open은 list만 허용한다.

reader_id·기사·순서는 본문에서 받지 않고 검증된 impression_id의 served 레코드로 연결한다. 클라이언트 UUID는 브라우저 식별값이지 인증 수단이 아니다. 기존 쿠키와 새 UUID 매핑·직접 진입·수집 허용·폐기 규칙은 웹 백엔드와 확정한다. 독립 로깅 서버에 쿠키 원문을 복사하지 말고 검증된 내부 사용자 컨텍스트를 전달한다. 외부 요청이 내부 사용자 헤더를 위조하지 못하게 경계를 나눈다.

### 반환 기록 수신

내부 POST /internal/served 제안. 외부 브라우저에 노출하지 않는다.

```json
{
  "records": [{
    "request_id": "req-001",
    "impression_id": "imp-001",
    "reader_id": "u001",
    "article_id": "A",
    "position": 1,
    "served_at": "2026-11-02T00:00:00.000Z"
  }]
}
```

뉴스 서버가 최종 응답의 값 그대로 보낸다. 최종 제외 기사는 기록하지 않는다. impression_id가 중복 키다. 웹 백엔드는 served 영속 수락을 먼저 확인한 뒤 해당 ID를 클라이언트에 노출하는 연결을 초기안으로 권장한다. 로깅 장애 시 뉴스 반환을 지연·실패시킬지, 웹 서버 outbox로 독립할지는 팀이 결정해야 한다. 뉴스 응답과 외부 수신은 하나의 원자적 트랜잭션이 아니므로 응답 유실·미노출 반환도 impression에 포함될 수 있다.

아직 등록되지 않은 impression_id의 action은 즉시 영구 거절하지 않는다. 초기 권장 순서에서는 HTTP 503 + Retry-After로 재시도를 요구하고 클라이언트가 같은 ID를 유지하게 한다. 등록이 영구히 누락되면 프론트 TTL 후 폐기될 수 있으므로 별도 지표로 경보한다. 임의 ID 저장을 허용하는 우회는 하지 않는다. 비동기 served 수락을 채택하면 검증 대기 상태와 TTL을 추가 설계해야 한다.

### ACK 의미와 오류

수신함 트랜잭션이 성공적으로 커밋된 후 HTTP 200을 반환한다. GCS 업로드는 기다리지 않는다. accepted는 영속 수신함 수락이지 GCS·BigQuery 완료가 아니다. 응답은 현재 프론트 results 파서와 맞춘다.

```json
{
  "results": [
    {"event_id":"b2ff0121-743e-4f15-a4e5-f577970216a3","status":"accepted"}
  ]
}
```

- accepted: 새 기록 수락. duplicate: 동일 ID·동일 의미 본문이 이미 수락됨.
- rejected + code: 영구 형식·권한·동일 ID 다른 내용 오류. retryable + code: 같은 ID로 재시도 가능.
- 잘못된 JSON·envelope는 HTTP 400, MIME 415, 크기 413, 처리량 제한 429, 저장소 장애 503.
- 요청 전체를 해석할 수 있으면 이벤트별 결과를 반환한다. 잘못된 event_id도 안전하게 표현 가능한 값만 반사한다. 프론트가 보낸 ID 집합과 응답을 대조한다.
- 동일 요청 내부의 중복·충돌도 검사한다. 같은 ID의 상충 내용은 덮어쓰지 않는다. 배치 내 다른 정상 이벤트는 독립 수락할 수 있다.

현재 프론트 transport는 네트워크 예외를 모두 재시도한다. HTTP adapter 연결 단계에서 400/413/415·401/403의 영구 실패/수집 중단, 429의 Retry-After를 구분하도록 보완해야 한다. 모의 구현만 보고 이 처리가 완료됐다고 판단하지 않는다.

## 4. 초기 제한과 시간 규칙

아래 숫자는 성능 측정 결과가 아닌 테스트 가능한 초기 설정안이다. 환경변수로 두되 이벤트 의미를 바꾸는 변경은 measurement_version에 기록한다.

| 항목 | 초기안 |
|---|---|
| 이벤트 개수 | 1~100, 프론트는 항상 1 |
| 전체 HTTP 본문 | 256KiB, 스트리밍 읽기 도중 제한 |
| 이벤트별 크기 | 4KiB, 초과는 해당 이벤트 거절 |
| ID 길이 | UUID event_id, 그 외 불투명 ID 최대 128자 |
| 구간 길이 | 양의 정수, 최대 24시간 제안 |
| 클라이언트 시각 | 수신보다 최대 24시간 과거·5분 미래 제안, 초과 격리/거절 |
| FLUSH 시작 | 대기 1,000건 또는 가장 오래 대기한 기록 30초 |
| 파일 제한 | 파티션별 최대 1,000행·8MiB 제안 |
| 저장 경로 | event_time 또는 served_at의 KST 5분 바닥값 |
| worker | 1개, 업로드 한 작업씩, 실패 시 지수 재시도 |

구간 event_time은 시작, ended_at은 끝이다. duration_ms는 단조 시계 경과값이다. Date 시계 조정·절전으로 두 차이가 다를 수 있어 허용 오차·격리 정책을 확정한다. 서버가 duration을 수신 시각으로 임의 대체하지 않는다. 긴 구간은 프론트에서 분할하는 계약을 따로 확정한다.

예: UTC 00:02와 00:04는 KST hour=09/minute=00, UTC 00:07은 minute=05. 5분 파티션은 GCS 경로이며 FLUSH 주기나 BQ 5분 테이블 파티션이 아니다. 지연 기록은 과거 경로에 새 파일로 추가한다. 경로는 닫힌 불변 집합이 아니다.

## 5. 저장 구조와 상태 모델

### 논리 테이블

| 테이블 | 핵심 컬럼·제약 | 목적 |
|---|---|---|
| served_records | impression_id PK, request_id, reader_id, article_id, position, served_at, received_at, canonical_hash | 반환 메타데이터·온라인 소유권 대조 |
| action_records | event_id PK, impression_id 참조, event_type, page_type, event_time, ended_at nullable, duration_ms nullable, received_at, canonical_json, canonical_hash, source, schema_version, measurement_version | 실제 수락 원본과 중복 판정 |
| export_jobs | job_id PK, stream, partition_path, object_name UNIQUE, content_hash, row_count, status, attempts, next_attempt_at, generation nullable, last_error | 고정된 파일 생성·재시도 상태 |
| export_members | job_id, stream, record_id, PK(stream,record_id) | 한 기록을 하나의 내보내기 작업에 고정 |
| deletion_tombstones | reader_id 또는 수집 세대 키, revoked_at, 상태 | 삭제 뒤 늦은 요청·재처리 복원 방지 |

SQL 타입·인덱스·마이그레이션을 1단계 산출물로 고정한다. FK·트랜잭션을 사용하고 기록 수락과 작업 배정을 분리한다. served 로그의 wire 필드를 raw JSONL에 유지하며 추가 버전·source·received_at은 서버 메타데이터다. 같은 JSON 키 순서만 달라도 충돌하지 않도록 정의한 필드 순서로 canonical JSON을 만든다. 시간 표기는 UTC로 정규화한 후 비교하고 최초 수신 시각은 hash에서 제외한다. 동일 ID·다른 사용자도 충돌/권한 오류이며 재귀속하지 않는다.

중복 인덱스를 지우면 오래된 재전송을 다시 수락할 수 있으므로 보관 기간은 허용 지연·재처리 범위를 포함해 확정한다. 이 문서가 무기한 보관을 결정하지 않는다.

### 파일 작업 상태

```text
수락된 원본 → 미배정
             ↓ DB 트랜잭션으로 구성원·고정 객체명 확정
           prepared → uploading → uploaded
                ↑        ↓ 실패/결과 미확인
                └── 같은 job_id·객체명·내용으로 재시도
```

단일 worker 초기안에서는 새 프로세스가 uploading을 발견하면 같은 작업으로 복구한다. 신규 worker 병렬 실행을 지원하려면 lease·소유권을 추가한다. API 수신 요청은 worker 때문에 오래 열린 트랜잭션에 묶지 않는다. SQLite 동기 처리의 요청 지연은 실제 부하로 검증한다.

## 6. FLUSH와 파일 저장 계약

1. 주기 스케줄러가 요청 유무와 무관하게 FLUSH 조건을 검사한다.
2. 미배정 원본을 stream·KST 5분 경로로 나눈다. 각 작업의 구성원·행 순서·객체명·hash를 트랜잭션으로 고정한다.
3. 원본에서 같은 JSONL bytes를 재생성한다. UTF-8, 한 줄 한 객체, 마지막 개행, 안정된 필드·행 순서를 사용한다.
4. 로컬 sink는 임시 파일 쓰기·동기화·원자적 rename을 사용하고 기존 동일 객체는 hash를 검증한다.
5. GCS sink는 고정 객체명에 create-only precondition을 사용한다. 재시도마다 임의 UUID 파일을 새로 만들지 않는다.
6. 성공 또는 기존 동일 객체 확인 후 generation·hash를 저장하고 uploaded로 갱신한다. 원본은 보관 정책 전까지 유지한다.
7. 업로드가 성공했지만 DB 갱신 전 종료되면 같은 객체를 조회해 size/hash를 확인하고 복구한다. 412를 무조건 성공으로 해석하지 않는다.

객체 경로 제안:

```text
served/date=2026-11-02/hour=09/minute=00/part-{job_id}.jsonl
actions/date=2026-11-02/hour=09/minute=00/part-{job_id}.jsonl
manifests/{job_id}.json
```

manifest는 object_name, generation, stream, partition_path, row_count, content_hash, schema_version, exported_at을 포함한다. 데이터 파일 수락 이후 별도 manifest 작업을 멱등 실행한다. manifest 실패를 데이터 재업로드로 해결하지 않는다. 같은 파티션에 나중 파일이 추가될 수 있어 manifest 하나는 해당 파일 완료만 의미한다. 전체 5분 구간의 최종 완료를 뜻하지 않는다.

GCS 생성 시 ifGenerationMatch=0은 기존 객체가 없는 경우만 쓰게 제한할 수 있다. 이를 고정 객체명과 결합하는 것은 이번 설계 선택이다. [Google Cloud Storage 요청 사전조건](https://docs.cloud.google.com/storage/docs/request-preconditions)

## 7. 역할별 코드 구조 제안

```text
services/logging-server/
  main.mjs         독립 실행 진입점·포트·종료 처리
  http.mjs         로깅 전용 HTTP 경계
  Dockerfile       독립 이미지 빌드
  README.md        단독 실행·테스트·설정 안내
  schema.mjs       요청 파싱·형식·시간 검증
  repository.mjs   SQLite 커밋·중복·충돌·삭제·작업 배정
  intake.mjs       수락 결과와 사용자/추천 문맥 검증
  partition.mjs    KST 5분 경로와 안정된 JSONL 생성
  exporter.mjs     FLUSH·재시도·종료·재시작 복구
  local-sink.mjs   로컬 객체 저장
  gcs-sink.mjs     이후 GCS adapter
프록시/게이트웨이   외부 동일 출처 경로를 독립 로깅 서비스로 전달
scripts/          재현·수집/내보내기 검증 명령
```

현재 scripts/check.mjs는 server 바로 아래 파일만 검사한다. services/logging-server 도입 시 해당 서비스의 독립 검사·테스트 명령을 추가하고 루트 검증에도 포함한다. build.mjs는 정적 화면 빌드이므로 서버 패키징·Docker 검증을 대신하지 않는다. 최소 내부 시그니처는 intakeActions(context,events), intakeServed(context,records), prepareExports(now), exportJob(job,sink)로 둔다. 실제 개수와 파일 경계는 중복이 생기지 않는 범위에서 단순화한다.

## 8. 분할 개발 순서와 완료 증거

각 단계는 하나의 커밋 또는 리뷰 가능한 변경 단위로 끝낸다. 앞 단계의 실제 입출력을 확인한 후 다음 단계로 진행한다.

| 단계 | 구현 | 완료 기준·필수 검증 |
|---|---|---|
| 1. 계약·영속 수신함 | 스키마, SQLite migration, canonical hash, action/served 수락 함수 | 재시작 후 기록 유지, 같은 ID duplicate, 다른 내용 conflict, 잘못된 입력·시간 거절 |
| 2. 독립 로컬 HTTP 서비스 | 별도 진입점·포트·Dockerfile, events·내부 served 경로, ACK, 인증 경계·본문 제한·오류 | 실제 HTTP 1건 커밋 후 ACK, 저장 실패 시 성공 금지, 배치 내 중복·충돌·부분 결과 |
| 3. 프론트 실제 HTTP 연결 | mock/HTTP adapter 구분, request/ACK 매핑, 영구 오류·429 분류 | event_id가 실제 수신함까지 추적, 응답 유실 재전송 1건, 탐색 중단 없음 |
| 4. 로컬 FLUSH | 5분 경로, 고정 작업·JSONL 파일, 주기·수량 조건 | 30초 동안 새 요청 없어도 기록 export, 다른 5분 구간 분리, 다음 FLUSH에서 재기록 없음 |
| 5. 장애 복구·운영 제한 | 중간 종료 복구, 재시도·용량·backpressure·삭제 | 업로드 전후 강제 종료에서도 누락·이중 파일 없음, 저장 공간 부족 시 503/수락 제한, 늦은 요청 차단 |
| 6. GCS adapter | 서비스 계정 권한, create-only·기존 객체 확인, manifest | 실제 버킷 객체·hash·generation 확인, 권한 실패 복구, 업로드 성공 응답 유실 재현 |
| 7. 적재 인계·완료 자료 | manifest 규약·재처리 정보·운영 가이드 | 데이터 담당자가 시험 event_id로 BQ 결과 확인, 중복 적재에도 정제 1건, 삭제 재적재 방지 확인 |

1단계는 HTTP·GCP 없이 저장 함수를 검증한다. 2단계는 프론트 없이 HTTP 입력으로 검증한다. 3단계에서 처음 브라우저와 실제 로깅 경로를 연결한다. 이렇게 나누면 화면 측정 오류와 서버 저장 오류를 분리할 수 있다.

3단계 전에는 뉴스 서버에서 served 문맥을 제공받아야 한다. 아직 없다면 인증된 로컬 fixture로 시험하고 실제 뉴스 반환 통합을 완료했다고 보고하지 않는다. 현재 mock의 메모리 ID를 무조건 신뢰하는 허용 경로를 운영 API에 넣지 않는다.

6단계의 GCP 프로젝트·버킷·배포·키 발급은 실제 계정·권한·비용 범위를 확인한 뒤 진행한다. 그 전까지 로컬 sink와 장애 테스트로 독립적으로 개발 가능하다. Airflow DAG와 학습 파이프라인은 담당자와 인계하며 이번 문서가 그 구현 완료를 의미하지 않는다.

## 9. 운영·삭제·인계에서 빠뜨리지 않을 것

지표는 수신·수락·duplicate·rejected·conflict·미등록 impression, 대기 건수·최고 대기 나이, FLUSH 성공/실패·재시도, 디스크 사용량, 마지막 업로드 시각이다. 내용·쿠키·토큰을 운영 로그에 그대로 남기지 않는다. 상태 확인용 health와 저장소/worker 상태 readiness를 구분한다.

종료 시 신규 수락을 멈추고 진행 중 DB 커밋을 마무리하며 worker는 제한 시간 내 종료한다. 무한 GCS 대기는 하지 않는다. 미완료 작업은 영속 상태로 남겨 다음 실행에서 복구한다. 초기에는 수신 프로세스와 worker의 단일 실행을 강제한다.

삭제 요청은 수집 중단·서버 거절 기준을 먼저 확정하고, 해당 사용자의 미배정·준비·업로드 중 작업을 직렬화해 처리한다. 이미 여러 사용자가 섞인 JSONL은 개별 행을 제자리 삭제할 수 없으므로 원본 재작성·기존 generation 삭제·BQ/피처 삭제·manifest 갱신과 재처리 차단이 필요하다. 해당 정책 확정 전 전체 삭제 완료를 표시하지 않는다. 단계 5에서 로컬 삭제를, 단계 6~7에서 원격 삭제 전파를 검증한다.

데이터 담당자는 파일 존재만으로 전체 도착 완료를 판단하지 않는다. 이벤트 없는 구간·업로드 실패·지연 파일을 구분한다. manifest와 처리 체크포인트를 받아 센서 대기와 스키마·중복·참조 품질 검사를 분리한다. 지연 도착 허용·음성 라벨 확정·데이터 보관·삭제 SLA는 공동 결정한다.

## 10. 다음 실행 작업

다음 지시는 “로깅 서버 1단계: 계약·영속 수신함 구현”으로 시작한다. 산출물은 스키마·저장 모듈·migration·함수 테스트와 결과 기록이다. HTTP 공개·GCS·프론트 전환은 뒤 단계로 유지한다. 저장소 파괴나 기존 visitors/likes 초기화는 수행하지 않는다.

공식 참고: [Node SQLite](https://nodejs.org/api/sqlite.html), [GCS 요청 사전조건](https://docs.cloud.google.com/storage/docs/request-preconditions). 현재 Node 버전 호환성을 실제 실행으로 확인하고, GCS SDK 의존성은 6단계에서 고정한다.

배포 검증 추가 기준: 프론트·뉴스 서버를 재시작해도 로깅 프로세스와 수신함은 유지되고, 로깅 서버만 재시작해도 프론트는 계속 동작하며 실패 전송은 재시도된다. 로깅 서비스 이미지에 프론트 화면·방문자 DB를 묶지 않는다. 로컬 compose에서도 별도 서비스와 로깅 전용 볼륨을 둔다.

## 1단계 구현 기록 · 2026-11-02

services/logging-server에 독립 package.json, schema.mjs, repository.mjs, 테스트와 README를 추가했다. Node 24.19.0에서 검증했다. served_records/action_records만 migration v1로 구현했으며 export·삭제 테이블은 후속 단계에서 도입한다. 기존 visitors/likes DB는 변경하지 않았다.

파일 DB 재열기 유지, 중복·충돌·사용자 소유권, 시간대·키 순서 정규화, 입력 오류·수집 비허용, 미등록 추천 건 재시도, 저장 오류 전체 rollback, 미래 스키마 거절을 테스트했다. 루트 검사·테스트에도 독립 서비스 검증을 포함했다.

아직 HTTP 인증·실제 브라우저 연결·삭제 원자성·FLUSH·GCS는 미구현이다. context.internal과 readerId는 저장 코어의 trusted 호출 계약이지 외부 HTTP 인증 수단이 아니다. 다음 단계에서 별도 포트·진입점·Dockerfile과 검증된 컨텍스트 전달을 구현한다.

## GCS 직전 로컬 구현 기록 · 2026-11-02

사용자 요청으로 2~5단계의 로컬 구현을 진행했다. 독립 main/http·bearer 내부 경계, 전용 Docker/compose, 웹의 명시적 시험 프록시와 ?feed=logging, 로컬 FLUSH·고정 파일·manifest·재시작 복구·재시도·사용자별 삭제를 구현했다. API accepted는 실제 SQLite 커밋이다.

브라우저의 article_open ID b9586418-fb77-47be-8e31-97d3ff60ac75를 실제 actions JSONL에서 확인했다. 기본 실행 경로는 services/logging-server/data/objects다. 전체 테스트·서비스 Docker 검증 결과와 실행 방법은 서비스 README를 따른다. 인메모리 모의·실제 로컬 HTTP·실제 운영 연결을 구분한다.

초기 설계 대비: 로컬 삭제를 위해 사용자별 파일을 분리했다. schema v3에서 export 작업·구성원·revoked_users를 도입했다. worker는 같은 단일 프로세스에서 주기 실행하며 독립 이미지 배포다. 공유 볼륨의 다중 writer·부하 성능·운영 디스크 quota·보관 자동화는 미지원이다. 요청률 제한 429·Retry-After 완전 대응, 실제 뉴스 서버 사용자/동의 통합은 후속 범위다.

GCS adapter·클라우드 배포·Airflow/BQ 작업은 구현하지 않았다. 해당 계정·저장소가 준비되면 고정 객체명·hash·manifest 계약으로 교체하되 사용자별 작은 파일·삭제·병합 전략도 함께 확정한다.

## reader_id 명칭 적용

현재 HTTP 요청·DB schema v4·내부 readerId 문맥은 reader_id 기준으로 통일했다. 이전 DB는 시작 시 컬럼과 중복 판정용 반환 JSON·해시를 이전한다. 이미 준비한 내보내기 작업은 복구를 위해 원래 파일 내용을 유지한다. 세부사항은 services/logging-server/README.md를 따른다.

## 2026-11-10 FastAPI 전환

현재 실행 진입점은 `services/logging-server/logging_service`의 독립 FastAPI 서비스입니다. 기존 Node 진입점은 Python 실행 호환기로 바뀌었습니다. SQLite schema v5·영속 ACK·중복 판정·5분 JSONL·manifest·복구·삭제를 유지합니다. 백엔드 파일 전송용 `/internal/served-file`은 multipart 전체 원자 수락을 지원합니다. 백엔드 전송기 인증 헤더 연결은 별도 담당자 변경이 필요하며 운영 통합 완료를 의미하지 않습니다. 위의 Node 설계·단계 기록은 개발 당시의 이력입니다. 최신 실행·검증·마이그레이션은 [서비스 README](../../services/logging-server/README.md)를 따릅니다.

## 2026-11-10 PostgreSQL·GCS 연결

일반 화면의 노출·클릭·좋아요/취소를 같은 출처 프록시로 전달하고 PostgreSQL 커밋 후 ACK하도록 확장했습니다. worker는 별도 프로세스에서 발생 시각 KST 5분 구간 JSONL을 GCS에 조건부 생성하고 receipt와 작업 상태를 갱신합니다. 테이블을 5분 단위로 나누지 않습니다. 최신 실행·재시도·권한·검증 범위는 [서비스 README](../../services/logging-server/README.md)를 따릅니다. 로컬 에뮬레이터 검증과 실제 GCP 연결을 구분합니다.
