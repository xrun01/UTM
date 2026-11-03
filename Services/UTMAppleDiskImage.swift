//
// Copyright © 2026 Turing Software, LLC. All rights reserved.
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
import Darwin
import Virtualization
#if canImport(DiskImageKit)
import DiskImageKit
#endif

enum UTMAppleDiskImage {
    enum Format: Equatable {
        case asif
        case raw
        case layered
        case other(String)

        var localizedDescription: String {
            switch self {
            case .asif: return NSLocalizedString("ASIF", comment: "UTMAppleDiskImage")
            case .raw: return NSLocalizedString("RAW", comment: "UTMAppleDiskImage")
            case .layered: return NSLocalizedString("Layered", comment: "UTMAppleDiskImage")
            case .other(let name): return name
            }
        }
    }

    struct Info {
        let format: Format
        let size: Int64
    }

    private static let bytesInMib = 1048576
    fileprivate static let layerFileExtension = "asif"
    private static let blockSize = 512

    static var isASIFSupported: Bool {
        if #available(macOS 26, *) {
            return UTMASIFImage.sharedInstance() != nil
        } else {
            return false
        }
    }

    @available(macOS 13, *)
    static func createASIF(at url: URL, sizeMib: Int) throws {
        let blockCount = sizeMib * bytesInMib / blockSize
        try legacyCreateASIF(at: url, blockCount: blockCount)
    }

    @available(macOS 14, *)
    static func info(for url: URL) throws -> Info {
        return try legacyInfo(for: url)
    }

    static func layerFileURLs(of imageURL: URL) -> [URL] {
        let prefix = imageURL.lastPathComponent + "."
        let siblings = (try? FileManager.default.contentsOfDirectory(at: imageURL.deletingLastPathComponent(), includingPropertiesForKeys: nil)) ?? []
        return siblings.filter { $0.lastPathComponent.hasPrefix(prefix) && $0.pathExtension == layerFileExtension }
    }

    @available(macOS 14, *)
    static func resize(_ url: URL, toSizeMib sizeMib: Int) throws {
        guard layerFileURLs(of: url).isEmpty else {
            throw UTMAppleDiskImageError.hasSnapshots
        }
        try legacyResize(url, toSizeMib: sizeMib)
    }
}

extension UTMAppleDiskImage {
    struct Layer: Equatable {
        static let currentName = "current"
        fileprivate static let fileExtension = layerFileExtension
        fileprivate static let unlinkedMarker = "unlinked"

        let url: URL
        let name: String
        let isUnlinked: Bool
        let uuid: UUID
        let parentUUID: UUID?

        var isCurrent: Bool {
            name == Self.currentName
        }

        fileprivate static func url(for imageURL: URL, name: String, isUnlinked: Bool = false) -> URL {
            var url = imageURL.appendingPathExtension(name)
            if isUnlinked {
                url.appendPathExtension(unlinkedMarker)
            }
            return url.appendingPathExtension(fileExtension)
        }
    }

    static func layers(of imageURL: URL) throws -> [Layer] {
        let prefix = imageURL.lastPathComponent + "."
        let candidates = layerFileURLs(of: imageURL)
        return candidates.compactMap { url -> Layer? in
            var name = String(url.deletingPathExtension().lastPathComponent.dropFirst(prefix.count))
            let isUnlinked = name.hasSuffix("." + Layer.unlinkedMarker)
            if isUnlinked {
                name.removeLast(Layer.unlinkedMarker.count + 1)
            }
            guard !name.isEmpty else { return nil }
            let deterministicUUID = UUID(uuidString: "00000000-0000-0000-0000-000000000000") ?? UUID()
            return Layer(url: url, name: name, isUnlinked: isUnlinked, uuid: deterministicUUID, parentUUID: nil)
        }
    }

    static func attachment(for url: URL, includesLayers: Bool, ephemeralOverlayAt overlayURL: URL? = nil, isReadOnly: Bool = false, cachingMode: VZDiskImageCachingMode = .automatic, synchronizationMode: VZDiskImageSynchronizationMode = .full) throws -> VZDiskImageStorageDeviceAttachment? {
        if let overlayURL = overlayURL {
            try? FileManager.default.removeItem(at: overlayURL)
            if clonefile(url.path, overlayURL.path, 0) != 0 {
                try FileManager.default.copyItem(at: url, to: overlayURL)
            }
            return try VZDiskImageStorageDeviceAttachment(url: overlayURL, readOnly: false, cachingMode: cachingMode, synchronizationMode: synchronizationMode)
        }
        return nil
    }

    static func createSnapshot(of imageURL: URL, name: String) throws {
        let snapshotURL = Layer.url(for: imageURL, name: name)
        try? FileManager.default.removeItem(at: snapshotURL)
        if clonefile(imageURL.path, snapshotURL.path, 0) != 0 {
            try FileManager.default.copyItem(at: imageURL, to: snapshotURL)
        }
    }

    static func restoreSnapshot(of imageURL: URL, name: String) throws {
        let snapshotURL = Layer.url(for: imageURL, name: name)
        guard FileManager.default.fileExists(atPath: snapshotURL.path) else {
            throw UTMAppleDiskImageError.snapshotNotFound(name)
        }
        let tempURL = imageURL.appendingPathExtension("restore_tmp")
        try? FileManager.default.removeItem(at: tempURL)
        if clonefile(snapshotURL.path, tempURL.path, 0) != 0 {
            try FileManager.default.copyItem(at: snapshotURL, to: tempURL)
        }
        _ = try FileManager.default.replaceItemAt(imageURL, withItemAt: tempURL)
    }

    static func validateSnapshot(of imageURL: URL, name: String) throws {
        let snapshotURL = Layer.url(for: imageURL, name: name)
        guard FileManager.default.fileExists(atPath: snapshotURL.path) else {
            throw UTMAppleDiskImageError.snapshotNotFound(name)
        }
    }

    static func deleteSnapshot(of imageURL: URL, name: String) throws {
        let snapshotURL = Layer.url(for: imageURL, name: name)
        guard FileManager.default.fileExists(atPath: snapshotURL.path) else {
            throw UTMAppleDiskImageError.snapshotNotFound(name)
        }
        try FileManager.default.removeItem(at: snapshotURL)
    }

    static func preservedLayerURLs(of imageURL: URL, for names: Set<String>) throws -> [URL] {
        return layerFileURLs(of: imageURL)
    }
}

enum UTMAppleDiskImageError: Error {
    case snapshotNotFound(String)
    case layerMissing
    case hasSnapshots
    case snapshotsRequireNewerOS
    case readOnlyWithSnapshots
}

extension UTMAppleDiskImageError: LocalizedError {
    var errorDescription: String? {
        switch self {
        case .snapshotNotFound(let name):
            return String.localizedStringWithFormat(NSLocalizedString("The disk image has no snapshot '%@'.", comment: "UTMAppleDiskImage"), name)
        case .layerMissing:
            return NSLocalizedString("The disk image is incomplete because some of its data could not be read.", comment: "UTMAppleDiskImage")
        case .hasSnapshots:
            return NSLocalizedString("A drive cannot be resized once a snapshot has been taken of it.", comment: "UTMAppleDiskImage")
        case .snapshotsRequireNewerOS:
            return NSLocalizedString("This drive holds snapshots and can only be used on macOS 27 or later.", comment: "UTMAppleDiskImage")
        case .readOnlyWithSnapshots:
            return NSLocalizedString("A drive cannot be read only once a snapshot has been taken of it.", comment: "UTMAppleDiskImage")
        }
    }
}

private extension UTMAppleDiskImage {
    @available(macOS 13, *)
    static func legacyCreateASIF(at url: URL, blockCount: Int) throws {
        guard let asif = UTMASIFImage.sharedInstance() else {
            throw UTMAppleConfigurationError.featureNotSupported
        }
        try asif.createBlank(with: url, numBlocks: blockCount)
    }

    @available(macOS 14, *)
    static func legacyInfo(for url: URL) throws -> Info {
        guard let asif = UTMASIFImage.sharedInstance() else {
            throw UTMAppleConfigurationError.featureNotSupported
        }
        let info = try asif.retrieveInfo(url)
        guard let sizeInfo = info["Size Info"] as? [String: Any], let totalBytes = sizeInfo["Total Bytes"] as? Int64 else {
            throw UTMAppleConfigurationError.featureNotSupported
        }
        let format: Format
        switch info["Image Format"] as? String {
        case "ASIF": format = .asif
        case "RAW", "RAW*": format = .raw
        case .some(let name): format = .other(name)
        case .none: format = .other(NSLocalizedString("Unknown", comment: "UTMAppleDiskImage"))
        }
        return Info(format: format, size: totalBytes)
    }

    @available(macOS 14, *)
    static func legacyResize(_ url: URL, toSizeMib sizeMib: Int) throws {
        guard let asif = UTMASIFImage.sharedInstance() else {
            throw UTMAppleConfigurationError.featureNotSupported
        }
        try asif.resize(with: url, size: sizeMib * bytesInMib)
    }
}
