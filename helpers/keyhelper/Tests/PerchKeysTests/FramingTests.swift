import Foundation
import Testing
@testable import PerchKeysCore

/// Hands out its bytes at most `chunk` at a time, like a pipe.
final class ChunkedSource: ByteSource {
    private var data: Data
    private let chunk: Int

    init(_ data: Data, chunk: Int = .max) {
        self.data = data
        self.chunk = chunk
    }

    func read(upTo count: Int) -> Data {
        let n = min(count, chunk, data.count)
        let out = data.prefix(n)
        data = data.dropFirst(n)
        return Data(out)
    }
}

@Suite struct FramingTests {
    @Test func encodesALittleEndianLength() {
        let frame = Framing.encode(Data("{}".utf8))
        #expect(Array(frame) == [2, 0, 0, 0, 0x7B, 0x7D])
    }

    @Test func decodesFramesFromPartialReads() throws {
        var stream = Framing.encode(Data(#"{"a":1}"#.utf8))
        stream.append(Framing.encode(Data("[]".utf8)))
        let reader = FrameReader(ChunkedSource(stream, chunk: 1))
        #expect(try reader.next() == .frame(Data(#"{"a":1}"#.utf8)))
        #expect(try reader.next() == .frame(Data("[]".utf8)))
        #expect(try reader.next() == .eof)
    }

    @Test func aCutOffFrameIsTruncated() {
        let stream = Framing.encode(Data("{}".utf8)).dropLast()
        #expect(throws: KeyError.truncated) { try FrameReader(ChunkedSource(Data(stream))).next() }
        #expect(throws: KeyError.truncated) { try FrameReader(ChunkedSource(Data([1, 0]))).next() }
    }

    @Test func refusesAFrameOver64KB() {
        var header = UInt32(Framing.maxFrame + 1).littleEndian
        let stream = Data(bytes: &header, count: 4)
        #expect(throws: KeyError.tooLarge) { try FrameReader(ChunkedSource(stream)).next() }
    }

    @Test func acceptsAFrameOfExactly64KB() throws {
        let body = Data(repeating: 0x20, count: Framing.maxFrame)
        #expect(try FrameReader(ChunkedSource(Framing.encode(body))).next() == .frame(body))
    }

    @Test func profileIds() {
        #expect(Profile.isValid("Default"))
        #expect(Profile.isValid("Profile_1.a-b"))
        #expect(!Profile.isValid(""))
        #expect(!Profile.isValid("../etc"))
        #expect(!Profile.isValid("a b"))
        #expect(!Profile.isValid(String(repeating: "a", count: 65)))
        #expect(!Profile.isValid("é"))
    }
}
