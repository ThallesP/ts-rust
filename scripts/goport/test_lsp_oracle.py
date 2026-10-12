#!/usr/bin/env python3
"""Unit tests for lsp_oracle.py classify with the D1 option B rule (drop_d1_kind). No server runs.

  python3 scripts/goport/test_lsp_oracle.py
"""
import copy
import importlib.util
import os
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("lsp_oracle", os.path.join(HERE, "lsp_oracle.py"))
lo = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lo)

# Plain Go at fed0bf24149f (server.go:388 supportedCodeActionKinds).
GO = ["quickfix", "source.organizeImports.ts", "source.removeUnusedImports.ts", "source.sortImports.ts", "source.fixAll.ts"]
# effect-tsgo 0.51.1 (patch 017) and the port: refactor.rewrite after quickfix.
PORT = GO[:1] + ["refactor.rewrite"] + GO[1:]


def answer(kinds, **caps):
    return {"capabilities": {"codeActionProvider": {"codeActionKinds": kinds}, **caps}, "serverInfo": {"name": "typescript"}}


def rec(result, method="initialize"):
    return {"i": 0, "kind": "request", "method": method, "status": "ok", "response": {"result": result}}


def cls(go, port, method="initialize"):
    return lo.classify(rec(go, method), rec(port, method), None)[0]


class D1Kind(unittest.TestCase):
    def test_port_kind_dropped_against_plain_go(self):
        self.assertEqual(cls(answer(GO), answer(PORT)), "same")

    def test_other_extra_kind_still_differs(self):
        other = GO[:1] + ["refactor.extract"] + GO[1:]
        self.assertEqual(lo.classify(rec(answer(GO)), rec(answer(other)), None),
                         ("diff", None, "/capabilities/codeActionProvider/codeActionKinds/1"))

    def test_other_extra_kind_beside_d1_kind_still_differs(self):
        self.assertEqual(cls(answer(GO), answer(PORT + ["refactor.extract"])), "diff")

    def test_drops_exactly_one(self):
        self.assertEqual(cls(answer(GO), answer(PORT[:2] + ["refactor.rewrite"] + PORT[2:])), "diff")

    def test_order_still_counts(self):
        self.assertEqual(cls(answer(GO), answer(PORT[::-1])), "diff")

    def test_other_capability_still_differs(self):
        self.assertEqual(cls(answer(GO), answer(PORT, hoverProvider=True)), "diff")

    def test_go_with_the_kind_compares_as_is(self):
        # An E0 (effect-tsgo) golden lists the kind: no drop on either side.
        self.assertEqual(cls(answer(PORT), answer(PORT)), "same")
        self.assertEqual(cls(answer(PORT), answer(GO)), "diff")

    def test_only_initialize(self):
        self.assertEqual(cls(answer(GO), answer(PORT), method="textDocument/hover"), "diff")

    def test_saved_answer_unchanged(self):
        port = answer(PORT)
        before = copy.deepcopy(port)
        self.assertEqual(cls(answer(GO), port), "same")
        self.assertEqual(port, before)

    def test_no_code_action_kinds(self):
        self.assertEqual(cls({"capabilities": {}}, answer(PORT)), "diff")
        port = answer(PORT)
        self.assertIs(lo.drop_d1_kind("initialize", None, port), port)


if __name__ == "__main__":
    unittest.main()
