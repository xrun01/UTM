//
// Copyright © 2026 xvm. All rights reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//

#import <Foundation/Foundation.h>
#import <CoreGraphics/CoreGraphics.h>
#import <IOSurface/IOSurfaceRef.h>
#import "UTMVmConfig.h"
#import "VmCommand.h"

NS_ASSUME_NONNULL_BEGIN

typedef NS_ENUM(uint32_t, UTMVmToolgateOpcode) {
    UTMVmToolgateOpPing = 1,
    UTMVmToolgateOpTimeSync = 2,
    UTMVmToolgateOpClipboardSync = 3,
    UTMVmToolgateOpDragDropNotify = 4,
    UTMVmToolgateOpCoherenceWindowSync = 5,
    UTMVmToolgateOpDisplayModeChange = 6,
    UTMVmToolgateOpSharedFolderStat = 7,
};

@class UTMVmBridge;

@protocol UTMVmBridgeDelegate <NSObject>
@optional
- (void)vmBridge:(UTMVmBridge *)bridge didUpdateIOSurface:(IOSurfaceRef)surface width:(NSUInteger)width height:(NSUInteger)height;
- (void)vmBridge:(UTMVmBridge *)bridge didUpdateCursorRGBA:(nullable NSData *)rgbaData size:(CGSize)size hotSpot:(CGPoint)hotSpot visible:(BOOL)visible;
- (void)vmBridge:(UTMVmBridge *)bridge didUpdateCoherenceWindows:(NSArray<UTMVmCoherenceWindowInfo *> *)windows;
- (void)vmBridge:(UTMVmBridge *)bridge didReceiveGuestClipboardString:(NSString *)text;
- (void)vmBridge:(UTMVmBridge *)bridge didReclaimBalloonBytes:(uint64_t)reclaimedBytes targetMemoryBytes:(uint64_t)targetMemoryBytes;
- (void)vmBridgeDidStop:(UTMVmBridge *)bridge errorMessage:(nullable NSString *)errorMessage;
@end

@interface UTMVmBridge : NSObject

@property (class, nonatomic, readonly) UTMVmBridge *shared;
@property (nonatomic, weak, nullable) id<UTMVmBridgeDelegate> delegate;
@property (nonatomic, readonly, getter=isRunning) BOOL running;
@property (nonatomic, readonly, getter=isPaused) BOOL paused;
@property (nonatomic, readonly, getter=isCoherenceMode) BOOL coherenceMode;
@property (nonatomic, readonly, getter=isCoherenceReady) BOOL coherenceReady;
@property (nonatomic, readonly) NSArray<UTMVmCoherenceWindowInfo *> *coherenceWindows;
@property (nonatomic, readonly, nullable) IOSurfaceRef currentIOSurface;
@property (nonatomic, readonly, nullable) UTMVmConfig *activeConfig;
@property (nonatomic, readonly) uint64_t reclaimedBalloonBytes;
@property (nonatomic, readonly, nullable) void *monitorDispatchTable;
@property (nonatomic, readonly) uint32_t monitorProtocolVersion;
@property (nonatomic, readonly) uint32_t monitorRegisteredSegments;
@property (nonatomic, readonly, nullable) NSString *monitorConsoleTail;
@property (nonatomic, readonly) uint32_t loadedFirmwareBytes;
@property (nonatomic, readonly, nullable) NSString *mountedGuestToolsIsoPath;
@property (nonatomic, readonly) uint64_t toolgateProcessedRequestCount;
@property (nonatomic, readonly) uint64_t dispatchedCommandCount;

// 统一枚举命令总线分发入口（GUI、无头模式与 MCP 共用唯一后台控制入口）
- (UTMVmCommandResult *)dispatchCommand:(UTMVmCommand *)command;
- (NSString *)dispatchCommandJson:(NSString *)jsonCommand;

// 面向 SwiftUI / ObjC 调用方的类型化便捷包装（内部统一构造 UTMVmCommand 并经 dispatchCommand: 分发）
- (BOOL)startWithConfig:(UTMVmConfig *)config error:(NSError * _Nullable * _Nullable)error;
- (BOOL)pauseWithError:(NSError * _Nullable * _Nullable)error;
- (BOOL)resumeWithError:(NSError * _Nullable * _Nullable)error;
- (BOOL)stopGracefully:(BOOL)graceful error:(NSError * _Nullable * _Nullable)error;

- (BOOL)mountGuestToolsIsoAtPath:(NSString *)isoPath error:(NSError * _Nullable * _Nullable)error;
- (uint32_t)submitToolgateRequestWithOp:(uint32_t)opcode
                                payload:(nullable const void *)payload
                                 length:(uint32_t)length
                         responseBuffer:(nullable void *)responseBuffer
                       responseCapacity:(uint32_t)responseCapacity
                              statusOut:(nullable int32_t *)statusOut;

- (void)updateDisplayResolution:(CGSize)pixelSize scaleFactor:(CGFloat)scaleFactor dpi:(uint32_t)dpi;
- (void)sendKeyCode:(uint16_t)scanCode isKeyDown:(BOOL)isKeyDown modifiers:(uint32_t)modifiers;
- (void)sendMouseMoveAbsolute:(CGPoint)normalizedPoint buttons:(uint32_t)buttons;
- (void)sendMouseDelta:(CGVector)delta buttons:(uint32_t)buttons;
- (void)sendScrollDeltaX:(CGFloat)deltaX deltaY:(CGFloat)deltaY isPrecise:(BOOL)isPrecise phase:(uint32_t)phase;

- (void)setCoherenceModeEnabled:(BOOL)enabled;
- (void)focusCoherenceWindow:(uint64_t)windowId;
- (void)moveCoherenceWindow:(uint64_t)windowId toRect:(CGRect)rect;
- (void)closeCoherenceWindow:(uint64_t)windowId;

- (void)updateSharedFolders:(NSArray<UTMVmSharedFolderConfig *> *)folders;
- (uint64_t)reclaimBalloonMemoryBytes:(uint64_t)targetBytes;
- (BOOL)captureCurrentScreenPNGToPath:(NSString *)pngPath error:(NSError * _Nullable * _Nullable)error;

- (void)syncHostClipboardString:(NSString *)text;
- (void)pollHostPasteboardIfNeeded;
- (BOOL)handleDragDropFileURLs:(NSArray<NSURL *> *)urls atGuestPoint:(CGPoint)point;
- (void)syncHostTimeWithTimeZone:(NSString *)timeZoneName offsetSeconds:(NSInteger)offsetSeconds;

- (BOOL)saveLiveStateToPath:(NSString *)stateFilePath
                  diskPaths:(NSArray<NSString *> *)diskPaths
                cloneSuffix:(NSString *)cloneSuffix
                      error:(NSError * _Nullable * _Nullable)error;
- (BOOL)restoreLiveStateFromPath:(NSString *)stateFilePath
                           error:(NSError * _Nullable * _Nullable)error;

@end

NS_ASSUME_NONNULL_END
