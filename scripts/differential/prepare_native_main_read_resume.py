#!/usr/bin/env python3
"""Strict source/capture audit for a NEW original MAIN Read resume; no app execution."""
import argparse
import hashlib
import json
from pathlib import Path
import re

from isolation import REPO, TARGET_SHA256
from prepare_plugins import PINNED_TARGET
from run_agent_definition_hooks import bounded_owned_file

MODEL = 'claude-sonnet-4-6'
PROMPT = 'OWNED_NATIVE_MAIN_READ_RESUME_PROMPT'
FINAL = 'OWNED_NATIVE_MAIN_READ_RESUME_FINAL'
SESSION_ID = 'eb4a72c3-fb27-40a5-b34a-b5e7f2c03553'
LEAF = '540eb1db-3f63-48da-8685-137ad67bf523'
RAW_SHA = '550ff3c1207359e466f972dbef880f968f394eb495e5c0ad403d833fa213fa4e'
CAPTURE_SHA = '55da88bf93e85dc91cfaf65ee2000409c8a9740db5f3a474130bf664879838c3'
TAU_SHA = '4656b7fb68d167f2acda42154e4542f75427f8c902057147ae75c17e19b44927'
RESULT_SHA = '06ca4af4bbb7ad8bf0a26b9fa5b4638d4fb310525a0e77c77e0b918531811709'
PREFIX_SHA = '7bb239f6f5ae7636d72f3dc87ac2c48ab6b59e8f59681e5ce7654a57b10d1f05'
RAW = REPO/'artifacts/differential-pass/native-main-read/original-main-read.transcripts/config/projects/-private-tmp-tau-differential--ti0di9d-work/eb4a72c3-fb27-40a5-b34a-b5e7f2c03553.jsonl'
CAPTURE = REPO/'artifacts/differential-pass/native-main-read/original-main-read.json'
TAU_CAPTURE = REPO/'artifacts/differential-pass/native-main-read-import-tau/tau-main-read-import.json'
RESEARCH = REPO/'artifacts/native-main-read-resume-research'
SCRIPT_NAMES = ['prepare_native_main_read_resume.py', 'run_native_main_read_resume.py',
                'compare_native_main_read_resume.py', 'test_native_main_read_resume_guards.py',
                'isolation.py', 'run_agent_definition_hooks.py', 'run_scoped_permissions.py',
                'node_fixture_runtime.py', 'bun_runtime.py', 'run_skills.py']


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def file_sha(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def compact_sha(value):
    return sha(json.dumps(value, sort_keys=True, separators=(',', ':')).encode())


def without_cache(value):
    if isinstance(value, dict):
        return {key: without_cache(child) for key, child in value.items() if key != 'cache_control'}
    if isinstance(value, list):
        return [without_cache(child) for child in value]
    return value


def read_fixed(path, expected_sha):
    raw, receipt = bounded_owned_file(REPO, path)
    if receipt['sha256'] != expected_sha:
        raise RuntimeError('Immutable captured artifact changed: '+str(path.relative_to(REPO)))
    return raw, receipt


def validate_rows(rows, capture):
    allowed_types = {'queue-operation', 'user', 'attachment', 'atis-latch', 'api-request-shape',
                     'api-request-blob', 'api-request', 'tools-used', 'assistant', 'last-prompt', 'cost-state'}
    graph = [row for row in rows if row.get('type') in {'user', 'assistant', 'attachment', 'system', 'progress'}]
    forbidden = {'slug', 'fileHistorySnapshots', 'trackedFileBackups', 'forkedFromSessionId',
                 'worktreeSession', 'relocatedCwd', 'sessionOwner', 'agentId', 'agentSetting'}
    if any(row.get('type') not in allowed_types for row in rows):
        raise RuntimeError('Unknown/actionable native record needs its own restore adapter')
    if any(forbidden.intersection(row) for row in rows):
        raise RuntimeError('Slug/history/fork/agent/worktree restore is not admitted')
    if not graph or any(row.get('sessionId') != SESSION_ID for row in rows):
        raise RuntimeError('Native owner differs')
    if any(row.get('isSidechain') is not False for row in graph):
        raise RuntimeError('Only the exact main owner is admitted')
    source_cwd = graph[0].get('cwd')
    if (not isinstance(source_cwd, str) or
        not re.fullmatch(r'/private/tmp/tau-differential-[A-Za-z0-9_-]+/work', source_cwd) or
        source_cwd != str(Path(capture['isolation']['root'])/'work') or
        any(row.get('cwd') != source_cwd for row in graph)):
        raise RuntimeError('Captured cwd is not the exact retired owned main workspace')
    previous = None
    seen = set()
    for row in graph:
        if not isinstance(row.get('uuid'), str) or row['uuid'] in seen or row.get('parentUuid') != previous:
            raise RuntimeError('Expected one complete native chain with no fork/retraction')
        seen.add(row['uuid'])
        previous = row['uuid']
        if any(key in row for key in ['retractedMessageUuids', 'isApiErrorMessage', 'isCompactSummary', 'isMeta']):
            raise RuntimeError('Retraction/error/compaction/meta recovery is not admitted')
    attachments = [row for row in graph if row['type'] == 'attachment']
    allowed_attachments = {'environment', 'model', 'date', 'session_context', 'total_tokens_reminder', 'prompt_snapshot'}
    if any(row.get('attachment', {}).get('type') not in allowed_attachments for row in attachments):
        raise RuntimeError('Goal/skill/hook/queued/actionable attachment restore is not admitted')
    for row in attachments:
        attachment = row['attachment']
        if attachment['type'] == 'session_context' and attachment.get('context') != {}:
            raise RuntimeError('Only empty captured session context is admitted')
        if attachment['type'] == 'environment':
            snapshot = attachment.get('snapshot', {})
            if (snapshot.get('workingDirectory') != source_cwd or snapshot.get('isWorktree') is not False or
                snapshot.get('isGitRepo') is not False or snapshot.get('additionalWorkingDirectories') != []):
                raise RuntimeError('Captured worktree/additional-directory profile differs')
        if attachment['type'] == 'prompt_snapshot' and any([
            attachment.get('contextRendering') != 'announced', attachment.get('reminderFold') is not False,
            attachment.get('echoWireToolInputs') is not False,
        ]):
            raise RuntimeError('Unsupported captured prompt-snapshot projection profile')
    checkpoints = [row for row in rows if row['type'] == 'last-prompt']
    if (len(checkpoints) != 1 or checkpoints[0].get('leafUuid') != LEAF or
        graph[-1].get('uuid') != LEAF or graph[-1]['type'] != 'assistant'):
        raise RuntimeError('This capture must checkpoint its final assistant, not a passive snapshot tail')
    assistants = [row for row in graph if row['type'] == 'assistant']
    users = [row for row in graph if row['type'] == 'user']
    if len(assistants) != 3 or len(users) != 2 or users[0]['message']['content'] != 'OWNED_NATIVE_MAIN_READ_PROMPT':
        raise RuntimeError('Actual MAIN Read conversation shape differs')
    fragments = [block for row in assistants[:-1] for block in row['message']['content']]
    expected_fragments = [{'type': 'text', 'text': 'OWNED_NATIVE_MAIN_READ_PRELUDE'},
                          {'type': 'tool_use', 'id': 'owned_native_main_read_1', 'name': 'Read',
                           'input': {'file_path': 'owned-read.txt'}}]
    if fragments != expected_fragments or any(row['message'].get('id') != 'msg_owned_native_main_read_1' for row in assistants[:-1]):
        raise RuntimeError('Only the exact completed Read call is admitted')
    results = users[1]['message'].get('content')
    if (results != [{'tool_use_id': 'owned_native_main_read_1', 'type': 'tool_result',
                     'content': '1\tOWNED_NATIVE_MAIN_READ_BYTES\n2\t'}] or
        users[1].get('sourceToolAssistantUUID') != assistants[1]['uuid']):
        raise RuntimeError('Read result must resolve its exact assistant owner')
    if (assistants[-1]['message'].get('stop_reason') != 'end_turn' or
        assistants[-1]['message'].get('content') != [{'type': 'text', 'text': 'OWNED_NATIVE_MAIN_READ_FINAL'}]):
        raise RuntimeError('A complete final reply is required; no interrupted tool restoration')
    if any(row.get('atis') != '' for row in rows if row['type'] == 'atis-latch'):
        raise RuntimeError('Nonempty ATIS restore state is not admitted')
    queues = [row for row in rows if row['type'] == 'queue-operation']
    if [row.get('operation') for row in queues] != ['enqueue', 'dequeue']:
        raise RuntimeError('Only the completed original prompt queue is admitted')
    if [row.get('tools') for row in rows if row['type'] == 'tools-used'] != [['Read']]:
        raise RuntimeError('Only the recorded Read tool identity is admitted')
    rendered = [value['content'] for row in attachments if row['attachment']['type'] in ['environment', 'model', 'date']
                for value in row.get('rendered', []) if isinstance(value.get('content'), str)]
    if len(rendered) != 3:
        raise RuntimeError('Captured rendered environment/model/date context differs')
    return graph, fragments, rendered, source_cwd


def load_inputs():
    raw, raw_receipt = read_fixed(RAW, RAW_SHA)
    captured, capture_receipt = read_fixed(CAPTURE, CAPTURE_SHA)
    tau_raw, tau_receipt = read_fixed(TAU_CAPTURE, TAU_SHA)
    capture = json.loads(captured)
    tau = json.loads(tau_raw)
    if (not capture['original_executed'] or capture['port_executed'] or
        not all(capture['checks'].values()) or len(capture['checks']) != 18):
        raise RuntimeError('Original capture provenance is not the actual completed main Read run')
    rows = [json.loads(line) for line in raw.splitlines() if line.strip()]
    if len(raw) != 104246 or len(rows) != 25:
        raise RuntimeError('Exact actual MAIN Read capture size/row count differs')
    graph, fragments, rendered, source_cwd = validate_rows(rows, capture)
    original_requests = [row['body'] for row in capture['requests'] if row['path'].split('?')[0] == '/v1/messages']
    if len(original_requests) != 2:
        raise RuntimeError('Original Read capture must have two actual model requests')
    expected_prefix = [*original_requests[1]['messages'], {'role': 'assistant', 'content': graph[-1]['message']['content']}]
    if compact_sha(without_cache(expected_prefix)) != PREFIX_SHA:
        raise RuntimeError('Known imported Read prefix changed')
    projected_results = [block for message in expected_prefix for block in message.get('content', [])
                         if isinstance(block, dict) and block.get('type') == 'tool_result']
    if len(projected_results) != 1 or sha(projected_results[0]['content'].encode()) != RESULT_SHA:
        raise RuntimeError('Known120-byte result/context content differs')
    tau_requests = [row for row in tau['requests'] if row['path'].split('?')[0] == '/v1/messages']
    if (tau['original_executed'] or not tau['port_entrypoint_executed'] or len(tau_requests) != 1 or
        len(tau['checks']) != 16 or not all(tau['checks'].values()) or
        not all(tau_requests[0]['observation']['checks'].values()) or len(tau_requests[0]['observation']['checks']) != 7 or
        tau['source_before']['sha256'] != RAW_SHA or tau['checkpoint'] != LEAF or
        tau['source_session_id'] != SESSION_ID):
        raise RuntimeError('Prior copied-Bun Read import provenance differs')
    if compact_sha(without_cache(tau_requests[0]['body']['messages'][:4])) != PREFIX_SHA:
        raise RuntimeError('Prior Tau outbound prefix is not the exact selected native Read history')
    runtime = tau['runtime']
    consistency = runtime['snapshot_consistency']
    if (len(runtime['source_files']) != 108 or
        sha(json.dumps(runtime['source_files'], sort_keys=True).encode()) != 'ff23d1990637e26b71336f290a083fc14ea6fbef7963371560408142cb680583' or
        runtime['manifest_sha256'] != 'fbe41b391b9ea80e9364a046bf807d041eaefe3ed0d222051b10f736bcbad8c9' or
        not consistency['source_before'] == consistency['source_after'] == consistency['source_copied'] == runtime['source_files']):
        raise RuntimeError('Prior Tau source closure is not the recorded versioned import')
    facts = {'session_id': SESSION_ID, 'source_cwd': source_cwd, 'checkpoint': LEAF,
             'rendered': rendered, 'fragments': fragments, 'result': projected_results[0]['content'],
             'expected_prefix': expected_prefix,
             'baseline': [*without_cache(expected_prefix), {'role': 'user', 'content': [{'type': 'text', 'text': PROMPT}]}],
             'restore_guards': {'actual_104246_byte_25_row_main': True, 'same_owner': True,
                 'no_slug': True, 'no_file_history': True, 'no_agent_fork_worktree_relocation': True,
                 'no_goal_skill_hook_queued_restore': True, 'completed_read_resolved': True,
                 'checkpoint_is_final_assistant': True, 'announced_nonfolded_context': True,
                 'empty_session_context_atis': True, 'versioned_tau_counterpart_verified': True}}
    receipts = {'raw': raw_receipt, 'capture': capture_receipt, 'tau': tau_receipt}
    return raw, facts, receipts, tau


def observe(body, facts):
    messages = body.get('messages', [])
    blocks = [block for message in messages if isinstance(message.get('content'), list)
              for block in message['content'] if isinstance(block, dict)]
    results = [block for block in blocks if block.get('type') == 'tool_result' and block.get('tool_use_id') == 'owned_native_main_read_1']
    assistants = [message for message in messages if message.get('role') == 'assistant']
    texts = [block['text'] for block in blocks if block.get('type') == 'text' and isinstance(block.get('text'), str)]
    joined = '\n'.join(texts)
    markers = ['OWNED_NATIVE_MAIN_READ_PROMPT', 'OWNED_NATIVE_MAIN_READ_PRELUDE', 'OWNED_NATIVE_MAIN_READ_FINAL', PROMPT]
    positions = [joined.find(marker) for marker in markers]
    checks = {'known_model': body.get('model') == MODEL, 'empty_tools': body.get('tools', []) == [],
        'exact_result_context': len(results) == 1 and results[0].get('content') == facts['result'],
        'assistant_fragment_blocks_exact': bool(assistants) and assistants[0].get('content') == facts['fragments'],
        'recorded_rendered_context': all(value in joined for value in facts['rendered']),
        'marker_order': all(position >= 0 for position in positions) and positions == sorted(positions),
        'native_final_before_new_prompt': len(assistants) >= 2 and assistants[-1].get('content') == [{'type': 'text', 'text': 'OWNED_NATIVE_MAIN_READ_FINAL'}],
        'imported_prefix_exact_without_cache': len(messages) >= 5 and compact_sha(without_cache(messages[:4])) == PREFIX_SHA}
    return {'checks': checks, 'marker_positions': positions,
        'result_content_sha256': sha(results[0]['content'].encode()) if len(results) == 1 and isinstance(results[0].get('content'), str) else None,
        'imported_prefix_content_sha256': compact_sha(without_cache(messages[:4])) if len(messages) >= 4 else None}


def supplemental_spans(modules):
    rows = []
    def add(identifier, name, offset, raw):
        if not 0 < len(raw) <= 5000:
            raise RuntimeError('Supplemental source span exceeds5000bytes')
        rows.append({'id': identifier, 'module': name, 'module_byte_offset': offset,
                     'offset': modules[name]['offset']+offset, 'length': len(raw), 'sha256': sha(raw), 'text': raw.decode()})
    specs = [('post_load_restore', 'chunk-7wt2h396.js', 'function p$t('),
             ('paste_epoch_replay', 'chunk-4h798pp0.js', 'function X5e('),
             ('invoked_skill_restore', 'chunk-4h798pp0.js', 'function Oes('),
             ('announcement_census', 'chunk-4h798pp0.js', 'function w8t('),
             ('turn_count_census', 'chunk-4h798pp0.js', 'function $ca('),
             ('image_scan', 'chunk-vdzdy276.js', 'function xkr('),
             ('image_directory', 'chunk-vdzdy276.js', 'function m('),
             ('image_current_root', 'chunk-z01sq3y8.js', 'function tx('),
             ('image_root_path', 'chunk-z01sq3y8.js', 'function JQn('),
             ('image_root_canonical', 'chunk-z01sq3y8.js', 'function th('),
             ('temp_env_base', 'chunk-en7h9wsf.js', 'function vf('),
             ('temp_root_bootstrap', 'chunk-en7h9wsf.js', 'function h('),
             ('temp_root_owner_guard', 'chunk-en7h9wsf.js', 'function l3('),
             ('temp_uid_component', 'chunk-en7h9wsf.js', 'function kQe('),
             ('goal_restore', 'chunk-exepfc8f.js', 'function Mys('),
             ('goal_selector', 'chunk-vb7c0fkd.js', 'function eer('),
             ('todo_selector', 'chunk-7wt2h396.js', 'function we('),
             ('tool_balance', 'chunk-4h798pp0.js', 'function Pee('),
             ('terminal_classification', 'chunk-4h798pp0.js', 'function N$n('),
             ('terminal_reply', 'chunk-4h798pp0.js', 'function S$n('),
             ('turn_verdict', 'chunk-4h798pp0.js', 'function w$e('),
             ('native_original_cwd', 'chunk-3zn9cw12.js', 'function Te(')]
    for identifier, name, token in specs:
        data = (REPO/'artifacts/claude-bundle'/name).read_bytes()
        start = data.index(token.encode())
        if data[max(0, start-6):start] == b'async ':
            start -= 6
        end = data.find(b'function ', start+len(token))
        if end == -1:
            end = len(data)
        elif data[end-6:end] == b'async ':
            end -= 6
        add('main_read_resume_'+identifier, name, start, data[start:end])
    name = 'chunk-4h798pp0.js'
    data = (REPO/'artifacts/claude-bundle'/name).read_bytes()
    start = data.index(b'function L$n(')
    end = data.index(b'function ', start+len(b'function L$n('))
    complete = data[start:end]
    for index in range(0, len(complete), 5000):
        add('main_read_resume_decoder_part_'+str(index//5000+1), name, start+index, complete[index:index+5000])
    for identifier, name, literal in [
        ('goal_export', 'chunk-btnzwcjk.js', 'export{Mys as restoreGoalFromTranscript};'),
        ('todo_actual_name', 'chunk-7zn1pqb8.js', 'var Zw="TodoWrite";'),
    ]:
        data = (REPO/'artifacts/claude-bundle'/name).read_bytes(); raw = literal.encode()
        add('main_read_resume_'+identifier, name, data.index(raw), raw)
    return rows


def verify_source():
    modules = {row['name']: row for row in json.loads((REPO/'artifacts/bundle-manifest.json').read_text())['modules']}
    required = {
        'native-resume-entry-research/spans.json': {'native_resume_entry_S0e', 'native_resume_entry_Jb', 'native_resume_entry_gwn', 'native_resume_entry_print_loader', 'native_resume_entry_print_adopt_storage'},
        'native-resume-context-research/spans.json': {'native_resume_context_RPi', 'native_resume_context_Eun', 'native_resume_context_vTe'},
        'native-main-capture-research/spans.json': {'native_main_persistence_flag', 'native_main_persistence_consumer', 'native_main_skip_persistence'},
        'native-main-import-research/restore-spans.json': {'native_import_plan_restore_slug_guard', 'native_import_same_owner_filehistory_guard'},
        'native-tool-context-research/spans.json': set(),
        'native-context-classifiers-research/spans.json': set(),
    }
    groups = {}; spans = []
    for name, ids in required.items():
        path = REPO/'artifacts'/name; rows = json.loads(path.read_text())
        if not ids <= {row['id'] for row in rows}:
            raise RuntimeError('Source handshake incomplete: '+name)
        groups[name] = {'sha256': file_sha(path), 'rows': len(rows)}
        spans += rows
    extra = supplemental_spans(modules); spans += extra
    with PINNED_TARGET.open('rb') as target:
        if hashlib.file_digest(target, 'sha256').hexdigest() != TARGET_SHA256:
            raise RuntimeError('Retained326 target changed')
        for name in {row['module'] for row in spans}:
            if file_sha(REPO/'artifacts/claude-bundle'/name) != modules[name]['sha256']:
                raise RuntimeError('Recovered source module changed')
        for row in spans:
            if not 0 < row['length'] <= 8192:
                raise RuntimeError('Source range exceeds bounded manifest scope')
            target.seek(row['offset']); raw = target.read(row['length'])
            if sha(raw) != row['sha256'] or raw.decode() != row['text']:
                raise RuntimeError('Retained executable source bytes differ')
    return {'target_sha256': TARGET_SHA256, 'all_equal': True, 'source_rows': len(spans),
            'groups': groups, 'supplemental_spans': extra, 'original_executed': False, 'recovered_code_executed': False}


def recipe():
    return {'expected_messages': 1, 'hard_message_cap': 2, 'cli': 1, 'tools': 0, 'hooks': 0, 'peers': 0,
            'arguments': ['--resume', '__OWNED_READONLY_COPY__', '--model', MODEL, '--tools', '',
                          '--print', PROMPT, '--max-turns', '1', '--output-format', 'json',
                          '--permission-mode', 'default', '--no-session-persistence'],
            'source_session_id': SESSION_ID, 'checkpoint': LEAF, 'source_raw_sha256': RAW_SHA,
            'prior_tau_capture_sha256': TAU_SHA, 'new_tau_execution': False,
            'current_cwd': '__OWNED_ROOT__/work', 'writer_directory': '__OWNED_ROOT__/imported',
            'readonly_copy_mode': '0400', 'writer_directory_mode': '0700; observe writes, do not hide them with an added read-only directory restriction',
            'expected_owned_temp_effects': 'Native temp bootstrap may create/chmod only beneath the explicit owned CLAUDE_CODE_TMPDIR. All state metadata is captured; adopted transcript directory must stay unchanged.'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=REPO/'artifacts/differential-pass/native-main-read-resume-preparation')
    args = parser.parse_args(); output = args.output.resolve(); output.mkdir(parents=True, exist_ok=True)
    if any((output/name).exists() for name in ['source-preflight.json', 'input-audit.json', 'recipe.json', 'harness-hashes.json']):
        raise RuntimeError('Refusing preparation overwrite')
    source = verify_source(); raw, facts, receipts, tau = load_inputs()
    RESEARCH.mkdir(parents=True, exist_ok=True)
    if (RESEARCH/'spans.json').exists():
        raise RuntimeError('Refusing supplemental source manifest overwrite')
    (RESEARCH/'spans.json').write_text(json.dumps(source['supplemental_spans'], indent=2)+'\n')
    (RESEARCH/'embedded-spans.tsv').write_text('sha256\t'+TARGET_SHA256+'\n'+''.join(
        f"{row['id']}\t{row['offset']}\t{row['length']}\t{row['sha256']}\n" for row in source['supplemental_spans']))
    (RESEARCH/'verification.json').write_text(json.dumps({'target_sha256': TARGET_SHA256,
        'spans': len(source['supplemental_spans']), 'all_equal': True,
        'max_span_bytes': max(row['length'] for row in source['supplemental_spans']),
        'original_executed': False, 'recovered_code_executed': False}, indent=2)+'\n')
    hashes = {name: file_sha(REPO/'scripts/differential'/name) for name in SCRIPT_NAMES}
    (output/'source-preflight.json').write_text(json.dumps(source, indent=2)+'\n')
    (output/'input-audit.json').write_text(json.dumps({'receipts': receipts, 'facts': facts,
        'prior_tau_manifest_sha256': tau['runtime']['manifest_sha256'], 'source_readonly_bytes': len(raw),
        'original_resume_executed': False, 'new_tau_executed': False}, indent=2)+'\n')
    (output/'recipe.json').write_text(json.dumps(recipe(), indent=2)+'\n')
    (output/'harness-hashes.json').write_text(json.dumps(hashes, indent=2)+'\n')
    print(json.dumps({'source_rows': source['source_rows'], 'supplemental_spans': len(source['supplemental_spans']),
        'all_equal': True, 'input_sha256': RAW_SHA, 'prior_tau_sha256': TAU_SHA,
        'all_restore_guards': all(facts['restore_guards'].values()), 'original_resume_executed': False, 'new_tau_executed': False}))


if __name__ == '__main__':
    main()
