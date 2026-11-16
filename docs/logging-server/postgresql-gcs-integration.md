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
