import Foundation

/// What the player needs from a haptic device. Times are on the JS clock (ms);
/// the backend converts them. The Core Haptics backend lives in
/// CoreHapticsBackend.swift; tests use a fake one.
protocol HapticBackend: AnyObject {
    /// Current time on the JS clock, ms.
    var nowMs: Double { get }
    /// Starts a score at `atMs`. Returns nil when the device cannot play.
    func start(score: Score, atMs: Double) -> Int?
    /// Stops a started score or hold at `atMs`, fading out over `fadeMs`.
    /// A score that has not begun yet is cancelled.
    func stop(_ handle: Int, atMs: Double, fadeMs: Double)
    func startHold(intensity: Double, sharpness: Double, atMs: Double) -> Int?
    func driveHold(_ handle: Int, intensity: Double, sharpness: Double, atMs: Double, rampMs: Double)
    /// Plays a base vibration, replacing one still playing.
    func playBase(_ base: BaseVibration, gain: Double, atMs: Double) -> Bool
}

/// Executes upscaler commands. It holds no synthesis rules: every value it
/// plays comes from the command. It only tracks which scores and holds belong
/// to which voice so `revise` and `release` can reach them.
final class UpscalerPlayer {
    /// Cross-fade where `revise` cuts a vibration that is still playing.
    /// Hypothesis until measured in S1; the Lab can change it for a trial.
    static var reviseFadeMs: Double = 8

    struct Scheduled: Equatable {
        let handle: Int
        let scoreId: String
        let startMs: Double
        let endMs: Double
    }

    struct Voice: Equatable {
        var scheduled: [Scheduled] = []
        var holds: [String: Int] = [:]
    }

    /// What reaches the device, for side-by-side comparison.
    enum Mode: String, CaseIterable {
        case full = "기본+업스케일"
        case baseOnly = "기본만"
        case off = "끔"
    }

    private let backend: HapticBackend
    private(set) var mode: Mode = .full
    private(set) var voices: [String: Voice] = [:]
    private(set) var bases: [String: BaseVibration] = [:]
    /// Receives one line per notable decision (skipped commands, failures).
    var log: (String) -> Void = { _ in }

    init(backend: HapticBackend) {
        self.backend = backend
    }

    /// Switching away from `full` fades out everything the upscaler holds.
    func setMode(_ newMode: Mode) {
        mode = newMode
        guard newMode != .full else { return }
        releaseAll()
    }

    func apply(_ command: UpscalerCommand) {
        prune()
        if mode != .full {
            switch command {
            case .play, .hold, .drive, .ask:
                return
            case .revise(let voice, let from, _):
                return cut(voice, from: from)
            default:
                break
            }
        }
        switch command {
        case .defineBase(let base):
            bases[base.name] = base
        case .base(let name, let at, let gain):
            guard mode != .off else { return }
            guard let base = bases[name] else { return log("base \(name) not defined") }
            if !backend.playBase(base, gain: min(1, max(0, gain)), atMs: at) { log("base \(name) not played") }
        case .play(let voice, let score):
            schedule(score, in: voice)
        case .revise(let voice, let from, let score):
            cut(voice, from: from)
            schedule(score, in: voice)
        case .hold(let voice, let stream, let at, let intensity, let sharpness):
            if let handle = voices[voice]?.holds[stream] {
                backend.driveHold(handle, intensity: intensity, sharpness: sharpness, atMs: at, rampMs: 0)
            } else {
                startHold(voice, stream, at, intensity, sharpness)
            }
        case .drive(let voice, let stream, let at, let intensity, let sharpness, let rampMs):
            if let handle = voices[voice]?.holds[stream] {
                backend.driveHold(handle, intensity: intensity, sharpness: sharpness, atMs: at, rampMs: rampMs)
            } else {
                startHold(voice, stream, at, intensity, sharpness)
            }
        case .unhold(let voice, let stream, let at, let fadeMs):
            guard let handle = voices[voice]?.holds.removeValue(forKey: stream) else { return }
            backend.stop(handle, atMs: at, fadeMs: fadeMs)
            dropIfEmpty(voice)
        case .release(let voice, let at, let fadeMs):
            release(voice, at: at, fadeMs: fadeMs)
        case .ask(let voice, _, let questions):
            log("ask \(voice) \(questions.count) question(s): not connected yet")
        case .unknown(let op):
            log("unknown command \(op)")
        }
    }

    /// The device restarted: every player it had is gone.
    func reset() {
        voices.removeAll()
    }

    /// Fades out every voice (the page that drove them went away).
    func releaseAll(fadeMs: Double = 20) {
        let now = backend.nowMs
        for voice in Array(voices.keys) { release(voice, at: now, fadeMs: fadeMs) }
    }

    // MARK: - Internals

    private func schedule(_ score: Score, in voice: String) {
        guard !score.events.isEmpty else { return }
        guard let handle = backend.start(score: score, atMs: score.at) else {
            return log("score \(score.id) not played")
        }
        voices[voice, default: Voice()].scheduled.append(
            Scheduled(handle: handle, scoreId: score.id, startMs: score.at, endMs: score.at + score.end)
        )
    }

    private func startHold(_ voice: String, _ stream: String, _ at: Double, _ intensity: Double, _ sharpness: Double) {
        guard let handle = backend.startHold(intensity: intensity, sharpness: sharpness, atMs: at) else {
            return log("hold \(voice)/\(stream) not played")
        }
        voices[voice, default: Voice()].holds[stream] = handle
    }

    /// Everything the voice would play from `from` on stops: scores not begun
    /// are cancelled, scores still playing are cut with a short fade.
    private func cut(_ voice: String, from: Double) {
        guard var v = voices[voice] else { return }
        let now = backend.nowMs
        v.scheduled = v.scheduled.filter { s in
            if s.endMs <= from { return true }
            if s.startMs >= from {
                backend.stop(s.handle, atMs: now, fadeMs: 0)
            } else {
                backend.stop(s.handle, atMs: from, fadeMs: Self.reviseFadeMs)
            }
            return false
        }
        voices[voice] = v
    }

    private func release(_ voice: String, at: Double, fadeMs: Double) {
        guard let v = voices.removeValue(forKey: voice) else { return }
        let now = backend.nowMs
        for handle in v.holds.values { backend.stop(handle, atMs: at, fadeMs: fadeMs) }
        for s in v.scheduled where s.endMs > at {
            if s.startMs >= at + fadeMs {
                backend.stop(s.handle, atMs: now, fadeMs: 0)
            } else {
                backend.stop(s.handle, atMs: at, fadeMs: fadeMs)
            }
        }
    }

    /// Forgets scores that have finished.
    private func prune() {
        let now = backend.nowMs
        for key in Array(voices.keys) {
            voices[key]?.scheduled.removeAll { $0.endMs < now }
            dropIfEmpty(key)
        }
    }

    private func dropIfEmpty(_ voice: String) {
        if let v = voices[voice], v.scheduled.isEmpty, v.holds.isEmpty { voices[voice] = nil }
    }
}
