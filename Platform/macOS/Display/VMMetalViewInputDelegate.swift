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

struct VMInputButton: OptionSet {
    let rawValue: UInt32
    static let left = VMInputButton(rawValue: 1 << 0)
    static let right = VMInputButton(rawValue: 1 << 1)
    static let middle = VMInputButton(rawValue: 1 << 2)
    static let side = VMInputButton(rawValue: 1 << 3)
    static let extra = VMInputButton(rawValue: 1 << 4)
}

typealias CSInputButton = VMInputButton

protocol VMMetalViewInputDelegate: AnyObject {
    var shouldUseCmdOptForCapture: Bool { get }
    func mouseMove(absolutePoint: CGPoint, buttonMask: CSInputButton)
    func mouseMove(relativePoint: CGPoint, buttonMask: CSInputButton)
    func mouseDown(button: CSInputButton, mask: CSInputButton)
    func mouseUp(button: CSInputButton, mask: CSInputButton)
    func mouseScroll(dy: CGFloat, buttonMask: CSInputButton)
    func mouseScrollPrecise(dx: CGFloat, dy: CGFloat, isPrecise: Bool, phase: NSEvent.Phase, buttonMask: CSInputButton)
    func keyDown(scanCode: Int)
    func keyUp(scanCode: Int)
    func syncCapsLock(with modifier: NSEvent.ModifierFlags?)
    func captureMouse()
    func releaseMouse()
    func didUseNumericPad()
    func handleDragDropURLs(_ urls: [URL], at point: CGPoint) -> Bool
}

extension VMMetalViewInputDelegate {
    func mouseScrollPrecise(dx: CGFloat, dy: CGFloat, isPrecise: Bool, phase: NSEvent.Phase, buttonMask: CSInputButton) {
        if dy != 0 {
            mouseScroll(dy: dy, buttonMask: buttonMask)
        }
    }

    func handleDragDropURLs(_ urls: [URL], at point: CGPoint) -> Bool {
        UTMVmBridge.shared.dispatch(.dragDropFiles(filePaths: urls.map(\.path), guestPoint: point)).ok
    }
}
