# PostgreSQL·GCS 인프라 연동 메모

상태: 코드·로컬 검증용. 실제 GCP 적용 완료가 아닙니다. 2026-11-10 인프라 main을 `6131cae`로 fast-forward하여 확인했습니다.

## 확인한 계약

- `terraform/envs/dev/storage.tf`: raw_logs는 `${var.project_id}-raw-logs`, 공개 차단·삭제 방지
- `terraform/envs/dev/iam.tf`: logging-server에 objectCreator만 부여
- `terraform/envs/dev/cloudsql.tf`: 뉴스용 Cloud SQL PostgreSQL `newsdb`. 로깅용 DB·사용자는 별도 합의 필요
- 실제 프로젝트 ID·비밀번호·ADC는 로컬 환경에서 확인되지 않음. placeholder를 실제 값으로 간주하지 않음
- storage.tf 주석의 JSONL.gz와 달리 요청에 따라 이번 구현은 비압축 JSONL

## 인프라 담당자와 맞출 항목

1. 실제 GOOGLE_CLOUD_PROJECT·GCS_BUCKET와 API/worker용 Workload Identity/ADC 주입
2. 전용 로깅 DB와 LOGGING_DATABASE_URL Secret, Cloud SQL Auth Proxy 연결. 뉴스 테이블과 분리된 behavior_logging schema 사용
3. worker에 객체 생성 + 읽기(storage.objects.get). 업로드 응답 유실 후 generation·동일 내용 확인에 필요. objectCreator 단독으로 부족
4. 사용자 삭제 경로 사용 시 객체 삭제 권한을 별도로 부여. 키·암호·토큰 값은 이슈·문서에 적지 않음
5. API와 worker 독립 실행, 기존 정적 Nginx의 behavior 경로와 news/feed 경로를 동일 출처 게이트웨이로 연결
6. 단일 worker 활성 잠금·보관 정책·DB 용량·worker 미처리 건수와 오래된 작업 알림
7. 5분 경로는 KST 발생 시각, .jsonl suffix, 늦은 도착 추가 part, manifest는 작업별 표시라는 계약을 Airflow와 합의

Terraform apply, IAM 확대, 버킷 생성, 실제 DB 데이터 변경은 이 작업에서 실행하지 않았습니다. 인프라 요청은 저장소의 infra-request 양식에 따라 이 값의 **키 이름과 필요한 권한만** 전달하면 됩니다.
