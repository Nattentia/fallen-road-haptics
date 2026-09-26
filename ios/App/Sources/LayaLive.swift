import Foundation

/// Live Laya inputs without a tokenizer. tools/laya/prepare.py tokenizes each
/// live question's fixed prefix and every state phrase the game can send, and
/// proves on CI that joining phrase tokens equals tokenizing the joined text.
/// Here the phone only joins them:
///     prefix ([CLS] question [SEP] [MASK] option … [SEP]) + phrases + [SEP]
/// Mirrors tools/laya/pieces.py `fit` and `assemble`.
struct LayaLive: Decodable {
    struct Question: Decodable {
        let id: String
        let qtype: Int
        let scale: Double
        let prefix: [Int]
        let markers: [Int]
        let labels: [String]
    }

    /// One model input: compact token ids and the positions of the options.
    struct Item: Equatable {
        let ids: [Int]
        let markers: [Int]
        let qtype: Int
        let scale: Double
        /// The phrases that fit, in order.
        let phrases: [String]
    }

    enum Problem: Error, Equatable {
        case unknownQuestion(String)
        case unknownPhrase(String)
    }

    let max_length: Int
    let pad: Int
    let sep: Int
    let questions: [Question]
    let pieces: [String: [Int]]

    static func load(from url: URL) throws -> LayaLive {
        try JSONDecoder().decode(LayaLive.self, from: Data(contentsOf: url))
    }

    /// Builds the input for one question. Phrases come most important first;
    /// when the state is too long, whole phrases are dropped from the end.
    /// A phrase outside the prepared vocabulary cannot be tokenized here, so
    /// the question is not asked (the upscaler then uses its rules alone).
    func item(question id: String, phrases: [String]) throws -> Item {
        guard let q = questions.first(where: { $0.id == id }) else { throw Problem.unknownQuestion(id) }
        var tokens: [[Int]] = []
        for p in phrases {
            guard let t = pieces[p] else { throw Problem.unknownPhrase(p) }
            tokens.append(t)
        }
        let room = max(0, max_length - q.prefix.count - 1)
        var ids = q.prefix
        var kept: [String] = []
        var used = 0
        for (p, t) in zip(phrases, tokens) {
            if used + t.count > room { break }
            ids += t
            used += t.count
            kept.append(p)
        }
        ids.append(sep)
        return Item(ids: ids, markers: q.markers, qtype: q.qtype, scale: q.scale, phrases: kept)
    }
}
