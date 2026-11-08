import Foundation

/// Reads framed requests until EOF and writes one framed reply for each.
/// Returns the process exit code: 0 at a clean EOF, 2 after an oversized or truncated frame.
public func serve(_ service: Service, input: ByteSource, output: (Data) -> Void) -> Int32 {
    let reader = FrameReader(input)
    while true {
        let body: Data
        do {
            switch try reader.next() {
            case .eof: return 0
            case .frame(let data): body = data
            }
        } catch {
            output(Framing.encode((try? JSONEncoder().encode(Response.failure(error))) ?? Data()))
            return 2
        }
        var reply = Framing.encode(service.handle(body))
        output(reply)
        wipe(&reply)
    }
}
