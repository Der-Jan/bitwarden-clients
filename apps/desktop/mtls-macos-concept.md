# macOS desktop mTLS with Keychain identities

Status: proposed design, 2026-10-12, with an isolated feasibility prototype tested on 2026-10-13. See [the prototype report](mtls-macos-prototype-report.md) for measured results and integration gates. No production desktop integration or Keychain permission changes are included.

The desktop app should let users configure a client identity while defining a self-hosted server, keep its private key in the macOS Keychain, and verify that the actual desktop TLS connection can use it. Certificate selection, private-key signing permission, and server acceptance are separate outcomes. A saved URL or an offered certificate is not proof of a working connection.

The proposed first version includes identity selection, connection testing, endpoint bindings, and actionable diagnostics. Permission repair is a separate capability that must demonstrate a supported Apple authorization flow before shipping. Private Apple APIs are excluded.

## Existing implementation and reuse

The inspected desktop main branch has no application-owned client-certificate selection dialog. The shared `SelfHostedEnvConfigDialogComponent.submit` validates URL fields and saves the environment without testing the connection. `DefaultConfigService.renewConfig` logs failed configuration retrieval and emits cached configuration. These behaviors can defer visible connection errors until a later operation such as sync; they do not establish the specific cause of an installed app's failure.

The Linux implementation in [PR 23638](https://github.com/bitwarden/clients/pull/23638), inspected at commit `1a11ec63838379e6be41317eac02550509fa1700`, provides useful contracts and policy:

- `ClientCertificateSettingsService` and its desktop adapter connect the shared Angular UI to main-process management.
- `ClientCertificateManagerComponent` is reachable before login from the self-hosted dialog and later from desktop settings.
- `MtlsMain` handles `select-client-certificate`, validates IPC senders, and selects from Electron's offered certificate objects.
- Endpoint normalization and fingerprint matching restrict identity use to a canonical TLS host and port.
- The registry separates active and pending configuration and requires restart to apply changes.

These files are on the Linux branch, not prerequisites already present on this documentation branch. Coordinate shared changes with that PR rather than copying its complete implementation into macOS.

| Concern             | Linux Flatpak                         | Proposed macOS behavior                                                     |
| ------------------- | ------------------------------------- | --------------------------------------------------------------------------- |
| Identity source     | App-private NSS store                 | Existing accessible Keychain identities                                     |
| Initial setup       | PKCS#12 import                        | Select an identity offered during a TLS challenge                           |
| Private key         | Managed NSS storage                   | Remains in its existing Keychain                                            |
| Persistent app data | Import ownership, cleanup, bindings   | Endpoint bindings and public metadata; scoped identity references if needed |
| Remove action       | Remove an app-owned imported identity | Remove the app binding only                                                 |
| Permission control  | NSS store policy                      | Keychain ACL and signing-process authorization                              |

The inspected checkout pins Electron 43.5.0. Its [versioned API documentation](https://github.com/electron/electron/blob/v43.5.0/docs/api/app.md#event-select-client-certificate) describes selection for WebContents requests and default use of the first matching certificate when the application does not override selection. Chromium's [macOS certificate store](https://github.com/chromium/chromium/blob/main/net/ssl/client_cert_store_mac.cc) enumerates Keychain identities and filters candidates for client authentication. These mechanisms provide a transport foundation, not a complete permission or selection UI.

## Shared code architecture from the Flatpak design

Use the Flatpak design as the baseline for one desktop mTLS feature. The relevant sources are its [detailed concept](https://github.com/Der-Jan/bitwarden-clients/blob/1a11ec63838379e6be41317eac02550509fa1700/apps/desktop/mtls-detailed-concept.md), [implementation plan](https://github.com/Der-Jan/bitwarden-clients/blob/1a11ec63838379e6be41317eac02550509fa1700/apps/desktop/mtls-implementation-plan.md), and [prototype report](https://github.com/Der-Jan/bitwarden-clients/blob/1a11ec63838379e6be41317eac02550509fa1700/apps/desktop/mtls-prototype-report.md). Their NSS store requirements apply to Flatpak; their endpoint policy, main-process ownership, IPC validation, configuration lifecycle, and shared UI apply to both platforms.

Extend and extract the existing code incrementally instead of creating a second macOS manager with duplicated endpoint or selection logic. Keep desktop transport policy in the desktop application; shared Angular components and public DTOs stay in their existing libraries. Platform-specific code belongs behind the desktop coordinator, not scattered through the shared dialog.

| Existing Linux component            | Common responsibility to retain                                                                                             | Platform-specific responsibility                                                |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `endpoint.ts`                       | Normalize configured and challenge endpoints                                                                                | None; reuse its tests on both platforms                                         |
| `selection.ts`                      | Validate binding and validity; match offered leaf DER fingerprint; never substitute an identity                             | Exact Keychain-copy resolution remains a macOS feasibility gate                 |
| `MtlsMain`                          | Register challenge handler, verify request ownership, complete callbacks, coordinate drafts and IPC                         | Delegate NSS operations or native Keychain diagnostics to the chosen adapter    |
| `MtlsRegistry`                      | Binding/public-metadata persistence, schema checks, revisions, serialization, active/pending snapshots and safe file access | NSS `storeId`, import ownership and cleanup journal remain Linux-only           |
| `MtlsBackend` and `mtls_helper`     | Bounded operation/result contracts where applicable                                                                         | NSS inspection/import/deletion remains Flatpak-only; macOS does not emulate it  |
| `ClientCertificateSettingsService`  | One UI contract, capability discovery, binding operations, probe and status results                                         | Desktop adapter exposes only supported operations                               |
| `ClientCertificateManagerComponent` | One manager for bindings, public metadata, replacement and error display                                                    | Import controls for Flatpak; system selection and key-access guidance for macOS |
| Preload and window guards           | Narrow IPC channels and trusted sender/session checks                                                                       | Native calls and packaging vary by platform                                     |

The common selection module should accept a narrow view containing bindings and public identity metadata rather than require NSS store fields. The same matching function can select from Electron's offered objects on either platform. Extend the existing tests rather than maintain parallel macOS copies.

Separate certificate ownership from endpoint configuration. The common registry records public certificate metadata and bindings; it never stores private keys. Flatpak additionally owns imported identities and keeps its durable NSS cleanup journal. macOS records existing identities only as references/metadata and does not acquire ownership of them. Removing metadata or a binding on macOS must not invoke a generic backend deletion method that deletes a Keychain key.

Do not simply remove `storeId` or `cleanup` from the current Linux schema: those fields coordinate NSS recovery. If a shared persistence abstraction is extracted, preserve the Linux schema or provide an explicit migration with recovery tests. A common validated file-access utility should apply to both registries so fixes for the Linux file-read finding are not duplicated or lost.

The platform boundary needs capabilities and operations for obtaining/selecting identities, optional import, optional app-owned deletion, optional native key diagnostics, and change activation. The shared coordinator owns binding policy and UI drafts; the platform adapter owns store-specific side effects. Use capability-specific interfaces or a discriminated backend contract so unsupported operations cannot accidentally mutate system identities. A Keychain adapter must not require an import password, NSS database, NSS helper, or cleanup journal merely to select an existing identity.

Keep common change results such as revision and activation state distinct from platform operation results. Start with the Linux restart model for shared binding changes unless live macOS activation is demonstrated; the capability can later permit safe live activation. Keep Linux import transactions and macOS TLS-selection drafts separate internally while presenting the same Save/Cancel and conflict behavior to the user.

New error codes for local signing, access denial, ambiguous identity copies, and probes extend the existing typed result contract. Shared UI renders them consistently; only the macOS adapter supplies Keychain-specific detail. Likewise, connection testing can benefit Flatpak without routing its private-key management through macOS APIs.

Integrate in this order: reuse endpoint/selection logic and tests, generalize public capabilities/results, extract the coordinator from NSS-specific management, and then add the Keychain adapter. Preserve the tested Flatpak import/bind/restart/remove workflow throughout. Avoid importing Linux helper binaries, store initialization, or private-key storage into the macOS package.

## Local diagnosis supplied by the user

The following evidence concerns the user's Mac and is an acceptance scenario for the design, not a general diagnosis for every mTLS failure:

- Safari authenticated successfully. Chrome failed with `ERR_SSL_CLIENT_AUTH_SIGNATURE_FAILED`.
- Chrome NetLog recorded `SSL_CLIENT_CERT_PROVIDED`, then `SSL_PRIVATE_KEY_OP` using provider `SecKey` and algorithm `rsa_pss_rsae_sha256`, followed by error `-141`.
- macOS logs reported `ACL partition mismatch`, a partition list containing only `apple:`, and `SecKeyCreateSignature` failure with OSStatus `-25293` / `CSSMERR_CSP_OPERATION_AUTH_DENIED`.
- The visible setting allowing all applications access did not remove this additional signing restriction. Direct RSA-PSS and RSA-PKCS1 signing tests succeeded and matched the certificate, so the key was intact. Reissuing and importing a new PKCS#12 identity reproduced the restriction.
- A targeted local partition-list amendment resolved the observed access denial. Existing entries were retained: `apple:`, Google `teamid:EQHXZ8M8AV`, Firefox `teamid:43AQ936H96`, and Helium `teamid:S4Q33XPHB4`.
- A Bitwarden attempt produced `ACL partition mismatch: client teamid:LTZ2PFU5D6`; that entry had not been added for Bitwarden. Read-only inspection of `/Applications/Bitwarden.app` with `codesign -dv --verbose=4` also reported `TeamIdentifier=LTZ2PFU5D6`. This reports the inspected bundle's identifier, not a complete signature-validity assessment or a guarantee about other builds or helper processes.
- The identity `mbp.jans.space` existed in both `login.keychain-db` and `JansClientCerts.keychain-db`.

The user's repair read access rules with `SecKeychainItemCopyAccess` and `SecAccessCopyACLList`. `SecKeychainItemSetAccess` failed with `-25293`; password-authenticated `SecKeychainItemSetAccessWithPassword` succeeded after a local hidden password prompt. The latter is a private Apple API and must not be used by the product.

For this incident, Vaultwarden was healthy and Traefik enforced mTLS for `bitwarden.jans.space` before HTTP access. Authentik ForwardAuth was not part of that route. The server trusted `Jans Intermediate ClientAuth CA` and `Jans Root CA`. The observed Chrome error occurred locally before the server could verify the client signature.

## User interaction

The self-hosted configuration dialog is the primary entry point. Desktop settings expose the same binding management for later changes.

1. The user enters the base URL and any custom service URLs.
2. The user chooses **Test connection** or **Choose client certificate**. Both initiate a controlled connection to the relevant configured endpoint.
3. If the server requests client authentication and no usable binding exists, show offered identities with subject, issuer, validity, fingerprint, and target host and port. Require an explicit choice even when only one candidate is offered.
4. macOS may separately request permission to use the private key. Such a prompt is not guaranteed to resolve a partition restriction; its outcome must be checked by completing the connection.
5. Complete the TLS handshake and fetch the effective API `/config` without Bitwarden account credentials. Show TLS success separately from a valid Bitwarden configuration response.
6. On Save, commit the edited environment and bindings as one logical configuration change. On Cancel, discard drafts and retain previous persistent configuration. Tear down test connections and prevent a cancelled draft from becoming runtime policy.

A connection failure leaves the dialog open with a diagnosis and retry action. Users may explicitly save an unverified configuration for offline setup, but the UI must retain an **Unverified** status rather than imply successful connectivity. If a successful test exists, its status applies to the tested endpoints and time, not indefinitely to every service.

An existing saved binding is reused for normal traffic without repeated selection prompts. Background sync reports a deduplicated status with **Review client certificate** rather than opening dialogs repeatedly. Foreground retry can enter the controlled selection flow. Offline vault use remains available.

## Transport and selection policy

Register selection policy before application networking begins. Keep the original offered certificate objects in the main process; expose only bounded public metadata and temporary opaque candidate IDs to the renderer. A selection reply must reference the same live challenge, trusted sender, and approved endpoint. Complete each Electron callback exactly once, including cancellation, timeout, window destruction, and unexpected errors.

Use a controlled renderer request in the managed desktop session for the Electron 43.5 prototype. Support for emitting the app selection event on main-process `net` requests is documented as an [Electron 44 change](https://www.electronjs.org/docs/latest/breaking-changes#behavior-changed-webcontents-may-be-null-in-select-client-certificate). Do not assume `net.fetch` in this checkout follows the same selection flow. Node `fetch` is also not a substitute for the Chromium transport.

Bindings authorize a canonical TLS destination, `host:port`. HTTPS and WSS to the same destination share TLS identity policy; a path does not isolate identities. Accounts using that destination share its binding, including before login. Explain this scope when configuring the certificate.

Resolve effective API, identity, icons, notifications, and other configured service URLs using the environment's existing rules. Do not automatically authorize a new host reached by redirect or a different custom service host. Require explicit bindings for those destinations and avoid forwarding account credentials during setup probes. Reject credentials in URLs and unsupported schemes.

Return only a certificate from the actual offered list. Never select a different identity when a configured one is missing, expired, or not offered. An unbound challenge continues without a certificate unless a user-initiated selection draft authorizes one. Normal server-certificate verification remains enabled; configuring a client identity must not add its CA to server trust or bypass verification.

Candidate choices and test connections need bounded lifetimes. Define the scope of temporary bindings in an implementation spike: if Chromium cannot isolate the draft from concurrent traffic in the managed session, use a controlled separate session and explicitly validate activation in the production session after Save. Never silently expose the draft to unrelated requests.

## Keychain identity copies and native integration

An identity consists of a certificate and its corresponding private key. Native inspection must resolve the key from the selected identity and establish that its public key matches the certificate; it must not export the private key.

A certificate fingerprint identifies certificate bytes, not a specific Keychain copy. Chromium's macOS store deduplicates identical certificates across Keychains. Electron's offered certificate objects do not provide a reliable selector for the underlying Keychain and private-key item. Therefore the first implementation cannot promise that choosing a fingerprint chooses a particular duplicate copy.

If native diagnostics or permission changes are added, maintain separate identifiers:

- The certificate fingerprint identifies the endpoint binding.
- A Keychain-scoped identity reference identifies a particular local certificate/key pair. Treat persistent references as opaque, local, potentially stale data; re-resolve and validate them before use. Keep them out of general renderer storage and sync.
- A temporary main-process candidate ID authorizes a UI operation on a previously enumerated object, not an arbitrary Keychain path supplied by the renderer.

Display the Keychain name when native enumeration can establish it. Before any mutation, prove that the target is the key used by the desktop TLS operation. If that relationship cannot be established, return an ambiguity error and perform no mutation. A native list or test signature in another process is insufficient proof.

This is a feasibility gate: determine whether supported APIs and the deployed Electron version can expose/control the exact duplicate identity, or whether a transport change is required. Do not assume that returning a matching certificate to Electron controls the underlying key copy.

Apple provides [SFChooseIdentityPanel](https://developer.apple.com/documentation/securityinterface/sfchooseidentitypanel/runmodal%28foridentities%3Amessage%3A%29?language=objc) for native identity selection. Evaluate it only after resolving transport ownership and duplicate selection; the panel alone does not address those issues. Keep native calls behind a small macOS adapter using the existing desktop native bridge where appropriate.

## Failure classification and diagnostics

Renderer `fetch` may expose only a generic network failure. Capture Chromium error descriptions in the main process through [webRequest.onErrorOccurred](https://www.electronjs.org/docs/latest/api/web-request#webrequestonerroroccurredfilter-listener), correlate them with the controlled probe, and send a typed result to the renderer. Electron allows only the last listener for a WebRequest event, so integrate with any existing listener rather than replacing it unintentionally. Concurrent requests to the same endpoint must not be misattributed to the probe.

| Evidence                                                 | Classification                  | User guidance                                                        |
| -------------------------------------------------------- | ------------------------------- | -------------------------------------------------------------------- |
| Server certificate validation failure                    | Server trust failure            | Check server certificate and configured hostname                     |
| Client-auth challenge with no candidates                 | No offered identity             | Check certificate, associated key, issuer, and Keychain availability |
| Bound fingerprint absent from candidates                 | Identity not offered            | Review the binding; do not substitute another certificate            |
| Explicit user cancellation                               | Cancelled                       | Allow a deliberate retry without reporting a corrupt key             |
| `ERR_SSL_CLIENT_AUTH_CERT_NO_PRIVATE_KEY`                | Missing private key             | Select an identity containing the matching key                       |
| `ERR_SSL_CLIENT_AUTH_PRIVATE_KEY_ACCESS_DENIED`          | Local key access denied         | Review Keychain authorization                                        |
| `ERR_SSL_CLIENT_AUTH_SIGNATURE_FAILED` / `-141`          | Local signing failed            | Explain that the TLS client signature could not be created           |
| Correlated Keychain partition mismatch and access denial | Keychain authorization conflict | Identify the confirmed build and key copy; offer supported guidance  |
| Evidence of remote client-auth rejection                 | Server rejection                | Check accepted CA chain and server policy                            |
| HTTP success with invalid `/config` response             | Unexpected server response      | Check the effective API URL                                          |
| Generic TLS alert without sufficient detail              | TLS handshake failed            | Retain uncertainty and provide limited diagnostic details            |

Chromium [defines `-141`](https://github.com/chromium/chromium/blob/main/net/base/net_error_list.h) as failure to sign client-authentication handshake data. Its [macOS signing implementation](https://github.com/chromium/chromium/blob/main/net/ssl/ssl_platform_key_mac.cc) maps a failed `SecKeyCreateSignature` to that error. It does not prove a partition mismatch, a broken key, or remote rejection by itself. Direct native OSStatus detail may be available only to the process performing the signing operation; do not promise that Electron supplies it.

Example generic message: **The client certificate was selected, but the app could not create the TLS signature with its private key. Check Keychain access permissions.** Show the more specific partition-list diagnosis only with correlated evidence.

Diagnostic details may include a canonical destination, public fingerprint, Chromium error, available OSStatus, and verified signing-process identity. Do not routinely collect full NetLogs or macOS logs. An opt-in support export must have a bounded scope and exclude passwords, private keys, account tokens, cookies, request bodies, and unnecessary full URLs or filesystem paths.

## Supported authorization and permission repair

Investigate public Keychain APIs and system authorization prompts for file-based Keychains, including [Apple's ACL documentation](https://developer.apple.com/documentation/security/access-control-lists) and [TN3137](https://developer.apple.com/documentation/technotes/tn3137-on-mac-keychains). Data-protection Keychain access groups are not interchangeable with the partition list of an existing file-based Keychain item.

The first version must remain useful when no supported repair flow is established: show the local signing diagnosis, preserve the binding, and provide verified manual guidance if available. Do not recommend reissuance as a cure for a proven access-control problem or claim that the visible allow-all setting fixes it.

Any future repair capability must satisfy all of the following:

1. Obtain explicit consent for the concrete key, Keychain, signing identity, and proposed permission delta. State that a Team-ID rule authorizes apps from that developer team, not just Bitwarden.
2. Determine the signature of the process that actually accesses the key, including relevant helper processes. Do not hardcode `LTZ2PFU5D6` or assume a development/ad-hoc build has the release identity.
3. Re-resolve the selected identity, validate ownership and certificate/key correspondence, and reject duplicate ambiguity or changed access rules before writing.
4. Preserve all existing authorization entries and change only the selected key. Do not broaden other operation authorizations, overwrite the partition list, or edit every matching key.
5. Use a supported Apple API and system authorization flow. Exclude `SecKeychainItemSetAccessWithPassword` and unreviewed shell repair commands from the product.
6. Prefer system-managed authentication. If a supported flow requires an app-handled password, collect it locally in a protected native prompt; keep it out of renderer IPC, command arguments, environment variables, logs, persistent settings, and diagnostic exports. Minimize its lifetime and clear owned buffers where feasible.
7. Reread the resulting access rules, verify unrelated rules were preserved, and retest the actual TLS connection. Report authorization change and connectivity as distinct results.

Do not promise automatic rollback by replacing the entire prior ACL: that could erase concurrent user changes. A repair transaction needs comparison of the rules immediately before mutation and a supported recovery strategy.

## Security requirements for file access and IPC

### Linux PR finding and its relevance

The two medium-severity Aikido comments in PR 23638 flag path construction in `MtlsRegistry` at lines 96 and 97: [first comment](https://github.com/bitwarden/clients/pull/23638#discussion_r4173553287), [second comment](https://github.com/bitwarden/clients/pull/23638#discussion_r4173553357). The associated read is `fs.readFile(path.join(userData, "mtls", "registry.json"), "utf8")`.

In the inspected Linux code, the bootstrap passes `app.getPath("userData")` to `MtlsMain.load`; registry reads are not exposed as a renderer-supplied path. However, desktop startup can derive app data from launch configuration such as `BITWARDEN_APPDATA_DIR`. Validating JSON after a read does not validate the file that was opened, prevent following a symlink, or bound the read. The scanner warning is a potential data-flow problem, not evidence that an attacker already controls this path. Do not dismiss it without tracing callers and checking filesystem behavior. This concept does not remediate or close the Linux finding.

### Required file access boundary

The macOS feature needs no arbitrary file-read IPC and no private-key file access. Use Security.framework identity APIs for Keychain operations. A displayed Keychain name is informational, not an authorization to open a renderer-supplied filesystem path.

For the app's binding registry and any future import capability:

- Derive the registry root once from trusted main-process startup configuration. Treat alternate app-data roots as explicit deployment configuration, never as server, deep-link, certificate-label, or renderer input. Define accepted root ownership and access policy without breaking supported custom roots silently.
- Use a fixed registry filename under an app-owned directory. Reject traversal and path substitution. Canonicalization and prefix checks alone are insufficient for symlinks and races; compare path components rather than string prefixes.
- Validate the app-owned registry directory and file for expected owner, restrictive permissions, regular-file type, and unsafe links. Do not change or delete unrelated directories to make a root acceptable. Define how legitimate system aliases in parent paths are resolved before validating app-owned components.
- Open the registry with no-follow semantics where supported, inspect the opened descriptor, and read through that descriptor. If ancestors can be replaced, use descriptor-relative access or an equivalent native mechanism; a check followed by pathname-based `readFile` is not race-safe. Reject unexpected hard links where supported and handle unsafe/missing files separately.
- Bound bytes before and during reading, then validate JSON depth/shape, schema version, entry counts, field lengths, and endpoint/reference formats. Do not allow an oversized file or special file to exhaust memory or block startup.
- Create new directories/files with restrictive modes and publish bounded validated updates atomically within the validated directory. Apply equivalent protections to temporary writes, replacement, and cleanup. Preserve a corrupt or unsupported-version registry for recovery; never silently erase it.
- Return typed, sanitized errors only. Never echo arbitrary file contents or return raw files through IPC, logs, or diagnostics.
- If PKCS#12 import is later added, let a main-process native picker create a short-lived opaque selection ID. Do not accept a renderer file path. Revalidate the chosen file at the actual bounded read and do not imply that a picker prevents substitution races.

The threat model includes a compromised renderer, malicious server responses or redirects, tampered registry data, and an adversary able to substitute files in an unsafe configured storage location. These measures limit privileged read/mutation capabilities; they cannot protect secrets from an attacker already running arbitrary code with the user's full Keychain access.

### IPC and network boundaries

Validate every IPC payload at runtime. Require the trusted application frame and expected managed session, not merely a WebContents ID. Bind opaque candidate IDs and draft IDs to their creator, endpoint, expiry, and current revision. Reject stale, forged, replayed, and cross-window IDs.

Expose capabilities such as `canImport`, `canSelectFromSystemStore`, `canDiagnoseKeyAccess`, and `canRepairKeyAccess` rather than treating platform support as one boolean. Repair capability remains false until its authorization and duplicate-identity gates pass. Existing Linux `restartRequired: true` types need a generalized result rather than assuming macOS changes are always live or always require restart.

Bound concurrent probes and native operations and allow cancellation. Only probe explicitly configured destinations during foreground setup; do not expose an arbitrary renderer-controlled network proxy. Local/private addresses remain legitimate self-hosted destinations, so validate authorization and request purpose rather than banning private networks.

## Activation and lifecycle

Chromium can cache selected identities and reuse TLS connections. A changed binding must not be reported as active while traffic continues using the old identity. Test supported session refresh behavior in the deployed Electron version; do not assume HTTP auth-cache clearing clears client-certificate selection. Use explicit restart activation if safe live activation cannot be established.

Keep draft, saved, and active state distinct. A failed storage update leaves prior configuration active. If the environment and binding store cannot be updated atomically, define a recoverable transaction with reconciliation after interruption. Failed authorization never silently switches to another certificate. Removing an app binding never deletes a system identity or edits its Keychain permissions.

## Implementation sequence and acceptance gates

1. **Transport and diagnostic spike.** On a signed build, reproduce identity offering, local signature denial, and successful TLS use through the production renderer/session. Establish error correlation without exporting secret-bearing logs. Test both Developer ID and Mac App Store distributions.
2. **Duplicate identity and authorization spike.** Determine how Chromium chooses duplicate copies, which process signs, and whether a public Apple flow can authorize the exact key. If these cannot be established, retain diagnostics and exclude repair; document the duplicate-selection limitation before implementation approval.
3. **Shared contracts and UI.** Coordinate with the Linux PR, add platform capabilities and typed probe results, and stage environment/binding edits in the self-hosted dialog. Add later management in settings.
4. **Registry and activation.** Implement the file-access boundary, persistence/recovery behavior, sender validation, and verified activation strategy. Review the Linux registry finding separately rather than treating this macOS document as a fix.
5. **Runtime verification.** Complete the matrix below on packaged builds. Ship repair only after its additional acceptance gates pass.

| Scenario                                        | Required outcome                                                                    |
| ----------------------------------------------- | ----------------------------------------------------------------------------------- |
| No mTLS server                                  | Existing setup and connection behavior continues                                    |
| One or several valid identities                 | Explicit selection; only the chosen binding is reused                               |
| Candidate offered but signing denied            | Local signing error appears during setup, not only sync                             |
| Confirmed partition mismatch                    | Specific diagnosis only when evidence is sufficient; no automatic mutation          |
| Valid key in another test process               | Does not cause the app to report TLS success without an app connection test         |
| Same certificate in two Keychains               | No unsupported claim about the selected copy; mutation blocked if ambiguous         |
| Locked Keychain, denied prompt, cancellation    | Distinct recoverable results with bounded operation lifetime                        |
| Expired, missing, or unsuitable identity        | No fallback to a different certificate                                              |
| Root/intermediate issuer configurations         | Correct chain handling and clear failure reporting                                  |
| API, identity, icons, notifications and WSS     | Bound destinations use the policy; no implicit authorization of other hosts         |
| Cross-host redirect                             | No identity or account-credential leakage to an unapproved destination              |
| Binding replacement and removal                 | Old connection/certificate caches cannot masquerade as new active policy            |
| Dialog cancellation, restart, interrupted save  | Draft discarded; saved/active state reconciles consistently                         |
| Custom app-data root and hostile registry files | Reject unsafe ownership, links, special/oversized files and substitution races      |
| Forged or stale IPC and concurrent probes       | No arbitrary reads, cross-window selection, or error misattribution                 |
| Release, App Store and development signatures   | Behavior verified for the actual build and signing process                          |
| Any supported repair                            | Consent, exact target, preserved rules, no private API/password leakage, TLS retest |

Runtime tests should cover real handshake behavior and filesystem/IPC boundaries rather than only mocked selection callbacks. The supplied Safari/Chrome incident is the primary regression scenario for Keychain authorization. Record macOS and Electron versions with results because the Keychain implementation, sandbox, and certificate-cache behavior affect the outcome.
