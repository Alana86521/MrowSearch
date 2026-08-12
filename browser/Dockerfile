FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS dependencies
RUN apt-get update && apt-get install -y --no-install-recommends g++ make python3 && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/mrow
COPY package.json package-lock.json ./
RUN npm ci
COPY src ./src
COPY tsconfig.server.json ./
RUN ./node_modules/.bin/tsc -p tsconfig.server.json
RUN npm prune --omit=dev

FROM kasmweb/chromium:1.19.0@sha256:8b0b5657171cae5d15e989ec5a69b70550cd843efce382023ee1c26430bd8fe9
USER root
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg socat && rm -rf /var/lib/apt/lists/*
COPY --from=dependencies /usr/local/bin/node /usr/local/bin/node
COPY --from=dependencies /opt/mrow/node_modules /opt/mrow/node_modules
COPY --from=dependencies /opt/mrow/dist /opt/mrow/dist
COPY browser/custom_startup.sh /dockerstartup/custom_startup.sh
COPY browser/chromium-policy.json /etc/chromium/policies/managed/mrowsearch.json
RUN chmod 0755 /dockerstartup/custom_startup.sh && mkdir -p /run/mrow /run/mrow-egress && chown -R 1000:0 /run/mrow /run/mrow-egress /opt/mrow
ENV MROW_WORKER_SOCKET_DIRECTORY=/run/mrow
ENV MROW_CHROMIUM_DEBUG_URL=http://127.0.0.1:9222
ENV NODE_ENV=production
USER 1000
