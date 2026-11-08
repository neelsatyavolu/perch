import Foundation
import Security
import Testing
@testable import PerchKeysCore

@Suite struct WrapTests {
    @Test func roundTripWithASoftwareKey() throws {
        let wrapKey = try WrapKey.ephemeral()
        let root = try Wrap.newRootKey()
        let blob = try Wrap.seal(root, to: try wrapKey.publicKey())
        #expect(blob != root)
        #expect(try Wrap.open(blob, with: wrapKey.privateKey) == root)
    }

    @Test func anotherKeyCannotUnwrap() throws {
        let blob = try Wrap.seal(try Wrap.newRootKey(), to: try WrapKey.ephemeral().publicKey())
        #expect(throws: KeyError.unwrapFailed) { try Wrap.open(blob, with: try WrapKey.ephemeral().privateKey) }
    }

    @Test func refusesKeysThatAreNot32Bytes() throws {
        let pub = try WrapKey.ephemeral().publicKey()
        #expect(throws: KeyError.badKeyLength) { try Wrap.seal(Data(count: 16), to: pub) }
    }

    @Test func wipeZeroesTheBuffer() {
        var data = Data([1, 2, 3, 4])
        wipe(&data)
        #expect(data == Data(count: 4))
    }

    @Test func importsX963Keys() throws {
        let pair = try RecoveryPair()
        #expect(throws: Never.self) { try Wrap.publicKey(x963: pair.publicRaw) }
        #expect(throws: Never.self) { try Wrap.privateKey(x963: pair.privateRaw) }
        #expect(throws: KeyError.badRecoveryKey) { try Wrap.publicKey(x963: Data(count: 65)) }
    }
}

/// A software P-256 pair in the X9.63 forms the protocol takes.
struct RecoveryPair {
    let publicRaw: Data
    let privateRaw: Data

    init() throws {
        let key = try WrapKey.ephemeral()
        privateRaw = SecKeyCopyExternalRepresentation(key.privateKey, nil)! as Data
        publicRaw = SecKeyCopyExternalRepresentation(try key.publicKey(), nil)! as Data
    }
}
