#!/usr/bin/env python3
"""Fresh20-canary public Bun/dependency/mock readiness only; never launch Tau."""
import argparse
import http.server
import json
from pathlib import Path
import subprocess

from bun_runtime import bun_environment,copy_bun_executable,copy_bun_source_runtime
from isolation import REPO,Isolation


class Handler(http.server.BaseHTTPRequestHandler):
    requests=[]
    def log_message(self,*_args):pass
    def do_POST(self):
        raw=self.rfile.read(int(self.headers.get('content-length','0')));body=json.loads(raw);self.requests.append({'path':self.path,'body':body})
        if self.path!='/owned-bun-protocol'or body!={'marker':'OWNED_BUN_PROTOCOL_REQUEST'}:self.send_error(400);return
        self.send_response(200);self.send_header('content-type','application/json');self.end_headers();self.wfile.write(b'{"marker":"OWNED_BUN_PROTOCOL_REPLY"}')


PROGRAM='''import ignore from "ignore";
import { marked } from "marked";
import picomatch from "picomatch";
import stringWidth from "string-width";
import { parse } from "yaml";
import { z } from "zod";
const local: string = "OWNED_BUN_PROTOCOL_REQUEST";
if (!ignore().add("owned-ignored").ignores("owned-ignored") || typeof await marked.parse("owned") !== "string" || !picomatch("*.txt")("owned.txt") || stringWidth("owned") !== 5 || parse("marker: owned").marker !== "owned") throw Error("Owned dependency check failed");
const payload = z.object({ marker: z.literal("OWNED_BUN_PROTOCOL_REQUEST") }).parse({ marker: local });
const response = await fetch(process.env.ANTHROPIC_BASE_URL + "/owned-bun-protocol", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(5000) });
if (!response.ok || (await response.json()).marker !== "OWNED_BUN_PROTOCOL_REPLY") throw Error("Owned protocol failed");
process.stdout.write("owned-bun-typescript-dependencies-protocol-ready");
'''


def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--artifacts',type=Path,default=REPO/'artifacts/differential-pass/bun-runtime-preparation');args=p.parse_args();directory=args.artifacts.resolve()
    if(directory/'readiness.json').exists():raise RuntimeError('Refusing readiness capture overwrite')
    isolation=Isolation(directory,Handler)
    receipts={'original_executed':False,'port_entrypoint_executed':False,'shared_build_executed':False}
    try:
        overrides=bun_environment(isolation.root);isolation.env.update(overrides);isolation.verify();bun,manifest=copy_bun_executable(isolation.root)
        version=isolation.sandbox([str(bun),'--version']);help_result=isolation.sandbox([str(bun),'--help'])
        receipts.update(isolation=isolation.report,environment_overrides=overrides,bun_executable=manifest,version_probe=version,help_probe=help_result)
        (directory/'bootstrap.json').write_text(json.dumps(receipts,indent=2)+'\n')
        if version['exit_code']!=0 or version['stdout'].strip()!='1.4.4'or help_result['exit_code']!=0 or'--no-install'not in help_result['stdout']:raise RuntimeError('Bun version/no-install bootstrap differs; no entrypoint execution allowed')
        entry,runtime=copy_bun_source_runtime(isolation.root,manifest);authored=entry.parent.parent/'owned-bun-protocol.ts';authored.write_text(PROGRAM)
        outcome=isolation.sandbox([str(bun),'--no-install',str(authored)])
        checks={'public_bun_version':version['stdout'].strip()=='1.4.4','no_install_supported':'--no-install'in help_result['stdout'],'authored_typescript_all_runtime_dependencies_protocol':outcome['exit_code']==0 and not outcome['timed_out']and outcome['stdout']=='owned-bun-typescript-dependencies-protocol-ready','one_owned_protocol_request':len(Handler.requests)==1,'no_forced_group_cleanup':not outcome['remaining_process_group_killed']}
        record={'isolation':isolation.report,'runtime':runtime,'environment_overrides':overrides,'version_probe':version,'help_probe':help_result,'authored_program':PROGRAM,'result':outcome,'requests':Handler.requests,'checks':checks,'original_executed':False,'port_entrypoint_executed':False,'shared_build_executed':False}
        (directory/'readiness.json').write_text(json.dumps(record,indent=2)+'\n');(directory/'bun-help.txt').write_text(help_result['stdout']);print(json.dumps({'checks':checks,'bun_sha256':runtime['bun_sha256'],'manifest_sha256':runtime['manifest_sha256'],'source_files':len(runtime['source_files']),'packages':runtime['packages'],'original_executed':False,'port_entrypoint_executed':False}))
        kernel=subprocess.run(['/usr/bin/log','show','--last','2m','--style','compact','--predicate','eventMessage CONTAINS "'+isolation.tag+'"'],capture_output=True,text=True,timeout=10);(directory/'denials.txt').write_text(kernel.stdout)
    except Exception as error:
        receipts.update(error={'type':type(error).__name__,'message':str(error)},isolation=isolation.report)
        (directory/'failure.json').write_text(json.dumps(receipts,indent=2)+'\n');raise
    finally:isolation.close()
    if not all(checks.values()):raise SystemExit(3)


if __name__=='__main__':main()
