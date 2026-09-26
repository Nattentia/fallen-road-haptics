import Foundation

// Mirrors src/shared/upscaler/contract.ts. The JS side sends these as JSON;
// field names and units (milliseconds, 0...1 values) are identical. The
// tests in ios/AppTests decode the fixture the TS tests export, so the two
// sides cannot drift apart unnoticed.

struct BaseVibration: Codable, Equatable {
    enum Kind: String, Codable { case transient, continuous }
    var name: String
    var kind: Kind
    var intensity: Double
    var sharpness: Double
    var durationMs: Double
}

struct ScoreEvent: Codable, Equatable {
    enum Kind: String, Codable { case transient, continuous }
    var kind: Kind
    /// ms from the score's zero.
    var t: Double
    /// ms; continuous events only.
    var duration: Double?
    var intensity: Double
    var sharpness: Double
}

struct CurvePoint: Codable, Equatable {
    var t: Double
    var value: Double
}

struct ScoreCurve: Codable, Equatable {
    enum Control: String, Codable { case intensity, sharpness }
    var control: Control
    var points: [CurvePoint]
}

struct HintUse: Codable, Equatable {
    var field: String
    var weight: Double
    var latencyMs: Double
}

struct ScoreSource: Codable, Equatable {
    var kind: String
    var hints: [HintUse]?
}

struct Score: Codable, Equatable {
    var id: String
    /// Absolute JS clock time (ms) of the score's zero.
    var at: Double
    var layer: String
    var source: ScoreSource
    var events: [ScoreEvent]
    var curves: [ScoreCurve]

    /// Where the last event ends, ms from the score's zero.
    var end: Double {
        events.map { $0.t + ($0.duration ?? 0) }.max() ?? 0
    }
}

struct AskQuestion: Codable, Equatable {
    var id: String
    var kind: String
    var prompt: String
    var options: [String]
}

enum UpscalerCommand: Equatable {
    case defineBase(BaseVibration)
    case base(name: String, at: Double, gain: Double)
    case play(voice: String, score: Score)
    case revise(voice: String, from: Double, score: Score)
    case hold(voice: String, stream: String, at: Double, intensity: Double, sharpness: Double)
    case drive(voice: String, stream: String, at: Double, intensity: Double, sharpness: Double, rampMs: Double)
    case unhold(voice: String, stream: String, at: Double, fadeMs: Double)
    case release(voice: String, at: Double, fadeMs: Double)
    case ask(voice: String, state: [String], questions: [AskQuestion])
    /// A command this build does not know; logged and skipped.
    case unknown(op: String)

    var op: String {
        switch self {
        case .defineBase: return "defineBase"
        case .base: return "base"
        case .play: return "play"
        case .revise: return "revise"
        case .hold: return "hold"
        case .drive: return "drive"
        case .unhold: return "unhold"
        case .release: return "release"
        case .ask: return "ask"
        case .unknown(let op): return op
        }
    }
}

extension UpscalerCommand: Decodable {
    private enum Key: String, CodingKey {
        case op, base, name, at, gain, voice, score, from, stream
        case intensity, sharpness, rampMs, fadeMs, state, questions
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Key.self)
        let op = try c.decode(String.self, forKey: .op)
        func d(_ key: Key) throws -> Double { try c.decode(Double.self, forKey: key) }
        func s(_ key: Key) throws -> String { try c.decode(String.self, forKey: key) }
        switch op {
        case "defineBase":
            self = .defineBase(try c.decode(BaseVibration.self, forKey: .base))
        case "base":
            self = .base(name: try s(.name), at: try d(.at), gain: try d(.gain))
        case "play":
            self = .play(voice: try s(.voice), score: try c.decode(Score.self, forKey: .score))
        case "revise":
            self = .revise(voice: try s(.voice), from: try d(.from), score: try c.decode(Score.self, forKey: .score))
        case "hold":
            self = .hold(voice: try s(.voice), stream: try s(.stream), at: try d(.at),
                         intensity: try d(.intensity), sharpness: try d(.sharpness))
        case "drive":
            self = .drive(voice: try s(.voice), stream: try s(.stream), at: try d(.at),
                          intensity: try d(.intensity), sharpness: try d(.sharpness), rampMs: try d(.rampMs))
        case "unhold":
            self = .unhold(voice: try s(.voice), stream: try s(.stream), at: try d(.at), fadeMs: try d(.fadeMs))
        case "release":
            self = .release(voice: try s(.voice), at: try d(.at), fadeMs: try d(.fadeMs))
        case "ask":
            self = .ask(voice: try s(.voice), state: try c.decode([String].self, forKey: .state),
                        questions: try c.decode([AskQuestion].self, forKey: .questions))
        default:
            self = .unknown(op: op)
        }
    }

    /// Decodes a command posted from JS (a WKScriptMessage body dictionary).
    static func from(message: Any) throws -> UpscalerCommand {
        let data = try JSONSerialization.data(withJSONObject: message)
        return try JSONDecoder().decode(UpscalerCommand.self, from: data)
    }
}
