# GCP 사용자 행동 수집 인프라 검토

2026년 10월 29일 공식 문서 조사 기준. 팀 회의용 제안이며 GCP 리소스 생성·배포·과금 설정은 수행하지 않았다. 초기 관심사 선택·저장은 범위에서 제외한다.

## 현재 권장 방향

실시간 추천 반영은 초기 목표가 아니라는 사용자 설명을 반영해 Cloud Run 수집 API → Cloud Storage 원본 → BigQuery 배치 적재를 우선 추천한다. 방문자 식별 정보는 별도 영속 DB에 둔다. 아래 DB 우선·Pub/Sub 구성은 비교 이력과 대안이며 현재 권장안은 청사진 v0.6을 우선한다. 아직 배포·비용·처리량을 검증하지 않았다.

## 후속 검토와 Pub/Sub 없는 선택지

Pub/Sub는 필수가 아니다. 아래 기존 구성은 비동기 분리를 위한 선택안이며 확정 구조가 아니다. 실시간 분석 요구와 트래픽이 아직 정해지지 않은 현재 단계에서는 수집 API → 영속 DB 저장을 먼저 검토하고, 필요할 때 BigQuery 배치 적재를 추가하는 작은 구성을 우선 제안한다.

| 대안 | 흐름 | 적합한 경우 | 직접 관리할 부분 |
|---|---|---|---|
| DB 우선 저장 | 브라우저 → Cloud Run → Firestore 또는 Cloud SQL → 주기적 BigQuery 적재 | 소규모 시작·이벤트 수신 확인·분석 지연 허용 | event_id 중복 검사·배치 체크포인트·재처리 |
| BigQuery 직접 기록 | 브라우저 → Cloud Run → BigQuery Storage Write API | 빠른 분석 가용성이 필요하고 서비스 수를 줄이고 싶을 때 | 적재 실패 시 응답·재시도·중복 제거·일시 장애 대응 |
| 파일 기반 배치 | 브라우저 → Cloud Run → Cloud Storage → BigQuery load job | 즉시 분석이 필요 없고 파일 재처리가 중요할 때 | 작은 파일 통합·배치 실행·중복 방지·완료 확인 |

DB 방식은 서버가 저장 완료를 확인한 후 수락한다. event_id를 키로 사용하고 동일 ID·동일 본문은 중복 수락, 동일 ID·다른 본문은 충돌로 거절한다. BigQuery로 옮길 때도 event_id를 유지하고 재실행에 안전한 체크포인트와 병합을 설계한다. Firestore 저장이 BigQuery로 자동 전송되는 것은 아니며 별도 배치 코드나 검증한 연동이 필요하다. Cloud SQL은 팀이 이미 관계형 DB를 선택했다면 우선 검토한다.

BigQuery 직접 기록은 Storage Write API를 이용할 수 있다. 기본 스트림은 at-least-once이므로 중복 제거를 설계한다. 스트림 offset 기반 exactly-once는 그 스트림 안의 보장이며 브라우저 재전송 전체의 중복 문제를 자동 해결하지 않는다. 저장 응답 전에 실패하면 재시도 가능한 오류를 반환한다. Cloud Run 메모리에만 쌓아두고 성공 응답을 보내는 방식은 피한다.

Cloud Storage 배치는 서버가 파일 업로드 성공을 확인한 뒤 수락하고, 고정된 객체 이름·작업 ID로 재시도를 관리한다. 요청마다 로그 파일을 계속 덧붙이는 방식 대신 변경하지 않는 객체로 저장한다. 적은 이벤트마다 load job을 실행하지 않고 모아서 적재하되, Cloud Run 로컬 디스크를 영속 대기열로 쓰지 않는다. 집계 결과의 가용 시점은 배치 주기에 좌우된다.

- [Storage Write API 스트리밍](https://docs.cloud.google.com/bigquery/docs/write-api-streaming)
- [BigQuery 배치 적재](https://docs.cloud.google.com/bigquery/docs/batch-loading-data)
- [로드 작업 최적화](https://docs.cloud.google.com/bigquery/docs/optimize-load-jobs)
- [Firestore 트랜잭션과 배치 쓰기](https://firebase.google.com/docs/firestore/manage-data/transactions)

## 제안하는 구성

사용자 행동을 받는 HTTP API를 Cloud Run에 배포하고, 검증된 이벤트를 Pub/Sub에 발행한 뒤 BigQuery 구독으로 원본 테이블에 적재하는 구성을 추천한다. 이 결론은 아래 서비스 기능과 현재 프로젝트 규모를 바탕으로 한 설계 제안이다. 처리량과 비용을 측정한 결론은 아니다.

```text
브라우저
  ↓ 같은 출처 /api/v1/events/batch
앱 백엔드 또는 /api 라우팅 계층
  ├─ 쿠키 토큰 검증 → 방문자 저장소 → 서버 reader_id 결정
  ↓ 인증된 내부 요청
Cloud Run 행동 수집 API
  ↓ 스키마·권한·추천 출처 검증, received_at 부여
Pub/Sub topic
  ↓ BigQuery subscription
BigQuery events_raw
  ↓ event_id 중복 제거·형식 검증·지연 데이터 처리
BigQuery events_clean
  ↓ 예약 SQL 집계
CTR 학습 표본·피처 테이블
```

브라우저가 방문자 정보를 검증할 수 있는 Cloud Run 수집 API를 동일 출처 /api 경로로 직접 호출하는 구성도 가능하다. 중간 백엔드와 수집 API를 반드시 두 개 만들어야 한다는 뜻은 아니다. 별도 서비스를 쓰면 앱 백엔드에서 방문자 컨텍스트를 검증하고 서비스 계정으로 비공개 수집 서비스를 호출하는 방식부터 검토한다. 브라우저가 보낸 reader_id를 신뢰하거나 쿠키 원문을 Pub/Sub로 넘기지 않는다.

## 서비스별 역할과 도입 시점

| 서비스 | 역할 | 이번 프로젝트 판단 |
|---|---|---|
| Cloud Run | 작성한 HTTP 수집 코드를 실행 | 수집 서버의 배포 후보 |
| Pub/Sub | 수집과 적재 사이의 비동기 메시지 전달 | 분석 저장소의 일시 장애와 수집 요청을 분리 |
| BigQuery 구독 | Pub/Sub 메시지를 BigQuery로 직접 적재 | 초기에는 별도 소비자 코드 없이 사용 검토 |
| BigQuery | 행동 분석·CTR 표본·피처 집계 | 원본·중복 제거 결과·학습 데이터를 구분 |
| BigQuery 예약 쿼리 | SQL 집계를 주기적으로 실행 | 초기 집계 자동화 후보 |
| Cloud Logging | API 오류·처리 실패 등 운영 로그 | 행동 원본의 주 저장 경로와 구분 |
| Cloud Monitoring | 수집 오류·적재 지연·미처리 메시지 감시 | 동작 확인에 필요 |
| Firestore | 방문자 토큰 해시와 독자 정보의 조회용 DB | 현재 SQLite의 관리형 대안 후보 |
| Dataflow | 복잡한 스트리밍 변환·윈도 집계 | 요구가 확인된 뒤 도입 |
| Cloud Storage | 원본 파일 보관·재처리용 아카이브 | 보관·재처리 요구가 생기면 추가 |

Cloud Logging은 BigQuery나 Pub/Sub로 로그를 라우팅할 수 있다. 따라서 ‘JSON 로그 출력 → Logging sink → BigQuery’도 가능하다. 다만 이 프로젝트에서는 학습 원본의 스키마·수락·재전송·중복 규칙을 직접 통제하는 이벤트 API 경로를 우선 제안한다. Logging을 사용할 수 없다는 뜻이 아니라 운영 진단과 행동 데이터의 책임을 구분하는 선택이다. [1][2][3][4]

## 프론트엔드에서 해야 할 일

노출·클릭·상세 열림·활성 체류 이벤트를 합의한 시점에 생성한다. event_id, event_type, schema_version, session_id, article_id, recommendation_id, occurred_at, 발생 경로, 이벤트별 속성을 기록한다. 독자 ID는 서버가 쿠키로 검증한다. 토큰, 쿠키 헤더, 서비스 계정 키는 이벤트 본문과 분석 테이블에 넣지 않는다.

소량 배치 전송과 제한된 재시도 큐를 만든다. 재시도할 때 같은 event_id를 유지하고, 응답을 확인하지 못한 전송은 중복 가능성이 있는 것으로 처리한다. 기존 브라우저 방문자 ID의 삭제·교체 시 이전 큐를 새 독자에게 재귀속하지 않는다. 기사 이동은 로깅 완료를 기다리지 않게 한다.

프론트에는 GCP 서비스 계정 키를 넣지 않는다. Pub/Sub·BigQuery에 직접 쓰는 대신 자체 API만 호출한다. 로그 수집 실패가 피드 조회 실패로 이어지지 않게 한다. 쿠키가 없고 지속 식별을 선택하지 않은 이용자의 이벤트 수집 범위는 팀에서 별도 결정한다.

## 수집 API의 수락 기준

1. 허용한 이벤트 종류·단위·길이·배치 크기·출처를 검증한다.
2. 쿠키 또는 인증된 내부 호출에서 독자를 확인하고, 해당 독자의 추천·기사·순위를 대조한다.
3. 서버 received_at을 부여하고 Pub/Sub publish 결과를 확인한다.
4. 발행이 확인된 이벤트만 수락 상태로 응답한다. 일부만 성공하면 이벤트별 결과를 반환한다.
5. 발행 실패 또는 결과 불명은 클라이언트 재시도 대상이다. 중복 발행 가능성을 허용하고 분석 단계에서 제거한다.

이 구성의 수락은 ‘Pub/Sub 발행 확인’이지 ‘BigQuery 적재 완료’가 아니다. 202 응답을 사용한다면 기존 계약의 accepted 의미를 이에 맞춰 갱신한다. 지금 문서의 단계별 검증 전에는 수집·적재 완료로 보고하지 않는다.

## 중복과 적재 실패 처리

BigQuery 구독은 at-least-once 전달을 지원하므로 원본에 중복이 생길 수 있다. Pub/Sub message_id만으로는 클라이언트 재발행을 구분하지 못한다. 앱 event_id를 기준으로 정제 뷰 또는 테이블에서 한 번만 계산한다. 동일 ID인데 본문이 다르면 무조건 하나를 고르지 말고 충돌 데이터로 분리한다. 체류는 article_view_id와 sequence도 검증한다. [1]

초기 원본 테이블은 수신·발행 날짜 기준 파티션과 JSON payload를 후보로 둔다. 정제 테이블은 이벤트별 필드를 정형화하고 조회 패턴에 따라 reader_id와 event_type 등의 클러스터링을 검토한다. JSON data 열과 메시지 메타데이터 저장 설정을 사용할 수 있으나 실제 테이블 스키마와 구독 옵션을 맞춰야 한다. 샘플 메시지로 적재를 먼저 확인한다. [2]

스키마 불일치·권한 오류로 적재하지 못하는 메시지에 대비해 dead-letter topic과 보관·재처리 절차를 구성한다. 오류 원인을 고친 뒤 원래 event_id를 유지해 재처리한다. 미처리 건수와 가장 오래 대기 중인 메시지의 나이, dead-letter 건수, API 거절 비율을 감시한다. [2][5]

CTR 라벨·피처에는 추천 당시 사용할 수 있었던 데이터만 포함한다. 원본 적재가 늦어도 과거 추천 입력을 소급 수정하지 않는다. 기사·추천 ID와 이벤트 ID 연결은 기존 청사진의 정의를 유지한다. 초기 관심사 입력을 피처로 요구하지 않는다.

## 현재 로컬 구현에서 바꿔야 할 부분

현재 Node 서버는 127.0.0.1에 바인딩하고 방문자 정보를 SQLite 파일에 저장한다. Cloud Run은 컨테이너가 PORT 환경변수의 포트로 0.0.0.0에서 요청을 받아야 하고 기본 파일시스템은 인스턴스 종료 후 유지되지 않는다. 그대로 배포하는 것은 적절하지 않다. [6]

방문자 표식의 조회는 Firestore 또는 팀이 선택한 Cloud SQL 같은 영속 저장소로 옮긴다. BigQuery는 매 API 요청의 방문자 인증 조회 DB로 제안하지 않는다. Firestore는 관리형 문서 DB 후보이며 비용·트랜잭션·삭제 요구를 비교해 확정한다. [7]

Cloud Run 여러 인스턴스가 같은 방문자 저장소를 조회할 수 있어야 한다. 쿠키는 기존대로 서버 발급·해시 저장·고정 만료를 유지하고 HTTPS·동일 출처 /api 경로를 설계한다. GitHub Pages와 다른 API 사이트를 단순 연결하면 쿠키 전송 문제가 생길 수 있으므로 배포 주소와 프록시를 먼저 정한다.

## 단계별 진행 제안

1. 이벤트 계약 확정. 노출·클릭·체류 단위, ID, 수집 허용 범위, 중복·지연 처리 규칙을 결정한다.
2. 로컬 수집 API와 테스트 저장소로 한 이벤트를 끝까지 추적한다. 모델은 연결하지 않는다.
3. GCP 테스트 프로젝트에 Cloud Run·Pub/Sub·BigQuery 최소 경로를 만든다. 방문자 저장소 전환도 함께 검증한다.
4. 실제 브라우저 클릭 1건을 event_id로 BigQuery에서 조회한다. 같은 이벤트를 두 번 전송해 정제 결과 1건을 확인한다.
5. BigQuery 적재 실패·Pub/Sub 발행 실패를 각각 유도해 재시도·dead-letter·운영 알림을 확인한다.
6. 노출과 클릭의 연결을 검증한 뒤 CTR 집계·학습 표본·피처 갱신을 추가한다.

가장 작은 시연만 급하면 Cloud Run → Firestore 저장으로 시작하고, 분석용 BigQuery 적재를 다음 단계로 둘 수도 있다. 그러나 수집·분석 파이프라인 자체가 프로젝트 평가 대상이라면 Cloud Run → Pub/Sub → BigQuery가 역할을 설명하고 장애 분리를 검증하기에 적절하다는 판단이다.

Dataflow는 이벤트 시간 기반 복잡한 윈도 처리·대규모 실시간 변환이 실제로 필요할 때 추가한다. Pub/Sub에서 BigQuery로 단순 적재만 필요하면 직접 구독을 먼저 비교한다. [1][8]

## 비용과 회의 결정 항목

월 비용은 방문자 수만으로 추정하지 않는다. 독자당 노출 카드 수·체류 보고 횟수·평균 이벤트 크기·재전송률·보관 기간·쿼리 스캔량이 필요하다. 최소 인스턴스·최대 인스턴스 설정, 분석 파티션 필터, 서비스별 사용량을 함께 검토한다. 예약 쿼리도 분석 사용량에 포함된다. 알림 전용 예산은 사용·지출을 자동 중단하지 않는다. [9][10]

회의에서는 수집 서비스 분리 여부, 방문자 저장소, 프론트/API 주소, 테스트 프로젝트와 리전, 이벤트 계약, 원본·정제 보관 기간, 실패 재처리 담당자, 비용 한도를 결정한다. 현재 데이터 유입량과 팀의 GCP 프로젝트·권한·예산은 확인하지 않았으므로 정확한 비용과 배포 일정은 미정이다.

## 공식 자료

- [1] [Pub/Sub BigQuery 구독](https://docs.cloud.google.com/pubsub/docs/bigquery)
- [2] [BigQuery 구독 생성과 스키마 설정](https://docs.cloud.google.com/pubsub/docs/create-bigquery-subscription)
- [3] [Cloud Run과 Pub/Sub 연동](https://docs.cloud.google.com/run/docs/tutorials/pubsub)
- [4] [Cloud Logging 라우팅](https://docs.cloud.google.com/logging/docs/routing/overview)
- [5] [Pub/Sub 모니터링](https://docs.cloud.google.com/pubsub/docs/monitoring)
- [6] [Cloud Run 컨테이너 실행 계약](https://docs.cloud.google.com/run/docs/container-contract)
- [7] [Firestore 개요](https://docs.cloud.google.com/firestore/native/docs/overview)
- [8] [Dataflow 개요](https://docs.cloud.google.com/dataflow/docs/overview)
- [9] [BigQuery 예약 쿼리](https://docs.cloud.google.com/bigquery/docs/scheduling-queries)
- [10] [예산과 알림](https://docs.cloud.google.com/billing/docs/how-to/budgets)
