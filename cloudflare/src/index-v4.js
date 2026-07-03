
const VERSION="v5.0-clean-core-2026-07-03";
const DEFAULT_REPO="sromanuk16-lab/miniskynet-core";
const DEFAULT_BRANCH="main";
const DEFAULT_WORKER_URL="https://miniskynet-core.sromanuk16.workers.dev";
const H={"content-type":"application/json; charset=utf-8"};

const SELF_APPLY_MARKERS=[
  "v5 clean core baseline",
  "single-file flat runtime",
  "proposal FSM",
  "confirm-only GitHub write",
  "proposal-specific verification",
  "v5 first clean self-apply marker",
];

const CMDS=new Set(["/start","/help","/status","/self","/self_set","/goals","/goal_add","/plan","/plan_set","/tasks","/addtask","/task_done","/next","/memory","/memory_score","/think","/repo_config","/repo_file","/repo_scan","/active_target","/propose","/proposals","/show","/reject","/code_preview","/code_show","/apply_check","/apply_confirm","/apply_status","/post_apply_verify","/proposals_clean","/health_check","/deploy_check"]);

const now=()=>new Date().toISOString();
const clip=(v,n=3900)=>String(v??"").slice(0,n);
const uid=p=>`${p}_${crypto.randomUUID().slice(0,8)}`;
const clean=p=>String(p||"").trim().replace(/^\/+/,"");
const safe=p=>{const x=clean(p);return x&&!x.includes("..")&&x.length<180&&/^[\w./-]+$/.test(x)?x:null};
const out=(data,status=200)=>new Response(JSON.stringify(data,null,2),{status,headers:H});

function parse(update){
  const m=update?.message||update?.edited_message;
  if(!m)return null;
  const text=String(m.text||"").trim();
  let command=null,args="";
  if(text.startsWith("/")){
    const i=text.indexOf(" ");
    command=(i<0?text:text.slice(0,i)).replace(/@\w+$/,"/path").replace("/path","").toLowerCase();
    args=i<0?"":text.slice(i+1).trim();
  }
  return{chatId:m.chat?.id,userId:m.from?.id,text,command,args};
}

async function kvText(env,key){return String(await env.MINISKYNET_KV.get(key)||"").trim()}
async function kvGet(env,key,fallback){const raw=await env.MINISKYNET_KV.get(key);if(!raw)return fallback;try{return JSON.parse(raw)}catch{return fallback}}
async function kvPut(env,key,value){await env.MINISKYNET_KV.put(key,JSON.stringify(value,null,2))}
async function arr(env,key){const v=await kvGet(env,key,{[key]:[]});return Array.isArray(v?.[key])?v[key]:[]}
async function saveArr(env,key,items,limit=100){await kvPut(env,key,{[key]:items.slice(-limit)})}

async function config(env){
  return{
    telegram:String(env.TELEGRAM_BOT_TOKEN||"").trim()||await kvText(env,"config:TELEGRAM_BOT_TOKEN"),
    owner:String(env.TELEGRAM_ALLOWED_USER_ID||"").trim()||await kvText(env,"config:TELEGRAM_ALLOWED_USER_ID"),
    gh:String(env.GITHUB_TOKEN||"").trim()||await kvText(env,"config:GITHUB_TOKEN"),
    repo:String(env.GITHUB_REPO||"").trim()||await kvText(env,"config:GITHUB_REPO")||DEFAULT_REPO,
    branch:String(env.GITHUB_BRANCH||"").trim()||await kvText(env,"config:GITHUB_BRANCH")||DEFAULT_BRANCH,
    worker:String(env.WORKER_URL||"").trim()||await kvText(env,"config:WORKER_URL")||DEFAULT_WORKER_URL,
    model:String(env.OPENROUTER_MODEL_CHEAP||"").trim()||await kvText(env,"config:OPENROUTER_MODEL_CHEAP")||"openai/gpt-4o-mini"
  };
}
function ownerOk(c,userId){return!c.owner||String(userId||"")===String(c.owner)}
async function tg(c,method,body){
  if(!c.telegram)throw new Error("TELEGRAM_BOT_TOKEN missing");
  const r=await fetch(`https://api.telegram.org/bot${c.telegram}/${method}`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
  return r.json().catch(()=>({}));
}
async function send(c,chatId,text){if(chatId)await tg(c,"sendMessage",{chat_id:chatId,text:clip(text)})}

const b64d=x=>new TextDecoder("utf-8").decode(Uint8Array.from(atob(String(x||"").replace(/\n/g,"")),ch=>ch.charCodeAt(0)));
function b64e(x){const b=new TextEncoder().encode(String(x||""));let s="";for(let i=0;i<b.length;i+=0x8000)s+=String.fromCharCode(...b.slice(i,i+0x8000));return btoa(s)}
const pathUrl=p=>clean(p).split("/").map(encodeURIComponent).join("/");

async function readFile(c,path){
  const p=safe(path);if(!p)throw new Error("unsafe path");
  const headers={accept:"application/vnd.github+json","user-agent":"MiniSkynet-v5"};
  if(c.gh)headers.authorization=`Bearer ${c.gh}`;
  const r=await fetch(`https://api.github.com/repos/${c.repo}/contents/${pathUrl(p)}?ref=${encodeURIComponent(c.branch)}`,{headers});
  const d=await r.json().catch(()=>({}));
  if(!r.ok)throw new Error(`GitHub ${r.status}: ${d.message||"request failed"}`);
  if(Array.isArray(d)||!d.content)throw new Error("not a text file");
  return{path:p,sha:d.sha||"",size:d.size||0,content:b64d(d.content)};
}
async function writeFile(c,path,sha,content,message){
  if(!c.gh)throw new Error("GITHUB_TOKEN missing");
  const p=safe(path);if(!p)throw new Error("unsafe path");
  const r=await fetch(`https://api.github.com/repos/${c.repo}/contents/${pathUrl(p)}`,{method:"PUT",headers:{accept:"application/vnd.github+json","content-type":"application/json","user-agent":"MiniSkynet-v5",authorization:`Bearer ${c.gh}`},body:JSON.stringify({message,content:b64e(content),sha,branch:c.branch})});
  const d=await r.json().catch(()=>({}));
  if(!r.ok)throw new Error(`GitHub write ${r.status}: ${d.message||"request failed"}`);
  return{commit_sha:d?.commit?.sha||"",content_sha:d?.content?.sha||""};
}
function mainFromWrangler(s){const m=String(s||"").match(/^main\s*=\s*["']([^"']+)["']/m);if(!m)return null;const rel=clean(m[1]);return rel.startsWith("cloudflare/")?rel:`cloudflare/${rel}`}
async function activeTarget(c){const wr=await readFile(c,"cloudflare/wrangler.toml");const main=mainFromWrangler(wr.content);if(!main)throw new Error("wrangler main not found");return{main,file:await readFile(c,main)}}
function findProp(list,key){const k=String(key||"").trim();return list.find(p=>p.id===k||String(p.id||"").startsWith(k))}

function health(){return{ok:true,version:VERSION,core:"v5-clean",runtime:"single-file",onion_imports:false,proposal_fsm:true,github_write:"confirm-only",verification:"proposal-specific",markers:SELF_APPLY_MARKERS}}
function help(){
  return["/start /help /status",`Version: ${VERSION}`,"","Core:","/self /self_set текст","/goals /goal_add текст","/plan /plan_set шаг1 | шаг2","/tasks /addtask текст /task_done n /next","/memory /memory_score","/think текст","","Repo:","/repo_config /repo_file path /repo_scan /active_target","","Self-apply:","/propose текст — сам готовит draft/check","/apply_confirm id — единственная команда записи в GitHub","/post_apply_verify id — проверяет конкретный результат","/proposals /show id /reject id /proposals_clean","/code_preview id /code_show id /apply_check id /apply_status id","","Markers:",...SELF_APPLY_MARKERS.map(x=>`- marker: ${x}`)].join("\n");
}

async function getSelf(env){return kvGet(env,"self",{text:"Я MiniSkynet Core v5 — личный инженерный агент Сергея. Читаю repo перед изменениями и пишу в GitHub только после /apply_confirm.",updated_at:now()})}
async function getGoals(env){return kvGet(env,"goals",{goals:["Быть личным инженерным агентом Сергея","Читать repo перед изменениями","Делать proposal → draft → apply → verify","Не возвращаться к onion/layer hell"],updated_at:now()})}
async function getPlan(env){return kvGet(env,"plan",{steps:["Проверить Core v5","Стабилизировать proposal/apply/verify","Вернуть нормальный think/dialog","Расширять реальные инженерные действия"],updated_at:now()})}

function markerRange(src){const start=src.indexOf("const SELF_APPLY_MARKERS=[");if(start<0)return null;const end=src.indexOf("];",start);return end>start?{start,end,block:src.slice(start,end+2)}:null}
function hasMarker(src,marker){const r=markerRange(src);return!!(r&&r.block.includes(JSON.stringify(marker)))}
function addMarker(src,marker){
  const r=markerRange(src);if(!r)throw new Error("SELF_APPLY_MARKERS block not found");
  if(hasMarker(src,marker))return{changed:false,content:src};
  return{changed:true,content:src.slice(0,r.end)+`  ${JSON.stringify(marker)},\n`+src.slice(r.end)};
}
function markerFromRequest(req){
  let t=String(req||"").trim().replace(/^добавить\s+/i,"").replace(/^add\s+/i,"").replace(/\s+в\s+help$/i,"").replace(/\s+in\s+help$/i,"").trim();
  return(t||"custom marker").slice(0,90);
}
function planOp(req){
  const t=String(req||"");
  if(/marker|маркер|help|verify|pipeline|confirm|development|self/i.test(t)){
    const marker=markerFromRequest(t);
    return{type:"add_marker",marker,expected:`- marker: ${marker}`,summary:`Добавить marker в /help: ${marker}`};
  }
  return{type:"manual",summary:"Core v5 auto-apply сейчас безопасно умеет только help markers."};
}
function sourceHelp(src){const r=markerRange(src);let markers=[];if(r)markers=[...r.block.matchAll(/"([^"]+)"/g)].map(m=>m[1]);return["Markers:",...markers.map(x=>`- marker: ${x}`)].join("\n")}
function buildDraft(p,file){
  const op=p.operation||planOp(p.request||p.title);
  if(op.type!=="add_marker")return{ok:false,reason:op.summary};
  const patch=addMarker(file.content,op.marker);
  if(!patch.changed)return{ok:true,already:true,summary:`Marker уже есть: ${op.marker}`,op};
  return{ok:true,already:false,op,draft:{target:file.path,sha:file.sha,new_content:patch.content,summary:op.summary,expected:op.expected,marker:op.marker,risk:"low",created_at:now()}};
}
async function prepare(c,p){
  const a=await activeTarget(c);p.target_file=a.file.path;p.operation=planOp(p.request);p.repo_evidence={read_at:now(),path:a.file.path,sha:a.file.sha,size:a.file.size};
  const d=buildDraft(p,a.file);
  if(!d.ok){p.state="blocked";p.blocked_reason=d.reason;return{mode:"blocked",reason:d.reason}}
  if(d.already){p.state="already_applied";p.marker=d.op.marker;p.expected=d.op.expected;return{mode:"already",summary:d.summary}}
  p.state="ready_for_confirm";p.marker=d.draft.marker;p.expected=d.draft.expected;p.code_draft=d.draft;p.check={ok:true,rule:"deterministic_marker_add",checked_at:now()};
  return{mode:"ready",draft:d.draft};
}
async function freshDraft(c,p){
  const a=await activeTarget(c);
  const stale=!p.code_draft||p.code_draft.target!==a.file.path||p.code_draft.sha!==a.file.sha;
  if(!stale)return{active:a,rebuilt:false,already:false};
  const d=buildDraft(p,a.file);
  if(!d.ok){p.state="blocked";p.blocked_reason=d.reason;return{active:a,rebuilt:true,blocked:true,reason:d.reason}}
  if(d.already){p.state="already_applied";p.marker=d.op.marker;p.expected=d.op.expected;return{active:a,rebuilt:true,already:true,summary:d.summary}}
  p.state="ready_for_confirm";p.target_file=a.file.path;p.marker=d.draft.marker;p.expected=d.draft.expected;p.code_draft=d.draft;p.rebuilt_at=now();
  return{active:a,rebuilt:true,already:false};
}
async function verify(c,p){
  const a=await activeTarget(c);
  const markerOk=p.marker?hasMarker(a.file.content,p.marker):false;
  const helpOk=p.expected?sourceHelp(a.file.content).includes(p.expected):false;
  return{ok:markerOk&&helpOk,marker_ok:markerOk,help_ok:helpOk,marker:p.marker||"",expected:p.expected||"",file:a.file.path,sha:a.file.sha,checked_at:now()};
}

async function handle(env,c,m){
  const{chatId,command,args}=m;
  if(command==="/start")return send(c,chatId,`✅ MiniSkynet Core v5 online.\nversion: ${VERSION}\n/help — команды`);
  if(command==="/help")return send(c,chatId,help());
  if(command==="/status"){const tasks=await arr(env,"tasks"),mem=await arr(env,"memories"),props=await arr(env,"proposals");return send(c,chatId,["📡 MiniSkynet Core v5 status",`- version: ${VERSION}`,"- runtime: single-file flat core","- router: strict","- proposal FSM: active","- GitHub write: /apply_confirm only","- verification: proposal-specific",`- tasks: active=${tasks.filter(t=>t.status!=="done").length}, done=${tasks.filter(t=>t.status==="done").length}`,`- memory: ${mem.length}`,`- proposals: ${props.length}`,`- model: ${c.model}`].join("\n"))}
  if(command==="/health_check"||command==="/deploy_check")return send(c,chatId,`🩺 Health check v5:\n- local version: ${VERSION}\n- local runtime: PASS ✅\n- markers: ${SELF_APPLY_MARKERS.length}`);
  if(command==="/self")return send(c,chatId,`🧠 Self:\n${(await getSelf(env)).text}\n\nИзменить: /self_set текст`);
  if(command==="/self_set"){await kvPut(env,"self",{text:args,updated_at:now()});return send(c,chatId,"✅ Self обновлён.")}
  if(command==="/goals")return send(c,chatId,"🎯 Goals:\n"+(await getGoals(env)).goals.map((g,i)=>`${i+1}. ${g}`).join("\n"));
  if(command==="/goal_add"){const g=await getGoals(env);g.goals.push(args);g.updated_at=now();await kvPut(env,"goals",g);return send(c,chatId,"✅ Goal добавлена.")}
  if(command==="/plan")return send(c,chatId,"🗺 Plan:\n"+(await getPlan(env)).steps.map((s,i)=>`${i+1}. ${s}`).join("\n"));
  if(command==="/plan_set"){await kvPut(env,"plan",{steps:args.split("|").map(x=>x.trim()).filter(Boolean),updated_at:now()});return send(c,chatId,"✅ Plan обновлён.")}
  if(command==="/tasks"){const t=(await arr(env,"tasks")).filter(x=>x.status!=="done").slice(0,12);return send(c,chatId,t.length?"📋 Active tasks:\n"+t.map((x,i)=>`${i+1}. ${x.id} p${x.p||4}: ${x.text}`).join("\n"):"Задач нет.")}
  if(command==="/addtask"){const t=await arr(env,"tasks");const task={id:uid("task"),text:args,p:4,status:"todo",created_at:now()};t.push(task);await saveArr(env,"tasks",t,120);return send(c,chatId,`✅ Добавил ${task.id}`)}
  if(command==="/task_done"){const t=await arr(env,"tasks"),active=t.filter(x=>x.status!=="done"),task=active[(parseInt(args,10)||1)-1];if(!task)return send(c,chatId,"Не нашёл задачу.");task.status="done";task.done_at=now();await saveArr(env,"tasks",t,120);return send(c,chatId,`✅ Закрыл: ${task.text}`)}
  if(command==="/next"){const t=(await arr(env,"tasks")).filter(x=>x.status!=="done")[0],p=await getPlan(env);return send(c,chatId,`⏭ Next:\n${t?`Источник: tasks\nШаг: ${t.text}`:`Источник: plan\nШаг: ${p.steps[0]||"нет"}`}`)}
  if(command==="/memory"){const mem=await arr(env,"memories");return send(c,chatId,mem.length?"🧠 Memory:\n"+mem.slice(-10).map(x=>`- [${x.type||"note"}/${x.score||0}] ${x.text}`).join("\n"):"Память пустая.")}
  if(command==="/memory_score"){const mem=await arr(env,"memories"),avg=mem.length?Math.round(mem.reduce((a,b)=>a+(b.score||0),0)/mem.length):0;return send(c,chatId,`🧠 Memory Quality:\n- всего: ${mem.length}\n- avg: ${avg}/100`)}
  if(command==="/think"||!command){return send(c,chatId,"Think в Core v5 включим следующим шагом. Сейчас стабилизирован чистый контур proposal/apply/verify.")}
  if(command==="/repo_config")return send(c,chatId,`🔎 Repo config:\n- repo: ${c.repo}\n- branch: ${c.branch}\n- GitHub token: ${c.gh?"есть ✅":"нет ⛔"}`);
  if(command==="/repo_file"){const f=await readFile(c,args);return send(c,chatId,`📄 ${f.path}\n- size: ${f.size}\n- sha: ${f.sha.slice(0,12)}\n\n${clip(f.content,1400)}`)}
  if(command==="/repo_scan"){const out=[];for(const p of["cloudflare/wrangler.toml","cloudflare/src/index-v4.js"]){try{const f=await readFile(c,p);out.push(`✅ ${p} size=${f.size} sha=${f.sha.slice(0,10)}`)}catch(e){out.push(`❌ ${p}: ${e.message}`)}}return send(c,chatId,"🧭 Repo scan:\n"+out.join("\n"))}
  if(command==="/active_target"){const a=await activeTarget(c);return send(c,chatId,`🎯 Active target:\n- wrangler main: ${a.main}\n- effective: ${a.file.path}\n- sha: ${a.file.sha.slice(0,12)}\n- size: ${a.file.size}`)}
  if(command==="/propose"){const props=await arr(env,"proposals");const p={id:uid("prop"),state:"proposed",title:clip(args,90),request:args,created_at:now()};props.push(p);try{const r=await prepare(c,p);await saveArr(env,"proposals",props,80);if(r.mode==="blocked")return send(c,chatId,`📦 Proposal ${p.id}\n⛔ blocked\nПричина: ${r.reason}\n/show ${p.id}`);if(r.mode==="already")return send(c,chatId,`📦 Proposal ${p.id}\n✅ Уже применено.\n- ${r.summary}\nApply не нужен.`);return send(c,chatId,`📦 Proposal ${p.id}\n✅ repo read: ok\n✅ draft: ok\n✅ apply_check: ok\n- target: ${p.code_draft.target}\n- expected: ${p.expected}\n\nФинальная запись в GitHub требует одну команду:\n/apply_confirm ${p.id}`)}catch(e){p.state="blocked";p.blocked_reason=String(e.message||e);await saveArr(env,"proposals",props,80);return send(c,chatId,`📦 Proposal ${p.id}\n⛔ blocked\nПричина: ${p.blocked_reason}\n/show ${p.id}`)}}
  if(command==="/proposals"){const props=await arr(env,"proposals");return send(c,chatId,props.length?"📦 Proposals:\n"+props.slice(-12).map(p=>`- ${p.id} [${p.state}] ${p.title||p.request}`).join("\n"):"Proposals нет.")}
  if(command==="/show"){const p=findProp(await arr(env,"proposals"),args);return send(c,chatId,p?`📦 ${p.id}\nstate: ${p.state}\nrequest: ${p.request||"—"}\ntarget: ${p.target_file||p.code_draft?.target||"—"}\nexpected: ${p.expected||"—"}\nmarker: ${p.marker||"—"}\napplied: ${p.apply_result?.commit_sha||"no"}\nverified: ${p.verify?.ok?"yes ✅":"no"}`:"Не нашёл proposal.")}
  if(command==="/reject"){const props=await arr(env,"proposals"),p=findProp(props,args);if(!p)return send(c,chatId,"Не нашёл proposal.");p.state="rejected";await saveArr(env,"proposals",props,80);return send(c,chatId,`✅ rejected: ${p.id}`)}
  if(command==="/code_preview"||command==="/apply_check"){const props=await arr(env,"proposals"),p=findProp(props,args);if(!p)return send(c,chatId,"Не нашёл proposal.");const f=await freshDraft(c,p);await saveArr(env,"proposals",props,80);if(f.already)return send(c,chatId,`✅ Уже применено: ${f.summary}\nApply не нужен.`);if(f.blocked)return send(c,chatId,`⛔ blocked: ${f.reason}`);const changes=p.code_draft.new_content!==f.active.file.content;return send(c,chatId,`🔐 Apply check ${p.id}\n- state: ${p.state}\n- target: ${f.active.file.path}\n- expected: ${p.expected}\n- rebuilt: ${f.rebuilt?"yes ✅":"no"}\n- changes: ${changes?"yes ✅":"no ⛔"}\n${changes?`Next: /apply_confirm ${p.id}`:"Blocker: no changes"}`)}
  if(command==="/code_show"){const p=findProp(await arr(env,"proposals"),args);return send(c,chatId,p?.code_draft?`🧬 Code draft ${p.id}\nsummary: ${p.code_draft.summary}\ntarget: ${p.code_draft.target}\nexpected: ${p.code_draft.expected}\n\n${clip(p.code_draft.new_content,2600)}`:"Code draft нет.")}
  if(command==="/apply_confirm"){const props=await arr(env,"proposals"),p=findProp(props,args);if(!p)return send(c,chatId,"Не нашёл proposal.");const f=await freshDraft(c,p);if(f.already){await saveArr(env,"proposals",props,80);return send(c,chatId,`✅ Уже применено: ${f.summary}\nApply не нужен.`)}if(f.blocked){await saveArr(env,"proposals",props,80);return send(c,chatId,`⛔ blocked: ${f.reason}`)}if(!p.code_draft||p.code_draft.new_content===f.active.file.content)return send(c,chatId,"⛔ no-op или нет draft. Apply blocked.");const res=await writeFile(c,f.active.file.path,f.active.file.sha,p.code_draft.new_content,`MiniSkynet v5 apply ${p.id}: ${p.code_draft.summary}`);p.state="applied";p.applied_at=now();p.apply_result={path:f.active.file.path,old_sha:f.active.file.sha,content_sha:res.content_sha,commit_sha:res.commit_sha,rebuilt:f.rebuilt};await saveArr(env,"proposals",props,80);return send(c,chatId,`✅ Applied:\n- proposal: ${p.id}\n- file: ${f.active.file.path}\n- expected: ${p.expected}\n- commit: ${res.commit_sha}\n\nПосле deploy: /post_apply_verify ${p.id}`)}
  if(command==="/post_apply_verify"){const props=await arr(env,"proposals"),p=findProp(props,args);if(!p)return send(c,chatId,"Не нашёл proposal.");const v=await verify(c,p);p.verify=v;p.state=v.ok?"verified":"partial";await saveArr(env,"proposals",props,80);return send(c,chatId,`🧪 Post-apply verify ${p.id}\n- state: ${p.state}\n- expected: ${v.expected}\n- marker: ${v.marker}\n- checked file: ${v.file}\n- marker in source: ${v.marker_ok?"yes ✅":"no ⛔"}\n- expected in generated help: ${v.help_ok?"yes ✅":"no ⛔"}\n- result: ${v.ok?"PASS ✅":"PARTIAL/FAIL ⚠️"}`)}
  if(command==="/apply_status"){const p=findProp(await arr(env,"proposals"),args);return send(c,chatId,p?`🚀 Apply status ${p.id}\n- state: ${p.state}\n- expected: ${p.expected||"—"}\n- applied: ${p.applied_at||"no"}\n- commit: ${p.apply_result?.commit_sha||"—"}\n- verified: ${p.verify?.ok?"yes ✅":"no"}`:"Не нашёл proposal.")}
  if(command==="/proposals_clean"){const props=await arr(env,"proposals"),keep=props.filter(p=>["ready_for_confirm","applied","verified"].includes(p.state)).slice(-30);await saveArr(env,"proposals",keep,80);return send(c,chatId,`🧹 Proposals cleaned: было ${props.length}, стало ${keep.length}`)}
  return send(c,chatId,`Не знаю команду ${command}. /help — список. Модель не вызываю.`);
}

async function telegram(request,env){
  const c=await config(env);
  const msg=parse(await request.json().catch(()=>null));
  if(!msg)return out({ok:true});
  if(!ownerOk(c,msg.userId)){await send(c,msg.chatId,"⛔ Доступ закрыт.");return out({ok:true,denied:true})}
  try{
    if(msg.command&&!CMDS.has(msg.command)){await send(c,msg.chatId,`Не знаю команду ${msg.command}. /help — список. Модель не вызываю.`);return out({ok:true,unknown_command:true,version:VERSION})}
    await handle(env,c,msg);
    return out({ok:true,command:msg.command||"text",version:VERSION});
  }catch(e){
    await send(c,msg.chatId,`❌ Core v5 error: ${clip(e.message||e,1000)}`);
    return out({ok:false,error:String(e.message||e),version:VERSION},500);
  }
}

export default{
  async fetch(request,env){
    const url=new URL(request.url);
    if(url.pathname==="/"||url.pathname==="/health")return out(health());
    if(url.pathname==="/telegram"&&request.method==="POST")return telegram(request,env);
    return out({ok:false,error:"not found",version:VERSION},404);
  },
  async scheduled(){}
};
