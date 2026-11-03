//
// Copyright © 2022 osy. All rights reserved.
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

private let kUTMBundleConfigFilename = "config.plist"

protocol UTMConfiguration: Codable, ObservableObject {
    associatedtype Drive: UTMConfigurationDrive
    static var oldestVersion: Int { get }
    static var currentVersion: Int { get }
    var information: UTMConfigurationInfo { get }
    var drives: [Drive] { get set }
    var backend: UTMBackend { get }
    func prepareSave(for packageURL: URL) async throws
    func saveData(to dataURL: URL) async throws -> [URL]
}

extension UTMConfiguration {
    static var oldestVersion: Int { 4 }
    static var currentVersion: Int { 4 }
}

extension CodingUserInfoKey {
    static var dataURL: CodingUserInfoKey {
        return CodingUserInfoKey(rawValue: "dataURL")!
    }
}

enum UTMBackend: String, CaseIterable, Codable {
    case unknown = "Unknown"
    case apple = "Apple"
}

protocol UTMConfigurationConstant: RawRepresentable, CaseIterable, Codable, Hashable, Identifiable where RawValue == String {
    var prettyValue: String { get }
    var isHidden: Bool { get }
}

extension UTMConfigurationConstant {
    var id: String { rawValue }
    var prettyValue: String { rawValue }
    var isHidden: Bool { false }
}

enum UTMPackageFileName: String {
    case efiVariables = "efi_vars.fd"
    case vmState = "vm_state.vzvmsave"
}

struct UTMTerminalTheme: RawRepresentable, Codable, Hashable, Identifiable {
    var rawValue: String
    var id: String { rawValue }
    init(rawValue: String) {
        self.rawValue = rawValue
    }
}

struct UTMTerminalFont: RawRepresentable, Codable, Hashable, Identifiable {
    var rawValue: String
    var id: String { rawValue }
    init(rawValue: String) {
        self.rawValue = rawValue
    }
}

enum UTMConfigurationError: Error {
    case versionTooLow
    case versionTooHigh
    case invalidConfigurationValue(String)
    case invalidBackend
    case invalidDataURL
    case invalidDriveConfiguration
    case customIconInvalid
    case driveAlreadyExists(URL)
    case cannotCreateDiskImage
}

extension UTMConfigurationError: LocalizedError {
    var errorDescription: String? {
        switch self {
        case .versionTooLow: return NSLocalizedString("This configuration is too old and is not supported.", comment: "UTMConfiguration")
        case .versionTooHigh: return NSLocalizedString("This configuration is saved with a newer version of UTM and is not compatible with this version.", comment: "UTMConfiguration")
        case .invalidConfigurationValue(let value): return String.localizedStringWithFormat(NSLocalizedString("An invalid value of '%@' is used in the configuration file.", comment: "UTMConfiguration"), value)
        case .invalidBackend: return NSLocalizedString("The backend for this configuration is not supported.", comment: "UTMConfiguration")
        case .driveAlreadyExists(let url): return String.localizedStringWithFormat(NSLocalizedString("The drive '%@' already exists and cannot be created.", comment: "UTMConfiguration"), url.lastPathComponent)
        default: return NSLocalizedString("An internal error has occurred.", comment: "UTMConfiguration")
        }
    }
}

// MARK: - Configuration file parsing

private final class UTMConfigurationStub: Decodable {
    var backend: UTMBackend
    var configurationVersion: Int
    
    enum CodingKeys: String, CodingKey {
        case backend = "Backend"
        case configurationVersion = "ConfigurationVersion"
    }
    
    required init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        backend = try values.decodeIfPresent(UTMBackend.self, forKey: .backend) ?? .unknown
        configurationVersion = try values.decodeIfPresent(Int.self, forKey: .configurationVersion) ?? 0
    }
}

extension UTMConfiguration {
    static var dataDirectoryName: String { "Data" }
    
    static func load(from packageURL: URL) throws -> any UTMConfiguration {
        let scopedAccess = packageURL.startAccessingSecurityScopedResource()
        defer {
            if scopedAccess {
                packageURL.stopAccessingSecurityScopedResource()
            }
        }
        let dataURL = packageURL.appendingPathComponent(Self.dataDirectoryName)
        let configURL = packageURL.appendingPathComponent(kUTMBundleConfigFilename)
        let configData = try Data(contentsOf: configURL)
        let decoder = PropertyListDecoder()
        decoder.userInfo = [.dataURL: dataURL]
        let stub = try decoder.decode(UTMConfigurationStub.self, from: configData)
        if stub.backend == .apple {
            #if os(macOS)
            return try decoder.decode(UTMAppleConfiguration.self, from: configData)
            #else
            throw UTMConfigurationError.invalidBackend
            #endif
        } else {
            throw UTMConfigurationError.invalidBackend
        }
    }
    
    func save(to packageURL: URL) async throws {
        let fileManager = FileManager.default

        // let concrete class do any pre-processing
        try await prepareSave(for: packageURL)
        // create package directory
        if !fileManager.fileExists(atPath: packageURL.path) {
            try fileManager.createDirectory(at: packageURL, withIntermediateDirectories: false)
        }
        // create data directory
        let dataURL = packageURL.appendingPathComponent(Self.dataDirectoryName)
        if !fileManager.fileExists(atPath: dataURL.path) {
            try fileManager.createDirectory(at: dataURL, withIntermediateDirectories: false)
        }
        // save new and existing data
        let existingDataURLs = try await saveData(to: dataURL)
        // cleanup any extra unreferenced files
        try await Self.cleanupAllFiles(at: dataURL, notIncluding: existingDataURLs)
        // create config.plist
        let encoder = PropertyListEncoder()
        encoder.outputFormat = .xml
        let settingsData = try encoder.encode(self)
        try settingsData.write(to: packageURL.appendingPathComponent(kUTMBundleConfigFilename))
    }
    
    /// Check if a file has changed and if so, copy the new file to the bundle
    /// - Parameters:
    ///   - sourceURL: File to copy
    ///   - destFolderURL: Destination in bundle's data directory
    ///   - customCopy: If non-nil, a custom copy function is invoked
    /// - Returns: URL of the updated item in the bundle
    static func copyItemIfChanged(from sourceURL: URL, to destFolderURL: URL, customCopy: ((_ sourceURL: URL, _ destURL: URL) async throws -> URL)? = nil) async throws -> URL {
        _ = sourceURL.startAccessingSecurityScopedResource()
        defer {
            sourceURL.stopAccessingSecurityScopedResource()
        }
        let fileManager = FileManager.default
        let destURL = destFolderURL.appendingPathComponent(sourceURL.lastPathComponent)
        // check if both are same file
        if fileManager.fileExists(atPath: destURL.path) {
            let sourceRef = try sourceURL.resourceValues(forKeys: [.fileResourceIdentifierKey]).fileResourceIdentifier
            let destRef = try destURL.resourceValues(forKeys: [.fileResourceIdentifierKey]).fileResourceIdentifier
            if sourceRef?.isEqual(destRef) ?? false {
                return destURL
            }
        }
        if let customCopy = customCopy {
            return try await customCopy(sourceURL, destFolderURL)
        } else {
            let newUrl = uniqueDestinationURL(from: sourceURL, to: destFolderURL)
            try await Task.detached {
                try FileManager.default.copyItem(at: sourceURL, to: newUrl)
            }.value
            return newUrl
        }
    }

    static func uniqueDestinationURL(from sourceUrl: URL, to destUrl: URL, withExtension: String? = nil) -> URL {
        let name = sourceUrl.deletingPathExtension().lastPathComponent
        let ext = withExtension ?? sourceUrl.pathExtension
        for i in 1..<1000 {
            let suffix = i == 1 ? "" : "-\(i)"
            let attemptUrl = destUrl.appendingPathComponent("\(name)\(suffix)").appendingPathExtension(ext)
            if !FileManager.default.fileExists(atPath: attemptUrl.path) {
                return attemptUrl
            }
        }
        return destUrl.appendingPathComponent(UUID().uuidString).appendingPathExtension(ext)
    }
    
    private static func cleanupAllFiles(at dataURL: URL, notIncluding urls: [URL]) async throws {
        let fileManager = FileManager.default
        let existingNames = urls.map { url in
            url.lastPathComponent
        }
        let dataFileURLs = try fileManager.contentsOfDirectory(at: dataURL, includingPropertiesForKeys: nil)
        try await Task.detached {
            for dataFileURL in dataFileURLs {
                if !existingNames.contains(dataFileURL.lastPathComponent) {
                    try FileManager.default.removeItem(at: dataFileURL)
                }
            }
        }.value
    }
}
