# 뉴스 행동 수집 · 프론트엔드 통합 명세

작성일: 2026-11-02 · 버전 0.3 · 미구현, 백엔드 협의용

## 1. 근거와 적용 범위

[백엔드 논의 자료](../meetings/2026-10-31/news_recommendation_discussion.html)의 2절 저장 구조, 3절 행동 계약, 4절 ID, 5.2절 학습 연결을 기준으로 기존 0.2 초안을 교체한다. [팀 회의용 설명](behavior-collection-overview.md)은 같은 내용을 쉽게 설명한다. 백엔드 자료 자체도 설계·예시이며 배포 계약은 아니다.

이 문서의 구분은 다음과 같다.

- 반영: 백엔드 자료의 ID·이벤트 형식·구간 측정 규칙과 사용자의 즉시 개별 전송 요구.
- 보완 제안: 재시도·소유권 검증·수집 선택·종료 처리 등 실제 구현에 필요한 규칙.
- 미합의: URL, ACK, 신원 교체 방어 수단, 상세 직접 진입, 수치 정책. 확정 전에 상호 동작을 보장한다고 주장하지 않는다.

앱 코드 기준은 현재 로컬 작업 트리다. vanilla JS, Node 서버, 가상 기사, 방문자 쿠키와 좋아요 규칙 피드가 있다. 수집 API·GCS·Airflow·CTR 학습은 미구현이다. 초기 관심사와 실시간 피처 반영은 이번 범위에 없다.

## 2. 이전 명세에서 교체한 내용

| 이전 0.2 | 통합 0.3 |
|---|---|
| recommendation_id 중심, session_id·feed_view_id 전송 | 서버 request_id와 기사별 impression_id, 행동에는 impression_id 전달 |
| article_impression / article_click / article_dwell | exposure / click + page_type + action |
| occurred_at | event_time, 구간 이벤트에는 ended_at 추가 |
| 노출 50%·1초에 1회 확정 | 50%·활성 탭·스크롤 정지 구간 종료 시 duration_ms 확정 |
| 한 피드에서 반복 노출 억제 | 반복 구간은 새 event_id, 같은 impression_id 유지 |
| 상세 10초 보고·sequence·is_final | 상세 노출 구간 보고. 정기 보고·sequence·is_final은 현재 최소 계약에서 제외 |
| like는 행동 로그 대상 아님 | click의 like / unlike로 수집 |
| event envelope와 복수 보조 ID | 백엔드 최소 flat JSON으로 변경, 안전장치 확장은 별도 협의 |
| 클라우드 ACK는 GCS 업로드 완료로 고정 | 영속 보관 ACK 권장. 버퍼 수락과 GCS 완료를 구분하고 실제 ACK는 합의 필요 |

기존 1초 임계값·10초 보고를 함께 적용하면 백엔드 원본 구간 정의와 달라진다. 필요하면 측정 정책 버전을 합의해 다시 도입한다. 이전 문서의 해당 규칙을 구현 근거로 사용하지 않는다.

## 3. 식별자와 피드 응답

| ID | 생성 주체 | 수명·용도 |
|---|---|---|
| article_id | 기사 저장 서버 | 기사 자체 |
| request_id | 웹 백엔드 | 논리적인 목록 조회 요청 |
| impression_id | 웹 백엔드 | 최종 반환 목록의 기사별 추천 건, 실제 노출 여부와 무관 |
| event_id | 프론트 | 행동 또는 측정 구간 한 건, 재시도 시 유지 |
| user_id | 서버 | served 로그의 주체. 기존 reader_id와 매핑은 서버가 담당 |

웹 백엔드가 최종 필터·중복 제거·순서 확정 후 impression_id를 발급하고 served 로그를 보존한다. 추천 API의 후보 결과만으로 발급하지 않는다. 최소 응답 예시는 다음과 같다. 실제 기사 표시 필드는 생략했다.

```json
{
  "request_id": "req-001",
  "items": [
    {"article_id": "a3", "impression_id": "imp-001", "position": 1}
  ]
}
```

현재 `/api/v1/feed`에는 이 ID들이 없으므로 백엔드 연결이 선행되어야 한다. `src/service.js`에서 실제 응답을 한 번 파싱하고 카드 컨텍스트로 만든다. 같은 ID를 DOM의 data 속성과 상세 라우트 상태에 보관한다. 프론트가 impression_id를 임의 발급하거나 기사 ID로 대체하지 않는다.

동일 논리 요청의 재시도는 같은 ID를 받도록 서버의 요청 멱등성 계약이 필요하다. 다음 페이지의 실제 서버 조회는 새 request_id이고 새 추천 건에는 새 impression_id를 받는다. 현재 로컬 snapshot을 3개씩 표시하는 loadMore는 서버 요청이 아니므로 원래 ID를 그대로 사용한다. 재렌더링·뒤로 가기·스크롤 재등장은 새 추천 건이 아니다. 명시적 재조회는 새 요청이다.

현재 카테고리 필터는 클라이언트에서 적용된다. 서버 position이 실제 표시 순서를 뜻하도록 통합 시 카테고리를 서버 요청에 포함하는 안을 권장한다. 클라이언트 필터를 유지하려면 display_position·filter 메타데이터 확장을 먼저 합의한다. 최소 행동 JSON에 몰래 필드를 추가하지 않는다. position이 페이지 내부 순위인지 전체 피드 순위인지도 API 계약에 명시한다.

## 4. 행동 JSON

백엔드 3.1절의 최소 형식을 따른다. 아래는 각각 독립 POST 본문이다. UUID 등 불투명 문자열을 사용하며 예시 ID는 설명용이다.

```json
{
  "event_id": "e001",
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
  "event_id": "e002",
  "event_type": "click",
  "event_time": "2026-11-02T00:00:04.000Z",
  "impression_id": "imp-001",
  "page_type": "list",
  "action": "article_open"
}
```

| 조합 | 의미·추가 필드 |
|---|---|
| exposure + list | 목록의 유효 노출 구간, duration_ms와 ended_at 필수 |
| exposure + detail | 상세 활성 구간, duration_ms와 ended_at 필수 |
| click + list + article_open | 목록에서 기사 열기, 시간 길이 없음 |
| click + list/detail + like/unlike | 해당 화면의 좋아요 상태 변경, 시간 길이 없음 |

공통 필드는 event_id, event_type, event_time, impression_id, page_type이다. exposure에는 action을 넣지 않고 click에는 duration_ms·ended_at을 넣지 않는다. event_time은 클릭 발생 시각 또는 구간 시작 시각이다. 브라우저는 UTC ISO 8601로 보내고 서버가 필요하면 KST 저장 경로로 변환한다. duration_ms는 단조 시계 차이의 양의 정수 밀리초다.

user_id, article_id, request_id, position, 기사 분류·언론사, 집계 피처는 행동 본문에 중복 전송하지 않는다. 서버가 impression_id의 served 기록으로 연결한다. 서버 수신 시각 received_at은 별도 보존을 제안한다. source=browser와 content_origin=synthetic도 서버·테스트 데이터 구분 메타데이터로 관리하며 클라이언트 임의 값은 신뢰하지 않는다. 스키마·측정 버전은 저장 메타데이터에 남기는 안을 협의한다.

## 5. 측정 수명과 이벤트 생성

### 목록 구간

측정 대상은 현재 기사 링크 `.card[data-article]`이고 좋아요 버튼은 제외한다. 별도 IntersectionObserver를 사용한다. 기존 더 보기 observer의 240px rootMargin은 사전 로딩용이므로 재사용하지 않는다.

시작 조건은 교차 비율 0.5 이상, document가 visible, 스크롤 정지, 유효한 impression_id, 수집 허용이다. 백엔드 예제는 document.hidden을 사용한다. 창 blur까지 제외하는 기존 초안의 포커스 조건은 같은 기준으로 합의하기 전 추가하지 않는다.

첫 scroll, 비율 0.5 미만, hidden, 카드 제거, 라우트 이탈에서 구간을 한 번 종료하고 duration_ms가 양수면 즉시 보낸다. 종료는 타이머 Map에서 먼저 제거한 뒤 전송하여 여러 종료 이벤트의 중복을 막는다. 다시 시작하면 새 구간·새 event_id를 사용한다. 재전송만 기존 ID를 유지한다.

scrollend를 지원하면 종료 감지에 사용하고 미지원이면 마지막 scroll 후 300ms debounce를 사용하는 백엔드 예시를 따른다. 300ms는 잠정값이며 정지 직후 측정 지연이 생긴다. 가시성을 다시 확인하고 측정을 재개한다. 전용 스크롤 컨테이너 도입 시 observer root와 scroll 이벤트 대상을 함께 바꾼다.

무한 스크롤 추가 카드도 관찰한다. `render()`의 main.innerHTML 교체 전 열린 구간을 마감하고 observer를 해제한다. 교체 후 같은 impression_id로 관찰을 재개한다. 이 때문에 분리된 구간은 정상 기록이며 중복 노출 횟수로 해석하지 않는다. 한 화면의 여러 카드가 조건을 충족하면 각각 측정한다.

### 상세 구간

같은 탭에서 기사 링크를 열면 카드의 impression_id를 상세 라우트 컨텍스트로 전달한다. 유효 상세가 렌더되고 visible이면 시작한다. 상세 스크롤은 종료 사유가 아니다. hidden·상세 이탈·다른 기사 이동·pagehide에서 종료하고, visible 복귀 시 새 구간을 시작한다.

같은 기사의 단순 재렌더링은 타이머를 중복 생성하지 않는다. 목록의 스크롤 복원은 목록 상태에만 적용한다. 시각 차이는 performance.now로 계산하고 시각 필드는 Date로 기록한다. 시스템 시계 조정·절전·콜백 지연으로 불일치가 생길 수 있어 서버가 ended_at, event_time, duration_ms를 대조하고 이상값을 격리한다. 허용 오차·최대 길이는 합의 전이며 실제 읽기 시간을 보장하지 않는다.

10초 중간 보고는 통합안에 없다. 따라서 화면을 오래 유지한 채 프로세스가 종료되면 열린 구간 전체가 유실될 수 있다. 중간 구간 분할을 도입하려면 겹치지 않는 시간 구간과 종료 시 잔여 구간 규칙을 먼저 합의한다.

### 기사 열기와 좋아요

기사 열기는 `a[data-article]`의 click과 가운데 버튼 auxclick에서 기록한다. Enter·Ctrl/Meta 클릭을 포함하고 같은 입력의 중복 생성을 막는다. 우클릭 메뉴를 통한 새 탭 열기는 안정적으로 관측할 수 없어 미지원 범위로 둔다. 전송을 기다리지 않고 기사로 이동한다. 클릭 직전 열린 목록 구간을 마감하며 click과 exposure의 서버 도착 순서를 가정하지 않는다.

좋아요는 기존 저장 API 성공 후 실제로 확인된 상태 전환마다 like 또는 unlike를 한 번 생성하는 보완안을 제안한다. 실패한 저장·중복 버튼 입력·초기 좋아요 조회는 행동으로 기록하지 않는다. event_time은 성공 확인 시각으로 정의하고 백엔드와 확정한다. 좋아요 API 재시도와 행동 로그 재시도는 서로 다른 작업이다. 로그 실패 때문에 좋아요 상태를 다시 토글하지 않는다. 같은 요청을 서버에서도 로깅한다면 이중 생성하지 않도록 생성 주체를 하나로 정한다.

### 직접 진입·새로고침·새 탭

현재 해시 URL에는 기사 ID만 있어 해당 상황에서 impression_id가 없을 수 있다. 없는 ID를 임의 생성하거나 아무 과거 ID를 붙이지 않는다. 현재 최소 계약은 impression_id 필수이므로 맥락을 확인할 수 없는 상세 행동은 전송하지 않고 로컬 진단으로 구분한다. 기사 읽기·좋아요 저장 자체는 계속 가능하다.

권장 후속 계약은 서버가 직접 진입용 상세 컨텍스트를 발급하고 entry_source를 구분하는 것이다. 신규 served 기록을 만든다면 추천 목록 노출과 섞지 않아야 한다. 같은 탭 history state로 컨텍스트를 복원할 경우에도 서버 소유권·유효성을 확인한다. 새 탭 전달 방식·null 허용 여부는 아직 미합의다.

## 6. 즉시 전송·실패 처리·수집 상태

백엔드 예시는 POST /events이고 기존 프론트 초안은 POST /api/v1/events다. 같은 출처의 브라우저 경로 `/api/v1/events`에서 웹 백엔드 또는 라우팅 계층을 거쳐 로깅 서버 `/events`로 전달하는 구성을 제안한다. 실제 경로와 인증은 확정해야 한다. 프론트에서 GCS·Airflow·Valkey로 직접 접속하지 않는다.

이벤트 확정 처리에서 flat JSON 한 건의 fetch를 즉시 시작한다. 정상 이벤트를 시간·개수 조건으로 기다리지 않는다. 기존 서버의 Origin 검사·JSON 검증은 유지한다. 실패·미확인 요청만 메모리에 보관하고 동일 event_id·동일 본문으로 개별 재시도한다. 기사 이동과 좋아요는 로그 응답을 기다리지 않는다.

잠정 운영값은 요청 4KiB, timeout 10초, 재시도 1·2·4·8·16·30초 상한과 jitter, 메모리 보관 500건 또는 512KiB 및 30분이다. 이는 백엔드 합의값이 아니다. 429는 Retry-After를 존중한다. 5xx·응답 유실은 재시도하고 영구 형식 오류·413은 폐기·진단한다. 새로고침 시 미확인 기록이 사라질 수 있다.

hidden·pagehide에서 종료된 구간은 동일 단건 형식의 JSON Blob으로 sendBeacon 전송을 시도한다. true를 서버 저장 성공으로 간주하지 않는다. 복귀하면 미확인 ID를 fetch로 재확인한다. 여러 카드가 함께 종료되면 각각 단건 요청이며 공유 전송 한도로 일부 실패할 수 있다. 영속 브라우저 저장이 없는 초기안은 종료 시 전달을 보장하지 않는다.

기존 좋아요 저장 허용을 행동 수집 허용으로 자동 승격하지 않는 제안을 유지한다. 수집 disabled 상태에서는 구간·전송 기록을 만들지 않는다. 허용 전에 보았던 구간을 소급 전송하지 않는다. 기존 “클릭·읽기 시간은 수집하지 않는다” 안내는 기능 도입과 함께 실제 상태에 맞춰 변경한다.

서버는 쿠키의 사용자와 impression_id 소유자가 같은지 검증해야 한다. ID를 알고 있다는 사실만으로 권한이 생기지 않는다. 서버가 이를 온라인으로 검증하려면 짧은 수명의 인덱스 또는 서명된 컨텍스트 등 구현 수단을 정해야 한다. GCS 사후 결합만으로 요청 시점의 소유권 검증을 대신하지 않는다.

삭제·수집 철회 시작 시 열린 구간을 전송하지 않고 폐기하며 관찰·재시도를 중단한다. 다른 탭에 알리고 복귀 시 상태를 재조회한다. 이미 전송된 요청과 서버 삭제가 경쟁할 수 있어 서버 직렬화·삭제 후 재수락 방지가 필요하다. 같은 방문자의 철회 후 재허용까지 막으려면 collection epoch 또는 동등한 서버 정책이 필요하다. 이는 최소 JSON에 없는 확장으로 협의하며, Beacon에서 임의 헤더를 설정할 수 없다는 점까지 고려해 수단을 선택한다.

## 7. API 성공 응답과 서버 FLUSH

백엔드 자료에는 구체적인 HTTP ACK 계약이 없다. 예제는 메모리 버퍼 실습을 허용하면서 운영에서는 영속 큐를 고려한다고 설명한다. 다음을 구분한다.

| 응답 의미 | 프론트 처리·한계 |
|---|---|
| 영속 저장 또는 영속 큐 수락 | ACK 확인 후 미확인 기록 제거 가능, GCS FLUSH는 이후 진행 가능 |
| 메모리 버퍼 수락만 완료 | 서버 재시작 유실 가능. 영속 성공과 구분한 실습 모드·지표 필요 |
| GCS 업로드까지 기다림 | FLUSH 대기로 응답이 늦어지면 브라우저 timeout·중복 재시도 가능 |

권장안은 영속 보관 확인 후 ACK하고 GCS 파일 쓰기는 분리하는 것이다. 영속 큐 제품은 이 문서에서 확정하지 않는다. 초기 메모리 실습을 선택하면 유실 허용 범위와 응답 의미를 명시해야 하며, “안전하게 저장 완료”라고 보고하지 않는다. HTTP 200 또는 202 자체만으로 저장 보장을 추론하지 않는다.

응답에는 요청 event_id와 accepted/duplicate/rejected/retryable에 해당하는 결과를 제공하는 안을 제안한다. 정확한 형식·상태코드가 합의되기 전에는 코드로 고정하지 않는다. 동일 ID·다른 본문은 충돌로 분리하고 새 ID로 바꾸어 재전송하지 않는다. 임시 보관과 분석의 중복 제거 책임도 명시한다.

로깅 서버는 event_time을 시간대와 함께 해석해 5분 경로를 계산한다. 백엔드 예시는 KST로 변환한다. GCS의 경로 구분이지 BigQuery의 5분 네이티브 파티션을 의미하지 않는다. FLUSH 예시 1,000건 또는 30초와 가공 예시 1시간은 독립값이다. 파일마다 새 객체명을 사용하며 기존 GCS 객체에 한 줄씩 덧붙이지 않는다.

늦게 도착한 구간은 시작 시각에 해당하는 과거 경로에 추가될 수 있다. 09:04~09:06 구간은 event_time 기준 minute=00 경로에 들어간다. 시간대별 체류 집계가 필요하면 구간을 데이터 처리에서 시간 경계로 분배하고, 파일 경로만으로 전체 시간을 귀속하지 않는다.

## 8. Airflow·분석과의 연결

served와 actions를 별도 원본으로 보존한다. Airflow는 파일 준비 확인과 적재·검증·결합 작업을 조율한다. GCS 존재 센서는 파일 존재 조건을 확인하며 데이터 품질 전체를 보장하지 않는다. [공식 GCS 센서 문서](https://airflow.apache.org/docs/apache-airflow-providers-google/stable/_api/airflow/providers/google/cloud/sensors/gcs/index.html)

통합안의 후속 검증은 필수 필드, 값 범위, 구간 시각, event_id 중복·충돌, impression_id 연결 누락, 사용자 소유권, served/actions 누락을 구분한다. 파일 하나의 도착을 구간 전체 완료로 해석하지 않는다. 이벤트 0건인 정상 구간, 업로드 장애, 지연 도착을 구분할 manifest·완료 표시·건수 정책과 timeout·알림 담당자를 정해야 한다.

서버 반환 기록이 먼저 저장된다는 보장은 없다. 연결되지 않은 action은 지연 served와 재결합할 수 있게 보류·재처리한다. 객체명·generation·처리 이력을 관리하고 동일 원본을 재처리해도 clean 결과가 늘어나지 않게 한다. 원본 본문이 같은 event_id만 중복 제거하고 서로 다른 실제 구간을 제거하지 않는다.

학습 단위는 목록 노출이 확인된 impression_id당 한 행이다. 여러 list 구간을 합치되 detail과 분리한다. clicked=1은 관찰 기간 내 click/action=article_open만 사용하고 like/unlike는 제외한다. 클릭만 있고 list exposure가 없으면 노출 미확인으로 별도 점검한다. 미노출을 clicked=0으로 만들지 않는다.

백엔드의 첫 목록 노출 후 30분은 라벨 예시다. 이전 초안의 지연 허용 24시간·미래 시각 5분·원본 참조 48시간도 확정값에서 제외하고 협의 목록으로 옮긴다. 열린 노출 구간·지연 로그가 도착하기 전에 음성 라벨을 확정하지 않도록 여유와 재처리를 정한다.

추천 입력 피처는 당시 이용 가능했던 이력으로 생성한다. 모델·Valkey의 피처 갱신과 프론트 전송은 별개다. 기사 수정 이력, 피처 available_at, 사용한 모델·피처 버전은 서버·데이터 담당자가 기록하며 브라우저 최소 JSON의 필수값으로 추가하지 않는다. 가상 기사·시험 행동과 운영 데이터를 구분한다. 삭제 정책은 GCS·BigQuery·파생 피처까지 담당자가 정하고 재처리로 삭제 데이터가 복원되지 않게 한다.

## 9. 현재 코드의 변경 계획

| 파일 | 작업 |
|---|---|
| src/service.js | 서버 request_id·items[].impression_id·position 파싱, 기존 기사 구조와 매핑 |
| src/app.js | 카드·상세 컨텍스트 유지, 렌더 전 구간 종료, 추가 카드 등록, hashchange 수명 관리 |
| 새 src/tracking.js | 목록·상세 구간 상태와 가시성·스크롤 시작/종료 관리 |
| 새 src/event-transport.js | 단건 즉시 전송, ACK·실패 재시도, 종료 전송 |
| src/likes.js | 저장 성공한 상태 전환을 해당 impression_id의 like/unlike로 연결 |
| src/visitor.js | 수집 선택, 초기 상태 조회, 철회·삭제 시작 알림과 탭 간 상태 갱신 |
| server/feed.mjs·server/http.mjs | 로컬 연결 시험에 필요한 ID·served 기록·수집 경로. 실제 서비스 책임은 백엔드와 협의 |
| tests/ | 구간 시간·전송·신원 변경·서버 연결 테스트 |

현재 visitor 초기 이벤트는 app 리스너 등록 전에 발생할 수 있어 초기 상태 조회와 변경 구독을 함께 둔다. 팀 시연 오류·빈 결과 모드와 자동 테스트는 운영 수집에서 제외한다. 기존 card의 map index는 추가 페이지마다 초기화되므로 실제 표시 순위로 사용하지 않는다.

## 10. 검증과 구현 시작 조건

| 입력·상황 | 기대 결과 |
|---|---|
| 피드 응답의 기사별 ID | 카드·상세·로그가 같은 impression_id 유지 |
| 49% 가시성, 스크롤 중 | 목록 구간 없음 |
| 정지·50% 이상 500ms 후 이탈 | 약 500ms list exposure 1건. 기존 1초 필터 없음 |
| 3초 정지 → 스크롤 → 2초 정지 | 같은 impression_id, 서로 다른 event_id 2건, 시간 합계 약 5초 |
| 상세 스크롤·hidden·복귀 | 상세 스크롤은 측정, hidden 제외, 복귀는 새 구간 |
| DOM 교체·뒤로 가기·무한 스크롤 | 열린 구간 이중 종료 없음, 추가 카드도 측정 |
| 기사 열기·Enter·가운데 클릭 | 입력당 article_open 1건, 로그 응답이 이동을 막지 않음 |
| 좋아요 성공·실패·재시도 | 성공한 상태 변경만 like/unlike, article_open 추가 없음 |
| 이벤트 여러 건 동시 확정 | 각각 즉시 단건 JSON 요청, 배치 타이머 없음 |
| 같은 ID 재전송·다른 본문 충돌 | 중복 증가 없음, 충돌은 분리 |
| 직접 진입으로 ID 없음 | 임의 ID 전송 없음, 탐색·좋아요 기능 유지 |
| 타인의 impression_id·삭제 후 늦은 전송 | 서버 거절, 새 방문자에 재귀속 없음 |
| UTC 00:04~00:06 구간 | KST 09:00 경로, 시작·종료 시각과 길이 보존 |
| 서버 재시작 직전 ACK | 합의한 영속 보장 또는 실습 유실 한계를 실제 확인 |
| 파일 도착·빈 구간·지연 served | 센서 통과와 품질 판정 분리, 재결합·재처리 가능 |
| 같은 원본 재적재 | impression_id별 학습 행·CTR·체류 합계 불변 |

구현 전 필수 합의는 실제 URL·JSON·ACK, 피드의 ID 제공, 사용자 검증 수단, 수집 허용 상태다. 상세 직접 진입·새 탭, 표시 순위, 좋아요 성공 시각, 긴 구간·절전 처리, 저장·삭제·지연 기간은 누락 범위를 명시한 뒤 확정한다.

측정 테스트는 주입 시계로 경계값을 검증하고 실제 브라우저에서 스크롤·탭 전환·라우트·종료를 확인한다. 기존 npm run check, npm test, npm run build도 구현 시 실행한다. 현재는 문서의 JSON·내부 링크만 검사했으며 행동 수집 동작을 검증한 상태가 아니다.

## 11. 참고

- [백엔드 논의 원본](../meetings/2026-10-31/news_recommendation_discussion.html): 원본은 수정하지 않음.
- [Airflow GCS 센서](https://airflow.apache.org/docs/apache-airflow-providers-google/stable/_api/airflow/providers/google/cloud/sensors/gcs/index.html): 준비 조건 확인의 범위.
- [MDN sendBeacon](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/sendBeacon): 전송 접수와 저장 확인의 차이.
- [MDN performance.now](https://developer.mozilla.org/en-US/docs/Web/API/Performance/now): 구간 길이 측정용 시계.
