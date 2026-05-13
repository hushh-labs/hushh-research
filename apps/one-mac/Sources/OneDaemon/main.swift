// SPDX-FileCopyrightText: 2026 Hushh
// SPDX-License-Identifier: Apache-2.0

import Foundation
import OneIndexer
import OneMCPServer
import OneShared

@main
struct OneDaemon {
    static func main() {
        let log = OneLog.logger(.daemon)
        log.notice("ai.hushh.one.daemon stub starting; full lifecycle lands in Phase 1 PR-7")
    }
}
