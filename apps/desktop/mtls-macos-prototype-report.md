# macOS mTLS prototype results

Status: isolated feasibility prototype implemented and exercised on 2026-10-13. The installed Bitwarden app and Keychain permissions were not modified. This is not a production desktop integration or a successful authenticated mTLS connection.

The prototype establishes that the Chromium renderer path can offer Keychain identities, select the configured certificate, and report a local signing failure through Electron's network error event. It also confirms that identical certificate copies cannot be distinguished using Electron's offered certificate objects. A supported permission repair and an authenticated connection using the user's client identity remain release gates.

## Implemented scope

[Run instructions and source](../../scripts/macos-mtls-prototype/README.md) describe the self-hosted connection form, native identity inventory, and automatic probes. Common desktop modules under `src/platform/main/mtls` reuse the Flatpak endpoint and fingerprint-selection policy with a narrow configuration interface. NSS storage, import, deletion, and cleanup are absent from the macOS probe.

The probe performs one foreground connection per isolated session and process. It retains only temporary state, accepts an explicit offered identity, fetches a bounded `/config` response without account credentials, and displays a typed result. UI content is inserted as text, not interpreted certificate HTML. The result UI was rendered and visually inspected for the local signing failure.

## Runtime environment

| Component                          | Observed value                                |
| ---------------------------------- | --------------------------------------------- |
| macOS                              | 26.6.2, build 25G83                           |
| Architecture                       | arm64                                         |
| Electron                           | 43.5.0                                        |
| Probe runtime signature            | Ad-hoc; no Team ID                            |
| Installed Bitwarden bundle Team ID | `LTZ2PFU5D6`, from prior read-only inspection |
| Native inventory                   | Swift with public Security.framework APIs     |

The probe's signing identity differs from the installed Bitwarden release. It validates transport behavior and diagnosis, not release authorization. Signed Developer ID and Mac App Store builds still need their own runtime tests.

## Measured outcomes

| Test                                                            | Observation                                                                                                                                                                                                                          | Conclusion                                                                                              |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| Native inventory for `mbp.jans.space`                           | Two identities with identical leaf SHA-256 fingerprints, in `login.keychain-db` and `JansClientCerts.keychain-db`; private-key reference retrieval returned status zero                                                              | Duplicate identity copies exist; reference retrieval does not prove signing permission                  |
| TLS probe to `bitwarden.jans.space` with the target fingerprint | Two candidates offered in total, exactly one matching the target fingerprint; selected target; native signing returned `-25293` / `CSSMERR_CSP_OPERATION_AUTH_DENIED`; network event reported `ERR_SSL_CLIENT_AUTH_SIGNATURE_FAILED` | Selection works and local signing denial is reproduced; no successful mTLS authentication               |
| Same server without selecting an identity                       | `ERR_BAD_SSL_CLIENT_AUTH_CERT`, classified as client authentication failed                                                                                                                                                           | No implicit first-certificate fallback; this code alone does not establish the remote rejection details |
| Public `https://api.bitwarden.eu/config`                        | HTTP 200 and recognizable configuration, no client identity offered                                                                                                                                                                  | Ordinary HTTPS/configuration retrieval works through the probe renderer                                 |
| `https://expired.badssl.com/`                                   | `ERR_CERT_DATE_INVALID`, classified as server trust failed                                                                                                                                                                           | Server trust validation remains active and separate from local signing errors                           |
| Common policy tests                                             | Four tests passed, covering canonical endpoints, malicious schemes/userinfo, exact offered fingerprint, no cross-host fallback, malformed candidates/validity dates, expired/not-yet-valid certificates, and error/callback behavior | Common policy is reusable without NSS state                                                             |
| TypeScript check                                                | Standalone strict check passed against Electron 43.5 and Node types                                                                                                                                                                  | Probe and extracted modules typecheck; not a monorepo typecheck                                         |

Raw local runtime diagnostics stay in temporary directories, not in this repository. No account login, token retrieval, vault sync, or permission repair was performed.

## Additional findings from actual execution

### Certificate cancellation callback

Passing `undefined` explicitly to the certificate-selection callback raised **Must pass valid certificate object** on Electron 43.5. Calling it with no argument also failed in the tested macOS runtime. Passing explicit `null` successfully continued without a certificate. The [versioned native implementation](https://github.com/electron/electron/blob/v43.5.0/shell/browser/api/electron_api_app.cc) explicitly accepts null even though the public TypeScript signature describes only an optional certificate.

`certificate-callback.ts` isolates that compatibility conversion. The selected-certificate and no-certificate paths were both exercised. When reconciling the Flatpak implementation, audit its `callback(certificate)` path for undefined rather than blindly applying a macOS-specific assumption; validate the deployed Linux runtime separately.

### Native inspection can itself require permission

An initial inventory attempted to derive public-key bytes using `SecKeyCopyPublicKey` on a private-key reference. It blocked in Keychain ACL access and launched SecurityAgent despite the query's no-interaction context. Process sampling located the blocked call, and the probe was stopped without authorizing the prompt. The final inventory omits this operation and completes with certificate data, identity key references, and Keychain locations. It performs no signing or private-key export.

Consequently, native checks must run outside the UI thread with an operation/process deadline. A no-interaction flag on the initial query must not be assumed to govern every later Security.framework call. Certificate/key correspondence and signing tests require a deliberately authorized, separately scoped operation if needed.

### Exact duplicate selection remains unavailable

The native inventory returned two copies of the target certificate. Electron offered only one matching target fingerprint. Its [selection callback implementation](https://github.com/electron/electron/blob/v43.5.0/shell/browser/api/electron_api_app.cc) reconstructs a certificate from supplied bytes and matches identities by certificate equality, then acquires the associated private key. Returning additional application metadata does not select another Keychain copy.

This prevents a reliable permission-repair target from being derived solely from the certificate event. The prototype does not claim which of the two key copies signed or attempted to sign. A native identity panel alone cannot solve this transport limitation. Exact-copy control would require an established transport/native integration mechanism or explicit management of the user's duplicate identities by the user, not automatic broad key changes.

## Feasibility decision

Proceed with a common desktop selection/diagnostic layer and platform-specific identity sources. The Flatpak policy, main-process coordination, and public UI contracts can be shared; its NSS ownership and helper code do not belong in macOS.

For an initial macOS feature, expose fingerprint-based binding and real connection testing, describe duplicate-copy ambiguity, and provide actionable local signing errors. Do not offer permission repair until public APIs can authorize the exact signing key with a verified process signature, explicit consent, and preservation of existing ACL entries. The prototype establishes no supported partition-list repair; the private password-authenticated API from the user's local repair remains excluded.

The production integration still needs:

1. Shared capability/result contracts and the actual Angular self-hosted/settings UI, coordinated with the Linux PR.
2. Secure binding persistence and staged Save/Cancel behavior, including the Linux PR's file-read warning requirements.
3. Signed build tests, certificate-cache activation behavior, and a successful mTLS connection with a user-authorized identity.
4. Sync, icons, identity endpoints, HTTPS/XHR/resource loads, and notification WebSocket coverage in the real desktop app.
5. Adversarial IPC, concurrency, timeout, and filesystem tests for the integrated implementation.
6. A separate feasibility decision on duplicate-key control and supported authorization before any permission-mutation capability.

See [the concept](mtls-macos-concept.md) for the detailed architecture and acceptance matrix. These are integration and release gates, not claims already satisfied by the standalone probe.
