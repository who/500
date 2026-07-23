#!/usr/bin/env python3
"""trace_500.py — JSON-lines trace emitter for the 500 oracle (five_hundred.py).

Plays K seeded hands with deterministic policies and streams one JSON object
per event to stdout, producing a stable, replayable record for the TS engine
parity harness (PRD section 7.2):

    python trace_500.py --seed 1 --hands 1000 > traces.jsonl

Schema v2
---------
Every record carries these common fields:

    v      : 2 (schema version; v2 added auction_action.may_dnulla, fh-17b)
    seed   : the --seed argument
    hand   : 0-based hand index
    first  : seat that opens the auction for this hand (hand % 4)
    type   : one of the record types below

Record types and their extra fields:

    deal            attempt, hands (4 lists of 10 card ints), middle (5 ints)
    auction_action  attempt, seat, ladder_pos (position BEFORE this action;
                    -1 = no bid yet — implies the legal bid set), may_indicate,
                    may_dnulla (partner already bid NULLA this auction, so
                    DOUBLE NULLA is in the legal set), action
                    {kind, level, strain}
    auction_result  attempt, redeal (bool), contract {kind, level, strain,
                    name} or null on redeal, declarer or null,
                    indications [[seat, {kind, level, strain}], ...]
    exchange        declarer, contract, slam, give_card (card taken from
                    partner for a slam, else null), active (seats that play),
                    declarer_cards (the 15- or 16-card pickup context),
                    declarer_keeps, passed (DNULLA pass-through cards or
                    null), partner_cards (DNULLA only), partner_keeps
    play            trick, seat, led_suit (effective led suit BEFORE this
                    play; null = leading), legal (legal_plays at this point),
                    card, named_suit (suit named for a led joker in
                    NT/nulla-type hands, else null)
    trick_winner    trick, led_suit, plays [[seat, card], ...], winner
    hand_result     contract, declarer, slam, made, declarer_delta,
                    defender_delta, declarer_side_tricks,
                    defender_side_tricks

Cards use the oracle's integer encoding as-is (0..44, 44 = joker). Bids are
{kind, level, strain}; contracts additionally carry a human-readable "name".
Redeal auctions are emitted in full (deal + actions + auction_result with
redeal=true) under the same hand index with an incrementing "attempt".

Determinism: output is byte-identical across runs given the same args (AC-2).

AC-3 documented combination
---------------------------
    python3 trace_500.py --seed 1 --hands 2000 --policies stress

emits at least one redeal, one NULLA contract, one slam and one DNULLA
contract. Verify with:

    python3 trace_500.py --seed 1 --hands 2000 --policies stress \
      | grep -c '"redeal":true'
    python3 trace_500.py --seed 1 --hands 2000 --policies stress \
      | grep -c '"kind":"NULLA"'
    python3 trace_500.py --seed 1 --hands 2000 --policies stress \
      | grep -c '"kind":"DNULLA"'
    python3 trace_500.py --seed 1 --hands 2000 --policies stress \
      | grep -c '"slam":true'

The `stress` config exists because neither heuristic nor mixed policies can
reach those paths: HeuristicPolicy never bids DNULLA and its slam threshold
(strength >= 8.0) is unreachable in practice (max observed ~6.9 over 5000
hands), and RandomPolicy climbs the ladder one rung at a time so it never
reaches DNULLA either. StressPolicy is a HeuristicPolicy subclass defined
here (the oracle is untouched) that rarely forces NULLA/DNULLA bids and
slams probabilistically, exercising every contract kind for parity traces.
Its DNULLA forcing is gated on may_dnulla, since a double nulla with no
partner nulla behind it is illegal and would only ever be scored as a pass.

The driver loops below (auction, exchange, trick play) are verbatim copies of
five_hundred.run_auction / _exchange_middle / play_hand with emit() calls
inserted — the oracle file itself is untouched, and no extra RNG draws are
made, so for the same seed the traced results are identical to a direct
five_hundred.simulate_hands run (test_trace_500.py asserts this).
"""

from __future__ import annotations

import argparse
import json
import random
import sys
from typing import Optional

from five_hundred import (
    JOKER,
    LADDER,
    LADDER_INDEX,
    NT,
    NULLA,
    DNULLA,
    IND,
    NUM,
    SUITS,
    Bid,
    HandResult,
    HeuristicPolicy,
    RandomPolicy,
    bid_value,
    card_power,
    deal,
    effective_suit,
    is_lose_all,
    legal_plays,
    trump_of,
)

SCHEMA_VERSION = 2


def bid_json(b: Bid) -> dict:
    return {"kind": b.kind, "level": b.level, "strain": b.strain}


def contract_json(b: Bid) -> dict:
    d = bid_json(b)
    d["name"] = str(b)
    return d


class Emitter:
    """Streams one compact JSON object per line; never accumulates records."""

    def __init__(self, seed: int, out):
        self.seed = seed
        self.out = out
        self.hand = 0
        self.first = 0

    def emit(self, type_: str, **fields) -> None:
        rec = {"v": SCHEMA_VERSION, "seed": self.seed, "hand": self.hand,
               "first": self.first, "type": type_}
        rec.update(fields)
        self.out.write(json.dumps(rec, separators=(",", ":")) + "\n")


# --------------------------------------------------------------------------
# Instrumented drivers — verbatim copies of the oracle loops plus emit()
# --------------------------------------------------------------------------
def traced_auction(hands, policies, first: int, rng, em: Emitter, attempt: int):
    """Copy of five_hundred.run_auction with per-action emits."""
    ladder_pos = -1
    declarer = None
    indications: list[tuple[int, Bid]] = []
    indicated = [False] * 4
    history: list[tuple[int, Bid]] = []
    for i in range(4):
        p = (first + i) % 4
        may_indicate = declarer is None and not indicated[p]
        may_dnulla = any(s == (p + 2) % 4 and b.kind == NULLA for s, b in history)
        action = policies[p].choose_bid(hands[p], ladder_pos, may_indicate, rng,
                                        may_dnulla)
        em.emit("auction_action", attempt=attempt, seat=p,
                ladder_pos=ladder_pos, may_indicate=may_indicate,
                may_dnulla=may_dnulla, action=bid_json(action))
        history.append((p, action))
        if action.kind == NUM or action.kind in (NULLA, DNULLA):
            idx = LADDER_INDEX.get(action)
            if (idx is not None and idx > ladder_pos
                    and (action.kind != DNULLA or may_dnulla)):
                ladder_pos, declarer = idx, p
            # else: illegal/low bid treated as a pass
        elif action.kind == IND and may_indicate:
            indicated[p] = True
            indications.append((p, action))
    if declarer is None:
        em.emit("auction_result", attempt=attempt, redeal=True,
                contract=None, declarer=None,
                indications=[[s, bid_json(b)] for s, b in indications])
        return None, None                  # redeal
    em.emit("auction_result", attempt=attempt, redeal=False,
            contract=contract_json(LADDER[ladder_pos]),
            declarer=declarer,
            indications=[[s, bid_json(b)] for s, b in indications])
    return LADDER[ladder_pos], declarer


def traced_exchange(hands, middle, contract, declarer, policies, rng,
                    em: Emitter):
    """Copy of five_hundred._exchange_middle with a single exchange emit."""
    partner = (declarer + 2) % 4
    slam = False
    give_card = None
    passed = None
    partner_cards = None
    partner_keeps = None
    if contract.kind == DNULLA:
        cards = hands[declarer] + middle
        keeps = policies[declarer].choose_keeps(cards, contract, rng)
        passed = [c for c in cards if c not in keeps]      # 5 discards travel on
        hands[declarer] = list(keeps)
        cards2 = hands[partner] + passed
        keeps2 = policies[partner].choose_keeps(cards2, contract, rng)
        hands[partner] = list(keeps2)
        partner_cards, partner_keeps = cards2, list(keeps2)
        active = [0, 1, 2, 3]
    elif contract.kind == NULLA:
        cards = hands[declarer] + middle
        keeps = policies[declarer].choose_keeps(cards, contract, rng)
        hands[declarer] = list(keeps)
        active = [p for p in range(4) if p != partner]     # partner sits out
    else:
        cards = hands[declarer] + middle
        if policies[declarer].consider_slam(cards, contract, rng):
            slam = True
            best = policies[declarer].give_best_card(hands[partner], contract, rng)
            give_card = best
            hands[partner].remove(best)
            cards = cards + [best]
            active = [p for p in range(4) if p != partner]  # solo
        else:
            active = [0, 1, 2, 3]
        keeps = policies[declarer].choose_keeps(cards, contract, rng)
        hands[declarer] = list(keeps)
    assert all(len(hands[p]) == 10 for p in active), "keeps must total 10"
    em.emit("exchange", declarer=declarer, contract=contract_json(contract),
            slam=slam, give_card=give_card, active=active,
            declarer_cards=list(cards), declarer_keeps=list(hands[declarer]),
            passed=passed, partner_cards=partner_cards,
            partner_keeps=partner_keeps)
    return active, slam


def traced_play_hand(hands, middle, contract, declarer, policies, rng,
                     em: Emitter) -> HandResult:
    """Copy of five_hundred.play_hand with per-play and per-trick emits."""
    trump = trump_of(contract)
    active, slam = traced_exchange(hands, middle, contract, declarer,
                                   policies, rng, em)
    decl_side = declarer % 2
    side_tricks = [0, 0]
    leader = declarer
    for trick in range(10):
        order = [p for p in active[active.index(leader):] +
                 active[:active.index(leader)]]
        led_suit: Optional[int] = None
        plays: list[tuple[int, int]] = []
        for p in order:
            legal = legal_plays(hands[p], trump, led_suit)
            card = policies[p].choose_play(hands[p], legal, plays, trump,
                                           led_suit, contract, rng)
            hands[p].remove(card)
            named_suit = None
            pre_led = led_suit
            if led_suit is None:
                if card == JOKER and trump is None:
                    led_suit = policies[p].choose_joker_suit(hands[p],
                                                             contract, rng)
                    named_suit = led_suit
                else:
                    led_suit = effective_suit(card, trump, None)
            plays.append((p, card))
            em.emit("play", trick=trick, seat=p, led_suit=pre_led,
                    legal=list(legal), card=card, named_suit=named_suit)
        winner = max(plays,
                     key=lambda pc: card_power(pc[1], trump, led_suit))[0]
        side_tricks[winner % 2] += 1
        em.emit("trick_winner", trick=trick, led_suit=led_suit,
                plays=[[p, c] for p, c in plays], winner=winner)
        leader = winner

    decl_tricks = side_tricks[decl_side]
    def_tricks = side_tricks[1 - decl_side]
    value = bid_value(contract)
    if is_lose_all(contract):
        made = decl_tricks == 0
        decl_delta = value if made else -value
        def_delta = 10 * decl_tricks          # tricks forced onto bidders
    elif slam:
        made = decl_tricks == 10
        decl_delta = (value + 250) if made else -(value + 250)
        def_delta = 10 * def_tricks
    else:
        made = decl_tricks >= contract.level
        decl_delta = value if made else -value
        def_delta = 10 * def_tricks
    res = HandResult(contract, declarer, slam, made, decl_delta, def_delta,
                     decl_tricks, def_tricks)
    em.emit("hand_result", contract=contract_json(contract),
            declarer=declarer, slam=slam, made=res.made,
            declarer_delta=res.declarer_delta,
            defender_delta=res.defender_delta,
            declarer_side_tricks=res.declarer_side_tricks,
            defender_side_tricks=res.defender_side_tricks)
    return res


def trace_one_hand(policies, first: int, rng, em: Emitter,
                   auction_only: bool = False,
                   max_redeals: int = 10_000) -> Optional[HandResult]:
    """Copy of five_hundred.play_one_hand: deal + auction + play, redealing
    internally (each attempt fully emitted). In --auction-only mode a hand is
    a single deal + auction — redeals end the hand instead of looping."""
    for attempt in range(max_redeals):
        hands, middle = deal(rng)
        em.emit("deal", attempt=attempt, hands=[list(h) for h in hands],
                middle=list(middle))
        contract, declarer = traced_auction(hands, policies, first, rng, em,
                                            attempt)
        if auction_only:
            return None
        if contract is None:
            continue                          # redeal
        return traced_play_hand(hands, middle, contract, declarer, policies,
                                rng, em)
    raise RuntimeError("auction never produced a contract; check bid policies")


# --------------------------------------------------------------------------
# Policy configs
# --------------------------------------------------------------------------
class StressPolicy(HeuristicPolicy):
    """Heuristic play plus rare forced NULLA/DNULLA bids and probabilistic
    slams, so traces exercise every contract kind (see AC-3 note in the
    module docstring). Fully deterministic through the shared rng."""

    def choose_bid(self, hand, ladder_pos, may_indicate, rng,
                   may_dnulla=False):
        r = rng.random()
        # DNULLA only answers a partner's NULLA (fh-17b), which is rare
        # enough that the forcing probability has to be generous to keep
        # double-nulla contracts in the traces at all.
        if may_dnulla and r < 0.5 and LADDER_INDEX[Bid(DNULLA)] > ladder_pos:
            return Bid(DNULLA)
        if r < 0.05 and LADDER_INDEX[Bid(NULLA)] > ladder_pos:
            return Bid(NULLA)
        return super().choose_bid(hand, ladder_pos, may_indicate, rng,
                                  may_dnulla)

    def consider_slam(self, hand15, contract, rng):
        return contract.kind == NUM and rng.random() < 0.2


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------
def make_policies(name: str):
    if name == "heuristic":
        return [HeuristicPolicy(), HeuristicPolicy(),
                HeuristicPolicy(), HeuristicPolicy()]
    if name == "mixed":
        return [HeuristicPolicy(), RandomPolicy(),
                HeuristicPolicy(), RandomPolicy()]
    if name == "stress":
        return [StressPolicy(), StressPolicy(),
                StressPolicy(), StressPolicy()]
    raise ValueError(f"unknown policy config: {name}")


def run_trace(seed: int, hands: int, policies_name: str = "heuristic",
              auction_only: bool = False, out=None) -> list[Optional[HandResult]]:
    """Trace `hands` hands, streaming JSON lines to `out` (default stdout).
    Mirrors five_hundred.simulate_hands seat rotation (first = i % 4)."""
    out = out if out is not None else sys.stdout
    policies = make_policies(policies_name)
    rng = random.Random(seed)
    em = Emitter(seed, out)
    results: list[Optional[HandResult]] = []
    for i in range(hands):
        em.hand = i
        em.first = i % 4
        results.append(trace_one_hand(policies, i % 4, rng, em,
                                      auction_only=auction_only))
    return results


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        description="Emit a JSON-lines trace of seeded 500 hands (schema v1).")
    ap.add_argument("--seed", type=int, default=0, help="RNG seed (default 0)")
    ap.add_argument("--hands", type=int, default=100,
                    help="number of hands to trace (default 100)")
    ap.add_argument("--policies", choices=["heuristic", "mixed", "stress"],
                    default="heuristic",
                    help="4x heuristic; heuristic/random alternating; or 4x "
                         "stress (forces rare NULLA/DNULLA/slam paths)")
    ap.add_argument("--auction-only", action="store_true",
                    help="deal + auction only; one auction per hand index "
                         "(auction-heavy traces, PRD section 9)")
    args = ap.parse_args(argv)
    run_trace(args.seed, args.hands, args.policies, args.auction_only)
    return 0


if __name__ == "__main__":
    sys.exit(main())
