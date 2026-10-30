FROM node:24.21.0-bookworm-slim AS verify
WORKDIR /app
COPY package.json server.mjs index.html ./
COPY src ./src
COPY server ./server
COPY scripts ./scripts
COPY tests ./tests
RUN npm run check && npm test && npm run build

FROM node:24.21.0-bookworm-slim AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4173 VISITOR_DB=/app/data/visitors.sqlite
WORKDIR /app
COPY --from=verify /app/package.json /app/server.mjs /app/index.html ./
COPY --from=verify /app/src ./src
COPY --from=verify /app/server ./server
RUN mkdir /app/data && chown node:node /app/data
USER node
EXPOSE 4173
CMD ["node", "server.mjs"]
