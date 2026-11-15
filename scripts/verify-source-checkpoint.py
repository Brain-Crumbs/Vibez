"""Verify both reviewed Fantasy Football delta receipts against immutable Git objects."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parent.parent
DESTINATION_ADAPTATIONS = {
    "src/uat-review/uat-review.ts": (
        "45937a05ee6485b412d448969fbeec2e2dc4e665",
        "Portable project composition and the later native evidence writer preserve the UAT bridge.",
    ),
    "package.json": (
        "5ed64a046cecbae67357349c4154dee53c263082",
        "MIG-008 candidate identity, package docs and isolated conformance entry point.",
    ),
    "tests/helpers/driver-fixture.mjs": (
        "eb57ce2b50153b8e4f73c6f662fa3927ef462e7c",
        "Defer the source runtime import so isolated consumers load the tarball.",
    ),
}


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
            path = row["path"]
            expected = DESTINATION_ADAPTATIONS.get(path, (row["blob"], ""))[0]
            observed = git(ROOT, "ls-tree", "HEAD", "--", path).decode().strip()
            require(observed == f"100644 blob {expected}\t{path}", f"Unreviewed destination drift: {path}")
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
        "reviewedAdaptations": {path: details[1] for path, details in DESTINATION_ADAPTATIONS.items()},
    }, indent=2))


if __name__ == "__main__":
    main()
