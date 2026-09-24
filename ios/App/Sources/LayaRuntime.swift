import CoreML
import Foundation

/// Laya typed decisions on device. Tokenization is done at build time
/// (tools/laya/prepare.py) for the fixed haptic questions × state grid; this
/// runtime does the on-device part: embedding lookup, masks, the Core ML
/// encoder body, and softmax decoding of the option logits.
/// Mirrors laya_coreml/ane.py (ANEAgent.model_inputs / forward) and result.py.
final class LayaRuntime {
    struct Item: Decodable {
        let ids: [Int]
        let markers: [Int]
        let qtype: Int
        let scale: Double
    }
    struct Question: Decodable {
        let id: String
        let type: String
        let labels: [String]
    }
    struct State: Decodable {
        let id: String
        let text: String
    }
    struct Prompts: Decodable {
        let max_length: Int
        let max_options: Int
        let hidden: Int
        let local_attention: Int
        let pad: Int
        let vocab_rows: Int
        let questions: [Question]
        let states: [State]
        let items: [[Item]]
    }

    let prompts: Prompts
    private let embed: [Float16]
    private let typeEmb: [Float16]
    let model: MLModel
    let loadMs: Double

    private let length: Int
    private let hidden: Int
    private let embeddings: MLMultiArray
    private let fullMask: MLMultiArray
    private let localMask: MLMultiArray
    private let typeVectors: MLMultiArray
    private let markerMap: MLMultiArray
    private var logitsName: String?

    static var directory: URL { Bundle.main.bundleURL.appendingPathComponent("Laya") }

    init(variant: String, units: MLComputeUnits) throws {
        let dir = Self.directory
        prompts = try JSONDecoder().decode(Prompts.self, from: Data(contentsOf: dir.appendingPathComponent("prompts.json")))
        embed = try Self.readF16(dir.appendingPathComponent("embed.f16"))
        typeEmb = try Self.readF16(dir.appendingPathComponent("type_emb.f16"))
        length = prompts.max_length
        hidden = prompts.hidden

        let config = MLModelConfiguration()
        config.computeUnits = units
        let started = Clock.nowMs()
        model = try MLModel(contentsOf: dir.appendingPathComponent("\(variant).mlmodelc"), configuration: config)
        loadMs = Clock.nowMs() - started

        embeddings = try MLMultiArray(shape: [1, NSNumber(value: hidden), 1, NSNumber(value: length)], dataType: .float16)
        fullMask = try MLMultiArray(shape: [1, NSNumber(value: length), 1, NSNumber(value: length)], dataType: .float16)
        localMask = try MLMultiArray(shape: [1, NSNumber(value: length), 1, NSNumber(value: length)], dataType: .float16)
        typeVectors = try MLMultiArray(shape: [1, NSNumber(value: hidden), 1, 1], dataType: .float16)
        markerMap = try MLMultiArray(shape: [1, NSNumber(value: length), 1, NSNumber(value: prompts.max_options)], dataType: .float16)
    }

    private static func readF16(_ url: URL) throws -> [Float16] {
        let data = try Data(contentsOf: url)
        return data.withUnsafeBytes { Array($0.bindMemory(to: Float16.self)) }
    }

    /// Probabilities over the question's options (length = option count).
    func decide(state: Int, question: Int) throws -> [Double] {
        let item = prompts.items[state][question]
        fill(item)
        let input = try MLDictionaryFeatureProvider(dictionary: [
            "embeddings": MLFeatureValue(multiArray: embeddings),
            "full_mask": MLFeatureValue(multiArray: fullMask),
            "local_mask": MLFeatureValue(multiArray: localMask),
            "type_vectors": MLFeatureValue(multiArray: typeVectors),
            "marker_map": MLFeatureValue(multiArray: markerMap),
        ])
        let output = try model.prediction(from: input)
        let logits = try logitsArray(output)
        let k = item.markers.count
        var z = (0..<k).map { logits[$0].doubleValue / item.scale }
        let peak = z.max() ?? 0
        z = z.map { exp($0 - peak) }
        let total = z.reduce(0, +)
        return z.map { $0 / total }
    }

    /// The option-logit output is the one whose second dimension is 1 (ane.py).
    private func logitsArray(_ output: MLFeatureProvider) throws -> MLMultiArray {
        if let name = logitsName, let array = output.featureValue(for: name)?.multiArrayValue { return array }
        for name in output.featureNames {
            if let array = output.featureValue(for: name)?.multiArrayValue,
               array.shape.count > 1, array.shape[1].intValue == 1 {
                logitsName = name
                return array
            }
        }
        throw NSError(domain: "Laya", code: 1, userInfo: [NSLocalizedDescriptionKey: "logits output not found"])
    }

    /// Strides of dims 1 and 3 for a [1, A, 1, B] array (Core ML may pad rows).
    private static func strides(_ array: MLMultiArray) -> (Int, Int) {
        (array.strides[1].intValue, array.strides[3].intValue)
    }

    private func fill(_ item: Item) {
        let L = length, H = hidden, K = prompts.max_options
        let n = item.ids.count
        let window = prompts.local_attention / 2
        let neg = Float16(-1e4)

        // embeddings [1,H,1,L]
        let e = embeddings.dataPointer.assumingMemoryBound(to: Float16.self)
        let (eC, eP) = Self.strides(embeddings)
        for pos in 0..<L {
            let row = (pos < n ? item.ids[pos] : prompts.pad) * H
            for c in 0..<H { e[c * eC + pos * eP] = embed[row + c] }
        }
        // Attention masks [1,key,1,query]. Position 0 is always a valid key (inputs.py).
        let f = fullMask.dataPointer.assumingMemoryBound(to: Float16.self)
        let l = localMask.dataPointer.assumingMemoryBound(to: Float16.self)
        let (fK, fQ) = Self.strides(fullMask)
        let (lK, lQ) = Self.strides(localMask)
        for key in 0..<L {
            let keyValid = key < n || key == 0
            for query in 0..<L {
                let queryValid = query < n || query == 0
                f[key * fK + query * fQ] = keyValid ? 0 : neg
                let local = (abs(query - key) <= window || !queryValid) && keyValid
                l[key * lK + query * lQ] = local ? 0 : neg
            }
        }
        // Question-type vector [1,H,1,1].
        let t = typeVectors.dataPointer.assumingMemoryBound(to: Float16.self)
        let tC = typeVectors.strides[1].intValue
        for c in 0..<H { t[c * tC] = typeEmb[item.qtype * H + c] }
        // Marker map [1,L,1,K]: unused marker slots point at position 0, as in ane.py.
        let m = markerMap.dataPointer.assumingMemoryBound(to: Float16.self)
        let (mP, mJ) = Self.strides(markerMap)
        for pos in 0..<L {
            for j in 0..<K { m[pos * mP + j * mJ] = 0 }
        }
        for j in 0..<K {
            let pos = j < item.markers.count ? item.markers[j] : 0
            m[pos * mP + j * mJ] = 1
        }
    }
}
