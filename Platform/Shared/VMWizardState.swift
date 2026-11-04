//
// Copyright © 2021 osy. All rights reserved.
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
import SwiftUI
#if canImport(Virtualization)
import Virtualization
#endif

enum VMWizardPage: Int, Identifiable {
    var id: Int {
        return self.rawValue
    }
    
    case start
    case operatingSystem
    case macOSBoot
    case linuxBoot
    case windowsBoot
    case classicMacOSBoot
    case otherBoot
    case hardware
    case drives
    case sharing
    case summary
}

enum VMWizardOS: Identifiable {
    var id: Self { self }

    case Other
    case macOS
    case Linux
    case Windows
    case ClassicMacOS

    var name: LocalizedStringKey {
        switch self {
        case .Other: return "Other"
        case .macOS: return "macOS"
        case .Linux: return "Linux"
        case .Windows: return "Windows"
        case .ClassicMacOS: return "Mac OS"
        }
    }

    var defaultIconName: String? {
        switch self {
        case .Other: return nil
        case .macOS: return "mac"
        case .Linux: return "linux"
        case .Windows: return "windows"
        case .ClassicMacOS: return "macos"
        }
    }
}

enum VMBootDevice: Int, Identifiable {
    var id: Int {
        return self.rawValue
    }

    case none
    case cd
    case floppy
    case kernel
    case drive
}

struct AlertMessage: Identifiable {
    var message: String
    public var id: String {
        message
    }

    init(_ message: String) {
        self.message = message
    }
}

@MainActor class VMWizardState: ObservableObject {
    let bytesInMib = 1048576
    let bytesInGib = 1073741824
    
    @Published var slide: AnyTransition = .identity
    @Published var currentPage: VMWizardPage = .start
    @Published var pageHistory = [VMWizardPage]() {
        didSet {
            currentPage = pageHistory.last ?? .start
        }
    }
    @Published var nextPageBinding: Binding<VMWizardPage?> = .constant(nil)
    @Published var alertMessage: AlertMessage?
    @Published var isBusy: Bool = false
    @Published var systemBootUefi: Bool = true
    @Published var systemBootTpm: Bool = true
    @Published var isGuestToolsInstallRequested: Bool = false
    @Published var useVirtualization: Bool = true
    @Published var useAppleVirtualization: Bool = true
    @Published var operatingSystem: VMWizardOS = .Other
    #if os(macOS) && arch(arm64)
    @Published var macPlatform: UTMAppleConfigurationMacPlatform?
    @Published var macRecoveryIpswURL: URL?
    @Published var macPlatformVersion: Int?
    var macIsLeastVentura: Bool {
        if let macPlatformVersion = macPlatformVersion {
            return macPlatformVersion >= 22
        } else {
            return false
        }
    }
    var macIsLeastSonoma: Bool {
        if let macPlatformVersion = macPlatformVersion {
            return macPlatformVersion >= 23
        } else {
            return false
        }
    }
    #endif
    @Published var legacyHardware: Bool = false
    @Published var bootDevice: VMBootDevice = .cd
    @Published var bootImageURL: URL?
    @Published var linuxKernelURL: URL?
    @Published var linuxInitialRamdiskURL: URL?
    @Published var linuxRootImageURL: URL?
    @Published var linuxBootArguments: String = ""
    @Published var linuxHasRosetta: Bool = false
    @Published var isWindows10OrHigher: Bool = true
    @Published var isWindowsExpressInstall: Bool = true
    @Published var windowsUnattendedUserName: String = UTMVmConfig.defaultGuestUserName()
    @Published var windowsUnattendedPassword: String = ""
    @Published var windowsDetectedLocale: String = UTMVmConfig.detectedHostWindowsLocale()
    @Published var quadra800RomUrl: URL?
    #if os(macOS)
    @Published var systemMemoryMib: Int = Int(UTMVmConfig.recommendedMemorySizeMib())
    @Published var storageSizeGib: Int = Int(UTMVmConfig.recommendedDiskSizeGib())
    #else
    @Published var systemMemoryMib: Int = 512
    @Published var storageSizeGib: Int = 8
    #endif
    @Published var systemCpuCount: Int = Int(UTMVmConfig.recommendedCpuCount())
    @Published var isDisplayEnabled: Bool = true
    @Published var isGLEnabled: Bool = false
    @Published var sharingDirectoryURL: URL?
    @Published var sharingReadOnly: Bool = false
    @Published var name: String?
    @Published var isOpenSettingsAfterCreation: Bool = false
    @Published var useNvmeAsDiskInterface = false
    @Published var machineProperties: String?

    /// SwiftUI BUG: on macOS 12, when VoiceOver is enabled and isBusy changes the disable state of a button being clicked, 
    var isNeverDisabledWorkaround: Bool {
        #if os(macOS)
        if #unavailable(macOS 13) {
            return false
        }
        return true
        #else
        return true
        #endif
    }
    
    var hasNextButton: Bool {
        switch currentPage {
        case .start:
            return false
        case .operatingSystem:
            return false
        case .windowsBoot:
            return !isWindowsExpressInstall
        case .summary:
            return false
        default:
            return true
        }
    }
    
    #if os(macOS) && arch(arm64)
    var isPendingIPSWDownload: Bool {
        guard useAppleVirtualization && operatingSystem == .macOS else {
            return false
        }
        guard let url = macRecoveryIpswURL else {
            return false
        }
        return !url.isFileURL
    }
    #else
    let isPendingIPSWDownload: Bool = false
    #endif
    
    var slideIn: AnyTransition {
        .asymmetric(insertion: .move(edge: .trailing), removal: .opacity)
    }
    
    var slideOut: AnyTransition {
        .asymmetric(insertion: .move(edge: .leading), removal: .opacity)
    }
    
    func next() {
        var nextPage = currentPage
        switch currentPage {
        case .start:
            nextPage = .operatingSystem
        case .operatingSystem:
            if operatingSystem == .Windows {
                nextPage = .windowsBoot
            } else {
                nextPage = .hardware
            }
        case .hardware:
            guard systemMemoryMib > 0 else {
                alertMessage = AlertMessage(NSLocalizedString("Invalid RAM size specified.", comment: "VMWizardState"))
                return
            }
            switch operatingSystem {
            case .Other:
                nextPage = .otherBoot
            case .macOS:
                nextPage = .macOSBoot
            case .Linux:
                nextPage = .linuxBoot
            case .Windows:
                nextPage = .drives
            case .ClassicMacOS:
                nextPage = .classicMacOSBoot
            }
        case .otherBoot, .macOSBoot, .linuxBoot, .windowsBoot, .classicMacOSBoot:
            guard [.kernel, .none].contains(bootDevice) || bootImageURL != nil else {
                alertMessage = AlertMessage(NSLocalizedString("Please select a boot image.", comment: "VMWizardState"))
                return
            }
            if currentPage == .windowsBoot && !isWindowsExpressInstall {
                nextPage = .hardware
                break
            }
            if currentPage == .macOSBoot {
                #if os(macOS) && arch(arm64)
                if macPlatform == nil || macRecoveryIpswURL == nil {
                    fetchLatestPlatform()
                }
                #endif
            }
            if currentPage == .linuxBoot {
                guard bootDevice != .kernel || linuxKernelURL != nil else {
                    alertMessage = AlertMessage(NSLocalizedString("Please select a kernel file.", comment: "VMWizardState"))
                    return
                }
            }
            if bootDevice == .drive {
                nextPage = .sharing
            } else {
                nextPage = .drives
            }
            if operatingSystem == .Linux && linuxRootImageURL != nil {
                nextPage = .sharing
            }
        case .drives:
            guard storageSizeGib > 0 else {
                alertMessage = AlertMessage(NSLocalizedString("Invalid drive size specified.", comment: "VMWizardState"))
                return
            }
            nextPage = .sharing
            if useAppleVirtualization {
                if operatingSystem != .Linux && operatingSystem != .Windows {
                    nextPage = .summary
                }
            }
        case .sharing:
            nextPage = .summary
        case .summary:
            break
        }
        slide = slideIn
        withAnimation {
            pageHistory.append(nextPage)
            nextPageBinding.wrappedValue = nextPage
            nextPageBinding = .constant(nil)
        }
    }
    
    func back() {
        slide = slideOut
        withAnimation {
            _ = pageHistory.popLast()
        }
    }
    
    #if os(macOS)
    private func generateAppleConfig() throws -> UTMAppleConfiguration {
        let config = UTMAppleConfiguration()
        config.information.name = name!
        config.system.memorySize = systemMemoryMib
        config.system.cpuCount = systemCpuCount
        if bootDevice != .none, let bootImageURL = bootImageURL {
            config.drives.append(UTMAppleConfigurationDrive(existingURL: bootImageURL, isExternal: true))
        }
        var isSkipDiskCreate = false
        if let iconName = operatingSystem.defaultIconName {
            config.information.iconURL = UTMConfigurationInfo.builtinIcon(named: iconName)
        }
        switch operatingSystem {
        case .Other, .ClassicMacOS:
            config.system.boot = try UTMAppleConfigurationBoot(for: .linux)
            config.system.genericPlatform = UTMAppleConfigurationGenericPlatform()
        case .Windows:
            var bootloader = try UTMAppleConfigurationBoot(for: .windows)
            bootloader.hasUefiBoot = systemBootUefi
            bootloader.hasSecureBoot = systemBootTpm
            config.system.boot = bootloader
            config.system.genericPlatform = UTMAppleConfigurationGenericPlatform()
            let unattendDirURL = (FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
                ?? URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true))
                .appendingPathComponent("UTM/Unattended", isDirectory: true)
            try? FileManager.default.createDirectory(at: unattendDirURL, withIntermediateDirectories: true)
            let unattendPath = unattendDirURL.appendingPathComponent("Autounattend_\(config.information.uuid.uuidString).iso").path
            let unattendUser: String
            if isWindowsExpressInstall {
                let trimmedUser = windowsUnattendedUserName.trimmingCharacters(in: .whitespacesAndNewlines)
                unattendUser = trimmedUser.isEmpty ? UTMVmConfig.defaultGuestUserName() : trimmedUser
            } else {
                unattendUser = "__CUSTOM_INTERACTIVE__"
            }
            if (try? UTMVmConfig.generateUnattendedIso(atPath: unattendPath,
                                                       userName: unattendUser,
                                                       password: windowsUnattendedPassword,
                                                       locale: windowsDetectedLocale)) != nil {
                let unattendURL = URL(fileURLWithPath: unattendPath)
                config.drives.append(UTMAppleConfigurationDrive(existingURL: unattendURL, isExternal: true))
            }
            if isGuestToolsInstallRequested || isWindowsExpressInstall,
               let guestToolsURL = Bundle.main.url(forResource: "GuestTools", withExtension: "iso") {
                config.drives.append(UTMAppleConfigurationDrive(existingURL: guestToolsURL, isExternal: true))
            }
        case .macOS:
            #if os(macOS) && arch(arm64)
            config.system.boot = try! UTMAppleConfigurationBoot(for: .macOS)
            config.system.boot.macRecoveryIpswURL = macRecoveryIpswURL
            config.system.macPlatform = macPlatform
            #endif
        case .Linux:
            #if os(macOS)
            if bootDevice == .kernel {
                var bootloader = try UTMAppleConfigurationBoot(for: .linux, linuxKernelURL: linuxKernelURL!)
                bootloader.linuxInitialRamdiskURL = linuxInitialRamdiskURL
                bootloader.linuxCommandLine = linuxBootArguments
                config.system.boot = bootloader
                if let linuxRootImageURL = linuxRootImageURL {
                    config.drives.append(UTMAppleConfigurationDrive(existingURL: linuxRootImageURL))
                    isSkipDiskCreate = true
                }
            } else {
                config.system.boot = try UTMAppleConfigurationBoot(for: .linux)
            }
            config.system.genericPlatform = UTMAppleConfigurationGenericPlatform()
            config.virtualization.hasRosetta = linuxHasRosetta
            #endif
        }
        if !isSkipDiskCreate {
            var newDisk = UTMAppleConfigurationDrive(newSize: storageSizeGib * bytesInGib / bytesInMib)
            if #available(macOS 14, *), (useNvmeAsDiskInterface || operatingSystem == .Windows) {
                newDisk.isNvme = true
            }
            if UTMAppleDiskImage.isASIFSupported && operatingSystem != .Windows {
                newDisk.isASIF = true
            }
            config.drives.append(newDisk)
        }
        if let sharingDirectoryURL = sharingDirectoryURL {
            config.sharedDirectories = [UTMAppleConfigurationSharedDirectory(directoryURL: sharingDirectoryURL, isReadOnly: sharingReadOnly)]
        }
        // some meaningful defaults
        let isMac = operatingSystem == .macOS
        var hasDisplay = isMac
        if #available(macOS 13, *) {
            hasDisplay = hasDisplay || (operatingSystem == .Linux) || (operatingSystem == .Windows)
        }
        if hasDisplay {
            config.displays = [UTMAppleConfigurationDisplay(width: 1920, height: 1200)]
            config.virtualization.audio = .inputOutput
            config.virtualization.keyboard = .generic
            config.virtualization.pointer = .mouse
        }
        #if arch(arm64)
        if isMac && macIsLeastVentura {
            config.virtualization.pointer = .trackpad
        }
        if isMac && macIsLeastSonoma {
            config.virtualization.keyboard = .mac
        }
        #endif
        config.virtualization.hasBalloon = true
        config.virtualization.hasEntropy = true
        config.networks = [UTMAppleConfigurationNetwork()]
        if operatingSystem == .Linux && bootDevice == .kernel {
            config.serials = [UTMAppleConfigurationSerial()]
        }
        if #available(macOS 13, *) {
            config.virtualization.hasClipboardSharing = true
        }
        return config
    }
    
    #if arch(arm64)
    private func fetchLatestPlatform() {
        VZMacOSRestoreImage.fetchLatestSupported { result in
            switch result {
            case .success(let restoreImage):
                DispatchQueue.main.async {
                    if let hardwareModel = restoreImage.mostFeaturefulSupportedConfiguration?.hardwareModel {
                        self.macPlatform = UTMAppleConfigurationMacPlatform(newHardware: hardwareModel)
                        self.macRecoveryIpswURL = restoreImage.url
                        self.macPlatformVersion = restoreImage.buildVersion.integerPrefix()
                    } else {
                        self.alertMessage = AlertMessage(NSLocalizedString("Failed to get latest macOS version from Apple.", comment: "VMWizardState"))
                    }
                }
            case .failure(let error):
                DispatchQueue.main.async {
                    self.alertMessage = AlertMessage(error.localizedDescription)
                }
            }
        }
    }
    #endif
    #endif
    
    func generateConfig() throws -> any UTMConfiguration {
        guard name != nil else {
            throw VMWizardError.nameEmpty
        }
        #if os(macOS)
        return try generateAppleConfig()
        #else
        throw NSLocalizedString("Unavailable for this platform.", comment: "VMWizardState")
        #endif
    }
    
    /// Execute a task with spinning progress indicator (Swift concurrency version)
    /// - Parameter work: Function to execute
    func busyWorkAsync(_ work: @escaping @Sendable () async throws -> Void) {
        Task.detached(priority: .userInitiated) {
            await MainActor.run { self.isBusy = true }
            do {
                try await work()
            } catch {
                logger.error("\(error)")
                await MainActor.run { self.alertMessage = AlertMessage(error.localizedDescription) }
            }
            await MainActor.run { self.isBusy = false }
        }
    }
}

// MARK: - Warnings for common mistakes

extension VMWizardState {
    nonisolated func confusedUserCheck() {
        Task { @MainActor in
            do {
                try confusedUserCheckBootImage()
            } catch {
                self.alertMessage = AlertMessage(error.localizedDescription)
            }
        }
    }
    
    private func confusedUserCheckBootImage() throws {
        guard let path = bootImageURL?.path.lowercased() else {
            return
        }
        if path.contains("x64") {
            throw VMWizardError.confusedArchitectureWarning("x64", "ARM64", "a64")
        }
        if path.contains("amd64") {
            throw VMWizardError.confusedArchitectureWarning("amd64", "ARM64", "arm64")
        }
        if path.contains("x86_64") {
            throw VMWizardError.confusedArchitectureWarning("x86_64", "ARM64", "arm64")
        }
    }
}

enum VMWizardError: Error {
    case confusedArchitectureWarning(String, String, String)
    case nameEmpty
}

extension VMWizardError: LocalizedError {
    var errorDescription: String? {
        switch self {
        case .confusedArchitectureWarning(let pattern, let architecture, let expected): return String.localizedStringWithFormat(NSLocalizedString("The selected boot image contains the word '%@' but the guest architecture is '%@'. Please ensure you have selected an image that is compatible with '%@'.", comment: "VMWizardState"), pattern, architecture, expected)
        case .nameEmpty: return NSLocalizedString("Name cannot be empty.", comment: "VMWizardState")
        }
    }
}
