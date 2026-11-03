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

/// Coherence 融合模式单应用宿主窗口：按客户机窗口矩形裁剪共享 IOSurfaceRef 纹理并同步窗口几何与焦点
final class VMCoherenceAppWindow: NSWindow, NSWindowDelegate {
    let guestWindowId: UInt64
    private let metalView: VMMetalView
    private var renderer: VMIOSurfaceMetalRenderer?
    private var isUpdatingFromGuest: Bool = false

    init(info: UTMVmCoherenceWindowInfo, surface: IOSurfaceRef?, totalSurfaceSize: CGSize) {
        self.guestWindowId = info.windowId
        let contentRect = info.guestFrame.isEmpty ? CGRect(x: 200, y: 200, width: 800, height: 600) : info.guestFrame
        self.metalView = VMMetalView(frame: CGRect(origin: .zero, size: contentRect.size))
        super.init(
            contentRect: contentRect,
            styleMask: [.borderless, .resizable, .miniaturizable, .closable],
            backing: .buffered,
            defer: false
        )
        self.title = info.title
        self.isOpaque = false
        self.backgroundColor = .clear
        self.hasShadow = true
        self.isMovableByWindowBackground = false
        self.delegate = self

        metalView.autoresizingMask = [.width, .height]
        metalView.device = MTLCreateSystemDefaultDevice()
        metalView.framebufferOnly = false
        if let dev = metalView.device {
            renderer = VMIOSurfaceMetalRenderer(device: dev)
            metalView.delegate = renderer
        }
        self.contentView = metalView
        updateWithInfo(info, surface: surface, totalSurfaceSize: totalSurfaceSize)
    }

    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }

    func updateWithInfo(_ info: UTMVmCoherenceWindowInfo, surface: IOSurfaceRef?, totalSurfaceSize: CGSize) {
        isUpdatingFromGuest = true
        defer { isUpdatingFromGuest = false }

        self.title = info.title
        if !info.guestFrame.isEmpty && info.guestFrame != self.frame {
            setFrame(info.guestFrame, display: true)
        }
        if totalSurfaceSize.width > 0 && totalSurfaceSize.height > 0 && !info.guestFrame.isEmpty {
            let normRect = CGRect(
                x: max(0.0, min(1.0, info.guestFrame.origin.x / totalSurfaceSize.width)),
                y: max(0.0, min(1.0, info.guestFrame.origin.y / totalSurfaceSize.height)),
                width: max(0.01, min(1.0, info.guestFrame.size.width / totalSurfaceSize.width)),
                height: max(0.01, min(1.0, info.guestFrame.size.height / totalSurfaceSize.height))
            )
            renderer?.cropNormalizedRect = normRect
        }
        if let surface = surface {
            renderer?.updateIOSurface(surface)
        }
        metalView.needsDisplay = true
    }

    func windowDidBecomeKey(_ notification: Notification) {
        guard !isUpdatingFromGuest else { return }
        UTMVmBridge.shared.dispatch(.focusCoherenceWindow(windowId: guestWindowId))
    }

    func windowDidMove(_ notification: Notification) {
        guard !isUpdatingFromGuest else { return }
        UTMVmBridge.shared.dispatch(.moveCoherenceWindow(windowId: guestWindowId, rect: frame))
    }

    func windowDidResize(_ notification: Notification) {
        guard !isUpdatingFromGuest else { return }
        UTMVmBridge.shared.dispatch(.moveCoherenceWindow(windowId: guestWindowId, rect: frame))
    }

    func windowWillClose(_ notification: Notification) {
        UTMVmBridge.shared.dispatch(.closeCoherenceWindow(windowId: guestWindowId))
    }
}
