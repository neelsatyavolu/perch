import Foundation

/// Native-messaging framing: a little-endian UInt32 length, then that many bytes of UTF-8 JSON.
public enum Framing {
    public static let maxFrame = 64 * 1024

    public static func encode(_ body: Data) -> Data {
        var length = UInt32(body.count).littleEndian
        var frame = Data(bytes: &length, count: 4)
        frame.append(body)
        return frame
    }
}

/// A byte source that may return fewer bytes than asked for; an empty result means EOF.
public protocol ByteSource: AnyObject {
    func read(upTo count: Int) -> Data
}

public final class FileHandleSource: ByteSource {
    private let handle: FileHandle

    public init(_ handle: FileHandle) { self.handle = handle }

    public func read(upTo count: Int) -> Data {
        (try? handle.read(upToCount: count)) ?? Data()
    }
}

public enum FrameResult: Equatable {
    case frame(Data)
    case eof
}

public final class FrameReader {
    private let source: ByteSource

    public init(_ source: ByteSource) { self.source = source }

    /// The next frame, `.eof` at a clean end, or throws `.truncated` / `.tooLarge`.
    /// An oversized frame is refused from its header, before its body is read.
    public func next() throws(KeyError) -> FrameResult {
        guard let header = try readExactly(4, eofOK: true) else { return .eof }
        let length = header.withUnsafeBytes { Int(UInt32(littleEndian: $0.loadUnaligned(as: UInt32.self))) }
        guard length <= Framing.maxFrame else { throw .tooLarge }
        return .frame(try readExactly(length, eofOK: false) ?? Data())
    }

    private func readExactly(_ count: Int, eofOK: Bool) throws(KeyError) -> Data? {
        var buffer = Data(capacity: count)
        while buffer.count < count {
            let chunk = source.read(upTo: count - buffer.count)
            if chunk.isEmpty {
                if buffer.isEmpty && eofOK { return nil }
                throw .truncated
            }
            buffer.append(chunk)
        }
        return buffer
    }
}

public struct Request: Decodable {
    public let op: String
    public let profile: String
    public let recoveryPublicKey: String?
    public let recovery: String?
    public let recoveryPrivateKey: String?
}

public struct Response: Encodable, Equatable {
    public var key: String?
    public var protected: Bool?
    public var recovery: String?
    public var ok: Bool?
    public var error: String?

    public init(key: String? = nil, protected: Bool? = nil, recovery: String? = nil, ok: Bool? = nil, error: String? = nil) {
        self.key = key
        self.protected = protected
        self.recovery = recovery
        self.ok = ok
        self.error = error
    }

    public static func failure(_ error: KeyError) -> Response { Response(error: error.rawValue) }
}

public enum Profile {
    /// ^[A-Za-z0-9._-]{1,64}$
    public static func isValid(_ id: String) -> Bool {
        guard (1...64).contains(id.utf8.count) else { return false }
        return id.utf8.allSatisfy { b in
            (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5A) || (b >= 0x61 && b <= 0x7A) || b == 0x2E || b == 0x5F || b == 0x2D
        }
    }
}

/// Accepts standard base64 or base64url, padded or not.
public func decodeBase64(_ text: String) -> Data? {
    var s = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    while s.count % 4 != 0 { s.append("=") }
    return Data(base64Encoded: s)
}
