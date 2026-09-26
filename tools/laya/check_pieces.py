"""Local check of the phrase pieces with only the tokenizer (no model).

    python tools/laya/check_pieces.py --tokenizer <dir with tokenizer.json> \
        --laya-src <dir holding laya_coreml's common.py>

CI runs the same verify() inside prepare.py with the installed laya_coreml.
"""

import argparse
import importlib.util
import json
import sys
from pathlib import Path

from tokenizers import Tokenizer as Backend

sys.path.insert(0, str(Path(__file__).parent))
import pieces  # noqa: E402


class Tok:
    """Same interface as laya_coreml.tokenizer.Tokenizer."""

    def __init__(self, path):
        path = Path(path)
        self.backend = Backend.from_file(str(path / "tokenizer.json"))
        self.backend.no_padding()
        self.backend.no_truncation()
        config = json.loads((path / "tokenizer_config.json").read_text())
        for name in ("cls_token", "sep_token", "pad_token", "mask_token"):
            value = config.get(name)
            if isinstance(value, dict):
                value = value.get("content")
            setattr(self, name, value)
            setattr(self, name + "_id", self.backend.token_to_id(value))

    def __call__(self, text, add_special_tokens=False):
        return {"input_ids": self.backend.encode(text, add_special_tokens=add_special_tokens).ids}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--tokenizer", required=True)
    parser.add_argument("--laya-src", required=True)
    parser.add_argument("--vocabulary", default=str(Path(__file__).parent / "vocabulary.json"))
    args = parser.parse_args()

    spec = importlib.util.spec_from_file_location("laya_common", Path(args.laya_src) / "common.py")
    common = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(common)

    tok = Tok(args.tokenizer)
    vocab = json.loads(Path(args.vocabulary).read_text(encoding="utf-8"))
    questions = [
        {"id": q["id"], "internal": {"t": q["type"], "ins": q["instructions"],
                                     "crit": dict.fromkeys(q["criteria"])}}
        for q in vocab["questions"]
    ]
    ids, prefixes = pieces.verify(
        tok, vocab["pieces"], questions, common.build_prefix, common.build_sequence,
        max_len=512, head_max_len=192,
    )
    longest = max(len(t) for t in ids.values())
    print(f"ok: {len(ids)} phrases, pairs and 20000 sequences exact; longest phrase {longest} tokens")
    for qid, (prefix, markers) in prefixes.items():
        print(f"  {qid}: prefix {len(prefix)} tokens, {len(markers)} options")


if __name__ == "__main__":
    main()
