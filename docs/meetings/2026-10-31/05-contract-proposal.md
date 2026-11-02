# 프론트엔드 측 이벤트와 API 제안

2026-11-02 · FE-01 논의 초안 · 팀 합의 전

우리 측 제안은 **실제로 보인 기사와 클릭·활성 체류를 기록하고, 서버가 확인한 익명 독자와 추천 목록에 연결하는 것**이다. 기존 화면과 방문자 저장을 활용한다. 아래 값은 회의 확정 사항이 아니라 팀에 가져갈 기본안이다.

## 먼저 합의하고 싶은 기본값

| 쟁점 | 우리 측 제안 | 이유와 감수할 점 |
|---|---|---|
| 독자 확인 | HttpOnly 쿠키를 서버가 검증해 reader_id 결정 | 프론트가 보낸 ID만으로 다른 독자에게 기록하지 않음 |
| 저장하지 않은 방문자 | 비개인화 피드는 제공하고 개인 행동은 전송하지 않음 | 현재 저장 시작 UI를 활용. 저장 시작 여부와 무관한 전체 서비스 지표 범위는 별도 합의 |
| 전달 목록 | 서버가 페이지별 제공 기사·추천 ID·rank 기록 | 브라우저에서 같은 전달 이벤트를 중복 생성하지 않음 |
| 실제 노출 | 활성 탭에서 카드 면적 50% 이상, 연속 1초 | 빠른 스크롤을 줄임. 짧게 본 기사는 집계에서 빠질 수 있음 |
| 노출 중복 | session_id·recommendation_id·article_id당 1회 | 뒤로 가기와 재렌더링으로 분모가 늘지 않음. 재노출 빈도 분석은 포기 |
| 클릭 | 피드 링크 활성화 시 1회. 상세 로딩 성공과 분리 | 실패한 상세 이동도 클릭 사실은 남음 |
| 체류 | 활성 시간 증가분을 10초마다 보고. 마지막 잔여분도 보고 | 읽은 시간을 보존. 총 10초 상한이나 긴 체류 제외는 적용하지 않는 제안 |
| 좋아요 | 언론사 기준. desired state를 서버에 저장 | 재시도로 상태가 뒤집히지 않음. 기사 좋아요와 구독은 별도 기능 |
| 브라우저 전송 | 최대 5초 또는 20건 중 먼저 충족 시, 이탈 때 잔여 전송 시도 | 서버의 GCS 5분 저장과 분리. 종료 시 누락 가능성은 남음 |
| 재시도 | 동일 ID·본문으로 최대 3회, 1·2·4초 지연. Retry-After 우선 | 일시 장애 대응. 실패가 남으면 관측하고 무한 보관하지 않음 |

노출의 1초, 전송의 5초·20건, 재시도 횟수는 시작점이다. 부하와 누락을 측정한 뒤 조정한다. 브라우저 종료에서 완전한 전달을 약속하지 않는다.

## 체류 10초에 대한 우리 의견

10초는 **보고 주기**로 사용하는 것을 권한다. 활성 상태에서 23초 읽었다면 10,000ms·10,000ms·3,000ms를 보내고 합계는 23,000ms다. 중간에 탭을 5초 숨겼다면 그 5초는 제외한다. 오래 읽었다는 이유만으로 전체 기록을 버리지 않는다.

이것은 회의록의 ‘10초 제한’을 해석해 확정한 내용이 아니다. 멘토가 총 상한을 의도했는지 확인해야 한다. 학습에서 이상치를 자르는 정책이 필요하면 원천 관측값과 정제 후 값을 구분해 데이터 담당이 적용하는 방향을 제안한다.

## 데이터 식별자와 이벤트 규칙

독자·기사·언론사·추천·이벤트 ID는 문자열이다. UTC ISO 8601 시각과 밀리초 정수를 사용한다. 추천 rank는 1부터 시작한다. session_id는 탭별 UUID이며 독자 변경 또는 30분 무활동 후 새로 만든다는 제안이다. 기사 상세 진입마다 article_view_id를 새로 만든다.

| event_type 제안 | 고유 필드 | 발생 시점 |
|---|---|---|
| article_exposure | article_id, recommendation_id, rank, visible_ratio, visible_ms | 노출 조건 충족 시 |
| article_click | article_id, recommendation_id, rank | 링크 활성화 시. 마우스·키보드·수정키 클릭·중간 버튼을 같은 기준으로 검증 |
| article_dwell | article_id, recommendation_id 또는 null, article_view_id, sequence, active_time_ms, is_final | 활성 체류 증가분 보고 |

공통 필드는 schema_version=1, event_id, event_type, session_id, occurred_at, source=browser다. reader_id는 서버가 수락 후 부여한다. 발생 당시 독자 문맥은 프론트 내부에 보존하고, 방문자 삭제·교체 시 기존 큐를 새 독자로 보내지 않는다. 이를 위한 서버 검증 방법은 계약 확정 전 정해야 한다. 제안은 배치에 expected_reader_id를 넣어 쿠키 독자와 다르면 전체 거절하는 것이다. 이 값은 권한 근거가 아니다.

기존 article_impression 명칭은 실제 노출을 뜻했다. 전달 목록과 혼동을 줄이기 위해 article_exposure로 바꾸는 안을 제안한다. 팀이 기존 이름을 유지한다면 의미를 동일하게 고정한다. 서버 제공 기록은 recommendation_served로 별도 관리하며 페이지 요청 재시도에 대한 중복 기준도 서버 계약에 포함한다.

좋아요 변경은 서버가 성공적으로 저장할 때 publisher_preference_changed 기록을 생성하는 안이다. 프론트가 별도로 같은 성공 이벤트를 보내지 않는다. 좋아요에는 article_id를 강제하지 않는다. 기사 출처 synthetic·collected와 행동 경로 browser·simulator는 서로 다른 필드로 유지한다.

## 제안 API 목록

기존 방문자 API를 제외한 아래 계약은 제안이며 실행 가능한 API가 아니다.

| 요청 | 역할 | 성공 응답의 핵심 |
|---|---|---|
| GET /api/v1/visitors/me | 기존 방문자 조회 | reader_id, reader_type, expires_at |
| POST /api/v1/visitors/bootstrap | 기존 저장 시작 | 기존 또는 새 방문자 |
| GET /api/v1/categories | 카테고리 | data.items의 category_id·name 목록으로 통일 제안 |
| POST /api/v1/recommendations | 새 추천 생성 | recommendation_id, strategy, fallback_reason, generated_at, feature_as_of, model_version, items, next_cursor |
| GET /api/v1/recommendations/{id}?cursor=… | 같은 추천 다음 페이지 | 고정된 추천 ID·순서와 다음 cursor |
| GET /api/v1/articles/{id} | 상세 조회 | article_id, publisher_id, 본문 텍스트와 출처 |
| POST /api/v1/events/batch | 브라우저 행동 수집 | 이벤트별 accepted·duplicate·rejected |
| GET /api/v1/me/publisher-likes | 좋아요 목록 | publisher_id 목록 |
| PUT /api/v1/me/publisher-likes/{publisher_id} | 좋아요 상태 지정 | liked, updated_at |

좋아요 요청은 `{ "liked": true }` 또는 `{ "liked": false }`다. 서버는 쿠키 독자를 사용한다. 반복 요청이 같은 상태면 추가 상태 변경 이벤트를 만들지 않는 안이다. 좋아요 성공이 추천의 즉시 반영을 뜻하지는 않는다.

추천 생성 요청은 category_id와 limit를 받는다. 실 방문자의 reader_id는 서버가 결정하고, 가상 독자용 API는 별도 권한으로 분리한다. 추천 생성의 Idempotency-Key는 기존 초안처럼 재시도 시 유지한다. 다음 페이지는 새 추천을 생성하지 않는다.

추천 items는 article·rank·reason을 포함한다. 기사에는 안정적인 publisher_id가 필요하다. 신규·이력 부족 독자는 서버가 대체 전략과 실제 이유를 반환한다. 관심사 입력이 없는 현재 MVP에서는 인기 데이터가 유효하면 인기, 없으면 최신순을 제안하되 최종 결정은 ML·백엔드와 한다. 모델 장애 시에도 화면이 서버의 대체 전략을 그대로 표시한다.

## 이벤트 요청 예시

아래는 노출 1개를 보내는 계약 예시다. ID는 설명용 값이다.

```json
{
  "expected_reader_id": "reader_example",
  "events": [{
    "schema_version": 1,
    "event_id": "253e52fc-3699-4a24-9be9-79e381b05cb0",
    "event_type": "article_exposure",
    "session_id": "59e61f7e-ed03-4f71-bd93-49c63cd5229b",
    "occurred_at": "2026-11-02T01:00:01.000Z",
    "source": "browser",
    "article_id": "article_example",
    "recommendation_id": "rec_example",
    "properties": {"rank": 1, "visible_ratio": 0.65, "visible_ms": 1000}
  }]
}
```

```json
{
  "data": {
    "results": [{
      "event_id": "253e52fc-3699-4a24-9be9-79e381b05cb0",
      "status": "accepted",
      "code": null
    }],
    "received_at": "2026-11-02T01:00:02.000Z"
  },
  "meta": {"request_id": "req_example"}
}
```

accepted는 내구성 있는 서버 저장 또는 큐 기록 이후에만 반환하는 것을 제안한다. GCS 적재·학습·추천 반영 완료를 뜻하지 않는다. 같은 event_id·같은 본문은 duplicate, 다른 본문은 rejected와 EVENT_ID_CONFLICT다. 중복 키는 최소 이벤트 수용 기간만큼 유지해야 하며 구체적인 보관 기간은 인프라·데이터 담당과 정한다.

expected_reader_id와 쿠키 독자가 다르면 409 VISITOR_CONTEXT_CHANGED로 배치를 거절한다. 미식별은 401, 잘못된 형식은 400, 제한은 429, 일시 서버 실패는 5xx로 구분한다. 이벤트별 오류는 HTTP 200의 results에 기록한다. accepted·duplicate만 큐에서 제거하고, 영구 거절은 재시도하지 않는다. 반환 오류의 표준 형식은 기존 v0.1의 error·meta 구조를 활용한다.

## 팀에 요청할 결정과 제공 자료

| 상대 | 확인할 결정 | 받아야 할 자료 |
|---|---|---|
| 데이터·멘토 | 체류 10초 의미, 노출 1초와 중복 범위, CTR 분모·라벨 관찰 기간 | 23초 체류와 전달 20개·노출 3개 사례의 기대값 |
| 뉴스 백엔드 | API 담당자, 카테고리·언론사 ID, 추천 보관과 페이지 계약, 좋아요 상태 API | 정상·빈 결과·오류 JSON 샘플 |
| 로깅·인프라 | 수신 경로, 수락 시점, 요청 크기, 보관 기간, Origin·쿠키 정책 | 이벤트 수신 주소와 저장 결과 확인 방법 |
| ML | 신규·이력 부족·장애 대체 전략, 피처 지연 표시 | 추천 순서·이유·model_version·feature_as_of 예시 |
| 전체 팀 | 수집할 브라우저 정보와 목적, 대시보드 담당, 배포 제품 | 필드 목록·담당자·합의 기록 |

브라우저 정보는 첫 연결에서는 추가 수집을 보류하고 목적별 필드를 정한 뒤 넣자는 제안이다. 후보는 언어·뷰포트·기기 분류이며, 헤더에서 얻을 항목과 중복하지 않는다. 원본 쿠키·비밀 값은 이벤트에 넣지 않는다.

## FE-01을 완료했다고 판단할 조건

이 문서는 우리 측 입장 정리까지 완료한 상태다. 팀 합의는 아직 없다. 회의 후에는 각 결정의 승인자·일자·채택값을 기록하고, API 초안을 개정한다. 다음 사항이 결정되어야 FE-01 전체를 완료로 바꾼다.

1. 체류·노출·클릭·좋아요의 의미와 예시 기대값을 합의한다.
2. 독자 확인과 방문자 교체 중 이벤트 처리 규칙을 합의한다.
3. API 요청·응답·오류와 이벤트 수락·중복 규칙을 합의한다.
4. 뉴스·로깅 API 담당자와 샘플 제공 방법을 정한다.

구현 AI는 이 문서를 제안으로 읽고 `02-ai-work-spec.md` 및 `03-backlog.json`의 미결정 항목과 함께 참조한다. 합의 전 mock을 만들 때에는 제안값을 쓴 사실을 표시한다.
