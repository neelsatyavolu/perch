/// Every failure the helper reports. The raw value is the `error` string in the reply, so it never
/// carries key material or OS error text.
public enum KeyError: String, Error, Sendable {
    case malformed = "malformed"
    case unknownOp = "unknown-op"
    case badProfile = "bad-profile"
    case tooLarge = "too-large"
    case truncated = "truncated"
    case missing = "missing"
    case exists = "exists"
    case unwrapFailed = "unwrap-failed"
    case wrapFailed = "wrap-failed"
    case badKeyLength = "bad-key-length"
    case badRecoveryKey = "bad-recovery-key"
    case wrapKeyUnavailable = "wrap-key-unavailable"
    case store = "store-failed"
    case `internal` = "internal"
}
