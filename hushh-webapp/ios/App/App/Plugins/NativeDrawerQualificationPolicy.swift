import UIKit
import CoreFoundation

enum NativeDrawerQualificationPolicy {
    // Only an acknowledged shell restart promotes a saved device preference.
    static let customPresentationAllowed = true
    static var experimentalInterfaceAvailable: Bool {
        guard customPresentationAllowed, #available(iOS 26.0, *) else { return false }
        return UIDevice.current.userInterfaceIdiom == .phone
    }
    static func requestedNativeInterface(in defaults: UserDefaults = .standard) -> Bool {
        // Same device-only JSON record written by the existing Preferences
        // service. Missing, malformed and non-Boolean values keep React.
        guard let stored = defaults.string(forKey: "CapacitorStorage.hushh_settings"),
              let data = stored.data(using: .utf8),
              let settings = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let value = settings["experimentalNativeInterface"] as? NSNumber,
              CFGetTypeID(value) == CFBooleanGetTypeID() else { return false }
        return value.boolValue
    }
    static func admits(_ idiom: UIUserInterfaceIdiom, enabled: Bool, coherentShell: Bool) -> Bool {
        switch idiom {
        case .phone: return enabled
        case .pad: return coherentShell
        default: return false
        }
    }
    static var deviceEligible: Bool {
        guard experimentalInterfaceAvailable else { return false }
        return admits(UIDevice.current.userInterfaceIdiom, enabled: enabled, coherentShell: coherentShell)
    }
    static func admitsCoherentPresentation(deviceEligible: Bool, coherentShell: Bool) -> Bool {
        deviceEligible && coherentShell
    }
    static var coherentPresentationEnabled: Bool {
        admitsCoherentPresentation(deviceEligible: deviceEligible, coherentShell: coherentShell)
    }
    private(set) static var coherentShell = customPresentationAllowed && requestedNativeInterface()
    @MainActor static func applySavedInterface(_ enabled: Bool) -> Bool {
        guard experimentalInterfaceAvailable, requestedNativeInterface() == enabled else { return false }
        coherentShell = enabled
        return true
    }
    static var enabled: Bool { coherentShell }
}
