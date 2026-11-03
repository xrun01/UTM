//
// Copyright © 2023 osy. All rights reserved.
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

import AppKit
import Foundation

protocol UTMScriptableUSBDevice: AnyObject {
    var usbName: String? { get }
    var usbManufacturerName: String? { get }
    var usbProductName: String? { get }
    var usbSerial: String? { get }
    var usbVendorId: Int { get }
    var usbProductId: Int { get }
    var usbBusNumber: Int { get }
    var usbPortNumber: Int { get }
}

@available(macOS 27, *)
extension UTMAppleUSBDevice: UTMScriptableUSBDevice {
    var usbName: String? {
        name
    }
}

@MainActor
@objc(UTMScriptingUSBDeviceImpl)
class UTMScriptingUSBDeviceImpl: NSObject, UTMScriptable {
    @nonobjc var box: any UTMScriptableUSBDevice
    
    private var data: UTMData? {
        (NSApp.scriptingDelegate as? AppDelegate)?.data
    }
    
    @objc var id: Int {
        box.usbBusNumber << 16 | box.usbPortNumber
    }
    
    @objc var name: String {
        box.usbName ?? String(format: "%04X:%04X", box.usbVendorId, box.usbProductId)
    }
    
    @objc var manufacturerName: String {
        box.usbManufacturerName ?? name
    }
    
    @objc var productName: String {
        box.usbProductName ?? name
    }
    
    @objc var vendorId: Int {
        box.usbVendorId
    }
    
    @objc var productId: Int {
        box.usbProductId
    }
    
    override var objectSpecifier: NSScriptObjectSpecifier? {
        let appDescription = NSApplication.classDescription() as! NSScriptClassDescription
        return NSUniqueIDSpecifier(containerClassDescription: appDescription,
                                   containerSpecifier: nil,
                                   key: "scriptingUsbDevices",
                                   uniqueID: id)
    }
    
    init(for usbDevice: any UTMScriptableUSBDevice) {
        self.box = usbDevice
    }
    
    private func same<Device: UTMScriptableUSBDevice>(usbDevice: any UTMScriptableUSBDevice, in devices: [Device]) -> Device? {
        if let usbDevice = usbDevice as? Device, let device = devices.first(where: { $0 === usbDevice }) {
            return device
        }
        if let device = devices.first(where: { $0.matchesLocation(of: usbDevice) }) {
            return device
        }
        if let device = devices.first(where: { $0.matchesSerial(of: usbDevice) }) {
            return device
        }
        let matchingDevices = devices.filter({ $0.matchesVidPid(of: usbDevice) })
        if matchingDevices.count == 1 {
            return matchingDevices[0]
        }
        return nil
    }
    
    @objc func connect(_ command: NSScriptCommand) {
        let scriptingVM = command.evaluatedArguments?["vm"] as? UTMScriptingVirtualMachineImpl
        withScriptCommand(command) { [self] in
            if #available(macOS 27, *), let vm = scriptingVM?.vm as? UTMAppleVirtualMachine {
                guard vm.hasUsbRedirection else {
                    throw UTMScriptingVirtualMachineImpl.ScriptingError.operationNotAvailable
                }
                let devices = try await UTMAppleUSBManager.shared.allDevices()
                guard let usbDevice = same(usbDevice: box, in: devices) else {
                    throw ScriptingError.deviceNotFound
                }
                try await vm.connectUsbDevice(usbDevice, takingOver: true)
            } else {
                throw UTMScriptingVirtualMachineImpl.ScriptingError.operationNotSupported
            }
        }
    }
    
    @objc func disconnect(_ command: NSScriptCommand) {
        withScriptCommand(command) { [self] in
            guard let data = data else {
                throw ScriptingError.notReady
            }
            var appleVMs: [UTMAppleVirtualMachine] = []
            if #available(macOS 27, *) {
                appleVMs = data.virtualMachines.compactMap({ vmdata in
                    guard let vm = vmdata.wrapped as? UTMAppleVirtualMachine, vm.state == .started, vm.hasUsbRedirection else {
                        return nil
                    }
                    return vm
                })
            }
            guard appleVMs.count > 0 else {
                throw UTMScriptingVirtualMachineImpl.ScriptingError.notRunning
            }
            var found = false
            if #available(macOS 27, *) {
                for vm in appleVMs {
                    if let device = same(usbDevice: box, in: vm.connectedUsbDevices) {
                        found = true
                        try await vm.disconnectUsbDevice(device)
                    }
                }
            }
            if !found {
                throw ScriptingError.deviceNotConnected
            }
        }
    }
}

// MARK: - Errors
extension UTMScriptingUSBDeviceImpl {
    enum ScriptingError: Error, LocalizedError {
        case notReady
        case deviceNotFound
        case deviceNotConnected
        
        var errorDescription: String? {
            switch self {
            case .notReady: return NSLocalizedString("UTM is not ready to accept commands.", comment: "UTMScriptingUSBDeviceImpl")
            case .deviceNotFound: return NSLocalizedString("The device cannot be found.", comment: "UTMScriptingUSBDeviceImpl")
            case .deviceNotConnected: return NSLocalizedString("The device is not currently connected.", comment: "UTMScriptingUSBDeviceImpl")
            }
        }
    }
}

private extension UTMScriptableUSBDevice {
    func matchesVidPid(of other: any UTMScriptableUSBDevice) -> Bool {
        usbVendorId == other.usbVendorId && usbProductId == other.usbProductId
    }

    func matchesLocation(of other: any UTMScriptableUSBDevice) -> Bool {
        matchesVidPid(of: other) && usbBusNumber == other.usbBusNumber && usbPortNumber == other.usbPortNumber
    }

    func matchesSerial(of other: any UTMScriptableUSBDevice) -> Bool {
        guard let serial = usbSerial, let otherSerial = other.usbSerial, !serial.isEmpty else {
            return false
        }
        return matchesVidPid(of: other) && serial == otherSerial
    }
}

// MARK: - NSApplication extension
extension AppDelegate {
    @MainActor
    @objc var scriptingUsbDevices: [UTMScriptingUSBDeviceImpl] {
        guard let data = data else {
            return []
        }
        if #available(macOS 27, *) {
            let hasAppleVM = data.virtualMachines.contains { vmData in
                guard let vm = vmData.wrapped as? UTMAppleVirtualMachine else {
                    return false
                }
                return vm.state == .started && vm.hasUsbRedirection
            }
            if hasAppleVM {
                return UTMAppleUSBManager.shared.devices.map({ UTMScriptingUSBDeviceImpl(for: $0) })
            }
        }
        return []
    }
}
