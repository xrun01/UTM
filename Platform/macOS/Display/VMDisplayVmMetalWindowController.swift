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
        metalView = VMMetalView(frame: displayView.bounds)
        metalView.translatesAutoresizingMaskIntoConstraints = false
        metalView.autoResizeDrawable = true
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
        NSLayoutConstraint.activate([
            metalView.topAnchor.constraint(equalTo: displayView.topAnchor),
            metalView.bottomAnchor.constraint(equalTo: displayView.bottomAnchor),
            metalView.leadingAnchor.constraint(equalTo: displayView.leadingAnchor),
            metalView.trailingAnchor.constraint(equalTo: displayView.trailingAnchor)
        ])
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
        syncDrawableScale()
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
        setControl([.drives, .sharedFolder], isEnabled: true)
        screenshotView.isHidden = true
        metalView.isHidden = false
        syncDrawableScale()
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

    private func syncDrawableScale() {
        guard let view = metalView else { return }
        let scale = window?.backingScaleFactor ?? NSScreen.main?.backingScaleFactor ?? 2.0
        if view.layer?.contentsScale != scale {
            view.layer?.contentsScale = scale
        }
        let bounds = view.bounds.size
        if bounds.width > 0 && bounds.height > 0 {
            let targetDrawable = CGSize(width: max(1.0, round(bounds.width * scale)),
                                        height: max(1.0, round(bounds.height * scale)))
            if view.drawableSize != targetDrawable {
                view.drawableSize = targetDrawable
            }
        }
    }

    private func syncDynamicResolution() {
        guard let win = window else { return }
        syncDrawableScale()
        let scale = win.backingScaleFactor
        let viewBounds = metalView?.bounds.size ?? displayView.bounds.size
        let currentRes = UTMVmBridge.shared.activeConfig?.initialDisplaySize ?? CGSize(width: 1280, height: 800)
        let surfaceW = UTMVmBridge.shared.currentIOSurface.map { CGFloat(IOSurfaceGetWidth($0)) } ?? 0
        let effectiveScale = (currentRes.width >= 1920.0 || currentRes.height >= 1200.0 || surfaceW >= 1920.0) ? scale : 1.0
        // 对齐 WDDM dispatchKmddWddmEntry 64 字节（16 像素）行距步幅与 EDID 偶数像素高，消除任意拖拽窗口时的黑边与模式拒绝
        let alignedW = CGFloat((max(640, Int(round(viewBounds.width * effectiveScale))) + 7) & ~15)
        let alignedH = CGFloat((max(480, Int(round(viewBounds.height * effectiveScale))) + 1) & ~1)
        let pixelSize = CGSize(width: alignedW, height: alignedH)
        let dpi = UInt32(96.0 * effectiveScale)
        UTMVmBridge.shared.dispatch(.updateDisplay(size: pixelSize, scaleFactor: scale, dpi: dpi))
    }

    private func scheduleDebouncedResolutionSync() {
        syncDrawableScale()
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

    private func currentNormalizedMousePoint() -> CGPoint {
        guard let view = metalView, let win = window else {
            return CGPoint(x: 0.5, y: 0.5)
        }
        let bounds = view.bounds.size
        guard bounds.width > 0, bounds.height > 0 else {
            return CGPoint(x: 0.5, y: 0.5)
        }
        let localPt = view.convert(win.mouseLocationOutsideOfEventStream, from: nil)
        let content = activeContentRect(in: bounds)
        return VMMetalView.normalizedTopLeftPoint(for: localPt, in: bounds, contentRect: content)
    }

    func mouseMove(relativePoint: CGPoint, buttonMask: CSInputButton) {
        UTMVmBridge.shared.dispatch(.sendMouseDelta(delta: CGVector(dx: relativePoint.x, dy: relativePoint.y), buttons: buttonMask.rawValue))
    }

    func mouseDown(button: CSInputButton, mask: CSInputButton) {
        let buttons = mask.union(button).rawValue
        if metalView?.isMouseCaptured == true {
            UTMVmBridge.shared.dispatch(.sendMouseDelta(delta: .zero, buttons: buttons))
        } else {
            UTMVmBridge.shared.dispatch(.sendMouseAbsolute(normalizedPoint: currentNormalizedMousePoint(), buttons: buttons))
        }
    }

    func mouseUp(button: CSInputButton, mask: CSInputButton) {
        let buttons = mask.subtracting(button).rawValue
        if metalView?.isMouseCaptured == true {
            UTMVmBridge.shared.dispatch(.sendMouseDelta(delta: .zero, buttons: buttons))
        } else {
            UTMVmBridge.shared.dispatch(.sendMouseAbsolute(normalizedPoint: currentNormalizedMousePoint(), buttons: buttons))
        }
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
        // 对标竞品无缝指针模式: 宿主与客户机共享绝对坐标映射, 不锁定宿主光标
        captureMouseToolbarButton?.state = .off
    }

    func releaseMouse() {
        metalView?.releaseMouse()
        captureMouseToolbarButton?.state = .off
    }

    func didUseNumericPad() {
        UTMVmBridge.shared.dispatch(.sendKey(scanCode: 0x45, isKeyDown: true, modifiers: 0))
        UTMVmBridge.shared.dispatch(.sendKey(scanCode: 0x45, isKeyDown: false, modifiers: 0))
    }

    // MARK: - 工具栏与菜单栏桥接动作

    override func captureMouseButtonPressed(_ sender: Any) {
        if metalView?.isMouseCaptured == true {
            releaseMouse()
        } else {
            captureMouse()
        }
    }

    override func resizeConsoleButtonPressed(_ sender: Any) {
        syncDynamicResolution()
    }

    override func didWake(_ notification: NSNotification) {
        super.didWake(notification)
        let tz = TimeZone.current
        UTMVmBridge.shared.dispatch(.syncHostTime(timeZoneName: tz.identifier, offsetSeconds: tz.secondsFromGMT()))
        syncDynamicResolution()
    }

    override func updateDrivesMenu(_ menu: NSMenu) {
        menu.autoenablesItems = false
        let toolsItem = NSMenuItem(
            title: NSLocalizedString("Install Windows Guest Tools…", comment: "VMDisplayVmMetalWindowController"),
            action: #selector(mountBundledGuestToolsIso(_:)),
            keyEquivalent: ""
        )
        toolsItem.target = self
        if let mounted = UTMVmBridge.shared.mountedGuestToolsIsoPath, !mounted.isEmpty {
            toolsItem.state = .on
        }
        menu.addItem(toolsItem)
        guard let appleVM = vm as? UTMAppleVirtualMachine else { return }
        let drives = appleVM.config.drives.filter(\.isExternal)
        if !drives.isEmpty {
            menu.addItem(.separator())
            for drive in drives {
                let item = NSMenuItem()
                item.title = drive.imageURL?.lastPathComponent
                    ?? NSLocalizedString("CD/DVD (empty)", comment: "VMDisplayVmMetalWindowController")
                item.isEnabled = false
                menu.addItem(item)
            }
        }
    }

    @objc private func mountBundledGuestToolsIso(_ sender: Any) {
        var candidates: [String] = []
        if let resDir = Bundle.main.resourcePath {
            candidates.append((resDir as NSString).appendingPathComponent("GuestTools.iso"))
        }
        candidates.append((FileManager.default.currentDirectoryPath as NSString).appendingPathComponent("git/UTM/lib/GuestTools.iso"))
        candidates.append((FileManager.default.currentDirectoryPath as NSString).appendingPathComponent("git/vm/engine/build/GuestTools/GuestTools.iso"))
        guard let isoPath = candidates.first(where: { FileManager.default.isReadableFile(atPath: $0) }) else {
            showErrorAlert("GuestTools.iso not found in application bundle.")
            return
        }
        let res = UTMVmBridge.shared.dispatch(.mountGuestToolsIso(isoPath: isoPath))
        if !res.ok, let msg = res.errorMessage {
            showErrorAlert(msg)
        }
    }

    override func updateSharedFolderMenu(_ menu: NSMenu) {
        menu.autoenablesItems = false
        guard let appleVM = vm as? UTMAppleVirtualMachine else { return }
        let entry = appleVM.registryEntry
        for i in entry.sharedDirectories.indices {
            let sharedDirectory = entry.sharedDirectories[i]
            let item = NSMenuItem(title: sharedDirectory.url.lastPathComponent, action: nil, keyEquivalent: "")
            let submenu = NSMenu()
            submenu.autoenablesItems = false
            let ro = NSMenuItem(
                title: NSLocalizedString("Read Only", comment: "VMDisplayVmMetalWindowController"),
                action: #selector(flipReadOnlyShare(_:)),
                keyEquivalent: ""
            )
            ro.target = self
            ro.tag = i
            ro.state = sharedDirectory.isReadOnly ? .on : .off
            submenu.addItem(ro)
            let remove = NSMenuItem(
                title: NSLocalizedString("Remove…", comment: "VMDisplayVmMetalWindowController"),
                action: #selector(removeShare(_:)),
                keyEquivalent: ""
            )
            remove.target = self
            remove.tag = i
            submenu.addItem(remove)
            item.submenu = submenu
            menu.addItem(item)
        }
        let add = NSMenuItem(
            title: NSLocalizedString("Add…", comment: "VMDisplayVmMetalWindowController"),
            action: #selector(addShare(_:)),
            keyEquivalent: ""
        )
        add.target = self
        menu.addItem(add)
    }

    private func syncSharedFoldersToBridge() {
        guard let appleVM = vm as? UTMAppleVirtualMachine else { return }
        let folders: [UTMVmSharedFolderConfig] = appleVM.registryEntry.sharedDirectories.map { share in
            let cfg = UTMVmSharedFolderConfig()
            cfg.shareName = share.url.lastPathComponent
            cfg.hostPath = share.url.path
            cfg.isReadOnly = share.isReadOnly
            return cfg
        }
        UTMVmBridge.shared.dispatch(.updateSharedFolders(folders: folders))
    }

    @objc private func addShare(_ sender: AnyObject) {
        guard let win = window, let appleVM = vm as? UTMAppleVirtualMachine else { return }
        let openPanel = NSOpenPanel()
        openPanel.title = NSLocalizedString("Select Shared Folder", comment: "VMDisplayVmMetalWindowController")
        openPanel.canChooseDirectories = true
        openPanel.canChooseFiles = false
        openPanel.beginSheetModal(for: win) { [weak self] response in
            guard response == .OK, let url = openPanel.url else { return }
            if let sharedDirectory = try? UTMRegistryEntry.File(url: url) {
                appleVM.registryEntry.sharedDirectories.append(sharedDirectory)
                self?.syncSharedFoldersToBridge()
            }
        }
    }

    @objc private func flipReadOnlyShare(_ sender: AnyObject) {
        guard let item = sender as? NSMenuItem,
              let appleVM = vm as? UTMAppleVirtualMachine,
              appleVM.registryEntry.sharedDirectories.indices.contains(item.tag) else { return }
        appleVM.registryEntry.sharedDirectories[item.tag].isReadOnly.toggle()
        syncSharedFoldersToBridge()
    }

    @objc private func removeShare(_ sender: AnyObject) {
        guard let item = sender as? NSMenuItem,
              let appleVM = vm as? UTMAppleVirtualMachine,
              appleVM.registryEntry.sharedDirectories.indices.contains(item.tag) else { return }
        appleVM.registryEntry.sharedDirectories.remove(at: item.tag)
        syncSharedFoldersToBridge()
    }

    override func updateKeyboardShortcutMenu(_ menu: NSMenu) {
        menu.autoenablesItems = false
        let shortcuts: [(String, Int)] = [
            ("Ctrl+Alt+Del", 1),
            ("Ctrl+Shift+Esc", 2),
            ("Win+R", 3),
            ("Win+E", 4),
            ("Win+L", 5),
            ("Alt+F4", 6),
            ("Alt+Tab", 7)
        ]
        for (title, tag) in shortcuts {
            let item = NSMenuItem(title: title, action: #selector(sendKeyCombo(_:)), keyEquivalent: "")
            item.target = self
            item.tag = tag
            menu.addItem(item)
        }
    }

    private func sendScanCodeCombo(_ codes: [UInt16], modifiers: UInt32) {
        for code in codes {
            UTMVmBridge.shared.dispatch(.sendKey(scanCode: code, isKeyDown: true, modifiers: modifiers))
        }
        for code in codes.reversed() {
            UTMVmBridge.shared.dispatch(.sendKey(scanCode: code, isKeyDown: false, modifiers: 0))
        }
    }

    @objc private func sendKeyCombo(_ sender: NSMenuItem) {
        switch sender.tag {
        case 1: // Ctrl+Alt+Del
            sendScanCodeCombo([0x1d, 0x38, 0xe053], modifiers: 6)
        case 2: // Ctrl+Shift+Esc
            sendScanCodeCombo([0x1d, 0x2a, 0x01], modifiers: 3)
        case 3: // Win+R
            sendScanCodeCombo([0xe05b, 0x13], modifiers: 8)
        case 4: // Win+E
            sendScanCodeCombo([0xe05b, 0x12], modifiers: 8)
        case 5: // Win+L
            sendScanCodeCombo([0xe05b, 0x26], modifiers: 8)
        case 6: // Alt+F4
            sendScanCodeCombo([0x38, 0x3e], modifiers: 4)
        case 7: // Alt+Tab
            sendScanCodeCombo([0x38, 0x0f], modifiers: 4)
        default:
            break
        }
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
        guard let surface = UTMVmBridge.shared.currentIOSurface else {
            return nil
        }
        IOSurfaceLock(surface, .readOnly, nil)
        defer { IOSurfaceUnlock(surface, .readOnly, nil) }
        let width = IOSurfaceGetWidth(surface)
        let height = IOSurfaceGetHeight(surface)
        let bytesPerRow = IOSurfaceGetBytesPerRow(surface)
        let baseAddr = IOSurfaceGetBaseAddress(surface)
        guard width > 0, height > 0, bytesPerRow >= width * 4 else {
            return nil
        }
        let byteCount = bytesPerRow * height
        let data = Data(bytes: baseAddr, count: byteCount)
        guard let provider = CGDataProvider(data: data as CFData),
              let colorSpace = CGColorSpace(name: CGColorSpace.sRGB),
              let cgImg = CGImage(
                  width: width,
                  height: height,
                  bitsPerComponent: 8,
                  bitsPerPixel: 32,
                  bytesPerRow: bytesPerRow,
                  space: colorSpace,
                  bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.noneSkipFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue),
                  provider: provider,
                  decode: nil,
                  shouldInterpolate: true,
                  intent: .defaultIntent
              ) else {
            return nil
        }
        let img = NSImage(cgImage: cgImg, size: NSSize(width: width, height: height))
        return UTMVirtualMachineScreenshot(wrapping: img)
    }
}
