//
// Copyright © 2025 osy. All rights reserved.
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

import AppIntents

@available(iOS 16, macOS 13, tvOS 16, watchOS 9, *)
struct UTMVirtualMachineEntityQuery: EntityQuery, EntityStringQuery {
    @Dependency
    var data: UTMData

    func entities(for identifiers: [UUID]) async throws -> [UTMVirtualMachineEntity] {
        await MainActor.run {
            data
                .virtualMachines
                .filter({ identifiers.contains($0.id) })
                .map({ UTMVirtualMachineEntity(from: $0) })
        }
    }

    func entities(matching: String) async throws -> [UTMVirtualMachineEntity] {
        await MainActor.run {
            data
                .virtualMachines
                .filter({ $0.detailsTitleLabel.localizedCaseInsensitiveContains(matching) })
                .map({ UTMVirtualMachineEntity(from: $0) })
        }
    }

    func suggestedEntities() async throws -> [UTMVirtualMachineEntity] {
        await MainActor.run {
            data
                .virtualMachines
                .map({ UTMVirtualMachineEntity(from: $0) })
        }
    }
}

@available(iOS 17, macOS 14, tvOS 17, watchOS 10, *)
extension UTMVirtualMachineEntityQuery: EntityPropertyQuery {
    typealias ComparatorMappingType = @Sendable (UTMVirtualMachineEntity) -> Bool

    static let properties = QueryProperties {
        Property(\UTMVirtualMachineEntity.$name) {
            ContainsComparator { searchValue in
                { $0.name.localizedStandardContains(searchValue) }
            }
            EqualToComparator { searchValue in
                { $0.name == searchValue }
            }
            NotEqualToComparator { searchValue in
                { $0.name != searchValue }
            }
        }
        Property(\UTMVirtualMachineEntity.$state) {
            EqualToComparator { searchValue in
                { $0.state == searchValue }
            }
            NotEqualToComparator { searchValue in
                { $0.state != searchValue }
            }
        }
    }

    static let sortingOptions = SortingOptions {
        SortableBy(\UTMVirtualMachineEntity.$name)
    }

    static var findIntentDescription: IntentDescription? {
        IntentDescription("Search for a virtual machine.",
                          searchKeywords: ["virtual machine", "vm"],
                          resultValueName: "Virtual Machines")
    }

    func entities(matching comparators: [ComparatorMappingType],
                  mode: ComparatorMode,
                  sortedBy: [EntityQuerySort<UTMVirtualMachineEntity>],
                  limit: Int?) async throws -> [UTMVirtualMachineEntity] {
        var matchedVms = await virtualMachines(matching: comparators, mode: mode)

        for sortOperation in sortedBy {
            switch sortOperation.by {
            case \.$name:
                matchedVms.sort(using: KeyPathComparator(\UTMVirtualMachineEntity.name, order: sortOperation.order.sortOrder))
            default:
                break
            }
        }

        if let limit, matchedVms.count > limit {
            matchedVms.removeLast(matchedVms.count - limit)
        }

        return matchedVms
    }

    @MainActor
    private func virtualMachines(matching comparators: [ComparatorMappingType], mode: ComparatorMode) -> [UTMVirtualMachineEntity] {
        data.virtualMachines.compactMap { vm in
            let entity = UTMVirtualMachineEntity(from: vm)
            var includeAsResult = mode == .and ? true : false
            let earlyBreakCondition = includeAsResult
            for comparator in comparators {
                guard includeAsResult == earlyBreakCondition else {
                    break
                }
                includeAsResult = comparator(entity)
            }
            return includeAsResult ? entity : nil
        }
    }
}

@available(iOS 16, macOS 13, tvOS 16, watchOS 9, *)
private extension EntityQuerySort.Ordering {
    var sortOrder: SortOrder {
        switch self {
        case .ascending:
            return SortOrder.forward
        case .descending:
            return SortOrder.reverse
        }
    }
}
