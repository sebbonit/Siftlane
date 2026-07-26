# Release security runbook

Siftlane uses two separate trust systems:

- Operating-system code signing identifies the publisher of macOS and Windows bundles.
- The Tauri updater key signs update payloads and is verified by the public key embedded in
  `src-tauri/tauri.conf.json`.

Treat their private keys independently and never store them in the repository.

## Release preflight

1. Run every local CI gate documented in `AGENTS.md`.
2. Run `pnpm version:check`.
3. Run the real-server protocol tests in `docs/integration-testing.md`.
4. Confirm the release workflow resolved the intended version and synchronized all build metadata.
5. For macOS, configure `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_ID`,
   `APPLE_PASSWORD`, and `APPLE_TEAM_ID` as GitHub Actions secrets. Verify the published `.app`
   with `codesign --verify --deep --strict` and `spctl --assess --type execute`.
6. For Windows, configure an Authenticode certificate or Azure Artifact Signing using Tauri's
   supported `signCommand`. Verify both the executable and installer with `Get-AuthenticodeSignature`.
7. Install each platform artifact on a clean machine, then test an update from the previous release.

Unsigned builds may still be produced while signing credentials are unavailable, but they must be
called out explicitly in the release notes and must not be described as notarized or trusted.

## Updater-key rotation

1. Generate the replacement updater keypair offline.
2. Store the new private key and password as new repository secrets; retain the old private key in
   offline recovery storage.
3. Publish a bridge release signed by the old private key whose embedded updater public key is the
   new public key.
4. Confirm the bridge release installs from the previous stable release on all platforms.
5. Switch the release workflow secrets to the new private key.
6. Publish and verify a second release signed by the new key.
7. Keep the bridge release available indefinitely. Clients older than the bridge cannot validate
   releases signed only by the new key.

Never replace the embedded public key and signing private key in a single release; existing clients
would reject that update.

## Rollback

The updater compares semantic versions, so do not move or overwrite an existing tag. To roll back:

1. Fix or revert the offending source on `main`.
2. Publish a new patch version with release notes identifying the regression.
3. Keep the broken release assets available until the replacement has propagated, because clients
   may already have cached its `latest.json`.
4. If an updater signing key is suspected compromised, stop publishing, remove `latest.json` from
   the affected release, rotate through the last trustworthy bridge release where possible, and
   publish manual-install guidance.
