# 사이 뉴스 프론트엔드

같은 소스로 로컬 개발과 GCP Nginx 정적 배포를 지원합니다. 환경별 브랜치는 만들지 않습니다.

## 로컬 실행

Node.js 24.19.0 이상과 백엔드 API가 필요합니다.

```powershell
npm ci
# 기본 백엔드: http://127.0.0.1:8000/
# 다른 주소 또는 백엔드 Nginx를 사용할 때만 설정합니다.
$env:NEWS_BACKEND_URL='http://127.0.0.1:8000/'
npm start
```

접속: http://127.0.0.1:4173/ (`npm run dev`도 동일). 소스를 수정하면 서버를 종료하고 다시 시작합니다. 현재 자동 재빌드 기능은 없습니다.

브라우저는 `/api/v1/backend/*`로 요청하고 로컬 개발 서버가 백엔드로 전달합니다. 백엔드 Nginx에 API가 `/api/` 아래 있으면 `NEWS_BACKEND_URL=http://127.0.0.1:8080/api/`로 설정합니다. `PUBLIC_ORIGIN`을 지정한다면 실제 브라우저 접속 주소와 일치시켜야 합니다. 기본 실행에서는 `localhost` 대신 `127.0.0.1`을 사용합니다.

백엔드가 꺼져 있으면 연결 오류를 표시합니다. 샘플 데이터로 자동 대체하지 않습니다. 로컬 서버는 화면 파일과 백엔드 프록시만 제공하며 SQLite·방문자 쿠키 API를 실행하지 않습니다. `.local/`은 개발·기존 회귀 테스트용 컴파일 결과이며 배포하지 않습니다.

## GCP 배포

```powershell
npm ci
npm run check
npm test
npm run build
```

**배포 대상은 `dist/` 내용만입니다.** HTML, CSS, 브라우저 JavaScript만 포함합니다. `server/`, `.local/`, `node_modules/`, SQLite, 환경 파일은 배포하지 않습니다. `npm run build`는 이전 버전의 서버 파일이 남지 않도록 이 저장소의 `dist/`를 비우고 생성합니다.

백엔드 담당자가 구성하는 Nginx에서 다음 두 가지를 연결합니다.

1. `dist/` 내용을 Nginx 정적 파일 루트에 배치합니다.
2. `/api/v1/backend/` 접두사를 제거하고 API 요청을 백엔드로 전달합니다.

예: `/api/v1/backend/news/feed` → FastAPI `/news/feed`. 기존 백엔드 Nginx를 경유한다면 `/api/news/feed`로 연결할 수 있습니다. [배포 계약과 Nginx 예시](docs/contracts/frontend-deployment.md)를 참고하세요.

소스만 GCP에 전달하는 경우 빌드 환경이 위 명령을 실행해야 합니다. Nginx는 TypeScript를 빌드하지 않습니다. 운영에서 `npm start`를 실행할 필요는 없으며 프론트 Node 실행 서버·방문자 DB 볼륨도 필요 없습니다. 운영 HTTPS·도메인·백엔드 주소는 백엔드/인프라 담당자가 설정합니다.

## Docker 로컬 실행 (선택)

```powershell
# Docker Desktop과 백엔드를 먼저 실행합니다.
$env:NEWS_BACKEND_URL='http://host.docker.internal:8000/'
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

- API: `POST /user/anonymous`, `POST /category`, `POST /subcategory`, `POST /news/feed`, `PUT/DELETE /news/{article_id}/like`.
- 브라우저에 UUID7 `reader_id`를 저장하고, 좋아요는 백엔드에 저장합니다. 카테고리·소분류 필터와 `next_offset` 페이지 처리는 백엔드 계약을 유지합니다.
- 피드 최상위 `reader_id`가 없는 성공 응답도 허용합니다. 기사의 `is_synthetic` 값에 따라 가상 여부를 표시합니다.
- 추천 모델과 행동 수집 서버는 연결하지 않았습니다. 기사 상세를 새로고침하면 목록 캐시가 없어 목록에서 다시 열어야 합니다.
- `image_url`은 브라우저가 접근 가능한 주소여야 합니다. 운영 데이터에 `localhost` 이미지 주소가 있으면 백엔드에서 운영 주소로 변경해야 합니다.
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
