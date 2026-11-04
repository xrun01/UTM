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

/// 零拷贝 IOSurface Metal 呈现器：直接将宿主引擎合成的 IOSurfaceRef 绑定为 MTLTexture 呈现至 MTKView
final class VMIOSurfaceMetalRenderer: NSObject, MTKViewDelegate {
    private let device: MTLDevice
    private let commandQueue: MTLCommandQueue?
    private var currentTexture: MTLTexture?
    private var currentSurface: IOSurfaceRef?
    var cropNormalizedRect: CGRect = CGRect(x: 0, y: 0, width: 1, height: 1)

    init?(device: MTLDevice) {
        self.device = device
        self.commandQueue = device.makeCommandQueue()
        super.init()
    }

    func updateIOSurface(_ surface: IOSurfaceRef) {
        let width = IOSurfaceGetWidth(surface)
        let height = IOSurfaceGetHeight(surface)
        guard width > 0, height > 0 else { return }
        let desc = MTLTextureDescriptor.texture2DDescriptor(
            pixelFormat: .bgra8Unorm,
            width: width,
            height: height,
            mipmapped: false
        )
        desc.usage = [.shaderRead]
        desc.storageMode = .shared
        self.currentSurface = surface
        self.currentTexture = device.makeTexture(descriptor: desc, iosurface: surface, plane: 0)
    }

    func mtkView(_ view: MTKView, drawableSizeWillChange size: CGSize) {}

    func draw(in view: MTKView) {
        guard let drawable = view.currentDrawable,
              let commandBuffer = commandQueue?.makeCommandBuffer() else {
            return
        }
        if let srcTexture = currentTexture,
           let blit = commandBuffer.makeBlitCommandEncoder() {
            let dstTexture = drawable.texture
            let srcX = Int(CGFloat(srcTexture.width) * cropNormalizedRect.origin.x)
            let srcY = Int(CGFloat(srcTexture.height) * cropNormalizedRect.origin.y)
            let srcW = max(1, min(srcTexture.width - srcX, Int(CGFloat(srcTexture.width) * cropNormalizedRect.size.width)))
            let srcH = max(1, min(srcTexture.height - srcY, Int(CGFloat(srcTexture.height) * cropNormalizedRect.size.height)))
            let copyW = min(srcW, dstTexture.width)
            let copyH = min(srcH, dstTexture.height)
            if copyW > 0 && copyH > 0 {
                blit.copy(
                    from: srcTexture,
                    sourceSlice: 0,
                    sourceLevel: 0,
                    sourceOrigin: MTLOrigin(x: srcX, y: srcY, z: 0),
                    sourceSize: MTLSize(width: copyW, height: copyH, depth: 1),
                    to: dstTexture,
                    destinationSlice: 0,
                    destinationLevel: 0,
                    destinationOrigin: MTLOrigin(x: 0, y: 0, z: 0)
                )
            }
            blit.endEncoding()
        } else if let rpd = view.currentRenderPassDescriptor,
                  let enc = commandBuffer.makeRenderCommandEncoder(descriptor: rpd) {
            enc.endEncoding()
        }
        commandBuffer.present(drawable)
        commandBuffer.commit()
    }
}
