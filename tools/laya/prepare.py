"""Prepare Laya assets for the iOS app (runs on the macOS CI runner).

The haptic decision questions and the game-state grid are fixed, so
tokenization happens here, once. The app only does what must happen on the
phone: embedding lookup, the Core ML encoder body, and answer decoding.

Outputs (ios/App/Laya/):
  prompts.json        questions, states and pre-tokenized items (compact ids)
  live.json           live-question prefixes and pre-tokenized state phrases
                      (compact ids), proven here to join exactly (pieces.py)
  golden-live-<variant>.json  reference answers for sample live states
  embed.f16           float16 rows for every token id the items use
  type_emb.f16        float16 question-type embeddings (3 x hidden)
  golden-<variant>.json  reference probabilities from the Python runtime
  <variant>.mlpackage copied for compilation by coremlcompiler
"""

import argparse
import itertools
import json
import random
import shutil
import sys
import time
from pathlib import Path

import numpy as np
from huggingface_hub import snapshot_download
from safetensors import safe_open

import laya_coreml as laya
from laya_coreml.common import build_prefix, build_sequence, temp_bucket

sys.path.insert(0, str(Path(__file__).parent))
import pieces  # noqa: E402

VARIANTS = {
    "fp16": "aac6fef/laya-multilingual-coreml-ane",
    "w8": "aac6fef/laya-multilingual-coreml-ane-w8",
}

QUESTIONS = {
    "motif": {
        "type": "choice",
        "instructions": "Which haptic motif fits this blade contact?",
        "criteria": ["tick", "strike", "scrape", "buzz", "bounce"],
    },
    "heavy": {
        "type": "score",
        "instructions": "How heavy should the impact feel?",
        "criteria": ["none", "light", "medium", "heavy", "crushing"],
    },
    "crisp": {
        "type": "score",
        "instructions": "How crisp and sharp should it feel?",
        "criteria": ["dull", "soft", "medium", "crisp", "piercing"],
    },
    "grain": {
        "type": "score",
        "instructions": "How grainy should the texture be?",
        "criteria": ["smooth", "slight", "medium", "rough", "gritty"],
    },
}

GRID = {
    "zone": ["head", "torso", "legs", "hand"],
    "weapon": ["sword", "spear", "hammer", "dagger", "mace"],
    "speed": ["slow", "medium", "fast"],
    "enemy": ["open", "guarding"],
}


def state_text(zone, weapon, speed, enemy):
    return f"blade contact. zone: {zone}. weapon: {weapon}. speed: {speed}. enemy: {enemy}."


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default="ios/App/Laya")
    parser.add_argument("--cache", default=".laya-cache")
    parser.add_argument("--vocabulary", default=str(Path(__file__).parent / "vocabulary.json"))
    args = parser.parse_args()
    out, cache = Path(args.out), Path(args.cache)
    out.mkdir(parents=True, exist_ok=True)

    bundles = {
        name: Path(snapshot_download(repo, local_dir=cache / name))
        for name, repo in VARIANTS.items()
    }
    # CI runners are VMs without a usable Neural Engine; CPU gives the reference.
    agents = {
        name: laya.load(str(path), local_files_only=True, compute_units="cpu")
        for name, path in bundles.items()
    }
    ref = agents["fp16"]
    max_len = ref.shape["max_length"]

    states = [
        {"id": "|".join(combo), "text": state_text(*combo)}
        for combo in itertools.product(*GRID.values())
    ]

    items, used = [], {ref.tok.pad_token_id}
    for state in states:
        prepared, _ = ref.prepare(state["text"], QUESTIONS)
        row = []
        for (qid, q), item in zip(QUESTIONS.items(), prepared):
            if len(item["ids"]) > max_len:
                raise SystemExit(f"{qid} @ {state['id']}: {len(item['ids'])} tokens > {max_len}")
            k = len(item["markers"])
            qt = int(item["qtype"])
            scale = ref.temperature_by_options.get(temp_bucket(qt, k), ref.temperature[qt])
            row.append({"ids": item["ids"], "markers": item["markers"], "qtype": qt, "scale": scale})
            used.update(item["ids"])
        items.append(row)

    # Live questions: prefixes whole, state phrases one by one, joined on the
    # phone. verify() stops the build if joining would differ from the real
    # tokenizer anywhere.
    vocab = json.loads(Path(args.vocabulary).read_text(encoding="utf-8"))
    live_defs = {
        q["id"]: {"type": q["type"], "instructions": q["instructions"], "criteria": q["criteria"]}
        for q in vocab["questions"]
    }
    live_questions = [
        {"id": qid, "internal": ref._to_internal(d)} for qid, d in live_defs.items()
    ]
    head_max_len = ref.cfg.get("head_max_len", 192)
    piece_ids, prefixes = pieces.verify(
        ref.tok, vocab["pieces"], live_questions, build_prefix, build_sequence,
        max_len=max_len, head_max_len=head_max_len,
    )
    for prefix, _ in prefixes.values():
        used.update(prefix)
    for ids in piece_ids.values():
        used.update(ids)
    used.add(ref.tok.sep_token_id)
    print(f"live: {len(piece_ids)} phrases verified, {len(prefixes)} questions")

    # Compact embedding table: only rows the fixed prompts can reach.
    vocab = sorted(used)
    compact = {tid: i for i, tid in enumerate(vocab)}
    rows = {}
    for name, path in bundles.items():
        with safe_open(str(path / "host_weights.safetensors"), framework="numpy") as w:
            table = w.get_tensor("encoder.embeddings.tok_embeddings.weight")
            rows[name] = (
                table[vocab].astype(np.float16),
                w.get_tensor("type_emb.weight").astype(np.float16),
            )
    if not all(np.array_equal(rows["fp16"][i], rows["w8"][i]) for i in (0, 1)):
        raise SystemExit("Host embeddings differ between variants; ship one table per variant")
    embed, type_emb = rows["fp16"]
    embed.tofile(out / "embed.f16")
    type_emb.tofile(out / "type_emb.f16")

    prompts = {
        "max_length": max_len,
        "max_options": 32,
        "hidden": int(embed.shape[1]),
        "local_attention": int(ref.encoder_cfg.get("local_attention", 128)),
        "pad": compact[ref.tok.pad_token_id],
        "vocab_rows": len(vocab),
        "questions": [
            {"id": qid, "type": q["type"], "labels": q["criteria"]} for qid, q in QUESTIONS.items()
        ],
        "states": states,
        "items": [
            [
                {
                    "ids": [compact[t] for t in item["ids"]],
                    "markers": item["markers"],
                    "qtype": item["qtype"],
                    "scale": item["scale"],
                }
                for item in row
            ]
            for row in items
        ],
    }
    (out / "prompts.json").write_text(json.dumps(prompts, separators=(",", ":")))

    live = {
        "max_length": max_len,
        "pad": compact[ref.tok.pad_token_id],
        "sep": compact[ref.tok.sep_token_id],
        "questions": [],
        "pieces": {p: [compact[t] for t in ids] for p, ids in piece_ids.items()},
    }
    for q in live_questions:
        prefix, markers = prefixes[q["id"]]
        qt = {"choice": 0, "score": 1, "noul": 2}[q["internal"]["t"]]
        k = len(markers)
        live["questions"].append({
            "id": q["id"],
            "qtype": qt,
            "scale": ref.temperature_by_options.get(temp_bucket(qt, k), ref.temperature[qt]),
            "prefix": [compact[t] for t in prefix],
            "markers": markers,
            "labels": live_defs[q["id"]]["criteria"],
        })
    (out / "live.json").write_text(json.dumps(live, separators=(",", ":")))

    # Sample live states with reference answers, for the on-device parity check.
    rng = random.Random(11)
    live_states = [
        pieces.fit(
            max((pf for pf, _ in prefixes.values()), key=len), piece_ids,
            [rng.choice(vocab["pieces"]) for _ in range(rng.randint(3, 8))], max_len,
        )
        for _ in range(24)
    ]

    for name, agent in agents.items():
        golden, started = [], time.perf_counter()
        for state in states:
            answers = agent.predict(state["text"], QUESTIONS)["answers"]
            golden.append(
                [[float(v) for v in answers[qid]["probabilities"].values()] for qid in QUESTIONS]
            )
        elapsed = time.perf_counter() - started
        (out / f"golden-{name}.json").write_text(
            json.dumps({"compute_units": agent.compute_units, "probabilities": golden})
        )
        live_golden = [
            {
                "phrases": st,
                "probabilities": {
                    qid: [float(v) for v in a["probabilities"].values()]
                    for qid, a in agent.predict(" ".join(st), live_defs)["answers"].items()
                },
            }
            for st in live_states
        ]
        (out / f"golden-live-{name}.json").write_text(json.dumps(live_golden))
        shutil.copytree(bundles[name] / "model.mlpackage", out / f"{name}.mlpackage", dirs_exist_ok=True)
        print(f"{name}: {len(states) * len(QUESTIONS)} golden decisions in {elapsed:.1f}s")

    print(f"states={len(states)} vocab_rows={len(vocab)} max_ids={max(len(i['ids']) for r in items for i in r)}")


if __name__ == "__main__":
    main()
