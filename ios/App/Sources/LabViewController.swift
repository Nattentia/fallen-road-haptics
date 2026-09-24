import CoreML
import UIKit

/// Stage-2 Laya feasibility bench: load time, memory, per-question latency,
/// 1/3/4-question decision sets, and parity with the Python reference.
final class LabViewController: UIViewController {
    private let output = UITextView()
    private var running = false
    private var lastReport: URL?

    override var supportedInterfaceOrientations: UIInterfaceOrientationMask { .landscape }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground

        output.isEditable = false
        output.font = .monospacedSystemFont(ofSize: 11, weight: .regular)
        output.text = "Laya 벤치마크: 아래 버튼 중 하나를 누르세요.\n"
            + "ANE = Neural Engine, fp16 = 검증된 원본 정밀도, w8 = 8비트 압축.\n"
            + "한 번에 약 1~3분 걸립니다. 게임은 뒤에서 멈춰 있습니다.\n"

        let buttons = UIStackView(arrangedSubviews: [
            makeButton("fp16 · ANE") { [weak self] in self?.run("fp16", .cpuAndNeuralEngine, "ANE") },
            makeButton("w8 · ANE") { [weak self] in self?.run("w8", .cpuAndNeuralEngine, "ANE") },
            makeButton("fp16 · CPU+GPU") { [weak self] in self?.run("fp16", .cpuAndGPU, "CPU+GPU") },
            makeButton("결과 저장") { [weak self] in self?.share() },
            makeButton("닫기") { [weak self] in self?.dismiss(animated: true) },
        ])
        buttons.axis = .horizontal
        buttons.spacing = 8
        buttons.distribution = .fillProportionally

        let stack = UIStackView(arrangedSubviews: [buttons, output])
        stack.axis = .vertical
        stack.spacing = 8
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 8),
            stack.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -8),
            stack.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 8),
            stack.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -8),
        ])
    }

    private func makeButton(_ title: String, _ handler: @escaping () -> Void) -> UIButton {
        var config = UIButton.Configuration.bordered()
        config.title = title
        config.buttonSize = .small
        return UIButton(configuration: config, primaryAction: UIAction { _ in handler() })
    }

    private func append(_ text: String) {
        DispatchQueue.main.async {
            self.output.text += text + "\n"
            self.output.scrollRangeToVisible(NSRange(location: self.output.text.count, length: 0))
        }
    }

    private func share() {
        guard let url = lastReport else { append("저장할 결과가 아직 없습니다."); return }
        let sheet = UIActivityViewController(activityItems: [url], applicationActivities: nil)
        sheet.popoverPresentationController?.sourceView = view
        present(sheet, animated: true)
    }

    private func run(_ variant: String, _ units: MLComputeUnits, _ unitsLabel: String) {
        guard !running else { return }
        running = true
        append("\n=== \(variant) · \(unitsLabel) ===")
        DispatchQueue.global(qos: .userInitiated).async {
            let report = LayaBench.run(variant: variant, units: units, unitsLabel: unitsLabel) { self.append($0) }
            DispatchQueue.main.async {
                self.lastReport = report
                self.running = false
            }
        }
    }
}

enum LayaBench {
    static func memoryMB() -> Double {
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<integer_t>.size)
        let result = withUnsafeMutablePointer(to: &info) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count)
            }
        }
        return result == KERN_SUCCESS ? Double(info.phys_footprint) / 1_048_576 : .nan
    }

    private static func pct(_ values: [Double], _ q: Double) -> Double {
        let s = values.sorted()
        return s.isEmpty ? .nan : s[min(s.count - 1, Int(q * Double(s.count)))]
    }

    private static func stats(_ values: [Double]) -> String {
        String(format: "p50 %.2f  p95 %.2f  max %.2f ms  (n=%d)", pct(values, 0.5), pct(values, 0.95), values.max() ?? .nan, values.count)
    }

    struct Golden: Decodable {
        let compute_units: String
        let probabilities: [[[Double]]]
    }

    /// Runs the full bench, streams progress lines, and returns the saved report file.
    static func run(variant: String, units: MLComputeUnits, unitsLabel: String, log: @escaping (String) -> Void) -> URL? {
        var lines: [String] = []
        func say(_ s: String) { lines.append(s); log(s) }
        let device = UIDevice.current
        say("기기 \(device.model) · iOS \(device.systemVersion)")

        let memBefore = memoryMB()
        let runtime: LayaRuntime
        do {
            runtime = try LayaRuntime(variant: variant, units: units)
        } catch {
            say("모델 로드 실패: \(error.localizedDescription)")
            return nil
        }
        let memLoaded = memoryMB()
        say(String(format: "로드 %.0f ms · 메모리 %.0f → %.0f MB", runtime.loadMs, memBefore, memLoaded))

        let states = runtime.prompts.states.count
        let questions = runtime.prompts.questions.count
        do {
            let t = Clock.nowMs()
            _ = try runtime.decide(state: 0, question: 0)
            say(String(format: "첫 추론 %.1f ms (워밍업 포함)", Clock.nowMs() - t))
            for q in 0..<questions { _ = try runtime.decide(state: 1, question: q) }
        } catch {
            say("추론 실패: \(error.localizedDescription)")
            return nil
        }

        // Every state × question once: latency and parity.
        let golden = (try? Data(contentsOf: LayaRuntime.directory.appendingPathComponent("golden-\(variant).json")))
            .flatMap { try? JSONDecoder().decode(Golden.self, from: $0) }
        var perQuestion: [Double] = []
        var maxAbs = 0.0, sumAbs = 0.0, cells = 0, argmaxAgree = 0, argmaxTotal = 0
        var set1: [Double] = [], set3: [Double] = [], set4: [Double] = []
        var peakMem = memLoaded
        for s in 0..<states {
            var elapsed = 0.0
            for q in 0..<questions {
                let t = Clock.nowMs()
                guard let probs = try? runtime.decide(state: s, question: q) else { continue }
                let dt = Clock.nowMs() - t
                perQuestion.append(dt)
                elapsed += dt
                if q == 0 { set1.append(elapsed) }
                if q == 2 { set3.append(elapsed) }
                if q == 3 { set4.append(elapsed) }
                if let ref = golden?.probabilities[s][q], ref.count == probs.count {
                    for (a, b) in zip(probs, ref) {
                        let d = abs(a - b)
                        maxAbs = max(maxAbs, d); sumAbs += d; cells += 1
                    }
                    argmaxTotal += 1
                    if probs.firstIndex(of: probs.max()!) == ref.firstIndex(of: ref.max()!) { argmaxAgree += 1 }
                }
            }
            if s % 30 == 29 { log("… \(s + 1)/\(states) 상태 완료"); peakMem = max(peakMem, memoryMB()) }
        }
        peakMem = max(peakMem, memoryMB())

        say("질문 1개      " + stats(perQuestion))
        say("결정 세트 1개 " + stats(set1))
        say("결정 세트 3개 " + stats(set3))
        say("결정 세트 4개 " + stats(set4))
        say(String(format: "최대 메모리 %.0f MB", peakMem))
        if golden != nil, cells > 0 {
            say(String(format: "원본 대비 확률 오차: 최대 %.4f · 평균 %.5f · 1순위 일치 %d/%d (%@ 기준)",
                       maxAbs, sumAbs / Double(cells), argmaxAgree, argmaxTotal, golden!.compute_units))
        } else {
            say("원본 기준값 없음: 일치 검사 생략")
        }

        // Stage-2 gate: 3 questions answered before a typical swipe ends (~100 ms).
        let p95 = pct(set3, 0.95)
        say(p95 <= 100 ? "판정: 3질문 p95 \(Int(p95)) ms ≤ 100 ms → 스와이프 중 응답 가능"
                       : "판정: 3질문 p95 \(Int(p95)) ms > 100 ms → 캐시/증류 검토 필요")

        let formatter = DateFormatter()
        formatter.dateFormat = "yyyyMMdd-HHmmss"
        let url = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("laya-\(variant)-\(unitsLabel)-\(formatter.string(from: Date())).txt")
        try? lines.joined(separator: "\n").write(to: url, atomically: true, encoding: .utf8)
        return url
    }
}
