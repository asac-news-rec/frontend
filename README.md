# 사이 뉴스 화면 초안

## 실제 뉴스 백엔드 화면 확인

백엔드 저장소의 API(`POST /user/anonymous`, `POST /category`, `POST /subcategory`, `POST /news/feed`, `PUT/DELETE /news/{article_id}/like`)를 같은 출처의 Node 서버 프록시로 연결합니다. 백엔드 API가 `127.0.0.1:8000`에서 실행 중이면 다음과 같이 시작합니다.

```powershell
$env:NEWS_BACKEND_URL='http://127.0.0.1:8000/'
npm ci
npm start
```

브라우저에서 `http://127.0.0.1:4173/`을 엽니다. 기본 화면이 백엔드 피드를 사용합니다. 백엔드의 Nginx `127.0.0.1:8080`을 사용할 때는 `NEWS_BACKEND_URL='http://127.0.0.1:8080/api/'`로 설정합니다. Docker 프론트엔드에서 호스트의 백엔드로 접근할 때는 `NEWS_BACKEND_URL='http://host.docker.internal:8000/'`을 설정하고 `docker compose up -d --build --wait`로 실행합니다. 실제 접속 주소는 이 PC와 백엔드 담당자가 접근 가능한 호스트 주소에 맞춰야 합니다. URL 쿼리스트링과 관계없이 백엔드 화면을 사용합니다.

DB의 `image_url`이 백엔드 저장소의 기본값인 `http://localhost:8001/`을 가리키면 아래 Docker 실행 절차의 이미지 서버도 켭니다. 이미지가 없거나 접근할 수 없으면 화면은 기존 일러스트를 표시합니다.

카테고리는 본문 없는 `POST /category`로 조회하고, 카테고리를 고르면 `{category}`를 담은 `POST /subcategory`로 소분류를 조회합니다. 피드에는 선택한 `category`, `subcategory`를 전달합니다. 필터를 바꾸면 `offset: 0`에서 다시 시작하고, 다음 페이지에는 동일한 필터와 응답의 `next_offset`을 사용합니다. 선택하지 않은 필터는 요청에서 생략합니다. 카테고리 조회에 실패해도 전체 뉴스는 표시되며, 다시 시도 버튼으로 카테고리만 다시 불러올 수 있습니다.

화면은 브라우저에 `reader_id`를 저장하며 백엔드 피드의 `items`, `next_offset`, `is_liked`를 화면에 사용합니다. 목록은 백엔드의 최신순이며 학습된 추천 순위가 아닙니다. 백엔드 기사는 상세 새로고침 시 목록 캐시가 없어 다시 피드에서 열어야 합니다. 좋아요는 백엔드 API에 저장됩니다. 실제 백엔드와 DB가 기동되지 않았다면 연결 오류를 표시하며 샘플 기사로 대체하지 않습니다.

2026-11-05에 전달된 `news_api_spec (1).xlsx`는 피드 응답 최상위 `reader_id`를 필수로 명시하지만, 백엔드 담당자는 이 필드가 없는 응답이 맞다고 확인했습니다. 현재 `app/main.py`의 성공 응답은 `request_id`, `served_at`, `items`, `next_offset`입니다. 프론트는 최상위 `reader_id`를 요구하지 않습니다. 문서의 해당 필드는 백엔드 명세에서 바로잡아야 합니다.

한국어 뉴스 서비스의 팀 검토용 화면입니다. `사이 뉴스`는 교체 가능한 임시 이름입니다. 기본 화면은 백엔드 뉴스 API에 연결되며, 현재 DB의 기사는 합성 데이터입니다. 학습된 추천 모델과 행동 수집 서버는 연결되지 않았습니다. 샘플 피드와 방문자 쿠키 기능은 화면에서 사용하지 않는 기존 서버 구현입니다.

## Docker로 실행

집 Mac에서 프론트엔드와 백엔드를 함께 시연하는 절차는 [Mac Docker 시연 안내](docs/mac-docker-demo.md)를 참고하세요.

태원님 PC에서는 다음 순서대로 확인할 수 있습니다. 프론트엔드와 백엔드 저장소는 같은 PC에 두고 Docker Desktop을 실행합니다.

1. 백엔드 저장소의 안내에 따라 API와 DB를 먼저 실행합니다. 브라우저에서 `http://127.0.0.1:8000/health`가 `{"status":"ok","database":1}`을 반환하고 기사 데이터가 적재되어 있어야 합니다.
2. 프론트엔드 저장소에서 아래 명령을 실행합니다.

```powershell
$env:NEWS_BACKEND_URL='http://host.docker.internal:8000/'
docker compose up -d --build --wait
```

3. 브라우저에서 **http://127.0.0.1:4181/** 을 엽니다. 기사 제목과 본문이 나오면 연결된 것입니다. Docker 컨테이너 내부의 4173 포트가 PC의 4181 포트에 연결됩니다. Docker로 확인할 때 PC의 4173을 따로 열거나 `npm start`를 실행할 필요가 없습니다. Origin 검증을 위해 `localhost` 대신 `127.0.0.1`을 사용합니다.

4. 기사 썸네일 URL이 `http://localhost:8001/`인 경우, 백엔드 저장소 폴더에서 아래 명령으로 이미지 서버를 한 번 실행합니다. 이 서버는 백엔드의 이미지 파일을 읽기 전용으로 제공합니다.

```powershell
docker run -d --name asac-news-backend-images -p 127.0.0.1:8001:80 -v "${PWD}/generate/output_with_thumbnail:/usr/share/nginx/html:ro" nginx:stable-alpine
```

이미지 서버를 다시 시작할 때는 `docker start asac-news-backend-images`를 사용합니다. 이미지 서버를 실행하지 않아도 기사 제목·본문과 좋아요는 동작합니다. 프론트엔드 이미지 빌드 중 문법 검사·테스트·정적 빌드가 실행됩니다.

화면이 연결 오류를 보이면 백엔드의 `/health`와 다음 로그를 확인합니다.

```powershell
docker compose ps
docker compose logs --tail 50 web
docker compose down
```

`down`은 서비스를 종료하고 방문자 DB 볼륨은 유지합니다. `down -v`는 DB 볼륨까지 삭제하므로 일반 종료에 사용하지 않습니다. 재실행은 `docker compose up -d --wait`, 코드 수정 후에는 `docker compose up -d --build --wait`를 사용합니다. Docker Desktop 엔진이 실행 중일 때 동작합니다.

4181 포트를 다른 서버가 사용 중이면 그 서버를 종료하거나 다음처럼 변경합니다.

```powershell
$env:NEWS_PORT='4182'
docker compose up -d --build --wait
```

이 경우 접속 주소는 http://127.0.0.1:4182/ 입니다. 컨테이너 내부는 0.0.0.0:4173으로 수신하지만 PC의 공개 포트는 127.0.0.1에만 연결합니다.

DB는 Docker의 `visitor-data` 이름 볼륨에 저장하며 기존 로컬 `data/visitors.sqlite`와 별개입니다. 기존 쿠키의 독자 정보가 새 DB에 없으면 새 방문자로 저장을 다시 시작해야 합니다. 기존 로컬 DB를 자동 복사하지 않습니다. 쿠키는 포트로 격리되지 않으므로 같은 호스트의 로컬 서버 여러 개에서 동시에 방문자 저장 기능을 시험하면 토큰이 바뀔 수 있습니다.

컨테이너용 이미지에는 코드만 복사하고 DB·Git 정보·문서·환경 파일을 제외합니다. 컨테이너는 일반 node 사용자로 실행합니다. 청사진 HTML은 기존 `docs/design/2026-10-31/frontend-blueprint-2026-10-31.html` 파일을 직접 열어 확인하며 앱 서버는 문서 경로를 제공하지 않습니다.

컨테이너 실행 후 HTTP·방문자 쿠키·재시작 유지 검증은 다음 명령으로 다시 실행할 수 있습니다. 검증이 web 서비스를 한 번 재시작합니다.

```powershell
node scripts/verify-docker.mjs
```

## 실행

Node.js 24.19.0 이상이 필요합니다. 방문자 저장에는 내장 node:sqlite를 사용합니다. TypeScript 컴파일러 설치를 위해 처음 실행할 때 `npm ci`가 필요합니다.

```powershell
npm ci
npm start
```

브라우저에서 http://127.0.0.1:4173 을 엽니다. 서버는 로컬 접속만 허용합니다. 팀 공유 호스팅은 별도로 설정해야 합니다.

```powershell
npm run check
npm test
npm run build
```

`dist/`에는 화면 파일과 서버가 사용하는 컴파일된 JavaScript가 들어갑니다. 브라우저와 Node 서버의 소스는 TypeScript이며, 빌드·검증 도구와 테스트는 JavaScript로 실행합니다. `npm start`와 `npm test`는 시작 전에 빌드합니다. 서버를 직접 실행하려면 먼저 `npm run build`를 실행한 뒤 `node dist/server.js`를 사용합니다. 방문자 저장 기능에는 Node 서버가 필요하며 정적 호스팅만으로 방문자 API는 실행되지 않습니다. 해시 경로를 사용하므로 기사 상세 새로고침을 위한 별도 서버 라우팅은 필요하지 않습니다.

## 화면 확인 순서

1. 기본 주소에서 백엔드 기사 목록을 확인합니다.
2. 카테고리와 소분류를 선택하고 기사 상세로 이동합니다.
3. 목록으로 돌아와 필터와 스크롤 위치를 확인합니다.
4. 좋아요·취소 후 새로고침하여 백엔드 저장 상태를 확인합니다.
5. 하단에서 다음 페이지를 불러옵니다.

## 파일 구조

| 파일 | 역할 |
|---|---|
| src/data.ts | 가상 독자 3명, 가상 기사 8개, 독자별 샘플 순서와 TypeScript 타입 |
| src/service.ts | 기존 샘플 API용 조회와 추천 묶음 생성 |
| src/app.ts | 화면 상태, 백엔드 피드·카테고리 전환, 기사 상세, 안전한 본문 출력 |
| src/style.css | 반응형 레이아웃, CSS 그래픽, 키보드 포커스 |
| server.ts, server/*.ts | Node 서버와 API·방문자 저장 소스. 빌드 후 dist/server.js로 실행 |
| tests/feed.test.js | 독자별 차이, 신규 독자 정렬, 필터, 오류·빈 결과·복구 검증 |
| DESIGN_NOTES.md | 구현 내용, 선택 이유, 팀 피드백 질문과 제한 |

## 검증 결과와 제한

2026-10-29, Node.js v24.19.0에서 문법 검사, 동작 테스트 4개, 정적 빌드를 통과했습니다. 테스트는 서비스 함수의 실제 반환값을 확인합니다. 브라우저 렌더링·키보드 조작·모바일 화면·실제 클릭 테스트를 대신하지 않습니다.

2026-10-29, 로컬 서버를 실행하고 브라우저에서 첫 화면이 표시되는 것을 확인했습니다. 키보드 조작, 기사 클릭 흐름, 모바일 화면과 넘침 검증은 남아 있습니다.

## 현재 화면과 기존 샘플 구현

현재 화면의 피드·카테고리·소분류·좋아요는 백엔드 API를 사용합니다. 독자 ID는 백엔드에서 발급받아 브라우저에 저장합니다. URL로 샘플·모의·로깅 화면을 선택하는 기능은 제공하지 않습니다.

기존 샘플 데이터, 방문자 쿠키·SQLite API와 관련 테스트는 서버 구현 이력으로 남아 있으며 현재 화면에서 호출하지 않습니다. 학습 모델과 행동 로깅 서버 연결은 후속 작업입니다.

같은 탭에서 기사 상세를 열었다가 돌아오면 피드·필터·스크롤 위치를 복원합니다. 새로고침과 새 탭에는 목록 캐시를 유지하지 않습니다.

## 문서 찾기

내용별 문서 위치는 [문서 안내](docs/README.md)를 참고하세요.

## Slack PR 알림

일반 PR을 열거나 Draft PR을 Ready for review로 전환하면 GitHub Actions가 리뷰 요청을 보냅니다. 저장소의 Actions Secret에 Slack `#pr요청` 채널용 Incoming Webhook URL을 `SLACK_PR_WEBHOOK_URL` 이름으로 등록해야 합니다. 워크플로가 `main`에 반영된 뒤 발생하는 PR 이벤트부터 적용됩니다.
