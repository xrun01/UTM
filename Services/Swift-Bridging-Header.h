//
// Copyright © 2020 osy. All rights reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
//

#import <AppKit/AppKit.h>
#include <os/proc.h>
#include "TargetConditionals.h"
#include "UTMLogging.h"
#include "UTMASIFImage.h"
#include "VMKeyboardMap.h"
#include "VmProtocol/UTMVmBridge.h"

#if TARGET_OS_OSX
typedef uint32_t CGSConnectionID;
typedef CF_ENUM(uint32_t, CGSGlobalHotKeyOperatingMode) {
    kCGSGlobalHotKeyOperatingModeEnable = 0,
    kCGSGlobalHotKeyOperatingModeDisable = 1,
};
extern CGSConnectionID CGSMainConnectionID(void);
extern CGError CGSSetGlobalHotKeyOperatingMode(CGSConnectionID connection, CGSGlobalHotKeyOperatingMode mode);
#endif
