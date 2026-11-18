#!/usr/bin/env bash
set -euo pipefail

image=${1:?Pass the production Nginx image tag}
api=''
nginx=''
cleanup() {
  if [[ -n "$nginx" ]]; then docker rm -f "$nginx" >/dev/null; fi
  if [[ -n "$api" ]]; then docker rm -f "$api" >/dev/null; fi
}
trap cleanup EXIT

# Match Cloud Run's shared network namespace without a live API or database.
api=$(docker run -d -p 127.0.0.1::80 node:24.21.0-bookworm-slim node -e '
  require("node:http").createServer((req, res) => {
    if (req.method === "POST" && req.url === "/user/anonymous") {
      res.setHeader("Set-Cookie", "news_reader=smoke-test; Path=/; HttpOnly; Secure");
      res.end("{}");
      return;
    }
    if (req.method !== "POST" || req.url !== "/news/feed") {
      res.writeHead(404).end();
      return;
    }
    req.on("data", () => {});
    req.on("end", () => res.end("feed-proxy-ok"));
  }).listen(8000, "127.0.0.1");
')
nginx=$(docker run -d --network "container:$api" "$image")
address=$(docker port "$api" 80/tcp)

curl --fail --silent --show-error --retry 10 --retry-connrefused --max-time 5 \
  "http://$address/" | grep -F '/src/app.js' >/dev/null
curl --fail --silent --show-error --max-time 5 "http://$address/src/app.js" >/dev/null
curl --fail --silent --show-error --max-time 5 "http://$address/src/style.css" >/dev/null
for path in /images/missing.jpg /foo; do
  test "$(curl --silent --show-error --max-time 5 --output /dev/null \
    --write-out '%{http_code}' "http://$address$path")" = 404
done
test "$(curl --fail --silent --show-error --retry 5 --max-time 5 --data '{}' \
  "http://$address/api/news/feed")" = 'feed-proxy-ok'
curl --fail --silent --show-error --max-time 5 --request POST --dump-header - \
  --output /dev/null "http://$address/api/user/anonymous" \
  | grep -iF 'Set-Cookie: news_reader=smoke-test; Path=/; HttpOnly; Secure' >/dev/null
echo 'Cloud Run frontend smoke test passed'
