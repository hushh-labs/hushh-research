import SwiftUI
import UIKit

/// One owned child slot. Its coverage is retained through UIKit dismissal;
/// collection admission and child admission deliberately use different gates.
@MainActor final class NativeWalletPanelPresentation {
    static private(set) var presentationCount = 0
    private weak var workspace: NativeWorkspaceModel?
    private weak var parent: UIViewController?
    private var sheet: NativeProfileOwnedSheet?
    private var detail: NativeWalletDetailModel?
    private var detached = false
    private var retiring = false
    private var externalCoverage = false
    var coverage: (() -> Void)?
    var coversPresentation: Bool { sheet?.coversPresentation == true || retiring }
    var ready: Bool { workspace?.state.wallet?.selectedId == nil ? sheet == nil && !retiring : sheet?.presentationSettled == true && !retiring }
    init(model: NativeWorkspaceModel, parent: UIViewController) { workspace = model; self.parent = parent }
    func allows(_ visit: String, dismissed: Bool) -> Bool {
        guard let workspace, workspace.active, (dismissed || workspace.presentationComplete), !externalCoverage, !retiring, detail?.visit == visit,
              workspace.state.wallet?.detailVisitId == visit else { return false }
        let privacy = HushhSessionPrivacyShield.shared.snapshot()
        guard privacy.appIsActive, !privacy.shielded, privacy.generation == workspace.state.privacyGeneration else { return false }
        return dismissed ? detached : sheet?.presentationSettled == true && !detached
    }
    func setExternalCoverage(_ covered: Bool) {
        externalCoverage = covered
        updateEligibility()
    }
    func updateEligibility() {
        guard let detail else { return }
        detail.enabled = allows(detail.visit, dismissed: false) && workspace?.pending == nil
        workspace?.walletEditor?.model.setPresentationEnabled(detail.enabled)
    }
    func prepare(completion: @escaping (Bool) -> Void) {
        guard let model = workspace else { completion(false); return }
        guard let wallet = model.state.wallet, let visit = wallet.detailVisitId, wallet.selectedId != nil else {
            retire { completion(true) }; return
        }
        if let detail, (detail.visit == visit || !detached), !retiring {
            detail.update(model.state, wallet: wallet); detail.editor = model.walletEditor?.model
            sheet?.refresh()
            DispatchQueue.main.async { [weak self] in self?.updateEligibility(); completion(self?.ready == true) }
            return
        }
        if sheet != nil {
            retire { [weak self] in self?.prepare(completion: completion) }; return
        }
        guard #available(iOS 26.0, *), let parent, parent.presentedViewController == nil else { completion(false); return }
        detached = false
        let detail = NativeWalletDetailModel(model.state, wallet: wallet, visit: visit)
        self.detail = detail; detail.editor = model.walletEditor?.model
        detail.action = { [weak self, weak detail] row, text in
            guard let self, let detail, self.detail === detail else { return }
            _ = self.workspace?.choice("row", row: row, text: text, detailVisitId: detail.visit)
            self.updateEligibility()
        }
        detail.dismissFeedback = { [weak self, weak detail] id, origin in
            guard let self, let detail, self.detail === detail, detail.visit == origin else { return }
            _ = self.workspace?.choice("feedback-dismiss", row: id, detailVisitId: detail.visit)
        }
        let owned = NativeProfileOwnedSheet(makeHost: { [weak detail] in
            guard let detail else { return nil }; return UIHostingController(rootView: NativeWalletCardDetailBody(model: detail))
        }, canPresent: { [weak self] in guard let self, let current = self.detail else { return false }; return self.allowsPreparation(current.visit) }, canDismiss: { [weak self, weak detail] in
            guard let self, let detail else { return false }
            return self.allowsPreparation(detail.visit) && self.workspace?.presentationComplete == true && !self.detached && !detail.busy && self.workspace?.pending == nil
        }, hasPending: { [weak self] in self?.workspace?.pending != nil }, appearance: { [weak model] in
            guard let model else { return nil }; return HushhNativeControlAppearance(appearance: model.state.appearance, accentHex: model.state.accentHex, foregroundHex: model.state.foregroundHex)
        }, cancel: { [weak self, weak detail] in
            guard let self, let detail, self.detail === detail, !self.retiring else { return }
            self.detached = true; detail.enabled = false
            _ = self.workspace?.choice("row", row: detail.closeId, detailVisitId: detail.visit, dismissed: true)
        }, clear: { [weak detail] in detail?.clear() })
        owned.coverage = { [weak self] in self?.updateEligibility(); self?.coverage?() }
        sheet = owned
        Self.presentationCount = min(100_000, Self.presentationCount + 1)
        guard owned.present(from: parent, completion: { [weak self, weak owned] settled in
            guard let self, self.sheet === owned else { completion(false); return }
            self.updateEligibility(); completion(settled && self.ready)
        }) else { retire { completion(false) }; return }
    }
    private func allowsPreparation(_ visit: String) -> Bool {
        guard let workspace, workspace.active, !externalCoverage, !retiring, workspace.state.wallet?.detailVisitId == visit else { return false }
        let privacy = HushhSessionPrivacyShield.shared.snapshot()
        return privacy.appIsActive && !privacy.shielded && privacy.generation == workspace.state.privacyGeneration
    }
    func retire(completion: @escaping () -> Void) {
        guard let sheet else { completion(); return }
        retiring = true
        sheet.retire { [self] in
            if self.sheet === sheet { self.sheet = nil; detail = nil; detached = false; retiring = false }
            coverage?(); completion()
        }
    }
}
