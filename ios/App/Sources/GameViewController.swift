import UIKit
import WebKit

/// Full-screen game in a WKWebView plus the JS→Swift haptic bridge ("hs"),
/// a live latency overlay, and buttons for haptics on/off, CSV export and
/// the Laya lab.
final class GameViewController: UIViewController, WKScriptMessageHandler {
    private var webView: WKWebView!
    private let haptics = HapticPlayer()
    private let log = LatencyLog()
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
        webView.load(URLRequest(url: URL(string: "app://local/game.html?probe=1")!))

        setUpOverlay()
        statsTimer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
            guard let self else { return }
            self.statsLabel.text = self.log.summary(hapticsOn: self.haptics.enabled)
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
        case "base":
            let action = body["action"] as? String ?? ""
            let issued = haptics.base()
            let done = Clock.nowMs()
            log.add(.init(
                seq: seq, kind: "base", detail: action, speed: 0, t0: nil,
                t1: (body["t1"] as? NSNumber)?.doubleValue ?? .nan,
                t2: log.toJs(received), t3: log.toJs(done),
                haptic: issued, syncRtt: log.syncRtt
            ))
        default:
            break
        }
    }

    // MARK: - Overlay

    private func setUpOverlay() {
        statsLabel.numberOfLines = 0
        statsLabel.font = .monospacedSystemFont(ofSize: 10, weight: .regular)
        statsLabel.textColor = .white
        statsLabel.backgroundColor = UIColor.black.withAlphaComponent(0.55)
        statsLabel.isUserInteractionEnabled = false

        let buttons = UIStackView(arrangedSubviews: [
            makeButton("햅틱", #selector(toggleHaptics)),
            makeButton("기록 저장", #selector(exportLog)),
            makeButton("Lab", #selector(openLab)),
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

    @objc private func toggleHaptics() {
        haptics.enabled.toggle()
    }

    @objc private func exportLog() {
        do {
            let url = try log.writeCsv()
            let sheet = UIActivityViewController(activityItems: [url], applicationActivities: nil)
            sheet.popoverPresentationController?.sourceView = view
            present(sheet, animated: true)
        } catch {
            NSLog("export failed: \(error)")
        }
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
