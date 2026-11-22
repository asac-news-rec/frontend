#!/usr/bin/env bash
set -euo pipefail
nginx_image=${1:?Pass the opt-in Nginx image}
gateway_image=${2:?Pass the gateway image}
api='' gateway='' nginx=''
cleanup() {
  if [[ -n "$nginx" ]]; then docker rm -f "$nginx" >/dev/null; fi
  if [[ -n "$gateway" ]]; then docker rm -f "$gateway" >/dev/null; fi
  if [[ -n "$api" ]]; then docker rm -f "$api" >/dev/null; fi
}
trap cleanup EXIT
api=$(docker run -d -p 127.0.0.1::80 node:24.21.0-bookworm-slim node -e '
 require("node:http").createServer((req,res)=>{
  res.setHeader("Content-Type","application/json");
  if(req.url==="/v1/user/anonymous"){
   res.setHeader("Set-Cookie","news_reader=fixture-proof; Path=/; HttpOnly; Secure");
   res.end(JSON.stringify({reader_id:"019a0000-0000-7000-8000-000000000001"}));return;
  }
  res.end(JSON.stringify({request_id:"fixture-request",served_at:new Date().toISOString(),items:[],next_cursor:null}));
 }).listen(8000,"127.0.0.1");
')
gateway=$(docker run -d --network "container:$api" \
 -e PUBLIC_ORIGIN=https://smoke.example -e LOGGING_URL=https://logging.example.run.app \
 -e LOGGING_AUDIENCE=https://logging.example.run.app \
 -e LOGGING_TOKEN=fixture-application-token-only "$gateway_image")
nginx=$(docker run -d --network "container:$api" "$nginx_image")
address=$(docker port "$api" 80/tcp)
curl --fail --silent --show-error --retry 10 --retry-connrefused --max-time 5 "http://$address/" >/dev/null
curl --fail --silent --show-error --retry 10 --max-time 5 "http://$address/api/behavior/status" | grep -F '"enabled":true' >/dev/null
headers=$(curl --fail --silent --show-error --request POST --dump-header - --output /dev/null \
 -H 'Origin: https://smoke.example' "http://$address/api/v1/user/anonymous")
printf '%s' "$headers" | grep -iF 'Set-Cookie: news_reader=fixture-proof' >/dev/null
printf '%s' "$headers" | grep -iF 'Set-Cookie: news_behavior_reader=' >/dev/null
curl --fail --silent --show-error -H 'Origin: https://smoke.example' -H 'Content-Type: application/json' \
 --data '{}' "http://$address/api/v1/news/feed" | grep -F '"collection_enabled":false' >/dev/null
curl --fail --silent --show-error "http://$address/api/v1/news/a1" >/dev/null
echo 'Behavior gateway image smoke passed; live IAM and logging are not exercised.'
