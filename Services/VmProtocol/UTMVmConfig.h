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

NS_ASSUME_NONNULL_BEGIN

typedef NS_ENUM(NSInteger, UTMVmNetworkMode) {
    UTMVmNetworkModeShared = 0,
    UTMVmNetworkModeBridged = 1,
    UTMVmNetworkModeHostOnly = 2,
};

@interface UTMVmDiskConfig : NSObject
@property (nonatomic, copy) NSString *identifier;
@property (nonatomic, copy) NSString *imagePath;
@property (nonatomic, assign) BOOL isReadOnly;
@property (nonatomic, assign) BOOL isOptical;
@property (nonatomic, assign) uint64_t sizeBytes;
@end

@interface UTMVmSharedFolderConfig : NSObject
@property (nonatomic, copy) NSString *shareName;
@property (nonatomic, copy) NSString *hostPath;
@property (nonatomic, assign) BOOL isReadOnly;
@end

@interface UTMVmPortForwardConfig : NSObject
@property (nonatomic, copy) NSString *protocolName;
@property (nonatomic, assign) uint16_t hostPort;
@property (nonatomic, assign) uint16_t guestPort;
@property (nonatomic, copy, nullable) NSString *guestAddress;
@end

@interface UTMVmConfig : NSObject
@property (nonatomic, copy) NSString *vmUUID;
@property (nonatomic, copy) NSString *vmName;
@property (nonatomic, assign) NSUInteger cpuCount;
@property (nonatomic, assign) uint64_t memorySizeBytes;
@property (nonatomic, assign) uint64_t hostMemQuotaMinBytes;
@property (nonatomic, assign) uint64_t hostMemQuotaMaxBytes;
@property (nonatomic, assign) BOOL adaptiveBalloonEnabled;
@property (nonatomic, copy) NSString *efiFirmwarePath;
@property (nonatomic, copy) NSString *monitorDylibPath;
@property (nonatomic, assign) BOOL useGenericVirtualization;
@property (nonatomic, assign) BOOL coherenceEnabled;
@property (nonatomic, assign) BOOL sharedProfileEnabled;
@property (nonatomic, assign) UTMVmNetworkMode networkMode;
@property (nonatomic, copy, nullable) NSString *bridgedInterfaceIdentifier;
@property (nonatomic, copy) NSArray<UTMVmDiskConfig *> *disks;
@property (nonatomic, copy) NSArray<UTMVmSharedFolderConfig *> *sharedFolders;
@property (nonatomic, copy) NSArray<UTMVmPortForwardConfig *> *portForwards;
@property (nonatomic, assign) BOOL audioOutputEnabled;
@property (nonatomic, assign) BOOL audioInputEnabled;
@property (nonatomic, assign) CGSize initialDisplaySize;
@property (nonatomic, assign) CGFloat initialScaleFactor;
@property (nonatomic, assign) BOOL unattendedInstallEnabled;
@property (nonatomic, copy, nullable) NSString *unattendedUserName;
@property (nonatomic, copy, nullable) NSString *unattendedPassword;
@property (nonatomic, copy, nullable) NSString *unattendedLocale;

+ (NSUInteger)recommendedCpuCount;
+ (NSUInteger)recommendedMemorySizeMib;
+ (NSUInteger)recommendedDiskSizeGib;
+ (NSString *)detectedHostWindowsLocale;
+ (NSString *)defaultGuestUserName;
+ (nullable NSString *)generateUnattendedIsoAtPath:(NSString *)isoOutputPath
                                          userName:(NSString *)userName
                                          password:(nullable NSString *)password
                                            locale:(nullable NSString *)locale
                                             error:(NSError * _Nullable * _Nullable)error;
+ (nullable NSString *)prepareBootIsoForPath:(NSString *)sourceIsoPath
                             primaryDiskPath:(nullable NSString *)primaryDiskPath
                             targetDirectory:(NSString *)targetDir;
@end

@interface UTMVmCoherenceWindowInfo : NSObject
@property (nonatomic, assign) uint64_t windowId;
@property (nonatomic, assign) uint32_t guestPid;
@property (nonatomic, copy) NSString *title;
@property (nonatomic, copy) NSString *appPath;
@property (nonatomic, assign) CGRect guestFrame;
@property (nonatomic, assign) BOOL isVisible;
@property (nonatomic, assign) BOOL isActive;
@property (nonatomic, assign) BOOL isMinimized;
@property (nonatomic, assign) NSInteger zOrder;
@end

#ifdef __cplusplus
// 0xff8 字节静态配置内存块，直接承载 CPU、内存、气球配额、磁盘、网络与共享目录配置
struct alignas(16) VmXmlConfigurationBlock {
    uint8_t raw[0xff8];
    uint32_t cpuCount;
    uint32_t nestedVirtEnabled;
    uint64_t ramSizeBytes;
    uint64_t hostMemQuotaMinBytes;
    uint64_t hostMemQuotaMaxBytes;
    uint32_t adaptiveHypervisorEnabled;
    uint32_t networkMode;
    uint32_t sharedProfileEnabled;
    uint32_t coherenceEnabled;
    uint32_t displayWidth;
    uint32_t displayHeight;
    uint32_t displayDpi;
    double displayScale;
};

void utmVmPopulateXmlConfigBlock(VmXmlConfigurationBlock *block, UTMVmConfig *config);
#endif

NS_ASSUME_NONNULL_END
