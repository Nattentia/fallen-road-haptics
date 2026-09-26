"""D5: how far the live questions can be trusted (runs on a macOS CI runner).

Asks a Laya checkpoint about the states in tools/laya/validation.json and
reports, per question:
  order       share of relative-order checks the answers get right
  paraphrase  mean change of the answer when the same moment is reworded
  anchors     share of loose everyday anchors met
  contact     share of unambiguous contact kinds named (chance: 0.2)
  bias        choice: change when the options are reversed;
              true/false: disagreement between the two opposite statements
  spread      spread of the answer across all states (flat answers say nothing)
  decided     mean decidedness (reported only)
Every metric is also computed for a model that answers at random (500 runs):
a question passes only when each metric beats that chance level (95th
percentile) and meets PASS. Random answers sit near the middle of a scale and
look "stable", which is why the chance comparison is needed.

Two ways to ask, three ways to state the moment:
  --questions choice  the live questions (vocabulary.json), 5 ordered options
  --questions noul    true/false statements: a scale is the mean of "is heavy"
                      and not "is light"; the contact kind is the largest of
                      five statement probabilities
  --state full        description + result, size, parties (what the phone sends)
  --state desc        description only
  --state fields      "mover: …. action: …. target: …." (validation.json)

  --criteria plain    bare option labels
  --criteria rubric   each option (true/false side for noul) carries a short
                      criterion with example objects (rubric.json, option A)
"""

import argparse
import json
import math
import random
from pathlib import Path

PASS = {"order": 0.75, "paraphrase": 0.15, "anchors": 0.75, "contact": 0.6, "bias": 0.15}
LOWER_IS_BETTER = {"paraphrase", "bias"}
IDS = ["hardness", "weight", "roughness", "contact"]
HERE = Path(__file__).parent


def expected(p):
    k = len(p)
    return sum(pi * i / (k - 1) for i, pi in enumerate(p))


def decidedness(p):
    k = len(p)
    h = -sum(x * math.log(x) for x in p if x > 0)
    return max(0.0, min(1.0, 1 - h / math.log(k)))


def argmax(p):
    return max(range(len(p)), key=lambda i: p[i])


def build_questions(vocab, validation, mode, rubric=None):
    out = {}
    if mode == "choice":
        for q in vocab["questions"]:
            labels = q["criteria"]
            if rubric:
                described = rubric["choice"][q["id"]]
                assert list(described) == labels, f"rubric labels differ for {q['id']}"
                criteria = {label: described[label] for label in labels}
                reverse = {label: described[label] for label in reversed(labels)}
            else:
                criteria, reverse = labels, list(reversed(labels))
            d = {"type": q["type"], "instructions": q["instructions"], "criteria": criteria}
            out[q["id"]] = d
            out[q["id"] + "~rev"] = {**d, "criteria": reverse}
        return out
    for qid, statements in validation["noul"].items():
        names = ["pos", "neg"] if qid != "contact" else [str(i) for i in range(len(statements))]
        for i, (name, text) in enumerate(zip(names, statements)):
            q = {"type": "noul", "instructions": text}
            if rubric:
                q["criteria"] = rubric["noul"][qid][i]
            out[f"{qid}~{name}"] = q
    return out


def shape(raw, mode):
    """Raw answers -> {qid: {"p": answer, "a": x, "b": y}} ("a"/"b" for bias)."""
    out = {}
    if mode == "choice":
        for qid in IDS:
            fwd, rev = raw[qid], list(reversed(raw[qid + "~rev"]))
            out[qid] = {"p": fwd, "a": fwd, "b": rev}
        return out
    for qid in IDS:
        if qid == "contact":
            ps = [raw[f"contact~{i}"][1] for i in range(5)]  # noul options: [false, true]
            total = sum(ps) or 1.0
            out[qid] = {"p": [x / total for x in ps], "a": None, "b": None}
        else:
            p1, p2 = raw[f"{qid}~pos"][1], raw[f"{qid}~neg"][1]
            v = (p1 + 1 - p2) / 2
            out[qid] = {"p": [1 - v, v], "a": [1 - p1, p1], "b": [p2, 1 - p2]}
    return out


def state_text(state, validation, mode):
    if mode == "full":
        return " ".join([state] + validation["context"])
    if mode == "fields":
        return validation["fields"][state]
    return state


def evaluate(get, validation):
    """`get(state)` returns shaped answers for one validation state."""
    cache = {}

    def answers(state):
        if state not in cache:
            cache[state] = get(state)
        return cache[state]

    def value(state, qid):
        return expected(answers(state)[qid]["p"])

    report = {qid: {} for qid in IDS}
    for qid in IDS[:3]:
        checks = [c for c in validation["order"] if c["question"] == qid]
        report[qid]["order"] = sum(value(c["higher"], qid) > value(c["lower"], qid) for c in checks) / len(checks)
        anchors = [a for a in validation["anchors"] if a["question"] == qid]
        report[qid]["anchors"] = sum(
            a.get("min", 0) <= value(a["state"], qid) <= a.get("max", 1) for a in anchors
        ) / len(anchors)

    for qid in IDS:
        diffs = []
        for a, b in validation["paraphrase"]:
            if qid == "contact":
                diffs.append(0.0 if argmax(answers(a)[qid]["p"]) == argmax(answers(b)[qid]["p"]) else 1.0)
            else:
                diffs.append(abs(value(a, qid) - value(b, qid)))
        report[qid]["paraphrase"] = sum(diffs) / len(diffs)

    contact = validation["contact"]
    report["contact"]["contact"] = sum(
        argmax(answers(c["state"])["contact"]["p"]) == c["expect"] for c in contact
    ) / len(contact)

    states = list(cache)
    for qid in IDS:
        diffs, decided = [], []
        for s in states:
            ans = answers(s)[qid]
            decided.append(decidedness(ans["p"]))
            if ans["a"] is None:
                continue
            if qid == "contact":
                diffs.append(0.0 if argmax(ans["a"]) == argmax(ans["b"]) else 1.0)
            else:
                diffs.append(abs(expected(ans["a"]) - expected(ans["b"])))
        if diffs:
            report[qid]["bias"] = sum(diffs) / len(diffs)
        report[qid]["decided"] = sum(decided) / len(decided)
        if qid != "contact":
            vals = [value(s, qid) for s in states]
            m = sum(vals) / len(vals)
            report[qid]["spread"] = math.sqrt(sum((v - m) ** 2 for v in vals) / len(vals))
    return report, cache


def chance(questions, mode, validation, runs=500, seed=3):
    """Per question and metric, the level a random model reaches 95% of the time."""
    rng = random.Random(seed)

    def get(state):
        raw = {}
        for qid, q in questions.items():
            k = len(q["criteria"]) if q["type"] == "choice" else 2
            w = [-math.log(1 - rng.random()) for _ in range(k)]
            t = sum(w)
            raw[qid] = [x / t for x in w]
        return shape(raw, mode)

    samples = {}
    for _ in range(runs):
        report, _ = evaluate(get, validation)
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
            ok = v == best if limit == best else (v < limit if low else v > limit)
            if key in PASS:
                ok = ok and (v <= PASS[key] if low else v >= PASS[key])
            verdicts[key] = ok
        r["chance"] = {k: round(v, 3) for k, v in bounds.get(qid, {}).items()}
        r["verdicts"] = verdicts
        r["pass"] = all(verdicts.values())
    return report


def markdown(title, report):
    keys = ["order", "paraphrase", "anchors", "contact", "bias", "spread", "decided", "pass"]
    lines = [f"### D5: {title}", "", "| question | " + " | ".join(keys) + " |",
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
    lines += ["", "Cells: value (chance level). ✗ = not better than chance or misses the bar "
              "(order ≥ 0.75, paraphrase ≤ 0.15, anchors ≥ 0.75, contact ≥ 0.6, bias ≤ 0.15)."]
    return "\n".join(lines)


def run(ask, vocab, validation, qmode, smode, rubric=None):
    """`ask(text, questions)` returns {qid: [probabilities in option order]}."""
    questions = build_questions(vocab, validation, qmode, rubric)
    report, cache = evaluate(
        lambda s: shape(ask(state_text(s, validation, smode), questions), qmode), validation
    )
    judge(report, chance(questions, qmode, validation))
    return report, cache


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--questions", choices=["choice", "noul"], default="choice")
    parser.add_argument("--state", choices=["full", "desc", "fields"], default="full")
    parser.add_argument("--criteria", choices=["plain", "rubric"], default="plain")
    parser.add_argument("--cache", default=".laya-cache")
    parser.add_argument("--out", default="d5-report.json")
    args = parser.parse_args()

    from huggingface_hub import snapshot_download
    import laya_coreml as laya

    path = snapshot_download(args.model, local_dir=Path(args.cache) / args.model.replace("/", "__"))
    agent = laya.load(str(path), local_files_only=True, compute_units="cpu")

    def ask(text, questions):
        answers = agent.predict(text, questions)["answers"]
        # choice: {"probabilities": {label: p}}; noul: {"noul": P(true)}
        return {
            qid: [float(v) for v in a["probabilities"].values()]
            if "probabilities" in a
            else [1 - float(a["noul"]), float(a["noul"])]
            for qid, a in answers.items()
        }

    def budget(questions):
        """Laya cuts each option at 48 tokens and the question part at 192: warn if hit."""
        from laya_coreml.common import render_options

        for qid, q in questions.items():
            opts = render_options(agent._to_internal(q))
            sizes = [1 + len(agent.tok(" " + o, add_special_tokens=False)["input_ids"]) for o in opts]
            if max(sizes) > 49 or sum(sizes) > 192 - 16:
                print(f"> ⚠️ {qid}: option tokens {sizes} hit Laya's limits (48 each, 176 total)")
                print()

    vocab = json.loads((HERE / "vocabulary.json").read_text(encoding="utf-8"))
    validation = json.loads((HERE / "validation.json").read_text(encoding="utf-8"))
    rubric = None
    if args.criteria == "rubric":
        rubric = json.loads((HERE / "rubric.json").read_text(encoding="utf-8"))
    budget(build_questions(vocab, validation, args.questions, rubric))
    report, cache = run(ask, vocab, validation, args.questions, args.state, rubric)
    title = f"{args.model} · {args.questions} · {args.state} · {args.criteria}"
    Path(args.out).write_text(json.dumps({"title": title, "report": report, "answers": cache}, indent=2))
    print(markdown(title, report))


if __name__ == "__main__":
    main()
