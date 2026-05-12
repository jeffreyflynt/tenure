# Backup & Restore

Your world model lives entirely on your machine. Tenure never phones home, which
means there is no cloud backup to fall back on. If you value your belief history,
export it periodically.

## What gets exported

A full export includes active and superseded beliefs, runtime config (including
provider keys), persona cache, and compaction history. The UI shows a preview of
exactly what will be included before you confirm.

## Exporting

Open `http://localhost:5757/admin/backup` and click **Export**. You'll see a
preview of what will be included, then the archive downloads directly to your
browser's downloads folder.

For scripted or automated backups, you can also use the API:

```bash
curl -X POST http://localhost:5757/v1/backup/export \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"passphrase": "my-secure-passphrase"}' \
  --output ~/tenure-backup.enc
```

The output is a single passphrase-encrypted archive. The raw encryption keys are
not included — the archive is safe to store in Dropbox, email to yourself, or
put on a USB stick.

Store the passphrase somewhere you won't lose it. Without it the archive cannot
be decrypted.

## Restoring

### From the UI (recommended)

On the new machine, start Tenure and open `http://localhost:5757/admin/backup`.
Use the **Import** button to upload your archive and enter your passphrase.

### From the API

On Linux and macOS:

```bash
ARCHIVE=$(base64 < ~/tenure-backup.enc)
curl -X POST http://localhost:5757/v1/backup/import \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"passphrase\": \"my-secure-passphrase\", \"archive\": \"$ARCHIVE\"}"
```

On Windows (PowerShell):

```powershell
$archive = [Convert]::ToBase64String([IO.File]::ReadAllBytes("$env:USERPROFILE\tenure-backup.enc"))
Invoke-RestMethod -Uri "http://localhost:5757/v1/backup/import" `
  -Method Post `
  -Headers @{ Authorization = "Bearer $TOKEN" } `
  -ContentType "application/json" `
  -Body (ConvertTo-Json @{ passphrase = "my-secure-passphrase"; archive = $archive })
```

> **Note:** For large archives, the UI import is more reliable than the API on
> Windows. The PowerShell approach above loads the entire archive into memory.

A successful restore returns:

```json
{
  "ok": true,
  "result": {
    "beliefs_imported": 142,
    "beliefs_skipped": 0,
    "compaction_entries_imported": 5,
    "persona_restored": true,
    "config_restored": true
  }
}
```

A successful restore gives you a fully working instance: beliefs, provider
credentials, and persona all intact. No re-onboarding required.

Import is safe to run multiple times — existing beliefs are skipped rather than
duplicated.

## If you never exported

If your disk fails without a backup, your world model is unrecoverable. Tenure's
encryption means even the raw database files are unreadable without the keys,
which lived on the same machine.

The export takes about ten seconds. Do it before anything risky.
