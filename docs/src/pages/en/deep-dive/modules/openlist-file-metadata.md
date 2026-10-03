# OpenList File Metadata

OpenList File Metadata is an optional module that preserves file times when transferring files through OpenList's S3 or WebDAV interface. Enable it alongside your existing backend module. It has no additional settings and uses that backend's connection configuration.

Files keep their existing names, paths, and contents. The module creates no remote metadata files and does not change the storage format. It applies to future transfers; enabling it does not repair dates on files that are already synchronized.

## Supported Times

| Interface | Upload                                                           | Download                                                                                 |
| --------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| S3        | `X-Amz-Meta-Mtime`, Unix seconds with millisecond precision      | Prefer `x-amz-meta-mtime`, falling back to `Last-Modified`; creation time is unavailable |
| WebDAV    | `X-OC-Mtime` and, when known, `X-OC-Ctime`, integer Unix seconds | Read `getlastmodified` and available `creationdate` properties                           |

Creation time is best effort. OpenList's S3 implementation does not persist the original creation time. WebDAV accepts a creation-time header, but whether it affects the stored file depends on the underlying driver and operating system. A returned creation date may be the server's creation time, not the original file's. Missing or invalid dates are not invented. Local creation-time restoration also depends on Obsidian's adapter and the operating system.

The module targets OpenList. Other servers that accept the same headers may work, but are not guaranteed. S3 custom metadata takes precedence over the HTTP date; external writers must keep that metadata current. OpenList can cache S3 custom metadata in memory, so successful readback alone does not prove that a storage driver will preserve it across a server restart.

## Transfer Behavior

Local discovery carries source times with each file's stats. Uploads associate those times with the exact remote object URL, including the backend endpoint and bucket. Concurrent transfers use separate entries. S3 signing and authentication remain in the backend request pipeline.

- S3 ordinary uploads and multipart initiation carry modification time. Individual parts and cleanup requests do not receive file-time headers.
- WebDAV ordinary uploads carry both available times. Nextcloud-style chunked uploads also carry them on the final `MOVE`; this does not add chunked-upload support to OpenList servers that lack it.
- Ordinary downloads restore times through the vault write request. Streamed downloads restore times after the final append and before moving the temporary file into place. The returned local file UID therefore describes the restored modification time.
- Generated content without source-time metadata, such as a new smart-merge result, uses normal write behavior.
- Failure and cancellation release per-transfer state. Disabling or unloading the module removes its registrations and stops time processing.

The remote filesystem wrapper runs at priority `500`, below memory control, optimization, prefix, encryption, and asymmetric-storage wrappers. It sees the actual backend keys without changing them. The local wrapper also runs at `500`; local request middleware runs at `3001`, and remote request middleware at `4001`. Existing cache wrappers retain the module's additional stat metadata for realtime fast mode.

## OpenList S3 Compatibility

Some OpenList versions return an empty ETag in listings or `HEAD`, a transient upload ETag, a multipart initiation root named `InitiateMultipartUpload`, or inconsistent modification dates between S3 responses. The module handles these responses without changing the S3 backend:

- Normalize the multipart initiation root to the standard result name.
- Treat empty ETags as absent and use the backend's modification-time/size identity.
- For listed files without a usable ETag, read `HEAD` metadata in batches of at most eight and supply a consistent modification date. These files require an additional request during traversal.
- Read the final stat after S3 uploads so the recorded identity matches later discovery. This prevents a successful upload from appearing as a new remote change on the following sync.

S3 streamed downloads also obtain headers before starting the local writer. Entries with usable listing ETags do not require additional traversal requests. All extra requests use the existing authentication, cancellation, retry, and rate-limiting pipeline.

## Verification

Unit tests cover request isolation, header placement, response compatibility, local write behavior, and module lifecycle. The repository's `scripts/verify-openlist-file-metadata.ts` additionally exercises the real S3 and WebDAV backends with normal files, empty files, a multipart file, special characters, rename, and overwrite. It checks content, restored modification time, and stable remote identities. Local files remain under `test-files`; the script removes its remote test files.

Run it with Bun and `--preload=./packages/openlist-file-metadata/test/mocks.ts`. Supply `OPENLIST_S3_ENDPOINT`, `OPENLIST_S3_BUCKET`, `OPENLIST_S3_ACCESS_KEY`, `OPENLIST_S3_SECRET_KEY`, `OPENLIST_DAV_ENDPOINT`, `OPENLIST_DAV_USERNAME`, and `OPENLIST_DAV_PASSWORD` through the environment. Credentials are not stored in the script.

The disk verification transport checks actual local modification times and the creation-time options passed to the writer. It does not emulate operating-system support for changing birth time or replace testing inside Obsidian.
