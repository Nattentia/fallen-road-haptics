"""Pre-tokenized state phrases for the phone, and the proof that joining them
is exact.

The phone has no tokenizer. A Laya input is
    [CLS] <question> [SEP] [MASK] opt0 [MASK] opt1 ... [SEP] <state> [SEP]
where the question part is fixed per question and <state> is the live state
as phrases joined by single spaces. So the phone keeps the question prefix
and each phrase's tokens, and joins them. That is only correct if no token
ever spans the space between two phrases. verify() checks it three ways and
raises on the first difference:
  1. every phrase is clean (no leading, trailing or doubled spaces);
  2. every ordered pair of phrases, joined, tokenizes to the two token lists
     one after the other;
  3. many random phrase sequences, and whole Laya items built from them,
     match the reference construction exactly.
"""

import random
import re

CLEAN = re.compile(r"^\S+( \S+)*$")


class PieceMismatch(SystemExit):
    pass


def encode(tok, text):
    return tok(text, add_special_tokens=False)["input_ids"]


def piece_ids(tok, pieces):
    return {p: encode(tok, p) for p in pieces}


def fit(prefix, pieces_ids, phrases, max_len):
    """Whole phrases, in order, while the item stays within max_len.

    Phrases come most important first, so a state that is too long loses
    its last phrases, never part of one.
    """
    room = max(0, max_len - len(prefix) - 1)
    kept, used = [], 0
    for p in phrases:
        n = len(pieces_ids[p])
        if used + n > room:
            break
        kept.append(p)
        used += n
    return kept


def assemble(prefix, pieces_ids, phrases, max_len, sep_id):
    """The phone's construction, mirrored: prefix + joined state + [SEP]."""
    kept = fit(prefix, pieces_ids, phrases, max_len)
    return prefix + [t for p in kept for t in pieces_ids[p]] + [sep_id], kept


def verify(tok, pieces, questions, build_prefix, build_sequence, max_len, head_max_len,
           samples=20000, seed=7):
    """Raises PieceMismatch on the first difference; returns (ids, prefixes)."""
    for p in pieces:
        if not CLEAN.match(p):
            raise PieceMismatch(f"unclean phrase: {p!r}")
    ids = piece_ids(tok, pieces)
    for p, t in ids.items():
        if not t:
            raise PieceMismatch(f"phrase tokenizes to nothing: {p!r}")

    # 2. Every ordered pair.
    for a in pieces:
        for b in pieces:
            joined = encode(tok, a + " " + b)
            if joined != ids[a] + ids[b]:
                raise PieceMismatch(f"tokens cross the boundary: {a!r} + {b!r}")

    # 3. Random sequences and whole items.
    prefixes = {}
    for q in questions:
        prefix, markers = build_prefix(tok, q["internal"], head_max_len)
        prefixes[q["id"]] = (prefix, markers)
    rng = random.Random(seed)
    for n in range(samples):
        seq = [rng.choice(pieces) for _ in range(rng.randint(1, 10))]
        text = " ".join(seq)
        if encode(tok, text) != [t for p in seq for t in ids[p]]:
            raise PieceMismatch(f"sequence differs: {seq!r}")
        if n % 20 == 0:
            q = questions[n // 20 % len(questions)]
            prefix, markers = prefixes[q["id"]]
            got, kept = assemble(prefix, ids, seq, max_len, tok.sep_token_id)
            want, want_markers = build_sequence(
                tok, " ".join(kept), q["internal"], max_len, head_max_len
            )
            if got != want or markers != want_markers:
                raise PieceMismatch(f"item differs for {q['id']}: {seq!r}")
    return ids, prefixes
