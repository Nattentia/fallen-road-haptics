import XCTest

/// Decodes the command fixture exported by tools/commandFixtures.test.mjs.
final class UpscalerContractTests: XCTestCase {
    private func fixture() throws -> Data {
        let bundle = Bundle(for: Self.self)
        let url = try XCTUnwrap(
            bundle.url(forResource: "commands", withExtension: "json", subdirectory: "Fixtures")
                ?? bundle.url(forResource: "commands", withExtension: "json")
        )
        return try Data(contentsOf: url)
    }

    func testDecodesEveryCommandKind() throws {
        let commands = try JSONDecoder().decode([UpscalerCommand].self, from: fixture())
        XCTAssertEqual(
            commands.map(\.op),
            ["defineBase", "base", "play", "revise", "hold", "drive", "unhold", "release", "ask"]
        )
        for command in commands {
            if case .unknown(let op) = command { XCTFail("unknown op \(op)") }
        }
    }

    func testKeepsValuesAndUnits() throws {
        let commands = try JSONDecoder().decode([UpscalerCommand].self, from: fixture())
        guard case .defineBase(let base) = commands[0] else { return XCTFail("defineBase") }
        XCTAssertEqual(base, BaseVibration(name: "plain", kind: .continuous, intensity: 0.8, sharpness: 0.4, durationMs: 120))

        guard case .play(let voice, let score) = commands[2] else { return XCTFail("play") }
        XCTAssertEqual(voice, "voice-1")
        XCTAssertEqual(score.at, 1000)
        XCTAssertEqual(score.events.count, 2)
        XCTAssertNil(score.events[0].duration)
        XCTAssertEqual(score.events[1].duration, 90)
        XCTAssertEqual(score.end, 95)
        XCTAssertEqual(score.curves.first?.control, .sharpness)
        XCTAssertEqual(score.source.hints?.first?.field, "hardness")

        guard case .drive(_, let stream, _, let intensity, _, let ramp) = commands[5] else { return XCTFail("drive") }
        XCTAssertEqual(stream, "stream-a")
        XCTAssertEqual(intensity, 0.45)
        XCTAssertEqual(ramp, 16)
    }

    func testUnknownCommandsDecodeWithoutFailing() throws {
        let json = #"{"op":"somethingNew","voice":"v"}"#.data(using: .utf8)!
        XCTAssertEqual(try JSONDecoder().decode(UpscalerCommand.self, from: json), .unknown(op: "somethingNew"))
    }

    func testDecodesAMessageDictionary() throws {
        let message: [String: Any] = ["op": "release", "voice": "v", "at": 12.5, "fadeMs": 30]
        XCTAssertEqual(try UpscalerCommand.from(message: message), .release(voice: "v", at: 12.5, fadeMs: 30))
    }

    func testRejectsNaNWithoutRaising() {
        let message: [String: Any] = ["op": "release", "voice": "v", "at": Double.nan, "fadeMs": 30]
        XCTAssertThrowsError(try UpscalerCommand.from(message: message))
    }

    func testReadsTheIntensityCurveLevel() {
        let score = Score(
            id: "s", at: 1000, layer: "upscale", source: ScoreSource(kind: "rule", hints: nil),
            events: [ScoreEvent(kind: .continuous, t: 0, duration: 100, intensity: 1, sharpness: 0.5)],
            curves: [ScoreCurve(control: .intensity, points: [
                CurvePoint(t: 0, value: 1), CurvePoint(t: 100, value: 0), CurvePoint(t: 101, value: 1),
            ])]
        )
        XCTAssertEqual(score.intensityControl(atMs: 50), 0.5, accuracy: 1e-9)
        XCTAssertEqual(score.intensityControl(atMs: -5), 1)
        XCTAssertEqual(score.intensityControl(atMs: 500), 1)
    }

    func testNamesThermalStatesForTheJsSide() {
        XCTAssertEqual(ThermalLoad.name(.nominal), "nominal")
        XCTAssertEqual(ThermalLoad.name(.fair), "fair")
        XCTAssertEqual(ThermalLoad.name(.serious), "serious")
        XCTAssertEqual(ThermalLoad.name(.critical), "critical")
    }
}
