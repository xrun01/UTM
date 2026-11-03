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

import SwiftUI

struct SettingsView: View {
    private enum Selection: CaseIterable, Identifiable {
        case application
        case display
        case input
        case network
        case file

        var id: Self {
            return self
        }

        var title: LocalizedStringKey {
            switch self {
            case .application:
                return "Application"
            case .display:
                return "Display"
            case .input:
                return "Input"
            case .network:
                return "Network"
            case .file:
                return "File"
            }
        }

        var systemImage: String {
            switch self {
            case .application:
                return "app.badge"
            case .display:
                return "rectangle.on.rectangle"
            case .input:
                return "keyboard"
            case .network:
                return "network"
            case .file:
                return "folder"
            }
        }

        @ViewBuilder
        var view: some View {
            switch self {
            case .application:
                ApplicationSettingsView()
            case .display:
                DisplaySettingsView()
            case .input:
                InputSettingsView()
            case .network:
                NetworkSettingsView()
            case .file:
                FileSettingsView()
            }
        }
    }

    @State private var selection: Selection = .application

    var body: some View {
        if #available(macOS 26, *) {
            newBody
        } else {
            oldBody
        }
    }

    @available(macOS 15, *)
    @ViewBuilder
    var newBody: some View {
        NavigationSplitView {
            List(Selection.allCases, selection: $selection) { category in
                Label(category.title, systemImage: category.systemImage)
            }.toolbar(removing: .sidebarToggle)
        } detail: {
            VStack(alignment: .leading) {
                HStack(alignment: .top) {
                    selection.view.padding()
                    Spacer()
                }
                Spacer()
            }
        }
    }

    @ViewBuilder
    var oldBody: some View {
        TabView {
            ForEach(Selection.allCases) { category in
                VStack(alignment: .leading) {
                    HStack(alignment: .top) {
                        category.view.padding()
                        Spacer()
                    }
                    Spacer()
                }
                .tabItem {
                    Label(category.title, systemImage: category.systemImage)
                }
            }
        }
    }
}

struct ApplicationSettingsView: View {
    @AppStorage("KeepRunningAfterLastWindowClosed") var isKeepRunningAfterLastWindowClosed = false
    @AppStorage("HideDockIcon") var isDockIconHidden = false
    @AppStorage("ShowMenuIcon") var isMenuIconShown = false
    @AppStorage("PreventIdleSleep") var isPreventIdleSleep = false
    @AppStorage("NoQuitConfirmation") var isNoQuitConfirmation = false
    @AppStorage("NoUsbPrompt") var isNoUsbPrompt = false
    @AppStorage("QuitRunningVirtualMachinesPolicy") var quitPolicy = UTMQuitPolicy.saveState.rawValue

    @State private var isConfirmResetAutoConnect = false

    var body: some View {
        Form {
            Toggle(isOn: $isKeepRunningAfterLastWindowClosed, label: {
                Text("Keep UTM running after last window is closed and all VMs are shut down")
            })
            if #available(macOS 13, *) {
                Toggle(isOn: $isDockIconHidden.inverted, label: {
                    Text("Show dock icon")
                }).onChange(of: isDockIconHidden) { newValue in
                    if newValue {
                        isMenuIconShown = true
                        isKeepRunningAfterLastWindowClosed = true
                    }
                }
                Toggle(isOn: $isMenuIconShown, label: {
                    Text("Show menu bar icon")
                }).disabled(isDockIconHidden)
            }
            Toggle(isOn: $isPreventIdleSleep, label: {
                Text("Prevent system from sleeping when any VM is running")
            })
            Picker("Running VMs on quit", selection: $quitPolicy) {
                Text("Save State (Default)").tag(UTMQuitPolicy.saveState.rawValue)
                Text("Request Power Down").tag(UTMQuitPolicy.requestPowerDown.rawValue)
            }
            .fixedSize(horizontal: true, vertical: false)
            .help("Choose whether UTM saves the state of running virtual machines or requests that their guest operating systems shut down when UTM quits.")
            Toggle(isOn: $isNoQuitConfirmation, label: {
                Text("Do not show confirmation when closing a running VM")
            }).help("Closing a VM without properly shutting it down could result in data loss.")
        }
    }
}

struct DisplaySettingsView: View {
    @AppStorage("NoScreenshot") var isNoScreenshot = false
    @AppStorage("NoSaveScreenshot") var isNoSaveScreenshot = false
    @AppStorage("FullScreenUseCameraHousingArea") var isFullScreenUseCameraHousingArea = false

    var body: some View {
        Form {
            Section(header: Text("Display")) {
                Toggle(isOn: $isNoScreenshot) {
                    Text("Disable VM screenshot")
                }.help("No VM screenshots will be taken.")
                .onChange(of: isNoScreenshot) { newValue in
                    isNoSaveScreenshot = newValue
                }
                Toggle(isOn: $isNoSaveScreenshot) {
                    Text("Do not save VM screenshot to disk")
                }.help("If enabled, any existing screenshot will be deleted the next time the VM is started.")
                .disabled(isNoScreenshot)
                Toggle(isOn: $isFullScreenUseCameraHousingArea) {
                    Text("Fill the area beside the camera housing in full screen")
                }.help("If enabled, a full screen VM display will use the entire screen including the area beside the built-in camera. The menu bar will cover this area while it is revealed.")
            }
        }
    }
}

struct InputSettingsView: View {
    @AppStorage("FullScreenAutoCapture") var isFullScreenAutoCapture = false
    @AppStorage("WindowFocusAutoCapture") var isWindowFocusAutoCapture = false
    @AppStorage("OptionAsMetaKey") var isOptionAsMetaKey = false
    
    var body: some View {
        Form {
            Section(header: Text("Mouse/Keyboard")) {
                Toggle(isOn: $isFullScreenAutoCapture) {
                    Text("Capture input automatically when entering full screen")
                }.help("If enabled, input capture will toggle automatically when entering and exiting full screen mode.")
                Toggle(isOn: $isWindowFocusAutoCapture) {
                    Text("Capture input automatically when window is focused")
                }.help("If enabled, input capture will toggle automatically when the VM's window is focused.")
            }
            
            Section(header: Text("Console")) {
                Toggle(isOn: $isOptionAsMetaKey, label: {
                    Text("Option (⌥) is Meta key")
                }).help("If enabled, Option will be mapped to the Meta key which can be useful for emacs. Otherwise, option will work as the system intended (such as for entering international text).")
            }
        }
    }
}

struct NetworkSettingsView: View {
    @AppStorage("IsRegenerateMACOnClone") var isRegenerateMACOnClone = false
    @AppStorage("HostNetworks") var hostNetworksData: Data = Data()
    @State private var hostNetworks: [UTMConfigurationHostNetwork] = []
    @State private var selectedID: UUID?
    @State private var isImporterPresented: Bool = false
    
    private func loadData() {
        hostNetworks = (try? PropertyListDecoder().decode([UTMConfigurationHostNetwork].self, from: hostNetworksData)) ?? []
    }
    
    private func saveData() {
        hostNetworksData = (try? PropertyListEncoder().encode(hostNetworks)) ?? Data()
    }
    
    var body: some View {
        Form {
            Section(header: Text("Cloning")) {
                Toggle("Regenerate MAC addresses on clone", isOn: $isRegenerateMACOnClone)
                    .help("When cloning a VM, regenerate MAC addresses on every network interface to prevent conflicts.")
            }
            Section(header: Text("Host Networks")) {
                Table($hostNetworks, selection: $selectedID) {
                    TableColumn("Name") { $network in
                        TextField(
                            "Name",
                            text: $network.name
                        )
                        .labelsHidden()
                    }
                    TableColumn("UUID") { $network in
                        TextField(
                            "UUID",
                            text: $network.uuid,
                            onEditingChanged: { (editingChanged) in
                                if !editingChanged && UUID(uuidString: network.uuid) != nil {
                                    saveData()
                                }
                            }
                        )
                        .labelsHidden()
                        .autocorrectionDisabled()
                        .foregroundStyle(UUID(uuidString: network.uuid) == nil ? .red : .primary)
                    }
                    .width(min: 160)
                }.help("Virtual machines in 'Host' network mode can be placed in the same network to communicate with each other.")
                HStack {
                    Button("Import from VMware Fusion") {
                        isImporterPresented.toggle()
                    }.fileImporter(isPresented: $isImporterPresented, allowedContentTypes: [.data]) { result in
                        
                        if let url = try? result.get() {
                            for network in UTMConfigurationHostNetwork.parseVMware(from: url) {
                                if !hostNetworks.contains(where: {$0.uuid == network.uuid}) {
                                    hostNetworks.append(network)
                                }
                            }
                            
                            saveData()
                        }
                    }.help("Navigate to '/Library/Preferences/VMware Fusion' (⌘+Shift+G) and select the 'networking' file")
                    Spacer()
                    Button("Delete") {
                        hostNetworks.removeAll { network in
                            network.id == selectedID
                        }
                        selectedID = nil
                        saveData()
                        
                    }.disabled(selectedID == nil)
                    Button("Add") {
                        let network = UTMConfigurationHostNetwork(name: "Network \(hostNetworks.count)")
                        hostNetworks.append(network)
                        saveData()
                    }
                }
            }
        }.onAppear(perform: loadData)
    }
}

struct FileSettingsView: View {
    @AppStorage("UseFileLock") var isUseFileLock = true

    var body: some View {
        Form {
            Section(header: Text("Backend")) {
                Toggle(isOn: $isUseFileLock) {
                    Text("Lock drive images when in use")
                }.help("If enabled, all writable drive images will be locked when the VM is running. Read-only drive images will not be locked.")
            }
        }
    }
}

extension UserDefaults {
    @objc dynamic var KeepRunningAfterLastWindowClosed: Bool { false }
    @objc dynamic var ShowMenuIcon: Bool { false }
    @objc dynamic var HideDockIcon: Bool { false }
    @objc dynamic var PreventIdleSleep: Bool { false }
    @objc dynamic var NoQuitConfirmation: Bool { false }
    @objc dynamic var QuitRunningVirtualMachinesPolicy: Int { UTMQuitPolicy.saveState.rawValue }
    @objc dynamic var NoCursorCaptureAlert: Bool { false }
    @objc dynamic var FullScreenAutoCapture: Bool { false }
    @objc dynamic var OptionAsMetaKey: Bool { false }
    @objc dynamic var CtrlRightClick: Bool { false }
    @objc dynamic var NoUsbPrompt: Bool { false }
    @objc dynamic var AlternativeCaptureKey: Bool { false }
    @objc dynamic var IsCapsLockKey: Bool { false }
    @objc dynamic var IsNumLockForced: Bool { false }
    @objc dynamic var NoSaveScreenshot: Bool { false }
    @objc dynamic var InvertScroll: Bool { false }
}

struct SettingsView_Previews: PreviewProvider {
    static var previews: some View {
        SettingsView()
    }
}
