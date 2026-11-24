# Cloud Run 프런트 배포

프런트 CI가 빌드한 HTML·CSS·JavaScript를 이 저장소의 Nginx 이미지에 담습니다. Cloud Run `news-feed`에서 `nginx` 컨테이너가 80번 포트로 화면을 제공하고, `/api/` 요청은 같은 인스턴스의 `fastapi` 컨테이너(`127.0.0.1:8000`)에 전달합니다. 브라우저는 같은 출처에서 화면과 API를 사용합니다.

## 이미지 검증

```bash
docker build --platform linux/amd64 --target production -t news-web:ci .
bash scripts/smoke-cloud-run.sh news-web:ci
```

스모크 테스트는 Cloud Run의 공유 네트워크를 재현해 `/`, JS, CSS 응답과 `/api/`의 경로 전달 및 익명 발급 응답의 `Set-Cookie` 전달을 확인합니다. 없는 정적 파일과 이미지 요청은 404인지 검사합니다. GitHub Actions의 `Frontend CI`는 이 검사를 PR과 `main`에서 실행합니다. `main` 푸시의 정적 빌드 파일은 `frontend-dist-<커밋 SHA>`로 90일간 보관합니다.

## 첫 배포 설정

1. [백엔드 배포 분리 요청](https://github.com/asac-news-rec/backend/issues/6)을 통해 백엔드 릴리스가 `fastapi`만 갱신하는지 확인합니다. 첫 배포와 롤백은 백엔드 배포 시간과 겹치지 않게 조율합니다.
2. 프런트 레포의 GitHub Environment `frontend-production`을 준비하고 배포 브랜치를 `main`으로 제한합니다. 환경 변수에 아래 값을 등록합니다.

   | GitHub Actions 변수 | 값 |
   |---|---|
   | `GCP_PROJECT` | Cloud Run 프로젝트 ID |
   | `RUN_REGION` | Cloud Run 리전 |
   | `NEWS_WEB_IMAGE` | 태그 없는 Artifact Registry 이미지 경로 |
   | `GCP_WORKLOAD_IDENTITY_PROVIDER` | GitHub OIDC용 Google Cloud Workload Identity Provider 전체 리소스 이름 |
   | `GCP_DEPLOY_SERVICE_ACCOUNT` | 이미지 업로드와 Cloud Run 서비스 갱신에 사용할 서비스 계정 이메일 |

3. 인프라 담당자와 Workload Identity Federation을 연결합니다. 프런트 저장소의 승인된 배포 환경에서만 계정을 사용할 수 있게 하고, 필요한 범위의 Artifact Registry 쓰기, Cloud Run 배포, Cloud Run 런타임 계정 사용 권한을 확인합니다.
4. 설정이 준비되면 저장소 변수 `FRONTEND_DEPLOY_ENABLED`를 `true`로 설정하고 Actions에서 `Frontend CI`를 `main`으로 실행합니다. 이후 `main` 푸시마다 검증 후 커밋 SHA로 태그한 이미지를 올리고 `news-feed`의 `nginx` 이미지를 갱신합니다.

## 첫 배포와 롤백 검증

- 배포 전후 Cloud Run 리비전의 컨테이너 이미지 목록을 비교해 `nginx`만 바뀌었는지 확인합니다. 다음 백엔드 릴리스에서도 현재 Nginx 이미지가 유지되는지 확인합니다.
- 인증된 브라우저에서 화면, 익명 독자 쿠키 발급, 피드와 다음 페이지, 좋아요, 썸네일을 확인합니다. 로컬 프런트 Compose의 `/images/`는 선택 설정 `compose.images.yaml`로 마운트한 이미지 디렉터리에서 제공됩니다([로컬 실행](../../README.md#docker-로컬-실행-선택)). 현재 Cloud Run 릴리스에는 이 마운트가 없으므로 `/images/` 요청은 404이며 화면은 기본 일러스트를 표시합니다. 첫 배포에서 실제 피드의 이미지 URL을 확인하고, 상대 경로 또는 로컬 URL을 반환한다면 운영 이미지 저장소 연결을 확인합니다.
- 화면만 되돌리려면 이전 Nginx 이미지 태그 또는 다이제스트로 `nginx` 컨테이너만 갱신합니다. 배포를 일시 중지하려면 저장소 변수 `FRONTEND_DEPLOY_ENABLED`를 끕니다.
## 2026-11-09 검증 기록

- Node 검사·빌드·20개 테스트 통과. Docker 이미지 내부에서도 동일 검사·테스트 통과.
- 백엔드 `nginx/default.conf` 원본을 읽기 전용 마운트해 `nginx -t` 통과.
- 위 Nginx에 프론트 `dist/`와 시험용 API·이미지를 연결했습니다. 빌드된 프론트 API 클라이언트로 ID 발급, 카테고리·소분류, 필터 피드, 다음 페이지, 좋아요 설정·해제, 이미지 조회를 검증했습니다.
- 로컬 개발 컨테이너를 거치는 동일 흐름 및 Docker 정적 파일 추출도 통과했습니다.
- 실제 백엔드 API·PostgreSQL·GCP 환경은 검증하지 않았습니다. 검증용 컨테이너는 종료·정리했고 기존 데이터는 변경하지 않았습니다.

## 실제 백엔드·DB 연동 검증 (2026-11-09)

실제 백엔드 `app/` 소스와 저장소에 고정된 API 의존성, 원본 Nginx 설정, PostgreSQL 18을 사용했습니다. 기존 `.env`가 없어 독립 시험 DB에 `exports/newsdb_2026-11-06_reader_id.dump`를 복원했습니다. 기사·이미지 생성용 모델 의존성은 API 실행과 무관하여 검증 이미지에서 제외했습니다. 기존 DB·볼륨과 백엔드 파일은 변경하지 않았습니다.

| 확인 | 결과 |
|---|---|
| 전체 피드 | 450개 기사, 23페이지, 중복 없음 |
| 카테고리 | 13개 조회 및 필터 일치 |
| 소분류 | 소분류가 있는 12개 카테고리의 선택 필터 일치 |
| 이미지 | 첫 페이지 20개 정상 응답, 브라우저 필터 결과의 이미지도 로딩 확인 |
| 좋아요 | 저장·중복 요청·피드 재조회 유지·해제 확인 |
| 실행 경로 | Nginx 정적 배포 및 로컬 개발 서버 경유 모두 통과 |
| 브라우저 | 기사 상세, 더 보기 20→40개, 사회→교육 필터 6개, 새로고침 후 좋아요 유지·해제 재조회 통과 |
| 브라우저 로그 | 확인한 테스트 탭에 error·warn 없음 |

복원 데이터는 합성 기사이며 운영 수집 데이터가 아닙니다. 실제 GCP 환경은 검증하지 않았습니다. 시험용 독자의 좋아요는 해제했고, 확인 후 시험 컨테이너와 전용 네트워크를 정리했습니다.

## v1·기사 상세 API 선행 배포

backend PR #9의 `/api/v1/*`와 `GET /api/v1/news/{article_id}`를 백엔드에 먼저 배포합니다. 프런트는 본문 없는 v1 목록에서 상세를 별도 요청하며 직접 진입·새로고침을 지원합니다. 배포 후 목록·상세·좋아요와 상세 404를 확인합니다. 백엔드를 이전 이미지로 되돌릴 때는 새 경로를 쓰기 전의 프런트 이미지를 먼저 복원합니다. 운영 행동 게이트웨이를 연결할 때는 `/api/v1/user/anonymous`·`/api/v1/news/feed`도 증명·제공 기록 훅을 거쳐야 합니다.
