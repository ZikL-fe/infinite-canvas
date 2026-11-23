FROM oven/bun:1.3.13

WORKDIR /app/server
COPY server/package.json server/bun.lock* ./
RUN bun install --production
COPY server ./

EXPOSE 3001
CMD ["bun", "run", "src/index.ts"]
