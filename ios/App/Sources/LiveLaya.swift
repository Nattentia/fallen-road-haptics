import CoreML
import Foundation

/// Runs prepared live questions on a serial worker. The game never waits for
/// inference: its initial haptic score has already been sent when ask arrives.
final class LiveLaya {
    struct Hint: Encodable {
        let voice: String
        let questionId: String
        let requestId: String?
        let confidence: Double
        let latencyMs: Double
        let field: String
        let value: String
    }

    private let worker = DispatchQueue(label: "haptics.laya.live", qos: .userInitiated)
    private var model: LayaRuntime?
    private var live: LayaLive?
    private var failed = false

    init() {
        worker.async { [weak self] in self?.load() }
    }

    func ask(voice: String, requestId: String?, state: [String], questions: [AskQuestion],
             completion: @escaping ([Hint]) -> Void) {
        worker.async { [weak self] in
            guard let self else { return }
            let started = Clock.nowMs()
            self.load()
            guard let model = self.model, let live = self.live else {
                DispatchQueue.main.async { completion([]) }
                return
            }
            let requested = Set(questions.map(\.id))
            var hints: [Hint] = []
            for field in ["valence", "actor"] {
                guard requested.contains(field), requested.contains("\(field)~rev") else { continue }
                do {
                    let forward = try live.item(question: field, phrases: state)
                    let reverse = try live.item(question: "\(field)~rev", phrases: state)
                    guard let fLabels = live.questions.first(where: { $0.id == field })?.labels,
                          let rLabels = live.questions.first(where: { $0.id == "\(field)~rev" })?.labels,
                          let sent = questions.first(where: { $0.id == field }),
                          sent.options == fLabels, Set(fLabels) == Set(rLabels) else { continue }
                    let fp = try model.decide(item: forward)
                    let rp = try model.decide(item: reverse)
                    guard fp.count == fLabels.count, rp.count == rLabels.count else { continue }
                    let backwards = Dictionary(uniqueKeysWithValues: zip(rLabels, rp))
                    let both = fLabels.enumerated().map { index, label in
                        (fp[index] + (backwards[label] ?? 0)) / 2
                    }
                    guard let best = both.indices.max(by: { both[$0] < both[$1] }) else { continue }
                    let values = field == "valence"
                        ? ["good", "bad", "neutral"] : ["self", "other", "world"]
                    hints.append(Hint(
                        voice: voice, questionId: field, requestId: requestId, confidence: both[best],
                        latencyMs: Clock.nowMs() - started, field: field, value: values[best]
                    ))
                } catch {
                    NSLog("laya live skipped %@: %@", field, String(describing: error))
                }
            }
            DispatchQueue.main.async { completion(hints) }
        }
    }

    private func load() {
        guard model == nil, !failed else { return }
        do {
            live = try LayaLive.load(from: LayaRuntime.directory.appendingPathComponent("live.json"))
            model = try LayaRuntime(variant: "fp16", units: .all)
            NSLog("laya live ready")
        } catch {
            failed = true
            NSLog("laya live unavailable: %@", String(describing: error))
        }
    }
}
