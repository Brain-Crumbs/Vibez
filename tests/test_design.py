"""Negative specification checks; not installed-runtime acceptance evidence."""
import copy
import importlib.util
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('design',ROOT/'scripts/check_design.py')
design = importlib.util.module_from_spec(spec)
spec.loader.exec_module(design)

class DesignTests(unittest.TestCase):
    def setUp(self):
        self.schema = design.read(ROOT/'docs/specs/project-config.schema.json')
        self.config = design.read(ROOT/'examples/alpha/vibez.config.json')

    def test_examples(self):
        for name in ('alpha','beta'):
            design.check_config(design.read(ROOT/f'examples/{name}/vibez.config.json'),self.schema)

    def test_invalid_config_shapes(self):
        from jsonschema import ValidationError
        edits = [
            lambda c: c.update(schemaVersion='2.0.0'),
            lambda c: c.update(token='secret'),
            lambda c: c['providers'].update(token='secret'),
            lambda c: c['budgets'].update(maxAttempts=11),
            lambda c: c['budgets'].update(providerTimeoutMs=0),
            lambda c: c['validators'][0].update(command='arbitrary shell'),
            lambda c: c['policy'].update(merge='agent-approved'),
            lambda c: c['policy'].update(reviewRoles=['Developer']),
            lambda c: c['policy'].update(requiredChecks=[]),
        ]
        for edit in edits:
            config=copy.deepcopy(self.config); edit(config)
            with self.subTest(config=config), self.assertRaises(ValidationError):
                design.check_config(config,self.schema)

    def test_unsafe_design_paths(self):
        from jsonschema import ValidationError
        for path in ('../beta','/tmp/state','C:/state','C:\\state','//host/share','a/../beta','.', './state', 'x:y'):
            config=copy.deepcopy(self.config); config['paths']['state']=path
            with self.subTest(path=path), self.assertRaises((ValueError,ValidationError)):
                design.check_config(config,self.schema)

    def test_aliasing_and_nested_paths(self):
        for path in ('.vibez/evidence','.VIBEZ/EVIDENCE','.vibez/evidence/child','.vibez'):
            config=copy.deepcopy(self.config); config['paths']['state']=path
            with self.subTest(path=path), self.assertRaisesRegex(ValueError,'Overlapping'):
                design.check_config(config,self.schema)

    def test_duplicate_validator(self):
        self.config['validators'][1]['id']=self.config['validators'][0]['id']
        with self.assertRaisesRegex(ValueError,'Duplicate validator'):
            design.check_config(self.config,self.schema)

    def test_inventory_rejects_missing_duplicate_tamper_and_destination_escape(self):
        data=b'example\n'; blobs={'src/example.ts':('blob-id',data)}
        item=dict(source='src/example.ts',sourceBlob='blob-id',sha256=design.digest(data),category='vibez',action='copy',destination='src/example.ts',owner='MIG-003',testOwner='MIG-008')
        inv=dict(revision=design.SOURCE,entries=[item])
        design.check_inventory(inv,blobs)
        variants=[dict(revision=design.SOURCE,entries=[]),dict(revision=design.SOURCE,entries=[item,item])]
        for key,value in [('sha256','bad'),('sourceBlob','bad'),('category','unknown'),('destination','../escape'),('owner','')]:
            changed=copy.deepcopy(inv); changed['entries'][0][key]=value; variants.append(changed)
        for changed in variants:
            with self.subTest(changed=changed),self.assertRaises(ValueError):
                design.check_inventory(changed,blobs)

if __name__ == '__main__':
    unittest.main()
