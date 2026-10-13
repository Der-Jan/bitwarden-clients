import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { createHash, X509Certificate } from "node:crypto";
import { join } from "node:path";
import {
  normalizeEndpoint,
  normalizeChallengeEndpoint,
} from "../../apps/desktop/src/platform/main/mtls/endpoint";
import { selectOfferedIdentity } from "../../apps/desktop/src/platform/main/mtls/selection";
import { classifyMtlsError } from "../../apps/desktop/src/platform/main/mtls/diagnosis";
import { completeCertificateSelection } from "../../apps/desktop/src/platform/main/mtls/certificate-callback";

test("canonical policy preserves TLS host/port boundaries", () => {
  assert.equal(
    normalizeEndpoint("wss://VAULT.example.:443/notifications?q=x"),
    "vault.example:443",
  );
  assert.equal(normalizeChallengeEndpoint("[::1]:8443"), "[::1]:8443");
  for (const input of [
    "https://user:pass@vault.example",
    "file:///etc/passwd",
    "http://vault.example",
    "vault.example/path:443",
    "https://vault.example:65536",
  ]) {
    assert.throws(() => normalizeChallengeEndpoint(input));
  }
});
test("only configured offered fingerprint can be selected", () => {
  const data = readFileSync(
    join(process.cwd(), "apps/desktop/src/platform/main/mtls/fixtures/test-cert.pem"),
    "utf8",
  );
  const cert = new X509Certificate(data);
  const fingerprint = createHash("sha256").update(cert.raw).digest("hex");
  const candidate = { data };
  const config = {
    bindings: { "vault.example:443": fingerprint },
    identities: { [fingerprint]: { notBefore: cert.validFrom, notAfter: cert.validTo } },
  };
  const now = new Date((Date.parse(cert.validFrom) + Date.parse(cert.validTo)) / 2);
  assert.equal(
    selectOfferedIdentity(config, "https://vault.example/api", [candidate], now).certificate,
    candidate,
  );
  assert.deepEqual(selectOfferedIdentity(config, "https://other.example", [candidate], now), {});
  assert.equal(
    selectOfferedIdentity(config, "https://vault.example", [{ data: "invalid" }], now).error,
    "identity-not-offered",
  );
  assert.equal(
    selectOfferedIdentity(
      config,
      "https://vault.example",
      [candidate],
      new Date(Date.parse(cert.validTo) + 1000),
    ).error,
    "certificate-expired",
  );
  assert.equal(
    selectOfferedIdentity(
      config,
      "https://vault.example",
      [candidate],
      new Date(Date.parse(cert.validFrom) - 1000),
    ).error,
    "certificate-not-yet-valid",
  );
  config.identities[fingerprint].notBefore = "invalid";
  assert.equal(
    selectOfferedIdentity(config, "https://vault.example", [candidate], now).error,
    "identity-missing",
  );
});
test("signature failure does not claim a partition mismatch or remote rejection", () => {
  assert.equal(
    classifyMtlsError("net::ERR_SSL_CLIENT_AUTH_SIGNATURE_FAILED"),
    "local-signing-failed",
  );
  assert.equal(
    classifyMtlsError("net::ERR_SSL_CLIENT_AUTH_PRIVATE_KEY_ACCESS_DENIED"),
    "private-key-access-denied",
  );
  assert.equal(classifyMtlsError("net::ERR_CERT_AUTHORITY_INVALID"), "server-trust-failed");
  assert.equal(classifyMtlsError("net::ERR_SSL_PROTOCOL_ERROR"), "connection-failed");
});
test("no identity passes explicit null across Electron compatibility boundary", () => {
  const calls: unknown[][] = [];
  const callback = (...args: unknown[]) => calls.push(args);
  completeCertificateSelection(callback);
  assert.deepEqual(calls, [[null]]);
  const cert = { data: "certificate" };
  completeCertificateSelection(callback, cert);
  assert.equal(calls[1][0], cert);
});
