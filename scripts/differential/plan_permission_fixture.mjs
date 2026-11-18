/* Authored, bounded stdio MCP permission peer. No application modules imported. */
import {appendFileSync} from 'node:fs';
import {dirname,resolve,basename} from 'node:path';
import {createInterface} from 'node:readline';
const [mode,logPath,scenario,planDirectory]=process.argv.slice(2);
const log=row=>appendFileSync(logPath,JSON.stringify({pid:process.pid,...row})+'\n');
if(mode==='ready'){log({event:'ready'});process.stdout.write('owned-plan-permission-ready');process.exit(0);}
log({event:'start'});process.on('exit',code=>log({event:'exit',code}));
process.on('SIGTERM',()=>{log({event:'signal',signal:'SIGTERM'});process.exit(0);});
let calls=0;
const lines=createInterface({input:process.stdin});
lines.on('close',()=>{log({event:'stdin-close'});process.exit(0);});
lines.on('line',line=>{
  if(line.length>1024*1024){log({event:'input-bound'});process.exit(3);}
  let message;try{message=JSON.parse(line);}catch{log({event:'invalid-json'});return;}
  log({event:'request',message});if(message.id===undefined)return;
  let result,error;
  if(message.method==='server/discover')error={code:-32601,message:'Owned standard MCP fixture'};
  else if(message.method==='initialize')result={protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'owned-plan-permissions',version:'1.0.0'}};
  else if(message.method==='tools/list')result={tools:[{name:'decide',description:'Return the deterministic approval decision for an owned plan fixture.',inputSchema:{type:'object',properties:{tool_name:{type:'string'},input:{type:'object'},tool_use_id:{type:'string'}},required:['tool_name','input']},annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false}}]};
  else if(message.method==='tools/call'){
    calls++;const args=message.params?.arguments;const input=args?.input;
    const admitted=message.params?.name==='decide'&&args?.tool_name==='ExitPlanMode'&&input&&typeof input==='object'&&!Array.isArray(input)&&typeof input.planFilePath==='string'&&resolve(dirname(input.planFilePath))===resolve(planDirectory)&&/^[a-z0-9-]+\.md$/.test(basename(input.planFilePath))&&!basename(input.planFilePath).includes('-agent-')&&input.plan==='OWNED_PLAN_FINAL\n'&&calls<=2;
    const decision=!admitted?{behavior:'deny',message:'OWNED_PLAN_SCOPE_REJECT',interrupt:false}:scenario==='reject'&&calls===1?{behavior:'deny',message:'OWNED_PLAN_REJECT',interrupt:false}:{behavior:'allow',updatedInput:input};
    if(typeof args?.tool_use_id==='string')decision.toolUseID=args.tool_use_id;
    log({event:'decision',invocation:calls,admitted,decision});
    result={content:[{type:'text',text:JSON.stringify(decision)}],isError:false};
  }else if(message.method==='ping')result={};
  else error={code:-32601,message:'Unknown owned method'};
  const response={jsonrpc:'2.0',id:message.id,...(error?{error}:{result})};
  log({event:'response',message:response});process.stdout.write(JSON.stringify(response)+'\n');
});
