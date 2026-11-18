#!/usr/bin/env python3
"""Pinned byte spans for background stream accounting; static only."""
import hashlib
import json
from pathlib import Path

from isolation import REPO, TARGET_SHA256
from prepare_plugins import PINNED_TARGET


def main():
    modules = {r['name']:r for r in json.loads((REPO/'artifacts/bundle-manifest.json').read_text())['modules']}
    specs = [
        ('progress_assistant_uses_current_usage_full', 'chunk-4h798pp0.js', 'function FNr(', 'function $Nr('),
        ('progress_stream_deltas_full', 'chunk-4h798pp0.js', 'function $Nr(', 'function Jun('),
        ('step_assistant_provisional_usage_and_late_copy', 'chunk-cr640x0r.js', 'function Zl(', 'var Wt='),
        ('step_stop_late_usage_application', 'chunk-cr640x0r.js', 'function ni(', 'var oi='),
        ('step_content_stop_assistant_yield', 'chunk-cr640x0r.js', 'function*ce(F,ne,j)', 'function*ke('),
        ('step_late_originals_and_stop', 'chunk-cr640x0r.js', 'function se(F)', 'function*re('),
        ('step_wire_content_stop_order', 'chunk-cr640x0r.js', 'function*re(F,ne)', 'function*xe('),
        ('runner_stream_delta_estimator', 'chunk-cr640x0r.js', 'Oo=(V)=>{let ve=Date.now()', ',tl={'),
        ('runner_text_length_delta_callback', 'chunk-cr640x0r.js', '...Nt&&{onUpdateLength:', ',onApiMetrics:'),
        ('background_stream_callback_binding', 'chunk-cr640x0r.js', 'Sn=(we)=>{$Nr(Se,we)', ';Zt();'),
        ('background_assistant_progress_consumer', 'chunk-cr640x0r.js', 'FNr(Se,we,ut,h.options.tools)', ';let xn='),
    ]
    rows = []
    for label,name,start,end in specs:
        data = (REPO/'artifacts/claude-bundle'/name).read_bytes(); i = data.index(start.encode()); j = data.index(end.encode(),i+len(start.encode())); raw = data[i:j]
        if not 0 < len(raw) <= 4096: raise RuntimeError('Progress span bound differs')
        rows.append({'id':label,'module':name,'offset':modules[name]['offset']+i,'length':len(raw),'sha256':hashlib.sha256(raw).hexdigest(),'text':raw.decode()})
    with PINNED_TARGET.open('rb') as target:
        if hashlib.file_digest(target,'sha256').hexdigest() != TARGET_SHA256: raise RuntimeError('Pinned retained target differs')
        for name in {r['module']for r in rows}:
            if hashlib.sha256((REPO/'artifacts/claude-bundle'/name).read_bytes()).hexdigest() != modules[name]['sha256']: raise RuntimeError('Progress module differs')
        for row in rows:
            target.seek(row['offset']);raw = target.read(row['length'])
            if hashlib.sha256(raw).hexdigest() != row['sha256'] or raw.decode() != row['text']: raise RuntimeError('Installed progress span differs')
    directory = REPO/'artifacts/differential-pass/background-agents/progress-source';directory.mkdir(parents=True,exist_ok=True)
    proof = {'all_equal':True,'target_sha256':TARGET_SHA256,'target_source_path':str(PINNED_TARGET),'spans':rows,'original_executed':False,'recovered_code_executed':False,
             'interpretation':'Observed notice17 and finaltext28chars. Source allows provisional usage and later record updates; exact internal progress tuple was not captured. Do not assert live cumout0/streamestimate7 solely from final17.'}
    (directory/'verification.json').write_text(json.dumps(proof,indent=2)+'\n');(directory/'embedded-spans.tsv').write_text('id\toffset\tlength\tsha256\n'+''.join(f"{r['id']}\t{r['offset']}\t{r['length']}\t{r['sha256']}\n"for r in rows))
    print(json.dumps({'all_equal':True,'spans':len(rows),'max_bytes':max(r['length']for r in rows),'proof_sha256':hashlib.sha256((directory/'verification.json').read_bytes()).hexdigest(),'original_executed':False}))


if __name__ == '__main__':main()
