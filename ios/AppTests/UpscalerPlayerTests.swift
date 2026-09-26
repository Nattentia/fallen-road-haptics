import XCTest

/// Records what the player asks of the device.
private final class FakeBackend: HapticBackend {
    enum Call: Equatable {
        case start(String, Double)
        case stop(Int, Double, Double)
        case hold(Double, Double, Double)
        case drive(Int, Double, Double, Double, Double)
        case base(String, Double, Double)
    }

    var nowMs: Double = 0
    var calls: [Call] = []
    var available = true
    private var next = 1

    private func handle() -> Int? {
        guard available else { return nil }
        defer { next += 1 }
        return next
    }

    func start(score: Score, atMs: Double) -> Int? {
        calls.append(.start(score.id, atMs))
        return handle()
    }

    func stop(_ handle: Int, atMs: Double, fadeMs: Double) {
        calls.append(.stop(handle, atMs, fadeMs))
    }

    func startHold(intensity: Double, sharpness: Double, atMs: Double) -> Int? {
        calls.append(.hold(intensity, sharpness, atMs))
        return handle()
    }

    func driveHold(_ handle: Int, intensity: Double, sharpness: Double, atMs: Double, rampMs: Double) {
        calls.append(.drive(handle, intensity, sharpness, atMs, rampMs))
    }

    func playBase(_ base: BaseVibration, gain: Double, atMs: Double) -> Bool {
        calls.append(.base(base.name, gain, atMs))
        return available
    }
}

final class UpscalerPlayerTests: XCTestCase {
    private var backend: FakeBackend!
    private var player: UpscalerPlayer!
    private var logs: [String] = []

    override func setUp() {
        backend = FakeBackend()
        player = UpscalerPlayer(backend: backend)
        logs = []
        player.log = { [unowned self] in self.logs.append($0) }
    }

    private func score(_ id: String, at: Double, length: Double = 100) -> Score {
        Score(
            id: id, at: at, layer: "upscale", source: ScoreSource(kind: "rule", hints: nil),
            events: [
                ScoreEvent(kind: .transient, t: 0, duration: nil, intensity: 1, sharpness: 0.8),
                ScoreEvent(kind: .continuous, t: 0, duration: length, intensity: 0.5, sharpness: 0.3),
            ],
            curves: []
        )
    }

    func testPlaysAScoreAtItsTime() {
        player.apply(.play(voice: "v", score: score("a", at: 50)))
        XCTAssertEqual(backend.calls, [.start("a", 50)])
        XCTAssertEqual(player.voices["v"]?.scheduled.first?.endMs, 150)
    }

    func testReviseCancelsWhatHasNotBegunAndFadesWhatIsPlaying() {
        backend.nowMs = 0
        player.apply(.play(voice: "v", score: score("playing", at: 0)))      // 0..100
        player.apply(.play(voice: "v", score: score("later", at: 200)))      // 200..300
        player.apply(.play(voice: "v", score: score("done", at: -500, length: 10)))
        backend.nowMs = 40
        backend.calls = []
        player.apply(.revise(voice: "v", from: 60, score: score("new", at: 60)))
        XCTAssertEqual(backend.calls, [
            .stop(1, 60, UpscalerPlayer.reviseFadeMs),
            .stop(2, 40, 0),
            .start("new", 60),
        ])
        XCTAssertEqual(player.voices["v"]?.scheduled.map(\.scoreId), ["new"])
    }

    func testReviseLeavesOtherVoicesAlone() {
        player.apply(.play(voice: "a", score: score("a1", at: 0)))
        player.apply(.play(voice: "b", score: score("b1", at: 0)))
        backend.calls = []
        player.apply(.revise(voice: "a", from: 10, score: score("a2", at: 10)))
        XCTAssertFalse(backend.calls.contains(.stop(2, 10, UpscalerPlayer.reviseFadeMs)))
        XCTAssertEqual(player.voices["b"]?.scheduled.map(\.scoreId), ["b1"])
    }

    func testHoldsAreDrivenPerStream() {
        player.apply(.hold(voice: "v", stream: "s1", at: 0, intensity: 0.3, sharpness: 0.6))
        player.apply(.hold(voice: "v", stream: "s1", at: 5, intensity: 0.4, sharpness: 0.6))
        player.apply(.drive(voice: "v", stream: "s1", at: 16, intensity: 0.5, sharpness: 0.7, rampMs: 16))
        player.apply(.drive(voice: "v", stream: "s2", at: 20, intensity: 0.2, sharpness: 0.2, rampMs: 16))
        XCTAssertEqual(backend.calls, [
            .hold(0.3, 0.6, 0),
            .drive(1, 0.4, 0.6, 5, 0),
            .drive(1, 0.5, 0.7, 16, 16),
            .hold(0.2, 0.2, 20),
        ])
        XCTAssertEqual(player.voices["v"]?.holds, ["s1": 1, "s2": 2])
        player.apply(.unhold(voice: "v", stream: "s1", at: 30, fadeMs: 20))
        XCTAssertEqual(backend.calls.last, .stop(1, 30, 20))
        XCTAssertEqual(player.voices["v"]?.holds, ["s2": 2])
    }

    func testReleaseFadesEverythingAndForgetsTheVoice() {
        player.apply(.hold(voice: "v", stream: "s", at: 0, intensity: 0.3, sharpness: 0.5))  // 1
        player.apply(.play(voice: "v", score: score("now", at: 0)))                           // 2: 0..100
        player.apply(.play(voice: "v", score: score("far", at: 500)))                         // 3: 500..600
        backend.nowMs = 20
        backend.calls = []
        player.apply(.release(voice: "v", at: 20, fadeMs: 40))
        XCTAssertEqual(Set(backend.calls.map { "\($0)" }), Set([
            .stop(1, 20, 40), .stop(2, 20, 40), .stop(3, 20, 0),
        ].map { "\($0)" }))
        XCTAssertNil(player.voices["v"])
    }

    func testUnknownVoicesAndStreamsAreHarmless() {
        player.apply(.unhold(voice: "x", stream: "y", at: 0, fadeMs: 10))
        player.apply(.release(voice: "x", at: 0, fadeMs: 10))
        player.apply(.revise(voice: "x", from: 0, score: score("r", at: 0)))
        XCTAssertEqual(backend.calls, [.start("r", 0)])
    }

    func testBaseNeedsADefinitionAndPassesItsGain() {
        player.apply(.base(name: "plain", at: 0, gain: 0.8))
        XCTAssertEqual(backend.calls, [])
        XCTAssertEqual(logs.count, 1)
        player.apply(.defineBase(BaseVibration(name: "plain", kind: .continuous, intensity: 0.8, sharpness: 0.4, durationMs: 120)))
        player.apply(.base(name: "plain", at: 3, gain: 0.8))
        XCTAssertEqual(backend.calls, [.base("plain", 0.8, 3)])
    }

    func testFinishedScoresArePruned() {
        player.apply(.play(voice: "v", score: score("a", at: 0)))
        backend.nowMs = 500
        player.apply(.ask(voice: "v", state: [], questions: []))
        XCTAssertNil(player.voices["v"])
    }

    func testResetForgetsAllVoices() {
        player.apply(.hold(voice: "v", stream: "s", at: 0, intensity: 0.3, sharpness: 0.5))
        player.reset()
        XCTAssertTrue(player.voices.isEmpty)
    }

    func testNothingIsTrackedWhenTheDeviceCannotPlay() {
        backend.available = false
        player.apply(.play(voice: "v", score: score("a", at: 0)))
        player.apply(.hold(voice: "v", stream: "s", at: 0, intensity: 0.3, sharpness: 0.5))
        XCTAssertNil(player.voices["v"])
        XCTAssertEqual(logs.count, 2)
    }

    func testUnknownCommandsAreLoggedAndSkipped() {
        player.apply(.unknown(op: "future"))
        XCTAssertEqual(backend.calls, [])
        XCTAssertEqual(logs, ["unknown command future"])
    }
}
