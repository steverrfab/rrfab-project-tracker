# Rebuilding the Project Tracker from scratch

Use this if Railway, or the tracker's whole Railway project, is gone. For
putting old data back into a running tracker, `RESTORE.md` is enough.

A copy of this file is saved to Backblaze every night
(`projects/rrfab-project-tracker/recovery/RECOVERY.md`), so it is there even if
GitHub is not. No passwords or keys are in this file. Those live in Railway's
variables and in Steve's password manager.

## What the tracker is made of

| Piece | Where it lives today |
|---|---|
| Code | GitHub `steverrfab/rrfab-project-tracker`, branch `main` |
| Web app | Railway project "RR Project Tracker", service `rrfab-project-tracker` (Node 20, built from `Dockerfile`) |
| Database | Railway service `Postgres`, PostgreSQL 18 |
| Uploaded files | Railway volume on the web service, mounted at `/data` (`/data/uploads`) |
| Address | `jobs.rrfabrication.org` (custom domain on Railway, port 8080) plus `rrfab-project-tracker-production.up.railway.app` |
| Offsite backups | Backblaze B2 bucket `steve-software-backups-20260925`, folder `projects/rrfab-project-tracker/` |
| Extra backup copy | SharePoint, `RR_Tracker_Backups` folder on the Operations site |

## Backups: what, when, where

| Job | When | What |
|---|---|---|
| Backblaze (`b2backup.js`) | 07:37 UTC nightly (3:37 AM EDT / 2:37 AM EST) | `pg_dump` of the database + zip of `/data` |
| SharePoint (`backup.js`) | 3 AM Eastern nightly | JSON export of the database + zip of `/data` |

Backblaze layout, under `projects/rrfab-project-tracker/`:

```
database/daily/    rrfab-project-tracker_<db>_<YYYY-MM-DD>_<HHMM>UTC.dump  (+ .manifest.json)   kept 30 days
database/weekly/   same, first run each Monday                                                    kept 12 weeks
database/monthly/  same, first run each month                                                     kept 12 months
files/daily|weekly|monthly/   rrfab-project-tracker_files_<...>.zip  (everything in /data/uploads)
recovery/RECOVERY.md          this file
```

Old copies expire through B2 lifecycle rules on each folder. The app's key
cannot delete anything. Each manifest lists checksums and the row count of every
table at backup time.

## Variables the web service needs (names only)

Required:
- `DATABASE_URL`: from the Postgres service (`${{Postgres.DATABASE_URL}}`)
- `TRACKER_KEY`: shared key for R&R Bid, ShopTrack and backup calls. Must match the same value on the rrfab-bid service.

Integrations:
- `BID_API_URL`, `BID_TOOL_URL`, `BID_SYNC`: R&R Bid link (won jobs, change orders, nightly sync, SSO sign-in)
- `SHOPTRACK_URL`, `SHOPTRACK_KEY`: shop hours and labor cost
- `SSO_ONLY`: `1` makes everyone but the Super Admin sign in through R&R Bid
- `PUBLIC_URL`, `COMPANY_NAME`: links and names in emails

Email (optional; off today): `AZURE_SENDER_USER`, `AZURE_SENDER_DISPLAY`, or `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`

Microsoft app sign-in (SharePoint backup, emails): `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`

SharePoint backup: `BACKUP_SP_SITE`, `BACKUP_SP_FOLDER`, `BACKUP_SP_LIBRARY` (optional), `BACKUP_KEEP_DAYS` (optional)

Backblaze backup: `B2_BACKUP_ENABLED`, `B2_BACKUP_ENDPOINT`, `B2_BACKUP_REGION`, `B2_BACKUP_BUCKET`, `B2_BACKUP_PREFIX`, `B2_BACKUP_KEY_ID`, `B2_BACKUP_SECRET`, `B2_BACKUP_UTC_TIME` (optional), `B2_BACKUP_ALERT_TO`, `B2_BACKUP_ALERT_FROM`

Other: `JWT_SECRET` (optional; if unset the login key is kept in `/data/jwt_secret` and a new one is made on a fresh volume, which just signs everyone out once), `PGSSL=require` only when connecting over a public database URL.

Railway sets `PORT`, `RAILWAY_VOLUME_MOUNT_PATH` and the deploy IDs itself.

## Scheduled jobs (all inside the web service, no separate workers)

- R&R Bid catch-up sync: at startup and nightly after 2 AM Eastern
- SharePoint backup: 3 AM Eastern
- Backblaze backup: 07:37 UTC, with a check every minute that emails an alert if there has been no good backup for 26 hours
- There are no webhooks in. R&R Bid and ShopTrack call `/api/integration/*` with `X-Integration-Key: TRACKER_KEY`.

## Rebuild, step by step

1. **New hosting project.** On Railway (or any host that runs a Dockerfile),
   create a PostgreSQL 18 database and a web service from the GitHub repo. It
   builds with the `Dockerfile`. Give the web service a volume mounted at `/data`.
2. **Variables.** Set the variables above. Secrets come from Steve's password
   manager or the original sources (Azure app registration, Backblaze, the
   rrfab-bid service for `TRACKER_KEY`).
3. **First start.** Deploy once. On an empty database the tracker creates its
   tables (`[migrate] Schema applied` in the logs). You can skip this and let
   `pg_restore` create everything instead (step 4).
4. **Load the database.** Download the newest `.dump` from
   `database/daily/` in Backblaze. With PostgreSQL 18 client tools:
   ```
   pg_restore --no-owner --no-privileges --clean --if-exists -d "<new database URL>" rrfab-project-tracker_railway_<date>.dump
   ```
   `--clean` replaces the tables that step 3 created. Compare a few row counts
   with the `tableRowCounts` in the matching `.manifest.json`.
5. **Put the files back.** Download the matching `files/daily/...zip`, unzip it,
   and copy its `uploads` folder to `/data/uploads` on the new volume (for
   Railway: `railway ssh` into the service). File names must not change.
6. **Domain.** Add `jobs.rrfabrication.org` as a custom domain on the new
   service, then update its DNS record (a CNAME at the domain's DNS provider) to
   the target the host shows. Wait for the certificate.
7. **Point the other apps at it.** Update `TRACKER_API_URL` on rrfab-bid (and
   ShopTrack's tracker URL) if the address changed.
8. **Check.** Log in as the Super Admin, open a few jobs and a pay app, open an
   attachment, and run a manual backup:
   `curl -X POST -H "X-Integration-Key: <TRACKER_KEY>" https://jobs.rrfabrication.org/api/integration/backup`

## Restore tests

| Date | Backup used | Result |
|---|---|---|
| 2026-09-27 | Test dump from a local copy of the schema (before first live run) | pg_restore into an empty PostgreSQL database; row counts and contract totals matched |
