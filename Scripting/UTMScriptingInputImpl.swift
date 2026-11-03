//
// Copyright © 2025 Turing Software, LLC. All rights reserved.
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

import Foundation

private let kDelayNs: UInt64 = 20000000

@objc extension UTMScriptingVirtualMachineImpl {
    @objc func sendScanCode(_ command: NSScriptCommand) {
        let scanCodes = command.evaluatedArguments?["codes"] as? [Int]
        withScriptCommand(command) { [self] in
            guard vm.state == .started else {
                throw ScriptingError.notRunning
            }
            guard let scanCodes = scanCodes else {
                throw ScriptingError.invalidParameter
            }
            let bridge = UTMVmBridge.shared
            for scanCode in scanCodes {
                var code = scanCode
                if (code & 0xFF00) == 0xE000 {
                    code = 0x100 | (code & 0xFF)
                }
                if (code & 0x80) == 0x80 {
                    bridge.sendKeyCode(UInt16(code & 0x17F), isKeyDown: false, modifiers: 0)
                } else {
                    bridge.sendKeyCode(UInt16(code & 0x1FF), isKeyDown: true, modifiers: 0)
                }
                try await Task.sleep(nanoseconds: kDelayNs)
            }
        }
    }

    @objc func sendKeystroke(_ command: NSScriptCommand) {
        let keystrokes = command.evaluatedArguments?["keystrokes"] as? String
        let _modifiers = command.evaluatedArguments?["modifiers"] as? [AEKeyword] ?? []
        let modifiers = _modifiers.compactMap({ UTMScriptingModifierKey(rawValue: $0) })
        withScriptCommand(command) { [self] in
            func normalizeScanCode(_ scanCode: Int) -> UInt16 {
                var keyCode = scanCode
                if (keyCode & 0xFF00) == 0xE000 {
                    keyCode = (keyCode & 0xFF) | 0x100
                }
                return UInt16(keyCode & 0xFFFF)
            }

            guard vm.state == .started else {
                throw ScriptingError.notRunning
            }
            guard let keystrokes = keystrokes else {
                throw ScriptingError.invalidParameter
            }
            let bridge = UTMVmBridge.shared
            for modifier in modifiers {
                bridge.sendKeyCode(modifier.toScanCode(), isKeyDown: true, modifiers: 0)
                try await Task.sleep(nanoseconds: kDelayNs)
            }
            let keyboardMap = VMKeyboardMap()
            await keyboardMap.mapText(keystrokes) { scanCode in
                bridge.sendKeyCode(normalizeScanCode(scanCode), isKeyDown: false, modifiers: 0)
            } keyDown: { scanCode in
                bridge.sendKeyCode(normalizeScanCode(scanCode), isKeyDown: true, modifiers: 0)
            }
            try await Task.sleep(nanoseconds: kDelayNs)
            for modifier in modifiers {
                bridge.sendKeyCode(modifier.toScanCode(), isKeyDown: false, modifiers: 0)
                try await Task.sleep(nanoseconds: kDelayNs)
            }
        }
    }

    @objc func sendMouseClick(_ command: NSScriptCommand) {
        let coordinate = command.evaluatedArguments?["coordinate"] as? [Int]
        let _mouseButton = command.evaluatedArguments?["button"] as? AEKeyword ?? UTMScriptingMouseButton.left.rawValue
        let mouseButton = UTMScriptingMouseButton(rawValue: _mouseButton) ?? .left
        withScriptCommand(command) { [self] in
            guard vm.state == .started else {
                throw ScriptingError.notRunning
            }
            guard let coordinate = coordinate, coordinate.count == 2 else {
                throw ScriptingError.invalidParameter
            }
            let point = CGPoint(x: coordinate[0], y: coordinate[1])
            let mask = mouseButton.buttonMask()
            let bridge = UTMVmBridge.shared
            bridge.sendMouseMoveAbsolute(point, buttons: 0)
            try await Task.sleep(nanoseconds: kDelayNs)
            bridge.sendMouseMoveAbsolute(point, buttons: mask)
            try await Task.sleep(nanoseconds: kDelayNs)
            bridge.sendMouseMoveAbsolute(point, buttons: 0)
        }
    }
}

private extension UTMScriptingModifierKey {
    func toScanCode() -> UInt16 {
        switch self {
        case .capsLock: return 0x3a
        case .shift: return 0x2a
        case .control: return 0x1d
        case .option: return 0x38
        case .command: return 0x15b
        case .escape: return 0x01
        }
    }
}

private extension UTMScriptingMouseButton {
    func buttonMask() -> UInt32 {
        switch self {
        case .left: return 1
        case .right: return 2
        case .middle: return 4
        }
    }
}
