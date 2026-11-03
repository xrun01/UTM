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

import SwiftUI

struct VMNavigationListView: View {
    @EnvironmentObject private var data: UTMData
    @State private var confirmAction: ConfirmAction?

    var body: some View {
        if #available(macOS 13, *) {
            CompatibleNavigationSplitView {
                List(selection: $data.selectedVM) {
                    listBody
                }.modifier(VMListModifier())
            } detail: {
                if let vm = data.selectedVM {
                    VMDetailsView(vm: vm)
                } else {
                    VMPlaceholderView()
                }
            }.navigationSplitViewStyle(.balanced)
        } else {
            NavigationView {
                List {
                    listBody
                }.modifier(VMListModifier())
                VMPlaceholderView()
            }
        }
    }
    
    @ViewBuilder private var listBody: some View {
        ForEach(data.virtualMachines) { vm in
            if !vm.isLoaded {
                UTMUnavailableVMView(vm: vm)
            } else {
                if #available(macOS 13, *) {
                    VMCardView(vm: vm)
                        .modifier(VMContextMenuModifier(vm: vm))
                        .tag(vm)
                        .swipeActions {
                            Button(role: .destructive) {
                                confirmAction = .confirmDeleteVM(vm: vm)
                            } label: {
                                Label("Delete", systemImage: "trash")
                            }
                        }
                } else {
                    NavigationLink(
                        destination: VMDetailsView(vm: vm),
                        tag: vm,
                        selection: $data.selectedVM,
                        label: { VMCardView(vm: vm) })
                    .modifier(VMContextMenuModifier(vm: vm))
                }
            }
        }.onMove(perform: move)
        .modifier(VMConfirmActionModifier(confirmAction: $confirmAction, workaroundSwipeBug: true, onConfirm: { _ in }))

        if data.pendingVMs.count > 0 {
            Section(header: Text("Pending")) {
                ForEach(data.pendingVMs, id: \.name) { vm in
                    UTMPendingVMView(vm: vm)
                }.onDelete(perform: cancel)
            }.transition(.opacity)
        }
    }
    
    private func move(fromOffsets: IndexSet, toOffset: Int) {
        data.listMove(fromOffsets: fromOffsets, toOffset: toOffset)
    }
    
    private func delete(indexSet: IndexSet) {
        let selected = data.virtualMachines[indexSet]
        for vm in selected {
            data.busyWorkAsync {
                try await data.delete(vm: vm)
            }
        }
    }
    
    private func cancel(indexSet: IndexSet) {
        let selected = data.pendingVMs[indexSet]
        for vm in selected {
            data.cancelDownload(for: vm)
        }
    }
}

@available(macOS 13, *)
private struct CompatibleNavigationSplitView<Sidebar, Detail> : View where Sidebar : View, Detail : View {
    @State private var columnVisibility: NavigationSplitViewVisibility = .doubleColumn
    
    let sidebar: () -> Sidebar
    let detail: () -> Detail

    init(@ViewBuilder sidebar: @escaping () -> Sidebar, @ViewBuilder detail: @escaping () -> Detail) {
        self.sidebar = sidebar
        self.detail = detail
    }
    
    var body: some View {
        NavigationSplitView(columnVisibility: $columnVisibility, sidebar: sidebar, detail: detail)
    }
}

private struct VMListModifier: ViewModifier {
    @EnvironmentObject private var data: UTMData

    func body(content: Content) -> some View {
        content
        .frame(minWidth: 250, idealWidth: 350)
        .listStyle(.sidebar)
        .navigationTitle(productName)
        .navigationSubtitle(data.selectedVM?.detailsTitleLabel ?? "")
        .toolbar {
            ToolbarItem(placement: .navigation) {
                newButton
            }
        }
        .sheet(isPresented: $data.showNewVMSheet) {
            VMWizardView()
        }
        .onReceive(NSNotification.OpenVirtualMachine) { _ in
            data.showNewVMSheet = false
        }
    }
    
    private var newButton: some View {
        Button(action: { data.newVM() }, label: {
            Label("New VM", systemImage: "plus").labelStyle(.iconOnly)
        }).help("Create a new VM")
    }
}
