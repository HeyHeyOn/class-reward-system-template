"""Pure runner guards only. These tests never start PG/Docker or claim recovery."""
import copy
import importlib.util
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('crs_recovery_pg', Path(__file__).resolve().parents[2] / 'scripts/crs-recovery-pg.py')
if SPEC is None or SPEC.loader is None:
    raise RuntimeError('runner module missing')
module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(module)


def synthetic_observation():
    # Pure comparator test vectors, deliberately NOT DB observations.
    return {'rows': {t: {'count': 1, 'sha256': 'unit-vector'} for tables in module.CATEGORIES.values() for t in tables},
            'schemaSha256': 'unit-schema', 'sequences': {'s': '1|t'}, 'catalog': {'acl': None},
            'probes': {'t': 'DENIED_NO_GRANTS'}, 'invariants': [True] * 5,
            'binding': {'matched': True, 'tenantCount': 1}}


class RunnerGuards(unittest.TestCase):
    def test_inert_cli(self):
        result = subprocess.run([sys.executable, '-B', str(module.__file__)], capture_output=True)
        self.assertEqual(result.returncode, 1)
        self.assertIn(b'NOT_RUN-explicit-Sol-runner-ownership-required', result.stderr)

    def test_strict_binding(self):
        base = {'tenantId': '11111111-1111-4111-8111-111111111111',
                'jobId': '22222222-2222-4222-8222-222222222222', 'generation': 1,
                'exportId': '33333333-3333-4333-8333-333333333333'}
        module.validate_binding(base)
        for field, value in [('tenantId', base['tenantId'] + '\n'), ('jobId', 'job'),
                             ('generation', True), ('generation', 0), ('generation', 9007199254740992)]:
            with self.subTest(field=field, value=value), self.assertRaises(module.Refused):
                module.validate_binding({**base, field: value})

    def test_every_observation_dimension_is_checked(self):
        source = synthetic_observation()
        for dimension in source:
            restored = copy.deepcopy(source)
            restored[dimension] = {} if isinstance(restored[dimension], dict) else 'changed'
            with self.subTest(dimension=dimension), self.assertRaises(module.Refused):
                module.compare(source, restored)

    def test_full_row_mutation_detected_even_when_count_matches(self):
        source, changed = synthetic_observation(), synthetic_observation()
        changed['rows']['accounts']['sha256'] = 'different'
        with self.assertRaisesRegex(module.Refused, 'full-row-mismatch'):
            module.compare(source, changed)

    def test_two_empty_observations_do_not_pass_as_coverage(self):
        source = synthetic_observation()
        source['rows']['padlet_claim_digest_registry']['count'] = 0
        with self.assertRaisesRegex(module.Refused, 'empty-required-category'):
            module.compare(source, copy.deepcopy(source))

    def test_missing_table_detected(self):
        source, changed = synthetic_observation(), synthetic_observation()
        del changed['rows']['task_completions']
        with self.assertRaisesRegex(module.Refused, 'full-row-mismatch'):
            module.compare(source, changed)

    def test_environment_does_not_forward_host_credentials(self):
        with patch.dict(module.os.environ, {'DATABASE_URL': 'do-not-forward', 'PGPASSWORD': 'do-not-forward',
                                           'DOCKER_HOST': 'tcp://forbidden', 'NODE_OPTIONS': '--inspect'}):
            env = module.clean_environment('/private/synthetic-home')
        self.assertNotIn('DATABASE_URL', env)
        self.assertNotIn('PGPASSWORD', env)
        self.assertNotIn('DOCKER_HOST', env)
        self.assertNotIn('NODE_OPTIONS', env)

    def test_image_pin_required_before_any_docker_invocation(self):
        with self.assertRaisesRegex(module.Refused, 'image-id-required'):
            module.OwnedPg('postgres:latest', {})


if __name__ == '__main__':
    unittest.main(verbosity=2)
