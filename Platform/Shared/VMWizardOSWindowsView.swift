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

import SwiftUI

struct VMWizardOSWindowsView: View {
    @ObservedObject var wizardState: VMWizardState
    @State private var isFileImporterPresented: Bool = false

    var body: some View {
        VMWizardContent("Windows") {
            Section {
                Picker("Installation Mode", selection: $wizardState.isWindowsExpressInstall) {
                    Text("Express (Fully Automatic)").tag(true)
                    Text("Custom (Step by Step)").tag(false)
                }
                .pickerStyle(.segmented)
            } header: {
                Text("Installation Method")
            }

            Section {
                FileBrowseField(url: $wizardState.bootImageURL, isFileImporterPresented: $isFileImporterPresented, hasClearButton: false)
                if wizardState.bootImageURL == nil {
                    Button("Get Windows 11 ARM64 Image from Microsoft…") {
                        if let url = URL(string: "https://www.microsoft.com/software-download/windows11arm64") {
                            NSWorkspace.shared.open(url)
                        }
                    }
                    .buttonStyle(.link)
                }

                if wizardState.isBusy {
                    Spinner(size: .large)
                }
            } header: {
                Text("Windows ARM64 ISO Image")
            }

            if wizardState.isWindowsExpressInstall {
                Section {
                    TextField("Username", text: $wizardState.windowsUnattendedUserName)
                    SecureField("Password (leave empty for automatic sign-in)", text: $wizardState.windowsUnattendedPassword)
                    HStack {
                        Text("System Language")
                        Spacer()
                        Text("\(wizardState.windowsDetectedLocale) (Same as Host)")
                            .foregroundColor(.secondary)
                    }
                    HStack {
                        Text("Automatic Hardware Configuration")
                        Spacer()
                        Text("\(wizardState.systemCpuCount) Cores / \(wizardState.systemMemoryMib / 1024) GB Memory / \(wizardState.storageSizeGib) GB NVMe")
                            .foregroundColor(.secondary)
                    }
                } header: {
                    Text("Unattended Account and Automatic Setup")
                }
            } else {
                Section {
                    Toggle("Install Windows 10 or later", isOn: $wizardState.isWindows10OrHigher)
                        .onChange(of: wizardState.isWindows10OrHigher) { newValue in
                            if newValue {
                                wizardState.systemBootUefi = true
                                wizardState.systemBootTpm = true
                                wizardState.isGuestToolsInstallRequested = true
                            } else {
                                wizardState.systemBootUefi = false
                                wizardState.systemBootTpm = false
                                wizardState.isGuestToolsInstallRequested = false
                            }
                        }
                    Toggle("Install Guest Tools", isOn: $wizardState.isGuestToolsInstallRequested)
                } header: {
                    Text("Custom Installation Options")
                }
            }
        }
        .fileImporter(isPresented: $isFileImporterPresented, allowedContentTypes: [.data], onCompletion: processImage)
        .onAppear {
            wizardState.bootDevice = .cd
            wizardState.windowsDetectedLocale = UTMVmConfig.detectedHostWindowsLocale()
            if wizardState.windowsUnattendedUserName.isEmpty {
                wizardState.windowsUnattendedUserName = UTMVmConfig.defaultGuestUserName()
            }
            if wizardState.bootImageURL == nil,
               let detectedIso = UTMVmConfig.detectDefaultWindowsIsoInDownloads() {
                wizardState.bootImageURL = detectedIso
            }
        }
    }

    private func processImage(_ result: Result<URL, Error>) {
        wizardState.busyWorkAsync {
            let url = try result.get()
            await MainActor.run {
                wizardState.bootImageURL = url
            }
        }
    }
}

struct VMWizardOSWindowsView_Previews: PreviewProvider {
    @StateObject static var wizardState = VMWizardState()

    static var previews: some View {
        VMWizardOSWindowsView(wizardState: wizardState)
    }
}
