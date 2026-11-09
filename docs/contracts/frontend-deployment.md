# 프론트엔드 정적 배포 계약

## 책임과 산출물

프론트는 `npm ci && npm run build`로 만든 `dist/` 내용만 제공합니다. 소스를 전달받는 방식이라면 배포 파이프라인에서 빌드합니다. 빌드에 Node.js가 필요하지만 운영 요청 처리에는 프론트 Node 서버가 필요 없습니다.

백엔드/인프라 담당자는 Nginx 정적 파일 루트, API upstream, HTTPS, 도메인을 구성합니다. 로컬과 운영은 같은 소스를 사용합니다.

## API 경로

브라우저·로컬 개발 서버·운영 Nginx 모두 백엔드와 동일한 경로를 사용합니다. 접두사를 추가하거나 제거하지 않으며 메서드, JSON 본문, 상태 코드와 응답을 유지합니다.

| 메서드 | 브라우저 요청과 백엔드 경로 |
|---|---|
| POST | `/user/anonymous` |
| POST | `/category` |
| POST | `/subcategory` |
| POST | `/news/feed` |
| PUT / DELETE | `/news/{article_id}/like` |

[Nginx 예시](../../deploy/nginx.frontend.conf)는 기존 Nginx에 반영할 참고용 서버 블록입니다. 서버 주소 `backend:8000`, 도메인, 정적 루트를 실제 환경에 맞춰 변경하고 `nginx -t`로 검사합니다. `proxy_pass http://backend:8000;`에는 URI를 붙이지 않아 원래 요청 경로를 유지합니다. API 위치 블록에서 별도 rewrite를 추가하지 않습니다. 같은 Nginx가 이미 이 API 경로를 제공한다면 기존 라우팅을 유지하고 정적 파일 제공 부분만 추가하면 됩니다.

브라우저는 화면과 같은 출처로 API를 호출하므로 이 경로에서는 별도 CORS 설정이 필요 없습니다. 로컬 전용 Node 프록시의 Origin 검사와 요청 허용 목록이 Nginx에 자동 이식되는 것은 아닙니다. 운영에서 필요한 인증·요청 검증·접근 제어는 백엔드와 게이트웨이가 책임집니다. CORS는 인증을 대신하지 않습니다.

기존 서버의 `/api/v1/visitors/*`, 샘플 `/api/v1/feed`, 로컬 `/api/v1/likes`는 운영에 노출하지 않습니다. 현재 화면은 이 API를 사용하지 않습니다.

## 배포 검증

1. `dist/`에 `index.html`과 `src/`만 있는지 확인합니다. 서버 코드·SQLite·환경 파일을 복사하지 않습니다.
2. Nginx 루트를 `dist/` 내용의 배치 위치에 맞추고 `nginx -t`를 실행합니다.
3. 화면 및 `/src/app.js`가 정상 응답하는지 확인합니다. `/server.js`, `/data/visitors.sqlite`는 404여야 합니다.
4. API를 통해 익명 ID 발급, 전체 피드, 카테고리·소분류, 다음 페이지, 좋아요 PUT/DELETE를 확인합니다.
5. 실제 배포 도메인에서 HTTPS와 기사 이미지 URL을 확인합니다. `/src/` 파일은 같은 이름으로 재빌드되므로 예시는 `no-cache`를 사용합니다.

실제 GCP 자원 생성이나 운영 Nginx 변경은 이 프론트 변경에 포함하지 않습니다.
