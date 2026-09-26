import Foundation

/// In-game latency log. Every row carries stage timestamps on the JS clock
/// (performance.now ms): t0 pointer event, t1 JS signal, t2 Swift receive,
/// t3 after the Core Haptics call. Swift times are converted with the offset
/// from the latest ping sync.
final class LatencyLog {
    struct Row {
        let seq: Int
        let kind: String      // contact / sfx / base / signal / upscaler
        let detail: String    // phase:zone, sfx key, base action or kind:what:chain step
        let speed: Double
        let t0: Double?
        let t1: Double
        let t2: Double
        let t3: Double
        let haptic: Bool      // a haptic command was issued
        let syncRtt: Double
    }

    private(set) var rows: [Row] = []
    private let capacity = 20_000
    private(set) var offset: Double?   // swiftMs - jsMs
    private(set) var syncRtt: Double = .nan
    let sessionStart = Date()

    /// A new page has its own JS clock origin; wait for its first sync.
    func resetSync() {
        offset = nil
        syncRtt = .nan
    }

    func sync(offset: Double, rtt: Double) {
        self.offset = offset
        syncRtt = rtt
    }

    /// Swift ms → JS clock ms. NaN until the first sync arrives.
    func toJs(_ swiftMs: Double) -> Double {
        guard let offset else { return .nan }
        return swiftMs - offset
    }

    func add(_ row: Row) {
        if rows.count >= capacity { rows.removeFirst(rows.count - capacity + 1) }
        rows.append(row)
    }

    private static func percentile(_ values: [Double], _ q: Double) -> Double {
        let sorted = values.filter { $0.isFinite }.sorted()
        guard !sorted.isEmpty else { return .nan }
        return sorted[min(sorted.count - 1, Int(q * Double(sorted.count)))]
    }

    private static func fmt(_ v: Double) -> String { v.isFinite ? String(format: "%.1f", v) : "-" }

    private func line(_ label: String, _ values: [Double]) -> String {
        "\(label) p50 \(Self.fmt(Self.percentile(values, 0.5)))  p95 \(Self.fmt(Self.percentile(values, 0.95)))  n=\(values.count)"
    }

    /// Short live summary for the overlay.
    func summary(hapticsOn: Bool) -> String {
        let touches = rows.filter { $0.kind == "contact" && $0.t0 != nil }
        let commands = rows.filter { $0.kind == "upscaler" && $0.haptic }
        return [
            "haptics \(hapticsOn ? "ON" : "OFF")  sync rtt \(Self.fmt(syncRtt))ms",
            line("touch→native ", touches.map { $0.t3 - ($0.t0 ?? .nan) }),
            line("bridge JS→Sw", rows.map { $0.t2 - $0.t1 }),
            line("cmd→native   ", commands.map { $0.t3 - $0.t1 }),
        ].joined(separator: "\n")
    }

    func csv() -> String {
        var out = "seq,kind,detail,speed,t0,t1,t2,t3,haptic,sync_rtt,touch_to_haptic_ms,bridge_ms,native_ms\n"
        for r in rows {
            let t0 = r.t0.map { String(format: "%.3f", $0) } ?? ""
            let touch = r.t0.map { String(format: "%.3f", r.t3 - $0) } ?? ""
            out += "\(r.seq),\(r.kind),\(r.detail),\(Int(r.speed)),\(t0),"
            out += String(format: "%.3f,%.3f,%.3f,", r.t1, r.t2, r.t3)
            out += "\(r.haptic ? 1 : 0),\(String(format: "%.3f", r.syncRtt)),\(touch),"
            out += String(format: "%.3f,%.3f\n", r.t2 - r.t1, r.t3 - r.t2)
        }
        return out
    }

    func writeCsv() throws -> URL {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyyMMdd-HHmmss"
        let url = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("latency-\(formatter.string(from: sessionStart)).csv")
        try csv().write(to: url, atomically: true, encoding: .utf8)
        return url
    }
}
