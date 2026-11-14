"""Verify both reviewed Fantasy Football delta receipts against immutable Git objects."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parent.parent


def git(root, *args):
    return subprocess.check_output(["git", "-C", str(root), *args])


def paths_between(root, before, after):
    names = git(root, "diff", "--no-renames", "--name-only", "-z", before, after)
    return set(names.decode().rstrip("\0").split("\0")) if names else set()


def require(condition, reason):
    if not condition:
        raise ValueError(reason)


def verify_paths(root, revision, rows):
    for row in rows:
        path = row["path"]
        spec = f"{revision}:{path}"
        blob = git(root, "rev-parse", spec).decode().strip()
        require(blob == row["blob"], f"Git object mismatch for {spec}")
        digest = hashlib.sha256(git(root, "cat-file", "blob", blob)).hexdigest()
        require(digest == row["sha256"], f"SHA-256 mismatch for {spec}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True, type=Path, help="Fantasy Football Git object store")
    parser.add_argument("--source-main", required=True, help="Fetched authoritative Fantasy Football main ref")
    args = parser.parse_args()
    ledger = json.loads((ROOT / "migration/source-deltas.json").read_bytes())
    baseline = json.loads((ROOT / "migration/inventory.json").read_bytes())["revision"]
    driver = json.loads((ROOT / "migration/mig-006-driver-import.json").read_bytes())
    uat, boot = (next(row for row in ledger["entries"] if row["id"] == name)
                 for name in ("DELTA-004", "DELTA-005"))
    source_head = git(args.source, "rev-parse", args.source_main).decode().strip()
    require(source_head == driver["sourceMerge"], "Fantasy Football main moved. Reconcile its new changes before release.")
    for before, after, delta in [(baseline, driver["sourceBase"], uat), (driver["sourceBase"], source_head, boot)]:
        observed = paths_between(args.source, before, after)
        source_paths = {row["path"] for row in delta["sourcePaths"]}
        require(len(source_paths) == len(delta["sourcePaths"]), f"{delta['id']} contains duplicate source paths")
        require(not observed ^ source_paths, f"{delta['id']} path drift: {sorted(observed ^ source_paths)}")
        verify_paths(args.source, after, delta["sourcePaths"])
        destination = delta["destinationCommit"]
        git(ROOT, "merge-base", "--is-ancestor", destination, "HEAD")
        verify_paths(ROOT, destination, delta["destinationPaths"])
        for row in delta["destinationPaths"]:
            git(ROOT, "cat-file", "-e", f"HEAD:{row['path']}")
    entries = driver["paths"]
    require({row["path"] for row in entries} == {row["path"] for row in boot["sourcePaths"]},
            "BOOT-037 import receipt and source ledger disagree")
    exclusions = {row["path"] for row in entries if row["disposition"] == "retain-source-policy"}
    require(exclusions == {"AGENTS.md", "BOOTSTRAP.md", "README.md"}, "Review changed exclusions before release")
    mapped = {row["destinationPath"] for row in entries if row["path"] not in exclusions}
    require(len(entries) == len(mapped) + len(exclusions), "BOOT-037 mappings are not one-to-one")
    require(mapped == {row["path"] for row in boot["destinationPaths"]}, "BOOT-037 destination mapping drifted")
    print(json.dumps({
        "sourceBaseline": baseline, "sourceExport": driver["sourceBase"], "sourceMain": source_head,
        "destination": git(ROOT, "rev-parse", "HEAD").decode().strip(),
        "verifiedUatPaths": len(uat["sourcePaths"]), "verifiedDriverPaths": len(entries),
        "mappedDriverPaths": len(mapped), "excludedSourcePolicy": sorted(exclusions),
    }, indent=2))


if __name__ == "__main__":
    main()
