FROM oven/bun:1.4.4-alpine

ENV TZ=America/Chicago
ENV NODE_ENV=production

WORKDIR /app
# the app runs as bun, so it can't create this itself
RUN mkdir logs && chown bun:bun logs
# docker compose exec -it <service> e621stream <command>
RUN printf '#!/bin/sh\nexec bun /app/src/cli/index.ts "$@"\n' > /usr/local/bin/e621stream && chmod +x /usr/local/bin/e621stream
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production --ignore-scripts
# owned by bun so compose watch can sync into it
COPY --chown=bun:bun . .
# shown on the status page and in /info. last, so a new commit doesn't throw away the cached layers above
ARG GIT_COMMIT=unknown
ENV GIT_COMMIT=$GIT_COMMIT
USER bun
CMD ["bun", "run", "src/index.ts"]
