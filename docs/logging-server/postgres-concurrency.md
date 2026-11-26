# PostgreSQL 수집 동시성 개선 (B안)

## 범위와 상태

이슈 #65. Pub/Sub Draft #64와 분리한 `main` 기반 변경입니다. HTTP ACK는 여전히
**DB 트랜잭션 커밋 완료**이며 PostgreSQL 스키마, GCS JSONL/gzip/manifest, Airflow
export 구간과 독자 식별 계약을 변경하지 않습니다. 외부 토픽·버킷·서명 키를 추가하지 않습니다.

`LOGGING_POSTGRES_POOL_ENABLED=true`로 새 경로를 선택합니다. 기본값은 `false`라서
이미지만 머지·배포하면 기존 경로가 유지됩니다. 실제 운영 설정 변경·성능 재시험은 별도입니다.

## 수집 경로

```text
요청 → 풀에서 연결 대여 → 공유 maintenance 잠금
     → 독자별 잠금 → 레코드 ID별 잠금
     → 기존 형식·소유자·중복 검증 (다른 독자와 병렬)
     → 짧은 전체 용량 잠금 → COUNT/일괄 INSERT/COMMIT → 연결 반환 → ACK
```

기존 API의 프로세스 RLock·연결 하나 대신 요청마다 독립 연결/트랜잭션을 사용합니다.
하나의 독자에 대한 순서는 유지하고 다른 독자의 검증/조회는 병렬 실행합니다.
DB 고유 키는 그대로 최종 무결성 방어선이며, 독자가 달라도 같은 impression/event ID를
보내는 경우는 레코드 잠금으로 직렬화해 기존 `duplicate`/`conflict` 결과를 유지합니다.

현재 전체 용량 제한을 정확히 지키기 위해 **전체 잠금을 완전히 제거하지 않습니다.**
새 레코드의 최종 용량 확인과 INSERT부터 COMMIT까지는 직렬화합니다. `COUNT`는 이 구간에
남아 있으므로 성능 한계가 사라졌다고 주장하지 않습니다. `capacity_wait_ms`가 커지면 다음
병목으로 평가합니다. 한 요청의 검증된 실제 신규 레코드 수로 제한을 검사하며, 무효 행과
동일 요청 내 중복은 신규 용량에 포함하지 않습니다. 초과 시 전체 삽입이 롤백됩니다.

파일 일괄 업로드는 전체 검증 실패 시 아무 행도 커밋하지 않습니다. 일반 수집은 기존처럼
행별 거절 결과를 반환하고 유효 행을 함께 커밋합니다. 응답 유실 후에는 원래 ID·내용으로
재시도하며, 오류가 났다는 이유만으로 저장되지 않았다고 가정하지 않습니다.

## 잠금과 기존 worker 호환

| 잠금 | 새 수집 | 기존 API / export / delete / prune |
|---|---|---|
| `INTAKE_LOCK=2700101` | 트랜잭션 공유 잠금 | 기존 트랜잭션 배타 잠금 |
| reader namespace `2700201` | 정렬된 독자 키에 배타 잠금 | 필요 없음: 전체 gate로 차단 |
| served/action namespace `2700202/2700203` | 정렬된 레코드 키에 배타 잠금 | 필요 없음: 전체 gate로 차단 |
| `CAPACITY_LOCK=2700103` | 최종 용량 확인~커밋 배타 잠금 | 필요 없음: 전체 gate로 차단 |
| `EXPORT_LOCK=2700102` | 사용하지 않음 | 기존 세션 잠금 유지 |

항상 gate → 독자 → 레코드 → 용량 순서로 획득합니다. 다중 독자/ID 배치는 정렬·중복 제거 후
획득하고, 한 도메인의 잠금들을 SQL 한 번으로 받아 기사 수만큼 DB 왕복하지 않습니다.
독자/레코드의 SHA-256 앞 32비트와 2인자 advisory namespace를 사용합니다. 해시 충돌은
추가 직렬화만 만들며 소유자·내용 검증을 대신하지 않습니다. 1인자 maintenance/export 키와
2인자 독자/레코드 키는 PostgreSQL의 별도 키 공간을 사용합니다.

기존 worker 코드를 바꾸지 않아도 공유/배타 gate로 동기화됩니다. 따라서 구/신 API가 섞인
rolling 배포 동안에도 기존 삭제·전체 용량 보호가 유지됩니다. 기존 API나 export 준비가 gate를
잡으면 새 수집이 기다릴 수 있습니다. 모든 작업이 독자별로 완전히 병렬화되는 설계는 아닙니다.

삭제 API는 풀 연결을 장시간 점유하는 대신 별도 `PostgresStore` 연결에서 기존 Exporter를
실행합니다. GCS 호출 전후의 export lease 확인, revoked tombstone, 지연 업로드 청소를
유지합니다. 세션 advisory lock을 가진 연결을 풀로 반환하지 않습니다. 일반 export/prune도
기존 전용 연결을 유지합니다. 새로운 Airflow 테이블 권한이나 raw 소비자 수정은 필요 없습니다.

## 설정과 타임아웃

| 변수 | 기본값 | 의미 |
|---|---|---|
| `LOGGING_POSTGRES_POOL_ENABLED` | `false` | `true`일 때 PostgreSQL 수집 API만 풀 사용 |
| `LOGGING_POSTGRES_POOL_SIZE` | `4` | 프로세스당 연결 수, 1~32 |
| `LOGGING_POSTGRES_POOL_TIMEOUT` | `1` | 연결 대여 대기 초, 0 초과~5 이하 |

pool 대기열은 64개로 제한합니다. 연결은 READ COMMITTED, `lock_timeout=1000ms`,
`statement_timeout=5000ms`로 설정합니다. 이 값들은 개별 대여/잠금/SQL 제한이며 요청 전체의
1초 제한이 아닙니다. 게이트웨이의 기존 1.5초 served ACK 제한은 유지합니다. 대기열 초과,
풀 고갈, DB 잠금 시간 초과는 503으로 응답하며 성공 ACK하지 않습니다.

DB 연결 예산은 `최대 인스턴스 수 × 프로세스 수 × pool_size`에 기존 백엔드·Airflow·삭제·기동
확인용 연결을 더해 잡습니다. 풀 크기를 무조건 늘리면 DB 연결 수/부하가 늘 수 있습니다.
처음에는 4로 검증하고 Cloud SQL의 실제 연결 여유를 확인합니다. 여러 인스턴스가 서로 다른
`LOGGING_MAX_RECORDS`를 쓰지 않도록 설정을 통일합니다.

## 관측 지표와 재시험

500ms 이상이거나 예외가 발생한 작업은 `logging_pool_transaction` 로그를 남깁니다.

- `pool_wait_ms`: 연결 대여 시간, 연결 반환은 포함하지 않음
- `maintenance_wait_ms`: 공유 gate 획득 SQL 시간
- `reader_wait_ms`, `record_wait_ms`: 각 도메인의 잠금 획득 SQL 시간
- `capacity_wait_ms`: 최종 용량 잠금 획득 SQL 시간
- `work_ms`: 전체 시간에서 위 시간을 뺀 나머지. 검증·일반 SQL·커밋/롤백·연결 반환 포함
- `failed`: 작업 예외 여부. `false`라도 개별 이벤트가 검증 거절될 수 있음

잠금 지표에는 DB 왕복/획득 SQL 실행 시간도 포함됩니다. 순수 DB lock wait나 CPU 시간으로
해석하지 않습니다. 식별자·이벤트·쿠키·접속 문자열은 이 로그에 기록하지 않습니다.
인증된 `/ready`에는 기존 집계와 pool 통계가 추가됩니다. 집계는 모니터링용이며 원자적인
전체 DB 스냅샷이나 성능 합격 판정이 아닙니다.

리뷰·CI 통과 후 새 이미지를 배포하고 작은 트래픽에서 pool 설정을 켭니다. 동일 데이터 패턴,
방문 속도, VU 사전 할당과 중단 기준으로 10회/초 → 20회/초 순서로 재시험합니다. HTTP 200
비율뿐 아니라 collection_enabled, 클릭 ACK, p95, 위 대기 지표, Cloud SQL 연결·CPU,
GCS export·삭제 결과를 확인합니다. 로컬 병렬성 테스트 통과만으로 운영 처리량 개선을
확정하지 않습니다. 이상 시 즉시 증량을 멈춥니다.

롤백은 `LOGGING_POSTGRES_POOL_ENABLED=false`로 바꾸거나 이전 리비전으로 트래픽을
되돌립니다. 동일 스키마·ACK·export 계약이므로 별도 데이터 변환이나 토픽 정리가 없습니다.
이미 커밋됐으나 ACK를 잃은 요청은 기존 ID로 재시도합니다. DB/볼륨은 삭제하지 않습니다.

## 검증 명령

`TEST_POSTGRES_URL`은 CREATE DATABASE 권한이 있는 **로컬 테스트 DB**로 지정합니다.
테스트는 고유 이름의 임시 DB를 생성하고 그 DB만 정리하며 전달된 원본 DB를 truncate하지
않습니다. GCS 테스트는 `STORAGE_EMULATOR_HOST`로 로컬 에뮬레이터를 지정합니다.

```bash
cd services/logging-server
python -m pip install -r requirements-dev.txt
python -m pytest python_tests -q
```

실제 PostgreSQL에서 서로 다른 독자의 병렬 진행, 동일 ID 중복·내용 충돌, 다중 독자 배치
잠금 순서, 여러 pool/구 API의 전체 용량 제한, 수집과 삭제 경쟁, 연결 고갈/잠금 timeout 후
복구, 기존 GCS JSONL/manifest·재시도·삭제를 검증합니다.

참조: [Psycopg 연결 풀](https://www.psycopg.org/psycopg3/docs/advanced/pool.html),
[PostgreSQL advisory lock](https://www.postgresql.org/docs/16/explicit-locking.html#ADVISORY-LOCKS).
