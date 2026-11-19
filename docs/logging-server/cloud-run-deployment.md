# 로깅 FastAPI Cloud Run 배포

`FastAPI logging` workflow는 테스트 통과 후 SHA 태그의 이미지를 빌드·푸시하고 기존
Cloud Run `logging-server`의 이미지를 갱신합니다. 기본 비활성 상태이며 실제 배포는
아래 인프라 준비와 리뷰·머지 뒤 진행합니다. 이벤트·DB 계약은 변경하지 않습니다.

## 최초 생성: 인프라 담당

- 프로젝트 `final-project-513508`, 리전 `asia-northeast3`, 서비스 `logging-server`.
- 런타임 `logging-server@final-project-513508.iam.gserviceaccount.com`.
- Cloud SQL `final-project-513508:asia-northeast3:news-rec-pg` 연결.
- Secret `logging-api-database-url`을 `LOGGING_DATABASE_URL`에 연결합니다.
- **24자 이상 공유 Bearer 토큰**을 Secret으로 만들고 `LOGGING_TOKEN`에 연결합니다.
  호출하는 프록시·백엔드에도 동일 값을 안전하게 전달합니다. DB URI만으로는 기동할 수 없습니다.
- `LOGGING_STORE=postgres`, `LOGGING_HOST=0.0.0.0`, `LOGGING_PORT=4195`, 컨테이너 포트 4195.
- 런타임에 Cloud SQL Client와 각 Secret의 읽기 권한을 부여합니다.
- 인그레스와 Cloud Run 호출 인증은 호출 경로에 맞춰 인프라 담당과 확정합니다.
  애플리케이션 Bearer 인증과 Cloud Run IAM 인증은 별개입니다.
- API는 PostgreSQL 수신을 담당하며 GCS 내보내기는 Airflow가 수행합니다.

## GitHub 설정

Environment `logging-production`의 배포 브랜치를 `main`으로 제한합니다.
OIDC 신뢰 조건도 이 저장소와 이 Environment에 맞춰 등록합니다.

| Environment 변수 | 값 |
|---|---|
| `GCP_PROJECT` | `final-project-513508` |
| `RUN_REGION` | `asia-northeast3` |
| `LOGGING_IMAGE` | `asia-northeast3-docker.pkg.dev/final-project-513508/news-rec/logging-server` (태그 제외) |
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | 인프라에서 준비한 Provider 전체 이름 |
| `GCP_DEPLOY_SERVICE_ACCOUNT` | 이 환경에서 사용할 배포 계정 이메일 |

배포 계정에는 해당 Artifact Registry 쓰기, 기존 `logging-server` 갱신 및 런타임
계정 사용 권한이 필요합니다. 현재 `frontend-deploy`의 `news-feed` 권한만으로는 부족합니다.
기존 계정의 권한 확대 또는 전용 계정 준비는 인프라 담당이 결정합니다.
workflow는 Secret 값·Cloud SQL·인그레스 설정을 수정하지 않습니다.

최초 서비스 생성 후 저장소 변수 `LOGGING_DEPLOY_ENABLED=true`를 설정하고
`FastAPI logging`을 `main`에서 수동 실행합니다. 이후 관련 파일의 main push에도 실행됩니다.
테스트와 Dockerfile 검증이 통과해야 배포하며, 더 최신 main이 있으면 구버전 배포를 건너뜁니다.

## 기동 이후 순서

1. `/health`와 Bearer 인증된 `/ready`를 확인합니다. URI·토큰을 로그에 출력하지 않습니다.
2. `logging_api` 소유의 `behavior_logging` 스키마·테이블 생성 확인을 주현 님에게 전달합니다.
3. 주현 님이 `airflow-grants.sql`을 적용합니다.
4. ML PR #15 머지 후 Airflow DAG 등록과 import 오류를 확인합니다.
5. PostgreSQL 수신 시각 기준 UTC 구간 하나를 수동 실행하고 gzip JSONL·manifest를 확인합니다.
   같은 구간을 재실행해 중복 객체가 생기지 않는지 확인합니다. 실제 수집과 시험 로그를 구분합니다.
6. 호출 서비스의 URL·공유 토큰·필요한 IAM 연결 후 실제 행동 요청의 PostgreSQL ACK를 확인합니다.

배포 중지는 `LOGGING_DEPLOY_ENABLED`를 끕니다. 롤백은 이전에 검증된 이미지 SHA나
다이제스트로 기존 서비스의 이미지만 갱신합니다. DB와 GCS 데이터는 삭제하지 않습니다.
