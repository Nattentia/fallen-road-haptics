import CoreHaptics

/// Core Haptics implementation of HapticBackend. One pre-started engine;
/// every score and hold gets its own advanced player, so a curve in one score
/// never reshapes another. JS clock times become engine times through the
/// distance from "now", which keeps both clocks' offsets out of the math.
final class CoreHapticsBackend: HapticBackend {
    /// Carrier event for holds; drive values reach it through dynamic controls
    /// (intensity multiplies 1, sharpness adds to this centre).
    private static let holdSharpnessCentre: Double = 0.5
    /// Length of the looped carrier under a hold (the Core Haptics maximum).
    /// The Lab shortens it to make the loop seam easy to judge.
    static var holdSegmentSeconds: TimeInterval = 30

    private var engine: CHHapticEngine?
    private var players: [Int: CHHapticAdvancedPatternPlayer] = [:]
    private var holdLevels: [Int: (intensity: Double, sharpness: Double)] = [:]
    /// Scores by handle, so a fade can start from the level the score's own
    /// intensity curve has reached.
    private var scores: [Int: Score] = [:]
    /// Set when the system stopped the engine; the next call restarts it.
    private var needsStart = false
    private var basePlayer: CHHapticPatternPlayer?
    private var nextHandle = 1
    private let jsNow: () -> Double
    /// Called after the engine restarted and every player was lost.
    var onReset: () -> Void = {}
    var log: (String) -> Void = { _ in }

    init(jsNow: @escaping () -> Double) {
        self.jsNow = jsNow
        startEngine()
    }

    var nowMs: Double { jsNow() }
    var isAvailable: Bool { engine != nil }
    fileprivate var engineForProbe: CHHapticEngine? { engine }

    // MARK: - Engine

    private func startEngine() {
        guard CHHapticEngine.capabilitiesForHardware().supportsHaptics else { return }
        do {
            let engine = try CHHapticEngine()
            engine.playsHapticsOnly = true
            engine.isAutoShutdownEnabled = false
            // Core Haptics calls these on its own queue; all state lives on main.
            engine.resetHandler = { [weak self] in
                DispatchQueue.main.async {
                    guard let self else { return }
                    self.forgetPlayers()
                    try? self.engine?.start()
                    self.onReset()
                }
            }
            engine.stoppedHandler = { [weak self] reason in
                DispatchQueue.main.async {
                    guard let self else { return }
                    self.log("engine stopped: \(reason.rawValue)")
                    self.forgetPlayers()
                    self.needsStart = true
                    self.onReset()
                }
            }
            try engine.start()
            self.engine = engine
        } catch {
            log("engine start failed: \(error)")
        }
    }

    private func forgetPlayers() {
        players.removeAll()
        holdLevels.removeAll()
        scores.removeAll()
        basePlayer = nil
    }

    /// Restarts an engine the system stopped (app switch, interruption).
    private func ensureRunning() -> CHHapticEngine? {
        guard let engine else { return nil }
        if needsStart {
            do {
                try engine.start()
                needsStart = false
            } catch {
                log("engine restart failed: \(error)")
                return nil
            }
        }
        return engine
    }

    /// Engine time for a JS clock time; the past maps to "now".
    private func engineTime(_ atMs: Double) -> TimeInterval {
        guard let engine else { return CHHapticTimeImmediate }
        let delay = max(0, atMs - nowMs) / 1000
        return delay > 0 ? engine.currentTime + delay : CHHapticTimeImmediate
    }

    private func register(_ player: CHHapticAdvancedPatternPlayer) -> Int {
        let handle = nextHandle
        nextHandle += 1
        players[handle] = player
        player.completionHandler = { [weak self] _ in
            DispatchQueue.main.async {
                self?.players[handle] = nil
                self?.holdLevels[handle] = nil
                self?.scores[handle] = nil
            }
        }
        return handle
    }

    // MARK: - Scores

    static func pattern(_ score: Score) throws -> CHHapticPattern {
        let events = score.events.map { e -> CHHapticEvent in
            let parameters = [
                CHHapticEventParameter(parameterID: .hapticIntensity, value: Float(e.intensity)),
                CHHapticEventParameter(parameterID: .hapticSharpness, value: Float(e.sharpness)),
            ]
            switch e.kind {
            case .transient:
                return CHHapticEvent(eventType: .hapticTransient, parameters: parameters, relativeTime: e.t / 1000)
            case .continuous:
                return CHHapticEvent(
                    eventType: .hapticContinuous, parameters: parameters,
                    relativeTime: e.t / 1000, duration: (e.duration ?? 0) / 1000
                )
            }
        }
        let curves = score.curves.compactMap { c -> CHHapticParameterCurve? in
            guard let start = c.points.first?.t else { return nil }
            return CHHapticParameterCurve(
                parameterID: c.control == .intensity ? .hapticIntensityControl : .hapticSharpnessControl,
                controlPoints: c.points.map {
                    CHHapticParameterCurve.ControlPoint(relativeTime: ($0.t - start) / 1000, value: Float($0.value))
                },
                relativeTime: start / 1000
            )
        }
        return try CHHapticPattern(events: events, parameterCurves: curves)
    }

    func start(score: Score, atMs: Double) -> Int? {
        guard let engine = ensureRunning() else { return nil }
        do {
            let player = try engine.makeAdvancedPlayer(with: Self.pattern(score))
            let handle = register(player)
            scores[handle] = score
            try player.start(atTime: engineTime(atMs))
            return handle
        } catch {
            log("score \(score.id) failed: \(error)")
            return nil
        }
    }

    func stop(_ handle: Int, atMs: Double, fadeMs: Double) {
        guard let player = players[handle] else { return }
        let at = engineTime(atMs)
        if fadeMs > 0, let engine {
            let from = holdLevels[handle]?.intensity
                ?? scores[handle].map { $0.intensityControl(atMs: max(0, atMs - $0.at)) }
                ?? 1
            let curve = CHHapticParameterCurve(
                parameterID: .hapticIntensityControl,
                controlPoints: [
                    .init(relativeTime: 0, value: Float(from)),
                    .init(relativeTime: fadeMs / 1000, value: 0),
                ],
                relativeTime: 0
            )
            try? player.scheduleParameterCurve(curve, atTime: at == CHHapticTimeImmediate ? engine.currentTime : at)
            let end = (at == CHHapticTimeImmediate ? engine.currentTime : at) + fadeMs / 1000
            try? player.stop(atTime: end)
        } else {
            try? player.stop(atTime: at)
        }
    }

    // MARK: - Holds

    func startHold(intensity: Double, sharpness: Double, atMs: Double) -> Int? {
        guard let engine = ensureRunning() else { return nil }
        let carrier = CHHapticEvent(
            eventType: .hapticContinuous,
            parameters: [
                CHHapticEventParameter(parameterID: .hapticIntensity, value: 1),
                CHHapticEventParameter(parameterID: .hapticSharpness, value: Float(Self.holdSharpnessCentre)),
            ],
            relativeTime: 0,
            duration: Self.holdSegmentSeconds
        )
        do {
            let player = try engine.makeAdvancedPlayer(with: CHHapticPattern(events: [carrier], parameters: []))
            player.loopEnabled = true
            player.loopEnd = Self.holdSegmentSeconds
            let handle = register(player)
            let at = engineTime(atMs)
            try player.sendParameters(Self.controls(intensity, sharpness), atTime: at)
            try player.start(atTime: at)
            holdLevels[handle] = (intensity, sharpness)
            return handle
        } catch {
            log("hold failed: \(error)")
            return nil
        }
    }

    func driveHold(_ handle: Int, intensity: Double, sharpness: Double, atMs: Double, rampMs: Double) {
        guard let player = players[handle], let engine else { return }
        let at = engineTime(atMs)
        if rampMs > 0, let from = holdLevels[handle] {
            let start = at == CHHapticTimeImmediate ? engine.currentTime : at
            let ramp = { (id: CHHapticDynamicParameter.ID, a: Double, b: Double) in
                CHHapticParameterCurve(
                    parameterID: id,
                    controlPoints: [.init(relativeTime: 0, value: Float(a)), .init(relativeTime: rampMs / 1000, value: Float(b))],
                    relativeTime: 0
                )
            }
            try? player.scheduleParameterCurve(ramp(.hapticIntensityControl, from.intensity, intensity), atTime: start)
            try? player.scheduleParameterCurve(
                ramp(.hapticSharpnessControl, from.sharpness - Self.holdSharpnessCentre, sharpness - Self.holdSharpnessCentre),
                atTime: start
            )
        } else {
            try? player.sendParameters(Self.controls(intensity, sharpness), atTime: at)
        }
        holdLevels[handle] = (intensity, sharpness)
    }

    private static func controls(_ intensity: Double, _ sharpness: Double) -> [CHHapticDynamicParameter] {
        [
            CHHapticDynamicParameter(parameterID: .hapticIntensityControl, value: Float(intensity), relativeTime: 0),
            CHHapticDynamicParameter(
                parameterID: .hapticSharpnessControl, value: Float(sharpness - holdSharpnessCentre), relativeTime: 0
            ),
        ]
    }

    // MARK: - Base

    func playBase(_ base: BaseVibration, gain: Double, atMs: Double) -> Bool {
        guard let engine = ensureRunning() else { return false }
        let parameters = [
            CHHapticEventParameter(parameterID: .hapticIntensity, value: Float(base.intensity * gain)),
            CHHapticEventParameter(parameterID: .hapticSharpness, value: Float(base.sharpness)),
        ]
        let event = base.kind == .transient
            ? CHHapticEvent(eventType: .hapticTransient, parameters: parameters, relativeTime: 0)
            : CHHapticEvent(eventType: .hapticContinuous, parameters: parameters, relativeTime: 0, duration: base.durationMs / 1000)
        do {
            try basePlayer?.stop(atTime: CHHapticTimeImmediate)
            let player = try engine.makePlayer(with: CHHapticPattern(events: [event], parameters: []))
            try player.start(atTime: engineTime(atMs))
            basePlayer = player
            return true
        } catch {
            log("base \(base.name) failed: \(error)")
            return false
        }
    }
}

// MARK: - Lab probes (T2): device limits measured without playing anything
// noticeable. Results are plain values; no device information is recorded.

extension CoreHapticsBackend {
    func probe(_ name: String) -> [String: Any] {
        guard let engine = engineForProbe else { return ["error": "no haptic engine"] }
        switch name {
        case "curvePoints":
            return Dictionary(uniqueKeysWithValues: [8, 16, 17, 32, 64].map { n in
                ("\(n)", Self.tryPattern(engine, events: [Self.faint(0, 1)], curvePoints: n))
            })
        case "eventsPerPattern":
            return Dictionary(uniqueKeysWithValues: [256, 1024, 4096, 16384].map { n in
                let events = (0..<n).map { i in
                    CHHapticEvent(
                        eventType: .hapticTransient,
                        parameters: [CHHapticEventParameter(parameterID: .hapticIntensity, value: 0.01)],
                        relativeTime: Double(i) * 0.001
                    )
                }
                let started = CACurrentMediaTime()
                let result = Self.tryPattern(engine, events: events, curvePoints: 0)
                return ("\(n)", ["result": result, "ms": (CACurrentMediaTime() - started) * 1000] as [String: Any])
            })
        case "players":
            var out: [String: Any] = [:]
            for k in [8, 16, 32, 64, 128] {
                var players: [CHHapticAdvancedPatternPlayer] = []
                var failure: String?
                for _ in 0..<k {
                    do {
                        let p = try engine.makeAdvancedPlayer(with: CHHapticPattern(events: [Self.faint(0, 0.5)], parameters: []))
                        try p.start(atTime: CHHapticTimeImmediate)
                        players.append(p)
                    } catch {
                        failure = "\(error)"
                        break
                    }
                }
                for p in players { try? p.stop(atTime: CHHapticTimeImmediate) }
                out["\(k)"] = ["started": players.count, "error": failure ?? ""] as [String: Any]
            }
            return out
        case "startLatency":
            var samples: [Double] = []
            for _ in 0..<30 {
                let started = CACurrentMediaTime()
                if let p = try? engine.makeAdvancedPlayer(with: CHHapticPattern(events: [Self.faint(0, 0.05)], parameters: [])) {
                    try? p.start(atTime: CHHapticTimeImmediate)
                    samples.append((CACurrentMediaTime() - started) * 1000)
                    try? p.stop(atTime: CHHapticTimeImmediate)
                }
            }
            samples.sort()
            let pick = { (q: Double) in samples.isEmpty ? -1 : samples[min(samples.count - 1, Int(q * Double(samples.count)))] }
            return ["n": samples.count, "p50Ms": pick(0.5), "p95Ms": pick(0.95)]
        case "clock":
            return ["engineMinusMediaTimeMs": (engine.currentTime - CACurrentMediaTime()) * 1000]
        default:
            return ["error": "unknown probe \(name)"]
        }
    }

    private static func faint(_ t: Double, _ duration: Double) -> CHHapticEvent {
        CHHapticEvent(
            eventType: .hapticContinuous,
            parameters: [
                CHHapticEventParameter(parameterID: .hapticIntensity, value: 0.01),
                CHHapticEventParameter(parameterID: .hapticSharpness, value: 0.5),
            ],
            relativeTime: t, duration: duration
        )
    }

    private static func tryPattern(_ engine: CHHapticEngine, events: [CHHapticEvent], curvePoints: Int) -> String {
        do {
            let curves = curvePoints == 0 ? [] : [CHHapticParameterCurve(
                parameterID: .hapticIntensityControl,
                controlPoints: (0..<curvePoints).map { .init(relativeTime: Double($0) * 0.01, value: 1) },
                relativeTime: 0
            )]
            let pattern = try CHHapticPattern(events: events, parameterCurves: curves)
            _ = try engine.makeAdvancedPlayer(with: pattern)
            return "ok"
        } catch {
            return "\(error)"
        }
    }
}
