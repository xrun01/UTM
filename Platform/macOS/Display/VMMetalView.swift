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
import MetalKit
import Carbon.HIToolbox

class VMMetalView: MTKView {
    weak var inputDelegate: VMMetalViewInputDelegate?
    private var wholeTrackingArea: NSTrackingArea?
    private var lastModifiers = NSEvent.ModifierFlags()
    private var lastKeyDown: Int?
    private(set) var isMouseCaptured = false
    private(set) var isFirstResponder = false
    private(set) var isMouseInWindow = false
    private var guestHardwareCursor: NSCursor?
    private var isGuestCursorVisible: Bool = true
    @Setting("HandleInitialClick") private var isHandleInitialClick: Bool = false
    @Setting("IsCtrlCmdSwapped") private var isCtrlCmdSwapped = false
    @Setting("IsCmdOptSwapped") private var isCmdOptSwapped = false
    @Setting("IsISOKeySwapped") private var isISOKeySwapped = false
    @Setting("IsCapsLockKey") private var isCapsLockKey: Bool = false

    private enum ModifierKeySwap {
        case none
        case ctrlCmd
        case cmdOpt
    }

    private var modifierKeySwap: ModifierKeySwap {
        if isCtrlCmdSwapped {
            return .ctrlCmd
        } else if isCmdOptSwapped {
            return .cmdOpt
        } else {
            return .none
        }
    }

    /// On ISO keyboards we have to switch `kVK_ISO_Section` and `kVK_ANSI_Grave`
    /// from: https://chromium.googlesource.com/chromium/src/+/lkgr/ui/events/keycodes/keyboard_code_conversion_mac.mm
    private func convertToCurrentLayout(for keycode: Int) -> Int {
        guard !isISOKeySwapped && KBGetLayoutType(Int16(LMGetKbdType())) == kKeyboardISO else {
            return keycode
        }
        switch keycode {
        case kVK_ISO_Section:
            return kVK_ANSI_Grave
        case kVK_ANSI_Grave:
            return kVK_ISO_Section
        default:
            return keycode
        }
    }
    
    /// Returns the scan code for the key code in the `event`, or `0` if scan code is unknown.
    private func getScanCodeForEvent(_ event: NSEvent) -> Int {
        if event.type == .keyDown || event.type == .keyUp {
            let keycode = convertToCurrentLayout(for: Int(event.keyCode))
            if keycode == CapsLockRemapper.hostKeyCode && CapsLockRemapper.shared.isActive {
                return Int(KeyCodeMap.keyCodeToScanCodes[kVK_CapsLock]!.down)
            }
            /// see KeyCodeMap file for explaination why the .down scan code is used for both key down and up
            return Int(KeyCodeMap.keyCodeToScanCodes[keycode]?.down ?? 0)
        } else {
            return 0
        }
    }
    
    override var acceptsFirstResponder: Bool { true }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        registerForDraggedTypes([.fileURL])
    }

    /// 计算等比缩放在视图尺寸内的有效内容区域（扣除上下或左右黑边内边距）
    static func aspectFitContentRect(for sourceSize: CGSize, in viewBounds: CGSize) -> CGRect {
        guard viewBounds.width > 0, viewBounds.height > 0, sourceSize.width > 0, sourceSize.height > 0 else {
            return CGRect(origin: .zero, size: viewBounds)
        }
        let srcAspect = sourceSize.width / sourceSize.height
        let dstAspect = viewBounds.width / viewBounds.height
        if srcAspect > dstAspect {
            let fitH = viewBounds.width / srcAspect
            return CGRect(x: 0, y: (viewBounds.height - fitH) * 0.5, width: viewBounds.width, height: fitH)
        } else {
            let fitW = viewBounds.height * srcAspect
            return CGRect(x: (viewBounds.width - fitW) * 0.5, y: 0, width: fitW, height: viewBounds.height)
        }
    }

    /// 将视图坐标（左下角为原点）转换为扣除黑边后的左上角原点归一化坐标 [0.0, 1.0]
    static func normalizedTopLeftPoint(for viewPoint: CGPoint, in viewBounds: CGSize, contentRect: CGRect) -> CGPoint {
        let rect = (contentRect.width > 0 && contentRect.height > 0) ? contentRect : CGRect(origin: .zero, size: viewBounds)
        guard rect.width > 0, rect.height > 0 else {
            return .zero
        }
        let relX = (viewPoint.x - rect.origin.x) / rect.width
        let relY = 1.0 - ((viewPoint.y - rect.origin.y) / rect.height)
        return CGPoint(x: max(0.0, min(1.0, relX)), y: max(0.0, min(1.0, relY)))
    }

    /// 将视图坐标转换为客户机像素坐标（左上角原点）
    static func guestPixelPoint(for viewPoint: CGPoint, in viewBounds: CGSize, contentRect: CGRect, guestSize: CGSize) -> CGPoint {
        let norm = normalizedTopLeftPoint(for: viewPoint, in: viewBounds, contentRect: contentRect)
        let gw = max(1.0, guestSize.width)
        let gh = max(1.0, guestSize.height)
        return CGPoint(x: round(norm.x * gw), y: round(norm.y * gh))
    }

    /// 客户机硬件光标原生呈现入口：接收 VirtIO GPU 位图、尺寸、热点与可见性，
    /// 由 VmDisplayHost 或 VmInputHost 在主机线程投递，无宿主端软件光标合成
    func updateGuestCursor(rgbaData: Data?, size: CGSize, hotSpot: CGPoint, visible: Bool) {
        isGuestCursorVisible = visible
        if let rgbaData = rgbaData, size.width > 0, size.height > 0 {
            let width = Int(size.width)
            let height = Int(size.height)
            if let rep = NSBitmapImageRep(
                bitmapDataPlanes: nil,
                pixelsWide: width,
                pixelsHigh: height,
                bitsPerSample: 8,
                samplesPerPixel: 4,
                hasAlpha: true,
                isPlanar: false,
                colorSpaceName: .deviceRGB,
                bytesPerRow: width * 4,
                bitsPerPixel: 32
            ), let dst = rep.bitmapData {
                rgbaData.copyBytes(to: dst, count: min(rgbaData.count, width * height * 4))
                let image = NSImage(size: size)
                image.addRepresentation(rep)
                guestHardwareCursor = NSCursor(image: image, hotSpot: hotSpot)
            }
        } else {
            guestHardwareCursor = nil
        }
        applyCurrentCursorState()
    }

    private func applyCurrentCursorState() {
        guard isMouseInWindow && isFirstResponder && !isMouseCaptured else {
            return
        }
        if !isGuestCursorVisible {
            NSCursor.tryHide()
        } else if let cursor = guestHardwareCursor {
            NSCursor.tryUnhide()
            cursor.set()
        } else {
            NSCursor.tryUnhide()
            NSCursor.arrow.set()
        }
    }
    
    override func becomeFirstResponder() -> Bool {
        isFirstResponder = true
        if isMouseInWindow {
            applyCurrentCursorState()
        }
        return super.becomeFirstResponder()
    }
    
    override func resignFirstResponder() -> Bool {
        isFirstResponder = false
        NSCursor.tryUnhide()
        if let lastKeyDown = lastKeyDown {
            inputDelegate?.keyUp(scanCode: lastKeyDown)
        }
        if lastModifiers.containsSpecialKeys {
            sendModifiers(lastModifiers, press: false)
            lastModifiers = []
        }
        return super.resignFirstResponder()
    }
    
    override func updateTrackingAreas() {
        let trackingArea = NSTrackingArea(rect: CGRect(origin: .zero, size: frame.size), options: [.mouseMoved, .mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self, userInfo: nil)
        logger.debug("update tracking area: \(trackingArea.rect)")
        if let oldTrackingArea = wholeTrackingArea {
            logger.debug("remove old tracking area: \(oldTrackingArea.rect)")
            removeTrackingArea(oldTrackingArea)
            NSCursor.tryUnhide()
        }
        wholeTrackingArea = trackingArea
        addTrackingArea(trackingArea)
        super.updateTrackingAreas()
    }
    
    override func mouseEntered(with event: NSEvent) {
        logger.debug("mouse entered (first responder: \(isFirstResponder))")
        isMouseInWindow = true
        syncUncapturedMouseLocation(with: event)
        if isFirstResponder {
            applyCurrentCursorState()
        }
    }
    
    override func mouseExited(with event: NSEvent) {
        logger.debug("mouse exited")
        isMouseInWindow = false
        NSCursor.tryUnhide()
    }
    
    private func syncUncapturedMouseLocation(with event: NSEvent) {
        guard !isMouseCaptured else { return }
        let converted = convert(event.locationInWindow, from: nil)
        inputDelegate?.mouseMove(absolutePoint: converted, buttonMask: NSEvent.pressedMouseButtons.inputButtons())
    }

    override func mouseDown(with event: NSEvent) {
        logger.trace("mouse down: \(event.buttonNumber)")
        syncUncapturedMouseLocation(with: event)
        inputDelegate?.mouseDown(button: .left, mask: NSEvent.pressedMouseButtons.inputButtons())
    }
    
    override func rightMouseDown(with event: NSEvent) {
        logger.trace("right mouse down: \(event.buttonNumber)")
        syncUncapturedMouseLocation(with: event)
        inputDelegate?.mouseDown(button: .right, mask: NSEvent.pressedMouseButtons.inputButtons())
    }
    
    override func otherMouseDown(with event: NSEvent) {
        logger.trace("other mouse down: \(event.buttonNumber)")
        syncUncapturedMouseLocation(with: event)
        switch event.buttonNumber {
        case 2: inputDelegate?.mouseDown(button: .middle, mask: NSEvent.pressedMouseButtons.inputButtons())
        case 3: inputDelegate?.mouseDown(button: .side, mask: NSEvent.pressedMouseButtons.inputButtons())
        case 4: inputDelegate?.mouseDown(button: .extra, mask: NSEvent.pressedMouseButtons.inputButtons())
        default: break
        }
    }
    
    override func mouseUp(with event: NSEvent) {
        logger.trace("mouse up: \(event.buttonNumber)")
        syncUncapturedMouseLocation(with: event)
        inputDelegate?.mouseUp(button: .left, mask: NSEvent.pressedMouseButtons.inputButtons())
    }
    
    override func rightMouseUp(with event: NSEvent) {
        logger.trace("right mouse up: \(event.buttonNumber)")
        syncUncapturedMouseLocation(with: event)
        inputDelegate?.mouseUp(button: .right, mask: NSEvent.pressedMouseButtons.inputButtons())
    }
    
    override func otherMouseUp(with event: NSEvent) {
        logger.trace("other mouse up: \(event.buttonNumber)")
        syncUncapturedMouseLocation(with: event)
        switch event.buttonNumber {
        case 2: inputDelegate?.mouseUp(button: .middle, mask: NSEvent.pressedMouseButtons.inputButtons())
        case 3: inputDelegate?.mouseUp(button: .side, mask: NSEvent.pressedMouseButtons.inputButtons())
        case 4: inputDelegate?.mouseUp(button: .extra, mask: NSEvent.pressedMouseButtons.inputButtons())
        default: break
        }
    }
    
    override func keyDown(with event: NSEvent) {
        guard !event.isARepeat else { return }
        logger.trace("key down: \(event.keyCode)")
        if event.modifierFlags.contains(.numericPad) {
            inputDelegate?.didUseNumericPad()
        }
        lastKeyDown = getScanCodeForEvent(event)
        inputDelegate?.keyDown(scanCode: lastKeyDown!)
    }
    
    override func keyUp(with event: NSEvent) {
        logger.trace("key up: \(event.keyCode)")
        lastKeyDown = nil
        inputDelegate?.keyUp(scanCode: getScanCodeForEvent(event))
    }
    
    override func flagsChanged(with event: NSEvent) {
        let modifiers = event.modifierFlags
        logger.trace("modifers: \(modifiers)")
        sendModifiers(lastModifiers.subtracting(modifiers), press: false)
        sendModifiers(modifiers.subtracting(lastModifiers), press: true)
        inputDelegate?.syncCapsLock(with: modifiers)
        lastModifiers = modifiers
        if !isMouseCaptured {
            super.flagsChanged(with: event)
        }
    }
    
    private func sendModifiers(_ modifier: NSEvent.ModifierFlags, press: Bool) {
        if modifier.contains(.capsLock) {
            let sc = Int(KeyCodeMap.keyCodeToScanCodes[kVK_CapsLock]!.down)
            if press {
                inputDelegate?.keyDown(scanCode: sc)
            } else {
                inputDelegate?.keyUp(scanCode: sc)
            }
        }
        if !modifier.isDisjoint(with: [.command, .leftCommand, .rightCommand]) {
            let vk = modifier.contains(.rightCommand) ? kVK_RightCommand : kVK_Command
            let vkSwapped: Int
            switch modifierKeySwap {
            case .ctrlCmd:
                vkSwapped = modifier.contains(.rightCommand) ? kVK_RightControl : kVK_Control
            case .cmdOpt:
                vkSwapped = modifier.contains(.rightCommand) ? kVK_RightOption : kVK_Option
            case .none:
                vkSwapped = vk
            }
            let sc = Int(KeyCodeMap.keyCodeToScanCodes[vkSwapped]!.down)
            if press {
                inputDelegate?.keyDown(scanCode: sc)
            } else {
                inputDelegate?.keyUp(scanCode: sc)
            }
        }
        if !modifier.isDisjoint(with: [.control, .leftControl, .rightControl]) {
            let vk = modifier.contains(.rightControl) ? kVK_RightControl : kVK_Control
            let vkSwapped = modifier.contains(.rightCommand) ? kVK_RightCommand : kVK_Command
            let sc = Int(KeyCodeMap.keyCodeToScanCodes[isCtrlCmdSwapped ? vkSwapped : vk]!.down)
            if press {
                inputDelegate?.keyDown(scanCode: sc)
            } else {
                inputDelegate?.keyUp(scanCode: sc)
            }
        }
        if modifier.contains(.function) {
            let sc = Int(KeyCodeMap.keyCodeToScanCodes[kVK_Function]!.down)
            if press {
                inputDelegate?.keyDown(scanCode: sc)
            } else {
                inputDelegate?.keyUp(scanCode: sc)
            }
        }
        if !modifier.isDisjoint(with: [.option, .leftOption, .rightOption]) {
            let vk = modifier.contains(.rightOption) ? kVK_RightOption : kVK_Option
            let vkSwapped: Int
            if modifierKeySwap == .cmdOpt {
                vkSwapped = modifier.contains(.rightOption) ? kVK_RightCommand : kVK_Command
            } else {
                vkSwapped = vk
            }
            let sc = Int(KeyCodeMap.keyCodeToScanCodes[vkSwapped]!.down)
            if press {
                inputDelegate?.keyDown(scanCode: sc)
            } else {
                inputDelegate?.keyUp(scanCode: sc)
            }
        }
        if !modifier.isDisjoint(with: [.shift, .leftShift, .rightShift]) {
            let vk = modifier.contains(.rightShift) ? kVK_RightShift : kVK_Shift
            let sc = Int(KeyCodeMap.keyCodeToScanCodes[vk]!.down)
            if press {
                inputDelegate?.keyDown(scanCode: sc)
            } else {
                inputDelegate?.keyUp(scanCode: sc)
            }
        }
    }
    
    override func mouseDragged(with event: NSEvent) {
        mouseMoved(with: event)
    }
    
    override func rightMouseDragged(with event: NSEvent) {
        mouseMoved(with: event)
    }
    
    override func otherMouseDragged(with event: NSEvent) {
        mouseMoved(with: event)
    }
    
    override func mouseMoved(with event: NSEvent) {
        logger.trace("mouse moved: \(event.deltaX), \(event.deltaY)")
        if isMouseCaptured {
            inputDelegate?.mouseMove(relativePoint: CGPoint(x: event.deltaX, y: -event.deltaY),
                                     buttonMask: NSEvent.pressedMouseButtons.inputButtons())
        } else {
            let location = event.locationInWindow
            let converted = convert(location, from: nil)
            inputDelegate?.mouseMove(absolutePoint: converted,
                                     buttonMask: NSEvent.pressedMouseButtons.inputButtons())
        }
    }
    
    override func scrollWheel(with event: NSEvent) {
        let dx = event.scrollingDeltaX
        let dy = event.scrollingDeltaY
        guard dx != 0 || dy != 0 else { return }
        logger.trace("scroll: dx=\(dx), dy=\(dy), precise=\(event.hasPreciseScrollingDeltas)")
        let mask = NSEvent.pressedMouseButtons.inputButtons()
        inputDelegate?.mouseScrollPrecise(dx: dx, dy: dy, isPrecise: event.hasPreciseScrollingDeltas, phase: event.phase, buttonMask: mask)
    }

    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        return .copy
    }

    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        let pasteboard = sender.draggingPasteboard
        let dropPoint = convert(sender.draggingLocation, from: nil)
        guard let urls = pasteboard.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL], !urls.isEmpty else {
            return false
        }
        if let delegate = inputDelegate {
            return delegate.handleDragDropURLs(urls, at: dropPoint)
        }
        let guestPoint = Self.guestPixelPoint(for: dropPoint, in: bounds.size, contentRect: CGRect(origin: .zero, size: bounds.size), guestSize: bounds.size)
        return UTMVmBridge.shared.dispatch(.dragDropFiles(filePaths: urls.map(\.path), guestPoint: guestPoint)).ok
    }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool {
        guard !isMouseCaptured else {
            return false
        }
        if let location = event?.locationInWindow {
            let converted = convert(location, from: nil)
            inputDelegate?.mouseMove(absolutePoint: converted,
                                     buttonMask: NSEvent.pressedMouseButtons.inputButtons())
        }
        return true
    }
}

extension VMMetalView {
    private var screenCenter: CGPoint? {
        guard let window = self.window else { return nil }
        guard let screen = window.screen else { return nil }
        let centerView = CGPoint(x: frame.size.width / 2, y: frame.size.height / 2)
        let centerWindow = convert(centerView, to: nil)
        var centerScreen = window.convertPoint(toScreen: centerWindow)
        let screenHeight = screen.frame.height
        centerScreen.y = screenHeight - centerScreen.y
        logger.debug("screen \(centerScreen.x), \(centerScreen.y)")
        return centerScreen
    }
    
    func captureMouse() {
        logger.trace("capture cursor")
        CGAssociateMouseAndMouseCursorPosition(0)
        CGWarpMouseCursorPosition(screenCenter ?? .zero)
        isMouseCaptured = true
        NSCursor.tryHide()
        CGSSetGlobalHotKeyOperatingMode(CGSMainConnectionID(), .disable)
        if isCapsLockKey {
            CapsLockRemapper.shared.apply()
        }
    }
    
    func releaseMouse() {
        logger.trace("release cursor")
        CGAssociateMouseAndMouseCursorPosition(1)
        isMouseCaptured = false
        if !isMouseInWindow {
            NSCursor.tryUnhide()
        }
        CGSSetGlobalHotKeyOperatingMode(CGSMainConnectionID(), .enable)
        if CapsLockRemapper.shared.isActive {
            // the physical release can arrive after the remap is gone, so never leave the guest holding Caps Lock
            inputDelegate?.keyUp(scanCode: Int(KeyCodeMap.keyCodeToScanCodes[kVK_CapsLock]!.down))
            CapsLockRemapper.shared.restore()
        }
    }
}

extension VMMetalView: NSAccessibilityGroup {
    override func accessibilityRole() -> NSAccessibility.Role? {
        .group
    }
    
    override func accessibilityRoleDescription() -> String? {
        NSLocalizedString("Capture Input", comment: "VMMetalView")
    }
    
    override func accessibilityLabel() -> String? {
        NSLocalizedString("Virtual Machine", comment: "VMMetalView")
    }
    
    override func accessibilityHelp() -> String? {
        NSLocalizedString("To capture input or to release the capture, press Command and Option at the same time.", comment: "VMMetalView")
    }
    
    override func isAccessibilityElement() -> Bool {
        true
    }
    
    override func isAccessibilityEnabled() -> Bool {
        true
    }
}

private extension NSCursor {
    private static var isCursorHidden: Bool = false
    
    static func tryHide() {
        if !NSCursor.isCursorHidden {
            NSCursor.hide()
            NSCursor.isCursorHidden = true
        }
    }
    
    static func tryUnhide() {
        if NSCursor.isCursorHidden {
            NSCursor.unhide()
            NSCursor.isCursorHidden = false
        }
    }
}

private extension NSEvent.ModifierFlags {
    var containsSpecialKeys: Bool {
        !self.isDisjoint(with: [.capsLock, .command, .control, .function, .option, .shift])
    }
}

private extension Int {
    func inputButtons() -> CSInputButton {
        var pressed = CSInputButton()
        if self & (1 << 0) != 0 {
            pressed.formUnion(.left)
        }
        if self & (1 << 1) != 0 {
            pressed.formUnion(.right)
        }
        if self & (1 << 2) != 0 {
            pressed.formUnion(.middle)
        }
        if self & (1 << 3) != 0 {
            pressed.formUnion(.side)
        }
        if self & (1 << 4) != 0 {
            pressed.formUnion(.extra)
        }
        return pressed
    }
}

private extension NSEvent.ModifierFlags {
    static var leftCommand: NSEvent.ModifierFlags {
        NSEvent.ModifierFlags(rawValue: 0x8)
    }
    
    static var rightCommand: NSEvent.ModifierFlags {
        NSEvent.ModifierFlags(rawValue: 0x10)
    }
    
    static var leftControl: NSEvent.ModifierFlags {
        NSEvent.ModifierFlags(rawValue: 0x1)
    }
    
    static var rightControl: NSEvent.ModifierFlags {
        NSEvent.ModifierFlags(rawValue: 0x2000)
    }
    
    static var leftOption: NSEvent.ModifierFlags {
        NSEvent.ModifierFlags(rawValue: 0x20)
    }
    
    static var rightOption: NSEvent.ModifierFlags {
        NSEvent.ModifierFlags(rawValue: 0x40)
    }
    
    static var leftShift: NSEvent.ModifierFlags {
        NSEvent.ModifierFlags(rawValue: 0x2)
    }
    
    static var rightShift: NSEvent.ModifierFlags {
        NSEvent.ModifierFlags(rawValue: 0x4)
    }
}
