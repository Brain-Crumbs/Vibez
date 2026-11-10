"""Boundaries for the immutable export verifier."""

import copy
import importlib.util
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("seed_export", ROOT / "scripts/seed_export.py")
seed = importlib.util.module_from_spec(spec)
spec.loader.exec_module(seed)


class SeedTests(unittest.TestCase):
    def test_path_and_credential_guard(self):
        seed.scan({"tests/fixtures/canary.task.json": ("blob", b"fixture")})
        for path in ("../outside", "C:/outside", "src/../escape", ".Git/config",
                     ".agent/state/lock", "tasks/definitions/canary.task.json",
                     "bootstrap/canary-proof.txt", "src/aux.ts", "name."):
            with self.subTest(path=path), self.assertRaises(ValueError):
                seed.scan({path: ("blob", b"fixture")})
        with self.assertRaisesRegex(ValueError, "collision"):
            seed.scan({"src/module.ts": ("a", b"a"), "SRC/module.ts": ("b", b"b")})
        with self.assertRaisesRegex(ValueError, "credential"):
            seed.scan({"fixture.txt": ("a", b"ghp_" + b"X" * 36)})

    def test_approved_snapshot_and_scope_reject_changes(self):
        inventory = (ROOT / seed.INVENTORY).read_bytes()
        plan = json.loads((ROOT / seed.PLAN).read_bytes())
        entries, _ = seed.provenance(inventory, plan)
        self.assertEqual(sum(item["action"] != "retain" for item in entries.values()), 244)
        with self.assertRaisesRegex(ValueError, "inventory changed"):
            seed.provenance(inventory + b"\n", plan)
        changed = copy.deepcopy(plan)
        first = next(iter(changed["sourceChanges"]))
        changed["sourceChanges"][first]["sha256"] = "0" * 64
        with self.assertRaisesRegex(ValueError, "owner decision"):
            seed.provenance(inventory, changed)
