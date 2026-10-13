# macOS mTLS feasibility prototype

This isolated Electron application exercises the desktop Chromium TLS path with existing Keychain identities. It implements a self-hosted connection form, challenge-driven identity selection, cancellation, bounded unauthenticated configuration retrieval, and local signing diagnostics. It does not modify the installed Bitwarden app, save bindings, export private keys, import identities, or change Keychain permissions.

The native inventory uses public Security.framework APIs to read identity references and their file-based Keychain location. It deliberately does not call `SecKeyCopyPublicKey` on the private-key reference: that call triggered a Keychain authorization prompt in the initial experiment. It does not test signing permission. Some location APIs are public but deprecated; their use here is a feasibility probe, not an approved production dependency.

## Run the application

From the repository root on macOS, install the two isolated runtime dependencies outside the monorepo:

```sh
npm install --prefix /tmp/bitwarden-macos-mtls-runtime --no-audit --no-fund electron@43.5.0 esbuild@0.25.12
NODE_PATH=/tmp/bitwarden-macos-mtls-runtime/node_modules node scripts/macos-mtls-prototype/run.cjs
```

Enter an HTTPS `/config` URL, choose **Verbindung prüfen**, and select an offered identity. Each application instance performs one probe. Restart it for another test to avoid reusing cached TLS identity selections. The default URL is the user's test server; change it for another environment.

The runtime and UI use a temporary build directory, a temporary app-data directory, and a new in-memory session per launch. No existing Bitwarden profile is opened. Temporary probe artifacts are retained for local inspection; remove only those disposable directories when no longer needed.

For unattended tests, explicitly supply the fingerprint to select. Without a fingerprint, automatic mode continues without a certificate; it never picks the first candidate. A structured outcome is printed to stdout. Exit status zero means the probe completed, not that authentication succeeded: inspect `outcome`. Fatal startup or process timeout is nonzero. The process deadline is 40 seconds; the connection deadline after launch is 20 seconds.

```sh
NODE_PATH=/tmp/bitwarden-macos-mtls-runtime/node_modules node scripts/macos-mtls-prototype/run.cjs --automatic --url https://api.bitwarden.eu/config
NODE_PATH=/tmp/bitwarden-macos-mtls-runtime/node_modules node scripts/macos-mtls-prototype/run.cjs --automatic --fingerprint YOUR_LOWERCASE_SHA256_FINGERPRINT
```

Add `--screenshot` in automatic mode to capture the result UI into the temporary app-data directory; its location is printed. Electron's own stderr may include native diagnostic errors. The harness never outputs response bodies, passwords, cookies, or private-key material. Treat local diagnostic output and public identity metadata as personal troubleshooting data.

The downloaded Electron binary is ad-hoc signed without a Team ID on the tested Mac. It is not a signed Bitwarden release. A result from it cannot establish the permission behavior of Bitwarden's Developer ID or App Store builds.

## Inventory existing identities

```sh
xcrun swiftc scripts/macos-mtls-prototype/keychain-identities.swift -o /tmp/bitwarden-macos-mtls-runtime/keychain-identities
/tmp/bitwarden-macos-mtls-runtime/keychain-identities
```

Output contains public certificate fingerprints, subject summaries, reference status, and Keychain basenames. A key reference status of zero is not proof that signing is authorized. The command does not change the Keychain search list and only inventories identities visible in the current search scope. It uses a no-interaction authentication context and a 15-second process deadline. This context does not automatically apply to later native operations; the prototype avoids operations that were observed to prompt.

## Verify common policy

```sh
/tmp/bitwarden-macos-mtls-runtime/node_modules/.bin/esbuild scripts/macos-mtls-prototype/policy.test.ts --bundle --platform=node --format=cjs --outfile=/tmp/bitwarden-macos-mtls-runtime/policy.test.cjs
node --test /tmp/bitwarden-macos-mtls-runtime/policy.test.cjs
```

`endpoint.ts` and `selection.ts` originate from the Flatpak branch at `1a11ec63838379e6be41317eac02550509fa1700`. The prototype narrows their state types to public metadata and bindings, rejects invalid validity dates, and adds a common error classifier and an Electron callback compatibility boundary. There is no NSS database dependency in these modules. The Flatpak branch itself has not been modified; integrating the shared modules requires reconciling the imports and re-running its existing tests.

## Prototype boundaries

- The form exercises the proposed flow in a standalone application, not the production Angular dialog. Monorepo main/renderer/preload builds have not been validated by this probe.
- No persistence or registry-file reader is implemented, so there is no arbitrary file-read IPC. This does not close the Linux PR's existing registry warning. Secure persistence is a production integration task.
- The request runs in a sandboxed renderer with context isolation and no Node integration. IPC checks the window, main frame, exact local UI URL, live challenge, and opaque candidate ID. Navigation/popups and permissions are denied. Network access is limited to the selected TLS destination; redirects fail, credentials are omitted, and response bodies are capped at 64 KiB.
- Probe outcomes are diagnostic, not a hardened attestation from an untrusted renderer. A compromised renderer can falsify a successful response report, but cannot mutate a Keychain or read arbitrary files through the exposed IPC. A production implementation must define that trust boundary explicitly.
- No exact Keychain-copy selection or permission repair is implemented. Native enumeration and Electron's offered certificate list cannot establish which identical key copy Chromium uses.
- The main-process network error event provides the Chromium failure stage. OSStatus is visible in native runtime stderr in the observed failure, not automatically delivered as a structured Electron error. A partition mismatch must not be inferred from `-141` alone.

See [the runtime report](../../apps/desktop/mtls-macos-prototype-report.md) for measured results and the remaining feasibility gates.
