import UIKit

enum NativeDrawerQualificationPolicy {
    // One build-time switch for the complete custom presentation: bootstrap,
    // dock, chrome and drawers. Never swap renderers in a live document.
    // The independently owned standard bottom navigation is unaffected.
    static let customPresentationAllowed = true
    static func admits(_ idiom: UIUserInterfaceIdiom, enabled: Bool, coherentShell: Bool) -> Bool {
        switch idiom {
        case .phone: return enabled
        case .pad: return coherentShell
        default: return false
        }
    }
    static var deviceEligible: Bool {
        guard customPresentationAllowed else { return false }
        guard #available(iOS 26.0, *) else { return false }
        return admits(UIDevice.current.userInterfaceIdiom, enabled: enabled, coherentShell: coherentShell)
    }
    static var coherentShell: Bool {
        guard customPresentationAllowed else { return false }
        #if HUSHH_NATIVE_SHELL_QUALIFICATION
        // Explicit qualification binaries keep the selected renderer across
        // manual launches. This does not enable ordinary Debug/Release builds.
        return true
        #elseif DEBUG
        return ProcessInfo.processInfo.arguments.contains("--hushh-native-shell-qualification")
        #else
        return false
        #endif
    }
    static var enabled: Bool {
        guard customPresentationAllowed else { return false }
        #if DEBUG
        return coherentShell || ProcessInfo.processInfo.arguments.contains("--hushh-native-product-drawers-qualification")
        #else
        return coherentShell
        #endif
    }
}
