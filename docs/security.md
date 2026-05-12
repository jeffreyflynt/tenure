# Security & Backup

## Encryption at rest

Tenure encrypts the `content`, `why_it_matters`, and `source_exchanges` fields
of every belief using MongoDB client-side field-level encryption (CSFLE). The
database stores ciphertext only — plaintext is never written to disk.

Encryption is backed by two keys in `~/.tenure/`:

- **`master.key`** — wraps provider credentials and runtime config
- **`belief.key`** — wraps belief content encryption keys

Both are created on first start with mode `0600` and never leave your machine.
Tenure holds the keys; MongoDB never sees them.

## Backup and portability

Because Tenure is fully local, there is no cloud backup to fall back on. If you
value your world model, export it periodically.

From the admin UI or via the API:

```bash
POST /v1/backup/export
```

This produces a single passphrase-encrypted archive containing your beliefs,
runtime config, and persona cache. The raw keys are not included — the archive
is safe to store in Dropbox, on a USB stick, or anywhere you keep important
files.

To restore on a new machine:

```bash
POST /v1/backup/import
```

The server decrypts the archive, writes your beliefs into the new database, and
generates fresh keys for the new machine. No manual key copying required.

## What happens if you skip the export

If you never export and your disk fails, your world model is gone. This is the
same loss model as losing your `~/.ssh/` directory without a backup. Tenure
never phones home, which means there is no fallback.

The export takes seconds. Run it before you do anything risky with your machine.
