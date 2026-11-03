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
#if canImport(Virtualization)
import Virtualization
#endif

struct VMWizardHardwareView: View {
    @ObservedObject var wizardState: VMWizardState

    var minCores: Int {
        #if canImport(Virtualization)
        VZVirtualMachineConfiguration.minimumAllowedCPUCount
        #else
        1
        #endif
    }
    
    var maxCores: Int {
        #if canImport(Virtualization)
        VZVirtualMachineConfiguration.maximumAllowedCPUCount
        #else
        Int(sysctlIntRead("hw.ncpu"))
        #endif
    }
    
    var minMemoryMib: Int {
        #if canImport(Virtualization)
        Int(VZVirtualMachineConfiguration.minimumAllowedMemorySize / UInt64(wizardState.bytesInMib))
        #else
        8
        #endif
    }
    
    var maxMemoryMib: Int {
        #if canImport(Virtualization)
        Int(VZVirtualMachineConfiguration.maximumAllowedMemorySize / UInt64(wizardState.bytesInMib))
        #else
        sysctlIntRead("hw.memsize")
        #endif
    }
    
    var body: some View {
        VMWizardContent("Hardware") {
            Section {
                RAMSlider(systemMemory: $wizardState.systemMemoryMib) { _ in
                    if wizardState.systemMemoryMib > maxMemoryMib {
                        wizardState.systemMemoryMib = maxMemoryMib
                    }
                    if wizardState.systemMemoryMib < minMemoryMib {
                        wizardState.systemMemoryMib = minMemoryMib
                    }
                }
            } header: {
                Text("Memory")
            }

            Section {
                HStack {
                    Stepper(value: $wizardState.systemCpuCount, in: minCores...maxCores) {
                        Text("CPU Cores")
                    }
                    NumberTextField("", number: $wizardState.systemCpuCount, prompt: "Default", onEditingChanged: { _ in
                        guard wizardState.systemCpuCount != 0  else {
                            return
                        }
                        if wizardState.systemCpuCount < minCores {
                            wizardState.systemCpuCount = minCores
                        } else if wizardState.systemCpuCount > maxCores {
                            wizardState.systemCpuCount = maxCores
                        }
                    })
                    .frame(width: 80)
                    .multilineTextAlignment(.trailing)
                }
            } header: {
                Text("CPU")
            }
        }
        .textFieldStyle(.roundedBorder)
        .onAppear {
            wizardState.legacyHardware = false
        }
    }
    
    private func sysctlIntRead(_ name: String) -> Int {
        var value: Int = 0
        var size = MemoryLayout<UInt64>.size
        sysctlbyname(name, &value, &size, nil, 0)
        return value
    }
}

struct VMWizardHardwareView_Previews: PreviewProvider {
    @StateObject static var wizardState = VMWizardState()
    
    static var previews: some View {
        VMWizardHardwareView(wizardState: wizardState)
    }
}
