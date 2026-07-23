"""
500 — house-rules engine + Monte Carlo harness
==============================================

Implements the family ruleset:
  * 4 players, 2 partnerships
  * 45-card deck: 4..A in all suits (2s/3s removed) + one joker
  * 10 cards each, 5-card middle to the bid winner (discard back to 10)
  * 6-level bids are non-winning "indications"; minimum winning bid is 7
  * Redeal if the auction never reaches a winning (7+) bid
  * Avondale schedule for numbered bids
  * Nulla (250): solo lose-all-tricks; ranks above all 7s, below all 8s
  * Double Nulla (500): both partners lose-all; beaten only by 10H and 10NT;
    middle passes through declarer (keep 10, pass 5) then partner (keep 10)
  * Slamming: after middle pickup on a numbered bid, declarer may take
    partner's best card, play solo for all 10 tricks; success = bid + 250,
    failure = -(bid + 250)
  * Joker is the highest card and takes any trick
  * In no-trump / nulla hands the joker is every suit: you can never sluff
    while holding it, and played to a trick it silently assumes the led suit;
    only when LED does its holder name a suit
  * Defenders score 10/trick (on lose-all bids: 10 per trick forced onto the
    bidding side)
  * Game to +500, out the back at -500

Documented assumptions (not covered by the house ruleset — adjust freely):
  * The winning bidder leads the first trick
  * A side reaching +500 wins even on defender points (declarer side checked
    first if both cross in the same hand)
  * Standard bower ordering in trump hands (joker > right bower > left bower)
"""

from __future__ import annotations

import random
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Optional, Sequence

# --------------------------------------------------------------------------
# Cards
# --------------------------------------------------------------------------
# Suits in ladder order (low -> high): Spades, Clubs, Diamonds, Hearts.
SUITS = ["S", "C", "D", "H"]
NT = 4                       # "strain" index for no-trump
RANKS = list(range(4, 15))   # 4..10, J=11, Q=12, K=13, A=14
JOKER = 44
N_CARDS = 45
SAME_COLOR = {0: 1, 1: 0, 2: 3, 3: 2}
_RANK_NAMES = {11: "J", 12: "Q", 13: "K", 14: "A"}


def make_card(suit: int, rank: int) -> int:
    return suit * 11 + (rank - 4)


def card_suit(c: int) -> Optional[int]:
    return None if c == JOKER else c // 11


def card_rank(c: int) -> Optional[int]:
    return None if c == JOKER else c % 11 + 4


def card_name(c: int) -> str:
    if c == JOKER:
        return "JOKER"
    r = card_rank(c)
    return f"{_RANK_NAMES.get(r, str(r))}{SUITS[card_suit(c)]}"


DECK = list(range(N_CARDS))

# --------------------------------------------------------------------------
# Bids and the ladder
# --------------------------------------------------------------------------
NUM, NULLA, DNULLA, IND, PASS = "NUM", "NULLA", "DNULLA", "IND", "PASS"


@dataclass(frozen=True)
class Bid:
    kind: str          # NUM / NULLA / DNULLA (winning), IND (6-level), PASS
    level: int = 0     # 7..10 for NUM, 6 for IND
    strain: int = -1   # 0..3 = trump suit, 4 = no-trump

    def __str__(self) -> str:
        if self.kind == NUM:
            return f"{self.level}{'NT' if self.strain == NT else SUITS[self.strain]}"
        if self.kind == IND:
            return f"6{'NT' if self.strain == NT else SUITS[self.strain]} (indication)"
        return self.kind


def _avondale(level: int, strain: int) -> int:
    return 40 + strain * 20 + (level - 6) * 100


def bid_value(b: Bid) -> int:
    if b.kind == NUM:
        return _avondale(b.level, b.strain)
    if b.kind == NULLA:
        return 250
    if b.kind == DNULLA:
        return 500
    return 0


def _build_ladder() -> list[Bid]:
    ladder: list[Bid] = []
    for s in range(5):                       # 7S..7NT
        ladder.append(Bid(NUM, 7, s))
    ladder.append(Bid(NULLA))                # above all 7s, below all 8s
    for level in (8, 9):
        for s in range(5):
            ladder.append(Bid(NUM, level, s))
    for s in range(3):                       # 10S, 10C, 10D
        ladder.append(Bid(NUM, 10, s))
    ladder.append(Bid(DNULLA))               # beaten only by 10H and 10NT
    ladder.append(Bid(NUM, 10, 3))           # 10H
    ladder.append(Bid(NUM, 10, NT))          # 10NT
    return ladder


LADDER = _build_ladder()
LADDER_INDEX = {b: i for i, b in enumerate(LADDER)}


def trump_of(contract: Bid) -> Optional[int]:
    """Trump suit index, or None for NT / nulla / double nulla."""
    if contract.kind == NUM and contract.strain != NT:
        return contract.strain
    return None


def is_lose_all(contract: Bid) -> bool:
    return contract.kind in (NULLA, DNULLA)


# --------------------------------------------------------------------------
# Card power / follow logic
# --------------------------------------------------------------------------
def effective_suit(card: int, trump: Optional[int], led_suit: Optional[int]) -> Optional[int]:
    """The suit a card counts as for following purposes.

    * Trump hands: joker and left bower are trump.
    * No-trump-type hands (NT, nulla, dnulla): the joker is every suit, so it
      counts as whatever suit was led.
    """
    if card == JOKER:
        return trump if trump is not None else led_suit
    s, r = card_suit(card), card_rank(card)
    if trump is not None and r == 11 and s == SAME_COLOR[trump]:
        return trump  # left bower belongs to the trump suit
    return s


def card_power(card: int, trump: Optional[int], led_suit: Optional[int]) -> int:
    """Sortable strength of a card within a trick. Higher wins."""
    if card == JOKER:
        return 3000  # highest card, takes any trick
    s, r = card_suit(card), card_rank(card)
    if trump is not None:
        if r == 11 and s == trump:
            return 2999                       # right bower
        if r == 11 and s == SAME_COLOR[trump]:
            return 2998                       # left bower
        if s == trump:
            return 2000 + r
    if s == led_suit:
        return 1000 + r
    return 0


def legal_plays(hand: Sequence[int], trump: Optional[int],
                led_suit: Optional[int]) -> list[int]:
    """Legal cards given the effective led suit (None = leading the trick).

    The joker-blocks-sluffing rule falls out naturally: in NT/nulla hands the
    joker's effective suit is always the led suit, so while you hold it you
    can always follow — and if it is your only follower, you must play it.
    """
    hand = list(hand)
    if led_suit is None:
        return hand
    followers = [c for c in hand if effective_suit(c, trump, led_suit) == led_suit]
    return followers if followers else hand


# --------------------------------------------------------------------------
# Policies (strategy plug-ins)
# --------------------------------------------------------------------------
class Policy:
    """Interface for a player's decisions. Override to build strategies."""

    def choose_bid(self, hand, ladder_pos, may_indicate, rng,
                   may_dnulla=False) -> Bid:
        """`may_dnulla` is True only when this seat's partner already bid
        regular NULLA in this auction; DOUBLE NULLA is illegal otherwise
        (500-house-rules.md, Double Nulla) and run_auction scores it as a
        pass."""
        raise NotImplementedError

    def choose_keeps(self, cards, contract, rng) -> list[int]:
        """Return exactly 10 cards to keep from 15 (or 16 after a slam)."""
        raise NotImplementedError

    def consider_slam(self, hand15, contract, rng) -> bool:
        return False

    def give_best_card(self, hand, contract, rng) -> int:
        """Partner surrenders their best card for a slam."""
        trump = trump_of(contract)
        return max(hand, key=lambda c: card_power(c, trump, card_suit(c)))

    def choose_joker_suit(self, hand, contract, rng) -> int:
        return rng.randrange(4)

    def choose_play(self, hand, legal, trick_plays, trump, led_suit,
                    contract, rng) -> int:
        raise NotImplementedError


class RandomPolicy(Policy):
    """Uniform-random legal play; timid random bidding. The baseline."""

    def __init__(self, bid_prob: float = 0.15, indicate_prob: float = 0.05):
        self.bid_prob = bid_prob
        self.indicate_prob = indicate_prob

    def choose_bid(self, hand, ladder_pos, may_indicate, rng,
                   may_dnulla=False):
        nxt = ladder_pos + 1
        # Lowest legal raise: DNULLA is skipped unless partner bid NULLA.
        while nxt < len(LADDER) and LADDER[nxt].kind == DNULLA and not may_dnulla:
            nxt += 1
        if nxt < len(LADDER) and rng.random() < self.bid_prob:
            return LADDER[nxt]
        if may_indicate and rng.random() < self.indicate_prob:
            return Bid(IND, 6, rng.randrange(5))
        return Bid(PASS)

    def choose_keeps(self, cards, contract, rng):
        return rng.sample(list(cards), 10)

    def choose_play(self, hand, legal, trick_plays, trump, led_suit,
                    contract, rng):
        return rng.choice(legal)


class HeuristicPolicy(Policy):
    """Simple table-sense baseline: strength-based bids, void-building
    discards, cheap-winner play, and lose-all ducking."""

    def _suit_strength(self, hand, strain):
        """Rough expected tricks with `strain` as trump (or NT)."""
        trump = strain if strain != NT else None
        score = 0.0
        if JOKER in hand:
            score += 1.0
        for c in hand:
            if c == JOKER:
                continue
            s, r = card_suit(c), card_rank(c)
            if trump is not None:
                if r == 11 and s in (trump, SAME_COLOR[trump]):
                    score += 0.95
                elif s == trump:
                    score += 0.55 if r >= 12 else 0.35
                elif r == 14:
                    score += 0.75
                elif r == 13:
                    score += 0.25
            else:
                if r == 14:
                    score += 0.9
                elif r == 13:
                    score += 0.5
                elif r == 12:
                    score += 0.2
        return score

    def _lowness(self, hand):
        """How suited the hand is to losing every trick (higher = lower)."""
        vals = [0 if c == JOKER else 15 - card_rank(c) for c in hand]
        return sum(vals) / len(vals)

    def choose_bid(self, hand, ladder_pos, may_indicate, rng,
                   may_dnulla=False):
        # Lose-all option: uniformly low hand, no joker, nothing above a jack.
        if (JOKER not in hand and self._lowness(hand) >= 8.6
                and max(card_rank(c) for c in hand) <= 11):
            nulla_i = LADDER_INDEX[Bid(NULLA)]
            if nulla_i > ladder_pos:
                return Bid(NULLA)
        best_strain = max(range(5), key=lambda s: self._suit_strength(hand, s))
        est = self._suit_strength(hand, best_strain)
        max_level = min(10, int(est + 2.5))
        if max_level < 7:
            if may_indicate and est >= 4.5 and best_strain < 4:
                return Bid(IND, 6, best_strain)
            return Bid(PASS)
        for i in range(ladder_pos + 1, len(LADDER)):
            b = LADDER[i]
            if b.kind == NUM and b.strain == best_strain and b.level <= max_level:
                return b
            if b.kind == NUM and b.level > max_level:
                break
        return Bid(PASS)

    def choose_keeps(self, cards, contract, rng):
        trump = trump_of(contract)
        cards = list(cards)
        if is_lose_all(contract):
            # Keep the ten weakest cards (joker counts as strongest).
            ranked = sorted(cards, key=lambda c: 99 if c == JOKER
                            else card_rank(c))
            return ranked[:10]
        # Numbered bids: keep trumps and high side cards; build a void by
        # preferentially shedding the shortest weak side suit.
        def key(c):
            if c == JOKER:
                return (0, 0)
            s, r = card_suit(c), card_rank(c)
            if trump is not None and (s == trump or
                                      (r == 11 and s == SAME_COLOR[trump])):
                return (0, 14 - r)
            return (1, 14 - r)
        by_side = defaultdict(list)
        for c in cards:
            if key(c)[0] == 1:
                by_side[card_suit(c)].append(c)
        # Rank side suits by (length, top rank): dump the shortest/weakest.
        dump_order = sorted(by_side, key=lambda s: (len(by_side[s]),
                            max(card_rank(c) for c in by_side[s])))
        discards: list[int] = []
        for s in dump_order:
            for c in sorted(by_side[s], key=card_rank):
                if card_rank(c) < 14 and len(discards) < len(cards) - 10:
                    discards.append(c)
            if len(discards) >= len(cards) - 10:
                break
        # Fallback: shed globally weakest cards if voids weren't enough.
        if len(discards) < len(cards) - 10:
            rest = sorted((c for c in cards if c not in discards), key=key,
                          reverse=True)
            for c in rest:
                if len(discards) >= len(cards) - 10:
                    break
                discards.append(c)
        return [c for c in cards if c not in discards]

    def consider_slam(self, hand15, contract, rng):
        if contract.kind != NUM:
            return False
        est = self._suit_strength(hand15, contract.strain)
        return est >= 8.0

    def choose_joker_suit(self, hand, contract, rng):
        counts = defaultdict(int)
        for c in hand:
            if c != JOKER:
                counts[card_suit(c)] += 1
        return min(range(4), key=lambda s: counts[s])  # lead where we're short

    def choose_play(self, hand, legal, trick_plays, trump, led_suit,
                    contract, rng):
        current_max = max((card_power(c, trump, led_suit)
                           for _, c in trick_plays), default=-1)
        if is_lose_all(contract):
            # Duck with the biggest card that still loses; if forced to win,
            # shed the most dangerous card.
            losers = [c for c in legal
                      if card_power(c, trump, led_suit) < current_max]
            pool = losers if losers else legal
            return max(pool, key=lambda c: card_power(c, trump,
                       led_suit if led_suit is not None else card_suit(c)))
        winners = [c for c in legal
                   if card_power(c, trump, led_suit) > current_max]
        if winners:
            return min(winners, key=lambda c: card_power(c, trump, led_suit))
        return min(legal, key=lambda c: card_power(c, trump, led_suit))


# --------------------------------------------------------------------------
# Auction
# --------------------------------------------------------------------------
@dataclass
class AuctionResult:
    contract: Optional[Bid]      # None => redeal
    declarer: Optional[int]
    indications: list[tuple[int, Bid]] = field(default_factory=list)


def run_auction(hands, policies, first: int, rng) -> AuctionResult:
    """Single round of exactly four calls (500-house-rules.md, Bidding):
    one call per player starting at `first` (left of the dealer), the dealer
    calling last. No winning bid after the fourth call means a redeal — the
    dealer's pass in that spot IS the throw-in choice.

    Double nulla is legal only when this seat's partner already bid regular
    NULLA earlier in the auction (500-house-rules.md, Double Nulla); one
    that fails the precondition is scored as a pass, like a too-low bid."""
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
        return AuctionResult(None, None, indications)        # redeal
    return AuctionResult(LADDER[ladder_pos], declarer, indications)


# --------------------------------------------------------------------------
# Playing a hand
# --------------------------------------------------------------------------
@dataclass
class HandResult:
    contract: Bid
    declarer: int
    slam: bool
    made: bool
    declarer_delta: int
    defender_delta: int
    declarer_side_tricks: int
    defender_side_tricks: int
    redeal: bool = False


def _exchange_middle(hands, middle, contract, declarer, policies, rng):
    """Apply middle pickup, slam declaration, and (double) nulla flows.
    Returns (active_players, slam_declared)."""
    partner = (declarer + 2) % 4
    slam = False
    if contract.kind == DNULLA:
        cards = hands[declarer] + middle
        keeps = policies[declarer].choose_keeps(cards, contract, rng)
        passed = [c for c in cards if c not in keeps]      # 5 discards travel on
        hands[declarer] = list(keeps)
        cards2 = hands[partner] + passed
        keeps2 = policies[partner].choose_keeps(cards2, contract, rng)
        hands[partner] = list(keeps2)
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
            hands[partner].remove(best)
            cards = cards + [best]
            active = [p for p in range(4) if p != partner]  # solo
        else:
            active = [0, 1, 2, 3]
        keeps = policies[declarer].choose_keeps(cards, contract, rng)
        hands[declarer] = list(keeps)
    assert all(len(hands[p]) == 10 for p in active), "keeps must total 10"
    return active, slam


def play_hand(hands, middle, contract, declarer, policies, rng) -> HandResult:
    trump = trump_of(contract)
    active, slam = _exchange_middle(hands, middle, contract, declarer,
                                    policies, rng)
    decl_side = declarer % 2
    side_tricks = [0, 0]
    leader = declarer
    for _ in range(10):
        order = [p for p in active[active.index(leader):] +
                 active[:active.index(leader)]]
        led_suit: Optional[int] = None
        plays: list[tuple[int, int]] = []
        for p in order:
            legal = legal_plays(hands[p], trump, led_suit)
            card = policies[p].choose_play(hands[p], legal, plays, trump,
                                           led_suit, contract, rng)
            hands[p].remove(card)
            if led_suit is None:
                if card == JOKER and trump is None:
                    led_suit = policies[p].choose_joker_suit(hands[p],
                                                             contract, rng)
                else:
                    led_suit = effective_suit(card, trump, None)
            plays.append((p, card))
        winner = max(plays,
                     key=lambda pc: card_power(pc[1], trump, led_suit))[0]
        side_tricks[winner % 2] += 1
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
    return HandResult(contract, declarer, slam, made, decl_delta, def_delta,
                      decl_tricks, def_tricks)


def deal(rng):
    cards = DECK[:]
    rng.shuffle(cards)
    hands = [sorted(cards[i * 10:(i + 1) * 10]) for i in range(4)]
    middle = cards[40:]
    return hands, middle


def play_one_hand(policies, first: int, rng,
                  max_redeals: int = 10_000) -> HandResult:
    """Deal + auction + play; redeals internally until a contract exists."""
    for _ in range(max_redeals):
        hands, middle = deal(rng)
        auction = run_auction(hands, policies, first, rng)
        if auction.contract is None:
            continue                          # redeal
        return play_hand(hands, middle, auction.contract, auction.declarer,
                         policies, rng)
    raise RuntimeError("auction never produced a contract; check bid policies")


# --------------------------------------------------------------------------
# Full games
# --------------------------------------------------------------------------
def play_game(policies, rng, max_hands: int = 300):
    """First side to +500 wins; a side at -500 goes out the back."""
    scores = [0, 0]
    first = 0
    for _ in range(max_hands):
        res = play_one_hand(policies, first, rng)
        d = res.declarer % 2
        scores[d] += res.declarer_delta
        scores[1 - d] += res.defender_delta
        if scores[d] >= 500:
            return d, scores
        if scores[1 - d] >= 500:
            return 1 - d, scores
        if scores[d] <= -500:
            return 1 - d, scores
        if scores[1 - d] <= -500:
            return d, scores
        first = (first + 1) % 4
    return (0 if scores[0] >= scores[1] else 1), scores


# --------------------------------------------------------------------------
# Monte Carlo harness
# --------------------------------------------------------------------------
def simulate_hands(n: int, policies, seed: int = 0):
    rng = random.Random(seed)
    stats = defaultdict(lambda: {"n": 0, "made": 0, "decl_pts": 0,
                                 "def_pts": 0, "slams": 0})
    for i in range(n):
        res = play_one_hand(policies, i % 4, rng)
        key = str(res.contract) + (" +SLAM" if res.slam else "")
        s = stats[key]
        s["n"] += 1
        s["made"] += res.made
        s["decl_pts"] += res.declarer_delta
        s["def_pts"] += res.defender_delta
        s["slams"] += res.slam
    return stats


def print_stats(stats):
    rows = sorted(stats.items(), key=lambda kv: -kv[1]["n"])
    print(f"{'contract':>14} {'n':>6} {'made%':>7} {'avg decl':>9} {'avg def':>8}")
    for k, s in rows:
        print(f"{k:>14} {s['n']:>6} {100*s['made']/s['n']:>6.1f}% "
              f"{s['decl_pts']/s['n']:>9.1f} {s['def_pts']/s['n']:>8.1f}")


def simulate_games(n: int, policies, seed: int = 0):
    rng = random.Random(seed)
    wins = [0, 0]
    for _ in range(n):
        w, _ = play_game(policies, rng)
        wins[w] += 1
    return wins


# --------------------------------------------------------------------------
# Determinized rollout: evaluate a middle-discard decision
# --------------------------------------------------------------------------
def evaluate_keeps(my15, keeps, contract, declarer, n_worlds, policies,
                   seed: int = 0):
    """Success rate of a fixed keep-set: deal the 30 unseen cards to the other
    three seats at random and play the hand out `n_worlds` times."""
    rng = random.Random(seed)
    unseen = [c for c in DECK if c not in my15]
    made = 0
    for _ in range(n_worlds):
        rng.shuffle(unseen)
        hands = [None] * 4
        others = [p for p in range(4) if p != declarer]
        for j, p in enumerate(others):
            hands[p] = sorted(unseen[j * 10:(j + 1) * 10])
        hands[declarer] = list(keeps)
        # Middle already absorbed into my15; feed an empty exchange by
        # pre-setting the hand and calling the trick loop directly.
        res = _play_fixed(hands, contract, declarer, policies, rng)
        made += res
    return made / n_worlds


def _play_fixed(hands, contract, declarer, policies, rng) -> bool:
    """Play out a hand whose exchange already happened (numbered bids only)."""
    trump = trump_of(contract)
    active = [0, 1, 2, 3]
    decl_side = declarer % 2
    side_tricks = [0, 0]
    leader = declarer
    hands = [list(h) for h in hands]
    for _ in range(10):
        order = active[active.index(leader):] + active[:active.index(leader)]
        led_suit = None
        plays = []
        for p in order:
            legal = legal_plays(hands[p], trump, led_suit)
            card = policies[p].choose_play(hands[p], legal, plays, trump,
                                           led_suit, contract, rng)
            hands[p].remove(card)
            if led_suit is None:
                if card == JOKER and trump is None:
                    led_suit = policies[p].choose_joker_suit(hands[p],
                                                             contract, rng)
                else:
                    led_suit = effective_suit(card, trump, None)
            plays.append((p, card))
        winner = max(plays,
                     key=lambda pc: card_power(pc[1], trump, led_suit))[0]
        side_tricks[winner % 2] += 1
        leader = winner
    return side_tricks[decl_side] >= contract.level


# --------------------------------------------------------------------------
# Self-checks + smoke test
# --------------------------------------------------------------------------
def _self_test():
    H, D, S, C = 3, 2, 0, 1
    # Bower ordering with hearts trump: joker > JH > JD > AH.
    assert card_power(JOKER, H, S) > card_power(make_card(H, 11), H, S)
    assert card_power(make_card(H, 11), H, S) > card_power(make_card(D, 11), H, S)
    assert card_power(make_card(D, 11), H, S) > card_power(make_card(H, 14), H, S)
    # Left bower follows trump, not its printed suit.
    assert effective_suit(make_card(D, 11), H, D) == H
    # Ladder placement.
    assert LADDER_INDEX[Bid(NULLA)] == LADDER_INDEX[Bid(NUM, 7, NT)] + 1
    assert LADDER_INDEX[Bid(NULLA)] < LADDER_INDEX[Bid(NUM, 8, 0)]
    assert LADDER_INDEX[Bid(NUM, 10, D)] < LADDER_INDEX[Bid(DNULLA)]
    assert LADDER_INDEX[Bid(DNULLA)] < LADDER_INDEX[Bid(NUM, 10, H)]
    assert LADDER_INDEX[Bid(NUM, 10, H)] < LADDER_INDEX[Bid(NUM, 10, NT)]
    # Avondale.
    assert bid_value(Bid(NUM, 7, S)) == 140 and bid_value(Bid(NUM, 10, NT)) == 520
    # Joker blocks sluffing in NT: void in spades but holding joker -> must play it.
    hand = [JOKER, make_card(C, 9)]
    assert legal_plays(hand, None, S) == [JOKER]
    # In a trump hand the joker is a trump, so a spade lead can be sluffed.
    assert set(legal_plays(hand, H, S)) == set(hand)
    print("self-test: all checks passed")


if __name__ == "__main__":
    _self_test()
    policies = [HeuristicPolicy(), HeuristicPolicy(),
                HeuristicPolicy(), HeuristicPolicy()]
    print("\n=== 5,000 hands, four heuristic players ===")
    print_stats(simulate_hands(5000, policies, seed=42))
    print("\n=== 200 games, heuristic (side 0) vs random (side 1) ===")
    mixed = [HeuristicPolicy(), RandomPolicy(), HeuristicPolicy(), RandomPolicy()]
    wins = simulate_games(200, mixed, seed=7)
    print(f"side 0 (heuristic) wins: {wins[0]}   side 1 (random) wins: {wins[1]}")
