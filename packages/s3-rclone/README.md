# S3 rclone

Optional adapter for `rclone serve s3`. Enable it alongside the updated S3 backend on Sync Engine 3.3.0 or later. The module specification is in `docs/src/pages/en/deep-dive/modules/s3-rclone.md`.

Run scripts directly from this package to avoid rebuilding SDK declarations:

```sh
bun fix
bun check
bun tests
bun compile
```

The adapter tests cover timestamp restoration, missing and invalid metadata, empty directory filtering, and module cleanup. S3 integration tests in `packages/s3/test/fs-s3.test.ts` cover timestamp headers for direct, buffered, and multipart uploads through a configured prefix.
