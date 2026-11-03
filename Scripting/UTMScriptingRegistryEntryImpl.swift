//
// Copyright © 2025 naveenrajm7. All rights reserved.
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
    @objc var registry: [URL] {
        let wrapper = UTMScriptingRegistryEntryImpl(vm.registryEntry)
        return wrapper.serializeRegistry()
    }
    
    @objc func updateRegistry(_ command: NSScriptCommand) {
        let newRegistry = command.evaluatedArguments?["newRegistry"] as? [URL]
        withScriptCommand(command) { [self] in
            guard let newRegistry = newRegistry else {
                throw ScriptingError.invalidParameter
            }
            let wrapper = UTMScriptingRegistryEntryImpl(vm.registryEntry)
            try await wrapper.updateRegistry(from: newRegistry)
            (vm as? UTMAppleVirtualMachine)?.updateConfigFromRegistry()
        }
    }
}

@MainActor
class UTMScriptingRegistryEntryImpl {
    private(set) var registry: UTMRegistryEntry
    
    init(_ registry: UTMRegistryEntry) {
        self.registry = registry
    }
    
    func serializeRegistry() -> [URL] {
        return registry.sharedDirectories.compactMap { $0.url }
    }
    
    func updateRegistry(from fileUrls: [URL]) async throws {
        registry.removeAllSharedDirectories()
        
        for url in fileUrls {
            let isScopedAccess = url.startAccessingSecurityScopedResource()
            defer {
                if isScopedAccess {
                    url.stopAccessingSecurityScopedResource()
                }
            }
            
            let bookmark = try url.persistentBookmarkData(isReadyOnly: false)
            let file = try UTMRegistryEntry.File(path: url.path, bookmark: bookmark)
            registry.appendSharedDirectory(file)
        }
    }
}
