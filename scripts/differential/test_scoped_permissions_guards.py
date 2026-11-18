#!/usr/bin/env python3
"""Authored static/ownership/budget guards only; never execute original or Tau."""
import json
from pathlib import Path
import tempfile
import unittest
import io
import os
from contextlib import redirect_stderr
from unittest.mock import patch

import prepare_scoped_permissions as fixture
import run_scoped_permissions as runner


class ScopedGuards(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='tau-scoped-guards-', dir='/private/tmp')
        self.root = Path(self.temp.name).resolve()
        (self.root/'work').mkdir()
        (self.root/'config').mkdir()

    def tearDown(self):
        self.temp.cleanup()

    def test_exact_case_and_file_rule_scope(self):
        with self.assertRaises(ValueError):
            fixture.recipe(self.root, 'unknown')
        plan = fixture.recipe(self.root, 'files')
        self.assertEqual(plan['settings']['permissions']['allow'], ['Edit(./selected.md)', 'Write(./ignored.md)'])
        self.assertEqual(plan['arguments'][-2:], ['--allowedTools', 'Edit'])
        self.assertNotIn('Write', plan['arguments'][-1:])
        self.assertEqual(plan['hooks'], plan['peers'], 0)

    def test_strong_leaf_rejects_symlink(self):
        path = self.root/'work/selected.md'
        target = self.root/'work/other.md'
        target.write_text('OWNED')
        path.symlink_to(target)
        self.assertIn('guard_error', fixture.file_state(self.root, path))

    def test_strong_leaf_rejects_hardlink(self):
        path = self.root/'work/selected.md'
        other = self.root/'work/other.md'
        other.write_text('OWNED')
        path.hardlink_to(other)
        self.assertIn('guard_error', fixture.file_state(self.root, path))

    def test_strong_leaf_rejects_oversize(self):
        path = self.root/'work/selected.md'
        with path.open('wb') as stream:
            stream.truncate(1048577)
        self.assertIn('guard_error', fixture.file_state(self.root, path))

    def test_shell_actions_exact_fixed_literals(self):
        commands = [fixture.action(self.root, 'bash', index)[1]['command'] for index in range(1, 5)]
        self.assertEqual(commands, ['printf OWNED_SCOPED_OK', 'printf OWNED_SCOPED_DENY suffix',
                                    'printf OWNED_SCOPED_ASK suffix', 'printf OWNED_SCOPED_DENYPLUS'])
        self.assertEqual(fixture.recipe(self.root, 'bash')['allowed_shell_calls'], 2)
        self.assertIsNone(fixture.action(self.root, 'bash', 5))

    def test_prior_failed_oracle_stops_next_case(self):
        (self.root/'original-files.json').write_text(json.dumps({'checks': {'failed': False}, 'requests': []}))
        with self.assertRaisesRegex(RuntimeError, 'oracle failed'):
            with runner.phase_guard(self.root, 'original', 'bash'):
                pass
        self.assertFalse((self.root/'.original-phase.lock').exists())

    def test_prior_failure_receipt_stops_next_case(self):
        (self.root/'tau-files.failure.json').write_text('{}')
        with self.assertRaisesRegex(RuntimeError, 'failure requires review'):
            with runner.phase_guard(self.root, 'tau', 'bash'):
                pass

    def test_no_overwrite_before_source_or_execution(self):
        (self.root/'original-files.stdout.txt').write_text('OWNED_KEEP')
        with patch('sys.argv', ['run_scoped_permissions.py', 'original', 'files', '--execute-reviewed-cli', '--artifacts', str(self.root)]):
            with patch.object(runner, 'verify_source', side_effect=AssertionError('Should not read source')):
                with self.assertRaisesRegex(RuntimeError, 'overwrite or rerun'):
                    runner.main()
        self.assertEqual((self.root/'original-files.stdout.txt').read_text(), 'OWNED_KEEP')

    def test_app_modes_require_explicit_review_flag_before_source(self):
        for mode in ['original', 'tau']:
            with patch('sys.argv', ['run_scoped_permissions.py', mode, 'files']), redirect_stderr(io.StringIO()):
                with patch.object(runner, 'verify_source', side_effect=AssertionError('Must not read source')):
                    with self.assertRaises(SystemExit) as error:
                        runner.main()
                    self.assertEqual(error.exception.code, 2)

    def test_selected_read_bytes_are_not_marker_substrings(self):
        value = fixture.SELECTED
        self.assertEqual(fixture.selected_read_payload({'content': '1\t'+value+'\n\n<system-reminder>owned</system-reminder>'}), value)
        self.assertNotEqual(fixture.selected_read_payload({'content': '1\tprefix '+value}), value)
        self.assertIsNone(fixture.selected_read_payload({'content': '1\t'+value+'\n2\textra'}))
        self.assertIsNone(fixture.selected_read_payload({'content': value}))
        self.assertEqual(fixture.selected_read_payload({'content': value}, readiness=True), value)

    def test_mock_rejects_private_bytes_in_any_model_input_before_tool_action(self):
        (self.root/'config/settings.json').write_text('{}')
        (self.root/'work/blocked.md').write_text(fixture.BLOCKED)
        state = fixture.ScopedPermissionMock('files')
        state.root = self.root
        state.requests = [{'path': '/v1/messages', 'body': {'model': fixture.MODEL,
            'tools': [{'name': name} for name in fixture.recipe(self.root, 'files')['tool_names']],
            'messages': [{'role': 'user', 'content': fixture.BLOCKED}]}}]
        halted = []
        state.on_halt = lambda: halted.append(True)
        content, stop = state.response('parent', 1)
        self.assertFalse(state.requests[0]['observation']['checks']['blocked_seed_not_in_model_input'])
        self.assertEqual(halted, [True])
        self.assertEqual(stop, 'end_turn')
        self.assertTrue(all(block['type'] == 'text' for block in content))

    def test_metadata_audit_never_follows_foreign_directory_symlink(self):
        for name in ['home', 'tmp', 'cache', 'data', 'xdg-config', 'tau-state']:
            (self.root/name).mkdir()
        with tempfile.TemporaryDirectory(prefix='tau-scoped-authored-foreign-', dir='/private/tmp') as temp:
            foreign = Path(temp).resolve()
            (foreign/'FOREIGN_METADATA_MUST_NOT_APPEAR').write_text('OWNED_AUTHORED_FOREIGN')
            (self.root/'work'/'escape').symlink_to(foreign, target_is_directory=True)
            value = runner.state_audit(self.root)
            self.assertTrue(value['guards'])
            self.assertFalse(value['content_read'])
            self.assertFalse(any('FOREIGN_METADATA_MUST_NOT_APPEAR' in row['path'] for row in value['entries']))

    def test_metadata_audit_rejects_directory_replacement_before_open(self):
        for name in ['home', 'tmp', 'cache', 'data', 'xdg-config', 'tau-state']:
            (self.root/name).mkdir()
        original = os.open
        replaced = []
        with tempfile.TemporaryDirectory(prefix='tau-scoped-authored-foreign-', dir='/private/tmp') as temp:
            foreign = Path(temp).resolve()
            (foreign/'FOREIGN_RACE_NAME').write_text('OWNED_AUTHORED_FOREIGN')
            def raced(name, flags, *args, **kwargs):
                if name == 'work' and kwargs.get('dir_fd') is not None and not replaced:
                    (self.root/'work').rename(self.root/'old-work')
                    (self.root/'work').symlink_to(foreign, target_is_directory=True)
                    replaced.append(True)
                return original(name, flags, *args, **kwargs)
            with patch.object(runner.os, 'open', side_effect=raced):
                value = runner.state_audit(self.root)
            self.assertEqual(replaced, [True])
            self.assertTrue(value['guards'])
            self.assertFalse(any('FOREIGN_RACE_NAME' in row['path'] for row in value['entries']))

    def test_phase_two_cli_hard_cap(self):
        for case, count in [('files', 6), ('bash', 5)]:
            (self.root/('original-'+case+'.json')).write_text(json.dumps({
                'checks': {'pass': True}, 'requests': [{'path': '/v1/messages'}]*count}))
        with self.assertRaisesRegex(RuntimeError, 'cap exhausted'):
            with runner.phase_guard(self.root, 'original', 'files'):
                pass


if __name__ == '__main__':
    unittest.main()
