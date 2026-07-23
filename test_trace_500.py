"""Smoke tests for trace_500.py (stdlib unittest only — no pytest).

Traces a handful of hands in-process and asserts:
  * every emitted line parses as JSON and carries the v2 common fields,
  * per-type records carry their documented schema fields,
  * two identical runs are byte-identical,
  * traced HandResults aggregate to the same stats as a direct
    five_hundred.simulate_hands run (the drivers are faithful copies).

Run with:  python3 -m unittest -v test_trace_500
"""

import io
import json
import unittest

import five_hundred
import trace_500

COMMON_FIELDS = {"v", "seed", "hand", "first", "type"}

TYPE_FIELDS = {
    "deal": {"attempt", "hands", "middle"},
    "auction_action": {"attempt", "seat", "ladder_pos", "may_indicate",
                       "may_dnulla", "action"},
    "auction_result": {"attempt", "redeal", "contract", "declarer",
                       "indications"},
    "exchange": {"declarer", "contract", "slam", "give_card", "active",
                 "declarer_cards", "declarer_keeps", "passed",
                 "partner_cards", "partner_keeps"},
    "play": {"trick", "seat", "led_suit", "legal", "card", "named_suit"},
    "trick_winner": {"trick", "led_suit", "plays", "winner"},
    "hand_result": {"contract", "declarer", "slam", "made", "declarer_delta",
                    "defender_delta", "declarer_side_tricks",
                    "defender_side_tricks"},
}


def run_to_text(seed, hands, policies="heuristic", auction_only=False):
    buf = io.StringIO()
    trace_500.run_trace(seed, hands, policies, auction_only, out=buf)
    return buf.getvalue()


class TraceSmokeTest(unittest.TestCase):
    def setUp(self):
        self.text = run_to_text(seed=1, hands=5)
        self.records = [json.loads(line)
                        for line in self.text.splitlines() if line]

    def test_emits_valid_json_lines(self):
        self.assertGreater(len(self.records), 0)
        for line in self.text.splitlines():
            self.assertTrue(line.strip(), "no blank lines expected")
            json.loads(line)

    def test_v2_common_fields_on_every_record(self):
        for rec in self.records:
            self.assertEqual(COMMON_FIELDS - rec.keys(), set(),
                             f"missing common fields in {rec}")
            self.assertEqual(rec["v"], 2)
            self.assertEqual(rec["seed"], 1)
            self.assertIn(rec["first"], range(4))
            self.assertEqual(rec["first"], rec["hand"] % 4)

    def test_per_type_schema_fields(self):
        seen_types = set()
        for rec in self.records:
            t = rec["type"]
            self.assertIn(t, TYPE_FIELDS, f"unknown record type {t}")
            seen_types.add(t)
            missing = TYPE_FIELDS[t] - rec.keys()
            self.assertEqual(missing, set(),
                             f"{t} record missing fields {missing}")
        # 5 played hands must include the full event lifecycle.
        for t in ("deal", "auction_action", "auction_result", "exchange",
                  "play", "trick_winner", "hand_result"):
            self.assertIn(t, seen_types)

    def test_hand_structure(self):
        deals = [r for r in self.records if r["type"] == "deal"]
        for d in deals:
            self.assertEqual(len(d["hands"]), 4)
            for h in d["hands"]:
                self.assertEqual(len(h), 10)
            self.assertEqual(len(d["middle"]), 5)
            dealt = [c for h in d["hands"] for c in h] + d["middle"]
            self.assertEqual(sorted(dealt), list(range(45)),
                             "each deal must contain the full 45-card deck")
        results = [r for r in self.records if r["type"] == "hand_result"]
        self.assertEqual(len(results), 5, "one hand_result per hand")
        winners = [r for r in self.records if r["type"] == "trick_winner"]
        self.assertEqual(len(winners), 50, "10 tricks per played hand")
        for rec in self.records:
            if rec["type"] == "play":
                self.assertIn(rec["card"], rec["legal"])

    def test_byte_determinism(self):
        self.assertEqual(self.text, run_to_text(seed=1, hands=5))
        stress = run_to_text(seed=7, hands=3, policies="stress")
        self.assertEqual(stress,
                         run_to_text(seed=7, hands=3, policies="stress"))

    def test_matches_direct_simulate_hands(self):
        # The instrumented drivers are verbatim copies with no extra RNG
        # draws, so tracing N hands must reproduce simulate_hands exactly.
        n, seed = 50, 42
        results = trace_500.run_trace(seed, n, "heuristic", out=io.StringIO())
        expected = five_hundred.simulate_hands(
            n, trace_500.make_policies("heuristic"), seed=seed)
        got = {}
        for res in results:
            key = str(res.contract) + (" +SLAM" if res.slam else "")
            s = got.setdefault(key, {"n": 0, "made": 0, "decl_pts": 0,
                                     "def_pts": 0, "slams": 0})
            s["n"] += 1
            s["made"] += res.made
            s["decl_pts"] += res.declarer_delta
            s["def_pts"] += res.defender_delta
            s["slams"] += res.slam
        self.assertEqual(got, dict(expected))

    def test_auction_only_mode(self):
        text = run_to_text(seed=1, hands=5, auction_only=True)
        records = [json.loads(line) for line in text.splitlines()]
        types = {r["type"] for r in records}
        self.assertEqual(types - {"deal", "auction_action", "auction_result"},
                         set(), "auction-only traces must stop at the auction")
        self.assertEqual(
            len([r for r in records if r["type"] == "auction_result"]), 5,
            "auction-only: exactly one auction per hand index")


if __name__ == "__main__":
    unittest.main()
