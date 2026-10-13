// Read-only inventory using public Security.framework APIs. No signing, ACL writes,
// private-key export, password collection, or Keychain search-list changes.
import Foundation
import Security
import CryptoKit
import LocalAuthentication

DispatchQueue.global().asyncAfter(deadline: .now() + 15) {
    print("{\"ok\":false,\"error\":\"inventory-timeout\"}")
    exit(2)
}

func fingerprint(_ data: Data) -> String {
    SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}

var results: CFTypeRef?
let authentication = LAContext()
authentication.interactionNotAllowed = true
let query: [CFString: Any] = [
    kSecClass: kSecClassIdentity,
    kSecMatchLimit: kSecMatchLimitAll,
    kSecReturnRef: true,
    kSecUseAuthenticationContext: authentication,
]
let status = SecItemCopyMatching(query as CFDictionary, &results)
if status != errSecSuccess && status != errSecItemNotFound {
    print("{\"ok\":false,\"osStatus\":\(status)}")
    exit(1)
}
var rows: [[String: Any]] = []
for identity in (results as? [SecIdentity] ?? []) {
    var cert: SecCertificate?
    guard SecIdentityCopyCertificate(identity, &cert) == errSecSuccess, let cert else { continue }
    let der = SecCertificateCopyData(cert) as Data
    var key: SecKey?
    let keyStatus = SecIdentityCopyPrivateKey(identity, &key)
    var keychain: SecKeychain?
    // File-based Keychain items support this public, deprecated API.
    let locationStatus = key.map {
        SecKeychainItemCopyKeychain(unsafeBitCast($0, to: SecKeychainItem.self), &keychain)
    } ?? keyStatus
    var keychainName: String? = nil
    if locationStatus == errSecSuccess, let keychain {
        var bytes = [CChar](repeating: 0, count: 4096)
        var length = UInt32(bytes.count)
        if SecKeychainGetPath(keychain, &length, &bytes) == errSecSuccess {
            keychainName = URL(fileURLWithPath: String(cString: bytes)).lastPathComponent
        }
    }
    let row: [String: Any] = [
        "fingerprint": fingerprint(der),
        "subject": (SecCertificateCopySubjectSummary(cert) as String?) ?? "",
        "privateKeyReferenceStatus": keyStatus,
        "keychainLocationStatus": locationStatus,
        "keychain": keychainName ?? "unavailable",
        "signingPermission": "not-tested",
    ]
    rows.append(row)
}
let output: [String: Any] = ["ok": true, "identities": rows]
let bytes = try JSONSerialization.data(withJSONObject: output, options: [.sortedKeys])
print(String(decoding: bytes, as: UTF8.self))
