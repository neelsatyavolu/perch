import CryptoKit
import Foundation
import Security

/// The key every root key is wrapped to. `protected` is true only for a Secure Enclave key.
public struct WrapKey {
    public let privateKey: SecKey
    public let protected: Bool

    public init(privateKey: SecKey, protected: Bool) {
        self.privateKey = privateKey
        self.protected = protected
    }

    public func publicKey() throws(KeyError) -> SecKey {
        guard let key = SecKeyCopyPublicKey(privateKey) else { throw .wrapKeyUnavailable }
        return key
    }

    /// A software P-256 key that is never stored. Tests use it in place of the Secure Enclave.
    public static func ephemeral() throws(KeyError) -> WrapKey {
        let attrs: [CFString: Any] = [
            kSecAttrKeyType: kSecAttrKeyTypeECSECPrimeRandom,
            kSecAttrKeySizeInBits: 256,
            kSecPrivateKeyAttrs: [kSecAttrIsPermanent: false],
        ]
        guard let key = SecKeyCreateRandomKey(attrs as CFDictionary, nil) else { throw .internal }
        return WrapKey(privateKey: key, protected: false)
    }
}

/// Loads or creates the wrap key. A signed build gets a Secure Enclave key in Perch's access group.
/// When there is no Secure Enclave, or the binary lacks the Keychain entitlement (an ad-hoc
/// development build), it falls back to a software key in the login Keychain.
public enum Enclave {
    public static func loadOrCreate() throws(KeyError) -> WrapKey {
        if SecureEnclave.isAvailable {
            switch findKey(tag: KeychainNames.wrapTag, dataProtection: true) {
            case .found(let key): return WrapKey(privateKey: key, protected: true)
            case .notFound:
                if let key = createEnclaveKey() { return WrapKey(privateKey: key, protected: true) }
            case .noEntitlement: break
            case .failed: throw .wrapKeyUnavailable
            }
        }
        return try loadOrCreateSoftware()
    }

    private enum Lookup { case found(SecKey), notFound, noEntitlement, failed }

    private static func findKey(tag: String, dataProtection: Bool) -> Lookup {
        var q: [CFString: Any] = [
            kSecClass: kSecClassKey,
            kSecAttrApplicationTag: Data(tag.utf8),
            kSecAttrKeyType: kSecAttrKeyTypeECSECPrimeRandom,
            kSecReturnRef: true,
        ]
        if dataProtection {
            q[kSecUseDataProtectionKeychain] = true
            q[kSecAttrAccessGroup] = KeychainNames.accessGroup
            q[kSecAttrTokenID] = kSecAttrTokenIDSecureEnclave
        }
        var out: CFTypeRef?
        switch SecItemCopyMatching(q as CFDictionary, &out) {
        case errSecSuccess: return .found(out as! SecKey)
        case errSecItemNotFound: return .notFound
        case errSecMissingEntitlement: return .noEntitlement
        default: return .failed
        }
    }

    /// nil when the entitlement is missing; the caller then falls back.
    private static func createEnclaveKey() -> SecKey? {
        guard let access = SecAccessControlCreateWithFlags(
            nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly, .privateKeyUsage, nil
        ) else { return nil }
        let attrs: [CFString: Any] = [
            kSecAttrKeyType: kSecAttrKeyTypeECSECPrimeRandom,
            kSecAttrKeySizeInBits: 256,
            kSecAttrTokenID: kSecAttrTokenIDSecureEnclave,
            kSecUseDataProtectionKeychain: true,
            kSecAttrAccessGroup: KeychainNames.accessGroup,
            kSecPrivateKeyAttrs: [
                kSecAttrIsPermanent: true,
                kSecAttrApplicationTag: Data(KeychainNames.wrapTag.utf8),
                kSecAttrAccessControl: access,
            ] as [CFString: Any],
        ]
        var error: Unmanaged<CFError>?
        let key = SecKeyCreateRandomKey(attrs as CFDictionary, &error)
        error?.release()
        return key
    }

    private static func loadOrCreateSoftware() throws(KeyError) -> WrapKey {
        switch findKey(tag: KeychainNames.softwareWrapTag, dataProtection: false) {
        case .found(let key): return WrapKey(privateKey: key, protected: false)
        case .notFound: break
        case .noEntitlement, .failed: throw .wrapKeyUnavailable
        }
        let key = try WrapKey.ephemeral().privateKey
        let add: [CFString: Any] = [
            kSecClass: kSecClassKey,
            kSecValueRef: key,
            kSecAttrApplicationTag: Data(KeychainNames.softwareWrapTag.utf8),
            kSecAttrLabel: "Perch Keys (not Secure Enclave)",
            kSecAttrAccessible: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
        ]
        guard SecItemAdd(add as CFDictionary, nil) == errSecSuccess else { throw .wrapKeyUnavailable }
        return WrapKey(privateKey: key, protected: false)
    }
}
