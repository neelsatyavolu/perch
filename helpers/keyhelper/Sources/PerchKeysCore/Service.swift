import Foundation

/// The wrap key and the store that goes with it (data-protection Keychain only when protected).
public struct Backend {
    public let wrapKey: WrapKey
    public let store: BlobStore

    public init(wrapKey: WrapKey, store: BlobStore) {
        self.wrapKey = wrapKey
        self.store = store
    }

    public static func system() throws(KeyError) -> Backend {
        let key = try Enclave.loadOrCreate()
        return Backend(wrapKey: key, store: KeychainBlobStore(dataProtection: key.protected))
    }
}

/// Answers one request at a time. The backend is resolved on the first request that needs it.
public final class Service {
    private let makeBackend: () throws(KeyError) -> Backend
    private var backend: Backend?

    public init(backend: @escaping () throws(KeyError) -> Backend) {
        self.makeBackend = backend
    }

    /// Request JSON in, reply JSON out. Never throws: every failure is an `error` reply.
    public func handle(_ body: Data) -> Data {
        let response: Response
        do {
            response = try dispatch(body)
        } catch {
            response = .failure(error)
        }
        return (try? JSONEncoder().encode(response)) ?? Data(#"{"error":"internal"}"#.utf8)
    }

    private func dispatch(_ body: Data) throws(KeyError) -> Response {
        let request: Request
        do {
            request = try JSONDecoder().decode(Request.self, from: body)
        } catch {
            throw .malformed
        }
        guard Profile.isValid(request.profile) else { throw .badProfile }
        switch request.op {
        case "get": return try get(request.profile)
        case "create": return try create(request.profile, recoveryPublicKey: request.recoveryPublicKey)
        case "delete": return try delete(request.profile)
        case "recovery-wrap": return try recoveryWrap(request)
        case "recovery-unwrap": return try recoveryUnwrap(request)
        default: throw .unknownOp
        }
    }

    private func resolved() throws(KeyError) -> Backend {
        if let backend { return backend }
        let made = try makeBackend()
        backend = made
        return made
    }

    private func reply(key: inout Data, protected: Bool, recovery: String? = nil) -> Response {
        defer { wipe(&key) }
        return Response(key: key.base64EncodedString(), protected: protected, recovery: recovery)
    }

    private func load(_ profile: String, _ b: Backend) throws(KeyError) -> Data {
        guard let blob = try b.store.read(profile: profile) else { throw .missing }
        return try Wrap.open(blob, with: b.wrapKey.privateKey)
    }

    private func get(_ profile: String) throws(KeyError) -> Response {
        let b = try resolved()
        var key = try load(profile, b)
        return reply(key: &key, protected: b.wrapKey.protected)
    }

    private func create(_ profile: String, recoveryPublicKey: String?) throws(KeyError) -> Response {
        let b = try resolved()
        guard try b.store.read(profile: profile) == nil else { throw .exists }
        let recoveryKey = try recoveryPublicKey.map { text throws(KeyError) in try parsePublic(text) }
        var key = try Wrap.newRootKey()
        do {
            let recovery = try recoveryKey.map { pub throws(KeyError) in try Wrap.seal(key, to: pub).base64EncodedString() }
            try b.store.write(profile: profile, blob: try Wrap.seal(key, to: try b.wrapKey.publicKey()))
            return reply(key: &key, protected: b.wrapKey.protected, recovery: recovery)
        } catch {
            wipe(&key)
            throw error
        }
    }

    private func delete(_ profile: String) throws(KeyError) -> Response {
        try resolved().store.delete(profile: profile)
        return Response(ok: true)
    }

    private func recoveryWrap(_ request: Request) throws(KeyError) -> Response {
        guard let text = request.recoveryPublicKey else { throw .malformed }
        let pub = try parsePublic(text)
        var key = try load(request.profile, try resolved())
        defer { wipe(&key) }
        return Response(recovery: try Wrap.seal(key, to: pub).base64EncodedString())
    }

    private func recoveryUnwrap(_ request: Request) throws(KeyError) -> Response {
        guard let wrapped = request.recovery.flatMap(decodeBase64),
              let privText = request.recoveryPrivateKey else { throw .malformed }
        guard var privRaw = decodeBase64(privText) else { throw .badRecoveryKey }
        let priv: SecKey
        do {
            priv = try Wrap.privateKey(x963: privRaw)
            wipe(&privRaw)
        } catch {
            wipe(&privRaw)
            throw error
        }
        var key = try Wrap.open(wrapped, with: priv)
        do {
            let b = try resolved()
            try b.store.write(profile: request.profile, blob: try Wrap.seal(key, to: try b.wrapKey.publicKey()))
            return reply(key: &key, protected: b.wrapKey.protected)
        } catch {
            wipe(&key)
            throw error
        }
    }

    private func parsePublic(_ text: String) throws(KeyError) -> SecKey {
        guard let raw = decodeBase64(text) else { throw .badRecoveryKey }
        return try Wrap.publicKey(x963: raw)
    }
}
