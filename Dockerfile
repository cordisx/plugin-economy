FROM node:24.14.1-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build
FROM node:24.14.1-bookworm-slim
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8788 ECONOMY_DB=/data/economy.sqlite
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY package.json ./
RUN mkdir /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8788
CMD ["node", "dist/server/main.js"]
