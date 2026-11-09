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
import QuartzCore

/// 最小 IOSurface 呈现器：把 CScreenMTL 产出的 IOSurfaceRef 直接绑定到 CALayer.contents，
/// 按等比缩放呈现，作为 Metal 设备不可用时的回退路径与窗口融合裁剪的同源纹理载体。
final class VMIOSurfaceLayerPresenter: NSObject {
    private let contentLayer = CALayer()
    private(set) var currentSurface: IOSurfaceRef?

    override init() {
        super.init()
        contentLayer.contentsGravity = .resize
        contentLayer.backgroundColor = NSColor.black.cgColor
        contentLayer.magnificationFilter = .linear
        contentLayer.minificationFilter = .linear
        contentLayer.isOpaque = true
        contentLayer.masksToBounds = true
    }

    /// 绑定到目标视图的图层树，图层尺寸随视图等比伸缩
    func attach(to view: NSView) {
        view.wantsLayer = true
        contentLayer.frame = view.bounds
        contentLayer.autoresizingMask = [.layerWidthSizable, .layerHeightSizable]
        if contentLayer.superlayer !== view.layer {
            contentLayer.removeFromSuperlayer()
            view.layer?.addSublayer(contentLayer)
        }
    }

    /// 更新当前呈现的 IOSurface，传 nil 清空画面
    func updateSurface(_ surface: IOSurfaceRef?) {
        currentSurface = surface
        contentLayer.contents = nil
        contentLayer.contents = surface
    }

    func clear() {
        currentSurface = nil
        contentLayer.contents = nil
    }

    /// 源画面在视图坐标中的等比缩放矩形，与 VMIOSurfaceMetalRenderer.contentRect 语义一致
    func contentRect(in viewBounds: CGSize) -> CGRect {
        return CGRect(origin: .zero, size: viewBounds)
    }
}
