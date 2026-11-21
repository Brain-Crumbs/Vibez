"""Validate the exact contract and conformance inputs shipped to browser consumers."""

import hashlib
import json
import re
import unittest
from datetime import datetime
from pathlib import Path

from urllib.parse import urlsplit

from jsonschema import Draft202012Validator, FormatChecker


SPEC = Path(__file__).resolve().parents[1] / "docs/specs/manual-console-v1"

# Plain jsonschema can silently ignore optional formats. Supply the v1 UTC
# timestamp and HTTPS URI checks explicitly in every conformance environment.
FORMATS = FormatChecker()


@FORMATS.checks("date-time", raises=ValueError)
def is_calendar_time(value):
    if not isinstance(value, str):
        return True
    datetime.fromisoformat(value)
    return True


@FORMATS.checks("uri", raises=ValueError)
def is_https_uri(value):
    if not isinstance(value, str):
        return True
    parts = urlsplit(value)
    labels = (parts.hostname or "").rstrip(".").split(".")
    return (
        parts.scheme == "https"
        and all(re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label) for label in labels)
        and (parts.port is None or 1 <= parts.port <= 65535)
        and re.search(r"%(?![0-9a-fA-F]{2})", value) is None
    )


class ManualConsoleContractTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        schema = json.loads((SPEC / "schema.json").read_text(encoding="utf-8"))
        cls.manifest = json.loads((SPEC / "fixtures.json").read_text(encoding="utf-8"))
        Draft202012Validator.check_schema(schema)
        cls.validator = Draft202012Validator(
            schema, format_checker=FORMATS
        )
        cls.fixtures = {case["id"]: case for case in cls.manifest["fixtures"]}
        cls.definitions = schema["$defs"]

    def payload(self, fixture):
        return self.fixtures[fixture]["payload"]["data"]

    def test_published_examples_match_the_same_schema_and_route(self):
        self.assertEqual(self.manifest["format"], "vibez.manual-console.conformance")
        self.assertEqual(self.manifest["version"], 1)
        self.assertEqual(len(self.fixtures), len(self.manifest["fixtures"]))
        for fixture, case in self.fixtures.items():
            with self.subTest(fixture=fixture):
                definition = case["definition"]
                self.assertIn(definition, self.definitions)
                route_validator = self.validator.evolve(
                    schema={"$ref": f"#/$defs/{definition}"}
                )
                self.assertEqual(route_validator.is_valid(case["payload"]), case["valid"])
                # This valid receipt is invalid specifically on a run detail route.
                root_valid = case["valid"] or fixture == "incorrect-route-kind"
                self.assertEqual(self.validator.is_valid(case["payload"]), root_valid)

    def test_original_markdown_survives_json_and_utf8_roundtrip(self):
        current = self.payload("waiting")
        record = self.payload("multiline")
        expected = (
            "# Developer handoff\r\n\r\nCopy exactly.  \r\n\r\n"
            "```json\r\n"
            '{"packetId":"'
            + ("d" * 64)
            + '","role":"Developer","revision":"'
            + ("a" * 40)
            + '","toolPolicy":{"allowed":["read_file"],"network":"none"},'
            '"responseTemplate":{"status":"<outcome>"},"label":"café Δ 🙂"}'
            "\r\n```\r\n"
        )
        encoded = json.dumps(record, ensure_ascii=False).encode("utf-8")
        body = json.loads(encoded)["body"]
        self.assertEqual(body["originalMarkdown"].encode("utf-8"), expected.encode("utf-8"))
        self.assertEqual(body["sha256"], hashlib.sha256(expected.encode("utf-8")).hexdigest())
        self.assertEqual(record["packet"], current["pending"]["role"])
        self.assertEqual(record["target"]["attemptId"], current["attempt"]["attemptId"])
        self.assertEqual(record["target"]["projectId"], current["summary"]["projectId"])
        self.assertEqual(record["target"]["sessionId"], current["summary"]["sessionId"])

    def test_disconnect_keeps_the_last_observed_snapshot(self):
        waiting = self.payload("waiting")
        self.assertEqual(self.payload("connected")["lastObserved"], waiting)
        self.assertEqual(self.payload("disconnected")["lastObserved"], waiting)
        self.assertIsNone(self.payload("disconnected-before-read")["lastObserved"])
        self.assertEqual(waiting["pullRequest"], {"state": "unknown"})
        self.assertEqual(waiting["ci"], {"state": "unknown"})
        self.assertEqual(self.payload("blocked")["actions"], [])
        self.assertEqual(self.payload("completed")["actions"], [])
        self.assertEqual(self.payload("prepared")["actions"], ["start"])

    def test_receipt_replay_and_gate_observation_are_independent(self):
        request = self.payload("reply-raw")
        receipt = self.payload("accepted")
        initial = self.payload("finished")
        replay = self.payload("replayed")
        self.assertEqual(initial["operation"]["receiptId"], receipt["receiptId"])
        self.assertEqual(initial["target"], receipt["target"])
        self.assertEqual(initial["requestId"], request["requestId"])
        self.assertEqual(replay, {**initial, "replayed": True})
        self.assertEqual(request["expectedPacketId"], receipt["importedPacketId"])
        self.assertEqual(self.payload("original-reply")["body"]["originalReply"], request["replyText"])
        self.assertEqual(self.payload("reused")["disposition"], "reused")
        rejected = self.payload("rejected")
        fenced = self.payload("reply-fenced")
        repair = self.payload("repair-pending")["pending"]
        self.assertEqual(rejected["requestId"], fenced["requestId"])
        self.assertEqual(rejected["expectedPacketId"], fenced["expectedPacketId"])
        self.assertEqual(rejected["expectedPacketId"], repair["role"]["packetId"])
        self.assertEqual(rejected["repairPacketId"], repair["repair"]["packet"]["packetId"])
        self.assertEqual(repair["repair"]["replyToPacketId"], rejected["expectedPacketId"])
        repair_record = self.payload("repair-correspondence")
        self.assertEqual(repair_record["packet"], repair["repair"]["packet"])
        repair_bytes = repair_record["body"]["originalMarkdown"].encode("utf-8")
        self.assertIn(b"original packet.  \r\n", repair_bytes)
        self.assertEqual(hashlib.sha256(repair_bytes).hexdigest(), repair_record["body"]["sha256"])
        native_result = json.loads(request["replyText"])
        self.assertEqual(native_result["packetId"], receipt["importedPacketId"])
        self.assertEqual(native_result["revisionIdentity"], self.payload("waiting")["summary"]["revision"])
        self.assertEqual(native_result["runId"], self.payload("waiting")["attempt"]["nativeRunId"])
        self.assertIsNone(rejected["importedPacketId"])
        self.assertEqual(self.payload("redacted-reply")["body"]["reason"], "redacted")
        self.assertEqual(self.payload("validation-failed")["gate"]["outcome"], "fail")
        self.assertEqual(receipt["disposition"], "accepted")
        self.assertEqual(self.payload("qa")["gate"], {"state": "awaiting-role", "role": "QA"})

    def test_history_preserves_attempts_receipts_and_unknown_legacy_data(self):
        history = self.payload("history")
        rework = self.payload("rework")
        events = history["events"]
        self.assertEqual(history["sessionId"], rework["summary"]["sessionId"])
        self.assertEqual(len({event["eventId"] for event in events}), len(events))
        dated = [event["recordedAt"] for event in events if event["recordedAt"] is not None]
        self.assertEqual(dated, sorted(dated))
        receipts = {
            event["details"]["receipt"]["receiptId"]: event["details"]["receipt"]
            for event in events if event["details"]["kind"] == "receipt"
        }
        for event in events:
            detail = event["details"]
            if detail["kind"] == "reply":
                receipt = receipts[detail["receiptId"]]
                self.assertEqual(receipt["target"]["sessionId"], history["sessionId"])
                self.assertEqual(receipt["target"]["attemptId"], event["attemptId"])
                self.assertEqual(receipt["expectedPacketId"], detail["expectedPacketId"])
        check = next(event for event in events if event["details"]["kind"] == "validation-check")
        gate = next(event for event in events if event["details"]["kind"] == "gate")
        self.assertEqual(check["attemptId"], gate["attemptId"])
        self.assertEqual(check["details"]["revision"], gate["details"]["gate"]["revision"])
        failed_check = self.payload("validation-check-failed")["events"][0]["details"]
        self.assertEqual(failed_check["outcome"], self.payload("validation-failed")["gate"]["outcome"])
        self.assertNotEqual(check["details"]["evidenceId"], failed_check["evidenceId"])
        link = next(event["details"] for event in events if event["details"]["kind"] == "rework")
        self.assertEqual(link["fromAttemptId"], rework["attempt"]["predecessorAttemptId"])
        self.assertEqual(link["toAttemptId"], rework["summary"]["currentAttemptId"])
        self.assertIsNone(events[-1]["recordedAt"])
        self.assertEqual(events[-1]["details"]["packet"], self.payload("historical-missing")["packet"])
        self.assertEqual(self.payload("historical-missing")["body"]["reason"], "missing")


if __name__ == "__main__":
    unittest.main()
