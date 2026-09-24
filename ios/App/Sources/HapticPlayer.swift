import CoreHaptics

/// Stage-1 haptic output. A pre-started engine plays:
///  - a weak continuous "blade passing" layer while the blade is in contact,
///    modulated live by blade speed (dynamic intensity control), and
///  - a transient when the game confirms an outcome (hit, block, counter…).
/// The mapping is a placeholder for the stage-3 renderer.
final class HapticPlayer {
    private var engine: CHHapticEngine?
    private var contact: CHHapticAdvancedPatternPlayer?
    var enabled = true

    /// Ceiling of the weak contact layer; speed scales within it.
    private static let contactCeiling: Float = 0.55

    private static let zoneSharpness: [String: Float] = [
        "head": 0.85, "hand": 0.9, "torso": 0.45, "legs": 0.3,
    ]

    /// Outcome transients: sfx key → (intensity, sharpness).
    private static let outcomes: [String: (Float, Float)] = [
        "hit_sword": (0.8, 0.7), "hit_dagger": (0.6, 0.85), "hit_spear": (0.8, 0.6),
        "hit_hammer": (1.0, 0.25), "hit_mace": (1.0, 0.35), "hit_weak": (0.9, 0.9),
        "enemy_block": (0.7, 1.0), "parried": (1.0, 0.9), "player_block": (0.8, 0.8),
        "player_hit": (1.0, 0.2), "counter": (1.0, 1.0), "guard_break": (1.0, 0.5),
        "felled": (0.7, 0.3),
    ]

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
                self?.contact = nil
                try? self?.engine?.start()
            }
            try engine.start()
            self.engine = engine
        } catch {
            NSLog("HapticPlayer start failed: \(error)")
        }
    }

    private static func contactLevel(speed: Double) -> Float {
        // 0 px/s → 35 % of the ceiling, ≥3000 px/s → full ceiling.
        Float(min(1.0, 0.35 + max(0, speed) / 3000 * 0.65))
    }

    func contactEnter(zone: String, speed: Double) {
        guard enabled, let engine else { return }
        stopContact()
        let sharpness = Self.zoneSharpness[zone] ?? 0.5
        let event = CHHapticEvent(
            eventType: .hapticContinuous,
            parameters: [
                CHHapticEventParameter(parameterID: .hapticIntensity, value: Self.contactCeiling),
                CHHapticEventParameter(parameterID: .hapticSharpness, value: sharpness),
            ],
            relativeTime: 0,
            duration: 2.0
        )
        do {
            let player = try engine.makeAdvancedPlayer(
                with: CHHapticPattern(events: [event], parameters: [])
            )
            try player.start(atTime: CHHapticTimeImmediate)
            try player.sendParameters(
                [CHHapticDynamicParameter(
                    parameterID: .hapticIntensityControl,
                    value: Self.contactLevel(speed: speed),
                    relativeTime: 0
                )],
                atTime: CHHapticTimeImmediate
            )
            contact = player
        } catch {
            NSLog("contactEnter failed: \(error)")
        }
    }

    func contactInside(speed: Double) {
        guard enabled, let contact else { return }
        try? contact.sendParameters(
            [CHHapticDynamicParameter(
                parameterID: .hapticIntensityControl,
                value: Self.contactLevel(speed: speed),
                relativeTime: 0
            )],
            atTime: CHHapticTimeImmediate
        )
    }

    func stopContact() {
        try? contact?.stop(atTime: CHHapticTimeImmediate)
        contact = nil
    }

    /// Returns true when the key maps to an outcome transient.
    @discardableResult
    func outcome(key: String) -> Bool {
        guard enabled, let engine, let (intensity, sharpness) = Self.outcomes[key] else { return false }
        let event = CHHapticEvent(
            eventType: .hapticTransient,
            parameters: [
                CHHapticEventParameter(parameterID: .hapticIntensity, value: intensity),
                CHHapticEventParameter(parameterID: .hapticSharpness, value: sharpness),
            ],
            relativeTime: 0
        )
        do {
            let player = try engine.makePlayer(with: CHHapticPattern(events: [event], parameters: []))
            try player.start(atTime: CHHapticTimeImmediate)
            return true
        } catch {
            NSLog("outcome failed: \(error)")
            return false
        }
    }
}
