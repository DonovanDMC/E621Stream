FROM oven/bun:1.3.10-alpine

ENV TZ=America/Chicago
ENV NODE_ENV=production

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production --ignore-scripts
COPY . .
USER bun
CMD ["bun", "run", "src/index.ts"]
