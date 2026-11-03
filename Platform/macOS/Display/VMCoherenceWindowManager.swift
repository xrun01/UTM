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
import IOSurface

/// Coherence 桌面融合窗口管理器：维护客户机顶层窗口句柄到 macOS 原生 NSWindow 的实时映射
final class VMCoherenceWindowManager {
    static let shared = VMCoherenceWindowManager()

    private var windowMap: [UInt64: VMCoherenceAppWindow] = [:]
    private var sharedSurface: IOSurfaceRef?
    private var totalSurfaceSize: CGSize = CGSize(width: 1920, height: 1080)

    private init() {}

    func updateSharedIOSurface(_ surface: IOSurfaceRef, totalSize: CGSize) {
        self.sharedSurface = surface
        self.totalSurfaceSize = totalSize
        for (_, win) in windowMap {
            win.contentView?.needsDisplay = true
        }
    }

    func syncWindows(_ infos: [UTMVmCoherenceWindowInfo]) {
        guard UTMVmBridge.shared.isCoherenceMode else {
            closeAllWindows()
            return
        }
        var activeIds = Set<UInt64>()
        let sortedInfos = infos.sorted { $0.zOrder < $1.zOrder }

        for info in sortedInfos {
            activeIds.insert(info.windowId)
            if let existing = windowMap[info.windowId] {
                existing.updateWithInfo(info, surface: sharedSurface, totalSurfaceSize: totalSurfaceSize)
                if info.isVisible && !info.isMinimized {
                    if info.isActive {
                        existing.makeKeyAndOrderFront(nil)
                    } else {
                        existing.orderFront(nil)
                    }
                } else {
                    existing.orderOut(nil)
                }
            } else if info.isVisible {
                let win = VMCoherenceAppWindow(info: info, surface: sharedSurface, totalSurfaceSize: totalSurfaceSize)
                windowMap[info.windowId] = win
                if info.isActive {
                    win.makeKeyAndOrderFront(nil)
                } else {
                    win.orderFront(nil)
                }
            }
        }

        let staleIds = Set(windowMap.keys).subtracting(activeIds)
        for staleId in staleIds {
            if let win = windowMap.removeValue(forKey: staleId) {
                win.orderOut(nil)
            }
        }
    }

    func closeAllWindows() {
        for (_, win) in windowMap {
            win.orderOut(nil)
        }
        windowMap.removeAll()
    }
}
