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

import Foundation
import OSLog

let logger = UTMLogger(label: "com.utmapp.UTM")

struct UTMLogger: Sendable {
    let label: String
    private let osLogger: os.Logger

    init(label: String) {
        self.label = label
        self.osLogger = os.Logger(subsystem: label, category: "UTM")
    }

    func trace(_ message: @autoclosure () -> String) {
        #if DEBUG
        write(level: "TRACE", message: message())
        #endif
    }

    func debug(_ message: @autoclosure () -> String) {
        #if DEBUG
        let text = message()
        osLogger.debug("\(text, privacy: .public)")
        write(level: "DEBUG", message: text)
        #endif
    }

    func info(_ message: @autoclosure () -> String) {
        let text = message()
        osLogger.info("\(text, privacy: .public)")
        write(level: "INFO", message: text)
    }

    func notice(_ message: @autoclosure () -> String) {
        let text = message()
        osLogger.notice("\(text, privacy: .public)")
        write(level: "NOTICE", message: text)
    }

    func warning(_ message: @autoclosure () -> String) {
        let text = message()
        osLogger.warning("\(text, privacy: .public)")
        write(level: "WARN", message: text)
    }

    func error(_ message: @autoclosure () -> String) {
        let text = message()
        osLogger.error("\(text, privacy: .public)")
        write(level: "ERROR", message: text)
    }

    func critical(_ message: @autoclosure () -> String) {
        let text = message()
        osLogger.critical("\(text, privacy: .public)")
        write(level: "CRITICAL", message: text)
    }

    private func write(level: String, message: String) {
        UTMLogging.sharedInstance().writeLine("\(timestamp()) \(level) \(label) : \(message)\n")
    }

    private func timestamp() -> String {
        var buffer = [Int8](repeating: 0, count: 64)
        var now = time(nil)
        let localTime = localtime(&now)
        strftime(&buffer, buffer.count, "%Y-%m-%dT%H:%M:%S%z", localTime)
        return String(cString: buffer)
    }
}
