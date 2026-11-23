# 프론트엔드 AI 작업 지침

> Version: 0.2.0 | Last Updated: 2026-11-03

이 문서는 `asac-news-rec/frontend`에서 작업하는 AI 에이전트의 진입점입니다. 세부 규칙은 `.claude/docs/`에 있습니다. Windows에서 symlink 생성 권한이 없을 수 있어 `AGENTS.md`에도 같은 내용을 복사합니다. 두 파일을 함께 갱신합니다.

## 상태 표기

- **[현재]** 이 브랜치에 실제로 있는 코드나 설정
- **[계획]** 만들 예정이며 경로와 계약이 바뀔 수 있는 것
- **[미정]** 팀이 아직 정하지 않은 것

계획과 미정 항목을 구현된 기능으로 설명하거나 문서만 보고 파일을 만들지 않습니다. 현재 상태는 작업 브랜치의 추적 파일과 실제 동작으로 확인합니다.

## 언어와 문서

사용자의 요청이 없으면 응답과 PR 설명은 한국어 격식체로 작성합니다. 문서는 작업에 맞게 확인합니다.

| 작업 | 먼저 볼 문서 |
|---|---|
| 저장소 구조와 소유권 | `.claude/docs/agent-project-reference.md` |
| 전체 시스템 설계 | `.claude/docs/architecture-overview.md` |
| 이슈, 브랜치, PR | `.claude/docs/agent-workflow-reference.md` |
| 금지 사항과 보안 | `.claude/docs/agent-prohibitions.md`, `.claude/docs/agent-security-guidelines.md` |

## 프로젝트 맥락

ASAC 뉴스 추천 프로젝트는 독자의 뉴스 이용 데이터를 수집·분석하고 개인화된 기사를 제공하는 전체 흐름을 목표로 합니다. 저장소는 `infra`, `backend`, `frontend`, `data-ml-pipeline`, `blueprint`로 나뉩니다.

이 저장소는 뉴스 화면과 로컬 개발 서버를 담당합니다. **[현재]** 기본 화면은 백엔드 뉴스·카테고리·소분류·좋아요 API를 사용합니다. `npm start`는 SQLite 없이 로컬 개발 프록시를 실행하고, `npm run build`는 브라우저 파일만 `dist/`에 생성합니다. GCP에서는 백엔드 담당자의 Nginx가 정적 파일과 API 전달을 담당합니다. 기존 방문자·샘플 서버는 회귀 테스트용으로 남아 있으며 기본 실행·운영 배포에 사용하지 않습니다. 추천 모델·행동 수집과 실제 GCP 배포 완료를 주장하지 않습니다.

## 작업 규칙

- 코드 변경은 이슈를 만들고 이슈에서 `<type>/<이슈번호>-영어-소문자-하이픈` 브랜치를 생성한 뒤 PR로 올립니다. 허용 type은 `feat`, `fix`, `exp`, `docs`, `refactor`, `chore`입니다.
- 기존 수정 사항을 먼저 확인하고 다른 작업의 미커밋 파일을 덮어쓰거나 커밋에 섞지 않습니다.
- 독자 ID, 기사 ID, 이용 이벤트, 추천 결과의 의미를 구분합니다. 이벤트를 다룰 때는 발생 시점, 단위, 중복 처리와 원본에서 결과까지의 추적 경로를 명시합니다.
- 가상 데이터와 실제 수집 데이터를 구분합니다. 독자별 결과, 추천 근거, 신규 독자 처리, 데이터 누출 여부를 검증합니다.
- `data/`, `*.sqlite*`, `.env`, 키와 토큰을 커밋하지 않습니다. `docker compose down -v`나 볼륨 삭제는 명시적 요청이 있을 때만 실행합니다.
- 변경한 동작, 명령, 계약은 관련 문서에 반영합니다. 작업 전후 실제 입력과 출력으로 검증합니다.
- GitHub 원격 작업은 요청 범위와 저장소 규칙을 확인하고 진행합니다. 팀원 두 명의 승인을 받기 전에는 머지하지 않습니다.

## 실행과 검증

Node.js 24.21.0이 필요합니다. `README.md`가 실행 절차의 기준입니다.

```bash
npm ci
npm start
npm run check
npm test
npm run build
docker compose config
```

Docker 실행은 `docker compose up -d --build --wait`이며 로컬 Nginx 접속 주소는 `http://127.0.0.1:8080/`입니다. 로컬 `npm start`는 `http://127.0.0.1:4173/`을 사용합니다. Docker 실행과 `node scripts/verify-docker.mjs`는 Docker Desktop과 로컬 FastAPI가 준비된 경우에만 수행합니다. 문서만 바뀐 PR은 `git diff --check`와 경로·링크 검증을 먼저 합니다.

## PR 리뷰

정확성, 기존 동작 영향, 독자 식별과 이벤트 개인정보, 시크릿 노출, Docker 볼륨 영향, 검증 결과를 확인합니다. `.github/workflows/branch-name-policy.yml`은 브랜치 이름을 검사합니다. **[미정]** Claude 자동 리뷰는 팀이 시크릿과 비용을 정할 때까지 이 저장소에 설치하지 않습니다. Draft PR을 셀프 리뷰한 뒤 팀원 두 명의 승인을 요청합니다.
