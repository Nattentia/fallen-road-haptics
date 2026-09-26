"""Can Laya tell what a blow lands on: a shield, a body, or nothing? (macOS CI)

The answer is in the text ("blocks", "hits", "misses"), so this is the kind of
judgement Laya is built for. Two sets:
  game        every event piece of the demo game (vocabulary.json), labelled
              from its wording
  reworded    hand-written moments that avoid the game's keywords, so a
              keyword rule cannot pass them by matching words
Reported per set: Laya accuracy, the keyword rule's accuracy, the level a
random answerer reaches 95% of the time, and how often Laya's answer changes
when the options are listed in reverse.
"""

import argparse
import json
import random
import re
from pathlib import Path

HERE = Path(__file__).parent
LABELS = ["shield", "body", "nothing"]
CRITERIA = {
    "a shield or guard": "the blow is blocked, parried or countered",
    "a body": "the blow lands on flesh",
    "nothing": "the blow misses or is dodged",
}
QUESTION = {"type": "choice", "instructions": "What does the blow land on?"}

REWORDED = [
    ("the enemy raises a buckler and the sword glances off it.", "shield"),
    ("sparks fly as the blade meets the enemy's round shield.", "shield"),
    ("the enemy catches the blow on his wooden board.", "shield"),
    ("the hammer rings against the knight's raised plate.", "shield"),
    ("the blade bites into the enemy's arm.", "body"),
    ("the spear sinks into the enemy's side.", "body"),
    ("the mace crunches into the enemy's ribs.", "body"),
    ("the player takes the thrust in the shoulder.", "body"),
    ("the axe swing whistles through empty air.", "nothing"),
    ("the enemy steps aside and the dagger finds nothing.", "nothing"),
    ("the player ducks and the club sails overhead.", "nothing"),
    ("the arrow flies wide of its target.", "nothing"),
]


def label(piece):
    """Label a game event piece from its wording, or None if it is not a blow."""
    p = piece.lower()
    if ":" in p or "crosses" in p or "winds up" in p or "breaks" in p or "called off" in p:
        return None
    if re.search(r"\b(blocks|parries|counters)\b", p):
        return "shield"
    if re.search(r"\b(misses|dodges)\b", p):
        return "nothing"
    if re.search(r"\b(hits|slashes|stabs|smashes|bashes|thrusts at)\b", p):
        return "body"
    return None


def rule(text):
    """Keyword baseline: the words a hand-written table would look for."""
    t = text.lower()
    if re.search(r"\b(shield|guard|blocks?|parr\w*|counters?)\b", t):
        return "shield"
    if re.search(r"\b(miss\w*|dodg\w*)\b", t):
        return "nothing"
    return "body"


def chance95(n, k=3, runs=2000, seed=5):
    rng = random.Random(seed)
    scores = sorted(sum(rng.randrange(k) == 0 for _ in range(n)) / n for _ in range(runs))
    return scores[int(0.95 * runs)]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default="aac6fef/laya-multilingual-coreml-ane")
    parser.add_argument("--criteria", choices=["plain", "described"], default="described")
    parser.add_argument("--cache", default=".laya-cache")
    parser.add_argument("--out", default="surface-report.json")
    args = parser.parse_args()

    from huggingface_hub import snapshot_download
    import laya_coreml as laya

    path = snapshot_download(args.model, local_dir=Path(args.cache) / args.model.replace("/", "__"))
    agent = laya.load(str(path), local_files_only=True, compute_units="cpu")

    names = list(CRITERIA)
    crit = CRITERIA if args.criteria == "described" else names
    rev = {k: CRITERIA[k] for k in reversed(names)} if args.criteria == "described" else names[::-1]
    questions = {"fwd": {**QUESTION, "criteria": crit}, "rev": {**QUESTION, "criteria": rev}}

    vocab = json.loads((HERE / "vocabulary.json").read_text(encoding="utf-8"))
    sets = {
        "game": [(p, label(p)) for p in vocab["pieces"] if label(p)],
        "reworded": REWORDED,
    }
    report, rows = {}, []
    for name, items in sets.items():
        right = flips = by_rule = 0
        for text, want in items:
            ans = agent.predict(text, questions)["answers"]
            fwd = LABELS[names.index(ans["fwd"]["choice"])]
            back = LABELS[names.index(ans["rev"]["choice"])]
            right += fwd == want
            flips += fwd != back
            by_rule += rule(text) == want
            rows.append({"set": name, "text": text, "want": want, "laya": fwd, "reversed": back,
                         "rule": rule(text), "p": ans["fwd"]["probabilities"]})
        n = len(items)
        report[name] = {"n": n, "laya": right / n, "rule": by_rule / n,
                        "chance95": chance95(n), "flip": flips / n}

    title = f"{args.model} · {args.criteria}"
    Path(args.out).write_text(json.dumps({"title": title, "report": report, "rows": rows}, indent=2),
                              encoding="utf-8")
    print(f"### Shield / body / nothing: {title}\n")
    print("| set | n | Laya | rule | chance (95%) | flips when reversed |")
    print("|---|---|---|---|---|---|")
    for name, r in report.items():
        print(f"| {name} | {r['n']} | {r['laya']:.2f} | {r['rule']:.2f} | {r['chance95']:.2f} | {r['flip']:.2f} |")
    print("\nMisses:\n")
    for r in rows:
        if r["laya"] != r["want"]:
            print(f"- [{r['set']}] {r['text']} → {r['laya']} (want {r['want']})")


if __name__ == "__main__":
    main()
