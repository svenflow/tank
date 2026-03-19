FROM oven/bun:1-alpine
WORKDIR /app
COPY server.ts .
COPY public/ public/
EXPOSE 8776
CMD ["bun", "run", "server.ts"]
