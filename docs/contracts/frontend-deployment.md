# 기존 백엔드 구성에 맞춘 프론트 배포

## 확인 기준

백엔드 저장소 `asac-news-rec/backend` main의 `nginx/default.conf`, `compose.yaml`, `app/main.py`, `app/repository.py`, `web/app.js`를 기준으로 맞춥니다. 확인 커밋: `cf31205`.

기존 Nginx는 `/api/`를 `api:8000/`으로 전달하고, `/images/`는 `/srv/images/`, 화면은 `/usr/share/nginx/html`에서 제공합니다. 백엔드 Compose가 `./web`을 이 정적 파일 루트에 연결합니다. 백엔드 소스와 Nginx 설정은 변경하지 않습니다.

## 배포 파일

1. 프론트에서 `npm ci`, `npm run check`, `npm test`, `npm run build`를 실행합니다.
2. 배포 담당자가 기존 백엔드 `web/` 화면을 백업합니다.
3. `dist/` 안의 `index.html`과 `src/` 디렉토리를 백엔드 `web/` 안에 배치합니다. 결과는 `web/index.html`, `web/src/app.js`, `web/src/style.css`입니다. `web/dist/`로 복사하지 않습니다.
4. 백엔드의 기존 실행·배포 절차를 따릅니다. 로컬 Compose에서는 http://127.0.0.1:8080/ 에서 새 화면을 확인합니다.

별도의 프론트 Nginx 설정이나 Node 실행 서버는 필요 없습니다. `.local/`, 서버 코드, node_modules, 환경 파일, SQLite를 `web/`에 복사하지 않습니다. 기존 화면을 되돌릴 때는 백업한 `web/` 내용을 복구합니다. 프론트 변경만으로 백엔드 DB나 이미지 폴더를 덮어쓰지 않습니다.

## API 경로와 응답

| 브라우저·로컬 프록시·Nginx 요청 | 메서드 | FastAPI 내부 경로 |
|---|---|---|
| `/api/user/anonymous` | POST (본문 없음) | `/user/anonymous` |
| `/api/category` | POST (본문 없음) | `/category` |
| `/api/subcategory` | POST `{category}` | `/subcategory` |
| `/api/news/feed` | POST `{reader_id, offset, category?, subcategory?}` | `/news/feed` |
| `/api/news/{article_id}/like` | PUT / DELETE `{reader_id}` | `/news/{article_id}/like` |

`/api/`는 백엔드가 이미 제공하는 외부 경로입니다. 프론트 전용 접두사나 새 라우팅은 추가하지 않습니다. 로컬 개발 서버도 백엔드 Nginx의 `/api/*` 경로로 전달합니다.

피드 응답의 `request_id`, `served_at`, `items`, `next_offset`을 사용하며 최상위 `reader_id`는 요구하지 않습니다. 카테고리는 `category_list`, 소분류는 `sub_category_list`입니다. 좋아요 응답은 `article_id`, `is_liked`, `changed`입니다. 백엔드의 페이지당 최대 20건 및 `next_offset: null` 종료 처리를 유지합니다. 브라우저 독자 ID 저장 키는 백엔드 참고 화면과 같은 `sai-news.backend-reader-id`를 사용합니다.

## 이미지와 로컬 실행

백엔드 참고 화면처럼 기존 `http://localhost:8001/...` 또는 `http://127.0.0.1:8001/...` 이미지 주소만 `/images/...`로 연결합니다. 외부 HTTP(S) 이미지는 유지하고 다른 프로토콜은 표시하지 않습니다. DB 값은 수정하지 않습니다.

기본 로컬 개발 서버는 `NEWS_BACKEND_URL=http://127.0.0.1:8080/`를 사용합니다. Docker 프론트에서는 `http://host.docker.internal:8080/`입니다. 둘 다 백엔드 Nginx의 루트 주소이고 `/api/`를 붙이지 않습니다. 로컬에서도 `/images/*`를 같은 Nginx로 전달하므로 별도의 8001 이미지 서버는 필요 없습니다.

## 검증과 운영

- 기존 Nginx와 API를 실행하고 `/api/health`, 화면, 카테고리·소분류, 다음 페이지, 좋아요 설정·해제를 확인합니다.
- `/images/`와 기존 로컬 이미지 URL이 변환된 주소에서 이미지가 보이는지 확인합니다.
- `nginx -t` 및 실제 GCP 검증은 배포 환경에서 수행합니다. 도메인·HTTPS·접근 제어는 백엔드/인프라 담당자의 기존 정책을 따릅니다.
- 같은 출처로 API를 호출합니다. 로컬 프록시의 Origin 검사가 운영 Nginx에 자동 적용되지는 않습니다.
- 현재 백엔드 Compose의 8080 포트는 `127.0.0.1`에만 바인딩되어 있습니다. 이 로컬 설정 자체가 GCP 외부 공개 구성을 의미하지는 않습니다.
- 기존 Nginx 캐시 정책을 변경하지 않았습니다. 교체 후 이전 화면이 보이면 브라우저 캐시를 확인합니다.

이 변경은 프론트 소스와 안내만 수정하며 백엔드 `web/` 파일 교체·실제 GCP 배포를 수행하지 않습니다.

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
