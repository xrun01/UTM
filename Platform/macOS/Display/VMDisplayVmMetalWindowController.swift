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
    private var layerPresenter: VMIOSurfaceLayerPresenter?
    private var resizeWorkItem: DispatchWorkItem?
    private var lastCapsLockOn: Bool = false
    @Setting("UseCmdOptForCapture") private var isUseCmdOptForCapture: Bool = false

    var shouldUseCmdOptForCapture: Bool {
        isUseCmdOptForCapture
    }

    override func windowDidLoad() {
        super.windowDidLoad()
        if let appleVM = vm as? UTMAppleVirtualMachine {
            appleVM.screenshotDelegate = self
            window?.title = appleVM.config.information.name
        }
        if let win = window {
            let targetSize = NSSize(width: 1280, height: 800)
            win.contentMinSize = NSSize(width: 640, height: 480)
            let frame = win.frameRect(forContentRect: CGRect(origin: win.frame.origin, size: targetSize))
            win.setFrame(frame, display: true)
            if ProcessInfo.processInfo.environment["UTM_HEADLESS_TEST"] != "1" {
                win.center()
            }
        }
        metalView = VMMetalView(frame: displayView.bounds)
        metalView.autoresizingMask = [.width, .height]
        metalView.device = MTLCreateSystemDefaultDevice()
        metalView.framebufferOnly = false
        metalView.isPaused = true
        metalView.enableSetNeedsDisplay = true
        metalView.inputDelegate = self
        if let dev = metalView.device {
            renderer = VMIOSurfaceMetalRenderer(device: dev)
            metalView.delegate = renderer
        } else {
            let presenter = VMIOSurfaceLayerPresenter()
            presenter.attach(to: metalView)
            layerPresenter = presenter
        }
        displayView.addSubview(metalView)
        UTMVmBridge.shared.delegate = self
        if let surface = UTMVmBridge.shared.currentIOSurface {
            renderer?.updateIOSurface(surface)
            layerPresenter?.updateSurface(surface)
            metalView.needsDisplay = (renderer != nil)
        }
    }

    override func enterLive() {
        super.enterLive()
        if let appleVM = vm as? UTMAppleVirtualMachine {
            window?.title = appleVM.config.information.name
        }
        screenshotView.isHidden = true
        metalView.isHidden = false
        UTMVmBridge.shared.delegate = self
        UTMPasteboard.general.requestPollingMode(forHashable: ObjectIdentifier(self))
        if let surface = UTMVmBridge.shared.currentIOSurface {
            renderer?.updateIOSurface(surface)
            layerPresenter?.updateSurface(surface)
            metalView.needsDisplay = (renderer != nil)
        }
        syncDynamicResolution()
        window?.makeFirstResponder(metalView)
    }

    override func close() {
        UTMPasteboard.general.releasePollingMode(forHashable: ObjectIdentifier(self))
        super.close()
    }

    private func updateMainWindowVisibilityForCoherence(windows: [UTMVmCoherenceWindowInfo]) {
        if UTMVmBridge.shared.isCoherenceMode && UTMVmBridge.shared.isCoherenceReady && !windows.isEmpty {
            window?.orderOut(nil)
        } else {
            window?.makeKeyAndOrderFront(nil)
        }
    }

    func toggleCoherenceMode() {
        let nextMode = !UTMVmBridge.shared.isCoherenceMode
        UTMVmBridge.shared.dispatch(.setCoherence(enabled: nextMode))
        if nextMode {
            updateMainWindowVisibilityForCoherence(windows: UTMVmBridge.shared.coherenceWindows)
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

    private func scheduleDebouncedResolutionSync() {
        metalView?.needsDisplay = true
        resizeWorkItem?.cancel()
        let item = DispatchWorkItem { [weak self] in
            self?.syncDynamicResolution()
        }
        resizeWorkItem = item
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(200), execute: item)
    }

    func windowDidResize(_ notification: Notification) {
        scheduleDebouncedResolutionSync()
    }

    func windowDidChangeBackingProperties(_ notification: Notification) {
        scheduleDebouncedResolutionSync()
    }

    func windowDidEnterFullScreen(_ notification: Notification) {
        syncDynamicResolution()
    }

    func windowDidExitFullScreen(_ notification: Notification) {
        syncDynamicResolution()
    }

    // MARK: - VMMetalViewInputDelegate

    private func currentModifierMask() -> UInt32 {
        let flags = NSEvent.modifierFlags
        var mask: UInt32 = 0
        if flags.contains(.shift) { mask |= 1 }
        if flags.contains(.control) { mask |= 2 }
        if flags.contains(.option) { mask |= 4 }
        if flags.contains(.command) { mask |= 8 }
        return mask
    }

    private func currentGuestPixelSize() -> CGSize {
        if let surface = UTMVmBridge.shared.currentIOSurface {
            let w = CGFloat(IOSurfaceGetWidth(surface))
            let h = CGFloat(IOSurfaceGetHeight(surface))
            if w > 0, h > 0 {
                return CGSize(width: w, height: h)
            }
        }
        let scale = window?.backingScaleFactor ?? 1.0
        let viewBounds = metalView?.bounds.size ?? displayView.bounds.size
        return CGSize(width: max(640, round(viewBounds.width * scale)),
                      height: max(480, round(viewBounds.height * scale)))
    }

    private func activeContentRect(in bounds: CGSize) -> CGRect {
        renderer?.contentRect(in: bounds)
            ?? layerPresenter?.contentRect(in: bounds)
            ?? VMMetalView.aspectFitContentRect(for: currentGuestPixelSize(), in: bounds)
    }

    func mouseMove(absolutePoint: CGPoint, buttonMask: CSInputButton) {
        let bounds = metalView.bounds.size
        guard bounds.width > 0, bounds.height > 0 else { return }
        let content = activeContentRect(in: bounds)
        let normPoint = VMMetalView.normalizedTopLeftPoint(for: absolutePoint, in: bounds, contentRect: content)
        UTMVmBridge.shared.dispatch(.sendMouseAbsolute(normalizedPoint: normPoint, buttons: buttonMask.rawValue))
    }

    func handleDragDropURLs(_ urls: [URL], at point: CGPoint) -> Bool {
        guard !urls.isEmpty else { return false }
        let bounds = metalView.bounds.size
        let content = activeContentRect(in: bounds)
        let guestPoint = VMMetalView.guestPixelPoint(for: point, in: bounds, contentRect: content, guestSize: currentGuestPixelSize())
        return UTMVmBridge.shared.dispatch(.dragDropFiles(filePaths: urls.map(\.path), guestPoint: guestPoint)).ok
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
        UTMVmBridge.shared.dispatch(.sendKey(scanCode: UInt16(truncatingIfNeeded: scanCode), isKeyDown: true, modifiers: currentModifierMask()))
    }

    func keyUp(scanCode: Int) {
        UTMVmBridge.shared.dispatch(.sendKey(scanCode: UInt16(truncatingIfNeeded: scanCode), isKeyDown: false, modifiers: currentModifierMask()))
    }

    func syncCapsLock(with modifier: NSEvent.ModifierFlags?) {
        guard let modifier = modifier else { return }
        let isCapsOn = modifier.contains(.capsLock)
        guard isCapsOn != lastCapsLockOn else { return }
        lastCapsLockOn = isCapsOn
        let modMask = currentModifierMask()
        UTMVmBridge.shared.dispatch(.sendKey(scanCode: 0x3a, isKeyDown: true, modifiers: modMask))
        UTMVmBridge.shared.dispatch(.sendKey(scanCode: 0x3a, isKeyDown: false, modifiers: modMask))
    }

    func captureMouse() {
        metalView?.captureMouse()
    }

    func releaseMouse() {
        metalView?.releaseMouse()
    }

    func didUseNumericPad() {
        UTMVmBridge.shared.dispatch(.sendKey(scanCode: 0x45, isKeyDown: true, modifiers: 0))
        UTMVmBridge.shared.dispatch(.sendKey(scanCode: 0x45, isKeyDown: false, modifiers: 0))
    }

    // MARK: - UTMVmBridgeDelegate

    func vmBridge(_ bridge: UTMVmBridge, didUpdate surface: IOSurfaceRef, width: UInt, height: UInt) {
        renderer?.updateIOSurface(surface)
        layerPresenter?.updateSurface(surface)
        metalView?.needsDisplay = (renderer != nil)
        VMCoherenceWindowManager.shared.updateSharedIOSurface(surface, totalSize: CGSize(width: CGFloat(width), height: CGFloat(height)))
    }

    func vmBridge(_ bridge: UTMVmBridge, didUpdateCursorRGBA rgbaData: Data?, size: CGSize, hotSpot: CGPoint, visible: Bool) {
        metalView?.updateGuestCursor(rgbaData: rgbaData, size: size, hotSpot: hotSpot, visible: visible)
    }

    func vmBridge(_ bridge: UTMVmBridge, didUpdateCoherenceWindows windows: [UTMVmCoherenceWindowInfo]) {
        VMCoherenceWindowManager.shared.syncWindows(windows)
        updateMainWindowVisibilityForCoherence(windows: windows)
    }

    func vmBridge(_ bridge: UTMVmBridge, didReceiveGuestClipboardString text: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        UTMPasteboard.general.markGuestClipboardApplied()
    }

    func vmBridge(_ bridge: UTMVmBridge, didReclaimBalloonBytes reclaimedBytes: UInt64, targetMemoryBytes: UInt64) {
        let reclaimedMib = reclaimedBytes / (1024 * 1024)
        let targetMib = targetMemoryBytes / (1024 * 1024)
        window?.subtitle = "Memory: \(targetMib) MB (Reclaimed \(reclaimedMib) MB)"
    }

    func vmBridgeDidStop(_ bridge: UTMVmBridge, errorMessage: String?) {
        UTMPasteboard.general.releasePollingMode(forHashable: ObjectIdentifier(self))
        VMCoherenceWindowManager.shared.closeAllWindows()
        window?.makeKeyAndOrderFront(nil)
        if let errorMessage = errorMessage {
            showErrorAlert(errorMessage)
        }
    }
}

extension VMDisplayVmMetalWindowController: UTMScreenshotProvider {
    var screenshot: UTMVirtualMachineScreenshot? {
        guard let view = metalView,
              let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else {
            return nil
        }
        view.cacheDisplay(in: view.bounds, to: rep)
        guard let cgImg = rep.cgImage else {
            return nil
        }
        let img = NSImage(cgImage: cgImg, size: view.bounds.size)
        return UTMVirtualMachineScreenshot(wrapping: img)
    }
}
