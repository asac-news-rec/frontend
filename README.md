# 사이 뉴스 프론트엔드

합성 로그 실습의 페르소나 5명과 입력 생성 명령은 [합성 로그 에이전트](docs/behavior-collection/synthetic-logging-agent.md)를 참조하세요. 현재 관심사 이름은 프런트엔드 시연 데이터 기준이며 백엔드 DB 카테고리는 확인되지 않았습니다.

로컬 브라우저 클릭 초기 버전은 같은 문서의 **브라우저 클릭 초기 버전** 절을 따릅니다. 가상 독자 전용 세션에서 화면의 기사를 선택·클릭하고 `article_open`을 실제 로깅 서버로 보냅니다. 일반 화면과 운영 정적 배포의 행동 수집 연결은 아직 없습니다.

같은 소스로 로컬 개발과 GCP Nginx 정적 배포를 지원합니다. 환경별 브랜치는 만들지 않습니다.

## 로컬 실행

Node.js 24.21.0이 필요합니다. 백엔드 저장소 안내에 따라 PostgreSQL·API·Nginx를 먼저 실행합니다. 백엔드 Nginx는 기본 http://127.0.0.1:8080/ 입니다.

```powershell
npm ci
# 기본 백엔드: http://127.0.0.1:8080/
# 다른 PC·포트의 백엔드 Nginx를 사용할 때만 설정합니다.
$env:NEWS_BACKEND_URL='http://127.0.0.1:8080/'
npm start
```

접속: http://127.0.0.1:4173/ (`npm run dev`도 동일). 소스를 수정하면 서버를 종료하고 다시 시작합니다. 현재 자동 재빌드 기능은 없습니다.

브라우저 요청은 백엔드 참고 화면과 동일하게 `/api/v1/news/feed`, `/api/v1/category`, `/api/v1/subcategory`, `/api/v1/user/anonymous`, `/api/v1/news/{article_id}/like`를 사용합니다. 로컬 개발 서버는 이 경로와 `/images/*`를 백엔드 Nginx로 그대로 전달합니다. `NEWS_BACKEND_URL`은 `/api/`가 없는 Nginx 루트 주소입니다. FastAPI의 8000 포트가 아니라 Nginx의 8080 포트를 사용합니다. `PUBLIC_ORIGIN`을 지정한다면 실제 브라우저 주소와 일치시켜야 합니다. 기본 실행에서는 `127.0.0.1`을 사용합니다.

백엔드가 꺼져 있으면 연결 오류를 표시합니다. 샘플 데이터로 자동 대체하지 않습니다. 로컬 서버는 화면 파일과 백엔드 프록시만 제공하며 SQLite·방문자 쿠키 API를 실행하지 않습니다. `.local/`은 개발·기존 회귀 테스트용 컴파일 결과이며 배포하지 않습니다.

## GCP 배포

`Dockerfile`의 `production` 타깃은 이 저장소에서 빌드한 `dist/`를 Nginx 이미지에 포함합니다. Nginx는 `/`에서 화면을 제공하고 `/api/` 요청을 같은 Cloud Run 서비스의 FastAPI에 전달합니다.

프런트 CI는 이미지와 정적 화면·API 프록시를 검사합니다. 배포를 활성화하면 `main`에서 빌드한 이미지를 Artifact Registry에 올리고 Cloud Run `news-feed`의 `nginx` 컨테이너 이미지를 갱신합니다. 최초 활성화와 검증 절차는 [Cloud Run 프런트 배포 안내](docs/contracts/frontend-deployment.md)를 참조하세요.

## Docker 로컬 실행 (선택)

```powershell
# Docker Desktop과 백엔드를 먼저 실행합니다.
$env:NEWS_BACKEND_URL='http://host.docker.internal:8080/'
docker compose up -d --build --wait
node scripts/verify-docker.mjs
```

접속: http://127.0.0.1:4181/ . 종료: `docker compose down`. Docker Compose는 `local` 빌드 타깃을 사용하며 개발 서버만 실행합니다. 기존 `visitor-data` 볼륨은 연결하거나 삭제하지 않습니다. 데이터가 필요할 수 있으므로 `down -v`를 사용하지 않습니다.

Node가 설치되지 않은 빌드 환경에서는 Docker로 정적 결과만 추출할 수도 있습니다.

```powershell
docker build --target static --output type=local,dest=./site .
```

이때 `site/` 내용이 `dist/`와 같은 배포 결과물입니다. 결과물 추출용 `static` 타깃은 실행 컨테이너가 아닙니다.

## 뉴스 API와 현재 한계

- 브라우저 API: `GET /api/v1/news/{article_id}`, `POST /api/v1/user/anonymous`, `POST /api/v1/category`, `POST /api/v1/subcategory`, `POST /api/v1/news/feed`, `PUT/DELETE /api/v1/news/{article_id}/like`.
- 첫 피드 조회 전에 `POST /api/v1/user/anonymous`를 본문 없이 호출합니다. 브라우저는 백엔드가 발급한 `news_reader` 쿠키를 후속 요청에 보냅니다. 피드 첫 요청은 필터만 담고, 다음 요청은 같은 필터와 직전 응답의 `next_cursor`를 담습니다. 좋아요 등록·해제는 본문 없이 호출합니다.
- 피드 최상위 `reader_id`가 없는 성공 응답도 허용합니다. 기사의 `is_synthetic` 값에 따라 가상 여부를 표시합니다.
- 추천 모델과 운영 행동 수집 서버는 연결하지 않았습니다. 로컬 가상 독자 세션의 클릭 수집만 별도 지원합니다. 기사 상세는 `#article/{article_id}`로 직접 진입하거나 새로고침할 수 있습니다. 상세 본문과 최신 좋아요 상태는 GET 응답의 `content`에서 읽습니다. 상세 로딩·404·연결 오류와 재시도를 구분하며 목록 복귀 시 필터와 스크롤을 유지합니다.
- 백엔드 참고 화면과 동일하게 기존 `localhost:8001`·`127.0.0.1:8001` 이미지 URL은 `/images/`로 연결합니다. DB를 바꾸지 않으며 외부 HTTP(S) 이미지 URL은 유지합니다.
- 기존 `server.ts`, 방문자·샘플 서버와 관련 테스트는 회귀 확인용으로 남아 있습니다. 기본 로컬 실행이나 운영 정적 빌드에는 사용하지 않습니다.

## 검증

```powershell
npm run check
npm test
npm run build
docker compose config
git diff --check
```

테스트는 실제 외부 백엔드 없이 시험용 HTTP 백엔드로 API 전달을 검증합니다. 운영 Nginx 연결과 실제 GCP 기동은 배포 환경에서 별도 검증해야 합니다.

## FastAPI 로깅 서비스

별도 로깅 서버는 Python FastAPI로 실행합니다. JSON 수신·영속 ACK와 백엔드 JSONL 파일 업로드 계약, 기존 DB 이전, 실행·검증 명령은 [로깅 서비스 안내](services/logging-server/README.md)를 참고하세요. 프런트엔드 화면·정적 배포 방식은 그대로 유지합니다.

## 일반 화면 행동 수집과 PostgreSQL·GCS

`LOGGING_URL`과 서버용 `LOGGING_TOKEN`을 설정하면 기본 백엔드 화면에서 목록 노출·기사 열기·좋아요/취소를 수집합니다. 같은 출처 프록시가 독자를 확인하고 FastAPI가 PostgreSQL 커밋 후 응답합니다. 별도 worker가 발생 시각 KST 5분 구간 JSONL을 GCS에 저장합니다. 테이블 시간 파티션은 만들지 않습니다. [전체 실행 및 제한](services/logging-server/README.md), [인프라 연동 계약](docs/logging-server/postgresql-gcs-integration.md)을 참고하세요.

## v1·상세 조회 전환과 배포 순서

백엔드 PR #9가 반영된 API를 먼저 배포한 뒤 이 프런트를 배포합니다. 새 `/api/v1/news/feed`에는 본문이 없고, 상세 `GET /api/v1/news/{article_id}`의 `content.paragraphs`에서 읽습니다. 기존 `/api/news/feed`는 백엔드 호환 경로이며 이 프런트의 기본 요청에는 사용하지 않습니다. 백엔드만 이전 이미지로 롤백하면 새 주소가 없어지므로, 필요하면 이전 프런트 이미지를 먼저 복원한 뒤 백엔드를 복원합니다.

상세 응답의 `request_id`는 상세 요청 식별자입니다. 목록의 `impression_id`를 대체하거나 새 노출로 기록하지 않습니다. 목록에서 열면 해당 목록 노출을 유지하고, 직접 진입한 기사에는 임의 노출 ID를 만들지 않습니다. 로깅·합성 게이트웨이는 v1 피드에서도 제공 기록 저장을 거칩니다. 운영용 게이트웨이 배치는 별도 후속 작업입니다.

로컬 프록시는 v1 경로와 기존 경로를 모두 허용합니다. 상세 GET은 브라우저가 Origin 헤더를 생략할 수 있어 허용하며, 다른 Origin 또는 cross-site Fetch Metadata를 명시한 요청은 거절합니다. 상태 변경 요청은 기존처럼 정확한 Origin과 method·본문 검증을 유지합니다. 피드·상세·좋아요의 401은 #34의 자동 복구 경로를 사용합니다.

상세 회귀 검증: `npm run test:browser` (Playwright Chromium 필요). 설치된 Chrome으로 검증할 때는 `PLAYWRIGHT_CHANNEL=chrome`을 지정할 수 있습니다. `article-detail.test.mjs`는 시험용 HTTP 백엔드와 실제 로컬 프록시로 본문 없는 목록, 상세 직접 진입·새로고침, 응답 경합, 404/503 재시도, 쿠키 전달·좋아요·스크롤 복원을 확인합니다. 운영 API 배포 검증을 대신하지 않습니다.

## 열린 탭의 익명 쿠키 복구

피드·상세·좋아요 요청이 401을 받으면 같은 탭의 동시 실패를 하나의 익명 재발급으로 합칩니다. Web Locks를 지원하는 브라우저에서는 첫 발급과 재발급 모두 같은 잠금을 사용합니다. 재발급을 시작할 때 요청 세대를 바꾸고 이전 독자의 목록·상세·좋아요·행동 큐를 비웁니다. 이전 세대의 성공 응답이나 ACK가 새 상태를 덮지 않도록 폐기합니다. 이미 서버에 커밋된 이전 독자의 행동은 삭제하지 않고, 미확인 큐를 새 독자로 재전송하지 않습니다.

복구 후에는 행동 세션을 다시 연결하고 현재 카테고리·소분류의 첫 페이지를 한 번 조회합니다. 상세 화면에 있었다면 목록으로 돌아옵니다. 실패한 좋아요와 이전 페이지 커서는 재전송하지 않습니다. 새 독자는 이전 독자의 좋아요를 이어받지 않습니다. 복구 중에는 안내를 표시하고 좋아요를 다시 눌러야 함을 알립니다. 재발급 실패나 지속 401은 오류 화면에 표시하고 명시적인 재시도로 복구를 다시 시작합니다. 재시도는 익명 발급 API를 다시 호출하며, 유효한 쿠키가 있으면 백엔드가 같은 독자를 반환할 수 있습니다. 403이나 로깅 전용 세션 장애는 익명 독자 재발급의 원인으로 취급하지 않습니다.

회귀 검증은 `tests/browser/reader-cookie-recovery.test.mjs`에서 실제 쿠키 삭제, 겹치는 401, 지연된 이전 응답, 기존 큐 폐기, 필터 보존, 재발급 실패·재시도를 재현합니다. 시험용 기사·독자만 사용합니다. 실제 운영 쿠키와 PostgreSQL/GCS 데이터는 수정하지 않습니다.
