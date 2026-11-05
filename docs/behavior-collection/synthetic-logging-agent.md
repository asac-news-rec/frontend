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

## 이후 브라우저 단계

웹이 완성되면 Nemotron 페르소나 데이터의 실제 컬럼을 먼저 확인한다. 그 뒤 Playwright로 접속해 쿠키 ID를 발급받고, 화면의 기사 제목을 모델에 주어 클릭·읽기 행동을 결정하게 하는 방안이다. 브라우저가 프런트 이벤트 경로를 사용하면 같은 파이프라인에서 수집할 수 있다. 1시간마다 N명 실행한다는 주기는 제안이며 확정된 운영 설정이 아니다. 이번 스크립트는 브라우저·쿠키·체류 시간·GCS 업로드를 구현하지 않는다.

## 확인할 결정

- 멘토: 이번 주에 화면 없이 직접 보낸 합성 이벤트를 허용하는가?
- 팀: 합성 독자의 ID 범위, 운영 로깅 서버 인증, 실행 ID와 합성 데이터 분리·보관은 어떻게 정할 것인가?
