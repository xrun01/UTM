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

import Foundation

@objc extension UTMScriptingVirtualMachineImpl {
    @objc var configuration: [AnyHashable : Any] {
        let wrapper = UTMScriptingConfigImpl(vm.config, data: data)
        return wrapper.serializeConfiguration()
    }
    
    @objc func updateConfiguration(_ command: NSScriptCommand) {
        let newConfiguration = command.evaluatedArguments?["newConfiguration"] as? [AnyHashable : Any]
        withScriptCommand(command) { [self] in
            guard let newConfiguration = newConfiguration else {
                throw ScriptingError.invalidParameter
            }
            guard !isInstalling else {
                throw ScriptingError.installInProgress
            }
            guard vm.state == .stopped else {
                throw ScriptingError.notStopped
            }
            data.close(vm: box)
            let wrapper = UTMScriptingConfigImpl(vm.config)
            try wrapper.updateConfiguration(from: newConfiguration)
            try await data.save(vm: box)
        }
    }
}

@MainActor
class UTMScriptingConfigImpl {
    private var bytesInMib: Int64 {
        1048576
    }
    
    private(set) var config: any UTMConfiguration
    private weak var data: UTMData?
    
    init(_ config: any UTMConfiguration, data: UTMData? = nil) {
        self.config = config
        self.data = data
    }
    
    func serializeConfiguration() -> [AnyHashable : Any] {
        guard let appleConfig = config as? UTMAppleConfiguration else {
            return [:]
        }
        return serializeAppleConfiguration(appleConfig)
    }
    
    func updateConfiguration(from record: [AnyHashable : Any]) throws {
        guard config is UTMAppleConfiguration else {
            return
        }
        try updateAppleConfiguration(from: record)
    }
    
    private func size(of drive: any UTMConfigurationDrive) -> Int {
        guard let data = data, let url = drive.imageURL else {
            return 0
        }
        return Int(data.computeSize(for: url) / bytesInMib)
    }
}

@MainActor
extension UTMScriptingConfigImpl {
    private func serializeAppleConfiguration(_ config: UTMAppleConfiguration) -> [AnyHashable : Any] {
        [
            "name": config.information.name,
            "icon": config.information.iconURL?.deletingPathExtension().lastPathComponent ?? "",
            "notes": config.information.notes ?? "",
            "memory": config.system.memorySize,
            "cpuCores": config.system.cpuCount,
            "directoryShares": config.sharedDirectories.enumerated().map({ serializeAppleDirectoryShare($1, index: $0) }),
            "drives": config.drives.map({ serializeAppleDriveExisting($0) }),
            "networkInterfaces": config.networks.enumerated().map({ serializeAppleNetwork($1, index: $0) }),
            "serialPorts": config.serials.enumerated().map({ serializeAppleSerial($1, index: $0) }),
            "displays": config.displays.enumerated().map({ serializeAppleDisplay($1, index: $0)}),
        ]
    }
    
    private func serializeAppleDirectoryShare(_ config: UTMAppleConfigurationSharedDirectory, index: Int) -> [AnyHashable : Any] {
        [
            "index": index,
            "readOnly": config.isReadOnly
        ]
    }
    
    private func serializeAppleDriveExisting(_ config: UTMAppleConfigurationDrive) -> [AnyHashable : Any] {
        [
            "id": config.id,
            "removable": config.isExternal,
            "hostSize": size(of: config),
        ]
    }
    
    private func appleNetworkMode(from mode: UTMAppleConfigurationNetwork.NetworkMode) -> UTMScriptingAppleNetworkMode {
        switch mode {
        case .shared: return .shared
        case .natNetwork: return .natNetwork
        case .host: return .host
        case .bridged: return .bridged
        }
    }
    
    private func serializeAppleNetwork(_ config: UTMAppleConfigurationNetwork, index: Int) -> [AnyHashable : Any] {
        [
            "index": index,
            "mode": appleNetworkMode(from: config.mode).rawValue,
            "address": config.macAddress,
            "hostInterface": config.bridgeInterface ?? "",
        ]
    }
    
    private func appleSerialInterface(from mode: UTMAppleConfigurationSerial.SerialMode) -> UTMScriptingSerialInterface {
        switch mode {
        case .ptty: return .ptty
        default: return .unavailable
        }
    }
    
    private func serializeAppleSerial(_ config: UTMAppleConfigurationSerial, index: Int) -> [AnyHashable : Any] {
        [
            "index": index,
            "interface": appleSerialInterface(from: config.mode).rawValue,
        ]
    }
    
    private func serializeAppleDisplay(_ config: UTMAppleConfigurationDisplay, index: Int) -> [AnyHashable : Any] {
        [
            "index": index,
            "dynamicResolution": config.isDynamicResolution,
        ]
    }
}

@MainActor
extension UTMScriptingConfigImpl {
    private func updateElements<T>(_ array: inout [T], with records: [[AnyHashable : Any]], onExisting: @MainActor (inout T, [AnyHashable : Any]) throws -> Void, onNew: @MainActor ([AnyHashable : Any]) throws -> T) throws {
        var unseenIndicies = IndexSet(integersIn: array.indices)
        for record in records {
            if let index = record["index"] as? Int {
                guard array.indices.contains(index) else {
                    throw ConfigurationError.indexNotFound(index: index)
                }
                try onExisting(&array[index], record)
                unseenIndicies.remove(index)
            } else {
                array.append(try onNew(record))
            }
        }
        array.remove(atOffsets: unseenIndicies)
    }
    
    private func updateIdentifiedElements<T: Identifiable>(_ array: inout [T], with records: [[AnyHashable : Any]], onExisting: @MainActor (inout T, [AnyHashable : Any]) throws -> Void, onNew: @MainActor ([AnyHashable : Any]) throws -> T) throws {
        var unseenIndicies = IndexSet(integersIn: array.indices)
        for record in records {
            if let id = record["id"] as? T.ID {
                guard let index = array.enumerated().first(where: { $1.id == id })?.offset else {
                    throw ConfigurationError.identifierNotFound(id: id)
                }
                try onExisting(&array[index], record)
                unseenIndicies.remove(index)
            } else {
                array.append(try onNew(record))
            }
        }
        array.remove(atOffsets: unseenIndicies)
    }
    
    private func updateAppleConfiguration(from record: [AnyHashable : Any]) throws {
        let config = config as! UTMAppleConfiguration
        if let name = record["name"] as? String, !name.isEmpty {
            config.information.name = name
        }
        if let icon = record["icon"] as? String, !icon.isEmpty {
            if let url = UTMConfigurationInfo.builtinIcon(named: icon) {
                config.information.iconURL = url
            } else {
                throw ConfigurationError.iconNotFound(icon: icon)
            }
        }
        if let notes = record["notes"] as? String, !notes.isEmpty {
            config.information.notes = notes
        }
        if let memory = record["memory"] as? Int, memory != 0 {
            config.system.memorySize = memory
        }
        if let cpuCores = record["cpuCores"] as? Int {
            config.system.cpuCount = cpuCores
        }
        if let directoryShares = record["directoryShares"] as? [[AnyHashable : Any]] {
            try updateAppleDirectoryShares(from: directoryShares)
        }
        if let drives = record["drives"] as? [[AnyHashable : Any]] {
            try updateAppleDrives(from: drives)
        }
        if let networkInterfaces = record["networkInterfaces"] as? [[AnyHashable : Any]] {
            try updateAppleNetworks(from: networkInterfaces)
        }
        if let serialPorts = record["serialPorts"] as? [[AnyHashable : Any]] {
            try updateAppleSerials(from: serialPorts)
        }
        if let displays = record["displays"] as? [[AnyHashable : Any]] {
            try updateAppleDisplays(from: displays)
        }
    }
    
    private func updateAppleDirectoryShares(from records: [[AnyHashable : Any]]) throws {
        let config = config as! UTMAppleConfiguration
        try updateElements(&config.sharedDirectories, with: records, onExisting: updateAppleExistingDirectoryShare, onNew: { record in
            var newShare = UTMAppleConfigurationSharedDirectory(directoryURL: nil, isReadOnly: false)
            try updateAppleExistingDirectoryShare(&newShare, from: record)
            return newShare
        })
    }
    
    private func updateAppleExistingDirectoryShare(_ share: inout UTMAppleConfigurationSharedDirectory, from record: [AnyHashable : Any]) throws {
        if let readOnly = record["readOnly"] as? Bool {
            share.isReadOnly = readOnly
        }
    }
    
    private func updateAppleDrives(from records: [[AnyHashable : Any]]) throws {
        let config = config as! UTMAppleConfiguration
        try updateIdentifiedElements(&config.drives, with: records, onExisting: updateAppleExistingDrive, onNew: unserializeAppleNewDrive)
    }
    
    private func updateAppleExistingDrive(_ drive: inout UTMAppleConfigurationDrive, from record: [AnyHashable : Any]) throws {
        if let source = record["source"] as? URL {
            drive.imageURL = source
        }
    }
    
    private func unserializeAppleNewDrive(from record: [AnyHashable : Any]) throws -> UTMAppleConfigurationDrive {
        let removable = record["removable"] as? Bool ?? false
        if let size = record["guestSize"] as? Int {
            return UTMAppleConfigurationDrive(newSize: size)
        } else {
            return UTMAppleConfigurationDrive(existingURL: record["source"] as? URL, isExternal: removable)
        }
    }
    
    private func updateAppleNetworks(from records: [[AnyHashable : Any]]) throws {
        let config = config as! UTMAppleConfiguration
        try updateElements(&config.networks, with: records, onExisting: updateAppleExistingNetwork, onNew: { record in
            var newNetwork = UTMAppleConfigurationNetwork()
            try updateAppleExistingNetwork(&newNetwork, from: record)
            return newNetwork
        })
    }
    
    private func parseAppleNetworkMode(_ value: AEKeyword?) -> UTMAppleConfigurationNetwork.NetworkMode? {
        guard let value = value, let parsed = UTMScriptingAppleNetworkMode(rawValue: value) else {
            return Optional.none
        }
        switch parsed {
        case .shared: return .shared
        case .natNetwork: return .natNetwork
        case .host: return .host
        case .bridged: return .bridged
        }
    }
    
    private func updateAppleExistingNetwork(_ network: inout UTMAppleConfigurationNetwork, from record: [AnyHashable : Any]) throws {
        if let mode = parseAppleNetworkMode(record["mode"] as? AEKeyword) {
            network.mode = mode
        }
        if let address = record["address"] as? String, !address.isEmpty {
            network.macAddress = address
        }
        if let interface = record["hostInterface"] as? String, !interface.isEmpty {
            network.bridgeInterface = interface
        }
    }
    
    private func updateAppleSerials(from records: [[AnyHashable : Any]]) throws {
        let config = config as! UTMAppleConfiguration
        try updateElements(&config.serials, with: records, onExisting: updateAppleExistingSerial, onNew: { record in
            var newSerial = UTMAppleConfigurationSerial()
            try updateAppleExistingSerial(&newSerial, from: record)
            return newSerial
        })
    }
    
    private func parseAppleSerialInterface(_ value: AEKeyword?) -> UTMAppleConfigurationSerial.SerialMode? {
        guard let value = value, let parsed = UTMScriptingSerialInterface(rawValue: value) else {
            return Optional.none
        }
        switch parsed {
        case .ptty: return .ptty
        default: return Optional.none
        }
    }
    
    private func updateAppleExistingSerial(_ serial: inout UTMAppleConfigurationSerial, from record: [AnyHashable : Any]) throws {
        if let interface = parseAppleSerialInterface(record["interface"] as? AEKeyword) {
            serial.mode = interface
        }
    }
    
    private func updateAppleDisplays(from records: [[AnyHashable : Any]]) throws {
        let config = config as! UTMAppleConfiguration
        try updateElements(&config.displays, with: records, onExisting: updateAppleExistingDisplay, onNew: { record in
            var newDisplay = UTMAppleConfigurationDisplay()
            try updateAppleExistingDisplay(&newDisplay, from: record)
            return newDisplay
        })
    }
    
    private func updateAppleExistingDisplay(_ display: inout UTMAppleConfigurationDisplay, from record: [AnyHashable : Any]) throws {
        if let dynamicResolution = record["dynamicResolution"] as? Bool {
            display.isDynamicResolution = dynamicResolution
        }
    }
    
    enum ConfigurationError: Error, LocalizedError {
        case identifierNotFound(id: any Hashable)
        case invalidDriveDescription
        case indexNotFound(index: Int)
        case deviceNotSupported
        case iconNotFound(icon: String)
        
        var errorDescription: String? {
            switch self {
            case .identifierNotFound(let id): return String.localizedStringWithFormat(NSLocalizedString("Identifier '%@' cannot be found.", comment: "UTMScriptingConfigImpl"), String(describing: id))
            case .invalidDriveDescription: return NSLocalizedString("Drive description is invalid.", comment: "UTMScriptingConfigImpl")
            case .indexNotFound(let index): return String.localizedStringWithFormat(NSLocalizedString("Index %lld cannot be found.", comment: "UTMScriptingConfigImpl"), index)
            case .deviceNotSupported: return NSLocalizedString("This device is not supported by the target.", comment: "UTMScriptingConfigImpl")
            case .iconNotFound(let icon): return String.localizedStringWithFormat(NSLocalizedString("The icon '%@' cannot be found in the built-in icons.", comment: "UTMScriptingConfigImpl"), icon)
            }
        }
    }
}
