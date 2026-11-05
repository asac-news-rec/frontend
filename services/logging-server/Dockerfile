FROM node:24.21.0-bookworm-slim AS verify
WORKDIR /service
COPY package.json ./
COPY *.mjs ./
COPY tests ./tests
RUN npm run check && npm test
FROM node:24.21.0-bookworm-slim
WORKDIR /service
ENV LOGGING_HOST=0.0.0.0 LOGGING_PORT=4195 LOGGING_DB=/service/data/inbox.sqlite LOGGING_EXPORT_DIR=/service/data/objects
COPY --from=verify /service/package.json ./
COPY --from=verify /service/*.mjs ./
RUN mkdir /service/data && chown node:node /service/data
USER node
EXPOSE 4195
CMD ["node","main.mjs"]
