#!/usr/bin/env python3
"""New trusted-project recipes only; old failed original phase stays immutable."""
import argparse
import hashlib
import json
from pathlib import Path

from isolation import REPO, TARGET_SHA256
from prepare_agent_definition_hooks import MODEL, ENV, PINNED_TARGET, recipes as original_recipes, agent, delegation_marker, verify as original_verify

CASES = ['trusted-project-dedup-once-foreground', 'trusted-project-nested-start-background-stop']
SCENARIOS = dict(zip(CASES, ['dedup-once-foreground', 'nested-start-background-stop']))


def verify():
    source = original_verify()
    modules = {row['name']: row for row in json.loads((REPO / 'artifacts/bundle-manifest.json').read_text())['modules']}
    with PINNED_TARGET.open('rb') as target:
        if hashlib.file_digest(target, 'sha256').hexdigest() != TARGET_SHA256:
            raise RuntimeError('Retained source target differs')
        for relative, expected in [('agent-definition-hooks-origin-research/spans.json', 52), ('agent-definition-hooks-origin-research/restriction-spans.json', 9)]:
            path = REPO / 'artifacts' / relative
            rows = json.loads(path.read_text())
            if len(rows) != expected:
                raise RuntimeError('Trusted-project origin proof set differs')
            for module in {row['module'] for row in rows}:
                if hashlib.sha256((REPO / 'artifacts/claude-bundle' / module).read_bytes()).hexdigest() != modules[module]['sha256']:
                    raise RuntimeError('Recovered proof module differs')
            for row in rows:
                target.seek(row['offset']); raw = target.read(row['length'])
                if hashlib.sha256(raw).hexdigest() != row['sha256'] or raw.decode() != row['text']:
                    raise RuntimeError('Trusted origin executable span differs')
            source['groups'][relative] = {'sha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'spans': len(rows)}
            source['spans'] += len(rows)
    return source


def recipes():
    plans = original_recipes()
    values = {}
    for case, scenario in SCENARIOS.items():
        plan = plans[scenario]
        for row in plan['responses']:
            if row.get('tool') == 'Agent':
                old = row['input']
                row['input'] = agent(old['subagent_type'], old['run_in_background'], case=case)
        plan.update(scenario_case=scenario, fixture_revision='source-separated trusted-project A2/B2',
                    trust_fixture={'path': '__OWNED_ROOT__/config/.claude.json', 'project_key': '__OWNED_ROOT__/work',
                                   'text': json.dumps({'projects': {'__OWNED_ROOT__/work': {'hasTrustDialogAccepted': True}}}) + '\n',
                                   'adjudication': 'Exact key/strict true and guarded owned path per snapshot; preserve all raw bootstrap updates, no across-run hash/inode equality requirement'},
                    prior_failed_control='artifacts/differential-pass/agent-definition-hooks-original/original-dedup-once-foreground.json',
                    response_identity='New trusted-project case-specific response IDs and DIRECT USER delegation markers; original failed IDs are not reused')
        plan['assertions'] = [text for text in plan['assertions'] if 'overwritten settings once state' not in text]
        plan['assertions'].append('Ordinary settings/definition once metadata has no implicit removal; Skill success callbacks are outside this control.')
        plan['assertions'].append('Exact owned project origin hasTrustDialogAccepted remains true; global config raw/identity changes are observed, not silently normalized away.')
        values[case] = plan
    return values


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=REPO / 'artifacts/trusted-agent-definition-hooks-prep')
    args = parser.parse_args()
    output = args.output.resolve(); output.mkdir(parents=True, exist_ok=True)
    if any((output / name).exists() for name in ['source-preflight.json', 'recipes.json', 'SUMMARY.json']):
        raise RuntimeError('Refusing trusted preparation overwrite')
    source = verify()
    (output / 'source-preflight.json').write_text(json.dumps(source, indent=2) + '\n')
    (output / 'recipes.json').write_text(json.dumps(recipes(), indent=2) + '\n')
    summary = {'prepared_only': True, 'original_executed': False, 'tau_executed': False, 'listener_started': False,
               'cases': CASES, 'expected_messages': 14, 'phase_hard_cap': 18, 'max_cli': 2, 'expected_authored_hooks': 10,
               'source_spans': source['spans'], 'separate_root_execution_go_required': True, 'old_failed_original_unchanged': True}
    (output / 'SUMMARY.json').write_text(json.dumps(summary, indent=2) + '\n')
    print(json.dumps(summary))


if __name__ == '__main__':
    main()
