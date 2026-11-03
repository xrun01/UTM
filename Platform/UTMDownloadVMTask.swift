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

/// Downloads a VM and creates a pending VM placeholder.
class UTMDownloadVMTask: UTMDownloadTask {
    init(for url: URL) {
        super.init(for: url, named: UTMDownloadVMTask.name(for: url))
    }
    
    static private func name(for url: URL) -> String {
        let filename = url.lastPathComponent
        var nameWithoutZIP = "UTM Virtual Machine"
        if let index = filename.range(of: ".zip", options: [])?.lowerBound {
            nameWithoutZIP = String(filename[..<index])
        }
        return nameWithoutZIP
    }
    
    override func processCompletedDownload(at location: URL, response: URLResponse?) async throws -> any UTMVirtualMachine {
        let tempDir = fileManager.temporaryDirectory
        let originalFilename = url.lastPathComponent
        let downloadedZip = tempDir.appendingPathComponent(originalFilename)
        var fileURL: URL? = nil
        do {
            if fileManager.fileExists(atPath: downloadedZip.path) {
                try fileManager.removeItem(at: downloadedZip)
            }
            try fileManager.moveItem(at: location, to: downloadedZip)
            let utmURL = try partialUnzipOnlyUtmVM(zipFileURL: downloadedZip, destinationFolder: UTMData.defaultStorageUrl, fileManager: fileManager)
            fileURL = utmURL
            try fileManager.removeItem(at: downloadedZip)
            let vm = try await VMData(url: utmURL)
            return await vm.wrapped!
        } catch {
            logger.error("\(error.localizedDescription)")
            if let fileURL = fileURL {
                try? fileManager.removeItem(at: fileURL)
            } else {
                try? fileManager.removeItem(at: downloadedZip)
            }
            throw error
        }
    }
    
    private func partialUnzipOnlyUtmVM(zipFileURL: URL, destinationFolder: URL, fileManager: FileManager) throws -> URL {
        let utmFileEnding = ".utm"
        let extractDir = fileManager.temporaryDirectory.appendingPathComponent("utm_unzip_\(UUID().uuidString)", isDirectory: true)
        try fileManager.createDirectory(at: extractDir, withIntermediateDirectories: true)
        defer {
            try? fileManager.removeItem(at: extractDir)
        }
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/usr/bin/ditto")
        proc.arguments = ["-x", "-k", zipFileURL.path, extractDir.path]
        try proc.run()
        proc.waitUntilExit()
        guard proc.terminationStatus == 0 else {
            throw UnzipNoUTMFileError()
        }
        let items = try fileManager.contentsOfDirectory(at: extractDir, includingPropertiesForKeys: nil)
        guard let extractedUtm = items.first(where: { $0.lastPathComponent.hasSuffix(utmFileEnding) }) else {
            throw UnzipNoUTMFileError()
        }
        let originalFileName = extractedUtm.lastPathComponent
        var destinationUtmDirectory = originalFileName
        var duplicateIndex = 2
        while fileManager.fileExists(atPath: destinationFolder.appendingPathComponent(destinationUtmDirectory).path) {
            destinationUtmDirectory = originalFileName.replacingOccurrences(of: utmFileEnding, with: " (\(duplicateIndex))\(utmFileEnding)")
            duplicateIndex += 1
        }
        let destinationURL = destinationFolder.appendingPathComponent(destinationUtmDirectory, isDirectory: true)
        try fileManager.moveItem(at: extractedUtm, to: destinationURL)
        return destinationURL
    }
    
    private class UnzipNoUTMFileError: LocalizedError {
        var errorDescription: String? {
            NSLocalizedString("There is no UTM file in the downloaded ZIP archive.", comment: "Error shown when importing a ZIP file from web that doesn't contain a UTM Virtual Machine.")
        }
    }
}
