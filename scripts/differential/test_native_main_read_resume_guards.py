#!/usr/bin/env python3
"""Authored capture/ownership/oracle tests only; no listener, native CLI or Tau execution."""
import base64
import copy
from contextlib import redirect_stderr, ExitStack
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import prepare_native_main_read_resume as prepare
import run_native_main_read_resume as runner


class ReadResumeGuards(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        raw, cls.facts, cls.receipts, cls.tau = prepare.load_inputs()
        cls.rows = [json.loads(line) for line in raw.splitlines() if line.strip()]
        captured, _ = prepare.read_fixed(prepare.CAPTURE, prepare.CAPTURE_SHA)
        cls.capture = json.loads(captured)

    def rejected_rows(self, mutate):
        rows = copy.deepcopy(self.rows)
        mutate(rows)
        with self.assertRaises(RuntimeError):
            prepare.validate_rows(rows, self.capture)

    def test_actual_main_read_capture_and_versioned_tau_are_admitted(self):
        self.assertTrue(all(self.facts['restore_guards'].values()))
        self.assertEqual(self.receipts['raw']['bytes'], 104246)
        self.assertEqual(self.facts['checkpoint'], prepare.LEAF)
        self.assertEqual(len(self.tau['runtime']['source_files']), 108)
        body = next(row['body'] for row in self.tau['requests'] if row['path'].split('?')[0] == '/v1/messages')
        self.assertTrue(all(prepare.observe(body, self.facts)['checks'].values()))

    def test_slug_restore_is_not_admitted(self):
        self.rejected_rows(lambda rows: rows[2].update(slug='owned-new-plan'))

    def test_file_history_restore_is_not_admitted(self):
        self.rejected_rows(lambda rows: rows.append({'type': 'file-history-snapshot', 'sessionId': prepare.SESSION_ID}))

    def test_foreign_owner_is_not_admitted(self):
        self.rejected_rows(lambda rows: rows[2].update(sessionId='11111111-1111-1111-1111-111111111111'))

    def test_sidechain_is_not_admitted(self):
        self.rejected_rows(lambda rows: rows[2].update(isSidechain=True))

    def test_fork_agent_worktree_relocation_restore_is_not_admitted(self):
        for key in ['forkedFromSessionId', 'agentId', 'worktreeSession', 'relocatedCwd', 'sessionOwner']:
            with self.subTest(key=key):
                self.rejected_rows(lambda rows: rows[2].update({key: 'OWNED_NOT_ADMITTED'}))

    def test_goal_skill_hook_and_queued_attachment_restore_is_not_admitted(self):
        for kind in ['goal_status', 'invoked_skills', 'hook_additional_context', 'queued_command']:
            with self.subTest(kind=kind):
                self.rejected_rows(lambda rows: rows[3]['attachment'].update(type=kind))

    def test_final_assistant_checkpoint_cannot_be_replaced_with_passive_tail(self):
        def mutate(rows):
            tail = copy.deepcopy(rows[17])
            tail['uuid'] = '11111111-1111-1111-1111-111111111111'
            tail['parentUuid'] = prepare.LEAF
            rows.append(tail)
        self.rejected_rows(mutate)

    def test_wrong_checkpoint_leaf_is_not_admitted(self):
        self.rejected_rows(lambda rows: rows[22].update(leafUuid=rows[17]['uuid']))

    def test_unresolved_read_result_is_not_admitted(self):
        self.rejected_rows(lambda rows: rows[16]['message']['content'][0].update(tool_use_id='owned-other'))

    def test_incomplete_final_assistant_is_not_admitted(self):
        self.rejected_rows(lambda rows: rows[21]['message'].update(stop_reason='tool_use'))

    def test_positive_echo_wire_profile_is_not_admitted(self):
        self.rejected_rows(lambda rows: rows[17]['attachment'].update(echoWireToolInputs=True))

    def test_nonempty_context_or_atis_is_not_admitted(self):
        self.rejected_rows(lambda rows: rows[7]['attachment'].update(context={'unsafe': 'OWNED'}))
        self.rejected_rows(lambda rows: rows[6].update(atis='OWNED_NONEMPTY'))

    def test_history_oracle_rejects_context_and_fragment_mutations(self):
        body = {'model': prepare.MODEL, 'tools': [], 'messages': copy.deepcopy(self.facts['baseline'])}
        self.assertTrue(all(prepare.observe(body, self.facts)['checks'].values()))
        body['messages'][2]['content'][0]['content'] = 'OWNED_ALTERED_CONTEXT'
        failed = prepare.observe(body, self.facts)['checks']
        self.assertFalse(failed['exact_result_context'])
        self.assertFalse(failed['imported_prefix_exact_without_cache'])

    def test_cache_metadata_only_is_excluded_from_prefix_hash(self):
        body = {'model': prepare.MODEL, 'tools': [], 'messages': copy.deepcopy(self.facts['baseline'])}
        body['messages'][0]['content'][0]['cache_control'] = {'type': 'ephemeral'}
        self.assertTrue(all(prepare.observe(body, self.facts)['checks'].values()))
        body['messages'][0]['content'][0]['text'] += 'OWNED_CHANGED'
        self.assertFalse(prepare.observe(body, self.facts)['checks']['imported_prefix_exact_without_cache'])

    def test_halt_callback_fires_once(self):
        state = runner.ResumeMock(self.facts)
        events = []
        state.on_halt = lambda: events.append(True)
        state.fail('OWNED_FIRST')
        state.fail('OWNED_SECOND')
        self.assertEqual(events, [True])
        self.assertEqual(state.halt, 'OWNED_FIRST')

    def test_original_review_gate_precedes_source_and_isolation(self):
        with patch('sys.argv', ['run_native_main_read_resume.py', 'original']), redirect_stderr(io.StringIO()):
            with patch.object(runner, 'verify_source', side_effect=AssertionError('Must not read source')):
                with self.assertRaises(SystemExit) as error:
                    runner.main()
                self.assertEqual(error.exception.code, 2)

    def test_existing_capture_refuses_overwrite_before_source(self):
        with tempfile.TemporaryDirectory(prefix='tau-read-resume-guard-', dir='/private/tmp') as temporary:
            directory = Path(temporary).resolve()
            (directory/'original-main-read-resume.failure.json').write_text('OWNED_KEEP')
            argv = ['run_native_main_read_resume.py', 'original', '--execute-reviewed-cli', '--artifacts', str(directory)]
            with patch('sys.argv', argv), patch.object(runner, 'verify_source', side_effect=AssertionError('Must not read source')):
                with self.assertRaisesRegex(RuntimeError, 'overwrite or rerun'):
                    runner.main()
            self.assertEqual((directory/'original-main-read-resume.failure.json').read_text(), 'OWNED_KEEP')


class WriterGuards(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='tau-read-writer-guard-', dir='/private/tmp')
        self.base = Path(self.temporary.name).resolve()
        self.root = self.base/'owned'; self.root.mkdir()
        self.directory = self.root/'imported'; self.directory.mkdir()
        self.input = self.directory/'native-main-read.jsonl'
        self.input.write_bytes(b'OWNED_READONLY_INPUT\n'); self.input.chmod(0o400)

    def tearDown(self):
        self.temporary.cleanup()

    def test_regular_readonly_snapshot_and_exact_capture(self):
        before = runner.writer_snapshot(self.root, self.directory)
        files = runner.writer_files(self.root, self.directory)
        self.assertEqual(base64.b64decode(files['files'][self.input.name]['raw_base64']), b'OWNED_READONLY_INPUT\n')
        self.assertEqual(before, runner.writer_snapshot(self.root, self.directory))

    def test_new_owned_sidecar_is_observed_and_its_bytes_preserved(self):
        before = runner.writer_snapshot(self.root, self.directory)
        sidecar = self.directory/'OWNED_UNEXPECTED.cache'; sidecar.write_bytes(b'\x00\xffOWNED_BINARY')
        after = runner.writer_snapshot(self.root, self.directory)
        self.assertNotEqual(before, after)
        self.assertEqual(base64.b64decode(runner.writer_files(self.root, self.directory)['files'][sidecar.name]['raw_base64']), b'\x00\xffOWNED_BINARY')

    def test_symlink_leaf_rejected_without_content_read(self):
        target = self.base/'foreign'; target.write_text('OWNED_FOREIGN')
        (self.directory/'sidecar').symlink_to(target)
        with patch.object(runner.os, 'read', side_effect=AssertionError('No content may be read')):
            with self.assertRaises(ValueError):
                runner.writer_snapshot(self.root, self.directory)
            with self.assertRaises(ValueError):
                runner.writer_files(self.root, self.directory)

    def test_hardlink_and_size_bounds(self):
        sidecar = self.directory/'sidecar'; sidecar.hardlink_to(self.input)
        with self.assertRaises(ValueError):
            runner.writer_snapshot(self.root, self.directory)
        sidecar.unlink()
        with sidecar.open('wb') as stream:
            stream.truncate(1048577)
        with self.assertRaises(ValueError):
            runner.writer_snapshot(self.root, self.directory)

    def test_writer_directory_symlink_rejected(self):
        alias = self.root/'alias'; alias.symlink_to(self.directory, target_is_directory=True)
        with self.assertRaises(ValueError):
            runner.writer_snapshot(self.root, alias)

    def test_writer_directory_preopen_replacement_rejected(self):
        foreign = self.base/'foreign'; foreign.mkdir(); (foreign/'FOREIGN_NAME_MUST_NOT_BE_LISTED').write_text('OWNED')
        original = os.open; changed = []
        def raced(name, flags, *args, **kwargs):
            if name == 'imported' and kwargs.get('dir_fd') is not None and not changed:
                self.directory.rename(self.root/'old-imported')
                self.directory.symlink_to(foreign, target_is_directory=True)
                changed.append(True)
            return original(name, flags, *args, **kwargs)
        with patch.object(runner.os, 'open', side_effect=raced):
            with self.assertRaises(OSError):
                runner.writer_snapshot(self.root, self.directory)
        self.assertEqual(changed, [True])


class ProcessFailureCaptureGuards(unittest.TestCase):
    """Exercise real runner failure control flow with no process/listener/runtime execution."""
    @classmethod
    def setUpClass(cls):
        cls.inputs = prepare.load_inputs()

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='tau-read-failure-guard-', dir='/private/tmp')
        self.base = Path(self.temporary.name).resolve()
        self.root = self.base/'owned'; self.root.mkdir()
        self.output = self.base/'artifacts'; self.output.mkdir()
        for name in ['work', 'home', 'tmp', 'config', 'cache', 'data', 'xdg-config', 'bin', 'tau-state']:
            (self.root/name).mkdir()
        owner = self
        class FakeIsolation:
            def __init__(self):
                self.root = owner.root; self.env = {}; self.tag = 'AUTHORED_FAILURE_FIXTURE_ONLY'
                self.report = {'root': str(self.root), 'authored_guard_fixture_only': True}
                self.closed = False
            def verify(self):
                self.report['fixture_verify_called'] = True
            def sandbox(self, _command):
                return {'exit_code': 0, 'stdout': json.dumps({'marker': 'owned-read-resume-runtime-ready', 'cwd': str(self.root/'work')}),
                    'stderr': '', 'timed_out': False, 'output_limited': False, 'remaining_process_group_killed': False}
            def copy_target(self, _target):
                # A path-only stub: no installed binary is opened, copied or executed.
                return self.root/'bin/AUTHORED_NEVER_EXECUTED_TARGET'
            def close(self):
                self.closed = True
        self.fake = FakeIsolation()
        self.cleanup = {'process_group': None, 'remaining_members': [], 'wrapper': 'AUTHORED_NO_PROCESS_STARTED'}
        self.outcome = {'exit_code': 1, 'stdout': 'OWNED_NON_JSON_STDOUT\n', 'stderr': 'OWNED_BOUNDED_FATAL_STDERR\n',
            'timed_out': False, 'output_limited': False, 'remaining_process_group_killed': False}

    def tearDown(self):
        self.temporary.cleanup()

    def invoke_failure(self, *, post_source_error=False, sidecar=False, after_retention=False, prelaunch=False):
        def stage(_isolation, _command, _arguments):
            if sidecar:
                foreign = self.base/'AUTHORED_FOREIGN'; foreign.write_text('OWNED_MUST_NOT_READ')
                (self.root/'imported/unsafe-sidecar').symlink_to(foreign)
            return copy.deepcopy(self.outcome), copy.deepcopy(self.cleanup)
        source_inputs = [copy.deepcopy(self.inputs)]
        if post_source_error:
            source_inputs.append(ValueError('OWNED_POST_SOURCE_GUARD_FAILURE'))
        else:
            source_inputs.append(copy.deepcopy(self.inputs))
        original_retain = runner.retain_process_outcome
        def retain_then_fail(*args):
            original_retain(*args)
            raise ValueError('OWNED_FAILURE_BEFORE_PARTIAL_RECORD')
        argv = ['run_native_main_read_resume.py', 'original', '--execute-reviewed-cli', '--artifacts', str(self.output)]
        with ExitStack() as stack:
            stack.enter_context(patch('sys.argv', argv))
            stack.enter_context(patch.object(runner, 'verify_source', side_effect=ValueError('OWNED_PRELAUNCH_FAILURE')) if prelaunch else
                                patch.object(runner, 'verify_source', return_value={'all_equal': True, 'authored_guard_fixture_only': True}))
            stack.enter_context(patch.object(runner, 'load_inputs', side_effect=source_inputs))
            stack.enter_context(patch.object(runner, 'Isolation', return_value=self.fake))
            stack.enter_context(patch.object(runner, 'copy_node_fixture_runtime', return_value=(self.root/'bin/AUTHORED_NODE_NOT_EXECUTED', {'authored_fixture_only': True})))
            stack.enter_context(patch.object(runner, 'clone_file', side_effect=lambda _source, destination: destination.write_bytes(self.inputs[0])))
            supervised = stack.enter_context(patch.object(runner, 'run_stage', side_effect=stage))
            stack.enter_context(patch.object(runner.subprocess, 'run', side_effect=AssertionError('Authored failure tests must start no subprocess')))
            if after_retention:
                stack.enter_context(patch.object(runner, 'retain_process_outcome', side_effect=retain_then_fail))
            with self.assertRaises(ValueError):
                runner.main()
            self.assertEqual(supervised.call_count, 0 if prelaunch else 1)
        failure = json.loads((self.output/'original-main-read-resume.failure.json').read_text())
        return failure

    def require_process_saved(self, failure):
        self.assertEqual(failure['result'], self.outcome)
        self.assertEqual(failure['cleanup'], self.cleanup)
        standalone = json.loads((self.output/'original-main-read-resume.process-outcome.json').read_text())
        self.assertEqual(standalone, {'result': self.outcome, 'cleanup': self.cleanup})
        for name in ['stdout', 'stderr']:
            self.assertEqual((self.output/('original-main-read-resume.'+name+'.txt')).read_text(), self.outcome[name])
            self.assertIn(name, failure['process_outcome_artifacts'])
        self.assertTrue(self.fake.closed)

    def test_non_json_original_output_preserves_bounded_streams_and_cleanup(self):
        failure = self.invoke_failure()
        self.require_process_saved(failure)
        self.assertEqual(failure['failure_stage'], 'parse_original_output')
        self.assertEqual(failure['output_parse_error']['type'], 'JSONDecodeError')
        self.assertIsNotNone(failure['partial_record'])

    def test_post_source_guard_failure_preserves_process_outcome(self):
        self.outcome.update(exit_code=0, stdout=json.dumps({'result': prepare.FINAL, 'session_id': prepare.SESSION_ID}))
        failure = self.invoke_failure(post_source_error=True)
        self.require_process_saved(failure)
        self.assertEqual(failure['failure_stage'], 'post_source_recheck')
        self.assertIsNone(failure['output_parse_error'])
        self.assertEqual(failure['partial_record']['output']['session_id'], prepare.SESSION_ID)

    def test_bad_sidecar_keeps_metadata_and_never_consumes_its_contents(self):
        self.outcome.update(exit_code=0, stdout=json.dumps({'result': prepare.FINAL, 'session_id': prepare.SESSION_ID}))
        original = runner.bounded_owned_file
        read_paths = []
        def guarded(root, path, *args, **kwargs):
            read_paths.append(path)
            self.assertNotEqual(path.name, 'unsafe-sidecar')
            return original(root, path, *args, **kwargs)
        with patch.object(runner, 'bounded_owned_file', side_effect=guarded):
            failure = self.invoke_failure(sidecar=True)
        self.require_process_saved(failure)
        self.assertEqual(failure['failure_stage'], 'post_writer_snapshot')
        self.assertEqual(failure['guard_observation']['leaf'], 'unsafe-sidecar')
        self.assertFalse(failure['guard_observation']['content_read'])
        self.assertTrue(read_paths)

    def test_outcome_survives_even_before_partial_record_exists(self):
        failure = self.invoke_failure(after_retention=True)
        self.require_process_saved(failure)
        self.assertIsNone(failure['partial_record'])
        self.assertEqual(failure['failure_stage'], 'retain_process_outcome')

    def test_prelaunch_failure_explicitly_has_no_process_outcome(self):
        failure = self.invoke_failure(prelaunch=True)
        self.assertIsNone(failure['result'])
        self.assertIsNone(failure['cleanup'])
        self.assertIsNone(failure['partial_record'])
        self.assertFalse(failure['application_launch_attempted'])
        self.assertEqual(failure['process_outcome_artifacts'], {})

    def test_exclusive_stream_failure_keeps_standalone_outcome_without_overwrite(self):
        path = self.output/'owned.stdout.txt'; path.write_text('OWNED_KEEP')
        artifacts = {}
        with self.assertRaises(FileExistsError):
            runner.retain_process_outcome(self.output, 'owned', self.outcome, self.cleanup, artifacts)
        self.assertEqual(path.read_text(), 'OWNED_KEEP')
        self.assertEqual(json.loads((self.output/'owned.process-outcome.json').read_text()),
                         {'result': self.outcome, 'cleanup': self.cleanup})


if __name__ == '__main__':
    unittest.main()
