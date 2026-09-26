import XCTest

/// The phone-side join, against a small hand-made table. The real table and
/// its exactness are checked on CI by tools/laya/prepare.py (pieces.verify).
final class LayaLiveTests: XCTestCase {
    private let table = """
    {"max_length": 12, "pad": 0, "sep": 2,
     "questions": [{"id": "hardness", "qtype": 0, "scale": 1.0,
                    "prefix": [1, 10, 2, 3, 20, 3, 21, 2], "markers": [3, 5], "labels": ["soft", "hard"]}],
     "pieces": {"a.": [30], "b c.": [31, 32], "d.": [33]}}
    """

    private func live() throws -> LayaLive {
        try JSONDecoder().decode(LayaLive.self, from: Data(table.utf8))
    }

    func testJoinsPrefixPhrasesAndSeparator() throws {
        let item = try live().item(question: "hardness", phrases: ["a.", "b c."])
        XCTAssertEqual(item.ids, [1, 10, 2, 3, 20, 3, 21, 2, 30, 31, 32, 2])
        XCTAssertEqual(item.markers, [3, 5])
        XCTAssertEqual(item.phrases, ["a.", "b c."])
    }

    func testDropsWholePhrasesFromTheEndWhenTooLong() throws {
        // Room for 3 state tokens: "a." (1) fits, "b c." (2) fits, "d." does not.
        let item = try live().item(question: "hardness", phrases: ["a.", "b c.", "d."])
        XCTAssertEqual(item.phrases, ["a.", "b c."])
        XCTAssertEqual(item.ids.count, 12)
        // Once a phrase does not fit, nothing after it is added either.
        let first = try live().item(question: "hardness", phrases: ["b c.", "b c."])
        XCTAssertEqual(first.phrases, ["b c."])
    }

    func testRefusesWhatItCannotTokenize() throws {
        XCTAssertThrowsError(try live().item(question: "hardness", phrases: ["a.", "never seen."])) { error in
            XCTAssertEqual(error as? LayaLive.Problem, .unknownPhrase("never seen."))
        }
        XCTAssertThrowsError(try live().item(question: "weight", phrases: ["a."]))
    }
}
