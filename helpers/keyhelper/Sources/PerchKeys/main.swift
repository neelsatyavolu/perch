import Foundation
import PerchKeysCore

// Perch Keys: framed JSON requests on stdin, framed replies on stdout. Nothing else is written to
// stdout, and nothing about keys is written anywhere else.
let service = Service(backend: Backend.system)
let stdout = FileHandle.standardOutput
let code = serve(service, input: FileHandleSource(.standardInput)) { frame in
    stdout.write(frame)
}
exit(code)
