# 에이전트 워크플로우 참조

> Last Updated: 2026-11-03

이슈부터 머지까지의 팀 작업 흐름입니다. 사람용 요약은 `CONTRIBUTING.md`에 있습니다.

## 순서

1. 변경 목적과 완료 조건을 이슈에 적습니다.
2. 이슈의 `Development > Create a branch`에서 `main`을 기준으로 브랜치를 만듭니다.
3. 작업 뒤 실제 입력·출력과 `git diff --check`로 검증합니다.
4. Draft PR을 열고 셀프 리뷰를 합니다. 본문에 `Closes #이슈번호`를 넣습니다.
5. Ready for review로 전환해 팀원 리뷰를 요청합니다.
6. 팀원 2명 승인과 대화 해결 후 squash merge합니다.

이번 저장소에는 Claude 자동 리뷰 workflow가 없습니다. 시크릿과 비용은 팀에서 결정할 때까지 **[미정]**입니다. 자동 리뷰가 실행된다고 문서나 PR에 쓰지 않습니다.

## 이름 규칙

브랜치는 `<type>/<이슈번호>-<영어-소문자-하이픈>` 형식입니다. type은 `feat`, `fix`, `exp`, `docs`, `refactor`, `chore` 중 하나입니다. `branch-name-policy.yml`이 PR에서 형식을 검사합니다. GitHub의 revert 브랜치는 workflow가 예외로 허용합니다.

커밋은 `<type>: <한국어 설명>` 형식을 사용합니다. 설명은 현재형 동사로 시작하고 50자 이내로 씁니다. 한 브랜치에는 한 목적의 변경만 담습니다.

## 이슈와 PR

`.github/ISSUE_TEMPLATE/`의 Feature, Bug, Experiment 양식을 사용합니다. 문서·설정만 처음 이식할 때처럼 적절한 양식이 없다면 빈 이슈를 사용할 수 있습니다. 자동 label은 해당 label이 저장소에 있을 때만 붙습니다.

PR은 `.github/PULL_REQUEST_TEMPLATE.md`를 채웁니다. 수행하지 않은 검증은 통과로 표시하지 않고 이유를 씁니다. Assignee는 생성자 본인으로 지정하고 존재하는 label 중 맞는 것을 선택합니다.

## 검증과 리뷰

- 화면·서버 코드 변경은 `npm run check`, `npm test`, `npm run build`를 실행합니다.
- Compose 변경은 `docker compose config`를 확인하고 Docker Desktop이 준비됐으면 실제 기동을 검증합니다.
- Docker 방문자 저장 변경은 `node scripts/verify-docker.mjs`의 재시작 영향을 확인합니다.
- 문서·양식 변경은 경로, 링크, 상태 표기, workflow trigger, `git diff --check`를 확인합니다.
- 시크릿·개인정보, 볼륨 삭제, 다른 작업의 미커밋 파일이 diff에 섞이지 않았는지 확인합니다.

`main` 보호 규칙과 squash 강제 설정은 저장소 설정에서 확인해야 하는 **[미정]** 항목입니다. 설정이 없어도 팀 합의인 2명 승인과 squash merge 절차를 지킵니다. 승인 전 새 커밋을 올리면 재리뷰가 필요할 수 있습니다.
