# 프론트엔드 작업 기준 · 첨부 인터페이스 규약 채택

작성일 2026-11-02 · 상태: 구현 전 작업 계획 · 프론트엔드 범위만 수행

2026-11-04 변경: 상세 체류 시간·5초 단위 상세 exposure는 제거했다. 현재 동작은 목록 노출, 기사 열기, 상세 이탈 이벤트 기준이다. 아래의 이전 검증 기록은 당시 구현을 설명하며 현재 동작의 증거가 아니다.

## 1. 우선순위와 계약 판단

기준 원본: [news_interface_contract.html](../meetings/2026-11-03/news_interface_contract.html).
발표 자료: [사람용 발표 HTML](../meetings/2026-11-03/frontend-contract-presentation.html).

사용자가 이 규약 방향을 채택했다. 필드·목록 구조는 아래대로 따른다. 사용자 명시 요구인 즉시 개별 전송이 첨부의 5초 또는 20건 배치 예시보다 우선한다. requests의 events는 배열 길이 1로 사용한다. 구체적인 URL·ACK·인증은 미합의다. 서버 구현이나 배포는 하지 않는다.

기존 behavior-collection-frontend-spec.md v0.3 및 모의 HTML은 click/action·flat JSON을 사용한 과거 구현 기준이다. 새 계약 작업은 이 문서를 우선한다. 현재 앱에 새 계약이 구현됐다고 보고하지 않는다.

검토 결과 큰 구조는 진행 가능하다. 단, 프론트 생성 reader_id는 인증이 아니며 기존 쿠키와 다르다. 전환·권한 검증·ACK·직접 진입·카테고리 계약은 연결 전 해결해야 한다. 미정값을 임의 서버 구현으로 메우지 않는다.

## 2. 데이터와 요청

### AnonymousIdentity

reader_id:string UUID. 최초 한 번 생성 후 브라우저 저장소에 보관하고 첫 조회·다음 조회에 동일 값 사용. 저장소 선택·만료·초기화와 수집 선택 정책은 미확정이므로 모의에서는 테스트 네임스페이스로 격리한다. 매 요청 새 ID 생성 금지. 기존 서버 방문자·likes를 자동 삭제하거나 새 UUID로 자동 이전하지 않는다.

목록 요청은 {reader_id:string,cursor:string|null}. 건수는 서버가 정한다. limit·category·Idempotency-Key를 추가하지 않는다. 실제 method·URL 미정. cursor는 서버 값 그대로, next_cursor=null이면 종료. 재처리한 HTTP 요청은 새 request_id일 수 있으며 기존 멱등 결과 재사용 가정을 제거한다.

### FeedResponse / ArticleItem

응답은 request_id:string, served_at:시간대 포함 ISO 문자열, items:ArticleItem[], next_cursor:string|null.

ArticleItem 필수 필드는 다음과 같다. nullable은 명시된 필드만 허용한다.

| 필드 | 형식 |
|---|---|
| article_id, impression_id, title, category | string |
| position | integer >=1, 각 응답에서 1부터 |
| subtitle, summary, subcategory, author, publisher, language | string 또는 null |
| paragraphs, tags | string[] |
| published_at | 시간대 포함 ISO 문자열 |
| is_synthetic | boolean |
| image_url, image_caption | string 또는 null |

순서는 서버 items 그대로다. 원본 id→article_id, 로컬 image_path→공개 image_url 변환은 서버 책임이다. 본문은 paragraphs 일반 텍스트로 렌더링한다. 이미지·언론사 null과 로드 오류 대체 상태를 처리한다. score·reason·strategy는 필수 응답값으로 가정하지 않는다.

### ActionEvent

공통 필수: event_id:UUID, event_type:exposure|article_open|article_close|like|unlike, event_time:시간대 포함 ISO 문자열, impression_id:string, page_type:list|detail.
exposure만 duration_ms:양의 정수, ended_at:시작 이상 ISO 문자열 필수. 다른 종류에는 두 필드를 넣지 않는다. action 필드는 사용하지 않는다. reader_id·article_id·position은 행동 본문에 중복 전송하지 않는다.

```json
{
  "events": [{
    "event_id": "b2ff0121-743e-4f15-a4e5-f577970216a3",
    "event_type": "article_open",
    "event_time": "2026-11-02T00:00:04.000Z",
    "impression_id": "imp-001",
    "page_type": "list"
  }]
}
```

impression_id는 서버 반환 건이지 실제 노출 완료 ID가 아니다. 목록·상세·좋아요에서 동일 맥락을 유지한다. 기사 ID로 대체·임의 생성하지 않는다. 모의 서버 역할의 fixture에서만 mock 식별자를 발급한다.

## 3. 측정과 전송

목록 exposure: 카드 50% 이상·document visible·스크롤 정지 구간. 1초 최소 노출 조건은 없다. 시작과 종료의 Date 시각 및 performance.now 차이를 보관한다. 종료 후 양수 duration을 확정하고 즉시 보낸다. 재등장은 같은 impression_id·새 event_id다. 상세 화면의 exposure와 체류 시간은 수집하지 않는다.

상세 화면에서 5초마다 시간을 보내던 방식은 중단했다. 목록 링크 활성화 시 article_open을 보내고, 같은 탭에서 열린 상세 화면을 떠날 때 article_close를 보낸다. 두 이벤트에 duration_ms와 reason을 넣지 않는다. 탭·창 전환, 창 최소화, 측정 해제, 방문자 변경에는 article_close를 만들지 않는다. 페이지 이탈 시 로컬 로깅 모드에서는 sendBeacon으로 종료 이벤트를 전송한다. 브라우저 강제 종료와 네트워크 장애에서는 전달이 보장되지 않으므로 article_close가 없는 기록도 허용한다.

기사 열기는 사용자 링크 활성화 순간이다. HTTP 실패와 별개다. 좋아요·해제는 상태 API와 별개 로그이며 저장 성공 시점 또는 입력 시점 정의를 서버와 맞춘다. 좋아요 때문에 article_open이 생성되지 않게 분리한다.

events:[event]를 확정 처리에서 즉시 adapter.send로 전달한다. 정상 이벤트 축적·배치 타이머 금지. 실패·미확인만 같은 ID·본문으로 재시도한다. 전송 중 같은 ID 동시 재시도를 막는다. 로그가 탐색·좋아요를 막지 않게 한다. ACK 의미가 미정이므로 HTTP 코드만 보고 영속 성공으로 가정하지 않는다.

모의 adapter는 수락·중복·충돌·장애를 재현하고 화면에 모의임을 표시한다. 실제 adapter는 계약 확정 후 추가한다. 모의 성공을 실제 HTTP·GCS 저장 증거로 쓰지 않는다. 삭제·철회·신원 변경 시 이전 타이머·재시도를 중단하며 이미 진행 중인 응답이 새 상태를 복구하지 않게 세대 번호를 검증한다.

## 4. 작업 순서

1. 기존 모의 화면의 flat JSON·click/action을 events 배열·새 enum으로 수정하고 고정 fixture를 만든다.
2. 사용자 ID adapter와 feed adapter를 모의로 구성한다. 실제 기존 방문자·likes 상태는 유지한다.
3. paragraphs·publisher·image_url·is_synthetic 표시와 cursor 다음 조회를 구현한다.
4. 본 피드 렌더·추가 카드·hashchange·likes 성공 지점에 측정 컨텍스트를 연결한다.
5. 시계·전송 의존성을 주입해 노출 구간과 재시도 검증 후 실제 브라우저에서 조작한다.
6. 실제 서버 준비 시 URL·ACK·권한·신원 전환 계약을 확정하고 실제 adapter로 연결한다.

단계마다 코드 차이·테스트 입출력을 확인한다. 서버 API·GCS FLUSH·Airflow·BQ·추론 서비스 구현은 이 작업에 포함하지 않는다.

## 5. 검증 기준

| 입력 | 관측할 결과 |
|---|---|
| 첫 조회·다음 조회 | reader_id 유지, cursor=null→서버 토큰→종료 |
| 요청 재시도·응답 경합 | 채택한 응답의 ID만 화면 사용, 서버의 새 ID 허용 |
| null 요약·언론사·이미지 | 레이아웃 유지, 안전한 대체 표시 |
| paragraphs에 HTML 문자열 | 태그 실행 없이 텍스트 표시 |
| 49%·스크롤 중 | list 측정 없음 |
| 50%·정지 3초 후 이탈 | exposure 약 3000ms, events 배열 길이 1 즉시 전달 |
| 다시 보임·상세 복귀 | 같은 impression_id, 새 구간 ID, 중복 종료 없음 |
| 상세 스크롤·hidden | 상세 스크롤 포함, hidden 제외 |
| 기사·좋아요 조작 | 새 event_type, action 없음, 저장과 로그 분리 |
| 장애·응답 유실·반복 재시도 | 동일 ID·동일 본문, 모의 저장 중복 없음 |
| 철회·사용자 변경·늦은 응답 | 이전 기록이 새 사용자 상태에 반영되지 않음 |
| 직접 진입 ID 부재 | 임의 ID 전송 금지, 지원 한계를 표시 |

실제 브라우저 동작·요청 JSON·모의 수락 결과를 남긴다. 실제 연결 후에만 서버 요청·응답과 저장 추적 결과를 추가한다. 개발 완료 문서에는 구현·모의 검증·미완료를 나눠 적는다.

## 6. 연결 전 합의 목록

- 기존 HttpOnly 쿠키와 프론트 UUID의 전환·매핑, 기존 좋아요 보존 여부.
- reader_id 조작·타인 impression_id 접근 차단 수단. 익명 ID만으로 기록 조회·삭제 권한을 주지 않음.
- 실제 URL·method·CORS/쿠키·오류·ACK와 영속 수락 보장.
- category 요청·직접 상세·새 탭의 문맥 ID 발급·복구.
- 긴 구간 분할·좋아요 기록 시점·시간 오차·최대 길이·수집 허용·보관·삭제.

큰 계약 방향 채택은 위 미정 항목의 임의 확정을 의미하지 않는다. 미정 서버 의존 기능은 모의로 진행하고 실제 연결 시 차이를 검증한다.

## 1단계 진행 기록 · 2026-11-02

독립 모의 화면과 mock-api.js를 새 계약으로 변경했다. 목록은 reader_id/cursor를 받고 3건씩 완전한 기사 필드와 서버 역할의 request_id/impression_id를 반환한다. 다음 페이지·종료·다른 사용자의 cursor 거절을 지원한다. 모의 UUID는 페이지 메모리에서만 유지하며 기존 사용자 저장소를 건드리지 않는다. 행동은 events 배열과 새 event_type을 사용한다. 모의 ACK results는 실제 서버 계약 확정 전의 테스트용 형식이다.

검증: node --test tests/mock-contract.test.js 2개 통과. 공유 모의 API와 HTML 스크립트 문법 검사 통과. 브라우저 자동 검증은 file URL 보안 정책으로 열기가 거절되어 수행하지 못했다. 실제 화면 조작 검증은 남아 있다. 이번 변경은 본 피드·실제 HTTP·클라우드 연결을 포함하지 않는다. 긴 노출 구간 분할도 아직 도입하지 않았다.

재현: behavior-collection-mock.html을 브라우저에서 직접 열고 첫 응답 JSON → 다음 기사 묶음 → next_cursor null을 확인한다. 측정 시작 후 기사 열기·좋아요를 조작하면 하단에 events 요청과 모의 ACK가 표시된다. 장애 체크 후 이벤트를 생성하고 장애를 해제하면 동일 ID 재시도를 확인할 수 있다. mock-api.js를 HTML 옆에 함께 둔다.

## 2단계 진행 기록 · 2026-11-02

?feed=mock 모드를 본 피드 UI에 연결했다. 별도 어댑터로 새 계약 기사 필드·request_id·impression_id를 내부 표시 구조로 매핑하며 채택한 기사만 상세 캐시에 등록한다. cursor로 3개씩 두 페이지를 조회한다. 모의 모드의 좋아요는 메모리만 사용하고 visitor 모듈을 초기화하지 않는다. 미정 카테고리는 전체만 표시한다.

문법·빌드·계약 테스트·어댑터 테스트 통과. HTTP 브라우저에서 6개 기사 추가 표시·종료·두 번째 묶음 상세 문단·언론사·이미지 대체 표시·목록 복귀를 확인했다. 직접 상세 새로고침의 문맥 복구·실제 이미지 성공/실패·픽셀 단위 스크롤 위치 검증은 남아 있다. 행동 측정 통합·실제 백엔드 연결은 다음 단계다.

## 3단계 진행 기록 · 2026-11-02

모의 본 피드에 노출·상세 체류·기사 열기·좋아요·해제를 연결했다. 상단의 모의 측정 체크박스로 켜고 끈다. 가시성 observer는 더 보기와 분리했으며 구간 모델은 exposure-segments.js, DOM 연결은 feed-tracking.js, 수락 호출은 contract-feed.js의 sendContractEvents 경계로 분리했다. 새 API 연결 시 해당 경계와 ACK·인증 계약을 교체한다.

브라우저에서 list/detail exposure, article_open, detail like와 동일 impression_id·단건 events·accepted를 확인했다. 순수 시계 테스트로 구간 중복 종료·새 구간 ID·목록/상세 길이·중단 폐기를 검증했다. 측정 기준 변경과 API 필드 변경은 여전히 코드 수정이 필요하다.

이 단계는 전송 성공 경로다. 실패는 화면에 남기며 자동 재시도·지연 ACK 세대 처리·종료 전달 보장·구간 5초 분할·실제 백엔드 연결은 아직 구현하지 않았다. 장애·상태 변경 처리는 4단계에서 보강한다. 본 모드는 메모리의 모의 저장만 사용한다.

## 4단계 진행 기록 · 2026-11-02

단건 즉시 전송을 event-transport.js로 이동했다. 실패·응답 미확인만 같은 ID·고정 본문으로 재시도한다. 지수 간격과 jitter, 10초 timeout, 30분 보관 수명, 500건·512KiB 제한을 두었다. 값은 모의 기본안이다. ACK ID 일치·accepted/duplicate를 확인하며 rejected는 제거한다. timeout 후 원 요청이 늦게 끝날 수 있으므로 서버 중복 제거는 계속 필요하다.

측정 해제·방문자 변경/삭제 알림은 열린 구간을 폐기하고 재시도를 중단한다. 세대 번호로 중단 전 응답이 재시작한 큐를 변경하지 못하게 했다. 이미 서버에 수락된 기록의 삭제는 별도 서버 계약이며 클라이언트 stop으로 되돌리지 않는다. pagehide는 마지막 모의 시도 후 재시도 타이머를 정리하고 pageshow에서 재개한다. 실제 종료 전달은 미보장이다.

패널에 전송 장애·응답 3초 지연·다음 응답 유실·수동 재시도를 추가했다. 응답 유실은 모의 저장 후 오류를 발생시켜 중복 수락을 재현한다. 자동 테스트로 응답 유실·중복·충돌 분리 계약, 동시 요청 방지, 중단 후 늦은 ACK, timeout, 만료·한도·영구 거절을 확인했다. 브라우저에서 장애 시 pending>0, 복구 후 accepted·pending=0을 확인했다.

실제 HTTP 상태코드·Retry-After·인증 오류 정책과 다른 탭 신원 변경의 실제 서버 검증은 서버 계약 확정 후 연결한다. 현재 모의 reader_id는 탭 메모리여서 실제 신원 전환·클라우드 삭제 검증이 완료된 것은 아니다. 실제 서버가 아직 없어 5단계 연동은 대기한다.

## 독자 유지 적용 · 2026-11-03

reader-identity.js로 UUID를 localStorage에 보관하고 새로고침·재접속에서 재사용하도록 변경했습니다. 저장 차단·손상은 새 임시 독자를 만들지 않고 안내합니다. 로깅 시연은 기존 SQLite 방문자 저장소·30일 HttpOnly 쿠키를 이용해 서버 재시작 뒤에도 독자를 복구합니다. 실제 뉴스 백엔드·기본 좋아요 독자와의 통합은 아직 별도입니다. 37개 자동 테스트·문법 검사·빌드가 통과했습니다. 이번 변경에서 실제 브라우저 재시작 UI 시험은 수행하지 않았습니다.

## 연속 순위·구간 분할·유효 노출 적용 · 2026-11-03

position은 cursor offset 기준 연속 순위로 변경했다. 상세 구간은 시작 UTC와 단조 시계 경과로 5초마다 나누고 이탈 시 잔여를 전달한다. 타이머 지연·정확한 경계·clear·재시작 시 중복을 자동 테스트로 확인했다. 목록 짧은 원본은 보존하고 별도 로컬 JSONL 분석 명령으로 연속 1초 기준을 분류한다. 44개 자동 테스트·문법 검사·빌드 통과. 실제 브라우저·GCS·BigQuery 자동 연결 검증은 이번 변경에 포함하지 않았다.
