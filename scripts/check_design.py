"""Read-only MIG-002 specification audit; not a runtime admission/identity engine."""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import subprocess

from jsonschema import Draft202012Validator

ROOT = Path(__file__).resolve().parents[1]
SOURCE = '50ef51e7dd2443dd0cec644c04e8db1b7fd612f7'
ENGINE = 'fbc46888ce0bd2af454f471561911a913d32e6fc'
BRANCH = 'migration/mig-002-boundaries-and-contracts'

def require(condition, message):
    if not condition:
        raise ValueError(message)

def read(path):
    return json.loads(path.read_text(encoding='utf-8'))

def digest(data):
    return hashlib.sha256(data).hexdigest()

def git(root, *args, input=None):
    return subprocess.check_output(['git', '-C', str(root), *args], input=input)

def blobs(root, revision):
    """Read exact Git bytes in a single batch, independent of checkout EOL rules."""
    rows = git(root, 'ls-tree', '-r', '-z', revision).split(b'\0')
    paths = {}
    for row in rows:
        if not row:
            continue
        meta, path = row.split(b'\t', 1)
        mode, kind, oid = meta.decode().split()
        require(kind == 'blob', 'Unexpected source submodule')
        paths[path.decode()] = oid
    raw = git(root, 'cat-file', '--batch', input=('\n'.join(paths.values())+'\n').encode())
    result = {}
    offset = 0
    for path, oid in paths.items():
        end = raw.index(b'\n', offset)
        actual, kind, length = raw[offset:end].decode().split()
        require(actual == oid and kind == 'blob', 'Invalid Git blob response')
        offset = end + 1
        data = raw[offset:offset+int(length)]
        result[path] = (oid, data)
        offset += int(length) + 1
    return result

def check_config(config, schema):
    Draft202012Validator(schema).validate(config)
    paths = config['paths']
    # Static ambiguity checks only; physical identity/containment is MIG-004.
    normalized = {k: PurePosixPath(v).as_posix().casefold() for k, v in paths.items()}
    for key, value in paths.items():
        require(value not in ('.', '') and str(PurePosixPath(value)) == value,
                f'Noncanonical design path: {key}')
        require(not any(c in value for c in ':\\'), f'Unsupported path character: {key}')
    keys = list(normalized)
    for i, a in enumerate(keys):
        for b in keys[i+1:]:
            x, y = normalized[a], normalized[b]
            require(not (x == y or x.startswith(y+'/') or y.startswith(x+'/')),
                    f'Overlapping design paths: {a}, {b}')
    ids = [v['id'] for v in config['validators']]
    require(len(set(ids)) == len(ids), 'Duplicate validator ID')

def check_inventory(inventory, source_blobs):
    require(inventory['revision'] == SOURCE, 'Wrong inventory revision')
    entries = inventory['entries']
    require(len({e['source'] for e in entries}) == len(entries), 'Duplicate inventory path')
    require({e['source'] for e in entries} == set(source_blobs), 'Incomplete source inventory')
    destinations = []
    for e in entries:
        oid, data = source_blobs[e['source']]
        require(e['sourceBlob'] == oid and e['sha256'] == digest(data), f"Source hash: {e['source']}")
        require(e['category'] in ('vibez', 'consumer', 'test-example', 'historical'), 'Unknown ownership')
        require(e['action'] in ('copy', 'adapt', 'retain'), 'Unknown action')
        require(e['owner'] and e['testOwner'], 'Missing ownership')
        d = e['destination']
        if e['action'] == 'retain':
            require(d == 'source:'+e['source'], 'Retained source moved')
        else:
            require(not d.startswith(('/', 'source:', '.agent/')) and '..' not in PurePosixPath(d).parts,
                    'Unsafe destination')
            destinations.append(d)
    require(len(destinations) == len(set(destinations)), 'Destination collision')

def check_records(root, engine):
    task = read(root/'migration/tasks/mig-002.task.json')
    requirement = read(root/'requirements/mig-002.requirement.json')
    for family, record in [('task', task), ('requirement', requirement)]:
        schema = read(engine/f'schemas/v1/{family}.schema.json')
        Draft202012Validator.check_schema(schema)
        Draft202012Validator(schema).validate(record)
    receipt = read(root/'migration/admissions/mig-002.json')
    issue = read(root/'migration/sources/issue-2.json')
    require(task['canonicalBranch'] == BRANCH and task['taskId'] == 'MIG-002', 'Task identity drift')
    require(task['dependencies'] == receipt['nativeDependencies'] == [], 'Unexpected native dependency')
    require(receipt['originalExternalEdges'] == ['Brain-Crumbs/IPTFantasyFootball#80'], 'Lost external edge')
    require(task['acceptanceCriteria'] == requirement['acceptanceCriteria'], 'Criteria mismatch')
    require(task['requirements'] == [requirement['requirementId']], 'Requirement reference mismatch')
    require(task['requiredReviewRoles'] == ['Developer','QA','Architect','UAT/Product','MergeController'], 'Review roles weakened')
    require(receipt['issueBodySha256'] == digest(issue['body'].encode()), 'Issue changed')
    require('sha256:'+receipt['issueBodySha256'] in requirement['sourceRefs'], 'Source trace lost')
    for key, path in [('definitionSha256','migration/tasks/mig-002.task.json'),('requirementSha256','requirements/mig-002.requirement.json')]:
        require(receipt[key] == digest((root/path).read_bytes()), 'Receipt binding changed: '+path)
    for item in receipt['evidence']:
        require(item['sha256'] == digest((root/'migration/admissions'/item['path']).read_bytes()), 'Admission evidence changed')
    pr = read(root/'migration/admissions/evidence/pr-83.json')
    require(pr['merged'] is True and pr['merge_commit_sha'] == SOURCE and
            pr['head_sha'] == receipt['prerequisites'][0]['head'], 'Unaccepted prerequisite')
    require(read(root/'migration/admissions/evidence/ci-83.json')['workflow_runs'][0]['conclusion'] == 'success', 'Prerequisite CI missing')
    require({r['role'] for r in receipt['prerequisites'][0]['reviews']} == {'qa','architecture','uat'}, 'Missing prerequisite reviews')
    require(all(r['outcome'] == 'PASS' for r in receipt['prerequisites'][0]['reviews']), 'Rejected prerequisite review')
    require(not (root/'tasks/definitions').exists() and not (root/'src').exists(), 'Seed design became runtime implementation')

def check_links(root):
    files = [p for p in root.rglob('*.md') if not any(part.startswith('.') for part in p.relative_to(root).parts)]
    for path in files:
        for link in re.findall(r'\]\(([^)]+)\)', path.read_text(encoding='utf-8')):
            if re.match(r'[a-z]+:', link) or link.startswith('#'):
                continue
            target = link.split('#')[0]
            require((path.parent/target).exists(), f'Broken link in {path.relative_to(root)}: {link}')

def check_all(root, source, engine):
    require(git(source,'rev-parse','HEAD').decode().strip() == SOURCE, 'Source checkout pin mismatch')
    require(git(engine,'rev-parse','HEAD').decode().strip() == ENGINE, 'Engine checkout pin mismatch')
    require(not git(engine,'status','--porcelain','--untracked-files=no').strip(), 'Dirty pinned engine')
    source_blobs = blobs(source, SOURCE)
    check_inventory(read(root/'migration/inventory.json'), source_blobs)
    caps = read(root/'migration/capabilities.json')
    modules = {p.split('/')[1] for p in source_blobs if p.startswith('src/')}
    require({m['module'] for m in caps['modules']} == modules and len(caps['modules']) == 24, 'Module coverage')
    for m in caps['modules']:
        require(m['contract'] in source_blobs and m['testOwner'] and m['sourceTests'], 'Module contract/test coverage')
        require(all(p in source_blobs for p in m['sourceTests']), 'Unknown source test')
    commands = source_blobs['src/cli/commands.ts'][1].decode()
    expected = re.findall(r'name: "([a-z]+)"', commands)
    require(sorted(c['command'] for c in caps['cli']) == sorted(expected), 'CLI coverage')
    require([e['criterion'] for e in caps['epicTrace']] == [f'M-AC-{i:02}' for i in range(1,10)], 'Epic coverage')
    require(all((root/e['design']).exists() and e['testOwners'] for e in caps['epicTrace']), 'Epic evidence path')
    schema = read(root/'docs/specs/project-config.schema.json')
    Draft202012Validator.check_schema(schema)
    configs = [read(root/f'examples/{n}/vibez.config.json') for n in ('alpha','beta')]
    for c in configs:
        check_config(c, schema)
    require(configs[0]['project'] != configs[1]['project'] and configs[0]['validators'] != configs[1]['validators'], 'Examples do not distinguish projects/validators')
    check_records(root,engine)
    check_links(root)
    ledger = read(root/'migration/source-deltas.json')
    require(ledger['baseline'] == SOURCE and ledger['finalCheckpointOwner'] == 'MIG-008', 'Delta ownership')
    require(len({e['id'] for e in ledger['entries']}) == len(ledger['entries']), 'Duplicate delta')
    for e in ledger['entries']:
        if e['disposition'] == 'imported':
            require(e['sourceCommit'] and e['destinationCommit'] and e['sourcePaths'] and e['destinationPaths'] and e['evidence'], 'Unsupported imported delta')
    # The pinned native registry/DAG parses the staged task without invoking start.
    subprocess.run(['node', str(root/'scripts/check_registry.mjs'), str(root), str(engine)], check=True)
    print(f'PASS: {len(source_blobs)} exact inventory paths; 24 modules; 12 CLI commands; 9 epic criteria; config examples; staged records; references')

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--engine', type=Path, required=True)
    args = parser.parse_args()
    check_all(ROOT, args.source.resolve(), args.engine.resolve())
