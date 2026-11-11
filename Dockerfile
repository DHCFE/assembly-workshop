FROM node:22-bookworm-slim AS frontend
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web web
COPY site site
COPY scripts scripts
COPY runtime/interactions.json runtime/placement.json runtime/
COPY examples examples
COPY licenses licenses
COPY LICENSE .
RUN npm run build

FROM ubuntu:26.04
COPY --from=frontend /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
RUN sed -i "s|http://|https://|g" /etc/apt/sources.list.d/ubuntu.sources \
    && apt-get -o Acquire::https::Timeout=20 -o Acquire::Retries=1 update \
    && apt-get -o Acquire::https::Timeout=20 -o Acquire::Retries=1 install -y --no-install-recommends blender python3 ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 10001 workshop \
    && mkdir /data \
    && chown workshop:workshop /data
WORKDIR /app
COPY --from=frontend /src/dist dist
COPY web/index.html web/index.html
COPY examples examples
COPY runtime runtime
USER workshop
ENV PYTHONUTF8=1 PYTHONUNBUFFERED=1
EXPOSE 8765
VOLUME ["/data"]
CMD ["python3", "runtime/server.py", "--bind", "0.0.0.0", "--port", "8765", "--data-dir", "/data"]
