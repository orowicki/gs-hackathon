FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/delivery/package.json packages/delivery/
COPY packages/api/package.json packages/api/
RUN npm ci
COPY packages packages
RUN npm run build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/delivery/package.json packages/delivery/
COPY packages/api/package.json packages/api/
RUN npm ci --omit=dev
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/packages/delivery/dist packages/delivery/dist
COPY --from=build /app/packages/api/dist packages/api/dist
EXPOSE 3000
CMD ["node", "packages/api/dist/main.js"]
