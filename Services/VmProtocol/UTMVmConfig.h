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
#include <stddef.h>

NS_ASSUME_NONNULL_BEGIN

typedef NS_ENUM(NSInteger, UTMVmNetworkMode) {
    UTMVmNetworkModeShared = 0,
    UTMVmNetworkModeBridged = 1,
    UTMVmNetworkModeHostOnly = 2,
};

typedef NS_ENUM(NSInteger, UTMVmDiskRole) {
    UTMVmDiskRoleSystemDisk = 0,
    UTMVmDiskRoleBootIso = 1,
    UTMVmDiskRoleUnattendedIso = 2,
    UTMVmDiskRoleGuestToolsIso = 3,
    UTMVmDiskRoleDataDisk = 4,
};

@interface UTMVmDiskConfig : NSObject
@property (nonatomic, copy) NSString *identifier;
@property (nonatomic, copy) NSString *imagePath;
@property (nonatomic, assign) BOOL isReadOnly;
@property (nonatomic, assign) BOOL isOptical;
@property (nonatomic, assign) UTMVmDiskRole role;
@property (nonatomic, assign) NSInteger bootOrder;
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
+ (BOOL)isDiskInitializedGptAtPath:(nullable NSString *)diskPath;
+ (nullable NSURL *)detectDefaultWindowsIsoInDownloads;
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
// 120 字节光驱配置结构 (对齐竞品 XML 配置 +0xd20 列表项尺寸 0x78)
struct VmXmlOpticalDriveConfig {
    uint32_t enabled;                       // +0x00 设备使能
    uint32_t connected;                     // +0x04 介质挂载状态
    uint32_t interfaceType;                 // +0x08 接口类型 (0=SATA, 1=IDE, 2=USB)
    uint32_t slotIndex;                     // +0x0c 槽位序号
    uint32_t role;                          // +0x10 磁盘角色 (UTMVmDiskRole)
    int32_t bootOrder;                      // +0x14 启动顺序
    uint64_t sizeBytes;                     // +0x18 镜像字节数
    char imagePath[88];                     // +0x20 镜像路径摘要
};
static_assert(sizeof(VmXmlOpticalDriveConfig) == 120, "光驱配置结构必须为 120 字节");

// 296 字节磁盘配置结构 (对齐竞品 XML 配置 +0xd38 列表项尺寸 0x128)
struct VmXmlHardDiskConfig {
    uint32_t enabled;                       // +0x00 设备使能
    uint32_t connected;                     // +0x04 介质连接状态
    uint32_t interfaceType;                 // +0x08 接口类型 (0=NVMe, 1=SATA)
    uint32_t slotIndex;                     // +0x0c 槽位序号
    uint32_t readOnly;                      // +0x10 只读标志
    uint32_t role;                          // +0x14 磁盘角色 (UTMVmDiskRole)
    int32_t bootOrder;                      // +0x18 启动顺序
    uint32_t sectorSize;                    // +0x1c 逻辑扇区字节数
    uint64_t sizeBytes;                     // +0x20 磁盘容量字节数
    char identifier[64];                    // +0x28 磁盘标识符
    char imagePath[192];                    // +0x68 镜像路径
};
static_assert(sizeof(VmXmlHardDiskConfig) == 296, "磁盘配置结构必须为 296 字节");

// 宿主持久化 XML 配置投影结构
// 前 0xfe0 字节与竞品 0xff8 对象内的 XML 配置数据区一一对应, 偏移证据来自
// sub_100068C50 (默认值初始化)、sub_1000CD3EC (虚拟机参数投影) 与 sub_100059E04 (热更新差分)
struct alignas(16) VmXmlConfigurationBlock {
    uint8_t reserved0000[0x0628];           // +0x0000
    uint32_t toolsAutoUpdatePolicy;         // +0x0628 客户机工具自动更新策略
    uint8_t reserved062c[0x2c];             // +0x062c
    uint32_t clipboardSyncEnabled;          // +0x0658 剪贴板与拖拽同步使能
    uint8_t reserved065c[0x26];             // +0x065c
    uint8_t autoPauseEnabled;               // +0x0682 自动暂停使能
    uint8_t autoPauseFlags;                 // +0x0683 自动暂停标志
    uint8_t autoPauseReason;                // +0x0684 自动暂停原因
    uint8_t reserved0685[0x13];             // +0x0685
    uint8_t sharedFoldersEnabled;           // +0x0698 共享文件夹总开关
    uint8_t reserved0699[0x0e];             // +0x0699
    uint8_t sharedFolderMapDriveLetters;    // +0x06a7 共享目录自动映射盘符
    uint8_t reserved06a8[0x04];             // +0x06a8
    uint32_t sharedFolderCount;             // +0x06ac 共享目录列表项数
    uint8_t reserved06b0[0x38];             // +0x06b0
    uint64_t sharedProfileConfig;           // +0x06e8 共享用户目录配置状态
    uint8_t reserved06f0[0x44];             // +0x06f0
    uint32_t coherenceShowTaskbar;          // +0x0734 融合模式显示任务栏
    uint32_t coherenceRelocateTaskbar;      // +0x0738 融合模式任务栏重定位
    uint8_t reserved073c[0x44];             // +0x073c
    uint32_t timeSyncEnabled;               // +0x0780 时间同步使能
    uint32_t timeSyncIntervalSeconds;       // +0x0784 时间同步周期秒数
    uint8_t reserved0788[0x04];             // +0x0788
    uint8_t timeSyncZoneDisabled;           // +0x078c 禁用时区同步
    uint8_t timeSyncKeepOffset;             // +0x078d 保持时间偏移量
    uint8_t timeSyncFromHost;               // +0x078e 从宿主同步时间
    uint8_t reserved078f[0xa1];             // +0x078f
    uint64_t snapshotPolicyFlags;           // +0x0830 快照与内存气球策略标志
    uint8_t reserved0838[0x220];            // +0x0838
    uint8_t hypervisorQuirks;               // +0x0a58 虚拟化特殊配置标志
    uint8_t reserved0a59[0x23];             // +0x0a59
    uint8_t adaptiveHypervisorEnabled;      // +0x0a7c 自适应虚拟化使能
    uint8_t nestedVirtEnabled;              // +0x0a7d 嵌套虚拟化使能
    uint8_t sharedProfileEnabled;           // +0x0a7e 共享配置使能
    uint8_t reserved0a7f[0x39];             // +0x0a7f
    uint64_t hostFeatureMask0ab8;           // +0x0ab8 宿主能力掩码
    uint8_t reserved0ac0[0x70];             // +0x0ac0
    uint32_t cpuCount;                      // +0x0b30 虚拟 CPU 核数
    uint32_t reserved0b34;                  // +0x0b34
    uint32_t firmwareType;                  // +0x0b38 固件类型, 1 表示 EFI
    uint32_t reserved0b3c;                  // +0x0b3c
    uint64_t guestFeatureMask0b40;          // +0x0b40 客户机特性掩码
    uint16_t vmFlags0b48;                   // +0x0b48 虚拟机标志位
    uint8_t reserved0b4a[0x32];             // +0x0b4a
    uint32_t ramSizeMb;                     // +0x0b7c 客户机 DRAM 容量
    uint8_t reserved0b80[0x08];             // +0x0b80
    uint32_t hostMemQuotaMinMb;             // +0x0b88 内存气球下限
    uint32_t hostMemQuotaMaxMb;             // +0x0b8c 内存气球上限
    uint8_t balloonQuotaEnabled;            // +0x0b90 内存气球配额使能
    uint8_t reserved0b91[0x2f];             // +0x0b91
    uint32_t vramSizeMb;                    // +0x0bc0 客户机显存容量
    uint8_t reserved0bc4[0x48];             // +0x0bc4
    union {
        struct {
            uint8_t displayFlag0c0c;        // +0x0c0c 显示配置标志
            uint8_t reserved0c0d[0x03];     // +0x0c0d
            uint32_t displayConfigHeight;   // +0x0c10 显示配置高度
        };
        uint32_t displayConfigWidth;        // +0x0c0c 显示配置宽度
    };
    union {
        uint8_t displayFlag0c14;            // +0x0c14
        uint8_t dynamicResolutionEnabled;   // +0x0c14 动态分辨率使能
    };
    union {
        uint8_t displayFlag0c15;            // +0x0c15
        uint8_t hidpiEnabled;               // +0x0c15 HiDPI 视网膜缩放使能
    };
    uint16_t displayRefreshRateHz;          // +0x0c16 显示刷新率
    union {
        uint64_t displayValue0c18;          // +0x0c18 显示配置数值
        double displayScaleFactor0c18;      // +0x0c18 显示缩放因子
    };
    uint8_t displayFlag0c20;                // +0x0c20
    uint8_t reserved0c21[0x1b];             // +0x0c21
    uint8_t deviceFlag0c3c;                 // +0x0c3c 设备配置标志
    uint8_t reserved0c3d[0x57];             // +0x0c3d
    union {
        uint8_t toolgateEnabled;            // +0x0c94 Toolgate 端口使能
        uint8_t enableToolgatePort;         // +0x0c94
    };
    union {
        uint8_t toolsAutoUpdateEnabled;     // +0x0c95 客户机工具与自动更新使能
        uint8_t enableToolgate;             // +0x0c95
    };
    uint8_t reserved0c96[0x8a];             // +0x0c96
    uint64_t opticalDriveList;              // +0x0d20 光驱配置列表节点
    uint64_t opticalDriveCount;             // +0x0d28 光驱数量
    uint8_t reserved0d30[0x08];             // +0x0d30
    uint64_t hardDiskList;                  // +0x0d38 磁盘配置列表节点
    uint64_t hardDiskCount;                 // +0x0d40 磁盘数量
    uint8_t reserved0d48[0x50];             // +0x0d48
    uint64_t networkAdapterList;            // +0x0d98 网络适配器列表节点
    uint64_t networkAdapterCount;           // +0x0da0 网络适配器数量
    uint8_t reserved0da8[0x08];             // +0x0da8
    uint64_t deviceValue0db0;               // +0x0db0 音频设备配置数值
    uint64_t audioDeviceCount;              // +0x0db8 音频设备数量
    uint8_t reserved0dc0[0x08];             // +0x0dc0
    uint64_t usbControllerList;             // +0x0dc8 USB 控制器列表节点
    uint64_t usbControllerCount;            // +0x0dd0 USB 控制器数量
    uint8_t reserved0dd8[0x18];             // +0x0dd8
    uint64_t tpmDeviceConfigPtr;            // +0x0df0 TPM 2.0 设备配置指针
    uint8_t reserved0df8[0x1e8];            // +0x0df8
    // 以下为宿主侧投影字段, 不属于竞品 XML 配置数据区
    uint32_t networkMode;                   // 网络模式
    uint32_t coherenceEnabled;              // 融合模式使能
    uint32_t displayWidth;                  // 初始显示宽度
    uint32_t displayHeight;                 // 初始显示高度
    uint32_t displayDpi;                    // 显示 DPI
    double displayScale;                    // 显示缩放
    uint64_t hostMemQuotaMinBytes;          // 内存气球下限字节数
    uint64_t hostMemQuotaMaxBytes;          // 内存气球上限字节数
    VmXmlOpticalDriveConfig opticalDrives[4]; // 宿主侧内联 120 字节光驱配置表
    VmXmlHardDiskConfig hardDisks[4];         // 宿主侧内联 296 字节磁盘配置表
};

static_assert(offsetof(VmXmlConfigurationBlock, toolsAutoUpdatePolicy) == 0x0628, "XML 配置工具自动更新策略偏移错误");
static_assert(offsetof(VmXmlConfigurationBlock, clipboardSyncEnabled) == 0x0658, "XML 配置剪贴板同步偏移错误");
static_assert(offsetof(VmXmlConfigurationBlock, autoPauseEnabled) == 0x0682, "XML 配置自动暂停使能偏移错误");
static_assert(offsetof(VmXmlConfigurationBlock, autoPauseFlags) == 0x0683, "XML 配置自动暂停标志偏移错误");
static_assert(offsetof(VmXmlConfigurationBlock, autoPauseReason) == 0x0684, "XML 配置自动暂停原因偏移错误");
static_assert(offsetof(VmXmlConfigurationBlock, sharedFoldersEnabled) == 0x0698, "XML 配置共享目录使能偏移错误");
static_assert(offsetof(VmXmlConfigurationBlock, sharedFolderMapDriveLetters) == 0x06a7, "XML 配置共享盘符映射偏移错误");
static_assert(offsetof(VmXmlConfigurationBlock, sharedFolderCount) == 0x06ac, "XML 配置共享目录数量偏移错误");
static_assert(offsetof(VmXmlConfigurationBlock, sharedProfileConfig) == 0x06e8, "XML 配置共享用户目录偏移错误");
static_assert(offsetof(VmXmlConfigurationBlock, coherenceShowTaskbar) == 0x0734, "XML 配置融合任务栏显示偏移错误");
static_assert(offsetof(VmXmlConfigurationBlock, coherenceRelocateTaskbar) == 0x0738, "XML 配置融合任务栏重定位偏移错误");
static_assert(offsetof(VmXmlConfigurationBlock, timeSyncEnabled) == 0x0780, "XML 配置时间同步使能偏移错误");
static_assert(offsetof(VmXmlConfigurationBlock, timeSyncIntervalSeconds) == 0x0784, "XML 配置时间同步周期偏移错误");
static_assert(offsetof(VmXmlConfigurationBlock, timeSyncZoneDisabled) == 0x078c, "XML 配置时区同步禁用偏移错误");
static_assert(offsetof(VmXmlConfigurationBlock, timeSyncKeepOffset) == 0x078d, "XML 配置时间偏移保持偏移错误");
static_assert(offsetof(VmXmlConfigurationBlock, timeSyncFromHost) == 0x078e, "XML 配置宿主时间同步偏移错误");
static_assert(offsetof(VmXmlConfigurationBlock, snapshotPolicyFlags) == 0x0830, "XML 配置快照策略偏移错误");
static_assert(offsetof(VmXmlConfigurationBlock, hypervisorQuirks) == 0x0a58, "XML 配置虚拟化标志偏移错误");
static_assert(offsetof(VmXmlConfigurationBlock, adaptiveHypervisorEnabled) == 0x0a7c, "XML 配置自适应虚拟化偏移错误");
static_assert(offsetof(VmXmlConfigurationBlock, nestedVirtEnabled) == 0x0a7d, "XML 配置嵌套虚拟化偏移错误");
static_assert(offsetof(VmXmlConfigurationBlock, sharedProfileEnabled) == 0x0a7e, "XML 配置共享配置偏移错误");
static_assert(offsetof(VmXmlConfigurationBlock, hostFeatureMask0ab8) == 0x0ab8, "XML 配置宿主能力偏移错误");
static_assert(offsetof(VmXmlConfigurationBlock, cpuCount) == 0x0b30, "XML 配置核数偏移错误");
static_assert(offsetof(VmXmlConfigurationBlock, firmwareType) == 0x0b38, "XML 配置固件类型偏移错误");
static_assert(offsetof(VmXmlConfigurationBlock, guestFeatureMask0b40) == 0x0b40, "XML 配置特性掩码偏移错误");
static_assert(offsetof(VmXmlConfigurationBlock, vmFlags0b48) == 0x0b48, "XML 配置虚拟机标志偏移错误");
static_assert(offsetof(VmXmlConfigurationBlock, ramSizeMb) == 0x0b7c, "XML 配置内存容量偏移错误");
static_assert(offsetof(VmXmlConfigurationBlock, hostMemQuotaMinMb) == 0x0b88, "XML 配置配额下限偏移错误");
static_assert(offsetof(VmXmlConfigurationBlock, hostMemQuotaMaxMb) == 0x0b8c, "XML 配置配额上限偏移错误");
static_assert(offsetof(VmXmlConfigurationBlock, balloonQuotaEnabled) == 0x0b90, "XML 配置配额使能偏移错误");
static_assert(offsetof(VmXmlConfigurationBlock, vramSizeMb) == 0x0bc0, "XML 配置显存容量偏移错误");
static_assert(offsetof(VmXmlConfigurationBlock, displayFlag0c0c) == 0x0c0c, "XML 配置显示标志偏移错误");
static_assert(offsetof(VmXmlConfigurationBlock, displayConfigWidth) == 0x0c0c, "XML 配置显示宽度偏移错误");
static_assert(offsetof(VmXmlConfigurationBlock, displayConfigHeight) == 0x0c10, "XML 配置显示高度偏移错误");
static_assert(offsetof(VmXmlConfigurationBlock, dynamicResolutionEnabled) == 0x0c14, "XML 配置动态分辨率偏移错误");
static_assert(offsetof(VmXmlConfigurationBlock, hidpiEnabled) == 0x0c15, "XML 配置HiDPI偏移错误");
static_assert(offsetof(VmXmlConfigurationBlock, displayRefreshRateHz) == 0x0c16, "XML 配置显示刷新率偏移错误");
static_assert(offsetof(VmXmlConfigurationBlock, displayValue0c18) == 0x0c18, "XML 配置显示数值偏移错误");
static_assert(offsetof(VmXmlConfigurationBlock, toolgateEnabled) == 0x0c94, "XML 配置Toolgate使能偏移错误");
static_assert(offsetof(VmXmlConfigurationBlock, toolsAutoUpdateEnabled) == 0x0c95, "XML 配置工具自动更新使能偏移错误");
static_assert(offsetof(VmXmlConfigurationBlock, opticalDriveList) == 0x0d20, "XML 配置光驱列表偏移错误");
static_assert(offsetof(VmXmlConfigurationBlock, opticalDriveCount) == 0x0d28, "XML 配置光驱数量偏移错误");
static_assert(offsetof(VmXmlConfigurationBlock, hardDiskList) == 0x0d38, "XML 配置磁盘列表偏移错误");
static_assert(offsetof(VmXmlConfigurationBlock, hardDiskCount) == 0x0d40, "XML 配置磁盘数量偏移错误");
static_assert(offsetof(VmXmlConfigurationBlock, networkAdapterList) == 0x0d98, "XML 配置网络列表偏移错误");
static_assert(offsetof(VmXmlConfigurationBlock, networkAdapterCount) == 0x0da0, "XML 配置网络数量偏移错误");
static_assert(offsetof(VmXmlConfigurationBlock, deviceValue0db0) == 0x0db0, "XML 配置设备数值偏移错误");
static_assert(offsetof(VmXmlConfigurationBlock, audioDeviceCount) == 0x0db8, "XML 配置音频数量偏移错误");
static_assert(offsetof(VmXmlConfigurationBlock, usbControllerList) == 0x0dc8, "XML 配置USB列表偏移错误");
static_assert(offsetof(VmXmlConfigurationBlock, usbControllerCount) == 0x0dd0, "XML 配置USB数量偏移错误");
static_assert(offsetof(VmXmlConfigurationBlock, tpmDeviceConfigPtr) == 0x0df0, "XML 配置TPM指针偏移错误");
static_assert(offsetof(VmXmlConfigurationBlock, networkMode) == 0x0fe0, "宿主侧投影字段起始偏移错误");

void utmVmPopulateXmlConfigBlock(VmXmlConfigurationBlock *block, UTMVmConfig *config);
#endif

NS_ASSUME_NONNULL_END
