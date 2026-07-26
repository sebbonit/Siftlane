# Protocol integration testing

The normal Rust suite compiles the protocol interoperability tests but leaves them ignored because
they require disposable servers. Run them before a stable release and whenever authentication,
transfer, resume, metadata, or TLS behavior changes.

## SFTP

Configure a test-only account whose root can be modified:

```sh
export SIFTLANE_TEST_SFTP_HOST=127.0.0.1
export SIFTLANE_TEST_SFTP_PORT=2222
export SIFTLANE_TEST_SFTP_USERNAME=siftlane
export SIFTLANE_TEST_SFTP_PASSWORD=test-only-password
export SIFTLANE_TEST_SFTP_ROOT=/upload
cargo test -p siftlane-sftp --test interop -- --ignored --nocapture
```

The harness accepts the configured test server's host key only inside the ignored test. Production
host-key verification is unchanged.

## FTP and explicit FTPS

```sh
export SIFTLANE_TEST_FTP_HOST=127.0.0.1
export SIFTLANE_TEST_FTP_PORT=2121
export SIFTLANE_TEST_FTP_USERNAME=siftlane
export SIFTLANE_TEST_FTP_PASSWORD=test-only-password
export SIFTLANE_TEST_FTP_ROOT=/upload
export SIFTLANE_TEST_FTP_SECURITY=plain # or explicit_tls
cargo test -p siftlane-ftp --test interop -- --ignored --nocapture
```

Each test creates a process-specific directory, writes a file in two chunks to exercise resume
offsets, reads it back, validates metadata, renames it, and removes all created data.
