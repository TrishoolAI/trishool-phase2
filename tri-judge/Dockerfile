FROM node:22-alpine AS build

WORKDIR /app

COPY package.json package-lock.json tsconfig.json vitest.config.ts ./
RUN npm ci

COPY src ./src
COPY test ./test
COPY docker ./docker

RUN npm run build

FROM node:22-alpine AS runtime

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=build /app/dist ./dist
COPY --from=build /app/docker ./docker

CMD ["node", "dist/index.js"]
