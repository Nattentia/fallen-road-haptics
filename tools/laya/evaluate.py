"""D5: how far the live questions can be trusted (runs on a macOS CI runner).

Asks a Laya checkpoint the live questions (tools/laya/vocabulary.json) about
the states in tools/laya/validation.json, forwards and with the options in
reverse order, and reports per question:
  order       share of relative-order checks the answers get right
  paraphrase  mean change of the answer when the same moment is reworded
  anchors     share of loose everyday anchors met
  contact     share of unambiguous contact kinds named (chance: 0.2)
  bias        mean change of the answer when the options are reversed
  spread      spread of the answer across all states (flat answers say nothing)
  decided     mean decidedness (1 - normalized entropy)
Every metric is also computed for a model that answers at random (500 runs):
a question passes only when each of its metrics beats that chance level (95th
percentile) and meets PASS. Failing questions move to deterministic rules
(v4 4). The chance check matters: random answers sit near the middle of a
scale, so they look "stable" under rewording and reordering.

    python tools/laya/evaluate.py --model aac6fef/laya-multilingual-coreml-ane --out report.json
"""

import argparse
import json
import math
import random
from pathlib import Path

PASS = {"order": 0.75, "paraphrase": 0.15, "anchors": 0.75, "contact": 0.6, "bias": 0.15}
LOWER_IS_BETTER = {"paraphrase", "bias"}
HERE = Path(__file__).parent


def expected(p):
    """Expected position on a 0..1 scale for an ordered choice."""
    k = len(p)
    return sum(pi * i / (k - 1) for i, pi in enumerate(p))


def decidedness(p):
    k = len(p)
    h = -sum(x * math.log(x) for x in p if x > 0)
    return max(0.0, min(1.0, 1 - h / math.log(k)))


def argmax(p):
    return max(range(len(p)), key=lambda i: p[i])


def questions_with_reversed(vocab):
    """Live question definitions plus each with its options reversed."""
    out = {}
    for q in vocab["questions"]:
        d = {"type": q["type"], "instructions": q["instructions"], "criteria": q["criteria"]}
        out[q["id"]] = d
        out[q["id"] + "~rev"] = {**d, "criteria": list(reversed(q["criteria"]))}
    return out


def evaluate(ask, vocab, validation):
    """`ask(text, questions)` returns {qid: [probabilities in option order]}."""
    context = validation["context"]
    questions = questions_with_reversed(vocab)
    ids = [q["id"] for q in vocab["questions"]]
    cache = {}

    def answers(state):
        if state not in cache:
            cache[state] = ask(" ".join([state] + context), questions)
        return cache[state]

    def value(state, qid):
        return expected(answers(state)[qid])

    report = {qid: {} for qid in ids}

    for qid in ids:
        checks = [c for c in validation["order"] if c["question"] == qid]
        if checks:
            ok = sum(value(c["higher"], qid) > value(c["lower"], qid) for c in checks)
            report[qid]["order"] = ok / len(checks)
        anchors = [a for a in validation["anchors"] if a["question"] == qid]
        if anchors:
            ok = sum(
                a.get("min", 0) <= value(a["state"], qid) <= a.get("max", 1) for a in anchors
            )
            report[qid]["anchors"] = ok / len(anchors)

    for qid in ids:
        diffs = []
        for a, b in validation["paraphrase"]:
            if qid == "contact":
                diffs.append(0.0 if argmax(answers(a)[qid]) == argmax(answers(b)[qid]) else 1.0)
            else:
                diffs.append(abs(value(a, qid) - value(b, qid)))
        report[qid]["paraphrase"] = sum(diffs) / len(diffs)

    contact = validation["contact"]
    report["contact"]["contact"] = sum(
        argmax(answers(c["state"])["contact"]) == c["expect"] for c in contact
    ) / len(contact)

    states = list(cache)
    for qid in ids:
        diffs, decided = [], []
        for s in states:
            fwd = answers(s)[qid]
            rev = list(reversed(answers(s)[qid + "~rev"]))
            decided.append(decidedness(fwd))
            if qid == "contact":
                diffs.append(0.0 if argmax(fwd) == argmax(rev) else 1.0)
            else:
                diffs.append(abs(expected(fwd) - expected(rev)))
        report[qid]["bias"] = sum(diffs) / len(diffs)
        report[qid]["decided"] = sum(decided) / len(decided)
        if qid != "contact":
            vals = [value(s, qid) for s in states]
            m = sum(vals) / len(vals)
            report[qid]["spread"] = math.sqrt(sum((v - m) ** 2 for v in vals) / len(vals))

    raw = {s: {q: [round(x, 4) for x in p] for q, p in a.items()} for s, a in cache.items()}
    return report, raw


def chance(vocab, validation, runs=500, seed=3):
    """Per question and metric, the level a random model reaches 95% of the time."""
    rng = random.Random(seed)

    def ask(text, questions):
        out = {}
        for qid, q in questions.items():
            w = [-math.log(1 - rng.random()) for _ in q["criteria"]]
            t = sum(w)
            out[qid] = [x / t for x in w]
        return out

    samples = {}
    for _ in range(runs):
        report, _ = evaluate(ask, vocab, validation)
        for qid, r in report.items():
            for key, v in r.items():
                samples.setdefault(qid, {}).setdefault(key, []).append(v)
    bounds = {}
    for qid, metrics in samples.items():
        for key, vs in metrics.items():
            vs.sort()
            at = 0.05 if key in LOWER_IS_BETTER else 0.95
            bounds.setdefault(qid, {})[key] = vs[min(len(vs) - 1, int(at * len(vs)))]
    return bounds


def judge(report, bounds):
    """Adds `pass` and per-metric verdicts: beat chance, and meet PASS."""
    for qid, r in report.items():
        verdicts = {}
        for key, v in list(r.items()):
            limit = bounds.get(qid, {}).get(key)
            # Decidedness is reported only: an honestly unsure answer is not
            # wrong, it just weighs little when blended.
            if limit is None or key == "decided":
                continue
            low = key in LOWER_IS_BETTER
            best = 0.0 if low else 1.0
            if limit == best:
                ok = v == best  # chance already reaches the ceiling
            else:
                ok = v < limit if low else v > limit
            if key in PASS:
                ok = ok and (v <= PASS[key] if low else v >= PASS[key])
            verdicts[key] = ok
        r["chance"] = {k: round(v, 3) for k, v in bounds.get(qid, {}).items()}
        r["verdicts"] = verdicts
        r["pass"] = all(verdicts.values())
    return report


def markdown(model, report):
    keys = ["order", "paraphrase", "anchors", "contact", "bias", "spread", "decided", "pass"]
    lines = [f"### D5: {model}", "", "| question | " + " | ".join(keys) + " |",
             "|---" * (len(keys) + 1) + "|"]
    for qid, r in report.items():
        cells = []
        for k in keys:
            v = r.get(k)
            if v is None:
                cells.append("–")
            elif isinstance(v, bool):
                cells.append("✅" if v else "❌")
            else:
                mark = "" if r["verdicts"].get(k, True) else " ✗"
                cells.append(f"{v:.2f} ({r['chance'].get(k, 0):.2f}){mark}")
        lines.append(f"| {qid} | " + " | ".join(cells) + " |")
    lines.append("")
    lines.append("Cells: value (chance level). ✗ = not better than chance or misses the bar "
                 "(order ≥ 0.75, paraphrase ≤ 0.15, anchors ≥ 0.75, contact ≥ 0.6, bias ≤ 0.15).")
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--cache", default=".laya-cache")
    parser.add_argument("--out", default="d5-report.json")
    args = parser.parse_args()

    from huggingface_hub import snapshot_download
    import laya_coreml as laya

    path = snapshot_download(args.model, local_dir=Path(args.cache) / args.model.replace("/", "__"))
    agent = laya.load(str(path), local_files_only=True, compute_units="cpu")

    def ask(text, questions):
        answers = agent.predict(text, questions)["answers"]
        return {qid: [float(v) for v in a["probabilities"].values()] for qid, a in answers.items()}

    vocab = json.loads((HERE / "vocabulary.json").read_text(encoding="utf-8"))
    validation = json.loads((HERE / "validation.json").read_text(encoding="utf-8"))
    report, raw = evaluate(ask, vocab, validation)
    judge(report, chance(vocab, validation))
    Path(args.out).write_text(json.dumps({"model": args.model, "report": report, "answers": raw}, indent=2))
    print(markdown(args.model, report))


if __name__ == "__main__":
    main()
