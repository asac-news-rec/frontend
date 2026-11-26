# Pub/Sub → GCS 로그 수집 전환

## 상태와 범위

이 브랜치는 `LOGGING_STORE=pubsub` 선택 경로를 구현합니다. 기본값은 기존 `postgres`이며,
이미지 배포만으로 운영 저장 경로가 바뀌지 않습니다. 실제 토픽·GCS 구독 생성과 운영 전환은
아직 수행하지 않았습니다. PostgreSQL·SQLite 데이터, Airflow DAG와 기존 export는 보존합니다.

```text
브라우저 / k6 → 같은 출처 게이트웨이(쿠키 검증) → 로깅 API(형식·서명 검증)
                                                   ↓ publish ACK
                                                Pub/Sub 토픽
                                                   ↓ Cloud Storage 구독
                                                GCS 원본 파일
```

Pub/Sub 모드에서 수집 API는 DB 연결, 프로세스 저장 잠금, advisory lock, Airflow export를
사용하지 않습니다. 별도 GCS 저장 작업자도 없습니다. API는 요청당 최대 100개 레코드를 하나의
Pub/Sub 메시지로 발행하고 **브로커 접수 응답 후** ACK합니다. 동기 SDK RPC 제한은 1초,
게이트웨이의 제공 기록 확인 제한은 기존 1.5초입니다. 큐에 넣었다는 사실만으로 GCS 도착을
보장했다고 표시하지 않습니다. RPC 실패·응답 유실은 저장 여부가 불확실한 503이며 재시도 시
원래 ID와 내용을 유지합니다.

## API·검증 계약

- HTTP 200의 `results[].status=accepted`와 `ack_stage=pubsub`는 브로커 접수 완료입니다.
  전체 메시지의 `message_id`가 함께 반환됩니다. DB 모드의 ACK 계약은 유지합니다.
- `/internal/served`와 `/internal/served-file`은 성공한 각 레코드에 `served_receipt`를
  반환합니다. 파일 업로드는 모든 행을 검증한 뒤 한 메시지로 발행합니다. 다른 요청의 같은
  ID와 충돌하는지는 이 단계에서 조회하지 않습니다.
- 영수증은 별도 Secret `LOGGING_RECEIPT_KEY`로 HMAC-SHA256 서명합니다. 정규화된
  제공 기록과 발급 후 24시간 만료 시각을 포함합니다. 이 값은 암호화된 데이터가 아닙니다.
  브라우저는 이미 제공받은 자기 기록에 대한 영수증만 받고, 서버 Secret은 받지 않습니다.
- 게이트웨이는 제공 기록 ACK의 영수증을 `items[].served_receipt`로 전달하고
  `collection_ack_stage=pubsub`를 표시합니다. 일부 chunk라도 실패하면 수집을 활성화하지
  않습니다. 정상 피드 제공 자체는 기존대로 유지됩니다.
- 브라우저/k6는 행동 이벤트에 `served_receipt`를 붙입니다. 로깅 서버는 서명·만료·독자·
  impression 일치를 검사합니다. DB 조회 없이 다른 독자의 제공 기록 사용을 거절합니다.
  영수증은 실제 화면 노출 또는 사람의 행동을 증명하지 않습니다.
- 브라우저는 재시도 큐에 영수증을 포함합니다. 기존 큐의 영수증 없는 이벤트나 만료된
  영수증은 Pub/Sub 모드에서 거절됩니다. 롤백 때 Pub/Sub 영수증을 가진 이벤트 역시 DB
  스키마에서 거절될 수 있습니다. 전환 전에 기존 세션/전송 큐를 마무리하고 새 피드를 받습니다.
- `/ready`는 설정된 mode를 보여주며 `gcs_verified=false`입니다. 실제 토픽/IAM/GCS
  상태를 점검하는 readiness 검사가 아닙니다. 실제 검증은 smoke 발행과 파일 대조로 합니다.
- `/internal/flush`는 HTTP 202와 `scheduled=false`입니다. GCS 구독의 파일 닫기를
  API에서 강제하지 않습니다.

## GCS 형식·중복·추적

Cloud Storage 구독의 **text** 형식을 사용합니다. 각 줄은 다음 JSON 메시지 하나입니다.

```json
{"schema_version":2,"stream":"served","records":[{"request_id":"example-request","impression_id":"example-impression","reader_id":"example-reader","article_id":"example-article","position":1,"served_at":"2026-11-26T00:00:00.000Z","received_at":"2026-11-26T00:00:00.010Z"}]}
```

`stream`은 `served` 또는 `actions`입니다. actions에는 기존 행동 필드 외에 서명으로 검증한
`reader_id`, `request_id`, `article_id`, `position`, `served_at`, `source`,
`measurement_version`이 들어갑니다. 영수증 자체와 쿠키는 GCS 메시지에 넣지 않습니다.
`served_at`/`event_time`은 발생 시점, `received_at`은 수집 서버의 수신 시점(UTC ms)입니다.
`features_as_of`의 원본 정밀도와 모델 메타데이터는 served 레코드에 유지합니다.

기존 Airflow의 reader별 JSONL/gzip/manifest와는 다른 **v2 원본 계약**입니다. 별도 prefix
`pubsub-v2/`를 사용하고 기존 학습·분석 작업에 그대로 연결하지 않습니다. 메시지/파일 도착
순서와 파일 개수를 이벤트 순서·개수로 해석하지 않습니다. 순서 대신 발생 시각과 ID를 씁니다.

원본에는 중복이 들어올 수 있습니다. served는 `impression_id`, actions는 `event_id`로
후처리에서 중복 제거합니다. 동일 요청 내부의 중복만 즉시 `duplicate`로 응답하고, 요청을
넘는 재전송에는 다시 `accepted`가 올 수 있습니다. Pub/Sub message_id는 재발행 때 바뀌므로
중복 제거 키가 아닙니다. 같은 ID인데 내용이 다르면 임의로 첫/마지막 값을 선택하지 말고
충돌로 격리합니다. `received_at`만 다른 재시도는 같은 내용으로 간주합니다.

현재 일반 화면과 k6 HTTP 시뮬레이션은 모두 신뢰된 게이트웨이의 `source=browser`입니다.
이 값만으로 실제 사람/가상 독자를 구별할 수 없습니다. 테스트 전용 토픽·버킷과 k6 audit의
run_id/ID 집합으로 시험 데이터를 구분하며 실제 추천 품질 증거로 사용하지 않습니다.

## 운영 전환 전 해결할 항목

**개별 독자 수집 철회·삭제가 필요한 운영 환경에는 아직 전환하지 않습니다.** 기존 DB의
revoked_users 조회와 reader별 객체 삭제를 v2에서 대체하지 않았습니다.
`/internal/delete-user`는 501 `PUBSUB_DELETION_REQUIRES_ERASURE_WORKFLOW`를 반환하며
삭제됐다고 응답하지 않습니다. 기존에 철회한 독자도 자동으로 이 모드에 이관되지 않습니다.

운영 전환에는 공유된 철회 상태 확인, 기존 tombstone 이관, 큐의 늦은 도착 처리, 여러 독자가
섞인 객체의 재작성/삭제, GCS soft-delete·버전·보존 정책까지 포함하는 별도 절차가 필요합니다.
즉시 수집 중단과 과거 기록 삭제 완료를 서로 다른 상태로 관리해야 합니다. 현재 브랜치는
합성 데이터의 별도 테스트 환경에서 경로와 처리량을 검증하는 범위입니다.

## 인프라 준비안 (아직 적용하지 않음)

팀 공용 리소스 변경은 infra 저장소에서 관리합니다. 다음은 담당자가 리뷰할 구체적인 설정입니다.

| 대상 | 설정 |
|---|---|
| 토픽 | `behavior-raw-v2-test`, 허용 저장 리전 `asia-northeast3` |
| 구독 | `behavior-raw-v2-test-gcs`, Cloud Storage export, text |
| 버킷 | 합성 데이터 전용 비공개 버킷, 기존 production prefix와 분리 |
| 파일 | prefix `pubsub-v2/`, suffix `.jsonl`, 최대 60초 또는 10MB로 배치 |
| 미처리 보존 | 7일, 자동 구독 만료 없음 |
| 로깅 런타임 | 해당 토픽에만 `roles/pubsub.publisher` |
| Pub/Sub 서비스 에이전트 | 대상 버킷에 `roles/storage.objectCreator`, `roles/storage.legacyBucketReader` |
| 서명 키 | 32자 이상의 별도 무작위 Secret, 로깅 런타임만 읽기 |

Cloud Storage 구독은 별도 subscriber 실행 없이 GCS에 씁니다. 대상 버킷·IAM 준비 후 실행할
명령 예시입니다. IAM 변경이나 생성 명령은 이 문서 작성 과정에서 실행하지 않았습니다.

```bash
# PROJECT와 TEST_BUCKET은 승인된 테스트 리소스로 지정합니다.
gcloud pubsub topics create behavior-raw-v2-test --project="$PROJECT" \
  --message-storage-policy-allowed-regions=asia-northeast3
gcloud pubsub subscriptions create behavior-raw-v2-test-gcs --project="$PROJECT" \
  --topic=behavior-raw-v2-test --cloud-storage-bucket="$TEST_BUCKET" \
  --cloud-storage-output-format=text --cloud-storage-file-prefix=pubsub-v2/ \
  --cloud-storage-file-suffix=.jsonl --cloud-storage-max-duration=60s \
  --cloud-storage-max-bytes=10MB --message-retention-duration=7d --expiration-period=never
```

**토픽과 구독을 모두 준비한 뒤에** 수집 트래픽을 전환합니다. 토픽만 있고 구독/보존이
없으면 publish 성공만 확인하고 로그를 잃을 수 있습니다. 위 설정의 GCS 접근 오류는 backlog와
oldest unacked age, 구독 상태를 감시합니다. 지속 유입이 내보내기 속도보다 크면 backlog가
늘고 보존 기한 뒤 손실될 수 있으므로 API 지연만으로 정상이라고 판단하지 않습니다.

Cloud Run 테스트 서비스 설정:

```text
LOGGING_STORE=pubsub
LOGGING_PUBSUB_TOPIC=projects/<project>/topics/behavior-raw-v2-test
LOGGING_RECEIPT_KEY=<Secret Manager 연결; 실제 값을 문서나 Git에 넣지 않음>
LOGGING_TOKEN=<기존 내부 인증 Secret>
```

ADC/런타임 서비스 계정으로 발행합니다. 로컬 키 파일을 이미지에 포함하지 않습니다.
`LOGGING_DATABASE_URL`이 남아 있어도 pubsub 모드에서 읽어 연결하지 않습니다.
`GCS_BUCKET`은 이 모드의 API에 필요하지 않고 구독에서 지정합니다.
workflow는 기존처럼 이미지만 갱신하므로 이 설정과 IAM은 별도로 준비해야 합니다.

## 검증과 전환 순서

1. 새 이미지·게이트웨이·브라우저를 먼저 배포하되 기존 postgres 모드로 회귀 검증합니다.
2. 합성 데이터용 별도 토픽/구독/버킷과 테스트 서비스를 준비하고 pubsub 모드를 켭니다.
3. k6 소량 smoke에서 쿠키 재접속, 영수증 전달, `ack_stage=pubsub`를 확인합니다.
   기존 k6 summary의 `database_verified`와 `gcs_verified`는 여전히 false입니다.
4. GCS 파일이 닫힐 때까지 기다린 뒤 필요한 객체를 로컬 `data/` 아래에 내려받습니다.
   다음 명령으로 GCS 원본과 k6 audit의 승인된 ID 전체를 대조합니다.

```powershell
# services/logging-server에서 실행. objects에는 내려받은 파일의 실제 경로를 전달합니다.
python -m logging_service.archive ../../data/export-1.jsonl ../../data/export-2.jsonl --audit ../../data/k6-audit.jsonl
```

도구는 식별자를 출력하지 않고 served/actions/duplicates/missing 수를 출력합니다. 빈 audit,
승인 기록 누락, ID 내용 충돌은 실패입니다. 이는 소량 검증용 메모리 도구이며 전체 운영 ETL이나
추천 결과 검증은 아닙니다. HTTP ACK 없는 요청이 실제로 저장됐을 수도 있으므로 초과 건수는
별도로 조사합니다. 자동 재발행으로 보정하지 않습니다.

5. 10회/초부터 올리며 API p95·오류율뿐 아니라 GCS 도착 지연, backlog와 최종 unique 건수를
   비교합니다. 지연·누락 발생 시 증량을 멈춥니다. 부하테스트 합격이 추천 결과 합격은 아닙니다.
6. 앞의 철회/삭제와 v2 분석 소비자 준비가 완료된 뒤에만 운영 전환을 검토합니다.

롤백은 트래픽을 멈추고 기존 `LOGGING_STORE=postgres`와 DB Secret/Cloud SQL 연결을
확인한 후 수행합니다. DB·토픽·구독·GCS 객체를 삭제하지 않습니다. 이미 접수된 Pub/Sub
메시지는 GCS로 계속 내보내고 구/신 경로를 따로 대조합니다. 롤백으로 Pub/Sub 로그가 DB에
자동 복원되지 않으며, 서명 키를 바꾸면 기존 영수증이 무효가 되므로 새 피드를 받아야 합니다.

참조: [Cloud Storage 구독](https://docs.cloud.google.com/pubsub/docs/cloudstorage),
[IAM·구독 생성](https://docs.cloud.google.com/pubsub/docs/create-cloudstorage-subscription),
[gcloud 설정](https://docs.cloud.google.com/sdk/gcloud/reference/pubsub/subscriptions/create).
