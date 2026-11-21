# Packages are never listed by name here: every packages/* is picked up, so adding a
# package needs no Dockerfile change.

# Only the package.json files, so `npm ci` stays cached until a manifest changes.
FROM node:20-alpine AS manifests
WORKDIR /app
COPY packages packages
RUN find packages -mindepth 2 -maxdepth 2 ! -name package.json -exec rm -rf {} +

FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY --from=manifests /app/packages packages
RUN npm ci
COPY packages packages
# The web app's mock data source imports sample alerts from the repo-root fixtures/.
COPY fixtures fixtures
RUN npm run build
# Keep built output and runtime files (migrations etc.); drop sources, tests and dev node_modules.
RUN find packages -mindepth 2 -maxdepth 2 \( -name node_modules -o -name src -o -name test -o -name e2e -o -name 'tsconfig*.json' \) -exec rm -rf {} +

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY --from=manifests /app/packages packages
RUN npm ci --omit=dev
COPY --from=build /app/packages packages
ENV WEB_DIST=/app/packages/web/dist
EXPOSE 3000
CMD ["node", "packages/api/dist/main.js"]
