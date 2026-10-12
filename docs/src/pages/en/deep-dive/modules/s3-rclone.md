# S3 rclone Module

The S3 rclone module adapts the S3 backend for `rclone serve s3`. Enable it alongside the S3 module, select **S3** as the storage backend, and configure the endpoint, bucket, credentials, URL style, and prefix in the S3 settings. It requires Sync Engine 3.3.0 or later and an S3 module that exposes `getMeta()`.

The adapter applies while S3 is selected and encryption is disabled. With encryption enabled, file metadata remains in the encryption module's format.

## Modification Times

Uploads convert the `mtime` metadata from milliseconds to rclone's seconds format, preserving millisecond precision: `1700000123456` becomes `1700000123.456`. Both direct and streamed uploads use this conversion. Creation time (`ctime`) and other metadata remain unchanged.

**Prefer metadata modification time on download** is disabled by default. Downloads normally restore the standard remote stat modification time. When enabled, valid `x-amz-meta-mtime` values take precedence; missing or invalid values fall back to the remote stat time. Numeric seconds and ISO timestamps are accepted and converted to milliseconds for the local file. The remote stat's modification time and UID remain unchanged for sync comparisons.

## Directories

Empty directories are omitted from both local and remote listings, including trees containing only empty directories. A directory containing a zero-byte file is retained. The adapter does not upload directory marker objects; remote listings infer parent directories from file paths so downloads can create the directories needed by those files. Listing exclusions also apply to inferred directories.

## Implementation

The module registers local and remote file-system wrappers at priority `500`, before S3 prefix mapping. The local wrapper filters empty directories. The remote wrapper converts metadata, filters empty directory markers, infers missing parents, and makes `mkdir()` a no-op. Remote folder move tasks also skip marker operations; the sync plan moves their child files separately. Downloads use the underlying S3 `getMeta()` method to retrieve original remote metadata, including when the supplied stat comes from the sync cache.
