# 화요일 멘토 검토 자료 · 프론트엔드 데이터 구조와 인터페이스

대상 회의: 2026-11-03 · 작성: 2026-11-02 · 버전 0.1

## 1. 제출 상태와 담당 범위

이 자료는 현재 프론트엔드 설계와 모의 화면을 설명하는 검토본이다. 개발 완료 보고서가 아니다. 독립된 모의 화면의 JavaScript 문법만 확인했으며 실제 브라우저 동작 검증, 본 피드 통합, 백엔드 연결은 남아 있다.

프론트엔드 담당 범위는 목록·상세 표시, 서버 식별자 유지, 가시성·시간·클릭 측정, 즉시 개별 전송과 재시도다. 백엔드·추론·로깅 저장·Airflow 구현은 각 담당자의 영역이다. 아래 서버 간 계약과 테이블은 연결 검토를 위한 제안이며 해당 담당자의 확정이 필요하다.

근거 자료는 [백엔드 논의](../2026-10-31/news_recommendation_discussion.html), [프론트엔드 상세 명세](../../behavior-collection/behavior-collection-frontend-spec.md), [모의 검증 화면](../../behavior-collection/behavior-collection-mock.html)이다. 초기 관심사 입력은 MVP에서 제외한다. 정적인 유저 속성이 없더라도 현재 방문자 ID와 서버가 보유한 과거 행동 피처로 추천을 요청할 수 있다.

## 2. impression과 exposure를 별도 사건으로 정의한다

| 프로젝트 이름 | 생성 위치 | 의미·발생 기준 | 실제로 보였는가 |
|---|---|---|---|
| impression | 웹 백엔드의 served 기록 | 최종 응답에 포함한 기사별 반환 기회. 서버가 impression_id 발급 | 보장하지 않음 |
| exposure + list | 프론트엔드 actions 기록 | 카드 50% 이상, 활성 탭, 스크롤 정지 상태인 구간 | 정의한 가시성 조건 충족 |
| exposure + detail | 프론트엔드 actions 기록 | 유효 상세 화면이 활성 탭에서 보이는 구간. 상세 스크롤은 포함 | 상세 화면 노출 |
| click + article_open | 프론트엔드 actions 기록 | 기사 링크 활성화 | 클릭 사건이며 노출 증명과 별개 |
| click + like/unlike | 프론트엔드 actions 기록 | 좋아요 저장 성공으로 확인된 상태 변경 | 기사 조회 클릭과 구분 |

impression_id는 실제 화면 노출 ID가 아니라 반환된 추천 건의 연결 키다. served 로그가 impression 사건에 해당한다. actions에는 별도 exposure 사건을 남긴다. 같은 이름의 ID가 있다고 두 사건을 합치지 않는다.

예를 들어 서버가 10개 기사를 반환하고 A·B·C만 실제로 보이며 A만 눌렸다면 impression 10건, 노출이 확인된 추천 건 3건, 기사 조회 클릭이 연결된 추천 건 1건이다. 학습에서는 A를 양성, B·C를 관찰 기간 종료 후 음성 후보로 사용한다. 나머지 7건은 노출 미확인이므로 음성으로 만들지 않는다. 로그 유실도 가능하므로 미확인을 실제 미노출이라고 단정하지 않는다.

현재 통합안은 1초 최소 기준 없이 양의 길이의 유효 구간을 기록한다. 50%와 스크롤 정지 조건은 백엔드 자료 기준이다. 임계값을 추가하려면 측정 정책 버전을 합의한다. 여러 노출 구간은 같은 impression_id의 학습 행 하나로 통합한다.

## 3. 단계별 요청·응답과 책임

```text
프론트 ─ 목록 요청 → 웹 백엔드 ─ 후보 점수 요청 → AI 추론 서버
프론트 ← 기사·impression_id ─ 웹 백엔드 ← 기사별 점수 ─ AI 추론 서버
                                  └→ served(impression) 로그
프론트 ─ exposure/click JSON 1건 → 웹 라우팅/로깅 API
                                      ↓
                           영속 수락 여부 응답 → 프론트
                                      ↓
                    GCS served/actions JSONL → Airflow·BigQuery
```

프론트는 추론 서버·GCS·Airflow·Valkey를 직접 호출하지 않는다. 브라우저의 전송은 즉시, 서버 저장 경로는 5분 구간, 서버 FLUSH와 분석 배치는 별도 주기다.

### 3.1 프론트 → 웹 백엔드: 목록

아래는 목표 계약 제안이다. 현재 로컬 /api/v1/feed 응답과 같지 않다.

| 요청 항목 | 형식 | 규칙 |
|---|---|---|
| 경로 | GET /api/v1/feed | 동일 출처 |
| category_id | 선택 string | 생략 시 전체. 실제 카테고리 API ID 사용 |
| cursor | 선택 opaque string | 다음 페이지에서 서버 값을 그대로 사용 |
| limit | integer | 기본 20, 1~50 제안 |
| Cookie | 기존 HttpOnly 방문자 쿠키 | 브라우저 자동 전달, 본문에 토큰·user_id 없음 |
| Idempotency-Key | UUID 헤더 제안 | 논리 조회마다 새 값, 네트워크 재시도는 유지. 서버 지원 합의 필요 |

```json
{
  "request_id": "req-001",
  "served_at": "2026-11-02T00:00:00.000Z",
  "strategy": "latest",
  "model_version": null,
  "items": [{
    "article_id": "a3",
    "impression_id": "imp-001",
    "position": 1,
    "title": "함께 달리는 주말 러닝",
    "summary": "화면 검토용 가상 기사",
    "publisher_name": "사이뉴스 시연 편집부",
    "published_at": "2026-10-28T23:30:00.000Z",
    "category_id": "sports",
    "thumbnail_url": null,
    "content_origin": "synthetic",
    "score": null,
    "reason": "최근 발행된 기사예요"
  }],
  "next_cursor": null
}
```

응답의 request_id·served_at·strategy·model_version·items·next_cursor는 필수다. 각 item의 위 필드도 필수이며 model_version·thumbnail_url·score·next_cursor는 null 가능하다. position은 한 응답의 1 기반 순위다. 다음 페이지는 새 요청이며, 누적 화면 순위는 프론트 내부에서 별도 관리한다. 기사 ID는 요청 내 중복되지 않는다. 서버가 필터와 순서를 확정하므로 프론트가 재정렬하지 않는다. 같은 논리 재시도는 같은 request_id와 impression_id를 반환한다.

score는 선택된 전략에서 제공하지 않으면 null이다. pCTR 전략일 때만 0~1 클릭 확률이라는 의미를 부여한다. 임의 순위 점수를 클릭 확률로 표시하지 않는다. 점수는 화면 필수 표시값이 아니다. 가상 기사와 실제 수집 기사를 구분한다.

기사 상세의 목표 경로는 GET /api/v1/articles/{article_id}이며 기사 표시 필드와 content_text를 받는 안이다. 현재 앱은 로컬 기사 조회다. 기존 피드에서 상세로 이동하면 impression_id를 내부 컨텍스트에 유지한다. 직접 진입·새로고침·새 탭의 ID 발급은 미합의이며 임의 ID를 만들어 전송하지 않는다.

### 3.2 웹 백엔드 → AI 추론 서버: 담당자 협의용

사용자 식별은 서버가 쿠키로 검증한다. 초기 관심사·나이·성별 등 없는 정적 속성을 필수 입력으로 만들지 않는다. 백엔드 자료처럼 추천 API가 user_id와 후보 article_id로 서버 피처를 조회하는 안이다.

```json
{
  "request_id": "req-001",
  "user_id": "u001",
  "inference_at": "2026-11-02T00:00:00.000Z",
  "candidate_article_ids": ["a3", "a1"],
  "limit": 2
}
```

```json
{
  "request_id": "req-001",
  "model_version": "ctr-example-v1",
  "score_type": "pctr",
  "items": [
    {"article_id": "a3", "score": 0.35},
    {"article_id": "a1", "score": 0.18}
  ]
}
```

요청 필드는 모두 필수다. user_id는 내부 사용자 키, candidate_article_ids는 비어 있지 않은 중복 없는 문자열 배열, limit는 후보 수 이하 양의 정수다. 응답 필드는 모두 필수이며 model_version은 적용 모델의 실제 버전, score_type은 점수의 의미다. items는 점수 내림차순이며 요청 후보만 포함한다. 동점 순서·timeout·후보 상한은 서버 담당자가 확정한다. 예시 버전은 실제 배포 모델이 아니다.

웹 백엔드는 반환 기사의 서비스 가능 여부를 확인해 최종 순서를 확정하고 그때 impression_id를 만든다. 모델 장애·이력 부족 시 latest 등 대체 전략을 명시한다. score null과 실제 모델 점수를 구분한다. 실제 사용한 피처 버전·선택 시각·기본값 정책은 서버 추론 기록으로 남겨 추천 당시 입력을 재현한다. 프론트가 과거 행동 비중이나 CTR을 계산해 보내지 않는다.

### 3.3 프론트 → 로깅 API: 단건 행동

브라우저 경로 POST /api/v1/events에서 내부 /events로 전달하는 안이다. 정확한 경로는 합의 전이다. Content-Type은 application/json, 같은 출처 쿠키와 Origin 검사를 사용한다.

```json
{
  "event_id": "evt-001",
  "event_type": "exposure",
  "event_time": "2026-11-02T00:00:01.000Z",
  "impression_id": "imp-001",
  "page_type": "list",
  "duration_ms": 3000,
  "ended_at": "2026-11-02T00:00:04.000Z"
}
```

```json
{
  "event_id": "evt-002",
  "event_type": "click",
  "event_time": "2026-11-02T00:00:04.000Z",
  "impression_id": "imp-001",
  "page_type": "list",
  "action": "article_open"
}
```

| 필드 | 형식 | 필수·제약 |
|---|---|---|
| event_id | string | 필수, 프론트 UUID, 재전송 시 유지 |
| event_type | enum | 필수, exposure 또는 click |
| event_time | timestamp string | 필수, 시간대 포함. 클릭 시각 또는 구간 시작 |
| impression_id | string | 필수, 웹 백엔드 발급 값 그대로 |
| page_type | enum | 필수, list 또는 detail |
| duration_ms | integer | exposure만 필수, 양수, 누적이 아닌 구간 길이 |
| ended_at | timestamp string | exposure만 필수, 종료 시각, 시작 이전 금지 |
| action | enum | click만 필수, article_open·like·unlike |

article_open은 list에서만 사용한다. 상세·목록 좋아요는 page_type으로 구분한다. click에는 시간 길이를 넣지 않고 exposure에는 action을 넣지 않는다. 사용자·기사·순서는 impression_id로 서버가 연결한다. 추가 필드 허용 여부와 최대 문자열·구간 길이는 서버 스키마로 확정해야 한다.

ACK 형식 제안은 다음과 같다. accepted는 영속 저장 또는 영속 큐 수락을 뜻하도록 권장한다. 아직 실제 서버 계약은 아니다.

```json
{"event_id":"evt-001","status":"accepted"}
```

status 제안은 accepted, duplicate, rejected, retryable이다. rejected·retryable은 code를 추가한다. event_id가 일치하는 accepted·duplicate만 미확인 목록에서 지운다. 메모리 버퍼 접수만으로 성공하는 실습은 별도 유실 허용 모드로 명시해야 한다. GCS FLUSH까지 응답을 대기하면 timeout이 발생할 수 있으므로 저장 책임을 서버와 정한다.

네트워크 오류·5xx·응답 유실은 같은 ID로 재시도한다. 429는 Retry-After를 존중하고 형식 오류는 무한 재시도하지 않는다. 방문자 삭제·변경 시 이전 기록 전송을 중단한다. 서버는 쿠키 사용자와 impression_id 소유자를 대조하며 ID 자체를 인증 수단으로 쓰지 않는다.

## 4. 원본 파일 형식과 테이블 스키마 제안

로깅 서버가 여러 단건 JSON을 모아 UTF-8 JSONL로 저장한다. 한 줄이 객체 하나다. GCS served/actions 경로를 분리하고 객체는 불변 파일로 생성한다. 기존 객체에 계속 append하지 않는다. 아래는 담당자에게 전달할 논리 스키마이며 프론트의 DB 구현 범위가 아니다.

### served_impressions: 반환 기회 1건당 1행

| 컬럼 | BigQuery 형식 | NULL | 정의 |
|---|---|---|---|
| impression_id | STRING | 불가 | 논리 유일 키, 기사별 반환 건 |
| event_type | STRING | 불가 | impression 고정. served 로그가 해당 사건임을 명시하는 저장 메타데이터 제안 |
| request_id | STRING | 불가 | 목록 요청 키 |
| user_id | STRING | 불가 | 서버 사용자 키 |
| article_id | STRING | 불가 | 기사 DB 연결 키 |
| position | INT64 | 불가 | 응답 내 1 기반 최종 순서 |
| served_at | TIMESTAMP | 불가 | 최종 응답 확정 시각 |
| received_at | TIMESTAMP | 불가 | 로깅 서버 수신 시각 |
| strategy | STRING | 불가 | latest 또는 model 등 실제 전략 |
| model_version | STRING | 가능 | 모델 미사용 시 null |
| score | FLOAT64 | 가능 | 모델 점수, 미제공 시 null |

user_id 없는 방문자의 수집 여부는 미합의다. 본 제안은 행동 수집을 허용하고 서버 식별된 방문자를 대상으로 한다. BQ에서 논리 키 유일성이 자동 보장된다고 가정하지 않고 정제 작업에서 검사한다.

### action_events: 행동·구간 1건당 1행

| 컬럼 | BigQuery 형식 | NULL | 정의 |
|---|---|---|---|
| event_id | STRING | 불가 | 행동 논리 유일 키 |
| impression_id | STRING | 불가 | served 참조 |
| event_type | STRING | 불가 | exposure 또는 click |
| page_type | STRING | 불가 | list 또는 detail |
| event_time | TIMESTAMP | 불가 | 클릭 발생·구간 시작 |
| ended_at | TIMESTAMP | 가능 | exposure 필수, click은 null |
| duration_ms | INT64 | 가능 | exposure 양수, click은 null |
| action | STRING | 가능 | click 필수, exposure는 null |
| received_at | TIMESTAMP | 불가 | 서버 수신 시각 |
| source | STRING | 불가 | 서버 부여 browser 또는 simulator |
| schema_version | INT64 | 불가 | 서버 수집 스키마 버전 제안 |
| measurement_version | STRING | 불가 | 측정 기준 버전 제안 |

wire JSON에서 생략한 비해당 필드는 테이블에서 null로 정규화한다. user_id는 검증한 served 연결에서 얻는다. raw에는 재전송 중복이 있을 수 있다. clean은 동일 event_id·동일 본문을 한 건으로 만들고 같은 ID의 다른 내용은 충돌로 격리한다. 여러 정상 구간을 같은 impression_id라는 이유로 제거하지 않는다.

### 학습용 연결 결과: 노출 확인된 추천 건 1건당 1행

| 컬럼 | 형식 | 정의 |
|---|---|---|
| impression_id | STRING | 행 연결 키, 모델 피처로 사용하지 않음 |
| user_id / article_id | STRING 각각 | 행동 주체와 기사 |
| first_exposed_at | TIMESTAMP | 최초 유효 list 구간 시작 |
| list_duration_ms | INT64 | 중복 제거된 list 구간 합계 |
| detail_duration_ms | INT64 | detail 구간 합계, list와 분리 |
| clicked | INT64 또는 null | 관찰 완료 후 article_open 유무 1/0, 미완료 null |
| label_status | STRING | pending 또는 final, 불일치는 별도 품질 테이블 |
| feature_snapshot_id | STRING 또는 null | 실제 사용한 피처 연결, 미확정 필드 |

시간 구간이 겹치는 중복 생성 버그는 event_id만으로 해결되지 않으므로 겹침도 품질 점검한다. clicked는 like/unlike를 제외한다. 첫 노출 후 30분은 백엔드 예시이며 지연 허용과 함께 확정해야 한다. 추천 이후 행동을 해당 추천 입력에 넣지 않는다. 피처 선택 시각과 available_at을 확인해 당시 사용 가능한 피처를 연결한다.

## 5. 5분 경로·FLUSH·Airflow의 인터페이스

발생 시각을 기준으로 5분 경로를 나누며 백엔드 예시는 KST다. 프론트는 UTC를 보내고 서버가 변환한다. 09:02 사건은 minute=00, 09:07 사건은 minute=05다. 구간 이벤트는 시작 시각을 기준으로 경로에 넣는다. 이는 GCS 경로 구분이며 BigQuery 네이티브 5분 파티션을 뜻하지 않는다.

FLUSH 1,000건 또는 30초, 가공 1시간은 설명용 예시다. 같은 5분 경로에도 여러 파일이 생긴다. 구간을 넘어 늦게 도착한 파일이 있을 수 있으므로 파일 존재만으로 전체 도착 완료를 판정하지 않는다.

데이터 담당자에게 필요한 연결 계약은 대상 prefix·시간대, 파일 객체명·generation, 스키마 버전, 건수와 완료 표시, 빈 구간 표기, 재처리·중복 방지와 지연 파일 처리다. 센서는 준비 여부를 기다리고 품질 작업은 필드·중복·시간·served 연결을 검사하도록 구분한다. 프론트는 시험 event_id를 전달해 원본과 정제 결과가 일치하는지 검증한다.

## 6. 프론트엔드 내부 상태와 구현 체크

내부 구조는 ArticleSummary, CardContext, ExposureSegment, PendingEvent로 나눈다. CardContext는 article_id·impression_id·position을 유지하고 ExposureSegment는 시작 UTC·단조 시계·page_type을 유지한다. PendingEvent는 고정된 전송 본문과 재시도 상태를 갖는다. 사용자 변경 시 이전 상태를 폐기한다.

목록은 50%·visible·정지 조건에서 시작하고 스크롤 시작·가시성 미달·hidden·이탈 시 종료한다. 상세는 visible에서 시작하고 hidden·이탈 시 종료하며 스크롤은 포함한다. 반복 노출은 새 event_id다. 종료 즉시 개별 전송하며 종료 직전 전송 성공은 보장하지 않는다. 긴 구간 중간 보고는 아직 합의하지 않았다.

| 확인 항목 | 현재 증거 | 완료 시 필요한 증거 |
|---|---|---|
| 모의 화면 | 독립 HTML과 JavaScript 문법 검사 | 브라우저 실제 조작 결과·스크린샷 |
| 노출·체류 구간 | 예제 구현 | 49%/50%, 스크롤·hidden·반복 노출 시간 비교 |
| 이벤트 단건 전송 | 인메모리 mockSend | 모의 API 호출 기록과 실제 HTTP 연결 확인 |
| 실패·재시도 | 모의 장애 스위치 | 같은 ID 재시도·중복 방지·철회 경쟁 검증 |
| 실제 피드 통합 | 미완료 | 서버 ID를 목록·상세·좋아요까지 추적 |
| GCS·분석 연결 | 미구현, 다른 담당 영역 | 담당자와 event_id로 저장 결과 확인 |

개발 완료 후 이 표의 상태를 실제 증거로 갱신하고 브라우저 측정·요청·응답 샘플을 첨부한다. 모의 구현을 실제 수집 완료로 표현하지 않는다.

## 7. 화요일에 확정받을 계약

1. 목록 응답의 request_id·impression_id·position, 다음 페이지와 재시도 ID 규칙.
2. 실제 API 경로·인증·flat 행동 JSON·ACK 보장과 오류 코드.
3. 직접 진입·새 탭의 상세 ID, 수집 허용·삭제·다른 탭 사용자 변경 처리.
4. 최소 구간·창 포커스·절전·긴 구간 분할·최대 요청 크기 정책.
5. served/actions 저장 스키마와 측정 버전, 지연 허용·보관·삭제 기한.
6. 서버·추론·로깅·데이터 담당자가 확정할 계약의 담당자와 연결 시험 일정.

프론트엔드는 합의된 응답을 표시하고 행동을 측정·전송하는 부분을 구현한다. 서버 간 인터페이스와 저장 스키마는 검토 제안으로 전달하고 구현은 해당 담당자가 맡는다.
