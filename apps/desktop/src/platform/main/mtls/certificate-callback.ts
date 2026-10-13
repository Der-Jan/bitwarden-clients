/** Electron 43.5 accepts explicit null for continuing without a certificate.
 * Its native implementation rejects undefined, including an omitted argument on
 * the macOS runtime tested by this probe. The public TS signature omits null.
 * Keep this compatibility boundary in one place and verify it on upgrades.
 */
export function completeCertificateSelection<T>(
  callback: (certificate?: T) => void,
  certificate?: T,
): void {
  if (certificate !== undefined) {
    callback(certificate);
  } else {
    (callback as (certificate: T | null) => void)(null);
  }
}
