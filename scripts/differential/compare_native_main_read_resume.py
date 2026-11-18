#!/usr/bin/env python3
"""Compare NEW original resume with the immutable PRIOR Tau Read-import capture; no app execution."""
import argparse
import json
from pathlib import Path

from isolation import REPO, TARGET_SHA256
from prepare_native_main_read_resume import (SESSION_ID, RAW_SHA, TAU_CAPTURE, TAU_SHA,
    load_inputs, observe, compact_sha, without_cache)
from run_agent_definition_hooks import bounded_owned_file


def text_blocks(content):
    if isinstance(content, str):
        return [content]
    if isinstance(content, list):
        return [block['text'] for block in content if isinstance(block, dict) and block.get('type') == 'text' and isinstance(block.get('text'), str)]
    return []


def selected(body, output, current_workspace, facts, outcome, messages):
    history = body.get('messages', [])
    observation = observe(body, facts)
    blocks = [block for message in history if isinstance(message.get('content'), list)
              for block in message['content'] if isinstance(block, dict)]
    results = [block for block in blocks if block.get('type') == 'tool_result']
    assistants = [message for message in history if message.get('role') == 'assistant']
    joined = '\n'.join(text for message in history for text in text_blocks(message.get('content')))
    positions = observation['marker_positions']
    last_user = next((message for message in reversed(history) if message.get('role') == 'user'), {})
    from prepare_native_main_read_resume import PROMPT
    return {
        'messages': messages,
        'model': body.get('model'),
        'tool_names': sorted(tool['name'] for tool in body.get('tools', [])),
        'imported_prefix_content_sha256': observation['imported_prefix_content_sha256'],
        'result_context_content_sha256': observation['result_content_sha256'],
        'assistant_fragment_content_sha256': compact_sha(without_cache(assistants[0]['content'])) if assistants else None,
        'recorded_rendered_context': [{'sha256': compact_sha(value), 'present': value in joined} for value in facts['rendered']],
        'old_prompt_prelude_final_new_prompt_order': all(position >= 0 for position in positions) and positions == sorted(positions),
        'imported_history_roles': [message.get('role') for message in history[:4]],
        'last_imported_assistant': without_cache(assistants[-1]['content']) if assistants else None,
        'native_session_id': output.get('session_id'),
        'final_text': output.get('result'),
        'retained_tool_result_ids': [block.get('tool_use_id') for block in results],
        'retained_tool_result_error_flags': [bool(block.get('is_error')) for block in results],
        'query_usage': {key: output.get('usage', {}).get(key) for key in ['input_tokens', 'output_tokens']},
        'turns': output.get('num_turns'),
        'result_index': output.get('result_index'),
        'exit_code': outcome['exit_code'],
        'new_prompt_in_final_user_round': PROMPT in '\n'.join(text_blocks(last_user.get('content'))),
        'current_workspace_distinct_from_captured': current_workspace != facts['source_cwd'],
    }


def view(record, facts, mode, raw_sha):
    rows = [row for row in record['requests'] if row['path'].split('?')[0] == '/v1/messages']
    body = rows[0]['body'] if rows else {}
    output = record.get('output') or json.loads(record['result']['stdout'])
    root = record['isolation']['root']
    def normalize(value):
        if isinstance(value, str):
            return value.replace(root, '<ROOT>')
        if isinstance(value, list):
            return [normalize(child) for child in value]
        if isinstance(value, dict):
            return {key: normalize(child) for key, child in value.items()}
        return value
    original = mode == 'original'
    source_stable = (record['input_receipts_before'] == record['input_receipts_after']) if original else record['source_before'] == record['source_after']
    writer_stable = (record['writer_before'] == record['writer_after'])
    audit = {'runtime_checks': record['checks'], 'fresh_canaries': record['isolation']['passed'] and len(record['isolation']['checks']) == 20,
        'headroom': record['isolation']['disk_headroom_at_context_start'],
        'removed': not Path(root).exists() and (record.get('disposable_root_removed') if original else True),
        'group_clean': not record['cleanup']['remaining_members'] and not record['result']['remaining_process_group_killed'] and not record.get('budget_kills', []),
        'source_stable': source_stable, 'copy_stable': record['copied_before'] == record['copied_after'] and record['copied_after']['sha256'] == RAW_SHA,
        'writer_stable': writer_stable, 'native_records_empty': not (record['native_records'] if original else record['native_snapshots'])['files'],
        'target_copy': record['isolation'].get('target_copy'),
        'historical_tau_manifest': None if original else record['runtime']['manifest_sha256'],
        'historical_tau_source_count': None if original else len(record['runtime']['source_files']),
        'new_original': original, 'new_tau_execution': False}
    return {'raw_sha256': raw_sha,
        'selected': selected(body, output, record['current_workspace'], facts, record['result'], len(rows)),
        'history_oracle': observe(body, facts), 'audit': audit,
        'wire': {'messages': normalize(body.get('messages')), 'system': normalize(body.get('system')),
            'tools': body.get('tools'), 'controls': {key: value for key, value in body.items() if key not in ['messages', 'system', 'tools']},
            'safe_headers': rows[0].get('safe_headers') if rows else None, 'output': normalize(output),
            'stderr': normalize(record['result']['stderr']), 'archives': normalize(record['archives']),
            'native_records': normalize(record['native_records'] if original else record['native_snapshots']),
            'writer_directory': normalize({'before': record['writer_before'], 'after': record['writer_after']}),
            'runtime': normalize(record['runtime']),
            'owned_state': normalize(record.get('state_after'))}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--original', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if args.output.exists():
        raise RuntimeError('Refusing native Read resume comparison overwrite')
    _, facts, _, tau_record = load_inputs()
    tau = view(tau_record, facts, 'tau', TAU_SHA)
    original = None
    if args.original:
        original_path = args.original if args.original.is_absolute() else REPO/args.original
        raw, receipt = bounded_owned_file(REPO, original_path)
        original_record = json.loads(raw)
        if not original_record['original_executed'] or original_record['port_entrypoint_executed']:
            raise RuntimeError('Expected the new original-only resume capture')
        original = view(original_record, facts, 'original', receipt['sha256'])
    views = [tau, *([original] if original else [])]
    audits = {
        'all_recorded_runtime_checks': all(all(item['audit']['runtime_checks'].values()) for item in views),
        'fresh_twenty_canaries': all(item['audit']['fresh_canaries'] for item in views),
        'roots_removed': all(item['audit']['removed'] for item in views),
        'headroom_guard': all(item['audit']['headroom'] >= 1073741824 for item in views),
        'source_and_copied_inputs_immutable': all(item['audit']['source_stable'] and item['audit']['copy_stable'] for item in views),
        'natural_clean_groups': all(item['audit']['group_clean'] for item in views),
        'actual_read_restore_preconditions': all(facts['restore_guards'].values()),
        'original_pinned_distinct_copy': not original or original['audit']['target_copy']['sha256'] == TARGET_SHA256 and original['audit']['target_copy']['distinct_inode'],
        'versioned_tau_counterpart_verified_without_rerun': tau['audit']['historical_tau_manifest'] == 'fbe41b391b9ea80e9364a046bf807d041eaefe3ed0d222051b10f736bcbad8c9' and tau['audit']['historical_tau_source_count'] == 108,
        'native_id_retained_empty_tools': all(item['selected']['native_session_id'] == SESSION_ID and item['selected']['tool_names'] == [] for item in views),
        'one_message_each_hard_two_bound': all(item['selected']['messages'] == 1 and item['selected']['messages'] <= 2 for item in views),
        'owned_adopted_writer_stable_no_native_append': all(item['audit']['writer_stable'] and item['audit']['native_records_empty'] for item in views),
    }
    output = {'tau': tau, 'original': original, 'audits': audits,
        'selected_equal': {key: value == original['selected'][key] for key, value in tau['selected'].items()} if original else {},
        'wire_difference_fields': [key for key, value in tau['wire'].items() if value != original['wire'][key]] if original else [],
        'complete': original is not None, 'new_tau_executions': 0, 'prior_tau_capture': str(TAU_CAPTURE),
        'selected_fields': len(tau['selected']),
        'normalization': 'Selected imported-prefix hashes remove only cache_control annotations recursively. Wire views replace only each disposable root. Raw captures/hashes and all remaining provider/context/output/persistence differences are retained.',
        'scope': 'NEW original resume of the actual104246B/25row MAIN Read capture versus the immutable prior108-source Bun import. It is distinct from the older90987B pure-text original-resume pair and is not a fresh test of the latest worktree or full native session parity.'}
    output['all_selected_equal'] = bool(original) and all(output['selected_equal'].values())
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(output, indent=2)+'\n')
    print(json.dumps({key: value for key, value in output.items() if key not in ['tau', 'original', 'selected_equal']}))
    if not all(audits.values()) or original and not output['all_selected_equal']:
        raise SystemExit(3)


if __name__ == '__main__':
    main()
