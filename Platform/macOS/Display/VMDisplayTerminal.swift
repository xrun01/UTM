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

import AppKit
import Combine
import SwiftUI

struct TerminalDimensions: Equatable {
    var cols: Int
    var rows: Int
}

enum TerminalCursorStyle {
    case blinkBlock
    case steadyBlock
}

@MainActor
protocol TerminalViewDelegate: AnyObject {
    func sizeChanged(source: TerminalView, newCols: Int, newRows: Int)
    func setTerminalTitle(source: TerminalView, title: String)
    func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?)
    func requestOpenLink(source: TerminalView, link: String, params: [String : String])
    func send(source: TerminalView, data: ArraySlice<UInt8>)
    func scrolled(source: TerminalView, position: Double)
    func clipboardCopy(source: TerminalView, content: Data)
    func rangeChanged(source: TerminalView, startY: Int, endY: Int)
}

@MainActor
class TerminalView: NSView {
    weak var terminalDelegate: (any TerminalViewDelegate)?
    var allowMouseReporting: Bool = false
    var optionAsMetaKey: Bool = false
    var font: NSFont = NSFont.monospacedSystemFont(ofSize: 12, weight: .regular)
    var nativeForegroundColor: NSColor = .textColor
    var nativeBackgroundColor: NSColor = .textBackgroundColor
    private(set) var terminalDimensions = TerminalDimensions(cols: 80, rows: 24)
    private let scrollView = NSScrollView()
    private let textView = NSTextView()

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        setupSubviews()
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        setupSubviews()
    }

    private func setupSubviews() {
        scrollView.frame = bounds
        scrollView.autoresizingMask = [.width, .height]
        scrollView.hasVerticalScroller = true
        textView.isEditable = false
        textView.isSelectable = true
        textView.font = font
        scrollView.documentView = textView
        addSubview(scrollView)
    }

    func updateUiClosed() -> Bool {
        true
    }

    func resize(cols: Int, rows: Int) {
        terminalDimensions = TerminalDimensions(cols: cols, rows: rows)
        terminalDelegate?.sizeChanged(source: self, newCols: cols, newRows: rows)
    }

    func setCursorStyle(_ style: TerminalCursorStyle) {}

    func getOptimalFrameSize() -> CGRect {
        CGRect(x: 0, y: 0, width: max(480, terminalDimensions.cols * 8), height: max(320, terminalDimensions.rows * 16))
    }

    func setUseMetal(_ useMetal: Bool) throws {}

    func feed(byteArray: ArraySlice<UInt8>) {
        if let str = String(bytes: byteArray, encoding: .utf8) {
            textView.string += str
            textView.scrollToEndOfDocument(nil)
        }
    }

    override func keyDown(with event: NSEvent) {
        if let chars = event.characters, let data = chars.data(using: .utf8) {
            let bytes = [UInt8](data)
            terminalDelegate?.send(source: self, data: bytes[...])
        }
    }
}

private let kVMDefaultResizeCmd = "stty cols $COLS rows $ROWS\\n"

@MainActor private func closeWhenIdle(_ terminalView: TerminalView) {
    guard !terminalView.updateUiClosed() else {
        return
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
        closeWhenIdle(terminalView)
    }
}

protocol VMDisplayTerminal {
    var vm: (any UTMVirtualMachine)! { get }
    var isOptionAsMetaKey: Bool { get }
    @MainActor func setupTerminal(_ terminalView: TerminalView, using config: UTMConfigurationTerminal, id: Int, for window: NSWindow)
    @MainActor func resizeCommand(for terminal: TerminalView, using config: UTMConfigurationTerminal) -> String
    func sizeChanged(id: Int, newCols: Int, newRows: Int)
    func sendString(_ string: String)
    @MainActor func enableMetalRenderer(for terminalView: TerminalView)
    @MainActor func closeTerminal(_ terminalView: TerminalView)
    @MainActor func openLink(_ link: String)
}

extension VMDisplayTerminal {
    @MainActor func setupTerminal(_ terminalView: TerminalView, using config: UTMConfigurationTerminal, id: Int, for window: NSWindow) {
        let fontSize = config.fontSize
        let fontName = config.font.rawValue
        let windowConfig = vm.registryEntry.terminalSettings[id] ?? UTMRegistryEntry.Terminal()
        if fontName != "" {
            let orig = terminalView.font
            let new = NSFont(name: fontName, size: CGFloat(fontSize)) ?? orig
            terminalView.font = new
        } else {
            let orig = terminalView.font
            let new = NSFont(descriptor: orig.fontDescriptor, size: CGFloat(fontSize)) ?? orig
            terminalView.font = new
        }
        if let consoleTextColor = config.foregroundColor,
           let textColor = Color(hexString: consoleTextColor),
           let consoleBackgroundColor = config.backgroundColor,
           let backgroundColor = Color(hexString: consoleBackgroundColor) {
            terminalView.nativeForegroundColor = NSColor(textColor)
            terminalView.nativeBackgroundColor = NSColor(backgroundColor)
        }
        if terminalView.terminalDimensions != TerminalDimensions(cols: windowConfig.columns, rows: windowConfig.rows) {
            terminalView.resize(cols: windowConfig.columns, rows: windowConfig.rows)
        }
        terminalView.setCursorStyle(config.hasCursorBlink ? .blinkBlock : .steadyBlock)
        let size = window.frameRect(forContentRect: terminalView.getOptimalFrameSize()).size
        let frame = CGRect(origin: window.frame.origin, size: size)
        window.setFrame(frame, display: false, animate: true)
        terminalView.optionAsMetaKey = isOptionAsMetaKey
    }
    
    @MainActor func resizeCommand(for terminalView: TerminalView, using config: UTMConfigurationTerminal) -> String {
        let cols = terminalView.terminalDimensions.cols
        let rows = terminalView.terminalDimensions.rows
        let template = config.resizeCommand ?? kVMDefaultResizeCmd
        let cmd = template
            .replacingOccurrences(of: "$COLS", with: String(cols))
            .replacingOccurrences(of: "$ROWS", with: String(rows))
            .replacingOccurrences(of: "\\n", with: "\n")
        return cmd
    }
    
    @MainActor func enableMetalRenderer(for terminalView: TerminalView) {
        try? terminalView.setUseMetal(true)
    }
    
    @MainActor func closeTerminal(_ terminalView: TerminalView) {
        closeWhenIdle(terminalView)
    }
    
    @MainActor func openLink(_ link: String) {
        guard let url = URL(string: link), let scheme = url.scheme?.lowercased(), ["http", "https"].contains(scheme) else {
            return
        }
        NSWorkspace.shared.open(url)
    }
    
    func sizeChanged(id: Int, newCols: Int, newRows: Int) {
        Task { @MainActor in
            let windowConfig = UTMRegistryEntry.Terminal(columns: newCols, rows: newRows)
            if let vm = vm {
                vm.registryEntry.terminalSettings[id] = windowConfig
            }
        }
    }
}
