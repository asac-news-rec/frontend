FROM node:24.21.0-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json tsconfig.browser.json dev-server.ts server.ts index.html ./
RUN npm ci
COPY src ./src
COPY server ./server
COPY scripts ./scripts
COPY tests ./tests
RUN npm run check && npm test && npm run build

# Optional local container; never used as the GCP frontend runtime.
FROM build AS local
ENV HOST=0.0.0.0 PORT=4173
EXPOSE 4173
USER node
CMD ["node", ".local/dev-server.js"]

# docker build --target static --output type=local,dest=./site .
FROM scratch AS static
COPY --from=build /app/dist/ /
