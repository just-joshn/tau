#!/usr/bin/env python3
"""Pin bounded native print persistence/flush bytes; never execute target code."""
import hashlib
import json
from pathlib import Path

from isolation import REPO,TARGET_SHA256
from prepare_plugins import PINNED_TARGET


def main():
    output=REPO/'artifacts/native-main-capture-research';output.mkdir(parents=True,exist_ok=True)
    modules={r['name']:r for r in json.loads((REPO/'artifacts/bundle-manifest.json').read_text())['modules']}
    specifications=[
        ('native_main_persistence_flag','chunk-g7cw7kap.js','.option("--no-session-persistence",','.addOption(new Rs("--resume-session-at'),
        ('native_main_persistence_default','chunk-3zn9cw12.js','#U=!1;#D=!1;','#H=void 0;'),
        ('native_main_persistence_accessors','chunk-3zn9cw12.js','sessionPersistenceDisabled(){','diskless(){'),
        ('native_main_persistence_consumer','chunk-97e8zgw1.js','if(o.sessionPersistence===!1){','Ra({sdkUrl:Be,isNonInteractiveSession:Y})'),
        ('native_main_persistence_host_accessor','chunk-3zn9cw12.js','function Emr(e){','function K(){'),
        ('native_main_skip_persistence','chunk-4h798pp0.js','function knl(){','function lHo(e){'),
        ('native_main_nested_session_guard','chunk-aacwty0k.js','function xMt(){','function Ggi(){'),
        ('native_main_writer_skip_guard','chunk-4h798pp0.js','shouldSkipPersistence(){','unarchiveOnPrompt('),
        ('native_main_print_flush','chunk-4h798pp0.js','async function Cnl(){','function Ipl(){'),
        ('native_main_writer_flush','chunk-4h798pp0.js','async flush(){if(this.releaseWaitsForUploads()','drainQueuedRows('),
        ('native_main_cleanup_registry','chunk-qvaw5eph.js','class oe{','function wb(){'),
        ('native_main_print_normal_exit','chunk-xt4nsgp1.js','let Yl=!Xa?1:E.outputFormat===','function jY('),
        ('native_main_shutdown_entry','chunk-4h798pp0.js','function Xi(e=0,','function no(){'),
        ('native_main_shutdown_schedule','chunk-4h798pp0.js','shutdownSync(e=0,','recordUncaughtAndCheckBreaker('),
        ('native_main_shutdown_cleanup_drain','chunk-4h798pp0.js','async shutdown(e,n="other",r){','widenFailsafeBy(e,n){'),
        ('native_main_print_result_flush_attempt','chunk-xt4nsgp1.js','async function iP(e){','function aP('),
        ('native_main_config_root_env','chunk-4m8bc75e.js','function n_t(){','function mf(){'),
        ('native_main_project_root','chunk-d4df24q9.js','function eh(){','function jie('),
        ('native_main_shutdown_scope_default','chunk-b3hq5byq.js','var p=new g,l=!1;','var f=new W('),
    ]
    records=[]
    with PINNED_TARGET.open('rb')as target:
        if hashlib.file_digest(target,'sha256').hexdigest()!=TARGET_SHA256:raise RuntimeError('Pinned target changed')
        for label,name,start,end in specifications:
            data=(REPO/'artifacts/claude-bundle'/name).read_bytes()
            if hashlib.sha256(data).hexdigest()!=modules[name]['sha256']:raise RuntimeError('Pinned module changed')
            a=data.index(start.encode());b=data.index(end.encode(),a+len(start.encode()));raw=data[a:b]
            if not 0<len(raw)<8192:raise RuntimeError('Native main proof bound exceeded')
            offset=modules[name]['offset']+a;target.seek(offset)
            if target.read(len(raw))!=raw:raise RuntimeError('Native main source bytes differ')
            records.append({'id':label,'module':name,'module_byte_offset':a,'offset':offset,'length':len(raw),'sha256':hashlib.sha256(raw).hexdigest(),'text':raw.decode(),'equal':True})
    (output/'spans.json').write_text(json.dumps(records,indent=2)+'\n')
    (output/'embedded-spans.tsv').write_text('sha256\t'+TARGET_SHA256+'\n'+''.join(f"{r['id']}\t{r['offset']}\t{r['length']}\t{r['sha256']}\n"for r in records))
    report={'target_sha256':TARGET_SHA256,'spans':len(records),'all_equal':True,'max_span_bytes':max(r['length']for r in records),'original_executed':False,'recovered_code_executed':False,'ghidra_claim':False}
    (output/'verification.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report))


if __name__=='__main__':main()
