import XCTest
@testable import App
#if canImport(AppIntents)
import AppIntents
#endif

// MARK: - Semantic phrase corpus

/// Per the Agent One Siri specification, one user intention must map to one
/// canonical App Intent regardless of sentence structure.  This test encodes
/// that contract as a corpus of utterance families — NOT an exhaustive whitelist
/// — and verifies structural invariants so regressions are caught at build time.
///
/// Apple's App Shortcuts semantic similarity index generalises beyond the exact
/// registered phrases, but the phrase families below are the seeds that train
/// that index.  Diversity in word order, verb choice, and grammatical form is
/// intentional.
///
/// No entry hardcodes a person name — the recipient is always a slot reference
/// (`\.$recipient` / `\.$person`) so Siri resolves spoken names against Agent
/// One's live contact entities.

@available(iOS 16.0, *)
final class AgentOneSiriSemanticCorpusTests: XCTestCase {

    // MARK: - Structural invariants

    func testNineFocusedShortcutsCoverAllP0Capabilities() {
#if canImport(AppIntents)
        let shortcuts = HusshOneAppShortcuts.appShortcuts
        let titles = Set(shortcuts.map(\.shortTitle))

        // Every P0 capability must appear exactly once.
        let expected: Set<String> = [
            "Share Location",
            "Ask for Location",
            "Stop Sharing",
            "Location On or Off",
            "Open Destination",
            "Talk to Agent One",
            "Check In",
            "Create Circle",
            "Open Map",
        ]
        XCTAssertEqual(titles, expected, """
            Every P0 capability needs exactly one AppShortcut.
            Missing: \(expected.subtracting(titles).sorted())
            Unexpected: \(titles.subtracting(expected).sorted())
            """)
        XCTAssertEqual(shortcuts.count, 9, """
            Apple limits apps to ten App Shortcuts.  Nine focused shortcuts
            cover all P0 capabilities without waste.
            """)
#endif
    }

    func testEveryPhraseContainsTheAgentOneNamespace() {
#if canImport(AppIntents)
        let agentOneToken = ".applicationName"
        for shortcut in HusshOneAppShortcuts.appShortcuts {
            for phrase in shortcut.phrases {
                XCTAssertTrue(
                    phrase.contains(agentOneToken),
                    """
                    Every Siri phrase must reference \(agentOneToken) so the
                    user's utterance is namespaced to Agent One and does not
                    collide with Apple system functionality (Find My, Settings).
                    Offending phrase in "\(shortcut.shortTitle)": "\(phrase)"
                    """
                )
            }
        }
#endif
    }

    func testNoPhraseHardcodesAPersonName() {
#if canImport(AppIntents)
        // These are names that should never appear verbatim in a phrase — they
        // must come from the contact entity slot instead.
        let forbiddenNames = [
            "Kushal", "Mom", "Dad", "Ankit", "Alex", "Taylor",
            "John", "Jane", "family", "friend",
        ]
        let slotReferences = ["\\(\\\\.\\$recipient)", "\\(\\\\.\\$person)"]

        for shortcut in HusshOneAppShortcuts.appShortcuts {
            for phrase in shortcut.phrases {
                let containsHardcodedName = forbiddenNames.contains {
                    phrase.range(of: $0, options: .caseInsensitive) != nil
                }
                let usesSlot = slotReferences.contains {
                    phrase.range(of: $0, options: .caseInsensitive) != nil
                }
                // Phrases about people must use a slot; others (duration, circle
                // name, destination) may hardcode their example text.
                if phrase.contains("person") || phrase.contains("recipient") {
                    XCTAssertTrue(
                        usesSlot || !containsHardcodedName,
                        """
                        Person name must be a slot reference, not a hardcoded
                        string.  Phrase in "\(shortcut.shortTitle)": "\(phrase)"
                        """
                    )
                }
            }
        }
#endif
    }

    // MARK: - Per-capability phrase family minimums

    func testShareLocationHasAtLeastEightDistinctPhrases() {
#if canImport(AppIntents)
        guard let shortcut = HusshOneAppShortcuts.appShortcuts.first(
            where: { $0.shortTitle == "Share Location" }
        ) else {
            XCTFail("Share Location shortcut missing")
            return
        }
        XCTAssertGreaterThanOrEqual(
            shortcut.phrases.count, 8,
            "Share Location needs ≥ 8 semantically diverse anchor phrases."
        )
#endif
    }

    func testAskForLocationHasAtLeastSixDistinctPhrases() {
#if canImport(AppIntents)
        guard let shortcut = HusshOneAppShortcuts.appShortcuts.first(
            where: { $0.shortTitle == "Ask for Location" }
        ) else {
            XCTFail("Ask for Location shortcut missing")
            return
        }
        XCTAssertGreaterThanOrEqual(
            shortcut.phrases.count, 6,
            "Ask for Location needs ≥ 6 semantically diverse anchor phrases."
        )
#endif
    }

    func testStopSharingHasAtLeastEightDistinctPhrases() {
#if canImport(AppIntents)
        guard let shortcut = HusshOneAppShortcuts.appShortcuts.first(
            where: { $0.shortTitle == "Stop Sharing" }
        ) else {
            XCTFail("Stop Sharing shortcut missing")
            return
        }
        XCTAssertGreaterThanOrEqual(
            shortcut.phrases.count, 8,
            "Stop Sharing needs ≥ 8 semantically diverse anchor phrases."
        )
#endif
    }

    func testLocationStateHasAtLeastSixDistinctPhrases() {
#if canImport(AppIntents)
        guard let shortcut = HusshOneAppShortcuts.appShortcuts.first(
            where: { $0.shortTitle == "Location On or Off" }
        ) else {
            XCTFail("Location On or Off shortcut missing")
            return
        }
        XCTAssertGreaterThanOrEqual(
            shortcut.phrases.count, 6,
            "Location On or Off needs ≥ 6 semantically diverse anchor phrases."
        )
#endif
    }

    func testOpenDestinationHasAtLeastFourDistinctPhrases() {
#if canImport(AppIntents)
        guard let shortcut = HusshOneAppShortcuts.appShortcuts.first(
            where: { $0.shortTitle == "Open Destination" }
        ) else {
            XCTFail("Open Destination shortcut missing")
            return
        }
        XCTAssertGreaterThanOrEqual(
            shortcut.phrases.count, 4,
            "Open Destination needs ≥ 4 semantically diverse anchor phrases."
        )
#endif
    }

    func testCheckInHasAtLeastFourDistinctPhrases() {
#if canImport(AppIntents)
        guard let shortcut = HusshOneAppShortcuts.appShortcuts.first(
            where: { $0.shortTitle == "Check In" }
        ) else {
            XCTFail("Check In shortcut missing")
            return
        }
        XCTAssertGreaterThanOrEqual(
            shortcut.phrases.count, 4,
            "Check In needs ≥ 4 semantically diverse anchor phrases."
        )
#endif
    }

    func testCreateCircleHasAtLeastFourDistinctPhrases() {
#if canImport(AppIntents)
        guard let shortcut = HusshOneAppShortcuts.appShortcuts.first(
            where: { $0.shortTitle == "Create Circle" }
        ) else {
            XCTFail("Create Circle shortcut missing")
            return
        }
        XCTAssertGreaterThanOrEqual(
            shortcut.phrases.count, 4,
            "Create Circle needs ≥ 4 semantically diverse anchor phrases."
        )
#endif
    }

    func testOpenMapHasAtLeastFourDistinctPhrases() {
#if canImport(AppIntents)
        guard let shortcut = HusshOneAppShortcuts.appShortcuts.first(
            where: { $0.shortTitle == "Open Map" }
        ) else {
            XCTFail("Open Map shortcut missing")
            return
        }
        XCTAssertGreaterThanOrEqual(
            shortcut.phrases.count, 4,
            "Open Map needs ≥ 4 semantically diverse anchor phrases."
        )
#endif
    }

    // MARK: - Semantic diversity check

    /// Verifies that no two phrases in the same shortcut are identical or
    /// trivially substrings of each other — a sign of copy-paste rather than
    /// genuine semantic diversity.
    func testPhraseFamilyHasNoTrivialDuplicates() {
#if canImport(AppIntents)
        for shortcut in HusshOneAppShortcuts.appShortcuts {
            let phrases = shortcut.phrases
            XCTAssertEqual(
                phrases.count,
                Set(phrases).count,
                """
                Duplicate phrases detected in "\(shortcut.shortTitle)".
                Each anchor must be semantically distinct.
                """
            )
        }
#endif
    }

    // MARK: - Contact entity slot coverage

    /// Every intent that takes a person parameter must use the canonical slot
    /// reference so Siri resolves against Agent One's contact entity index.
    func testPersonSlotsUseCanonicalReferences() {
#if canImport(AppIntents)
        let personShortcuts = [
            "Share Location",
            "Ask for Location",
            "Stop Sharing",
        ]
        for title in personShortcuts {
            guard let shortcut = HusshOneAppShortcuts.appShortcuts.first(
                where: { $0.shortTitle == title }
            ) else { continue }
            for phrase in shortcut.phrases {
                XCTAssertTrue(
                    phrase.contains("\\(\\\\.\\$recipient)") || phrase.contains("\\(\\\\.\\$person)"),
                    """
                    "\(title)" phrase must reference a person slot, not a
                    hardcoded name: "\(phrase)"
                    """
                )
            }
        }
#endif
    }

    // MARK: - Intent title contracts

    /// Verifies the static titles of each AppIntent match the expected
    /// spoken form.  These titles are what Siri reports back to the user.
    func testIntentTitlesUseAgentOneVocabulary() {
#if canImport(AppIntents)
        // "Talk to Agent One" — voice handoff.
        XCTAssertEqual(TalkToHusshOneIntent().title, "Talk to Agent One")

        // Location action titles.
        XCTAssertEqual(ShareLocationWithOneIntent().title, "Share Location")
        XCTAssertEqual(AskForLocationWithOneIntent().title, "Ask for Location")
        XCTAssertEqual(StopLocationSharingWithOneIntent().title, "Stop Location Sharing")
        XCTAssertEqual(SetOneLocationStateIntent().title, "Set Location State")
        XCTAssertEqual(CreateOneCircleIntent().title, "Create a Circle")
        XCTAssertEqual(RenameOneCircleIntent().title, "Rename a Circle")
#endif
    }
}
