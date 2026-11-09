> 과거 Node·SQLite 시연 절차입니다. 현재 실행·배포는 [README](../README.md)를 따르세요.

# 맥북에서 프론트엔드·백엔드 Docker 시연

이 문서는 **새 Mac**에서 AI 실행 담당자가 따라 할 절차입니다. Docker Desktop과 Git이 설치되어 있고 GitHub의 `asac-news-rec` 저장소에 접근 권한이 있어야 합니다. 모든 명령은 macOS Terminal의 `zsh` 기준입니다. Mac에서의 실행은 아직 검증하지 않았으므로, 아래 확인 명령의 실제 결과를 보고 시연 준비를 완료하세요.

## 1. GitHub SSH 접속과 저장소 복제

```zsh
docker info >/dev/null
git --version
ssh -T git@github.com
```

`ssh -T`에서 GitHub가 인증 성공 메시지를 표시하면 다음으로 진행합니다. SSH 키가 없거나 접근이 거절되면 AI는 Mac의 **공개 키만** 확인하거나 새 키를 만들고, 사용자가 GitHub 계정에 공개 키를 등록하도록 요청하세요. 개인 키나 토큰을 화면·로그에 출력하지 마세요. GitHub 호스트 키 검증을 끄지 마세요.

```zsh
mkdir -p ~/asac-news-demo
cd ~/asac-news-demo
git clone git@github.com:asac-news-rec/backend.git
git clone git@github.com:asac-news-rec/frontend.git
cd frontend
git switch feat/7-backend-integration
```

브랜치가 원격에 아직 없다면 AI는 `git branch -r`로 확인하고 작업을 중단해 담당자에게 알립니다. `main`으로 조용히 대체하지 않습니다.

## 2. 백엔드 DB 준비

```zsh
cd ~/asac-news-demo/backend
test -f exports/newsdb_2026-11-05_reader_id.dump
test -d generate/output_with_thumbnail/2026-11-05/images
test ! -e .env
cp .env.example .env
chmod 600 .env
python3 -c 'from pathlib import Path; import secrets; p=Path(".env"); s=p.read_text(); p.write_text(s.replace("CHANGE_ME_TO_A_STRONG_PASSWORD", secrets.token_hex(24)))'
docker compose config --quiet
docker compose up -d postgres --wait
```

`test ! -e .env`가 실패하면 기존 파일을 덮어쓰지 말고 AI가 내용을 확인해야 합니다. `.env`는 이 Mac에서만 사용하는 DB 비밀번호를 담습니다. Git에 추가하지 않습니다. **새로 생성한 빈 DB에만** 다음 백업을 복원합니다. 기존 `postgres-data` 볼륨이나 테이블이 있으면 복원 전에 AI가 상태를 확인하고 사용자 데이터의 처리 방침을 묻습니다. `docker compose down -v`를 사용하지 않습니다.

```zsh
docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "select count(*) from information_schema.tables where table_schema = '\''public'\''"'
```

위 결과가 `0`인 경우에만:

```zsh
postgres_container="$(docker compose ps -q postgres)"
docker cp exports/newsdb_2026-11-05_reader_id.dump "${postgres_container}:/tmp/newsdb.dump"
docker compose exec -T postgres sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --no-privileges --exit-on-error --single-transaction /tmp/newsdb.dump'
docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "select count(*) from news_articles"'
```

백업 시점 기준 기사 350건이 나와야 합니다.

## 3. 백엔드 API와 이미지 실행

먼저 저장소의 공식 Compose 서비스를 실행합니다. 백엔드 이미지에는 모델 관련 의존성도 들어 있어 첫 빌드가 오래 걸릴 수 있습니다.

```zsh
docker compose up -d --build --wait
curl -fsS http://127.0.0.1:8000/health
```

`{"status":"ok","database":1}`을 확인합니다. 공식 이미지 빌드가 실패하면 오류 로그를 보존하고 원인을 확인하세요. 시연을 위해 경량 API가 필요할 경우, 아래처럼 **실제 백엔드 소스**를 Python 컨테이너에 읽기 전용으로 마운트해 실행할 수 있습니다. 이것은 공식 백엔드 이미지 대신 API 동작을 확인하는 경로입니다. DB는 앞 단계의 같은 Docker 볼륨을 사용합니다.

```zsh
docker compose up -d postgres --wait
docker ps -a --filter name=asac-news-demo-api
docker run -d --name asac-news-demo-api \
  --network asac-news-backend_default \
  --env-file .env -e PGHOST=postgres -e PGPORT=5432 \
  -p 127.0.0.1:8000:8000 -v "$PWD:/app:ro" -w /app \
  python:3.14-slim sh -c \
  'pip install --no-cache-dir fastapi uvicorn "psycopg[binary]" python-dotenv && python -m uvicorn app.main:app --host 0.0.0.0 --port 8000'
curl -fsS http://127.0.0.1:8000/health
```

경량 경로를 사용할 때는 기존 공식 `api` 컨테이너가 8000 포트를 점유하지 않았는지 확인하고, 이름이 같은 기존 컨테이너를 임의로 삭제하지 마세요.

DB의 기사 이미지 URL은 `localhost:8001`을 사용합니다. 공식 백엔드 Nginx는 8080 포트이므로 이미지용 컨테이너를 따로 실행합니다.

```zsh
docker ps -a --filter name=asac-news-demo-images
docker run -d --name asac-news-demo-images \
  -p 127.0.0.1:8001:80 \
  -v "$PWD/generate/output_with_thumbnail:/usr/share/nginx/html:ro" \
  nginx:stable-alpine
```

이미지 컨테이너가 이미 있으면 중복 생성하지 말고 상태와 마운트를 확인하세요.

## 4. 프론트엔드 실행 및 화면 확인

```zsh
cd ~/asac-news-demo/frontend
export NEWS_BACKEND_URL='http://host.docker.internal:8000/'
docker compose config --quiet
docker compose up -d --build --wait
curl -fsS -o /dev/null http://127.0.0.1:4181/
curl -fsS http://127.0.0.1:8000/health
open http://127.0.0.1:4181/
```

Docker Desktop의 `host.docker.internal`은 프론트엔드 컨테이너에서 Mac의 8000 포트로 접근하기 위한 주소입니다. 브라우저 주소에는 쿼리 문자열이 필요하지 않습니다. 4181은 Mac에서 여는 프론트엔드 포트, 4173은 컨테이너 내부 포트입니다.

화면에서 기사 목록과 썸네일을 보고, 기사 클릭·좋아요·새로고침 후 반영을 확인하세요. 카테고리 대분류 API 연결은 백엔드 담당자의 구현을 기다리는 중이므로, 그 부분을 완료된 것으로 시연하지 않습니다. 문제가 있으면 `docker compose logs --tail 100 web`(frontend), `docker compose logs --tail 100 api postgres`(backend), `docker logs asac-news-demo-images`를 확인하세요.

## 5. 종료와 재실행

각 저장소에서 `docker compose down`으로 종료합니다. 이 명령은 DB 볼륨을 유지합니다. 별도로 띄운 이미지 컨테이너는 `docker stop asac-news-demo-images`로 중지합니다. 경량 API를 사용했다면 `docker stop asac-news-demo-api`로 중지합니다. 재시작할 때는 각 저장소에서 `docker compose up -d --wait`를 실행하고, 프론트엔드에는 위 `NEWS_BACKEND_URL`을 다시 설정합니다.

## 이 PC에서 실제 사용한 구성

Windows PC에는 백엔드 저장소를 로컬 복제했습니다. 해당 복제본의 2026-11-05 백업을 PostgreSQL 18 Docker 볼륨에 복원하고, 실제 백엔드 FastAPI 소스를 `python:3.14-slim` 컨테이너에서 경량 의존성으로 실행했습니다. 이미지도 별도 Nginx 컨테이너에서 제공했습니다. 프론트엔드는 Docker 4181 포트로 띄우고 백엔드 8000 포트로 연결했습니다. 이 PC의 복제본·`.env`·DB 볼륨은 GitHub에 올라가지 않으며 Mac에서 새로 생성해야 합니다.
