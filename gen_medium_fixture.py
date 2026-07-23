#!/usr/bin/env python3
"""gen_medium_fixture.py — 100-context decision fixture for the Medium bot.

Records HeuristicPolicy decisions (the Medium bot's oracle) as JSON lines so
packages/bots/test/medium.spec.ts can assert the TS port reproduces every
decision exactly (fh-f2a.2 AC-2):

    uv run python gen_medium_fixture.py \
        > packages/bots/test/fixtures/medium-decisions.jsonl

Schema v1 — one record per line:

    v       : 1
    i       : 0-based record index
    method  : choose_bid | choose_keeps | consider_slam | choose_joker_suit
              | give_best_card | choose_play
    result  : the oracle's decision (bid object, card list, card, suit, bool)
    ... plus the method's arguments (hands/cards/legal as card-int lists,
    contracts/bids as {kind, level, strain}, trick_plays as [seat, card]
    pairs).

Tie-break convention: every card-list argument is sorted ascending BEFORE the
oracle sees it, and recorded sorted. Python's max()/min()/stable sorts break
ties by iteration order, so pinning the input order pins the decisions; the
TS port sorts its inputs the same way (see packages/bots/src/medium.ts).

Contexts come from two sources:
  * organic — 4 HeuristicPolicy seats play seeded hands via the oracle's own
    play_one_hand, with a recording wrapper capturing every decision;
  * synthetic — direct method calls for branches unreachable in organic play:
    consider_slam >= 8.0 (documented unreachable in trace_500.py), the
    16-card post-slam keep, give_best_card, DNULLA keeps, and joker-suit
    naming. Rare organic branches (nulla bids, nulla keeps, lose-all plays,
    indications) are force-included before common ones fill the quota.

Determinism: output is byte-identical across runs (fixed seed, no
timestamps). HeuristicPolicy itself never draws from rng, so recording
args + result is sufficient for exact replay.
"""

from __future__ import annotations

import json
import random
import sys

from five_hundred import (
    DNULLA,
    IND,
    NULLA,
    NUM,
    Bid,
    HeuristicPolicy,
    make_card,
    play_one_hand,
)

JOKER = 44
TOTAL = 100


def bid_json(b: Bid) -> dict:
    return {"kind": b.kind, "level": b.level, "strain": b.strain}


class RecordingPolicy(HeuristicPolicy):
    """Delegates to HeuristicPolicy with sorted card inputs, recording every
    decision context into a shared list."""

    def __init__(self, records: list[dict]):
        self.records = records

    def choose_bid(self, hand, ladder_pos, may_indicate, rng,
                   may_dnulla=False):
        hand = sorted(hand)
        action = super().choose_bid(hand, ladder_pos, may_indicate, rng,
                                    may_dnulla)
        self.records.append({
            "method": "choose_bid", "hand": hand, "ladder_pos": ladder_pos,
            "may_indicate": may_indicate, "result": bid_json(action),
        })
        return action

    def choose_keeps(self, cards, contract, rng):
        cards = sorted(cards)
        keeps = super().choose_keeps(cards, contract, rng)
        self.records.append({
            "method": "choose_keeps", "cards": cards,
            "contract": bid_json(contract), "result": list(keeps),
        })
        return keeps

    def consider_slam(self, hand15, contract, rng):
        hand15 = sorted(hand15)
        slam = super().consider_slam(hand15, contract, rng)
        self.records.append({
            "method": "consider_slam", "hand15": hand15,
            "contract": bid_json(contract), "result": slam,
        })
        return slam

    def give_best_card(self, hand, contract, rng):
        hand = sorted(hand)
        card = super().give_best_card(hand, contract, rng)
        self.records.append({
            "method": "give_best_card", "hand": hand,
            "contract": bid_json(contract), "result": card,
        })
        return card

    def choose_joker_suit(self, hand, contract, rng):
        hand = sorted(hand)
        suit = super().choose_joker_suit(hand, contract, rng)
        self.records.append({
            "method": "choose_joker_suit", "hand": hand,
            "contract": bid_json(contract), "result": suit,
        })
        return suit

    def choose_play(self, hand, legal, trick_plays, trump, led_suit,
                    contract, rng):
        hand = sorted(hand)
        legal = sorted(legal)
        card = super().choose_play(hand, legal, trick_plays, trump, led_suit,
                                   contract, rng)
        self.records.append({
            "method": "choose_play", "hand": hand, "legal": legal,
            "trick_plays": [[p, c] for p, c in trick_plays],
            "trump": trump, "led_suit": led_suit,
            "contract": bid_json(contract), "result": card,
        })
        return card


def organic_records() -> list[dict]:
    records: list[dict] = []
    policies = [RecordingPolicy(records) for _ in range(4)]
    rng = random.Random(20260721)
    for h in range(60):
        play_one_hand(policies, h % 4, rng)
    return records


def synthetic_records() -> list[dict]:
    """Direct-call contexts for branches organic play cannot reach."""
    hp = RecordingPolicy([])
    records = hp.records
    rng = random.Random(0)  # never drawn from; required by the signatures
    hearts = Bid(NUM, 10, 3)

    # A >= 8.0 pickup: joker, both bowers, every heart, two side aces
    # (est 8.5) -> the slam gate itself fires even though random deals never
    # produce it (trace_500.py documents the threshold as unreachable).
    monster = sorted(
        [JOKER, make_card(2, 11)]
        + [make_card(3, r) for r in range(4, 15)]
        + [make_card(0, 14), make_card(1, 14)]
    )
    assert hp.consider_slam(monster, hearts, rng) is True
    # Just-under hand: joker + top hearts + side kings stays below 8.0.
    near = sorted(
        [JOKER, make_card(2, 11)]
        + [make_card(3, r) for r in range(9, 15)]
        + [make_card(0, 13), make_card(1, 13), make_card(2, 13),
           make_card(0, 4), make_card(1, 4), make_card(2, 4),
           make_card(0, 5)]
    )
    assert hp.consider_slam(near, hearts, rng) is False
    # Partner surrenders their best card for the slam...
    partner = sorted([make_card(3, 11), make_card(0, 14), make_card(2, 5),
                      make_card(1, 8), make_card(0, 6), make_card(2, 9),
                      make_card(1, 12), make_card(0, 9), make_card(2, 6),
                      make_card(1, 5)])
    best = hp.give_best_card(partner, hearts, rng)
    # ...and the declarer keeps 10 from the 16-card post-slam pickup.
    hp.choose_keeps(sorted(monster + [best]), hearts, rng)

    # DNULLA keeps: Medium never bids it, but partners/rollouts may face it.
    dn_cards = sorted(rng.sample([c for c in range(45)], 15))
    hp.choose_keeps(dn_cards, Bid(DNULLA), rng)

    # Joker-suit naming (led joker in an NT-type hand; hand excludes joker).
    hp.choose_joker_suit(sorted(rng.sample([c for c in range(44)], 9)),
                         Bid(NUM, 8, 4), rng)
    hp.choose_joker_suit([make_card(0, 4), make_card(0, 9), make_card(1, 12),
                          make_card(2, 7)], Bid(NULLA), rng)

    # Synthetic nulla-shaped bid hand (all four suits' 4..6 + a 7, no joker).
    low_hand = sorted([make_card(s, r) for s in range(4) for r in (4, 5)]
                      + [make_card(0, 6), make_card(1, 6)])
    hp.choose_bid(low_hand, -1, True, rng)

    return records


def take_mixed(pool: list[dict], quota: int,
               tiers: list) -> list[dict]:
    """Fill `quota` from tiered sub-pools: each (predicate, cap) in order,
    None cap = unlimited; leftovers fill from the whole pool in order."""
    picked: list[dict] = []
    for pred, cap in tiers:
        sub = [r for r in pool if pred(r) and r not in picked]
        picked.extend(sub if cap is None else sub[:cap])
    for r in pool:
        if len(picked) >= quota:
            break
        if r not in picked:
            picked.append(r)
    return picked[:quota]


def main() -> None:
    organic = organic_records()
    synthetic = synthetic_records()

    # Per-method quotas over organic records (synthetics ride on top),
    # sub-tiered so rare branches are force-included without swamping the
    # common ones. The oracle's indication branch is dead code (it needs
    # est >= 4.5 inside max_level < 7, which implies est < 4.5), so no IND
    # record can exist.
    quotas = {
        "choose_bid": (34, [
            (lambda r: r["result"]["kind"] == NULLA, None),
            (lambda r: r["result"]["kind"] == NUM, 16),
        ]),
        "choose_keeps": (14, [
            (lambda r: r["contract"]["kind"] == NULLA, 4),
        ]),
        "consider_slam": (5, []),
        "choose_play": (TOTAL - len(synthetic) - 34 - 14 - 5, [
            (lambda r: r["contract"]["kind"] == NULLA, 12),
        ]),
    }
    picked: list[dict] = list(synthetic)
    for method, (quota, tiers) in quotas.items():
        pool = [r for r in organic if r["method"] == method]
        picked.extend(take_mixed(pool, quota, tiers))
    assert len(picked) == TOTAL, f"expected {TOTAL} records, got {len(picked)}"

    methods = {r["method"] for r in picked}
    assert methods == {"choose_bid", "choose_keeps", "consider_slam",
                       "choose_joker_suit", "give_best_card", "choose_play"}
    assert any(r["method"] == "choose_bid" and r["result"]["kind"] == NULLA
               for r in picked), "no nulla bid captured"
    assert any(r["method"] == "choose_keeps"
               and r["contract"]["kind"] == NULLA for r in picked)
    assert any(r["method"] == "choose_play"
               and r["contract"]["kind"] == NULLA for r in picked)
    assert any(r["method"] == "consider_slam" and r["result"] for r in picked)

    for i, rec in enumerate(picked):
        rec = {"v": 1, "i": i, **rec}
        sys.stdout.write(json.dumps(rec, separators=(",", ":")) + "\n")


if __name__ == "__main__":
    main()
