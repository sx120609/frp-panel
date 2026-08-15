FROM node:20-alpine
ARG FRP_VERSION=0.61.1
ARG FRP_DOWNLOAD_MIRRORS=""
RUN apk add --no-cache curl tar && \
    ARCH="$(case "$(uname -m)" in x86_64) echo amd64;; aarch64|arm64) echo arm64;; armv7*) echo arm;; *) echo amd64;; esac)" && \
    ARCHIVE="/tmp/frp_${FRP_VERSION}_linux_${ARCH}.tar.gz" && \
    BASES="${FRP_DOWNLOAD_MIRRORS:-https://gh-proxy.com/https://github.com/fatedier/frp/releases/download,https://ghproxy.net/https://github.com/fatedier/frp/releases/download,https://github.com/fatedier/frp/releases/download}" && \
    DOWNLOADED=0 && \
    for BASE in $(echo "$BASES" | tr ',' ' '); do \
      if curl --connect-timeout 10 --max-time 180 --retry 1 -fL "$BASE/v${FRP_VERSION}/frp_${FRP_VERSION}_linux_${ARCH}.tar.gz" -o "$ARCHIVE"; then DOWNLOADED=1; break; fi; \
    done && \
    test "$DOWNLOADED" -eq 1 && \
    mv "$ARCHIVE" /tmp/frp.tgz && \
    tar -xzf /tmp/frp.tgz -C /tmp && \
    install -m 0755 "/tmp/frp_${FRP_VERSION}_linux_${ARCH}/frps" /usr/local/bin/frps && \
    rm -rf /tmp/frp*

WORKDIR /app
COPY package.json server.mjs ./
COPY public ./public
RUN mkdir -p /app/data /app/generated

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080
EXPOSE 7000 7500
VOLUME ["/app/data", "/app/generated"]

CMD ["node", "server.mjs"]
