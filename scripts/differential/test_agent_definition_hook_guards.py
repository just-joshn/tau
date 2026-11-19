#!/usr/bin/env python3
"""Authored capture-guard fixtures only: no subprocess, listener or CLI execution."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import tempfile
import traceback
from unittest.mock import patch

import run_agent_definition_hooks as runner


def require(value, message):
    if not value:
        raise AssertionError(message)


def observed(root, path):
    original = os.read
    reads = []

    def read(descriptor, count):
        raw = original(descriptor, count)
        reads.append(len(raw))
        return raw

    with patch.object(runner.os, 'read', side_effect=read):
        value = runner.owned_snapshot(root, path)
    return value, reads


def rejected_without_read(root, path):
    value, reads = observed(root, path)
    require(value.get('guard_error') and 'raw_text' not in value, 'Invalid file must return a guard error and no contents')
    require(not reads, 'Invalid path/link/size must be rejected before any content read')
    return {'guard_error': value['guard_error'], 'content_read_calls': len(reads)}


def regular(base, root):
    path = root / 'nested/regular.txt'; path.parent.mkdir()
    raw = b'OWNED_CAPTURE_BOUND\n' + b'x' * (1048576 - len(b'OWNED_CAPTURE_BOUND\n'))
    path.write_bytes(raw)
    value, reads = observed(root, path)
    require(value.get('sha256') == hashlib.sha256(raw).hexdigest() and value.get('bytes') == 1048576, 'Exact 1MiB regular file must be captured')
    require(value.get('regular_single_link') and value.get('ownership_rechecked') and value.get('ctime_ns') == path.stat().st_ctime_ns, 'Strong receipt must expose verified ownership/ctime')
    missing = runner.owned_snapshot(root, root / 'absent.txt')
    require(missing == {'path': str(root / 'absent.txt'), 'exists': False}, 'Ordinary initially absent leaf must remain absent')
    return {'accepted_bytes': value['bytes'], 'content_read_calls': len(reads), 'receipt_ctime': True, 'absent_leaf': True}


def hardlink(base, root):
    target = base / 'authored-foreign.txt'; target.write_text('OWNED_FOREIGN_HARDLINK\n')
    path = root / 'hardlink.txt'; os.link(target, path)
    require(path.stat().st_nlink == 2, 'Hardlink fixture must actually have two links')
    return rejected_without_read(root, path)


def leaf_symlink(base, root):
    own = root / 'target.txt'; own.write_text('OWNED_INSIDE_TARGET\n')
    foreign = base / 'foreign.txt'; foreign.write_text('OWNED_OUTSIDE_TARGET\n')
    values = {}
    for name, target in [('inside', own), ('outside', foreign), ('dangling', root / 'missing-target')]:
        path = root / name; path.symlink_to(target)
        values[name] = rejected_without_read(root, path)
    return values


def directory_symlink(base, root):
    own = root / 'real'; own.mkdir(); (own / 'target.txt').write_text('OWNED_INSIDE_DIRECTORY\n')
    foreign = base / 'foreign'; foreign.mkdir(); (foreign / 'target.txt').write_text('OWNED_OUTSIDE_DIRECTORY\n')
    values = {}
    for name, target in [('inside-alias', own), ('outside-alias', foreign)]:
        path = root / name; path.symlink_to(target, target_is_directory=True)
        values[name] = rejected_without_read(root, path / 'target.txt')
    alias = base / 'root-alias'; alias.symlink_to(root, target_is_directory=True)
    values['root-alias'] = rejected_without_read(alias, alias / 'real/target.txt')
    return values


def bounds(base, root):
    oversized = root / 'oversized'; oversized.write_bytes(b'x' * 1048577)
    oversized_receipt = rejected_without_read(root, oversized)
    directory = root / 'aggregate'; directory.mkdir()
    (directory / 'a.jsonl').write_bytes(b'a' * 1048576)
    (directory / 'b.jsonl').write_bytes(b'b' * 1048576)
    (directory / 'c.jsonl').write_bytes(b'c')
    original = os.read; byte_counts = []

    def read(descriptor, count):
        raw = original(descriptor, count); byte_counts.append(len(raw)); return raw

    with patch.object(runner.os, 'read', side_effect=read):
        aggregate = runner.owned_records(root, directory, ('.jsonl',))
    require(aggregate['guards'] and aggregate['bytes'] == 2097152 and sum(byte_counts) == 2097152, 'Aggregate must stop before reading beyond 2MiB')
    require('raw_text' not in aggregate['files']['aggregate/c.jsonl'], 'Over-budget next file contents must never be returned')
    directory = root / 'count'; directory.mkdir()
    for index in range(17):
        (directory / (str(index).zfill(2) + '.json')).write_text('{}')
    byte_counts.clear()
    with patch.object(runner.os, 'read', side_effect=read):
        counted = runner.owned_records(root, directory, ('.json',))
    require(counted['guards'] and len(counted['files']) == 16 and sum(byte_counts) == 32, 'File-count bound must hold before reading the seventeenth file')
    return {'oversized': oversized_receipt, 'aggregate_bytes': aggregate['bytes'], 'aggregate_guards': aggregate['guards'],
            'count_files': len(counted['files']), 'count_bytes_read': sum(byte_counts), 'count_guards': counted['guards']}


def preopen_races(base, root):
    path = root / 'race.txt'; path.write_text('OWNED_BEFORE\n')
    replacement = root / 'replacement.txt'; replacement.write_text('OWNED_AFTER!\n')
    original_open = os.open; original_read = os.read; read_counts = []; changed = []

    def leaf_open(name, flags, *args, **kwargs):
        if name == 'race.txt' and kwargs.get('dir_fd') is not None and not changed:
            os.replace(replacement, path); changed.append('leaf')
        return original_open(name, flags, *args, **kwargs)

    def read(descriptor, count):
        raw = original_read(descriptor, count); read_counts.append(len(raw)); return raw

    with patch.object(runner.os, 'open', side_effect=leaf_open), patch.object(runner.os, 'read', side_effect=read):
        leaf = runner.owned_snapshot(root, path)
    require(changed == ['leaf'] and leaf.get('guard_error') and not read_counts and 'raw_text' not in leaf, 'Pre-open inode replacement must be rejected before reading')
    directory = root / 'directory'; directory.mkdir(); (directory / 'file').write_text('OWNED_DIRECTORY_BEFORE\n')
    foreign = base / 'foreign'; foreign.mkdir(); (foreign / 'file').write_text('OWNED_DIRECTORY_AFTER\n')
    changed.clear()

    def directory_open(name, flags, *args, **kwargs):
        if name == 'directory' and kwargs.get('dir_fd') is not None and not changed:
            directory.rename(root / 'retired'); directory.symlink_to(foreign, target_is_directory=True); changed.append('directory')
        return original_open(name, flags, *args, **kwargs)

    with patch.object(runner.os, 'open', side_effect=directory_open), patch.object(runner.os, 'read', side_effect=read):
        directory_value = runner.owned_snapshot(root, directory / 'file')
    require(changed == ['directory'] and directory_value.get('guard_error') and not read_counts and 'raw_text' not in directory_value, 'Pre-open directory symlink replacement must be rejected before reading')
    return {'leaf_guard': leaf['guard_error'], 'directory_guard': directory_value['guard_error'], 'content_read_calls': len(read_counts)}


def read_races(base, root):
    path = root / 'mutating.txt'; path.write_bytes(b'A' * 65536); before = path.stat()
    original = os.read; changes = []

    def mutate(descriptor, count):
        raw = original(descriptor, count)
        if raw and not changes:
            path.write_bytes(b'B' * 65536)
            os.utime(path, ns=(before.st_atime_ns, before.st_mtime_ns))
            changes.append(path.stat().st_ctime_ns)
        return raw

    with patch.object(runner.os, 'read', side_effect=mutate):
        value = runner.owned_snapshot(root, path)
    after = path.stat()
    require(after.st_ino == before.st_ino and after.st_size == before.st_size and after.st_mtime_ns == before.st_mtime_ns and after.st_ctime_ns != before.st_ctime_ns, 'Race fixture must preserve inode/size/mtime while changing ctime')
    require(changes and value.get('guard_error') and 'raw_text' not in value, 'Same-size read mutation with restored mtime must be rejected')
    path = root / 'disappearing.txt'; path.write_text('OWNED_DISAPPEARING\n'); changes.clear()

    def remove(descriptor, count):
        raw = original(descriptor, count)
        if raw and not changes:
            path.unlink(); changes.append('removed')
        return raw

    with patch.object(runner.os, 'read', side_effect=remove):
        removed = runner.owned_snapshot(root, path)
    require(changes == ['removed'] and removed.get('guard_error') and 'raw_text' not in removed, 'A post-open unlink must be a race guard, not an initially absent leaf')
    return {'same_inode_size_mtime': True, 'changed_ctime': True, 'mutation_guard': value['guard_error'], 'unlink_guard': removed['guard_error']}


CASES = [('regular_and_initially_missing', regular), ('hardlink_before_read', hardlink), ('leaf_symlinks_before_read', leaf_symlink),
         ('directory_symlinks_before_read', directory_symlink), ('size_aggregate_count_before_consume', bounds),
         ('preopen_leaf_and_directory_races', preopen_races), ('during_read_ctime_and_unlink_races', read_races)]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if args.output.exists():
        raise RuntimeError('Refusing authored guard receipt overwrite')
    cases = {}
    roots = []
    for name, run in CASES:
        with tempfile.TemporaryDirectory(prefix='tau-authored-hook-guard-', dir='/private/tmp') as temporary:
            base = Path(temporary).resolve(); root = base / 'owned'; root.mkdir(); roots.append(str(base))
            try:
                cases[name] = {'passed': True, 'receipt': run(base, root)}
            except Exception as error:
                cases[name] = {'passed': False, 'error': {'type': type(error).__name__, 'message': str(error)}, 'traceback': traceback.format_exc()}
    files = [Path(__file__), Path(runner.__file__)]
    result = {'authored_fileguard_only': True, 'original_executed': False, 'tau_executed': False, 'listener_started': False, 'subprocess_started': False,
              'cases': cases, 'all_passed': all(value['passed'] for value in cases.values()), 'roots_removed': all(not Path(root).exists() for root in roots),
              'file_hashes': {str(path.relative_to(Path.cwd())): hashlib.sha256(path.read_bytes()).hexdigest() for path in files}}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result, indent=2))
    if not result['all_passed'] or not result['roots_removed']:
        raise SystemExit(3)


if __name__ == '__main__':
    main()
