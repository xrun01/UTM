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
                Picker("安装模式", selection: $wizardState.isWindowsExpressInstall) {
                    Text("一键安装 (全自动)").tag(true)
                    Text("自定义配置 (逐步向导)").tag(false)
                }
                .pickerStyle(.segmented)
            } header: {
                Text("安装方式")
            }

            Section {
                FileBrowseField(url: $wizardState.bootImageURL, isFileImporterPresented: $isFileImporterPresented, hasClearButton: false)

                if wizardState.isBusy {
                    Spinner(size: .large)
                }
            } header: {
                Text("Windows ARM64 ISO 镜像")
            }

            if wizardState.isWindowsExpressInstall {
                Section {
                    TextField("用户名", text: $wizardState.windowsUnattendedUserName)
                    SecureField("密码 (留空则免密自动登录)", text: $wizardState.windowsUnattendedPassword)
                    HStack {
                        Text("系统语言")
                        Spacer()
                        Text("\(wizardState.windowsDetectedLocale) (跟随宿主系统)")
                            .foregroundColor(.secondary)
                    }
                    HStack {
                        Text("自动硬件配置")
                        Spacer()
                        Text("\(wizardState.systemCpuCount) 核 / \(wizardState.systemMemoryMib / 1024) GB 内存 / \(wizardState.storageSizeGib) GB NVMe")
                            .foregroundColor(.secondary)
                    }
                } header: {
                    Text("一键无人值守账户与自动配置")
                }
            } else {
                Section {
                    Toggle("Install Windows 10 or higher", isOn: $wizardState.isWindows10OrHigher)
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
                    Text("自定义安装选项")
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
