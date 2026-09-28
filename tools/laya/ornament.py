"""Probe whether the shipped Laya checkpoint can select scene haptic flourishes.

Human labels and two phrasings are fixed below before running inference. The
keyword baseline uses the demo game's common wording. This is an offline
diagnostic, not a production classifier or a tuning set.
"""

import argparse
import json
import re
from pathlib import Path


# label, game-style text, equivalent paraphrase
CASES = [
    ("anticipation", "enemy winds up a slash attack toward player.", "the foe draws its blade back to strike the hero."),
    ("anticipation", "boss charges a heavy attack at player.", "the giant gathers force for a blow that has yet to land."),
    ("anticipation", "enemy raises sword before attacking player.", "a hostile fighter lifts steel over the hero's head."),
    ("anticipation", "enemy draws bow to shoot player.", "an archer takes aim at the hero before releasing the arrow."),
    ("anticipation", "trap prepares to fire at player.", "the floor mechanism clicks into place beneath the hero."),
    ("anticipation", "monster prepares to lunge at player.", "the creature crouches, ready to spring toward the hero."),
    ("relief", "player dodges enemy slash at the last instant.", "the hero slips clear of a blade by a hair."),
    ("relief", "player shield blocks enemy heavy attack.", "the hero catches the crushing blow on a shield."),
    ("relief", "player parries enemy sword attack.", "the hero turns aside an incoming blade."),
    ("relief", "enemy arrow misses player.", "the shot sails harmlessly past the hero."),
    ("relief", "player escapes enemy grab.", "the hero wriggles free of the monster's grasp."),
    ("relief", "player avoids the trap as it fires.", "the floor mechanism snaps shut behind the escaping hero."),
    ("triumph", "player fells the enemy.", "the foe collapses after the hero's final strike."),
    ("triumph", "player defeats the boss.", "the giant is beaten and the hero stands victorious."),
    ("triumph", "player kills the last enemy.", "the final opponent drops, ending the fight."),
    ("triumph", "player wins the duel.", "the hero emerges as victor of the duel."),
    ("triumph", "enemy surrenders to player.", "the defeated foe lays down its weapon before the hero."),
    ("triumph", "player lands the finishing blow on enemy.", "the hero's strike ends the opponent's resistance."),
    ("setback", "enemy slash attack hits player.", "the hero takes the foe's blade across the chest."),
    ("setback", "player shield breaks under enemy attack.", "the hero's protection splinters from the blow."),
    ("setback", "player falls after enemy strike.", "the foe knocks the hero to the ground."),
    ("setback", "enemy attack stuns player.", "the hero reels, dazed by the impact."),
    ("setback", "player health drops from enemy hit.", "the foe's blow leaves the hero badly hurt."),
    ("setback", "boss grabs and crushes player.", "the giant catches the hero and squeezes hard."),
]

OPTIONS = {
    "anticipation": "anticipation: a threat is about to land",
    "relief": "relief: the player has just escaped or stopped a threat",
    "triumph": "triumph: the player has won or defeated an opponent",
    "setback": "setback: the player has been hurt or lost a defense",
}
KEYS = list(OPTIONS)


def rule(text):
    """Fixed keyword baseline based on the demo's usual phrasing."""
    if re.search(r"hits player|shield breaks|player falls|stuns player|health drops|crushes player", text):
        return "setback"
    if re.search(r"fells|defeats|kills|wins|surrenders|finishing blow", text):
        return "triumph"
    if re.search(r"dodges|shield blocks|parries|misses|escapes|avoids", text):
        return "relief"
    return "anticipation"


def score(rows, field, phrasing):
    subset = [r for r in rows if r["phrasing"] == phrasing]
    return sum(r[field] == r["truth"] for r in subset) / len(subset)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default="aac6fef/laya-multilingual-coreml-ane")
    parser.add_argument("--cache", default=".laya-cache")
    parser.add_argument("--out", default="ornament-report.json")
    args = parser.parse_args()

    from huggingface_hub import snapshot_download
    import laya_coreml as laya

    path = snapshot_download(args.model, local_dir=Path(args.cache) / args.model.replace("/", "__"))
    agent = laya.load(str(path), local_files_only=True, compute_units="cpu")
    rows = []
    for truth, game, reworded in CASES:
        for phrasing, text in (("game", game), ("reworded", reworded)):
            questions = {}
            for reverse in (False, True):
                order = KEYS[::-1] if reverse else KEYS
                questions["reverse" if reverse else "forward"] = {
                    "type": "choice",
                    "instructions": "What haptic flourish fits this moment for the player?",
                    "criteria": {OPTIONS[key]: None for key in order},
                }
            answers = agent.predict(text, questions)["answers"]
            probabilities = {
                direction: {key: answers[direction]["probabilities"][OPTIONS[key]] for key in KEYS}
                for direction in ("forward", "reverse")
            }
            pick = lambda probs: max(KEYS, key=lambda key: probs[key])
            both = {key: (probabilities["forward"][key] + probabilities["reverse"][key]) / 2 for key in KEYS}
            rows.append({
                "truth": truth, "phrasing": phrasing, "text": text,
                "rule": rule(text), "one_way": pick(probabilities["forward"]),
                "reverse": pick(probabilities["reverse"]), "laya": pick(both),
                "both_probabilities": both,
            })

    metrics = {}
    for phrasing in ("game", "reworded", "all"):
        subset = rows if phrasing == "all" else [r for r in rows if r["phrasing"] == phrasing]
        metrics[phrasing] = {
            "n": len(subset),
            "laya": sum(r["laya"] == r["truth"] for r in subset) / len(subset),
            "one_way": sum(r["one_way"] == r["truth"] for r in subset) / len(subset),
            "rule": sum(r["rule"] == r["truth"] for r in subset) / len(subset),
            "option_flip": sum(r["one_way"] != r["reverse"] for r in subset) / len(subset),
        }
    metrics["paraphrase_agreement"] = sum(rows[i]["laya"] == rows[i + 1]["laya"] for i in range(0, len(rows), 2)) / len(CASES)
    result = {"model": args.model, "task": "scene haptic flourish", "metrics": metrics, "rows": rows}
    Path(args.out).write_text(json.dumps(result, indent=2, ensure_ascii=False), encoding="utf-8")
    print("### Laya scene haptic flourish experiment\n")
    print("| phrasing | n | Laya both ways | Laya one way | keyword rule | option flip |")
    print("|---|---:|---:|---:|---:|---:|")
    for phrasing in ("game", "reworded", "all"):
        m = metrics[phrasing]
        print(f"| {phrasing} | {m['n']} | {m['laya']:.2f} | {m['one_way']:.2f} | {m['rule']:.2f} | {m['option_flip']:.2f} |")
    print(f"\nParaphrase agreement: {metrics['paraphrase_agreement']:.2f}")
    print("Balanced four-way chance: 0.25. Labels are human assigned; this small synthetic set is diagnostic only.")


if __name__ == "__main__":
    main()
