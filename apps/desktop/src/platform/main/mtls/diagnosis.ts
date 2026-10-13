/** Chromium errors establish a failure stage, not the exact Keychain ACL cause. */
export function classifyMtlsError(error: string): string {
  const code = error.replace(/^net::/, "");
  switch (code) {
    case "ERR_SSL_CLIENT_AUTH_SIGNATURE_FAILED":
      return "local-signing-failed";
    case "ERR_SSL_CLIENT_AUTH_PRIVATE_KEY_ACCESS_DENIED":
      return "private-key-access-denied";
    case "ERR_SSL_CLIENT_AUTH_CERT_NO_PRIVATE_KEY":
      return "private-key-missing";
    case "ERR_SSL_CLIENT_AUTH_CERT_NEEDED":
      return "client-identity-needed";
    case "ERR_BAD_SSL_CLIENT_AUTH_CERT":
      return "client-authentication-failed";
    case "ERR_ABORTED":
      return "cancelled";
    default:
      return code.startsWith("ERR_CERT_") ? "server-trust-failed" : "connection-failed";
  }
}
