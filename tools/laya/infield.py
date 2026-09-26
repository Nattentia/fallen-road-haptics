"""4-2' (v5 3.3): can Laya make the judgements whose answer is in the text?

D5'  fill fields a game may leave empty, from the description alone:
     valence (for the player), actor, target, importance (by order).
D5'' judge a situation from moment + gauges: danger to the player, how
     decisive the moment is (by order).
Choice questions only, neutral labels, no "nothing"-like option (work log
2026-09-26-2, 12). Next to Laya: a keyword rule, the level a random
answerer reaches 95% of the time, and how often Laya's answer changes when
the options are listed in reverse. Runs on a macOS CI runner.
"""

import argparse
import json
import random
import re
from pathlib import Path

HERE = Path(__file__).parent

QUESTIONS = {
    "valence": ("For the player, this moment is", {
        "good": "good for the player",
        "bad": "bad for the player",
        "neutral": "neither good nor bad",
    }),
    "actor": ("Who started this exchange?", {
        "self": "the player",
        "other": "the opponent",
        "world": "the surroundings",
    }),
    "target": ("Who is on the receiving end?", {
        "self": "the player",
        "other": "the opponent",
        "world": "the surroundings",
    }),
    "importance": ("How much does this moment matter?", {
        "0": "hardly at all",
        "1": "a little",
        "2": "a lot",
        "3": "it decides the fight",
    }),
}
SITUATIONS = {
    "danger": ("How much danger is the player in?", {
        "0": "safe",
        "1": "some danger",
        "2": "serious danger",
        "3": "about to be hurt badly",
    }),
    "decisive": ("How decisive is this moment for the fight?", {
        "0": "routine",
        "1": "notable",
        "2": "a turning point",
    }),
}


def question(spec, reverse=False):
    text, options = spec
    keys = list(options)[::-1] if reverse else list(options)
    return {"type": "choice", "instructions": text,
            "criteria": {options[k]: None for k in keys}}, keys


def expected(p):
    return sum(i * x for i, x in enumerate(p)) / (len(p) - 1)


# --- keyword rule baseline -------------------------------------------------
# Built from the demo game's own phrasing only, as a hand-written table for
# that game would be. The reworded set shows what such a table misses.

def rule_valence(t):
    if re.search(r"misses|held back|cut short|called off", t):
        return "neutral"
    if re.search(r"hits player|player falls|shield breaks|guard blocks|parries", t):
        return "bad"
    return "good"


def rule_actor(t):
    if re.search(r"^enemy|enemy \w+ attack|player shield|player dodges", t):
        return "other"
    return "self"


def rule_importance(t):
    if re.search(r"boss|falls|breaks|fells|perfectly|last instant", t):
        return 0.95
    if re.search(r"heavily|head|unleashes|parries", t):
        return 0.7
    if re.search(r"misses|held back|cut short|called off", t):
        return 0.05
    return 0.5


def rule_level(qid, t):
    if qid == "danger":
        incoming = "winds up" in t
        low = "player health: low" in t
        bare = "shield durability: none" in t
        return 0 if not incoming else 3 if (low and bare) else 2 if (low or bare) else 1
    hit = re.search(r"smashes|slashes|hits player|misses", t)
    if "hits player" in t:
        return 2 if "player health: low" in t else 0
    if "misses" in t:
        return 1 if "enemy health: low" in t else 0
    return 2 if hit and "enemy health: low" in t else 0


# --- scoring -----------------------------------------------------------------

def order_score(values, truths, gap):
    pairs = [(i, j) for i in range(len(values)) for j in range(len(values))
             if truths[i] - truths[j] >= gap]
    if not pairs:
        return None
    return sum(values[i] > values[j] for i, j in pairs) / len(pairs)


def chance(n, k, runs=2000, seed=9):
    """95th percentile accuracy of a random answerer over n items, k options."""
    rng = random.Random(seed)
    s = sorted(sum(rng.randrange(k) == 0 for _ in range(n)) / n for _ in range(runs))
    return s[int(0.95 * runs)]


def order_chance(truths, gap, runs=500, seed=9):
    rng = random.Random(seed)
    s = sorted(order_score([rng.random() for _ in truths], truths, gap) for _ in range(runs))
    return s[int(0.95 * runs)]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default="aac6fef/laya-multilingual-coreml-ane")
    parser.add_argument("--cache", default=".laya-cache")
    parser.add_argument("--out", default="infield-report.json")
    args = parser.parse_args()

    from huggingface_hub import snapshot_download
    import laya_coreml as laya

    path = snapshot_download(args.model, local_dir=Path(args.cache) / args.model.replace("/", "__"))
    agent = laya.load(str(path), local_files_only=True, compute_units="cpu")
    data = json.loads((HERE / "infield.json").read_text(encoding="utf-8"))

    def ask(text, specs):
        qs, keys = {}, {}
        for qid, spec in specs.items():
            qs[qid], keys[qid] = question(spec)
            qs[qid + "~rev"], keys[qid + "~rev"] = question(spec, reverse=True)
        answers = agent.predict(text, qs)["answers"]
        out = {}
        for qid in specs:
            fwd = list(answers[qid]["probabilities"].values())
            rev = list(answers[qid + "~rev"]["probabilities"].values())[::-1]
            pick = lambda p: keys[qid][max(range(len(p)), key=p.__getitem__)]
            out[qid] = {"p": fwd, "pick": pick(fwd), "flip": pick(fwd) != pick(rev)}
        return out

    report, rows = {}, []
    for name in ("game", "reworded"):
        items = data[name]
        answers = [ask(it["text"], QUESTIONS) for it in items]
        for it, a in zip(items, answers):
            rows.append({"set": name, "text": it["text"], **{q: a[q]["pick"] for q in QUESTIONS}})
        n = len(items)
        for qid, rule in (("valence", rule_valence), ("actor", rule_actor)):
            report[f"{name} {qid}"] = {
                "n": n,
                "laya": sum(a[qid]["pick"] == it[qid] for it, a in zip(items, answers)) / n,
                "rule": sum(rule(it["text"]) == it[qid] for it in items) / n,
                "chance95": chance(n, len(QUESTIONS[qid][1])),
                "flip": sum(a[qid]["flip"] for a in answers) / n,
            }
        opposite = {"self": "other", "other": "self", "world": "self"}
        report[f"{name} target"] = {
            "n": n,
            "laya": sum(a["target"]["pick"] == it["target"] for it, a in zip(items, answers)) / n,
            "rule": sum(opposite[rule_actor(it["text"])] == it["target"] for it in items) / n,
            "chance95": chance(n, 3),
            "flip": sum(a["target"]["flip"] for a in answers) / n,
        }
        truths = [it["importance"] for it in items]
        report[f"{name} importance (order)"] = {
            "n": n,
            "laya": order_score([expected(a["importance"]["p"]) for a in answers], truths, 0.3),
            "rule": order_score([rule_importance(it["text"]) for it in items], truths, 0.3),
            "chance95": order_chance(truths, 0.3),
            "flip": sum(a["importance"]["flip"] for a in answers) / n,
        }

    for qid, spec in SITUATIONS.items():
        items = data[qid]
        answers = [ask(it["text"], {qid: spec})[qid] for it in items]
        truths = [it["level"] for it in items]
        report[f"{qid} (order)"] = {
            "n": len(items),
            "laya": order_score([expected(a["p"]) for a in answers], truths, 1),
            "rule": order_score([rule_level(qid, it["text"]) for it in items], truths, 1),
            "chance95": order_chance(truths, 1),
            "flip": sum(a["flip"] for a in answers) / len(items),
        }
        for it, a in zip(items, answers):
            rows.append({"set": qid, "text": it["text"], "level": it["level"], qid: a["pick"]})

    for r in report.values():
        r["pass"] = r["laya"] > r["chance95"] and r["flip"] <= 0.15
        r["beats rule"] = r["laya"] > r["rule"]
    Path(args.out).write_text(json.dumps({"model": args.model, "report": report, "rows": rows}, indent=2),
                              encoding="utf-8")
    print(f"### 4-2' in-text judgements: {args.model}\n")
    print("| question | n | Laya | rule | chance (95%) | flips | beats chance, stable | beats rule |")
    print("|---|---|---|---|---|---|---|---|")
    for name, r in report.items():
        print(f"| {name} | {r['n']} | {r['laya']:.2f} | {r['rule']:.2f} | {r['chance95']:.2f} | "
              f"{r['flip']:.2f} | {'✅' if r['pass'] else '❌'} | {'✅' if r['beats rule'] else '❌'} |")


if __name__ == "__main__":
    main()
