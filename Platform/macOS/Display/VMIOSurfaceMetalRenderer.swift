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

/// 零拷贝 IOSurface Metal 呈现器：直接将宿主引擎合成的 IOSurfaceRef 绑定为 MTLTexture 并通过着色器等比缩放呈现至 MTKView
final class VMIOSurfaceMetalRenderer: NSObject, MTKViewDelegate {
    private let device: MTLDevice
    private let commandQueue: MTLCommandQueue?
    private var pipelineState: MTLRenderPipelineState?
    private var samplerState: MTLSamplerState?
    private var currentTexture: MTLTexture?
    private var currentSurface: IOSurfaceRef?
    var cropNormalizedRect: CGRect = CGRect(x: 0, y: 0, width: 1, height: 1)

    private static let shaderSource = """
    #include <metal_stdlib>
    using namespace metal;

    struct VertexOut {
        float4 position [[position]];
        float2 uv;
    };

    vertex VertexOut iosurfaceVertex(uint vid [[vertex_id]],
                                     constant float4 &cropRect [[buffer(0)]]) {
        const float2 pos[4] = {
            float2(-1.0, -1.0),
            float2( 1.0, -1.0),
            float2(-1.0,  1.0),
            float2( 1.0,  1.0)
        };
        const float2 baseUv[4] = {
            float2(0.0, 1.0),
            float2(1.0, 1.0),
            float2(0.0, 0.0),
            float2(1.0, 0.0)
        };
        VertexOut out;
        out.position = float4(pos[vid], 0.0, 1.0);
        out.uv = cropRect.xy + baseUv[vid] * cropRect.zw;
        return out;
    }

    fragment half4 iosurfaceFragment(VertexOut in [[stage_in]],
                                     texture2d<half> tex [[texture(0)]],
                                     sampler smp [[sampler(0)]]) {
        half4 c = tex.sample(smp, in.uv);
        return half4(c.rgb, 1.0h);
    }
    """

    init?(device: MTLDevice) {
        self.device = device
        self.commandQueue = device.makeCommandQueue()
        super.init()
        setupPipeline()
    }

    private func setupPipeline() {
        let smpDesc = MTLSamplerDescriptor()
        smpDesc.minFilter = .linear
        smpDesc.magFilter = .linear
        smpDesc.sAddressMode = .clampToEdge
        smpDesc.tAddressMode = .clampToEdge
        self.samplerState = device.makeSamplerState(descriptor: smpDesc)

        guard let library = try? device.makeLibrary(source: Self.shaderSource, options: nil),
              let vfn = library.makeFunction(name: "iosurfaceVertex"),
              let ffn = library.makeFunction(name: "iosurfaceFragment") else {
            return
        }
        let desc = MTLRenderPipelineDescriptor()
        desc.vertexFunction = vfn
        desc.fragmentFunction = ffn
        desc.colorAttachments[0].pixelFormat = .bgra8Unorm
        self.pipelineState = try? device.makeRenderPipelineState(descriptor: desc)
    }

    func updateIOSurface(_ surface: IOSurfaceRef) {
        let width = IOSurfaceGetWidth(surface)
        let height = IOSurfaceGetHeight(surface)
        guard width > 0, height > 0 else { return }
        if let existingSurface = currentSurface,
           let existingTex = currentTexture,
           IOSurfaceGetID(existingSurface) == IOSurfaceGetID(surface),
           existingTex.width == width,
           existingTex.height == height {
            return
        }
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

    func contentRect(in viewBounds: CGSize) -> CGRect {
        guard viewBounds.width > 0, viewBounds.height > 0,
              let tex = currentTexture else {
            return CGRect(origin: .zero, size: viewBounds)
        }
        let srcW = max(1.0, CGFloat(tex.width) * cropNormalizedRect.width)
        let srcH = max(1.0, CGFloat(tex.height) * cropNormalizedRect.height)
        let scale = min(viewBounds.width / srcW, viewBounds.height / srcH)
        let fitW = srcW * scale
        let fitH = srcH * scale
        let offX = (viewBounds.width - fitW) * 0.5
        let offY = (viewBounds.height - fitH) * 0.5
        return CGRect(x: offX, y: offY, width: fitW, height: fitH)
    }

    func mtkView(_ view: MTKView, drawableSizeWillChange size: CGSize) {
        view.needsDisplay = true
    }

    func draw(in view: MTKView) {
        let backingScale = view.window?.backingScaleFactor ?? NSScreen.main?.backingScaleFactor ?? 2.0
        if view.layer?.contentsScale != backingScale {
            view.layer?.contentsScale = backingScale
        }
        let expectedDrawableSize = CGSize(
            width: max(1.0, round(view.bounds.width * backingScale)),
            height: max(1.0, round(view.bounds.height * backingScale))
        )
        if abs(view.drawableSize.width - expectedDrawableSize.width) > 1.0 ||
           abs(view.drawableSize.height - expectedDrawableSize.height) > 1.0 {
            view.drawableSize = expectedDrawableSize
        }
        guard let drawable = view.currentDrawable,
              let rpd = view.currentRenderPassDescriptor,
              let commandBuffer = commandQueue?.makeCommandBuffer() else {
            return
        }
        rpd.colorAttachments[0].loadAction = .clear
        rpd.colorAttachments[0].clearColor = MTLClearColor(red: 0.0, green: 0.0, blue: 0.0, alpha: 1.0)
        rpd.colorAttachments[0].storeAction = .store

        if let enc = commandBuffer.makeRenderCommandEncoder(descriptor: rpd) {
            if let srcTexture = currentTexture,
               let pso = pipelineState,
               let smp = samplerState {
                let dstW = Double(drawable.texture.width)
                let dstH = Double(drawable.texture.height)
                let srcW = max(1.0, Double(srcTexture.width) * Double(cropNormalizedRect.width))
                let srcH = max(1.0, Double(srcTexture.height) * Double(cropNormalizedRect.height))
                let scale = min(dstW / srcW, dstH / srcH)
                let vpW = max(1.0, srcW * scale)
                let vpH = max(1.0, srcH * scale)
                let vpX = (dstW - vpW) * 0.5
                let vpY = (dstH - vpH) * 0.5
                enc.setViewport(MTLViewport(originX: vpX, originY: vpY, width: vpW, height: vpH, znear: 0.0, zfar: 1.0))
                enc.setRenderPipelineState(pso)
                var crop = SIMD4<Float>(
                    Float(cropNormalizedRect.origin.x),
                    Float(cropNormalizedRect.origin.y),
                    Float(cropNormalizedRect.size.width),
                    Float(cropNormalizedRect.size.height)
                )
                enc.setVertexBytes(&crop, length: MemoryLayout<SIMD4<Float>>.stride, index: 0)
                enc.setFragmentTexture(srcTexture, index: 0)
                enc.setFragmentSamplerState(smp, index: 0)
                enc.drawPrimitives(type: .triangleStrip, vertexStart: 0, vertexCount: 4)
            }
            enc.endEncoding()
        }
        commandBuffer.present(drawable)
        commandBuffer.commit()
    }
}
