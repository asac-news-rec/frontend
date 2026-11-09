# 합성 로그 에이전트

## 현재 구현

멘토가 제시한 큰 방향은 페르소나 에이전트가 브라우저로 접속해 기사를 클릭하는 것이다. 이번 주에는 **브라우저 없이 합성 이벤트를 보내는 방식**을 제안한다. 이 방식의 허용 여부는 멘토 확인이 필요하다.

`scripts/synthetic-logging-agent.mjs`는 입력한 가상 독자와 기사 제목을 OpenRouter의 DeepSeek Flash에 전달한다. 모델이 기사 하나 또는 클릭 없음을 선택한다. 스크립트는 목록 전체를 `POST /internal/served`에 등록하고, 선택한 기사가 있으면 해당 `impression_id`로 `article_open` 한 건을 `POST /events`에 보낸다. 이벤트의 저장 출처는 `simulator`다. 서버 ACK의 `accepted`는 SQLite 수락이며 GCS 전송 완료가 아니다. 기본 실행 간격은 한 회가 끝난 뒤 10초다.

입력 JSON은 독자 배열이다. 각 독자는 `reader_id`, `persona`, `articles`를 가진다. 각 기사는 `article_id`, `position`, `title`을 가진다.

```json
[{"reader_id":"synthetic-reader-1","persona":"40대 직장인, 반도체·금리에 관심","articles":[{"article_id":"article-1","position":1,"title":"반도체 업계 동향"}]}]
```

`reader_id`는 가상 독자 식별자다. `article_id`는 입력 목록의 기사 식별자다. `request_id`는 한 목록 제공의 식별자, `impression_id`는 제공된 기사별 식별자, `event_id`는 클릭의 UUID다. `served_at`과 `event_time`은 UTC다. 재시도 큐는 아직 없으며 요청 실패 시 실행을 중단한다. 모델 선택은 실제 독자의 클릭이나 체류 시간을 측정하지 않는다. 로컬 로깅 서버 계약에는 체류 시간 이벤트가 없으므로 이번 스크립트는 체류를 만들지 않는다.

## 실행

`examples/synthetic-personas.json`에는 서로 다른 관심사의 가상 독자 5명이 있다. 관심사 이름은 현재 **프런트엔드 시연 데이터**의 IT·과학, 스포츠, 문화, 사회, 생활을 기준으로 했다. 백엔드 DB의 `exports/news_articles.dump`는 이 작업 환경에서 읽을 수 없어 DB 카테고리와 일치한다고 확인하지 못했다. `scripts/make-synthetic-contexts.mjs`는 이 페르소나와 프런트엔드의 가상 기사 8건을 결합해 실행 입력을 만든다. 이 데이터는 로컬 경로 검증용이며 실제 수집 기사나 백엔드 DB의 기사 ID가 아니다.

```powershell
node scripts/make-synthetic-contexts.mjs > contexts.json
```

로깅 서버를 켠 뒤 저장소 루트에서 실행한다. 아래 파일명은 직접 만든 입력 파일의 예시다. 비밀값과 실제 개인정보를 입력 JSON이나 Git에 넣지 않는다.

```powershell
$env:OPENROUTER_API_KEY='<OpenRouter 키>'
$env:LOGGING_TOKEN='<로깅 서버와 같은 토큰>'
node scripts/synthetic-logging-agent.mjs --contexts contexts.json --once --dry-run
node scripts/synthetic-logging-agent.mjs --contexts contexts.json --once
node scripts/synthetic-logging-agent.mjs --contexts contexts.json
```

`--dry-run`도 모델은 호출하지만 로깅 서버에는 보내지 않는다. `LOGGING_URL`로 로컬 서버 주소를 바꿀 수 있고 `OPENROUTER_MODEL`로 모델 ID를 바꿀 수 있다. 현재 기본 모델은 `deepseek/deepseek-v4.1-flash-1017`이다. 키가 없는 환경에서는 실제 모델·HTTP 연결을 검증할 수 없다.

## 브라우저 클릭 초기 버전

`scripts/browser-click-agent.mjs`는 Playwright 브라우저 컨텍스트를 하나 만들고, 로컬 개발 서버에 가상 독자 전용 HttpOnly 세션을 발급받습니다. 화면의 `a[data-article]`에서 기사 ID와 제목을 읽어 기존 `decide()`에 전달하고, 선택한 링크를 실제로 클릭합니다. `null`이면 클릭 없이 종료하고 목록 밖 ID는 거절합니다. 상세 화면 진입과 클릭 이벤트의 로깅 서버 ACK까지 확인한 후 컨텍스트를 닫습니다. 출력에는 성공 여부와 후보 수만 포함하며 독자 ID·쿠키·토큰은 출력하지 않습니다.

이 모드의 독자 ID는 페르소나 파일의 `reader_id`를 주입하는 대신 실제 화면이 `/api/user/anonymous`로 발급받은 UUID7을 사용합니다. 페르소나 파일의 ID는 모델 입력 문맥입니다. 실행마다 새 컨텍스트·새 독자이며 재방문 ID 유지와 페르소나별 영속 매핑은 아직 없습니다. Nemotron 데이터, 여러 기사 반복 탐색, 체류·스크롤·자동 재시도도 이번 범위에 없습니다.

로컬 개발 서버는 가상 세션의 피드 응답 메타데이터를 `/internal/served`에 먼저 등록한 뒤 화면에 반환합니다. 프런트는 실제 목록 링크 클릭으로 상세 화면이 열릴 때만 이벤트를 `/api/synthetic/events`로 보내며 서버는 세션에 연결된 독자 ID와 `source=simulator`로 전달합니다. 내부 로깅 토큰은 서버 환경에만 있습니다. 기존 직접 전송 스크립트는 병행 실행하지 않습니다. ACK의 accepted는 SQLite 수락이며 GCS 전송 완료가 아닙니다.

### 실행

실제 뉴스 백엔드를 먼저 실행합니다. 이 모드는 로컬 Node 개발 서버에서만 지원하며 GCP Nginx 정적 배포에는 적용되지 않습니다. 아래 환경을 설정한 터미널에서 로깅 서버와 웹 서버를 실행합니다. 토큰은 같은 값을 두 프로세스에 전달해야 합니다.

```powershell
npm ci
npx playwright install chromium
$env:LOGGING_TOKEN=[guid]::NewGuid().ToString()+[guid]::NewGuid().ToString()
$env:SYNTHETIC_AGENT_TOKEN=[guid]::NewGuid().ToString()+[guid]::NewGuid().ToString()
$env:LOGGING_URL='http://127.0.0.1:4195'
$env:NEWS_BACKEND_URL='http://127.0.0.1:8080/'
# 별도 터미널에서 동일 LOGGING_TOKEN으로 실행하고 유지
npm --prefix services/logging-server start
# 로깅 서버를 유지한 채 별도 터미널에서 위 환경을 설정하고 실행
npm start
```

에이전트 터미널에는 웹 서버와 동일한 `SYNTHETIC_AGENT_TOKEN`과 모델 키를 설정합니다. `LOGGING_TOKEN`은 에이전트에 필요하지 않습니다.

```powershell
$env:OPENROUTER_API_KEY='<로컬 키>'
# SYNTHETIC_AGENT_TOKEN은 웹 서버에 설정한 값과 동일하게 전달
npm run agent:browser -- --index 0 --url http://127.0.0.1:4173/ --headed
```

기설치 Edge를 사용하려면 브라우저 설치 대신 `$env:PLAYWRIGHT_CHANNEL='msedge'`를 설정할 수 있습니다. `--index`는 0부터 시작하며 기본 페르소나 파일의 첫 독자를 사용합니다. `--personas <파일>`로 입력 파일을 바꿀 수 있습니다. 실행은 독자 한 명의 한 번 선택으로 종료됩니다. 실패 시 종료 코드 1이며 로그를 임의로 성공 처리하지 않습니다.

### 검증

```powershell
npm run test:browser
```

시험용 HTTP 백엔드와 실제 로깅 HTTP 서버·SQLite, 실제 브라우저를 사용합니다. 모델 선택만 테스트 함수로 대체합니다. 화면 기사 수집·상세 진입·독자와 기사 연결·합성 출처·정확히 한 건 저장·중복 재수락·클릭 없음·목록 밖 ID 거절·독자별 컨텍스트 분리·일반 방문 로그 제외를 검증합니다. 테스트는 실제 뉴스 백엔드나 OpenRouter 연결 성공을 보장하지 않습니다. SQLite는 테스트용 인메모리 DB이며 영속 저장·재시작 검증은 기존 로깅 서버 테스트가 담당합니다.

## 이후 확장

Nemotron 페르소나 데이터의 실제 컬럼을 확인한 뒤 현재 페르소나 입력 형태로 변환한다. 이후 독자 ID 유지, 여러 기사 탐색과 읽기 행동을 확장할 수 있다. 1시간마다 N명 실행한다는 주기는 제안이며 확정된 운영 설정이 아니다. 브라우저 초기 버전에도 체류 시간·GCS 업로드는 없다.

## 확인할 결정

- 멘토: 이번 주에 화면 없이 직접 보낸 합성 이벤트를 허용하는가?
- 팀: 합성 독자의 ID 범위, 운영 로깅 서버 인증, 실행 ID와 합성 데이터 분리·보관은 어떻게 정할 것인가?
