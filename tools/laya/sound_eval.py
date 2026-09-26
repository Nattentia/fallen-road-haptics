"""D5 sound experiment: can Laya judge hardness and weight from a sound? (macOS CI)

A sound's features (tools/laya/sound_features.mjs, the upscaler's own analysis)
are put into words: pitch, onset, length, decay, grain. Only measurement is
turned into words; nothing says "hard" or "heavy".

Two sets:
  kenney  130 CC0 impact sounds whose file names give the truth
          (soft < wood < hard material; light < medium < heavy within one
          material). Scored on pairs: does the harder/heavier one get the
          higher answer? Chance is 0.5.
  game    the order checks of validation.json between game moments, asked
          with the description alone and with the words of the sound the
          game plays at that moment.
Next to Laya: the best single-feature rule (its direction picked after
looking, so an optimistic ceiling), a random answerer, and how often Laya's
answer changes when the options are listed in reverse.
"""

import argparse
import itertools
import json
import random
import re
from pathlib import Path

HERE = Path(__file__).parent

HARDNESS = {
    0: ["footstep_carpet", "footstep_grass", "footstep_snow", "impactSoft_heavy",
        "impactSoft_medium", "impactPunch_heavy", "impactPunch_medium"],
    1: ["footstep_wood", "impactWood_heavy", "impactWood_light", "impactWood_medium",
        "impactPlank_medium"],
    2: ["footstep_concrete", "impactMetal_heavy", "impactMetal_light", "impactMetal_medium",
        "impactPlate_heavy", "impactPlate_light", "impactPlate_medium", "impactTin_medium",
        "impactBell_heavy", "impactGlass_heavy", "impactGlass_light", "impactGlass_medium",
        "impactMining"],
}
HARD_OF = {c: level for level, cs in HARDNESS.items() for c in cs}
WEIGHT = {"light": 0, "medium": 1, "heavy": 2}


def words(f):
    """Measurement in plain words (fixed bins)."""
    b, s = f["brightness"], f["brightnessStart"]
    pitch = ("very deep" if b < 0.15 else "deep" if b < 0.3 else "middle-pitched" if b < 0.5
             else "high" if b < 0.7 else "very high")
    onset = "dull onset" if s < 0.3 else "soft-edged onset" if s < 0.6 else "clicky onset"
    d = f["durationMs"]
    length = "very short" if d < 150 else "short" if d < 300 else "medium length" if d < 500 else "long"
    k = f["decayMs"]
    decay = "stops at once" if k < 40 else "dies away quickly" if k < 100 else "rings on"
    n = f["noisiness"]
    grain = "clean tone" if n < 0.01 else "a little grainy" if n < 0.05 else "grainy"
    return f"sound: {pitch}, {onset}, {length}, {decay}, {grain}."


def cls(name):
    return re.sub(r"_\d+\.(ogg|wav)$", "", name)


def kenney_pairs(sounds):
    names = [n for n in sounds if cls(n) in HARD_OF]
    hard = [(a, b, HARD_OF[cls(a)] > HARD_OF[cls(b)])
            for a, b in itertools.combinations(names, 2) if HARD_OF[cls(a)] != HARD_OF[cls(b)]]
    wn = [n for n in sounds if cls(n).rsplit("_", 1)[-1] in WEIGHT]
    fam = lambda n: cls(n).rsplit("_", 1)[0]
    lvl = lambda n: WEIGHT[cls(n).rsplit("_", 1)[-1]]
    weight = [(a, b, lvl(a) > lvl(b)) for a, b in itertools.combinations(wn, 2)
              if fam(a) == fam(b) and lvl(a) != lvl(b)]
    return {"hardness": hard, "weight": weight}


GAME_SOUND = [  # which sound the game plays with a moment (signal.sound)
    (r"shield blocks|shield perfectly", "player_block_1.ogg"),
    (r"guard blocks|parries", "enemy_block_1.ogg"),
    (r"attack hits player", "player_hit_1.ogg"),
    (r"daggers", "hit_dagger_1.ogg"),
    (r"hammer", "hit_hammer_1.ogg"),
    (r"mace", "hit_mace_1.ogg"),
    (r"spear", "hit_spear_1.ogg"),
    (r"sword", "hit_sword_1.ogg"),
]


def game_sound(state):
    if not state.startswith(("player ", "enemy ")):
        return None
    for pattern, sound in GAME_SOUND:
        if re.search(pattern, state):
            return sound
    return None


def expected(p):
    return sum(i * x for i, x in enumerate(p)) / (len(p) - 1)


def pair_score(value, pairs):
    return sum((value(a) > value(b)) == truth for a, b, truth in pairs) / len(pairs)


def chance95(pairs, names, runs=500, seed=7):
    rng = random.Random(seed)
    scores = []
    for _ in range(runs):
        v = {n: rng.random() for n in names}
        scores.append(pair_score(v.__getitem__, pairs))
    scores.sort()
    return scores[int(0.95 * runs)]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default="aac6fef/laya-multilingual-coreml-ane")
    parser.add_argument("--cache", default=".laya-cache")
    parser.add_argument("--out", default="sound-report.json")
    args = parser.parse_args()

    from huggingface_hub import snapshot_download
    import laya_coreml as laya

    path = snapshot_download(args.model, local_dir=Path(args.cache) / args.model.replace("/", "__"))
    agent = laya.load(str(path), local_files_only=True, compute_units="cpu")

    vocab = json.loads((HERE / "vocabulary.json").read_text(encoding="utf-8"))
    qs = {}
    for q in vocab["questions"]:
        if q["id"] in ("hardness", "weight"):
            d = {"type": "choice", "instructions": q["instructions"], "criteria": q["criteria"]}
            qs[q["id"]] = d
            qs[q["id"] + "~rev"] = {**d, "criteria": q["criteria"][::-1]}

    cache = {}

    def ask(text):
        if text not in cache:
            ans = agent.predict(text, qs)["answers"]
            out = {}
            for qid in ("hardness", "weight"):
                fwd = list(ans[qid]["probabilities"].values())
                rev = list(ans[qid + "~rev"]["probabilities"].values())[::-1]
                out[qid] = {"v": expected(fwd), "flip": max(range(5), key=fwd.__getitem__)
                            != max(range(5), key=rev.__getitem__)}
            cache[text] = out
        return cache[text]

    report = {}
    kenney = json.loads((HERE / "sound-kenney.json").read_text(encoding="utf-8"))
    text_of = {n: "something hits a surface. " + words(f) for n, f in kenney.items()}
    for qid, pairs in kenney_pairs(kenney).items():
        names = sorted({n for a, b, _ in pairs for n in (a, b)})
        rule = pair_score(lambda n: -kenney[n]["brightnessStart"] if qid == "weight"
                          else kenney[n]["brightnessStart"], pairs)
        report[f"kenney {qid}"] = {
            "pairs": len(pairs),
            "laya": pair_score(lambda n: ask(text_of[n])[qid]["v"], pairs),
            "rule": rule,
            "chance95": chance95(pairs, names),
            "flip": sum(ask(text_of[n])[qid]["flip"] for n in names) / len(names),
        }

    game = json.loads((HERE / "sound-game.json").read_text(encoding="utf-8"))
    validation = json.loads((HERE / "validation.json").read_text(encoding="utf-8"))
    checks = [c for c in validation["order"] if c["question"] in ("hardness", "weight")
              and game_sound(c["higher"]) and game_sound(c["lower"])]
    for label, with_sound in (("game, description only", False), ("game, description + sound", True)):
        text = (lambda s: f"{s} {words(game[game_sound(s)])}") if with_sound else (lambda s: s)
        right = sum(ask(text(c["higher"]))[c["question"]]["v"] > ask(text(c["lower"]))[c["question"]]["v"]
                    for c in checks)
        report[label] = {"pairs": len(checks), "laya": right / len(checks)}

    Path(args.out).write_text(json.dumps({"model": args.model, "report": report,
                                          "texts": {n: text_of[n] for n in sorted(kenney)},
                                          "answers": cache}, indent=2), encoding="utf-8")
    print(f"### Sound → hardness / weight: {args.model}\n")
    print("| set | pairs | Laya | best rule | chance (95%) | flips when reversed |")
    print("|---|---|---|---|---|---|")
    for name, r in report.items():
        cells = [f"{r[k]:.2f}" if k in r else "–" for k in ("laya", "rule", "chance95", "flip")]
        print(f"| {name} | {r['pairs']} | " + " | ".join(cells) + " |")


if __name__ == "__main__":
    main()
