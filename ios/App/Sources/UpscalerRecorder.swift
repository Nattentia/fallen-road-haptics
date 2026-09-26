import Foundation

/// Keeps every upscaler message (signals from the game, commands to the
/// player) as JSON lines with the JS-clock time it arrived. The file is the
/// source for real-play test fixtures and, later, scene export.
final class UpscalerRecorder {
    private var lines: [String] = []
    private let capacity = 50_000

    func add(_ message: [String: Any], receivedAt: Double) {
        var row = message
        row["rx"] = receivedAt.isFinite ? receivedAt : nil
        guard JSONSerialization.isValidJSONObject(row),
              let data = try? JSONSerialization.data(withJSONObject: row, options: [.sortedKeys]),
              let line = String(data: data, encoding: .utf8) else { return }
        if lines.count >= capacity { lines.removeFirst(lines.count - capacity + 1) }
        lines.append(line)
    }

    var isEmpty: Bool { lines.isEmpty }

    func write(stamp: String) throws -> URL {
        let url = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("upscaler-\(stamp).jsonl")
        try (lines.joined(separator: "\n") + "\n").write(to: url, atomically: true, encoding: .utf8)
        return url
    }
}
