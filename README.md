# 마이뉴스 프론트엔드

## CI 실행 범위

로깅 CI는 PostgreSQL·GCS·HTTP 통합 검증과 브라우저 회귀 검증을 별도 작업으로 병렬 실행합니다.
PR에서 문서, 로깅 Python 테스트, `postgres.py`·`postgres_pool.py`·`postgres.sql`만 바뀌면
브라우저 검증을 생략합니다. HTTP API·공통 store·의존성·화면·프록시·workflow 및 알 수 없는
경로 변경은 브라우저 검증을 유지합니다. `scripts/ci-browser-scope.mjs`가 삭제·이름 변경도
포함한 PR 전체 diff를 판정합니다. `main` push와 수동 실행은 항상 전체 검증합니다.

기존 필수 체크 이름 `test`는 필요한 작업이 모두 성공해야 통과하는 최종 확인 작업입니다.
경로 판정 실패나 필요한 검증의 실패·취소는 배포를 막습니다. 브라우저 테스트별 제한은 2분,
통합/브라우저 작업별 제한은 8분입니다. 새 PR 커밋이 오면 이전 커밋의 CI를 자동 취소하지만
`main` 배포 실행은 취소하지 않습니다. 프런트 기본 검증은 모든 PR에서 유지됩니다.

화면 API로 쿠키 발급·피드 조회·로그 저장과 부하를 검증하는 절차는 [k6 로그 입력·부하 실험](docs/behavior-collection/k6-logging-load.md)을 참조하세요.

합성 로그 실습의 페르소나 5명과 입력 생성 명령은 [합성 로그 에이전트](docs/behavior-collection/synthetic-logging-agent.md)를 참조하세요. 현재 관심사 이름은 프런트엔드 시연 데이터 기준이며 백엔드 DB 카테고리는 확인되지 않았습니다.

로컬 브라우저 클릭 초기 버전은 같은 문서의 **브라우저 클릭 초기 버전** 절을 따릅니다. 가상 독자 전용 세션에서 화면의 기사를 선택·클릭하고 `article_open`을 실제 로깅 서버로 보냅니다. 일반 화면과 운영 정적 배포의 행동 수집 연결은 아직 없습니다.

같은 소스로 로컬 개발과 GCP Nginx 정적 배포를 지원합니다. 환경별 브랜치는 만들지 않습니다.

## 로컬 실행

Node.js 24.21.0이 필요합니다. 백엔드 저장소 안내에 따라 PostgreSQL·API를 먼저 실행하고, 아래 Docker 로컬 실행 절차로 프런트 Nginx를 실행합니다. Nginx는 기본 http://127.0.0.1:8080/ 입니다.

```powershell
npm ci
# 기본 백엔드: http://127.0.0.1:8080/
# 다른 PC·포트의 프런트 Nginx를 사용할 때만 설정합니다.
$env:NEWS_BACKEND_URL='http://127.0.0.1:8080/'
npm start
```

접속: http://127.0.0.1:4173/ (`npm run dev`도 동일). 소스를 수정하면 서버를 종료하고 다시 시작합니다. 현재 자동 재빌드 기능은 없습니다.

브라우저 요청은 백엔드 참고 화면과 동일하게 `/api/v1/news/feed`, `/api/v1/category`, `/api/v1/subcategory`, `/api/v1/user/anonymous`, `/api/v1/news/{article_id}/like`를 사용합니다. 로컬 개발 서버는 이 경로와 `/images/*`를 프런트 Nginx로 그대로 전달합니다. Node 개발 서버용 `NEWS_BACKEND_URL`은 `/api/`가 없는 Nginx 루트 주소입니다. FastAPI의 8000 포트가 아니라 Nginx의 8080 포트를 사용합니다. `PUBLIC_ORIGIN`을 지정한다면 실제 브라우저 주소와 일치시켜야 합니다. 기본 실행에서는 `127.0.0.1`을 사용합니다.

백엔드가 꺼져 있으면 연결 오류를 표시합니다. 샘플 데이터로 자동 대체하지 않습니다. 로컬 서버는 화면 파일과 백엔드 프록시만 제공하며 SQLite·방문자 쿠키 API를 실행하지 않습니다. `.local/`은 개발·기존 회귀 테스트용 컴파일 결과이며 배포하지 않습니다.

## GCP 배포

`Dockerfile`의 `production` 타깃은 이 저장소에서 빌드한 `dist/`를 Nginx 이미지에 포함합니다. Nginx는 `/`에서 화면을 제공하고 `/api/` 요청을 같은 Cloud Run 서비스의 FastAPI에 전달합니다.

프런트 CI는 이미지와 정적 화면·API 프록시를 검사합니다. 배포를 활성화하면 `main`에서 빌드한 이미지를 Artifact Registry에 올리고 Cloud Run `news-feed`의 `nginx` 컨테이너 이미지를 갱신합니다. 최초 활성화와 검증 절차는 [Cloud Run 프런트 배포 안내](docs/contracts/frontend-deployment.md)를 참조하세요.

## Docker 로컬 실행 (선택)

```powershell
# Docker Desktop과 백엔드 PostgreSQL·FastAPI를 먼저 실행합니다.
# 백엔드 Compose에 Nginx가 남아 있다면 실행하지 않습니다.
docker compose up -d --build --wait
node scripts/verify-docker.mjs
```

접속: http://127.0.0.1:8080/ . 종료: `docker compose down`. Docker Compose는 `local-nginx` 빌드 타깃으로 빌드된 정적 화면을 제공합니다. 소스 변경 후에는 다시 빌드합니다. `/api/` 접두사를 제거해 FastAPI로 전달합니다(예: `/api/v1/category` → `/v1/category`). 기본 대상은 `host.docker.internal:8000`이며 Docker Desktop에서 호스트에 공개한 FastAPI 포트를 사용합니다. Linux에서는 해당 호스트 게이트웨이에서 FastAPI에 접근할 수 있어야 합니다.

포트를 바꿀 때는 실행과 검증을 같은 PowerShell 세션에서 수행합니다. `FASTAPI_UPSTREAM`에는 스킴·경로 없이 `호스트:포트`를 지정합니다. Compose는 Node 개발 서버용 `NEWS_BACKEND_URL`을 사용하지 않습니다.

```powershell
$env:NEWS_PORT='8089'
$env:FASTAPI_UPSTREAM='host.docker.internal:8008'
docker compose -p frontend-nginx-check up -d --build --wait
node scripts/verify-docker.mjs
docker compose -p frontend-nginx-check down
Remove-Item Env:NEWS_PORT, Env:FASTAPI_UPSTREAM
```

Nginx 컨테이너의 healthcheck는 정적 화면만 확인합니다. 검증 스크립트는 `/api/health`의 200 응답도 검사하므로 FastAPI가 필요합니다. 기본 Nginx 구성은 행동 수집 게이트웨이를 실행하지 않습니다. 로컬 행동 수집 작업은 기존 Node 개발 서버 절차를 사용합니다.

기본 8080은 기존 접속 주소를 유지하기 위한 선택입니다. 이미 백엔드 Nginx가 사용 중이라면 백엔드 폴더에서 `docker compose stop nginx`로 해당 서비스만 중지한 뒤 프런트를 실행합니다. 다른 프로젝트가 사용 중이면 해당 서비스를 임의로 중지하지 말고 위 예제처럼 `NEWS_PORT`를 변경합니다. 자동으로 다른 컨테이너를 중지하거나 포트를 변경하지 않습니다.

`FASTAPI_UPSTREAM`은 시작 시 템플릿에 적용되고 호스트명도 Nginx 기동 시 해석됩니다. Compose에서 미설정 또는 빈 값은 기본값으로 대체합니다. 직접 이미지 실행 시 빈 값 또는 `http://` 스킴은 잘못된 설정으로 기동 실패할 수 있고, 경로가 포함되면 전달 경로가 달라지므로 반드시 `호스트:포트`만 지정합니다. 호스트명은 해석되지만 FastAPI가 꺼져 있으면 화면은 제공되며 API 요청은 연결 거절 시 502(연결 시간 초과 시 504)입니다. 같은 주소에서 FastAPI가 복구되면 다음 요청부터 연결됩니다. 호스트 IP가 바뀌면 Nginx를 재시작합니다.

`/api/v1/category?x=1`은 `/v1/category?x=1`, `/api/`는 `/`로 전달됩니다. `/api`는 먼저 `/api/`로 301 리다이렉트되므로 클라이언트는 처음부터 슬래시가 있는 API 주소를 사용해야 합니다. health 계약은 [백엔드 실행 안내](https://github.com/asac-news-rec/backend/blob/main/README.md)의 상태 확인 주소(`/api/health`, 직접 실행 `/health`)를 따릅니다. 로컬 HTTP의 익명 쿠키를 사용하려면 백엔드의 `READER_COOKIE_SECURE=false` 설정이 필요합니다. Nginx는 쿠키 속성을 수정하지 않습니다.

생성 이미지가 있으면 기존 디렉터리를 읽기 전용으로 연결합니다. 마운트가 없으면 `/images/`는 404이며 화면은 기본 일러스트를 표시합니다. 경로가 없으면 override 실행은 실패하며 디렉터리를 자동 생성하지 않습니다.

이전 백엔드 Nginx와 동일한 `location /images/` + `alias /srv/images/` 매핑입니다. 예를 들어 `/images/day/a%20b.svg`는 마운트 루트의 `day/a b.svg`를 읽습니다. 마운트가 없거나 해당 파일이 없으면 404이며, 디렉터리가 존재하지만 index 파일이 없으면 목록을 노출하지 않고 403을 반환합니다.

```powershell
$env:NEWS_IMAGES_DIR=(Resolve-Path '../backend/generate/local_generate/output_with_thumbnail').Path
docker compose -f compose.yaml -f compose.images.yaml up -d --build --wait
# 종료할 때도 같은 -f 옵션을 사용합니다.
docker compose -f compose.yaml -f compose.images.yaml down
```

운영 `production` 타깃의 Nginx 80 → FastAPI 8000 설정은 바뀌지 않습니다. 기존 `visitor-data` 볼륨은 연결하거나 삭제하지 않습니다. 데이터가 필요할 수 있으므로 `down -v`를 사용하지 않습니다.

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

로컬 프록시는 v1 경로와 기존 경로를 모두 허용합니다. 상세 GET은 브라우저가 Origin 헤더를 생략할 수 있어 허용하며, 다른 Origin 또는 cross-site Fetch Metadata를 명시한 요청은 거절합니다. 상태 변경 요청은 기존처럼 정확한 Origin과 method·본문 검증을 유지합니다. 익명 쿠키 만료 시 401 자동 복구는 #34의 별도 작업입니다.

상세 회귀 검증: `npm run test:browser` (Playwright Chromium 필요). 설치된 Chrome으로 검증할 때는 `PLAYWRIGHT_CHANNEL=chrome`을 지정할 수 있습니다. `article-detail.test.mjs`는 시험용 HTTP 백엔드와 실제 로컬 프록시로 본문 없는 목록, 상세 직접 진입·새로고침, 응답 경합, 404/503 재시도, 쿠키 전달·좋아요·스크롤 복원을 확인합니다. 운영 API 배포 검증을 대신하지 않습니다.

## Cloud Run 행동 게이트웨이

운영용 `behavior-proxy` 타깃은 정적 파일과 합성 에이전트 API를 제공하지 않는 Node sidecar입니다.
`production-behavior` Nginx 이미지와 함께 사용하고, 기본 `production` 이미지는 기존 API 전달을
유지합니다. 최초 sidecar·Secret·IAM 설정과 명시적 활성화가 필요합니다.
[설정·검증·롤백](docs/logging-server/cloud-run-deployment.md#news-feed-행동-게이트웨이-인프라-준비-후-활성화)을
따르며, 실제 dev 준비 확인 전에는 활성화하지 않습니다. 앱 토큰과 IAM ID 토큰은 서버에만 둡니다.
