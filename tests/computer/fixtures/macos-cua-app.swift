import AppKit
import Darwin

// Compile with swiftc, then run with a unique window title and an absolute JSON state path.
final class FlippedView: NSView {
    override var isFlipped: Bool { true }
}

final class ScrollProbe: NSScrollView {
    var wheelEvents = 0
    var lastDelta = NSPoint.zero
    var onChange: (() -> Void)?

    override func scrollWheel(with event: NSEvent) {
        wheelEvents += 1
        lastDelta = NSPoint(x: event.scrollingDeltaX, y: event.scrollingDeltaY)
        super.scrollWheel(with: event)
        onChange?()
    }
}

final class InputProbe: NSTextView {
    var mouseDowns = 0
    var onChange: (() -> Void)?

    override func mouseDown(with event: NSEvent) {
        mouseDowns += 1
        super.mouseDown(with: event)
        onChange?()
    }
}

final class DragProbe: NSView {
    override var isFlipped: Bool { true }
    var block = NSRect(x: 24, y: 30, width: 64, height: 64)
    let target = NSRect(x: 220, y: 180, width: 64, height: 64)
    var downs = 0
    var moves = 0
    var ups = 0
    var dragging = false
    var onChange: (() -> Void)?
    private var grabOffset = NSPoint.zero

    override func draw(_ dirtyRect: NSRect) {
        NSColor.windowBackgroundColor.setFill()
        NSBezierPath(rect: bounds).fill()
        NSColor.separatorColor.setStroke()
        NSBezierPath(rect: bounds.insetBy(dx: 1, dy: 1)).stroke()
        NSColor.systemGreen.withAlphaComponent(0.25).setFill()
        NSBezierPath(roundedRect: target, xRadius: 8, yRadius: 8).fill()
        NSColor.systemGreen.setStroke()
        NSBezierPath(roundedRect: target, xRadius: 8, yRadius: 8).stroke()
        NSColor.systemBlue.setFill()
        NSBezierPath(roundedRect: block, xRadius: 8, yRadius: 8).fill()
        ("DRAG" as NSString).draw(at: NSPoint(x: block.minX + 12, y: block.minY + 24),
                                  withAttributes: [.font: NSFont.boldSystemFont(ofSize: 12),
                                                   .foregroundColor: NSColor.white])
    }

    override func mouseDown(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        guard block.contains(point) else { return }
        dragging = true
        downs += 1
        grabOffset = NSPoint(x: point.x - block.minX, y: point.y - block.minY)
        onChange?()
    }

    override func mouseDragged(with event: NSEvent) {
        guard dragging else { return }
        let point = convert(event.locationInWindow, from: nil)
        moves += 1
        block.origin = NSPoint(x: min(max(0, point.x - grabOffset.x), bounds.width - block.width),
                               y: min(max(0, point.y - grabOffset.y), bounds.height - block.height))
        needsDisplay = true
        onChange?()
    }

    override func mouseUp(with event: NSEvent) {
        guard dragging else { return }
        dragging = false
        ups += 1
        onChange?()
    }
}

final class Fixture: NSObject, NSApplicationDelegate, NSWindowDelegate, NSTextViewDelegate {
    struct MoveCommand: Decodable {
        let id: String
        let action: String
        let window: String
        let x: Double
        let y: Double
    }

    let title: String
    let stateURL: URL
    let commandURL: URL?
    var primary: NSWindow!
    var secondary: NSWindow!
    var button: NSButton!
    var secondaryButton: NSButton!
    var input: InputProbe!
    var inputScroll: NSScrollView!
    var scroll: ScrollProbe!
    var drag: DragProbe!
    var clicks = 0
    var secondaryClicks = 0
    var textChanges = 0
    var focusChanges = 0
    var timer: Timer?
    var signalSources: [DispatchSourceSignal] = []
    var sequence = 0
    var ready = false
    var closed = false
    var lastCommandData: Data?
    var commandAck: [String: Any]?

    init(title: String, stateURL: URL, commandURL: URL? = nil) {
        self.title = title
        self.stateURL = stateURL
        self.commandURL = commandURL
    }

    func label(_ value: String, frame: NSRect, parent: NSView) {
        let label = NSTextField(labelWithString: value)
        label.frame = frame
        parent.addSubview(label)
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        primary = NSWindow(contentRect: NSRect(x: 100, y: 100, width: 720, height: 600),
                           styleMask: [.titled, .closable, .miniaturizable],
                           backing: .buffered, defer: false)
        primary.title = title
        primary.delegate = self
        primary.isReleasedWhenClosed = false
        primary.center()
        let content = primary.contentView!
        label("CUA native desktop probe", frame: NSRect(x: 24, y: 552, width: 650, height: 24), parent: content)

        button = NSButton(title: "Click counter: 0", target: self, action: #selector(click))
        button.frame = NSRect(x: 24, y: 504, width: 220, height: 36)
        button.bezelStyle = .rounded
        content.addSubview(button)
        inputScroll = NSScrollView(frame: NSRect(x: 24, y: 446, width: 672, height: 52))
        inputScroll.borderType = .bezelBorder
        inputScroll.hasVerticalScroller = true
        input = InputProbe(frame: NSRect(origin: .zero, size: inputScroll.contentSize))
        input.font = NSFont.systemFont(ofSize: 14)
        input.isRichText = false
        input.isAutomaticQuoteSubstitutionEnabled = false
        input.isAutomaticDashSubstitutionEnabled = false
        input.isAutomaticTextReplacementEnabled = false
        input.isContinuousSpellCheckingEnabled = false
        input.smartInsertDeleteEnabled = false
        input.isVerticallyResizable = true
        input.isHorizontallyResizable = false
        input.autoresizingMask = [.width]
        input.minSize = NSSize(width: 0, height: inputScroll.contentSize.height)
        input.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        input.textContainer?.widthTracksTextView = true
        input.textContainer?.containerSize = NSSize(width: inputScroll.contentSize.width,
                                                   height: CGFloat.greatestFiniteMagnitude)
        input.textContainerInset = NSSize(width: 6, height: 6)
        input.delegate = self
        input.onChange = { [weak self] in self?.writeState() }
        inputScroll.documentView = input
        content.addSubview(inputScroll)

        label("Scroll inside the left panel", frame: NSRect(x: 24, y: 414, width: 320, height: 24), parent: content)
        label("Drag blue block onto green target", frame: NSRect(x: 376, y: 414, width: 320, height: 24), parent: content)
        scroll = ScrollProbe(frame: NSRect(x: 24, y: 112, width: 320, height: 288))
        scroll.hasVerticalScroller = true
        scroll.borderType = .bezelBorder
        let document = FlippedView(frame: NSRect(x: 0, y: 0, width: 300, height: 2200))
        for index in 0..<60 {
            label("Scroll row \(index + 1)", frame: NSRect(x: 16, y: 12 + index * 36, width: 260, height: 24), parent: document)
        }
        scroll.documentView = document
        scroll.onChange = { [weak self] in self?.writeState() }
        content.addSubview(scroll)

        drag = DragProbe(frame: NSRect(x: 376, y: 112, width: 320, height: 288))
        drag.onChange = { [weak self] in self?.writeState() }
        content.addSubview(drag)
        label("State is recorded as JSON. Close this window to quit.",
              frame: NSRect(x: 24, y: 52, width: 672, height: 28), parent: content)

        secondary = NSWindow(contentRect: NSRect(x: primary.frame.maxX + 16, y: primary.frame.minY,
                                                 width: 300, height: 180),
                             styleMask: [.titled, .closable], backing: .buffered, defer: false)
        secondary.title = title + " - Focus Probe"
        secondary.delegate = self
        secondary.isReleasedWhenClosed = false
        label("Secondary focus target", frame: NSRect(x: 24, y: 90, width: 260, height: 28),
              parent: secondary.contentView!)
        secondaryButton = NSButton(title: "Secondary clicks: 0", target: self, action: #selector(clickSecondary))
        secondaryButton.frame = NSRect(x: 24, y: 40, width: 252, height: 36)
        secondaryButton.bezelStyle = .rounded
        secondary.contentView!.addSubview(secondaryButton)
        secondary.orderFront(nil)
        primary.makeKeyAndOrderFront(nil)
        NSApplication.shared.activate(ignoringOtherApps: true)

        for code in [SIGTERM, SIGINT] {
            signal(code, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: code, queue: .main)
            source.setEventHandler { NSApplication.shared.terminate(nil) }
            source.resume()
            signalSources.append(source)
        }
        ready = true
        timer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
            self?.pollCommand()
            self?.writeState()
        }
        writeState()
        print("{\"ready\":true,\"pid\":\(ProcessInfo.processInfo.processIdentifier),\"windowId\":\(primary.windowNumber)}")
        fflush(stdout)
    }

    @objc func click() {
        clicks += 1
        button.title = "Click counter: \(clicks)"
        writeState()
    }

    @objc func clickSecondary() {
        secondaryClicks += 1
        secondaryButton.title = "Secondary clicks: \(secondaryClicks)"
        writeState()
    }

    func pollCommand() {
        guard !closed, let commandURL,
              let data = try? Data(contentsOf: commandURL), data != lastCommandData else { return }
        lastCommandData = data
        let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        let id = object?["id"] as? String
        do {
            let command = try JSONDecoder().decode(MoveCommand.self, from: data)
            guard !command.id.isEmpty, command.action == "move", command.x.isFinite, command.y.isFinite else {
                commandAck = ["id": command.id, "ok": false, "error": "Expected a nonempty id, move action, and finite x/y."]
                return
            }
            let window: NSWindow
            switch command.window {
            case "primary": window = primary
            case "secondary": window = secondary
            default:
                commandAck = ["id": command.id, "ok": false, "error": "The target must be primary or secondary."]
                return
            }
            guard window.isVisible, let screen = NSScreen.screens.first else {
                commandAck = ["id": command.id, "ok": false, "error": "The fixture window or primary screen is unavailable."]
                return
            }
            window.setFrameOrigin(NSPoint(x: command.x, y: screen.frame.maxY - command.y - window.frame.height))
            commandAck = ["id": command.id, "ok": true]
        } catch {
            commandAck = ["id": id as Any? ?? NSNull(), "ok": false, "error": "Invalid move command: \(error.localizedDescription)"]
        }
    }

    func textDidChange(_ notification: Notification) {
        textChanges += 1
        writeState()
    }

    func windowDidBecomeKey(_ notification: Notification) {
        focusChanges += 1
        writeState()
    }

    func windowWillClose(_ notification: Notification) {
        if let window = notification.object as? NSWindow, window === primary {
            NSApplication.shared.terminate(nil)
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        closed = true
        timer?.invalidate()
        writeState()
        signalSources.forEach { $0.cancel() }
    }

    func rect(_ screenRect: NSRect) -> [String: Double] {
        let top = NSScreen.screens.first?.frame.maxY ?? 0
        let y = top - screenRect.maxY
        return ["x": screenRect.minX, "y": y, "width": screenRect.width, "height": screenRect.height,
                "centerX": screenRect.midX, "centerY": y + screenRect.height / 2]
    }

    func screenRect(_ view: NSView, localRect: NSRect? = nil) -> [String: Double] {
        rect(view.window!.convertToScreen(view.convert(localRect ?? view.bounds, to: nil)))
    }

    func windowState(_ window: NSWindow) -> [String: Any] {
        ["id": window.windowNumber, "title": window.title, "key": window.isKeyWindow,
         "main": window.isMainWindow, "visible": window.isVisible, "frame": rect(window.frame),
         "backingScale": window.backingScaleFactor]
    }

    func writeState() {
        guard ready else { return }
        sequence += 1
        var state: [String: Any] = [
            "ready": true, "closed": closed, "pid": ProcessInfo.processInfo.processIdentifier,
            "sequence": sequence, "updatedAtMs": Int64(Date().timeIntervalSince1970 * 1000),
            "active": NSApplication.shared.isActive,
            "frontmost": NSWorkspace.shared.frontmostApplication?.processIdentifier == ProcessInfo.processInfo.processIdentifier,
            "keyWindowId": NSApplication.shared.keyWindow?.windowNumber ?? -1,
            "focusChanges": focusChanges,
            "coordinateSpace": "global-screen-points-top-left",
            "primary": windowState(primary), "secondary": windowState(secondary),
            "button": ["rect": screenRect(button), "clicks": clicks],
            "secondaryButton": ["rect": screenRect(secondaryButton), "clicks": secondaryClicks],
            "input": ["rect": screenRect(inputScroll), "value": input.string, "changes": textChanges,
                      "mouseDowns": input.mouseDowns, "focused": primary.firstResponder === input],
            "scroll": ["rect": screenRect(scroll), "offsetX": scroll.contentView.bounds.origin.x,
                       "offsetY": scroll.contentView.bounds.origin.y, "wheelEvents": scroll.wheelEvents,
                       "lastDeltaX": scroll.lastDelta.x, "lastDeltaY": scroll.lastDelta.y],
            "drag": ["rect": screenRect(drag), "block": screenRect(drag, localRect: drag.block),
                     "target": screenRect(drag, localRect: drag.target), "downs": drag.downs,
                     "moves": drag.moves, "ups": drag.ups, "dragging": drag.dragging]
        ]
        if let commandAck { state["command"] = commandAck }
        do {
            let data = try JSONSerialization.data(withJSONObject: state, options: [.sortedKeys, .prettyPrinted])
            try data.write(to: stateURL, options: .atomic)
        } catch {
            fputs("CUA fixture could not write its state: \(error.localizedDescription)\n", stderr)
            ready = false
            NSApplication.shared.terminate(nil)
        }
    }
}

guard (3...4).contains(CommandLine.arguments.count) else {
    fputs("Usage: macos-cua-app <unique-window-title> <absolute-state-json-path> [absolute-command-json-path]\n", stderr)
    exit(2)
}
guard CommandLine.arguments[2].hasPrefix("/") else {
    fputs("The state path must be absolute.\n", stderr)
    exit(2)
}
let commandPath = CommandLine.arguments.count == 4 ? CommandLine.arguments[3] : nil
guard commandPath == nil || commandPath!.hasPrefix("/") else {
    fputs("The command path must be absolute.\n", stderr)
    exit(2)
}
let app = NSApplication.shared
let fixture = Fixture(title: CommandLine.arguments[1], stateURL: URL(fileURLWithPath: CommandLine.arguments[2]),
                      commandURL: commandPath.map { URL(fileURLWithPath: $0) })
app.setActivationPolicy(.regular)
app.delegate = fixture
app.run()
