import UIKit

/// Applies a feature-owned value without interrupting marked text or reducing
/// an existing selection to a caret. This holds no editor or secret state.
@MainActor enum NativeTextFieldProjection {
    static func apply(_ text: String, to field: UITextField) {
        guard field.markedTextRange == nil, field.text != text else { return }
        let selection = field.selectedTextRange.map {
            (field.offset(from: field.beginningOfDocument, to: $0.start),
             field.offset(from: field.beginningOfDocument, to: $0.end))
        }
        field.text = text
        guard let selection else { return }
        let length = field.offset(from: field.beginningOfDocument, to: field.endOfDocument)
        let lower = max(0, min(selection.0, length))
        let upper = max(lower, min(selection.1, length))
        guard let start = field.position(from: field.beginningOfDocument, offset: lower),
              let end = field.position(from: field.beginningOfDocument, offset: upper) else { return }
        field.selectedTextRange = field.textRange(from: start, to: end)
    }
}
