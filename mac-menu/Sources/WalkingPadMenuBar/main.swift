@preconcurrency import AppKit
@preconcurrency import Foundation

private let defaultSocketURL = "ws://raspberrypi.local:8788/ws"
private let defaultDashboardURL = "http://raspberrypi.local:8788/"
private let preferredSymbolNames = ["figure.walk.treadmill", "figure.walk"]

@main
@MainActor
final class WalkingPadMenuApp: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private let menu = NSMenu()
    private let stepsItem = NSMenuItem(title: "Steps: --", action: nil, keyEquivalent: "")
    private let connectionItem = NSMenuItem(title: "Disconnected", action: nil, keyEquivalent: "")
    private let updatedItem = NSMenuItem(title: "Last update: never", action: nil, keyEquivalent: "")
    private let urlItem = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    private let dashboardItem = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    private var client: StepWebSocketClient?
    private var currentSteps: Int?
    private var lastUpdate: Date?
    private var connectionState = "Disconnected"

    static func main() {
        let app = NSApplication.shared
        let delegate = WalkingPadMenuApp()
        app.delegate = delegate
        app.setActivationPolicy(.accessory)
        app.run()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        configureMenu()
        setTitle(steps: nil)
        connect()
    }

    private func configureMenu() {
        stepsItem.isEnabled = false
        connectionItem.isEnabled = false
        updatedItem.isEnabled = false
        urlItem.isEnabled = false
        dashboardItem.isEnabled = false

        let openItem = NSMenuItem(
            title: "Open WalkingPad",
            action: #selector(openDashboard),
            keyEquivalent: "o"
        )
        openItem.target = self

        let reconnectItem = NSMenuItem(
            title: "Reconnect",
            action: #selector(reconnect),
            keyEquivalent: "r"
        )
        reconnectItem.target = self

        let quitItem = NSMenuItem(
            title: "Quit",
            action: #selector(quit),
            keyEquivalent: "q"
        )
        quitItem.target = self

        menu.delegate = self
        menu.addItem(stepsItem)
        menu.addItem(connectionItem)
        menu.addItem(updatedItem)
        menu.addItem(urlItem)
        menu.addItem(dashboardItem)
        menu.addItem(.separator())
        menu.addItem(openItem)
        menu.addItem(reconnectItem)
        menu.addItem(.separator())
        menu.addItem(quitItem)

        statusItem.menu = menu
        statusItem.button?.toolTip = "WalkingPad daily steps"
        statusItem.button?.image = Self.statusImage()
        statusItem.button?.imagePosition = .imageLeading
    }

    private func connect() {
        let urlString = Self.configuredString(
            environmentKey: "WALKINGPAD_MENU_WS_URL",
            defaultsKey: "websocketURL",
            fallback: defaultSocketURL
        )
        guard let url = URL(string: urlString) else {
            updateConnection("Bad URL")
            return
        }

        client?.stop()
        client = StepWebSocketClient(url: url)
        client?.onConnectionChange = { [weak self] state in
            self?.updateConnection(state)
        }
        client?.onSteps = { [weak self] steps in
            self?.currentSteps = steps
            self?.lastUpdate = Date()
            self?.setTitle(steps: steps)
            self?.refreshMenuItems()
        }
        client?.start()
        refreshMenuItems()
    }

    private func setTitle(steps: Int?) {
        let title: String
        if let steps {
            title = NumberFormatter.localizedString(from: NSNumber(value: steps), number: .decimal)
        } else {
            title = "--"
        }
        statusItem.button?.title = title
    }

    private func updateConnection(_ state: String) {
        connectionState = state
        refreshMenuItems()
    }

    func menuWillOpen(_ menu: NSMenu) {
        refreshMenuItems()
    }

    private func refreshMenuItems() {
        let stepsText = currentSteps.map {
            NumberFormatter.localizedString(from: NSNumber(value: $0), number: .decimal)
        } ?? "--"
        stepsItem.title = "Steps: \(stepsText)"
        connectionItem.title = connectionState

        if let lastUpdate {
            updatedItem.title = "Last update: \(Self.timeFormatter.string(from: lastUpdate))"
        } else {
            updatedItem.title = "Last update: never"
        }

        urlItem.title = "Socket: \(Self.configuredSocketURLString())"
        dashboardItem.title = "Open: \(Self.configuredDashboardURL().absoluteString)"
    }

    @objc private func reconnect() {
        connect()
    }

    @objc private func openDashboard() {
        NSWorkspace.shared.open(Self.configuredDashboardURL())
    }

    @objc private func quit() {
        client?.stop()
        NSApplication.shared.terminate(nil)
    }

    private static let timeFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.timeStyle = .medium
        formatter.dateStyle = .none
        return formatter
    }()

    private static func statusImage() -> NSImage? {
        for symbolName in preferredSymbolNames {
            if let image = NSImage(systemSymbolName: symbolName, accessibilityDescription: "WalkingPad") {
                image.isTemplate = true
                return image
            }
        }

        return nil
    }

    private static func configuredSocketURLString() -> String {
        configuredString(
            environmentKey: "WALKINGPAD_MENU_WS_URL",
            defaultsKey: "websocketURL",
            fallback: defaultSocketURL
        )
    }

    private static func configuredDashboardURL() -> URL {
        let configured = configuredString(
            environmentKey: "WALKINGPAD_MENU_DASHBOARD_URL",
            defaultsKey: "dashboardURL",
            fallback: ""
        )

        if !configured.isEmpty, let url = URL(string: configured) {
            return url
        }

        if let url = dashboardURL(fromSocketURLString: configuredSocketURLString()) {
            return url
        }

        return URL(string: defaultDashboardURL)!
    }

    private static func configuredString(environmentKey: String, defaultsKey: String, fallback: String) -> String {
        let environment = ProcessInfo.processInfo.environment
        if let value = environment[environmentKey], !value.isEmpty {
            return value
        }

        if let value = UserDefaults.standard.string(forKey: defaultsKey), !value.isEmpty {
            return value
        }

        return fallback
    }

    private static func dashboardURL(fromSocketURLString socketURLString: String) -> URL? {
        guard let socketURL = URL(string: socketURLString),
              var components = URLComponents(url: socketURL, resolvingAgainstBaseURL: false) else {
            return nil
        }

        if components.scheme == "ws" {
            components.scheme = "http"
        } else if components.scheme == "wss" {
            components.scheme = "https"
        }

        components.path = "/"
        components.query = nil
        components.fragment = nil
        return components.url
    }
}

@MainActor
private final class StepWebSocketClient {
    var onSteps: ((Int) -> Void)?
    var onConnectionChange: ((String) -> Void)?

    private let url: URL
    private var session: URLSession?
    private var task: URLSessionWebSocketTask?
    private var reconnectTimer: Timer?
    private var reconnectDelay: TimeInterval = 1
    private var stopped = false

    init(url: URL) {
        self.url = url
    }

    func start() {
        stopped = false
        reconnectTimer?.invalidate()
        onConnectionChange?("Connecting")

        let session = URLSession(configuration: .ephemeral)
        let task = session.webSocketTask(with: url)
        self.session = session
        self.task = task
        task.resume()
        receiveNext()
    }

    func stop() {
        stopped = true
        reconnectTimer?.invalidate()
        reconnectTimer = nil
        task?.cancel(with: .goingAway, reason: nil)
        session?.invalidateAndCancel()
        task = nil
        session = nil
    }

    private func receiveNext() {
        task?.receive { [weak self] result in
            Task { @MainActor in
                self?.handle(result)
            }
        }
    }

    private func handle(_ result: Result<URLSessionWebSocketTask.Message, Error>) {
        guard !stopped else {
            return
        }

        switch result {
        case .success(let message):
            reconnectDelay = 1
            onConnectionChange?("Connected")
            if let text = Self.text(from: message), let steps = StepMessageParser.steps(from: text) {
                onSteps?(steps)
            }
            receiveNext()

        case .failure:
            onConnectionChange?("Disconnected")
            scheduleReconnect()
        }
    }

    private func scheduleReconnect() {
        guard !stopped else {
            return
        }

        task?.cancel(with: .goingAway, reason: nil)
        session?.invalidateAndCancel()
        task = nil
        session = nil

        let delay = reconnectDelay
        reconnectDelay = min(reconnectDelay * 1.8, 20)
        reconnectTimer?.invalidate()
        reconnectTimer = Timer.scheduledTimer(withTimeInterval: delay, repeats: false) { [weak self] _ in
            Task { @MainActor in
                self?.start()
            }
        }
    }

    private static func text(from message: URLSessionWebSocketTask.Message) -> String? {
        switch message {
        case .string(let text):
            return text
        case .data(let data):
            return String(data: data, encoding: .utf8)
        @unknown default:
            return nil
        }
    }
}

private enum StepMessageParser {
    static func steps(from text: String) -> Int? {
        guard let data = text.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data),
              let dictionary = json as? [String: Any] else {
            return nil
        }

        return directSteps(in: dictionary)
            ?? statusSteps(in: dictionary)
            ?? snapshotSteps(in: dictionary)
            ?? recursiveSteps(in: dictionary)
    }

    private static func directSteps(in dictionary: [String: Any]) -> Int? {
        integer(dictionary["dailySteps"])
            ?? integer(dictionary["steps"])
            ?? integer(dictionary["sessionSteps"])
    }

    private static func statusSteps(in dictionary: [String: Any]) -> Int? {
        guard let status = dictionary["status"] as? [String: Any] else {
            return nil
        }

        return directSteps(in: status)
            ?? integer(status["dailySteps"])
            ?? integer(status["steps"])
    }

    private static func snapshotSteps(in dictionary: [String: Any]) -> Int? {
        guard dictionary["type"] as? String == "snapshot",
              let state = dictionary["state"] as? [String: Any],
              let values = state["values"] as? [[String: Any]] else {
            return nil
        }

        let preferredIds = ["2acd", "vendorNotify"]
        for id in preferredIds {
            if let steps = values.compactMap({ value -> Int? in
                guard value["id"] as? String == id,
                      let parsed = value["parsed"] as? [String: Any] else {
                    return nil
                }
                return integer(parsed["steps"])
            }).last {
                return steps
            }
        }

        return values.compactMap { value -> Int? in
            guard let parsed = value["parsed"] as? [String: Any] else {
                return nil
            }
            return integer(parsed["steps"])
        }.last
    }

    private static func recursiveSteps(in value: Any) -> Int? {
        if let dictionary = value as? [String: Any] {
            if let steps = integer(dictionary["dailySteps"]) ?? integer(dictionary["steps"]) {
                return steps
            }
            for child in dictionary.values {
                if let steps = recursiveSteps(in: child) {
                    return steps
                }
            }
        }

        if let array = value as? [Any] {
            for child in array {
                if let steps = recursiveSteps(in: child) {
                    return steps
                }
            }
        }

        return nil
    }

    private static func integer(_ value: Any?) -> Int? {
        switch value {
        case let number as NSNumber:
            return number.intValue
        case let string as String:
            return Int(string)
        default:
            return nil
        }
    }
}
