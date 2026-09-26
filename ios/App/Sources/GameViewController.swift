import UIKit
import WebKit

/// Full-screen game in a WKWebView plus the JS→Swift haptic bridge ("hs"),
/// a live latency overlay, and buttons for haptics on/off, CSV export and
/// the Laya lab.
final class GameViewController: UIViewController, WKScriptMessageHandler {
    private var webView: WKWebView!
    private let log = LatencyLog()
    private let recorder = UpscalerRecorder()
    private lazy var backend = CoreHapticsBackend(jsNow: { [weak self] in
        guard let self else { return .nan }
        return self.log.toJs(Clock.nowMs())
    })
    private lazy var upscaler = UpscalerPlayer(backend: backend)
    private static let gameURL = URL(string: "app://local/game.html?probe=1")!
    private static let labURL = URL(string: "app://local/game.html?lab=1")!
    private let statsLabel = UILabel()
    private var statsTimer: Timer?

    override var prefersStatusBarHidden: Bool { true }
    override var prefersHomeIndicatorAutoHidden: Bool { true }
    override var preferredScreenEdgesDeferringSystemGestures: UIRectEdge { .all }
    override var supportedInterfaceOrientations: UIInterfaceOrientationMask { .landscape }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black

        let config = WKWebViewConfiguration()
        let webRoot = Bundle.main.bundleURL.appendingPathComponent("web")
        config.setURLSchemeHandler(BundleSchemeHandler(root: webRoot), forURLScheme: BundleSchemeHandler.scheme)
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        config.userContentController.add(WeakHandler(self), name: "hs")
        // No text selection, callouts or magnifier while swiping.
        let css = "*{-webkit-user-select:none;-webkit-touch-callout:none}html,body{overscroll-behavior:none}"
        let script = "var s=document.createElement('style');s.textContent='\(css)';document.documentElement.appendChild(s);"
        config.userContentController.addUserScript(
            WKUserScript(source: script, injectionTime: .atDocumentEnd, forMainFrameOnly: true)
        )

        webView = WKWebView(frame: view.bounds, configuration: config)
        webView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        webView.scrollView.isScrollEnabled = false
        webView.scrollView.bounces = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.isOpaque = false
        webView.backgroundColor = .black
        webView.isInspectable = true
        view.addSubview(webView)
        webView.load(URLRequest(url: Self.gameURL))

        backend.log = { NSLog("haptics: %@", $0) }
        upscaler.log = { NSLog("upscaler: %@", $0) }
        backend.onReset = { [weak self] in self?.upscaler.reset() }

        setUpOverlay()
        statsTimer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
            guard let self else { return }
            self.statsLabel.text = self.log.summary(hapticsOn: self.upscaler.mode != .off)
        }
    }

    // MARK: - Bridge

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        let received = Clock.nowMs()
        guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
        let seq = (body["seq"] as? NSNumber)?.intValue ?? 0

        switch type {
        case "ping":
            let sentAt = (body["t"] as? NSNumber)?.doubleValue ?? 0
            webView.evaluateJavaScript("window.__hsPong&&window.__hsPong(\(sentAt),\(received))")
        case "sync":
            let offset = (body["offset"] as? NSNumber)?.doubleValue ?? 0
            let rtt = (body["rtt"] as? NSNumber)?.doubleValue ?? .nan
            log.sync(offset: offset, rtt: rtt)
        case "contact":
            let phase = body["phase"] as? String ?? ""
            let zone = body["zone"] as? String ?? ""
            let speed = (body["speed"] as? NSNumber)?.doubleValue ?? 0
            // Logged only: blade contact is input for the upscaler, not base vibration.
            let done = Clock.nowMs()
            log.add(.init(
                seq: seq, kind: "contact", detail: "\(phase):\(zone)", speed: speed,
                t0: (body["t0"] as? NSNumber)?.doubleValue,
                t1: (body["t1"] as? NSNumber)?.doubleValue ?? .nan,
                t2: log.toJs(received), t3: log.toJs(done),
                haptic: false, syncRtt: log.syncRtt
            ))
        case "sfx":
            let key = body["key"] as? String ?? ""
            let done = Clock.nowMs()
            log.add(.init(
                seq: seq, kind: "sfx", detail: key, speed: 0, t0: nil,
                t1: (body["t1"] as? NSNumber)?.doubleValue ?? .nan,
                t2: log.toJs(received), t3: log.toJs(done),
                haptic: false, syncRtt: log.syncRtt
            ))
        case "signal":
            // Upscaler input, kept whole for real-play fixtures.
            recorder.add(body, receivedAt: log.toJs(received))
            let signal = body["signal"] as? [String: Any] ?? [:]
            let kind = signal["kind"] as? String ?? "?"
            let chain = signal["chain"] as? [String: Any]
            let step = chain.flatMap { $0["step"] as? String } ?? "-"
            let what = signal["outcome"] as? String ?? signal["phase"] as? String
                ?? signal["clock"] as? String ?? signal["id"] as? String ?? ""
            let done = Clock.nowMs()
            log.add(.init(
                seq: seq, kind: "signal", detail: "\(kind):\(what):\(step)", speed: 0, t0: nil,
                t1: (body["t1"] as? NSNumber)?.doubleValue ?? .nan,
                t2: log.toJs(received), t3: log.toJs(done),
                haptic: false, syncRtt: log.syncRtt
            ))
        case "base":
            // Logged only: the base itself arrives as an upscaler command.
            let action = body["action"] as? String ?? ""
            let issued = false
            let done = Clock.nowMs()
            log.add(.init(
                seq: seq, kind: "base", detail: action, speed: 0, t0: nil,
                t1: (body["t1"] as? NSNumber)?.doubleValue ?? .nan,
                t2: log.toJs(received), t3: log.toJs(done),
                haptic: issued, syncRtt: log.syncRtt
            ))
        case "upscaler":
            recorder.add(body, receivedAt: log.toJs(received))
            let raw = body["commands"] as? [Any] ?? []
            var ops: [String] = []
            for item in raw {
                do {
                    let command = try UpscalerCommand.from(message: item)
                    upscaler.apply(command)
                    ops.append(command.op)
                } catch {
                    NSLog("upscaler: undecodable command \(error)")
                }
            }
            let done = Clock.nowMs()
            log.add(.init(
                seq: seq, kind: "upscaler", detail: ops.joined(separator: "+"), speed: 0, t0: nil,
                t1: (body["t1"] as? NSNumber)?.doubleValue ?? .nan,
                t2: log.toJs(received), t3: log.toJs(done),
                haptic: !ops.isEmpty, syncRtt: log.syncRtt
            ))
        case "labSet":
            if let fade = (body["reviseFadeMs"] as? NSNumber)?.doubleValue { UpscalerPlayer.reviseFadeMs = fade }
            if let loop = (body["holdLoopSeconds"] as? NSNumber)?.doubleValue { CoreHapticsBackend.holdSegmentSeconds = loop }
        case "labProbe":
            let name = body["probe"] as? String ?? ""
            let result = backend.probe(name)
            let json = (try? JSONSerialization.data(withJSONObject: result))
                .flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
            webView.evaluateJavaScript("window.__hsLabResult&&window.__hsLabResult(\(Self.quoted(name)),\(json))")
        case "labSave":
            let name = (body["name"] as? String ?? "lab").filter { $0.isLetter || $0.isNumber || $0 == "-" }
            let text = body["json"] as? String ?? "{}"
            let url = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
                .appendingPathComponent("lab-\(name)-\(Self.stamp()).json")
            do {
                try text.write(to: url, atomically: true, encoding: .utf8)
                share([url])
            } catch {
                NSLog("lab save failed: \(error)")
            }
        case "labExit":
            UpscalerPlayer.reviseFadeMs = 8
            CoreHapticsBackend.holdSegmentSeconds = 30
            webView.load(URLRequest(url: Self.gameURL))
        default:
            break
        }
    }

    private static func quoted(_ s: String) -> String {
        let data = (try? JSONSerialization.data(withJSONObject: [s])) ?? Data("[\"\"]".utf8)
        let array = String(data: data, encoding: .utf8) ?? "[\"\"]"
        return String(array.dropFirst().dropLast())
    }

    private static func stamp() -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyyMMdd-HHmmss"
        return formatter.string(from: Date())
    }

    private func share(_ urls: [URL]) {
        let sheet = UIActivityViewController(activityItems: urls, applicationActivities: nil)
        sheet.popoverPresentationController?.sourceView = view
        present(sheet, animated: true)
    }

    // MARK: - Overlay

    private func setUpOverlay() {
        statsLabel.numberOfLines = 0
        statsLabel.font = .monospacedSystemFont(ofSize: 10, weight: .regular)
        statsLabel.textColor = .white
        statsLabel.backgroundColor = UIColor.black.withAlphaComponent(0.55)
        statsLabel.isUserInteractionEnabled = false

        let buttons = UIStackView(arrangedSubviews: [
            makeButton("햅틱: \(UpscalerPlayer.Mode.full.rawValue)", #selector(toggleHaptics)),
            makeButton("기록 저장", #selector(exportLog)),
            makeButton("Lab", #selector(openLab)),
            makeButton("업스케일 Lab", #selector(openUpscalerLab)),
        ])
        buttons.axis = .horizontal
        buttons.spacing = 6

        let stack = UIStackView(arrangedSubviews: [statsLabel, buttons])
        stack.axis = .vertical
        stack.alignment = .trailing
        stack.spacing = 4
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 4),
            stack.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -4),
        ])
    }

    private func makeButton(_ title: String, _ action: Selector) -> UIButton {
        var config = UIButton.Configuration.filled()
        config.title = title
        config.baseBackgroundColor = UIColor.black.withAlphaComponent(0.55)
        config.baseForegroundColor = .white
        config.buttonSize = .mini
        let button = UIButton(configuration: config)
        button.addTarget(self, action: action, for: .touchUpInside)
        return button
    }

    /// Cycles 기본+업스케일 → 기본만 → 끔 for side-by-side comparison.
    @objc private func toggleHaptics(_ sender: UIButton) {
        let all = UpscalerPlayer.Mode.allCases
        let next = all[(all.firstIndex(of: upscaler.mode)! + 1) % all.count]
        upscaler.setMode(next)
        sender.configuration?.title = "햅틱: \(next.rawValue)"
    }

    @objc private func exportLog() {
        do {
            var urls = [try log.writeCsv()]
            if !recorder.isEmpty { urls.append(try recorder.write(stamp: Self.stamp())) }
            share(urls)
        } catch {
            NSLog("export failed: \(error)")
        }
    }

    @objc private func openUpscalerLab() {
        webView.load(URLRequest(url: Self.labURL))
    }

    @objc private func openLab() {
        let lab = LabViewController()
        lab.modalPresentationStyle = .fullScreen
        present(lab, animated: true)
    }
}

/// Breaks the WKUserContentController → handler retain cycle.
private final class WeakHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?
    init(_ target: WKScriptMessageHandler) { self.target = target }
    func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
        target?.userContentController(c, didReceive: m)
    }
}
