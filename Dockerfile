# Commercial Splitter, web version: the same app in your browser.
#
#   docker run -d -p 8080:8080 -v /path/to/your/videos:/videos ghcr.io/<owner>/commercial-splitter
#
# then open http://localhost:8080 (or http://<server>:8080 from another computer).

FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg tini \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY core ./core
COPY server ./server
COPY web ./web
COPY cli.js LICENSE ./

ENV PORT=8080 \
    CS_MEDIA_DIRS=/videos \
    CS_DATA_DIR=/config \
    NODE_ENV=production
RUN mkdir -p /videos /config && chown node:node /videos /config
VOLUME ["/videos", "/config"]
EXPOSE 8080
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/icon.svg').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--", "node", "server/index.js"]
