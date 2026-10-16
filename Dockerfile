FROM oven/bun:1.3.10-alpine

ENV TZ=America/Chicago
ENV NODE_ENV=production

# the backfill streams e621's db exports into postgres with curl and psql
RUN apk add --no-cache curl postgresql-client

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production --ignore-scripts
COPY . .
USER bun
CMD ["bun", "run", "src/index.ts"]
