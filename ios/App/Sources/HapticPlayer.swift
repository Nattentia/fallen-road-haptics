import CoreHaptics

/// Plays the game's base vibration: one plain buzz, identical for every
/// action (player hit, enemy hit, enemy kill, boss kill). It is what a
/// typical mobile game ships and what any vibration motor could render, so
/// it carries no sharpness change, texture or layering. The haptic upscaler
/// will add its layer on top of it.
final class HapticPlayer {
    private var engine: CHHapticEngine?
    private var basePlayer: CHHapticPatternPlayer?
    var enabled = true

    private static let baseIntensity: Float = 0.8
    private static let baseSharpness: Float = 0.4
    private static let baseDuration: TimeInterval = 0.12

    var isAvailable: Bool { engine != nil }

    init() {
        startEngine()
    }

    private func startEngine() {
        guard CHHapticEngine.capabilitiesForHardware().supportsHaptics else { return }
        do {
            let engine = try CHHapticEngine()
            engine.playsHapticsOnly = true
            engine.isAutoShutdownEnabled = false
            engine.resetHandler = { [weak self] in
                self?.basePlayer = nil
                try? self?.engine?.start()
            }
            try engine.start()
            self.engine = engine
        } catch {
            NSLog("HapticPlayer start failed: \(error)")
        }
    }

    /// Plays the base buzz. A new one replaces a buzz still playing, so a
    /// hit and a kill in the same frame feel like one buzz, not a double one.
    @discardableResult
    func base() -> Bool {
        guard enabled, let engine else { return false }
        let event = CHHapticEvent(
            eventType: .hapticContinuous,
            parameters: [
                CHHapticEventParameter(parameterID: .hapticIntensity, value: Self.baseIntensity),
                CHHapticEventParameter(parameterID: .hapticSharpness, value: Self.baseSharpness),
            ],
            relativeTime: 0,
            duration: Self.baseDuration
        )
        do {
            try basePlayer?.stop(atTime: CHHapticTimeImmediate)
            let player = try engine.makePlayer(with: CHHapticPattern(events: [event], parameters: []))
            try player.start(atTime: CHHapticTimeImmediate)
            basePlayer = player
            return true
        } catch {
            NSLog("base haptic failed: \(error)")
            return false
        }
    }
}
