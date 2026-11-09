import Foundation
import Security

/// Wrapping 32-byte root keys to a P-256 key with ECIES (X9.63 KDF, SHA-256, AES-GCM, variable IV).
/// The same algorithm wraps to the Secure Enclave key and to the recovery key.
public enum Wrap {
    public static let algorithm = SecKeyAlgorithm.eciesEncryptionCofactorVariableIVX963SHA256AESGCM
    public static let rootKeyLength = 32

    public static func seal(_ rootKey: Data, to publicKey: SecKey) throws(KeyError) -> Data {
        guard rootKey.count == rootKeyLength else { throw .badKeyLength }
        var error: Unmanaged<CFError>?
        guard let blob = SecKeyCreateEncryptedData(publicKey, algorithm, rootKey as CFData, &error) else {
            error?.release()
            throw .wrapFailed
        }
        return blob as Data
    }

    public static func open(_ blob: Data, with privateKey: SecKey) throws(KeyError) -> Data {
        var error: Unmanaged<CFError>?
        guard let plain = SecKeyCreateDecryptedData(privateKey, algorithm, blob as CFData, &error) else {
            error?.release()
            throw .unwrapFailed
        }
        var key = plain as Data
        guard key.count == rootKeyLength else {
            wipe(&key)
            throw .badKeyLength
        }
        return key
    }

    /// A fresh random root key.
    public static func newRootKey() throws(KeyError) -> Data {
        var key = Data(count: rootKeyLength)
        let status = key.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, rootKeyLength, $0.baseAddress!) }
        guard status == errSecSuccess else { throw .internal }
        return key
    }

    /// A P-256 public key from its X9.63 uncompressed form (65 bytes: 04 || X || Y).
    public static func publicKey(x963 raw: Data) throws(KeyError) -> SecKey {
        guard raw.count == 65, raw.first == 0x04 else { throw .badRecoveryKey }
        return try importKey(raw, cls: kSecAttrKeyClassPublic)
    }

    /// A P-256 private key from its X9.63 form (97 bytes: 04 || X || Y || K).
    public static func privateKey(x963 raw: Data) throws(KeyError) -> SecKey {
        guard raw.count == 97, raw.first == 0x04 else { throw .badRecoveryKey }
        return try importKey(raw, cls: kSecAttrKeyClassPrivate)
    }

    private static func importKey(_ raw: Data, cls: CFString) throws(KeyError) -> SecKey {
        let attrs: [CFString: Any] = [kSecAttrKeyType: kSecAttrKeyTypeECSECPrimeRandom, kSecAttrKeyClass: cls, kSecAttrKeySizeInBits: 256]
        var error: Unmanaged<CFError>?
        guard let key = SecKeyCreateWithData(raw as CFData, attrs as CFDictionary, &error) else {
            error?.release()
            throw .badRecoveryKey
        }
        return key
    }
}

/// Overwrites the bytes before the buffer is released.
public func wipe(_ data: inout Data) {
    data.resetBytes(in: 0..<data.count)
}
