FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS build-toolchain
RUN apt-get update && apt-get install -y --no-install-recommends g++ make python3 && rm -rf /var/lib/apt/lists/*

FROM build-toolchain AS dependencies
WORKDIR /opt/mrow
COPY package.json package-lock.json ./
RUN npm ci

FROM dependencies AS build
COPY . .
RUN npm run build

FROM build-toolchain AS production-dependencies
WORKDIR /opt/mrow
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS runtime
ENV NODE_ENV=production
WORKDIR /opt/mrow
COPY --from=production-dependencies /opt/mrow/node_modules ./node_modules
COPY --from=build /opt/mrow/dist ./dist
COPY package.json ./
RUN mkdir -p /data /run/mrow-egress /run/workers/worker-1 /run/workers/worker-2 /run/workers/worker-3 /run/workers/worker-4 && chown -R node:node /data /run/mrow-egress /run/workers /opt/mrow
USER node
EXPOSE 3080
CMD ["node", "dist/server/index.js"]
