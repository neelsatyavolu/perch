import Foundation
import Testing
@testable import PerchKeysCore

/// A service over an in-memory store and a software key; it never touches a real Keychain.
final class Harness {
    let store = MemoryBlobStore()
    let service: Service

    init() throws {
        let backend = Backend(wrapKey: try WrapKey.ephemeral(), store: store)
        service = Service(backend: { backend })
    }

    func call(_ request: [String: Any]) throws -> [String: Any] {
        let body = try JSONSerialization.data(withJSONObject: request)
        return try JSONSerialization.jsonObject(with: service.handle(body)) as! [String: Any]
    }
}

@Suite struct ServiceTests {
    @Test func createGetDelete() throws {
        let h = try Harness()
        let created = try h.call(["op": "create", "profile": "Default"])
        let key = try #require(created["key"] as? String)
        #expect(Data(base64Encoded: key)?.count == 32)
        #expect(created["protected"] as? Bool == false)
        #expect(created["recovery"] == nil)
        #expect(h.store.items["Default"] != nil && h.store.items["Default"] != Data(base64Encoded: key))

        #expect(try h.call(["op": "get", "profile": "Default"])["key"] as? String == key)
        #expect(try h.call(["op": "delete", "profile": "Default"])["ok"] as? Bool == true)
        #expect(try h.call(["op": "get", "profile": "Default"])["error"] as? String == "missing")
    }

    @Test func createRefusesToReplaceAnExistingKey() throws {
        let h = try Harness()
        _ = try h.call(["op": "create", "profile": "Default"])
        #expect(try h.call(["op": "create", "profile": "Default"])["error"] as? String == "exists")
    }

    @Test func refusesUnknownOpsBadProfilesAndMalformedJSON() throws {
        let h = try Harness()
        #expect(try h.call(["op": "export", "profile": "Default"])["error"] as? String == "unknown-op")
        #expect(try h.call(["op": "get", "profile": "../x"])["error"] as? String == "bad-profile")
        #expect(try h.call(["op": "get"])["error"] as? String == "malformed")
        let reply = try JSONSerialization.jsonObject(with: h.service.handle(Data("{not json".utf8))) as! [String: Any]
        #expect(reply["error"] as? String == "malformed")
    }

    @Test func recoveryRoundTrip() throws {
        let h = try Harness()
        let pair = try RecoveryPair()
        let created = try h.call(["op": "create", "profile": "p1", "recoveryPublicKey": pair.publicRaw.base64EncodedString()])
        let key = try #require(created["key"] as? String)
        let recovery = try #require(created["recovery"] as? String)

        let rewrapped = try h.call(["op": "recovery-wrap", "profile": "p1", "recoveryPublicKey": pair.publicRaw.base64EncodedString()])
        #expect(rewrapped["recovery"] is String && rewrapped["key"] == nil)

        // A new Mac: the device key and its blob are gone.
        let fresh = try Harness()
        let restored = try fresh.call([
            "op": "recovery-unwrap", "profile": "p1", "recovery": recovery,
            "recoveryPrivateKey": pair.privateRaw.base64EncodedString(),
        ])
        #expect(restored["key"] as? String == key)
        #expect(try fresh.call(["op": "get", "profile": "p1"])["key"] as? String == key)
    }

    @Test func recoveryUnwrapRefusesTheWrongKey() throws {
        let h = try Harness()
        let pair = try RecoveryPair()
        let created = try h.call(["op": "create", "profile": "p1", "recoveryPublicKey": pair.publicRaw.base64EncodedString()])
        let reply = try h.call([
            "op": "recovery-unwrap", "profile": "p1", "recovery": created["recovery"] as! String,
            "recoveryPrivateKey": try RecoveryPair().privateRaw.base64EncodedString(),
        ])
        #expect(reply["error"] as? String == "unwrap-failed")
    }

    @Test func badRecoveryPublicKeyCreatesNothing() throws {
        let h = try Harness()
        let reply = try h.call(["op": "create", "profile": "p1", "recoveryPublicKey": "AAAA"])
        #expect(reply["error"] as? String == "bad-recovery-key")
        #expect(h.store.items.isEmpty)
    }
}

@Suite struct LoopTests {
    @Test func servesUntilEOF() throws {
        let h = try Harness()
        var input = Framing.encode(Data(#"{"op":"create","profile":"a"}"#.utf8))
        input.append(Framing.encode(Data(#"{"op":"get","profile":"a"}"#.utf8)))
        var frames: [Data] = []
        let code = serve(h.service, input: ChunkedSource(input, chunk: 3)) { frames.append($0) }
        #expect(code == 0)
        #expect(frames.count == 2)
        let replies = try frames.map { try FrameReader(ChunkedSource($0)).next() }
        guard case .frame(let first) = replies[0], case .frame(let second) = replies[1] else {
            Issue.record("expected two frames")
            return
        }
        let a = try JSONSerialization.jsonObject(with: first) as! [String: Any]
        let b = try JSONSerialization.jsonObject(with: second) as! [String: Any]
        #expect(a["key"] as? String == b["key"] as? String)
    }

    @Test func oversizedRequestGetsAnErrorThenExitsNonzero() throws {
        let h = try Harness()
        var input = Framing.encode(Data(repeating: 0x20, count: Framing.maxFrame + 1))
        input.append(Framing.encode(Data(#"{"op":"create","profile":"a"}"#.utf8)))
        var frames: [Data] = []
        let code = serve(h.service, input: ChunkedSource(input)) { frames.append($0) }
        #expect(code != 0)
        #expect(frames.count == 1)
        guard case .frame(let body) = try FrameReader(ChunkedSource(frames[0])).next() else {
            Issue.record("expected a frame")
            return
        }
        #expect((try JSONSerialization.jsonObject(with: body) as! [String: Any])["error"] as? String == "too-large")
        #expect(h.store.items.isEmpty)
    }
}
