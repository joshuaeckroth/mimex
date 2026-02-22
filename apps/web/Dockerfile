FROM node:20-alpine

WORKDIR /app
COPY apps/web/package.json ./package.json
COPY apps/web/src ./src
COPY apps/web/scripts ./scripts

RUN node ./scripts/build.mjs

ENV HOST=0.0.0.0
ENV PORT=3000
ENV API_ORIGIN=http://api:8080
EXPOSE 3000

CMD ["node", "./scripts/server.mjs", "--root=dist", "--port=3000"]
