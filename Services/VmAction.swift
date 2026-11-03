//
// Copyright © 2026 xvm. All rights reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//

import Foundation
import CoreGraphics

/// 面向 SwiftUI 界面的强类型操作枚举（对标 Rust Enum，全量界面动作统一转为 UTMVmCommand 经 dispatchCommand 发送至后台引擎）
enum VmAction {
    case queryStatus
    case start(config: UTMVmConfig)
    case pause
    case resume
    case stop(graceful: Bool)
    case updateDisplay(size: CGSize, scaleFactor: CGFloat, dpi: UInt32)
    case captureScreen(pngPath: String)
    case setCoherence(enabled: Bool)
    case focusCoherenceWindow(windowId: UInt64)
    case moveCoherenceWindow(windowId: UInt64, rect: CGRect)
    case closeCoherenceWindow(windowId: UInt64)
    case sendKey(scanCode: UInt16, isKeyDown: Bool, modifiers: UInt32)
    case sendMouseAbsolute(normalizedPoint: CGPoint, buttons: UInt32)
    case sendMouseDelta(delta: CGVector, buttons: UInt32)
    case sendMouseScroll(deltaX: CGFloat, deltaY: CGFloat, isPrecise: Bool, phase: UInt32)
    case mountGuestToolsIso(isoPath: String)
    case updateSharedFolders(folders: [UTMVmSharedFolderConfig])
    case reclaimBalloonMemory(targetBytes: UInt64)
    case syncClipboard(text: String)
    case dragDropFiles(filePaths: [String], guestPoint: CGPoint)
    case syncHostTime(timeZoneName: String, offsetSeconds: Int)
    case submitToolgate(opcode: UInt32, payload: Data?)
    case saveLiveSnapshot(statePath: String, diskPaths: [String], cloneSuffix: String)
    case restoreLiveSnapshot(statePath: String)

    func toCommand() -> UTMVmCommand {
        switch self {
        case .queryStatus:
            return UTMVmCommand(tag: .queryStatus)
        case let .start(config):
            let cmd = UTMVmCommand(tag: .start)
            cmd.config = config
            return cmd
        case .pause:
            return UTMVmCommand(tag: .pause)
        case .resume:
            return UTMVmCommand(tag: .resume)
        case let .stop(graceful):
            let cmd = UTMVmCommand(tag: .stop)
            cmd.boolFlag = graceful
            return cmd
        case let .updateDisplay(size, scaleFactor, dpi):
            let cmd = UTMVmCommand(tag: .updateDisplay)
            cmd.sizeArg = size
            cmd.floatArg = scaleFactor
            cmd.uint32Arg = dpi
            return cmd
        case let .captureScreen(pngPath):
            let cmd = UTMVmCommand(tag: .captureScreen)
            cmd.pathArg = pngPath
            return cmd
        case let .setCoherence(enabled):
            let cmd = UTMVmCommand(tag: .setCoherence)
            cmd.boolFlag = enabled
            return cmd
        case let .focusCoherenceWindow(windowId):
            let cmd = UTMVmCommand(tag: .focusCoherenceWindow)
            cmd.uint64Arg = windowId
            return cmd
        case let .moveCoherenceWindow(windowId, rect):
            let cmd = UTMVmCommand(tag: .moveCoherenceWindow)
            cmd.uint64Arg = windowId
            cmd.rectArg = rect
            return cmd
        case let .closeCoherenceWindow(windowId):
            let cmd = UTMVmCommand(tag: .closeCoherenceWindow)
            cmd.uint64Arg = windowId
            return cmd
        case let .sendKey(scanCode, isKeyDown, modifiers):
            let cmd = UTMVmCommand(tag: .sendKey)
            cmd.uint16Arg = scanCode
            cmd.boolFlag = isKeyDown
            cmd.uint32Arg = modifiers
            return cmd
        case let .sendMouseAbsolute(normalizedPoint, buttons):
            let cmd = UTMVmCommand(tag: .sendMouseAbsolute)
            cmd.pointArg = normalizedPoint
            cmd.uint32Arg = buttons
            return cmd
        case let .sendMouseDelta(delta, buttons):
            let cmd = UTMVmCommand(tag: .sendMouseDelta)
            cmd.pointArg = CGPoint(x: delta.dx, y: delta.dy)
            cmd.uint32Arg = buttons
            return cmd
        case let .sendMouseScroll(deltaX, deltaY, isPrecise, phase):
            let cmd = UTMVmCommand(tag: .sendMouseScroll)
            cmd.pointArg = CGPoint(x: deltaX, y: deltaY)
            cmd.boolFlag = isPrecise
            cmd.uint32Arg = phase
            return cmd
        case let .mountGuestToolsIso(isoPath):
            let cmd = UTMVmCommand(tag: .mountGuestToolsIso)
            cmd.pathArg = isoPath
            return cmd
        case let .updateSharedFolders(folders):
            let cmd = UTMVmCommand(tag: .updateSharedFolders)
            cmd.sharedFoldersArg = folders
            return cmd
        case let .reclaimBalloonMemory(targetBytes):
            let cmd = UTMVmCommand(tag: .reclaimBalloonMemory)
            cmd.uint64Arg = targetBytes
            return cmd
        case let .syncClipboard(text):
            let cmd = UTMVmCommand(tag: .syncClipboard)
            cmd.pathArg = text
            return cmd
        case let .dragDropFiles(filePaths, guestPoint):
            let cmd = UTMVmCommand(tag: .dragDropFiles)
            cmd.stringArrayArg = filePaths
            cmd.pointArg = guestPoint
            return cmd
        case let .syncHostTime(timeZoneName, offsetSeconds):
            let cmd = UTMVmCommand(tag: .syncHostTime)
            cmd.pathArg = timeZoneName
            cmd.int64Arg = Int64(offsetSeconds)
            return cmd
        case let .submitToolgate(opcode, payload):
            let cmd = UTMVmCommand(tag: .submitToolgate)
            cmd.uint32Arg = opcode
            cmd.payloadArg = payload
            return cmd
        case let .saveLiveSnapshot(statePath, diskPaths, cloneSuffix):
            let cmd = UTMVmCommand(tag: .saveLiveSnapshot)
            cmd.pathArg = statePath
            cmd.stringArrayArg = diskPaths
            cmd.secondaryStringArg = cloneSuffix
            return cmd
        case let .restoreLiveSnapshot(statePath):
            let cmd = UTMVmCommand(tag: .restoreLiveSnapshot)
            cmd.pathArg = statePath
            return cmd
        }
    }
}

extension UTMVmBridge {
    @discardableResult
    func dispatch(_ action: VmAction) -> UTMVmCommandResult {
        dispatchCommand(action.toCommand())
    }
}
