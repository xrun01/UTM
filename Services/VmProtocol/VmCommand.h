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
#import "UTMVmConfig.h"

NS_ASSUME_NONNULL_BEGIN

// 统一虚拟机操作命令标签枚举（对标 Rust Enum 变体，覆盖 GUI、无头模式与 MCP 全部操作）
typedef NS_ENUM(uint32_t, VmCommandTag) {
    VmCommandTagQueryStatus = 1,
    VmCommandTagStart = 2,
    VmCommandTagPause = 3,
    VmCommandTagResume = 4,
    VmCommandTagStop = 5,
    VmCommandTagUpdateDisplay = 6,
    VmCommandTagCaptureScreen = 7,
    VmCommandTagSetCoherence = 8,
    VmCommandTagFocusCoherenceWindow = 9,
    VmCommandTagMoveCoherenceWindow = 10,
    VmCommandTagCloseCoherenceWindow = 11,
    VmCommandTagSendKey = 12,
    VmCommandTagSendMouseAbsolute = 13,
    VmCommandTagSendMouseDelta = 14,
    VmCommandTagSendMouseScroll = 15,
    VmCommandTagMountGuestToolsIso = 16,
    VmCommandTagUpdateSharedFolders = 17,
    VmCommandTagReclaimBalloonMemory = 18,
    VmCommandTagSyncClipboard = 19,
    VmCommandTagDragDropFiles = 20,
    VmCommandTagSyncHostTime = 21,
    VmCommandTagSubmitToolgate = 22,
    VmCommandTagSaveLiveSnapshot = 23,
    VmCommandTagRestoreLiveSnapshot = 24,
};

// 统一虚拟机后台事件标签枚举
typedef NS_ENUM(uint32_t, VmEventTag) {
    VmEventTagDisplaySurfaceUpdated = 1,
    VmEventTagCursorUpdated = 2,
    VmEventTagCoherenceWindowsUpdated = 3,
    VmEventTagClipboardUpdated = 4,
    VmEventTagLifecycleStopped = 5,
};

// 命令执行结果载体
@interface UTMVmCommandResult : NSObject
@property (nonatomic, assign) BOOL ok;
@property (nonatomic, assign) int32_t statusCode;
@property (nonatomic, assign) uint64_t uintValue;
@property (nonatomic, copy, nullable) NSString *stringValue;
@property (nonatomic, copy, nullable) NSData *responsePayload;
@property (nonatomic, copy, nullable) NSString *errorMessage;
@property (nonatomic, copy, nullable) NSDictionary<NSString *, id> *statusDictionary;

+ (instancetype)successWithUint:(uint64_t)val;
+ (instancetype)successWithString:(nullable NSString *)str;
+ (instancetype)successWithPayload:(nullable NSData *)payload status:(int32_t)status;
+ (instancetype)failureWithCode:(int32_t)code message:(NSString *)message;
- (NSString *)toJsonString;
@end

// 统一标签联合体命令对象（支持 Swift / ObjC / C++ 直接构造及 MCP JSON-RPC 双向序列化）
@interface UTMVmCommand : NSObject
@property (nonatomic, assign, readonly) VmCommandTag tag;
@property (nonatomic, strong, nullable) UTMVmConfig *config;
@property (nonatomic, assign) BOOL boolFlag;
@property (nonatomic, assign) BOOL secondaryBoolFlag;
@property (nonatomic, assign) uint64_t uint64Arg;
@property (nonatomic, assign) int64_t int64Arg;
@property (nonatomic, assign) uint32_t uint32Arg;
@property (nonatomic, assign) uint32_t secondaryUint32Arg;
@property (nonatomic, assign) uint16_t uint16Arg;
@property (nonatomic, assign) CGPoint pointArg;
@property (nonatomic, assign) CGSize sizeArg;
@property (nonatomic, assign) CGRect rectArg;
@property (nonatomic, assign) CGFloat floatArg;
@property (nonatomic, copy, nullable) NSString *pathArg;
@property (nonatomic, copy, nullable) NSString *secondaryStringArg;
@property (nonatomic, copy, nullable) NSArray<NSString *> *stringArrayArg;
@property (nonatomic, copy, nullable) NSArray<UTMVmSharedFolderConfig *> *sharedFoldersArg;
@property (nonatomic, copy, nullable) NSData *payloadArg;

- (instancetype)initWithTag:(VmCommandTag)tag;
+ (instancetype)queryStatusCommand;
+ (instancetype)startCommandWithConfig:(UTMVmConfig *)config;
+ (instancetype)pauseCommand;
+ (instancetype)resumeCommand;
+ (instancetype)stopCommandGracefully:(BOOL)graceful;
+ (instancetype)updateDisplayCommandWithSize:(CGSize)pixelSize scaleFactor:(CGFloat)scale dpi:(uint32_t)dpi;
+ (instancetype)captureScreenCommandToPath:(NSString *)pngPath;
+ (instancetype)setCoherenceCommandEnabled:(BOOL)enabled;
+ (instancetype)focusCoherenceWindowCommand:(uint64_t)windowId;
+ (instancetype)moveCoherenceWindowCommand:(uint64_t)windowId toRect:(CGRect)rect;
+ (instancetype)closeCoherenceWindowCommand:(uint64_t)windowId;
+ (instancetype)sendKeyCommand:(uint16_t)scanCode isKeyDown:(BOOL)isKeyDown modifiers:(uint32_t)modifiers;
+ (instancetype)sendMouseAbsoluteCommand:(CGPoint)normalizedPoint buttons:(uint32_t)buttons;
+ (instancetype)sendMouseDeltaCommand:(CGVector)delta buttons:(uint32_t)buttons;
+ (instancetype)sendMouseScrollCommand:(CGFloat)deltaX deltaY:(CGFloat)deltaY isPrecise:(BOOL)isPrecise phase:(uint32_t)phase;
+ (instancetype)mountGuestToolsIsoCommandAtPath:(NSString *)isoPath;
+ (instancetype)updateSharedFoldersCommand:(NSArray<UTMVmSharedFolderConfig *> *)folders;
+ (instancetype)reclaimBalloonMemoryCommand:(uint64_t)targetBytes;
+ (instancetype)syncClipboardCommand:(NSString *)text;
+ (instancetype)dragDropFilesCommand:(NSArray<NSString *> *)filePaths atGuestPoint:(CGPoint)point;
+ (instancetype)syncHostTimeCommandWithTimeZone:(NSString *)timeZoneName offsetSeconds:(NSInteger)offsetSeconds;
+ (instancetype)submitToolgateCommandWithOp:(uint32_t)opcode payload:(nullable NSData *)payload;
+ (instancetype)saveLiveSnapshotCommandToPath:(NSString *)statePath
                                    diskPaths:(NSArray<NSString *> *)diskPaths
                                  cloneSuffix:(NSString *)cloneSuffix;
+ (instancetype)restoreLiveSnapshotCommandFromPath:(NSString *)statePath;

// JSON <-> UTMVmCommand 编解码（服务于无头 CLI 与 MCP 工具调用）
+ (nullable instancetype)commandFromJsonObject:(NSDictionary<NSString *, id> *)dict
                                         error:(NSError * _Nullable * _Nullable)error;
+ (nullable instancetype)commandFromJsonString:(NSString *)jsonString
                                         error:(NSError * _Nullable * _Nullable)error;
- (NSDictionary<NSString *, id> *)toJsonObject;
- (NSString *)toJsonString;

// 导出全量 24 个命令变体的 MCP Tool Schema 描述表
+ (NSArray<NSDictionary<NSString *, id> *> *)mcpToolDefinitions;

@end

NS_ASSUME_NONNULL_END
