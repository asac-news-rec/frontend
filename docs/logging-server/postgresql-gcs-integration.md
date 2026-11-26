# PostgreSQL·GCS 인프라 연동 메모

상태: 코드·로컬 검증용. 실제 GCP 적용 완료가 아닙니다. 2026-11-10 인프라 main을 `6131cae`로 fast-forward하여 확인했습니다.

## 확인한 계약

- `terraform/envs/dev/storage.tf`: raw_logs는 `${var.project_id}-raw-logs`, 공개 차단·삭제 방지
- `terraform/envs/dev/iam.tf`: logging-server에 objectCreator만 부여
- `terraform/envs/dev/cloudsql.tf`: 뉴스용 Cloud SQL PostgreSQL `newsdb`. 로깅용 DB·사용자는 별도 합의 필요
- 실제 프로젝트 ID·비밀번호·ADC는 로컬 환경에서 확인되지 않음. placeholder를 실제 값으로 간주하지 않음
- Airflow DAG는 storage.tf 주석에 맞춰 gzip 압축 JSONL을 업로드

## 인프라 담당자와 맞출 항목

1. 실제 GOOGLE_CLOUD_PROJECT·GCS_BUCKET와 API/Airflow 태스크용 Workload Identity/ADC 주입
2. 전용 로깅 DB와 LOGGING_DATABASE_URL Secret, Cloud SQL Auth Proxy 연결. 뉴스 테이블과 분리된 behavior_logging schema 사용
3. Airflow 태스크에 객체 생성·읽기(storage.objects.get) 권한 부여. 읽기는 응답 유실 후 기존 객체의 내용을 확인할 때 필요
4. API의 사용자 삭제와 Airflow의 잔여 객체 정리에 삭제 권한 부여. 키·암호·토큰 값은 이슈·문서에 적지 않음
5. DAG 파일과 logging_service 패키지를 Airflow 실행 환경에 배포하고, 정적 Nginx의 behavior·news/feed·user/anonymous 경로를 동일 출처 게이트웨이에 연결
6. Airflow 실패·미처리 구간 알림, DB 용량과 보관 정책 설정
7. 정기 실행 cron·첫 구간 합의. 소비자는 UTC 수신 구간 경로의 .jsonl.gz와 작업별 manifest를 읽도록 연결

Terraform apply, IAM 확대, 버킷 생성, 실제 DB 데이터 변경은 이 작업에서 실행하지 않았습니다. 인프라 요청은 저장소의 infra-request 양식에 따라 이 값의 **키 이름과 필요한 권한만** 전달하면 됩니다.

## served_at 입력 정밀도 호환

뉴스 FastAPI가 보내는 `served_at`은 소수점 최대 6자리와 명시적 시간대를 허용합니다. 로깅 수신 시 UTC 밀리초로 정규화하고 4~6번째 자리는 버립니다. PostgreSQL·JSONL 저장과 해시·중복 판정은 기존 밀리초 단위를 유지합니다. 이 입력 확장은 `/internal/served`와 `/internal/served-file`에 동일하게 적용하며, 행동 시각의 최대 3자리 계약과 수신 시각 기준 Airflow 구간은 바뀌지 않습니다.

## 일괄 수신과 지연 진단 (이슈 #61)

제공 기록과 행동 이벤트는 요청당 최대 100개를 한 트랜잭션에서 처리합니다. 기존 기록·삭제 독자·제공 소유자를 일괄 조회하고 신규 행은 `executemany`로 삽입합니다. PostgreSQL의 psycopg는 이 삽입을 파이프라인으로 전송합니다. 제공 기록 100개 요청의 SELECT는 4회이며 기사별 SELECT 왕복을 반복하지 않습니다. 용량 집계 COUNT 자체의 비용은 여전히 남아 있습니다.

동일 요청 내 중복은 accepted 다음 duplicate, 내용 충돌은 rejected로 처리합니다. 파일 수신의 atomic 실패는 전체를 취소하며 ACK는 커밋 뒤 반환합니다. 프로세스 잠금과 PostgreSQL 공통 advisory lock은 유지하므로 인스턴스를 늘리는 것만으로 저장 병렬성이 늘어나지는 않습니다. 이 변경은 잠금 내부 DB 왕복 횟수를 줄입니다.

화면 게이트웨이의 1.5초 served 확인 제한은 유지합니다. 확인 실패 시 뉴스 HTTP 200과 `collection_enabled=false`를 유지하며 `feed_collection_disabled` 구조화 경고에 허용된 reason과 elapsed_ms만 남깁니다. `SERVED_ACK_TIMEOUT`, `SERVED_NOT_COMMITTED`, `READER_PROOF_INVALID`, `FEED_READER_MISMATCH`, `LOGGING_IDENTITY_UNAVAILABLE`, `LOGGING_UNAVAILABLE`, `SERVED_ACK_FAILED`를 구분합니다. 쿠키·토큰·독자 ID·본문·원본 예외는 기록하지 않습니다.

PostgreSQL 트랜잭션이 잠금 대기부터 처리까지 500ms 이상 걸리면 `logging_transaction_slow wait_ms=… work_ms=…`를 기록합니다. wait_ms는 프로세스 잠금·연결 복구·DB 잠금 획득까지, work_ms는 잠금 획득 후 본문 실행 시간이며 커밋 시간은 포함하지 않습니다. 이 수치만으로 DB CPU 포화를 판정하지 않습니다.

로컬 검증: Python 단위 37개, PostgreSQL/GCS 에뮬레이터 통합 12개, Node 33개 통과. 실제 PostgreSQL에서 요청 내 중복·충돌, 원자적 롤백, 용량 제한, 삭제 독자를 확인했습니다. 운영 배포와 동일 부하 재측정은 아직 수행하지 않았으므로 운영 지연 개선 폭은 미확인입니다.
