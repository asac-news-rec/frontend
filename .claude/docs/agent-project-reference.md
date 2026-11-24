# 프론트엔드 저장소 참조

> Last Updated: 2026-11-06

상태 표기는 `CLAUDE.md`를 따릅니다. 경로의 존재 여부는 작업 브랜치에서 확인합니다.

## [현재] 저장소 구조

```text
src/                 화면, 샘플 데이터, 피드·방문자·좋아요 클라이언트
server/              피드·방문자·좋아요 HTTP 처리(TypeScript)
server.ts            Node 서버 진입점(TypeScript)
tests/               피드·방문자·좋아요 테스트
scripts/             검사, 빌드, Docker 검증
docs/                화면 설계, 프론트·백엔드 계약, 행동 수집 설계
Dockerfile           로컬 개발 컨테이너 및 정적 파일 추출
compose.yaml         로컬 Nginx (기존 볼륨 미사용)
compose.images.yaml  생성 이미지 읽기 전용 마운트 (선택)
README.md            실행 방법과 현재 한계
CLAUDE.md            에이전트 진입점
AGENTS.md            Windows 호환을 위한 동일 내용의 사본
.claude/docs/        상세 규칙
.agents              Git에서는 .claude를 가리키는 symlink
.github/             이슈·PR 양식과 브랜치 이름 검사
```

브라우저와 로컬 서버 소스는 TypeScript입니다. `npm run build`는 브라우저 의존성만 `dist/`에 출력합니다. `npm start`는 `.local/dev-server.js`에서 개발 프록시를 실행하며 SQLite를 초기화하지 않습니다. 기존 서버는 `.local/`에 컴파일되어 회귀 테스트에서만 사용합니다. 로컬 Compose는 프런트 Nginx로 정적 화면과 FastAPI 전달을 제공하며, 배포 계약은 `docs/contracts/frontend-deployment.md`입니다.

Windows Git에서 `core.symlinks=false`이면 `.agents`가 링크 대상 문자열을 담은 일반 파일로 체크아웃될 수 있습니다. 이 경우 `.claude/docs/`를 직접 사용합니다. `AGENTS.md`와 `CLAUDE.md`는 내용이 같아야 합니다.

## 파일 책임

| 경로 | 책임 |
|---|---|
| `src/data.ts`, `src/service.ts` | 가상 독자·기사와 샘플 추천 결과 |
| `src/app.ts`, `src/style.css` | 화면 상태, 기사 상세, 반응형 UI |
| `src/visitor.ts`, `server/visitors.ts` | 비로그인 방문자 식별과 저장 |
| `src/likes.ts`, `server/http.ts`, `server/visitors.ts` | 좋아요 UI와 API·저장 |
| `server/feed.ts`, `server/http.ts` | 샘플 피드와 HTTP 경계 |
| `tests/` | 독자별 차이, 신규 독자, 방문자, 좋아요 동작 검증 |
| `docs/contracts/` | 다른 저장소와 합의할 인터페이스 |
| `docs/behavior-collection/` | 행동 이벤트 수집 설계와 시안 |

## 소유권 경계

| 영역 | 담당 저장소 |
|---|---|
| 화면, 독자 식별, 브라우저 행동 이벤트 | `frontend` |
| 뉴스 기사·백엔드 API | `backend` |
| 수집 기반, 배포, 팀 공용 인프라 | `infra` |
| 배치, 피처, 모델 학습 | `data-ml-pipeline` |
| 전체 설계 문서 | `blueprint` |

프론트엔드의 팀 담당은 김세호(`hosose`)입니다. 저장소 경계를 넘는 API나 이벤트 스키마는 계약 문서와 실제 구현을 함께 확인하고 담당자와 합의합니다.

## 상태와 확장 규칙

- **[현재]** 샘플 피드와 가상 추천 순서, 비로그인 방문자 SQLite, 좋아요가 있습니다. 방문자 데이터는 `data/` 또는 Docker `visitor-data` 볼륨에 저장됩니다.
- **[계획]** 실제 백엔드 피드, 행동 이벤트의 수집·전송·로깅 서버 연결은 문서와 작업 중인 코드가 있어도 `main`에서 완료된 기능으로 간주하지 않습니다.
- **[미정]** 추론 서버·운영 배포 연결과 최종 이벤트 계약은 팀 합의를 확인합니다.

새 화면 동작은 `src/`, HTTP 처리는 `server/`, 관찰 가능한 동작 검증은 `tests/`에 둡니다. 다른 저장소와 공유하는 필드는 `docs/contracts/`에 기록합니다. 데이터 구조와 식별자, 시점과 단위를 먼저 정하고 변경 뒤 README의 실행 방법을 갱신합니다.
