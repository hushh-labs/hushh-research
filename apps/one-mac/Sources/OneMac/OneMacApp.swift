// SPDX-FileCopyrightText: 2026 Hushh
// SPDX-License-Identifier: Apache-2.0

import SwiftUI

@main
struct OneMacApp: App {
    var body: some Scene {
        WindowGroup("One") {
            ContentView()
        }
    }
}

private struct ContentView: View {
    var body: some View {
        VStack(spacing: 16) {
            Text("🤫 One")
                .font(.largeTitle)
            Text("Hello, your agents — yours to own.")
                .foregroundStyle(.secondary)
        }
        .padding(40)
        .frame(minWidth: 480, minHeight: 320)
    }
}
