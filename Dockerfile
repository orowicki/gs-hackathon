FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/api/package.json packages/api/
COPY packages/web/package.json packages/web/
COPY packages/config/package.json packages/config/
COPY packages/ingest/package.json packages/ingest/
COPY packages/filter/package.json packages/filter/
RUN npm ci
COPY packages packages
RUN npm run build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/api/package.json packages/api/
COPY packages/web/package.json packages/web/
COPY packages/config/package.json packages/config/
COPY packages/ingest/package.json packages/ingest/
RUN npm ci --omit=dev
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/packages/api/dist packages/api/dist
COPY --from=build /app/packages/web/dist packages/web/dist
COPY --from=build /app/packages/config/dist packages/config/dist
COPY --from=build /app/packages/config/migrations packages/config/migrations
COPY --from=build /app/packages/ingest/dist packages/ingest/dist
COPY --from=build /app/packages/ingest/migrations packages/ingest/migrations
ENV WEB_DIST=/app/packages/web/dist
EXPOSE 3000
CMD ["node", "packages/api/dist/main.js"]
