/* Independently authored bounded lifecycle hook fixture; only builtin fs. */
const fs=require('node:fs');
const [mode,logPath,scenario,kind]=process.argv.slice(2);
const log=row=>fs.appendFileSync(logPath,JSON.stringify({pid:process.pid,ppid:process.ppid,kind,...row})+'\n');
if(mode==='ready'){log({event:'ready'});process.stdout.write('owned-subagent-lifecycle-ready');process.exit(0);}
log({event:'start'});process.on('exit',code=>log({event:'exit',code}));
let data='';process.stdin.setEncoding('utf8');
process.stdin.on('data',chunk=>{data+=chunk;if(data.length>1024*1024)process.exit(3);});
process.stdin.on('end',()=>{
  let input;try{input=JSON.parse(data);}catch{process.exitCode=3;return;}
  const invocation=fs.readFileSync(logPath,'utf8').split('\n').filter(Boolean).map(JSON.parse).filter(row=>row.event==='input'&&row.kind===kind).length+1;
  log({event:'input',invocation,input});
  if(input.agent_type!=='owned-reader'||invocation>4){process.stderr.write('OWNED_LIFECYCLE_SCOPE_REJECT');process.exitCode=3;return;}
  let output;
  if(kind==='start-context'&&input.hook_event_name==='SubagentStart')output={continue:false,stopReason:'OWNED_START_CONTINUE_IGNORED',hookSpecificOutput:{hookEventName:'SubagentStart',additionalContext:'OWNED_SUBAGENT_START_CONTEXT'}};
  else if(kind==='start-diagnostic'&&input.hook_event_name==='SubagentStart'){
    log({event:'output',stderr:'OWNED_SUBAGENT_START_DIAGNOSTIC',code:2});process.stderr.write('OWNED_SUBAGENT_START_DIAGNOSTIC');process.exitCode=2;return;
  }else if(kind==='stop'&&input.hook_event_name==='SubagentStop'){
    if(scenario==='fallback')output={decision:'block',reason:'OWNED_FALLBACK_BLOCK_IGNORED',hookSpecificOutput:{hookEventName:'SubagentStop',additionalContext:'OWNED_FALLBACK_CONTEXT_IGNORED'}};
    else if(invocation===1)output={hookSpecificOutput:{hookEventName:'SubagentStop',additionalContext:'OWNED_SUBAGENT_STOP_CONTEXT'}};
    else output={continue:false,stopReason:'OWNED_SUBAGENT_FINISH',decision:'block',reason:'OWNED_FINAL_BLOCK_IGNORED',hookSpecificOutput:{hookEventName:'SubagentStop',additionalContext:'OWNED_FINAL_CONTEXT_IGNORED'}};
  }else{process.stderr.write('OWNED_LIFECYCLE_EVENT_REJECT');process.exitCode=3;return;}
  log({event:'output',output,code:0});process.stdout.write(JSON.stringify(output)+'\n');
});
