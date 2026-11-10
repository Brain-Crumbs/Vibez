"""Verify the sealed MIG-003 seed or reconstruct its tree from approved inputs."""

import argparse
from hashlib import sha256
from io import BytesIO
import json
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[1]
BASE = "4c838c1598fce5348c3a8052146b42e4eb05e1a4"
SOURCE = "5cd23ef5415f2d2140654551f9152339417e4b58"
INVENTORY = "migration/inventory.json"
INVENTORY_HASH = "4fd27bff41e2cf8f63e366d13e6c6f1bf3c07e557ec223e39b5c73947dd5326e"
SCOPE_HASH = "c0c8927f73972a999108a5e82acd3f8bc32c0cc640a86a93374e870ce2d87f2a"
DECISION = "https://github.com/Brain-Crumbs/Vibez/issues/3#issuecomment-6747942125"
PLAN = "migration/seed-provenance.json"
RECEIPT = "migration/admissions/mig-003.json"
LEDGER = "migration/source-deltas.json"
EVIDENCE_PATHS = {RECEIPT, LEDGER}
PRIVATE_MATERIAL = re.compile(
    rb"gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|"
    rb"-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----|"
    rb"(?:AKIA|ASIA)[A-Z0-9]{16}"
)
WINDOWS_DEVICE = re.compile(r"(?i)^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)")


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(data):
    return sha256(data).hexdigest()


def git(repo, *args, input=None):
    return subprocess.check_output(
        ["git", "--no-replace-objects", "-C", str(repo), *args], input=input,
    )


def tree(repo, revision):
    """Return source path -> (Git blob ID, raw bytes). Read only regular files."""
    rows = git(repo, "ls-tree", "-rz", revision).split(b"\0")
    index = {}
    for row in filter(None, rows):
        metadata, path = row.split(b"\t", 1)
        mode, kind, oid = metadata.decode("ascii").split()
        require((mode, kind) == ("100644", "blob"), "Seed requires regular non-executable files")
        index[path.decode("utf-8")] = oid

    batch = BytesIO(git(repo, "cat-file", "--batch", input="".join(
        oid + "\n" for oid in index.values()
    ).encode("ascii")))
    result = {}
    for path, oid in index.items():
        actual, kind, length = batch.readline().decode("ascii").split()
        require((actual, kind) == (oid, "blob"), f"Unexpected Git object for {path}")
        contents = batch.read(int(length))
        require(batch.read(1) == b"\n", f"Invalid Git blob framing for {path}")
        result[path] = (oid, contents)
    require(not batch.read(1), "Unexpected trailing Git blob data")
    return result


def scan(files):
    """Reject unsafe paths and common private material in a seed artifact."""
    folded = set()
    for name, (_, data) in files.items():
        path = PurePosixPath(name)
        require(bool(path.parts) and not path.is_absolute() and path.as_posix() == name
                and not re.search(r'[\x00-\x1f<>:"\\|?*]', name)
                and all(part != ".." and not part.endswith((".", " "))
                        and not WINDOWS_DEVICE.match(part) for part in path.parts),
                f"Nonportable seed path: {name}")
        parts = [part.casefold() for part in path.parts]
        require(not any(part in {".git", ".agent", ".aws", ".codex", ".venv", "node_modules", "dist", "worktrees"}
                        or part == ".env" or part.startswith(".env.") for part in parts)
                and parts[0] not in {"bootstrap", "evidence", "reviews"}
                and (parts[:2] != ["tasks", "definitions"] or name == "tasks/definitions/.gitkeep"),
                f"Excluded seed path: {name}")
        require(name.casefold() not in folded, f"Case-insensitive seed collision: {name}")
        folded.add(name.casefold())
        require(b"\0" not in data and not PRIVATE_MATERIAL.search(data),
                f"Binary or credential-like material: {name}")


def provenance(inventory_bytes, plan):
    require(digest(inventory_bytes) == INVENTORY_HASH, "Reviewed inventory changed")
    inventory = json.loads(inventory_bytes)
    entries = {item["source"]: item for item in inventory["entries"]}
    changes = plan["sourceChanges"]
    require(plan["version"] == 1 and plan["sourceRevision"] == SOURCE
            and plan["rightsDecision"] == DECISION and plan["scopeSha256"] == SCOPE_HASH,
            "Export authorization changed")
    require(len(entries) == len(inventory["entries"]) == 289
            and len(changes) == 6 and changes.keys() <= entries.keys(),
            "Unexpected source path set")
    identities = {name: (item["sourceBlob"], item["sha256"]) for name, item in entries.items()}
    for name, change in changes.items():
        require(entries[name]["action"] != "retain" and change["blob"] != identities[name][0],
                f"Unexpected source delta for {name}")
        identities[name] = (change["blob"], change["sha256"])
    rows = "".join(f"{name}\t{identities[name][0]}\t{identities[name][1]}\n"
                   for name in sorted(entries, key=str.encode) if entries[name]["action"] != "retain")
    require(digest(rows.encode("utf-8")) == SCOPE_HASH, "Source scope differs from the owner decision")
    return entries, identities


def reconstruct(base, seed, plan, entries, identities, source=None):
    """Rebuild raw imports from source and apply explicit sealed Vibez overlays."""
    adaptations = plan["adaptations"]
    authored = plan["authored"]
    removed = plan["removed"]
    require(all(removed.values()) and removed.keys() <= base.keys(), "Unaccounted removal")
    expected = {name: blob[1] for name, blob in base.items()
                if name not in removed and name not in EVIDENCE_PATHS}
    destinations = set()
    used_adaptations = set()
    for name, entry in entries.items():
        if entry["action"] == "retain":
            continue
        destination = entry["destination"]
        require(destination not in destinations and destination in seed,
                f"Missing or duplicate export destination: {destination}")
        destinations.add(destination)
        _, data = seed[destination]
        if name in adaptations:
            change = adaptations[name]
            require(entry["action"] == "adapt" and change["reason"] and digest(data) == change["sha256"],
                    f"Unapproved adaptation: {name}")
            used_adaptations.add(name)
        else:
            require(destination == name and digest(data) == identities[name][1],
                    f"Raw source content or path changed: {name}")
            if source is not None:
                data = source[name][1]
        expected[destination] = data

    require(used_adaptations == adaptations.keys() and len(destinations) == 244,
            "Unaccounted adaptation or export destination")
    for name, reason in authored.items():
        require(reason and name in seed and name not in destinations and name not in EVIDENCE_PATHS,
                f"Invalid authored overlay: {name}")
        expected[name] = seed[name][1]
    require(expected == {name: blob[1] for name, blob in seed.items() if name not in EVIDENCE_PATHS},
            "Sealed tree contains an unaccounted path or modification")
    return expected


def check_receipt(receipt):
    revision = receipt["seedRevision"]
    require(bool(re.fullmatch(r"[0-9a-f]{40}", revision)) and receipt["sourceRevision"] == SOURCE
            and receipt["baseRevision"] == BASE and receipt["rightsDecision"] == DECISION
            and receipt["taskId"] == "MIG-003" and receipt["scopeSha256"] == SCOPE_HASH,
            "Invalid seed receipt")
    prerequisite = receipt["prerequisite"]
    head = "23d7ae898acad6b0325182951512964bedb927fc"
    require(prerequisite["taskId"] == "MIG-002" and prerequisite["head"] == head
            and prerequisite["merge"] == "053a53956a66881b4d92356fcc9f1deca321e875",
            "MIG-002 acceptance identity differs")
    checks = prerequisite["ci"]
    require(sorted(item["name"] for item in checks)
            == ["Design contracts (ubuntu-latest)", "Design contracts (windows-latest)"],
            "Missing prerequisite CI contexts")
    for item in checks:
        projection = {key: value for key, value in item.items() if key != "receiptSha256"}
        require(item["head"] == head and item["status"] == "completed" and item["conclusion"] == "success"
                and digest(json.dumps(projection, sort_keys=True, separators=(",", ":")).encode())
                == item["receiptSha256"], "Prerequisite CI receipt differs")
    reviews = prerequisite["reviews"]
    require(sorted(item["role"] for item in reviews) == ["Architecture", "QA", "UAT/Product"]
            and all(item["outcome"] == "PASS" and item["url"].startswith(prerequisite["pr"] + "#issuecomment-")
                    and re.fullmatch(r"[0-9a-f]{64}", item["commentBodySha256"])
                    and re.fullmatch(r"[0-9a-f]{64}", item["originalReportSha256"]) for item in reviews),
            "Missing prerequisite review evidence")


def check_candidate(base, seed, head, plan, entries, receipt):
    require({name: blob for name, blob in seed.items() if name not in EVIDENCE_PATHS}
            == {name: blob for name, blob in head.items() if name not in EVIDENCE_PATHS},
            "Candidate differs from the sealed seed outside its integration evidence")
    old = json.loads(base[LEDGER][1])
    current = json.loads(head[LEDGER][1])
    delta = current["entries"][-1]
    require({**current, "entries": current["entries"][:-1]} == old
            and delta["id"] == "DELTA-004" and delta["supersedes"] == "DELTA-001"
            and delta["sourceCommit"] == SOURCE and delta["sourcePr"] == receipt["sourceRepairPR"]
            and delta["destinationCommit"] == receipt["seedRevision"]
            and delta["disposition"] == "imported" and delta["destinationPr"] == receipt["destinationPR"],
            "Source delta ledger is not an auditable append")
    require({row["path"]: {"blob": row["blob"], "sha256": row["sha256"]}
             for row in delta["sourcePaths"]} == plan["sourceChanges"],
            "UAT source delta hashes differ from the authorized snapshot")
    require({row["path"]: (row["blob"], row["sha256"]) for row in delta["destinationPaths"]}
            == {entries[path]["destination"]: (seed[entries[path]["destination"]][0],
                                               digest(seed[entries[path]["destination"]][1]))
                for path in plan["sourceChanges"]}, "UAT destination delta hashes differ from the sealed seed")


def verify(source_repo, output, check_head):
    receipt = json.loads(git(ROOT, "show", f"HEAD:{RECEIPT}"))
    check_receipt(receipt)
    revision = receipt["seedRevision"]
    for ancestor, descendant in ((BASE, revision), (revision, "HEAD")):
        git(ROOT, "merge-base", "--is-ancestor", ancestor, descendant)
    require(git(ROOT, "rev-parse", f"{revision}^{{tree}}").decode().strip() == receipt["seedTree"],
            "Seed tree identity differs from the receipt")
    seed = tree(ROOT, revision)
    scan(seed)
    plan = json.loads(seed[PLAN][1])
    entries, identities = provenance(seed[INVENTORY][1], plan)
    source = tree(source_repo, SOURCE) if source_repo is not None else None
    if source is not None:
        require({name: (oid, digest(data)) for name, (oid, data) in source.items()} == identities,
                "Pinned source has an unaccounted file or blob")
    base = tree(ROOT, BASE)
    expected = reconstruct(base, seed, plan, entries, identities, source)
    if check_head:
        head = tree(ROOT, "HEAD")
        scan(head)
        check_candidate(base, seed, head, plan, entries, receipt)
        require(not git(ROOT, "status", "--porcelain", "--untracked-files=all").strip(),
                "Seed candidate checkout is dirty")
        for name, (_, data) in head.items():
            path = ROOT / name
            require(path.is_file() and not path.is_symlink() and path.read_bytes() == data,
                    f"Candidate worktree bytes differ for {name}")
    if output is not None:
        require(source is not None, "Reproduction requires --source")
        output = output.parent.resolve(strict=True) / output.name
        output.mkdir()
        for name, data in expected.items():
            path = output / name
            path.parent.mkdir(parents=True, exist_ok=True)
            with path.open("xb") as stream:
                stream.write(data)
        actual = {path.relative_to(output).as_posix(): path.read_bytes()
                  for path in output.rglob("*") if path.is_file()}
        require(actual == expected, "Fresh export does not match the sealed seed tree")
    print(f"PASS: {len(entries)} source dispositions, 244 export candidates, "
          f"{len(expected)} sealed files at {revision}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, help="Fantasy Football clone containing the authorized commit")
    parser.add_argument("--output", type=Path, help="New directory under an existing parent for the reproduced tree")
    parser.add_argument("--check-head", action="store_true", help="Also verify the MIG-003 candidate and clean worktree")
    args = parser.parse_args()
    try:
        verify(args.source, args.output, args.check_head)
    except (KeyError, OSError, ValueError, subprocess.CalledProcessError) as error:
        print(f"FAIL: {error}", file=sys.stderr)
        raise SystemExit(1) from error
