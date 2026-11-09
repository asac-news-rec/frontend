# Claude PR 리뷰와 복습 질문

.github/workflows/claude.yml은 infra PR #14의 이해도 확인 방식을 프론트엔드에 적용합니다. 코드 리뷰와 함께 실제 변경 줄에 "이해도 확인:" 질문 1~3개를 남깁니다. 작성자는 같은 스레드에 근거와 검증 결과를 답변하고 해결 처리합니다. 단순 문서·서식 변경에는 질문을 생략합니다.

## 관리자 초기 설정

1. https://github.com/apps/claude 에서 frontend 저장소에 Claude 앱을 설치하거나 기존 조직 설치의 대상 저장소에 frontend를 추가합니다.
2. 사용할 Claude 계정과 사용량 부담 주체를 정합니다. 이 자동화는 해당 인증 계정의 사용량을 소비합니다.
3. Claude Code의 공식 OAuth 설정을 사용할 경우 로컬 터미널에서 `claude setup-token`을 실행합니다. 토큰은 채팅, PR, 코드, 로그에 붙이지 않습니다.
4. https://github.com/asac-news-rec/frontend/settings/secrets/actions 에서 `CLAUDE_CODE_OAUTH_TOKEN`이라는 Repository Secret을 등록합니다. 조직 Secret을 사용하는 경우 frontend에 사용 권한이 있어야 합니다.
5. 워크플로를 main에 반영한 뒤 같은 저장소 브랜치의 실제 코드 변경 PR을 열거나 Draft를 Ready for review로 전환합니다.
6. Actions의 "Claude Code PR Review" 성공과 PR 인라인 질문 및 리뷰 요약을 확인합니다. 이 PR 준비 단계에서는 Secret 등록 여부 및 실제 AI 실행은 검증되지 않았습니다.

공식 인증 안내: https://github.com/anthropics/claude-code-action/blob/main/docs/setup.md

## 실행 조건과 제한

- PR opened 및 ready_for_review에서 실행합니다. Draft와 외부 fork는 제외합니다.
- 추가 커밋 push만으로 재실행하지 않습니다. 기존 실행 재시도는 Actions의 Re-run jobs를 사용합니다. 이전 실행에 연결된 커밋을 확인하십시오.
- 특정 모델 ID는 고정하지 않고 액션의 기본 모델을 사용합니다.
- PR당 20분, 에이전트 20턴 제한을 둡니다. 이는 금액 상한이 아닙니다.
- 인증 Secret이 없으면 값을 출력하지 않고 설정 안내와 함께 실패합니다.
- 코드 쓰기 권한과 checkout 인증 정보 유지를 사용하지 않습니다. 리뷰 댓글 작성 권한을 사용하며 자동 머지하지 않습니다.
- 검토 대상 코드와 문맥이 Claude 서비스로 전달됩니다. 인증 계정 및 저장소 접근 권한은 관리자가 설정해야 합니다.
- AI 리뷰만으로 정확성을 보장하지 않습니다. 팀의 사람 리뷰 절차를 따릅니다.

## 실패 시 확인

- 인증 검사 실패: Secret 이름과 조직 Secret의 저장소 허용 범위를 확인합니다.
- 앱 또는 GitHub 토큰 오류: Claude 앱의 frontend 접근과 조직 Actions 정책을 확인합니다.
- 인증 만료 또는 사용량 오류: 사용 계정에서 토큰과 이용 가능량을 확인합니다.
- 인라인 질문이 없음: 문서만 변경한 PR인지, 액션 로그에 리뷰 도구 실행 오류가 있는지 확인합니다.
