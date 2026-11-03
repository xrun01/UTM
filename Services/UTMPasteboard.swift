//
// Copyright © 2020 osy. All rights reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
//

import AppKit

typealias SystemPasteboard = NSPasteboard
typealias SystemPasteboardType = NSPasteboard.PasteboardType

@objc class UTMPasteboard: NSObject {
    @objc(generalPasteboard)
    static let general = UTMPasteboard(for: SystemPasteboard.general)
    
    private(set) var changeCount: Int
    fileprivate let systemPasteboard: SystemPasteboard
    private var timer: Timer?
    private var listeners = Set<AnyHashable>()
    
    private init(for systemPasteboard: SystemPasteboard) {
        self.systemPasteboard = systemPasteboard
        self.changeCount = systemPasteboard.changeCount
    }
    
    @nonobjc func requestPollingMode<T>(forHashable hashable: T) where T: Hashable {
        if listeners.isEmpty {
            timer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { _ in
                self.onTimerTick()
            }
        }
        _ = listeners.insert(hashable)
    }
    
    @objc func requestPollingMode(forObject object: AnyHashable) {
        requestPollingMode(forHashable: object)
    }
    
    @nonobjc func releasePollingMode<T>(forHashable hashable: T) where T: Hashable {
        _ = listeners.remove(hashable)
        if listeners.isEmpty {
            timer?.invalidate()
            timer = nil
        }
    }
    
    @objc func releasePollingMode(forObject object: AnyHashable) {
        releasePollingMode(forHashable: object)
    }
    
    private func onTimerTick() {
        let newCount = systemPasteboard.changeCount
        if newCount > changeCount {
            if hasContents() {
                if let text = systemPasteboard.string(forType: .string), !text.isEmpty {
                    UTMVmBridge.shared.dispatch(.syncClipboard(text: text))
                }
            }
        }
        changeCount = newCount
    }

    @objc func hasContents() -> Bool {
        if let items = systemPasteboard.pasteboardItems {
            return items.count > 0
        }
        return false
    }
}
