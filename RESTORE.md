# Restoring the Project Tracker from a backup

Every night at 3 AM Eastern the tracker saves two files to SharePoint, in the
`RR_Tracker_Backups` folder:

- `rr-tracker-db-<date and time>.json.gz` is the whole database: every job,
  pay app, change order, user and note.
- `rr-tracker-files-<date and time>.zip` is every uploaded file: pay apps,
  drawings and other documents attached to jobs.

The time in the name is UTC, so a 3 AM Eastern backup is stamped 07-00Z in
summer and 08-00Z in winter. The last 30 days are kept.

You will need: a computer with Node.js and the tracker code
(`git clone https://github.com/steverrfab/rrfab-project-tracker`, then
`npm install` in that folder), and the connection string of the database you
are restoring into. In Railway that is the Postgres service's
`DATABASE_PUBLIC_URL` variable (use the public one when running from your own
computer).

## 1. Pick the backup

Open the `RR_Tracker_Backups` folder in SharePoint and download the
`rr-tracker-db-...json.gz` file from the night you want. Leave it zipped. If you
also need the attachments, download the `rr-tracker-files-...zip` with the same
date.

## 2. Get an empty database with the tracker's tables

In Railway, add a new Postgres database (or use the existing one if you are
putting old data back on purpose). Point the tracker service's `DATABASE_URL` at
it and let the tracker start once. On startup it creates all its tables in an
empty database. You can see `[migrate] Schema applied` in the deploy logs.

## 3. Load the backup

From the tracker folder on your computer:

```
DATABASE_URL="<the database's public URL>" PGSSL=require node restore.js rr-tracker-db-2026-09-25T07-00-00Z.json.gz --yes
```

(On Windows PowerShell, set the variables first:
`$env:DATABASE_URL="..."; $env:PGSSL="require"`, then run the `node restore.js ...` line.)

It prints each table and how many rows went in, then `Restore finished.`

What to know:

- **It replaces what is in that database.** Anything already in the tables is
  wiped first. `--yes` is there so you cannot do this by accident.
- **All or nothing.** If anything goes wrong it says `Restore FAILED, nothing was
  changed`, and the database is exactly as it was.
- **Older backups load into a newer tracker.** A column that no longer exists is
  skipped with a note; a column added since the backup gets its normal default.

## 4. Put the attachments back (if needed)

Unzip the `rr-tracker-files-...zip`. It holds an `uploads` folder. That folder
goes on the tracker's Railway volume (mounted at `/data`), so the files end up in
`/data/uploads`. The easiest way is the Railway CLI:
`railway ssh` into the tracker service and copy the files in, or ask Claude to do
it. File names must stay exactly as they are; the database refers to them by
name.

## 5. Check it

Restart the tracker in Railway. Everyone has to log in again once (the login key
is deliberately not in the backup). Open a few jobs and a pay app to confirm
numbers and attachments are there.

## Running a backup by hand

Before a risky change, you can take one on the spot:

```
curl -X POST -H "X-Integration-Key: <TRACKER_KEY>" https://<tracker address>/api/integration/backup
```

It answers when done, with what it saved. The same address with GET (no `-X
POST`) shows the last run and whether anything is missing from the setup.
