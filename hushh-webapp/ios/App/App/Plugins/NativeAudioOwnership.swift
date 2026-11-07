import Foundation

/// Calls and One Voice share the process audio session. Neither may deactivate
/// the other's session during capture teardown.
enum NativeAudioOwnership {
    private static let lock = NSLock()
    private static var owner: ObjectIdentifier?
    static func claim(_ instance: AnyObject) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard owner == nil || owner == ObjectIdentifier(instance) else { return false }
        owner = ObjectIdentifier(instance)
        return true
    }
    static func release(_ instance: AnyObject) {
        lock.lock(); defer { lock.unlock() }
        if owner == ObjectIdentifier(instance) { owner = nil }
    }
}
