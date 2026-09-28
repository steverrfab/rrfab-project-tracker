# Built by Railway (railway.json -> DOCKERFILE). A Dockerfile instead of the
# automatic Node build so the server has pg_dump/pg_restore 18, matching the
# Postgres 18 database, for the nightly Backblaze backup (b2backup.js).
FROM node:20-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
 && install -d /usr/share/postgresql-common/pgdg \
 && curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc \
 && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends postgresql-client-18 \
 && apt-get purge -y gnupg && apt-get autoremove -y && rm -rf /var/lib/apt/lists/* \
 && pg_dump --version

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY frontend/package.json frontend/
RUN npm install --prefix frontend
COPY . .
RUN npm run build --prefix frontend

ENV NODE_ENV=production
CMD ["node", "server.js"]
