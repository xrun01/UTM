//
// Copyright © 2026 xvm. All rights reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//

import AppKit
import Metal
import MetalKit
import IOSurface

/// 绑定 UTMVmBridge 的 Metal 零拷贝显示窗口控制器，支持动态分辨率、硬件光标与 Coherence 融合切换
class VMDisplayVmMetalWindowController: VMDisplayWindowController, VMMetalViewInputDelegate, UTMVmBridgeDelegate {
    var metalView: VMMetalView!
    private var renderer: VMIOSurfaceMetalRenderer?
    @Setting("UseCmdOptForCapture") private var isUseCmdOptForCapture: Bool = false

    var shouldUseCmdOptForCapture: Bool {
        isUseCmdOptForCapture
    }

    override func windowDidLoad() {
        super.windowDidLoad()
        metalView = VMMetalView(frame: displayView.bounds)
        metalView.autoresizingMask = [.width, .height]
        metalView.device = MTLCreateSystemDefaultDevice()
        metalView.framebufferOnly = false
        metalView.inputDelegate = self
        if let dev = metalView.device {
            renderer = VMIOSurfaceMetalRenderer(device: dev)
            metalView.delegate = renderer
        }
        displayView.addSubview(metalView)
        UTMVmBridge.shared.delegate = self
        if let surface = UTMVmBridge.shared.currentIOSurface {
            renderer?.updateIOSurface(surface)
            metalView.needsDisplay = true
        }
    }

    override func enterLive() {
        super.enterLive()
        syncDynamicResolution()
        window?.makeFirstResponder(metalView)
    }

    func toggleCoherenceMode() {
        let nextMode = !UTMVmBridge.shared.isCoherenceMode
        UTMVmBridge.shared.dispatch(.setCoherence(enabled: nextMode))
        if nextMode {
            window?.orderOut(nil)
        } else {
            window?.makeKeyAndOrderFront(nil)
            syncDynamicResolution()
        }
    }

    private func syncDynamicResolution() {
        guard let win = window else { return }
        let scale = win.backingScaleFactor
        let viewBounds = metalView?.bounds.size ?? displayView.bounds.size
        let pixelSize = CGSize(width: max(640, round(viewBounds.width * scale)),
                               height: max(480, round(viewBounds.height * scale)))
        let dpi = UInt32(96.0 * scale)
        UTMVmBridge.shared.dispatch(.updateDisplay(size: pixelSize, scaleFactor: scale, dpi: dpi))
    }

    func windowDidResize(_ notification: Notification) {
        syncDynamicResolution()
    }

    func windowDidChangeBackingProperties(_ notification: Notification) {
        syncDynamicResolution()
    }

    func windowDidEnterFullScreen(_ notification: Notification) {
        syncDynamicResolution()
    }

    func windowDidExitFullScreen(_ notification: Notification) {
        syncDynamicResolution()
    }

    // MARK: - VMMetalViewInputDelegate

    func mouseMove(absolutePoint: CGPoint, buttonMask: CSInputButton) {
        let bounds = metalView.bounds.size
        guard bounds.width > 0, bounds.height > 0 else { return }
        let normX = max(0.0, min(1.0, absolutePoint.x / bounds.width))
        let normY = max(0.0, min(1.0, 1.0 - (absolutePoint.y / bounds.height)))
        UTMVmBridge.shared.dispatch(.sendMouseAbsolute(normalizedPoint: CGPoint(x: normX, y: normY), buttons: buttonMask.rawValue))
    }

    func mouseMove(relativePoint: CGPoint, buttonMask: CSInputButton) {
        UTMVmBridge.shared.dispatch(.sendMouseDelta(delta: CGVector(dx: relativePoint.x, dy: relativePoint.y), buttons: buttonMask.rawValue))
    }

    func mouseDown(button: CSInputButton, mask: CSInputButton) {
        UTMVmBridge.shared.dispatch(.sendMouseDelta(delta: .zero, buttons: mask.union(button).rawValue))
    }

    func mouseUp(button: CSInputButton, mask: CSInputButton) {
        UTMVmBridge.shared.dispatch(.sendMouseDelta(delta: .zero, buttons: mask.subtracting(button).rawValue))
    }

    func mouseScroll(dy: CGFloat, buttonMask: CSInputButton) {
        UTMVmBridge.shared.dispatch(.sendMouseScroll(deltaX: 0, deltaY: dy, isPrecise: false, phase: 0))
    }

    func mouseScrollPrecise(dx: CGFloat, dy: CGFloat, isPrecise: Bool, phase: NSEvent.Phase, buttonMask: CSInputButton) {
        UTMVmBridge.shared.dispatch(.sendMouseScroll(deltaX: dx, deltaY: dy, isPrecise: isPrecise, phase: UInt32(phase.rawValue)))
    }

    func keyDown(scanCode: Int) {
        UTMVmBridge.shared.dispatch(.sendKey(scanCode: UInt16(truncatingIfNeeded: scanCode), isKeyDown: true, modifiers: 0))
    }

    func keyUp(scanCode: Int) {
        UTMVmBridge.shared.dispatch(.sendKey(scanCode: UInt16(truncatingIfNeeded: scanCode), isKeyDown: false, modifiers: 0))
    }

    func syncCapsLock(with modifier: NSEvent.ModifierFlags?) {}

    func captureMouse() {
        metalView?.captureMouse()
    }

    func releaseMouse() {
        metalView?.releaseMouse()
    }

    func didUseNumericPad() {}

    // MARK: - UTMVmBridgeDelegate

    func vmBridge(_ bridge: UTMVmBridge, didUpdate surface: IOSurfaceRef, width: UInt, height: UInt) {
        renderer?.updateIOSurface(surface)
        metalView?.needsDisplay = true
        VMCoherenceWindowManager.shared.updateSharedIOSurface(surface, totalSize: CGSize(width: CGFloat(width), height: CGFloat(height)))
    }

    func vmBridge(_ bridge: UTMVmBridge, didUpdateCursorRGBA rgbaData: Data?, size: CGSize, hotSpot: CGPoint, visible: Bool) {
        metalView?.updateGuestCursor(rgbaData: rgbaData, size: size, hotSpot: hotSpot, visible: visible)
    }

    func vmBridge(_ bridge: UTMVmBridge, didUpdateCoherenceWindows windows: [UTMVmCoherenceWindowInfo]) {
        VMCoherenceWindowManager.shared.syncWindows(windows)
    }

    func vmBridge(_ bridge: UTMVmBridge, didReceiveGuestClipboardString text: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }

    func vmBridgeDidStop(_ bridge: UTMVmBridge, errorMessage: String?) {
        VMCoherenceWindowManager.shared.closeAllWindows()
        if let errorMessage = errorMessage {
            showErrorAlert(errorMessage)
        }
    }
}
