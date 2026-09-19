FROM oven/bun:1
WORKDIR /app
COPY package.json bun.lock tsconfig.json ./
COPY packages ./packages
COPY apps ./apps
RUN bun install --frozen-lockfile --production
ENV PORT=8787 JEVTAIL_DB=/data/jevtail.db
VOLUME /data
EXPOSE 8787
CMD ["bun", "apps/server/src/bun.ts"]
