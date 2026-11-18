"""Select small native functions that directly call chosen import stubs, for a SHA-pinned Ghidra manifest.

Usage: python3 -I select-callers.py <binary> <sha256> <out-ranges.tsv> <out-calls.json> <per-family> <family>...
A family is an import-name prefix such as _write or _rename. Scope: aligned direct BL words in __text only;
indirect calls and tail calls are not covered. Nothing is executed.
"""
import bisect
import hashlib
import json
import mmap
import struct
import sys

binary, sha, ranges_out, calls_out, per_family, *families = sys.argv[1:]
per_family = int(per_family)

with open(binary, 'rb') as source:
    image = mmap.mmap(source.fileno(), 0, access=mmap.ACCESS_READ)
    assert hashlib.sha256(image).hexdigest() == sha, 'unexpected executable hash'
    command = 32
    for _ in range(struct.unpack_from('<I', image, 16)[0]):
        kind, size = struct.unpack_from('<II', image, command)
        if kind == 2:
            symbols, symbol_count, strings, strings_size = struct.unpack_from('<4I', image, command + 8)
        if kind == 0xb:
            indirect, indirect_count = struct.unpack_from('<II', image, command + 56)
        if kind == 0x26:
            starts_offset, starts_size = struct.unpack_from('<II', image, command + 8)
        if kind == 0x19:
            for index in range(struct.unpack_from('<I', image, command + 64)[0]):
                section = command + 72 + index * 80
                name = image[section:section + 16].split(b'\0')[0]
                if name == b'__stubs':
                    stub_address, stub_size = struct.unpack_from('<QQ', image, section + 32)
                    stub_index, stub_stride = struct.unpack_from('<II', image, section + 68)
                if name == b'__text':
                    text_address, text_size, text_offset = struct.unpack_from('<QQI', image, section + 32)
        command += size

    def family_of(name):
        return next((f for f in families if name == f or name.startswith(f + '$')), None)

    imports = {}
    for index in range(stub_size // stub_stride):
        symbol = struct.unpack_from('<I', image, indirect + 4 * (stub_index + index))[0]
        if symbol >= symbol_count:
            continue
        string = struct.unpack_from('<I', image, symbols + symbol * 16)[0]
        assert string < strings_size
        end = image.find(b'\0', strings + string, strings + strings_size)
        name = image[strings + string:end].decode()
        if family_of(name):
            imports[stub_address + index * stub_stride] = name

    starts, address, delta, shift = [], 0x100000000, 0, 0
    for byte in image[starts_offset:starts_offset + starts_size]:
        delta |= (byte & 127) << shift
        if byte & 128:
            shift += 7
            continue
        if delta == 0:
            break
        address += delta
        starts.append(address)
        delta = shift = 0

    calls = []
    for offset in range(text_offset, text_offset + text_size, 4):
        word = struct.unpack_from('<I', image, offset)[0]
        if word & 0xfc000000 != 0x94000000:
            continue
        displacement = word & 0x3ffffff
        if displacement & 0x2000000:
            displacement -= 0x4000000
        site = text_address + offset - text_offset
        target = site + displacement * 4
        if target not in imports:
            continue
        index = bisect.bisect_right(starts, site) - 1
        if index < 0 or index + 1 >= len(starts):
            continue
        calls.append({'import': imports[target], 'family': family_of(imports[target]), 'stub': hex(target),
                      'call': hex(site), 'entry': hex(starts[index]), 'end_exclusive': hex(starts[index + 1]),
                      'bytes': starts[index + 1] - starts[index]})

selected, counts = [], {}
for family in families:
    candidates = sorted((c for c in calls if c['family'] == family), key=lambda c: (c['bytes'], c['entry']))
    counts[family] = {'direct_sites': len(candidates), 'entries': len({c['entry'] for c in candidates})}
    seen = {c['entry'] for c in selected}
    for call in candidates:
        if len([c for c in selected if c['family'] == family]) == per_family:
            break
        if call['entry'] not in seen:
            seen.add(call['entry'])
            selected.append(call)

with open(calls_out, 'w') as out:
    json.dump({'sha256': sha, 'scope': 'aligned direct BL words in __text only; no indirect or tail-call coverage',
               'imports': {name: hex(a) for a, name in sorted(imports.items())}, 'counts': counts,
               'selected': selected}, out, indent=2)
    out.write('\n')
with open(ranges_out, 'w') as out:
    out.write(f'sha256\t{sha}\n')
    for call in selected:
        start, end = int(call['entry'], 16), int(call['end_exclusive'], 16)
        assert end - start <= 65536, 'range exceeds the manifest limit'
        out.write(f'{start:x}\t{end - 1:x}\n')
print(json.dumps({'counts': counts, 'selected': [(c['family'], c['entry'], c['bytes']) for c in selected]}))
