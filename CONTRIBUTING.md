# 프론트엔드 기여 가이드

이 저장소는 ASAC 뉴스 추천 프로젝트의 화면과 로컬 개발 프록시를 관리합니다. 같은 소스로 로컬 실행과 GCP Nginx 정적 배포를 지원하며 환경별 브랜치를 나누지 않습니다. 현재 구현과 한계는 `README.md`와 `AGENTS.md`를 기준으로 확인합니다.

## 작업 흐름

1. 이슈에 목적, 범위, 완료 조건을 기록합니다.
2. 이슈의 `Development > Create a branch`에서 `main` 기준 브랜치를 만듭니다.
3. 코드와 문서를 수정하고 실제 동작을 검증합니다.
4. Draft PR을 열고 템플릿을 채운 뒤 스스로 diff를 읽습니다.
5. Ready for review로 바꾸고 팀원 리뷰를 요청합니다.
6. 팀원 2명의 승인과 대화 해결 후 squash merge합니다.

브랜치 이름은 `<type>/<이슈번호>-<영어-소문자-하이픈>`입니다. 허용 type은 `feat`, `fix`, `exp`, `docs`, `refactor`, `chore`입니다. 커밋은 `<type>: <한국어 현재형 설명>` 형식이며 제목은 50자 이내입니다. PR 본문에 `Closes #이슈번호`를 적습니다.

`.github/ISSUE_TEMPLATE/`의 Feature, Bug, Experiment 양식과 `.github/PULL_REQUEST_TEMPLATE.md`를 사용합니다. Assignee는 생성자 본인으로 지정하고 실제로 있는 label 중 맞는 것을 선택합니다. label이 없으면 임의로 존재한다고 쓰지 않습니다.

## 로컬 실행과 검증

Node.js 24.19.0 이상이 필요합니다. 실제 명령과 포트는 `README.md`를 기준으로 합니다.

```bash
npm ci
npm start
npm run check
npm test
npm run build
docker compose config
```

Docker 실행은 `docker compose up -d --build --wait`입니다. Docker Desktop이 준비된 경우에 실제 기동과 `node scripts/verify-docker.mjs`를 확인합니다. `docker compose down -v`는 방문자 DB 볼륨을 지우므로 일반 종료에 사용하지 않습니다.

문서·양식만 바꾼 경우에는 경로, 링크, 상태 표기, `git diff --check`를 검증합니다. 수행하지 않은 검증은 PR에 통과로 표시하지 않습니다. 코드 변경 시에는 독자별 피드 차이, 신규 독자, 추천 근거, 방문자 데이터와 이벤트 개인정보를 확인합니다.

## 보안과 리뷰

`.env`, `data/`, SQLite 파일, 키와 토큰은 커밋하지 않습니다. 방문자 쿠키나 실제 독자 정보를 이슈·PR·로그에 붙이지 않습니다. API·이벤트 계약을 바꾸면 `docs/contracts/`와 관련 문서를 갱신합니다. 동작 영향과 롤백 방법을 PR에 적습니다.

`.github/workflows/branch-name-policy.yml`은 브랜치 이름을 검사합니다. Claude 자동 리뷰 workflow는 팀이 시크릿과 비용을 결정하기 전까지 이 저장소에 없습니다. `main` 보호 규칙과 squash 강제 설정은 **[미정]**이며, 설정과 관계없이 위의 팀 리뷰 절차를 지킵니다.

에이전트 규칙은 `CLAUDE.md`, `AGENTS.md`, `.claude/docs/`에 있습니다. Windows에서 symlink를 만들 수 없어 `AGENTS.md`는 `CLAUDE.md` 사본입니다. 두 파일을 함께 수정합니다. `.agents`는 Git symlink로 기록되지만 Windows Git의 `core.symlinks=false`에서는 일반 파일로 체크아웃될 수 있습니다. 이때 `.claude/docs/`를 직접 엽니다.

원본: [infra 하네스 PR #2](https://github.com/asac-news-rec/infra/pull/2). 이 저장소에 맞게 실행·검증·보안 내용을 수정했습니다.
