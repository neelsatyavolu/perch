import Foundation
import Security

/// Where wrapped root keys live, one item per profile.
public protocol BlobStore: AnyObject {
    func read(profile: String) throws(KeyError) -> Data?
    func write(profile: String, blob: Data) throws(KeyError)
    func delete(profile: String) throws(KeyError)
}

public enum KeychainNames {
    public static let accessGroup = "VTQW687WBQ.co.xanom.perch.keys"
    public static let service = "co.xanom.perch.keys"
    public static let wrapTag = "co.xanom.perch.keys.wrap"
    public static let softwareWrapTag = "co.xanom.perch.keys.wrap.software"

    public static func account(_ profile: String) -> String { "root:\(profile)" }
}

/// Generic-password Keychain items. A signed build uses the data-protection Keychain in Perch's
/// access group; an ad-hoc build cannot, so it falls back to the login Keychain.
public final class KeychainBlobStore: BlobStore {
    private let dataProtection: Bool

    public init(dataProtection: Bool) {
        self.dataProtection = dataProtection
    }

    private func query(_ profile: String) -> [CFString: Any] {
        var q: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: KeychainNames.service,
            kSecAttrAccount: KeychainNames.account(profile),
        ]
        if dataProtection {
            q[kSecUseDataProtectionKeychain] = true
            q[kSecAttrAccessGroup] = KeychainNames.accessGroup
        }
        return q
    }

    public func read(profile: String) throws(KeyError) -> Data? {
        var q = query(profile)
        q[kSecReturnData] = true
        q[kSecMatchLimit] = kSecMatchLimitOne
        var out: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &out)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = out as? Data else { throw .store }
        return data
    }

    public func write(profile: String, blob: Data) throws(KeyError) {
        let status = SecItemUpdate(query(profile) as CFDictionary, [kSecValueData: blob] as CFDictionary)
        if status == errSecSuccess { return }
        guard status == errSecItemNotFound else { throw .store }
        var add = query(profile)
        add[kSecValueData] = blob
        add[kSecAttrAccessible] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        guard SecItemAdd(add as CFDictionary, nil) == errSecSuccess else { throw .store }
    }

    public func delete(profile: String) throws(KeyError) {
        let status = SecItemDelete(query(profile) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw .store }
    }
}

/// For tests: nothing leaves memory.
public final class MemoryBlobStore: BlobStore {
    public private(set) var items: [String: Data] = [:]

    public init() {}

    public func read(profile: String) throws(KeyError) -> Data? { items[profile] }
    public func write(profile: String, blob: Data) throws(KeyError) { items[profile] = blob }
    public func delete(profile: String) throws(KeyError) { items[profile] = nil }
}
