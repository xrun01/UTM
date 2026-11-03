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

import Foundation
import Carbon.HIToolbox

class VMHeadlessSessionState: NSObject, UTMVirtualMachineDelegate {
    private let vm: any UTMVirtualMachine
    private let onStop: (() -> Void)?

    init(for vm: any UTMVirtualMachine, onStop: (() -> Void)?) {
        self.vm = vm
        self.onStop = onStop
        super.init()
        self.vm.delegate = self
    }

    func virtualMachine(_ vm: any UTMVirtualMachine, didTransitionToState state: UTMVirtualMachineState) {
        if state == .stopped {
            DispatchQueue.main.async {
                self.onStop?()
            }
        }
    }

    func virtualMachine(_ vm: any UTMVirtualMachine, didErrorWithMessage message: String) {
        logger.error("Headless VM error: \(message)")
    }

    func virtualMachine(_ vm: any UTMVirtualMachine, didCompleteInstallation success: Bool) {}

    func virtualMachine(_ vm: any UTMVirtualMachine, didUpdateInstallationProgress progress: Double) {}
}

extension UTMData {
    func run(vm: VMData, options: UTMVirtualMachineStartOptions = [], startImmediately: Bool = true) {
        var window: Any? = vmWindows[vm]
        if window == nil {
            let close = {
                self.vmWindows.removeValue(forKey: vm)
                window = nil
            }
            if let avm = vm.wrapped as? UTMAppleVirtualMachine {
                if avm.config.system.architecture == UTMAppleConfigurationSystem.currentArchitecture {
                    let primarySerialIndex = avm.config.serials.firstIndex { $0.mode == .builtin }
                    if let primarySerialIndex = primarySerialIndex {
                        window = VMDisplayAppleTerminalWindowController(primaryForIndex: primarySerialIndex, vm: avm, onClose: close)
                    }
                    if !avm.config.displays.isEmpty {
                        if avm.config.system.boot.operatingSystem == .macOS {
                            window = VMDisplayAppleDisplayWindowController(vm: avm, onClose: close)
                        } else {
                            window = VMDisplayVmMetalWindowController(vm: avm, onClose: close)
                        }
                    } else if avm.config.displays.isEmpty && window == nil {
                        window = VMHeadlessSessionState(for: avm, onStop: close)
                    }
                }
            }
            if window == nil {
                DispatchQueue.main.async {
                    self.alertItem = .message(NSLocalizedString("This virtual machine cannot be run on this machine.", comment: "UTMDataExtension"))
                }
            }
        }
        if let unwrappedWindow = window as? VMDisplayWindowController {
            vmWindows[vm] = unwrappedWindow
            vm.wrapped!.delegate = unwrappedWindow
            unwrappedWindow.showWindow(nil)
            unwrappedWindow.window!.makeMain()
            if startImmediately {
                unwrappedWindow.requestAutoStart(options: options)
            }
        } else if let unwrappedWindow = window as? VMHeadlessSessionState {
            vmWindows[vm] = unwrappedWindow
            if startImmediately {
                if vm.wrapped!.state == .paused {
                    vm.wrapped!.requestVmResume()
                } else if vm.wrapped!.state == .stopped {
                    vm.wrapped!.requestVmStart(options: options)
                }
            }
        } else {
            logger.critical("Failed to create window controller.")
        }
    }
    
    func stop(vm: VMData) {
        guard let wrapped = vm.wrapped else {
            return
        }
        Task {
            if wrapped.registryEntry.isSuspended && !wrapped.isRunningAsDisposible {
                try? await wrapped.deleteSnapshot(name: nil)
            }
            if vm.state == .started || vm.state == .paused {
                try? await wrapped.stop(usingMethod: .force)
            } else {
                try? await wrapped.stop(usingMethod: .kill)
            }
            await MainActor.run {
                self.close(vm: vm)
            }
        }
    }
    
    func close(vm: VMData) {
        if let window = vmWindows.removeValue(forKey: vm) as? VMDisplayWindowController {
            DispatchQueue.main.async {
                window.close()
            }
        }
    }
}
