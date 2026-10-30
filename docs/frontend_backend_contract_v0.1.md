# 개인화 뉴스 플랫폼 프론트엔드·백엔드 데이터 계약 초안 v0.1

후속 범위 변경 · 초기 관심사 입력·저장은 미합의이므로 제외했다. 이 문서의 초기 관심사 관련 제안은 확정 명세가 아니며 최신 청사진 v0.4를 우선한다.

작성일 2026-10-29. 팀 협의용 제안이며 확정된 API나 구현 완료 명세가 아니다. 현재 저장소에는 앱 코드가 없다. 문서의 기사와 독자는 모두 설명용 가상 데이터다.

## 1. 합의할 목표

독자 선택 → 뉴스 피드 → 기사 상세 → 행동 수집 → 배치 처리 → 추천 갱신의 흐름을 연결한다. 초기 범위는 독자 선택, 피드, 상세, 이벤트 수집이다. 독자 분석 화면은 후속 범위로 둔다. 댓글, 북마크, 검색, 회원가입은 이번 계약에 포함하지 않는다.

프론트엔드는 추천을 계산하지 않는다. 서버가 반환한 순서와 추천 이유를 표시한다. 가상 독자 시뮬레이터는 화면 외부에서 동작할 수 있으며, 브라우저를 반드시 거칠 필요는 없다.

## 2. 공통 형식

| 항목 | 제안 규칙 | 이유 |
|---|---|---|
| 전송 | JSON, 필드명 snake_case, 기본 경로 /api/v1 | 프론트·백엔드가 같은 이름으로 데이터를 확인한다. |
| 식별자 | 의미를 해석하지 않는 문자열 | DB의 정수·UUID 선택이 화면 코드를 바꾸지 않게 한다. 예시의 접두사는 의무가 아니다. |
| 시간 | UTC ISO 8601 문자열, 예시 2026-10-29T02:00:00.000Z | 서버 시간과 한국 화면 표시를 구분한다. 화면은 KST로 변환한다. |
| 시간 길이 | 0 이상의 정수, 필드명에 _ms | 초와 밀리초 혼동을 방지한다. |
| 목록 | 빈 결과는 [], 다음 페이지가 없으면 next_cursor=null | 빈 목록과 통신 실패를 구분한다. |
| null | 값이 없거나 측정하지 못했음을 의미 | 0을 미측정 값으로 쓰지 않는다. |
| 버전 | 경로 v1, 이벤트 schema_version=1 | API 호환성과 적재 이벤트의 형식 버전을 따로 관리한다. |
| 목록 크기 | limit 기본 20, 범위 1~50 | 응답 크기를 제한한다. 피드는 추천 생성 시 최대 50개를 고정한다. |

아래 예시 객체의 필드는 모두 응답에 존재한다. nullable로 명시한 필드는 null이 가능하다. 요청의 선택 필드는 생략 가능하다. 인증·권한은 별도로 합의해야 하며 reader_id를 알고 있다는 사실은 접근 권한이 아니다.

## 3. 먼저 구분할 데이터

| 객체 | 주요 필드와 형식 | 생성 주체 |
|---|---|---|
| Reader | reader_id:string, display_name:string, reader_type:"synthetic", initial_interests:Interest[], history_status:"new" 또는 "insufficient" 또는 "sufficient" | 백엔드 |
| Interest | category_id:string, name:string | 공통 카테고리 목록 |
| ArticleSummary | article_id:string, title:string, summary:string, category:Interest, thumbnail_url:string 또는 null, published_at:시간, content_origin:"synthetic" 또는 "collected", publisher_name:string 또는 null, source_url:string 또는 null | 기사 데이터 담당 |
| ArticleDetail | ArticleSummary의 모든 필드, content_text:string | 기사 데이터 담당 |
| Recommendation | recommendation_id:string, reader_id:string, generated_at:시간, feature_as_of:시간 또는 null, strategy:string, model_version:string 또는 null, fallback_reason:string 또는 null, items:추천 항목[] | 추천 서빙 백엔드 |
| Event | event_id:string, reader_id:string, session_id:string, event_type:enum, occurred_at:시간, recommendation_id:string 또는 null, article_id:string, source:enum, properties:이벤트별 객체 | 브라우저 또는 시뮬레이터 |

initial_interests는 처음 설정한 관심사이며 행동으로 추정한 관심사와 다르다. history_status의 판단은 서버가 맡는다. 초기 제안은 유효 article_click이 0개면 new, 1~4개면 insufficient, 5개 이상이면 sufficient이다. 이 기준은 모델 품질을 보장하지 않으므로 ML 담당자가 수정할 수 있다.

추천은 독자에게 제공한 목록 한 묶음이다. 추천 항목은 article, rank, reason을 갖는다. rank는 1부터 시작하고 목록 전체에서 중복되지 않는다. reason은 {code:string, text:string}이며 서버가 산출 근거에 맞게 제공한다.

content_origin은 기사의 생성 출처다. 이벤트의 source는 행동의 발생 경로다. 가상 독자의 기사를 사람이 눌러도 source는 browser다. 가상 독자라는 이유로 실제 사람의 행동 데이터로 보고하지 않는다.

## 4. 화면과 API 연결

| 화면·행동 | API | 성공 | 필요한 결과 |
|---|---|---|---|
| 카테고리 조회 | GET /api/v1/categories | 200 | 카테고리 ID와 표시명 |
| 독자 선택 | GET /api/v1/readers?limit=20&cursor=… | 200 | 독자 목록과 초기 관심사 |
| 첫 피드·명시적 새로고침 | POST /api/v1/recommendations | 201 | 고정된 추천 목록 첫 페이지 |
| 피드 다음 페이지 | GET /api/v1/recommendations/{recommendation_id}?limit=20&cursor=… | 200 | 같은 추천 묶음의 다음 페이지 |
| 기사 상세 | GET /api/v1/articles/{article_id} | 200 | 기사 본문 |
| 행동 전송 | POST /api/v1/events/batch | 200 | 이벤트별 수락·중복·거절 결과 |

카테고리 응답은 {"data":{"items":[{"category_id":"technology","name":"IT·과학"}]},"meta":{"request_id":"req_categories_01"}} 형태다. readers 응답의 data는 items와 next_cursor를 갖는다. cursor는 서버가 만든 불투명 문자열이며 프론트가 내용을 조합하거나 해석하지 않는다.

### 독자 응답 예시

```json
{
  "data": {
    "items": [
      {
        "reader_id": "reader_001",
        "display_name": "IT에 관심이 많은 독자",
        "reader_type": "synthetic",
        "initial_interests": [{"category_id": "technology", "name": "IT·과학"}],
        "history_status": "new"
      }
    ],
    "next_cursor": null
  },
  "meta": {"request_id": "req_readers_01"}
}
```

신규 독자를 만드는 API는 이번 범위에 넣지 않는다. 시드 데이터나 시뮬레이터가 독자를 제공한다고 가정한다. 실제 독자 생성 화면이 필요하면 별도 계약을 추가한다.

### 추천 생성 요청

```json
{
  "reader_id": "reader_001",
  "category_id": null,
  "limit": 20
}
```

reader_id는 필수다. category_id는 선택이며 null 또는 생략하면 전체 카테고리를 대상으로 한다. 값을 보내면 해당 카테고리로 후보를 제한한 뒤 서버가 순서를 정한다. limit는 첫 페이지 크기이며 생략 가능하다.

프론트는 요청 헤더 Idempotency-Key에 요청마다 새 UUID를 넣고 네트워크 재시도에는 같은 값을 쓴다. 서버는 동일 키와 동일 본문에 대해 24시간 동안 같은 추천 묶음을 반환한다. 같은 키에 다른 본문이면 409를 반환한다. 새로고침이나 독자 전환은 새 키를 사용한다.

### 추천 응답 예시

```json
{
  "data": {
    "recommendation_id": "rec_001",
    "reader_id": "reader_001",
    "category_id": null,
    "generated_at": "2026-10-29T02:00:00.000Z",
    "feature_as_of": null,
    "strategy": "initial_interest",
    "model_version": null,
    "fallback_reason": "new_reader",
    "items": [
      {
        "rank": 1,
        "reason": {"code": "INITIAL_INTEREST_MATCH", "text": "처음 선택한 IT·과학 관심사와 관련된 기사예요."},
        "article": {
          "article_id": "article_001",
          "title": "도서관에서 만나는 새로운 AI 교육",
          "summary": "지역 도서관이 시민 대상 AI 교육을 시작합니다.",
          "category": {"category_id": "technology", "name": "IT·과학"},
          "thumbnail_url": null,
          "published_at": "2026-10-29T01:00:00.000Z",
          "content_origin": "synthetic",
          "publisher_name": null,
          "source_url": null
        }
      }
    ],
    "next_cursor": null
  },
  "meta": {"request_id": "req_rec_01"}
}
```

서버는 추천 ID에 독자, 후보 기사 ID, 순위, 추천 이유, 전략, 버전을 연결해 보관한다. 페이지를 넘겨도 순위를 다시 계산하지 않는다. 초안의 추천 보관 기간은 30일이며 기간이 지난 목록 조회는 410 RECOMMENDATION_EXPIRED로 응답한다. cursor는 해당 추천 ID에만 유효하다.

strategy 제안 값은 model, initial_interest, popular, latest다. fallback_reason은 new_reader, insufficient_history, model_unavailable, null이다. 개인화 모델을 사용하면 model_version을 반드시 반환한다. initial_interest는 추천 모델의 예측 결과로 표시하지 않는다.

이력이 부족하면 초기 관심사를 우선 사용하고, 관심사가 없으면 집계 가능한 인기 기사를 사용한다. 인기 데이터도 없으면 최신 기사로 대체한다. 조건에 맞는 기사가 없으면 items=[]를 반환하고 화면은 빈 상태를 표시한다. 서버가 추천 실패를 성공한 모델 추천처럼 꾸미지 않는다.

### 기사 상세 응답 예시

```json
{
  "data": {
    "article_id": "article_001",
    "title": "도서관에서 만나는 새로운 AI 교육",
    "summary": "지역 도서관이 시민 대상 AI 교육을 시작합니다.",
    "category": {"category_id": "technology", "name": "IT·과학"},
    "thumbnail_url": null,
    "published_at": "2026-10-29T01:00:00.000Z",
    "content_origin": "synthetic",
    "publisher_name": null,
    "source_url": null,
    "content_text": "지역 도서관이 시민 대상 AI 교육을 시작합니다.\n교육은 기초 과정부터 진행됩니다."
  },
  "meta": {"request_id": "req_article_01"}
}
```

MVP 본문은 일반 텍스트다. 프론트는 줄바꿈을 표시하고 HTML로 해석하지 않는다. 외부 수집 기사는 publisher_name과 source_url을 필수로 제공하는 규칙을 제안한다. 이미지가 없으면 기본 이미지를 표시한다. 기사 상세 직접 진입도 허용하며 추천 출처가 없으면 이벤트 recommendation_id는 null이다.

## 5. 행동 이벤트 계약

### 공통 필드

| 필드 | 형식·필수 여부 | 목적 |
|---|---|---|
| schema_version | 정수 1, 필수 | 적재 이벤트 형식 구분 |
| event_id | UUID 문자열, 필수 | 재전송 중복 제거 |
| event_type | article_impression, article_click, article_dwell 중 하나, 필수 | 행동 의미 구분 |
| reader_id | 문자열, 필수 | 행동 주체 |
| session_id | UUID 문자열, 필수 | 한 번의 독자 이용 세션 연결 |
| article_id | 문자열, 필수 | 행동 대상 |
| recommendation_id | 문자열 또는 null, 필수 | 행동을 발생시킨 추천 묶음 |
| occurred_at | UTC 시간, 필수 | 실제 발생 시각 |
| source | browser 또는 simulator, 필수 | 발생 경로 구분. 서버가 호출 권한과 대조 |
| properties | 이벤트 종류별 객체, 필수 | 노출·클릭·체류 고유 정보 |

브라우저 session_id는 탭별로 생성한다. 독자 전환이나 마지막 활동 후 30분이 지나면 새 값을 사용한다. 시뮬레이터도 독자별 이용 세션을 만든다. 같은 가상 독자라도 브라우저와 시뮬레이터의 세션 ID는 공유하지 않는다.

### 이벤트별 측정 규칙

| 이벤트 | properties | 발생 조건과 중복 규칙 |
|---|---|---|
| article_impression | rank:양의 정수, visible_ratio:0~1, visible_ms:양의 정수 | 활성 탭에서 카드의 50% 이상이 연속 1,000ms 보이면 발생. 가려지거나 기준 미달이면 타이머 초기화. session_id·recommendation_id·article_id별 1회 |
| article_click | rank:양의 정수 | 피드의 기사 링크를 활성화할 때마다 발생. 마우스·키보드·새 탭 열기도 포함하도록 구현 검토. 네트워크 재전송은 같은 event_id |
| article_dwell | article_view_id:UUID, sequence:양의 정수, active_time_ms:양의 정수, is_final:boolean | 상세가 화면에 보이고 문서가 포커스된 시간의 증가분. 누적값이 아님. 10초마다 전송하고 비활성화·이탈 시 남은 증가분 전송 |

article_impression과 article_click은 recommendation_id가 필수 non-null이다. 직접 진입은 피드 클릭 이벤트를 만들지 않는다. 직접 진입의 article_dwell은 recommendation_id=null을 허용한다. article_view_id는 상세 진입마다 새로 만들며 일반적인 읽기 체류와 재방문을 구분한다.

article_dwell의 sequence는 같은 article_view_id에서 1부터 증가한다. 동일 sequence의 재시도는 동일 event_id와 본문을 유지한다. active_time_ms는 1~10,000을 허용하며 장시간 타이머 지연은 최대 10,000ms 단위로 나눠 보낸다. is_final은 마지막이라고 판단한 보고이며 실제 종료 전달을 보장하지 않는다. 브라우저 종료로 일부 이벤트가 누락될 수 있으므로 측정값은 관측한 활성 시간으로 해석한다.

이벤트를 보내는 독자 정보는 발생 순간에 고정한다. 독자를 바꾼 뒤 이전 독자의 전송 대기 이벤트를 새 reader_id로 수정하지 않는다. 프론트는 독자별 캐시를 분리하고 늦게 도착한 이전 독자의 피드 응답이 현재 화면을 덮지 않게 한다.

### 이벤트 전송 예시

```json
{
  "events": [
    {
      "schema_version": 1,
      "event_id": "9d4384bc-431b-4ffb-a426-56bd65894cc1",
      "event_type": "article_impression",
      "reader_id": "reader_001",
      "session_id": "87fa0dc0-7af5-4a13-9cf6-3e2dfa9ed44b",
      "article_id": "article_001",
      "recommendation_id": "rec_001",
      "occurred_at": "2026-10-29T02:00:01.000Z",
      "source": "browser",
      "properties": {"rank": 1, "visible_ratio": 0.8, "visible_ms": 1000}
    },
    {
      "schema_version": 1,
      "event_id": "628e3df8-8ef8-4d59-92e1-407e70417366",
      "event_type": "article_dwell",
      "reader_id": "reader_001",
      "session_id": "87fa0dc0-7af5-4a13-9cf6-3e2dfa9ed44b",
      "article_id": "article_001",
      "recommendation_id": "rec_001",
      "occurred_at": "2026-10-29T02:00:15.000Z",
      "source": "browser",
      "properties": {"article_view_id": "581c584a-2bef-457f-a5fb-a183ca64edb8", "sequence": 1, "active_time_ms": 10000, "is_final": false}
    }
  ]
}
```

article_click도 같은 공통 필드를 사용하며 properties는 {"rank":1}이다. 예시는 서로 다른 이벤트의 형식을 보여주며 전체 이용 로그를 나타내지는 않는다.

### 전송 응답 예시

```json
{
  "data": {
    "results": [
      {"event_id": "9d4384bc-431b-4ffb-a426-56bd65894cc1", "status": "accepted", "code": null},
      {"event_id": "628e3df8-8ef8-4d59-92e1-407e70417366", "status": "duplicate", "code": null}
    ],
    "received_at": "2026-10-29T02:00:16.000Z"
  },
  "meta": {"request_id": "req_events_01"}
}
```

한 번에 1~50개를 보낸다. 정상적인 배치 구조는 HTTP 200과 입력 순서에 맞는 개별 결과를 반환한다. accepted는 서버의 내구성 있는 저장소 또는 큐에 기록되었다는 의미다. BigQuery 적재·학습·추천 반영 완료를 뜻하지 않는다.

동일 event_id·동일 본문은 duplicate다. 동일 event_id·다른 본문은 rejected와 EVENT_ID_CONFLICT를 반환한다. 잘못된 추천 소속은 RECOMMENDATION_CONTEXT_MISMATCH다. 한 배치 안에서 중복 event_id는 허용하지 않고 배치 전체를 400으로 거절한다. 중복 제거용 키는 적어도 이벤트 수용 기간 30일 동안 보관한다.

프론트는 accepted와 duplicate를 대기열에서 지운다. rejected는 자동 재시도하지 않는다. 응답을 받지 못했거나 429·5xx이면 동일 event_id로 지수 지연 재시도하며 Retry-After가 있으면 따른다. 초기 재시도는 최대 3회로 제한하고 남은 실패는 관측 지표로 남긴다. 완전한 무손실 수집을 보장하는 설계는 아니다.

서버는 received_at을 직접 생성한다. occurred_at이 수신 시각보다 5분 넘게 미래이거나 30일보다 과거면 EVENT_TIME_OUT_OF_RANGE로 거절한다. 시뮬레이터의 과거 데이터 일괄 적재는 이 API가 아닌 별도 배치 경로로 분리한다.

## 6. 검증·오류·운영 경계

서버는 독자·기사의 존재, 추천의 독자 소유 관계, 추천에 포함된 기사와 rank 일치, 필수 필드와 범위를 검증한다. source는 클라이언트 문자열만 믿지 않고 브라우저·시뮬레이터용 호출 권한과 대조한다. 화면이 DB나 BigQuery에 직접 쓰지 않게 한다.

에러 응답은 다음 형식을 사용한다.

```json
{
  "error": {
    "code": "READER_NOT_FOUND",
    "message": "독자를 찾을 수 없습니다.",
    "details": [{"field": "reader_id", "reason": "unknown_id"}]
  },
  "meta": {"request_id": "req_error_01"}
}
```

| HTTP 상태 | 의미 | 프론트 처리 |
|---|---|---|
| 400 | 형식·파라미터 오류 | 자동 재시도 중단, 개발 로그 확인 |
| 401·403 | 인증·권한 오류 | 접근 안내, 자동 반복 요청 중단 |
| 404 | 독자·기사·추천 없음 | 대상 없음 화면 |
| 409 | 멱등 키와 요청 본문 충돌 | 요청 생성 로직 확인 |
| 410 | 추천 보관 기간 종료 | 새 피드 요청 안내 |
| 429 | 요청 제한 | Retry-After 이후 재시도 |
| 500·503 | 서버·필수 서비스 장애 | 오류 안내와 재시도 |

추천 모델 장애라도 대체 전략이 성공하면 201과 실제 대체 전략을 반환한다. 대체 전략도 제공하지 못하면 503이다. 새 추천을 조회하지 않은 상태에서 화면이 관심사나 추천 순서를 임의로 바꾸지 않는다.

학습 입력은 occurred_at뿐 아니라 received_at도 기준 시점 이내여야 한다. 기준 시점 이후 도착한 이벤트를 과거 추천의 입력으로 소급 사용하지 않는다. feature_as_of는 피처에 포함한 데이터의 기준 시각이다. 추천 생성 시각과 동일하다는 보장은 없다. 실험 품질은 별도 평가로 확인한다.

## 7. 이 형식을 제안하는 이유

| 설계 선택 | 해결하는 문제 | 부담·대안 |
|---|---|---|
| 추천 ID와 목록 고정 | 클릭이 어떤 추천의 몇 번째 기사였는지 추적. 페이지 이동 중 순서 변경 방지 | 서버의 추천 이력 보관 필요. 매번 재계산하면 원인 분석이 어려움 |
| 피드 응답과 실제 노출 분리 | 내려받았지만 보지 않은 기사를 노출로 세는 문제 방지 | 화면 가시성 측정 필요. 데이터 담당자와 집계 정의 합의 필요 |
| event_id와 체류 sequence | 재전송 때문에 클릭·체류가 부풀려지는 문제 방지 | 중복 제거 저장 필요. 재시도마다 새 ID를 만들면 해결되지 않음 |
| 체류 증가분과 활성 시간 | 탭만 열어 둔 시간을 줄이고 부분 수신도 합산 가능 | 브라우저 종료 누락은 남음. 실제 집중도나 완독 여부를 보장하지 않음 |
| 초기 관심사와 추정 관심사 분리 | 모델이 알아낸 결과와 사전 설정을 혼동하지 않음 | 분석 화면에 두 값의 명칭을 다르게 표시 |
| 추천 이유·대체 전략·갱신 시간 | 신규 독자와 모델 장애 상황을 설명하고 오래된 결과 식별 | 이유 문구는 서버의 실제 규칙을 따라야 함 |
| 서버 추천 항목에 기사 요약 포함 | 카드마다 상세 API를 추가 요청하는 구조 방지 | 목록 응답 크기 증가. 본문은 상세 API에만 포함 |
| 기사 출처와 행동 발생 경로 분리 | 가상·수집 기사와 시뮬레이션·브라우저 행동을 별도로 분석 | 필터 없이 합산한 결과를 실제 이용자 성과로 보고하면 안 됨 |
| UTC와 단위 명시 | 시간대·초/밀리초 차이로 집계가 어긋나는 문제 방지 | 화면에서 KST 표시 변환 필요 |
| 서버 입력 검증 | 다른 독자의 추천 ID 연결과 잘못된 rank 적재 방지 | 인증 방식은 인프라·백엔드와 추가 합의 필요 |

적용 원칙은 Model the Domain과 Boundary Discipline이다. 전자는 독자·기사·추천·이벤트를 다른 객체로 나누는 선택에 반영했다. 후자는 서버에서 입력과 추천 소속을 검증하는 선택에 반영했다. Experience First는 핵심 독서 흐름을 우선하고 분석 화면을 후순위로 두는 선택에 반영했다.

## 8. 팀 회의에서 확정할 항목

| 질문 | 제안 기본값 | 합의할 담당 |
|---|---|---|
| 가상 독자 행동은 어디서 생성하는가? | 독립 시뮬레이터. 프론트는 시연 중 사람의 행동도 전송 | 백엔드·데이터·프론트 |
| 독자 선택은 공개 기능인가? | 시연용 접근 제어 환경에서만 허용. 인증 방법은 미정 | 백엔드·인프라 |
| 노출 기준은 무엇인가? | 활성 탭, 카드 50%, 연속 1초 | 프론트·데이터 |
| 체류 기준과 단위는 무엇인가? | 활성 화면 시간의 증가분, 밀리초, 10초 주기 | 프론트·데이터 |
| 배치 추천은 언제 바뀌는가? | 배치 주기 미정. 생성·피처 기준 시각을 응답에 포함 | ML·데이터 |
| 신규 독자 추천은 무엇인가? | 초기 관심사 → 인기 → 최신 순으로 대체 | ML·백엔드 |
| 이력 부족 기준은 무엇인가? | 유효 클릭 5개 미만. ML 담당자 검토 필요 | ML·데이터 |
| 이벤트 수락 시점은 언제인가? | 내구성 있는 저장 또는 큐 기록 이후 | 백엔드·인프라 |
| 추천 이력·이벤트 중복 키 보관은? | 30일. 프로젝트 기간·비용에 맞게 확정 | 백엔드·데이터 |
| API 문서와 샘플은 누가 유지하는가? | 백엔드가 기계 판독 가능한 명세 관리, 프론트와 공동 검토 | 백엔드·프론트 |

## 9. 실제 입력·출력으로 확인할 수용 조건

1. 같은 독자·같은 멱등 키·같은 요청은 같은 추천 ID와 순서를 반환한다.
2. 다음 페이지의 추천 ID는 유지되고 rank가 겹치지 않는다.
3. 서로 다른 관심사를 가진 독자의 결과와 추천 이유를 비교한다. 결과 차이는 실제 추천 로직 연결 후 검증하며 지금은 보장하지 않는다.
4. 독자 A의 추천 ID를 독자 B 이벤트에 넣으면 거절한다.
5. 화면 아래에 있어 보이지 않은 카드와 비활성 탭의 카드는 노출 이벤트를 만들지 않는다.
6. 같은 이벤트를 두 번 보내면 두 번째는 duplicate이며 분석 집계는 한 번이다.
7. 상세에서 10초·10초·3초 증가분을 보내면 체류는 23,000ms다. 탭을 숨긴 시간은 제외한다.
8. 직접 기사 상세에 진입하면 recommendation_id=null인 체류만 남기고 피드 클릭을 만들지 않는다.
9. 독자 전환 직전에 발생한 이벤트는 이전 독자 ID를 유지한다. 이전 응답은 현재 독자의 화면을 덮지 않는다.
10. 신규 독자는 실제 대체 전략과 이유가 표시된다. 빈 기사 목록과 API 오류는 다른 화면으로 표시한다.
11. 이벤트 accepted 뒤 BigQuery 적재 전 상태를 추천 반영 완료로 표시하지 않는다.
12. 과거 추천의 평가 입력에 미래 발생·미래 수신 이벤트가 포함되지 않는지 데이터 파이프라인에서 확인한다.

이 문서는 합의 초안이다. 실행 가능한 API, 검증 코드, 실제 수집·추천 기능은 구현하지 않았다.
