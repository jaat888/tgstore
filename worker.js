// Telegram storage - Cloudflare Worker version (free plan, D1 database, no card needed).
// Same project / share links / admin password / bots as the Python app; old data is restored
// from the pinned manifest in your Telegram channel (or from a "Download backup" file).
//
// Bindings:  DB (D1 database), SQLDB (Durable Object class ProjDB - only needed for project SQL, see wrangler.toml)
// Secrets / variables (all optional):
//   CHANNEL_ID, BOT_TOKEN, ADMIN_PASSWORD  -> auto setup + restore on first visit
//   RESET_PASSWORD (min 6)  -> type it on the login page: it becomes the new admin password. Remove it afterwards.
//   ADMIN_PASSWORD also works on the login page while it is set (stored password stays unchanged).
//   TG_API (default https://api.telegram.org), CHUNK_MB (18), MAX_FILE_GB (25),
//   MAX_CHUNKS (22: chunks one response may stream, free plan = 50 subrequests),
//   SQL_MAX_ROWS (50000), SQL_SYNC_SECS (20: how soon a changed SQL db is backed up to Telegram),
//   HASH_UPLOADS=1 (Worker hashes uploads itself; default: browser/client sends sha), AUTO_BACKUP=0 (off)

const SW_JS = "// tgstore download helper: one browser download = many Range requests (each one under the free-plan limit).\nself.addEventListener('install', function () { self.skipWaiting(); });\nself.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });\nself.addEventListener('fetch', function (e) {\n  var u = new URL(e.request.url);\n  if (u.origin === self.location.origin && u.pathname === '/xdl') e.respondWith(big(u));\n});\nasync function big(u) {\n  var t = u.searchParams.get('u') || '', name = u.searchParams.get('n') || 'download';\n  if (!/^\\/(dl|s)\\/[^\\/\\\\]/.test(t) || t.indexOf('//') >= 0) return new Response('bad link', { status: 400 });\n  var h;\n  try { h = await fetch(t, { headers: { Range: 'bytes=0-0' } }); } catch (x) { return new Response('network error', { status: 502 }); }\n  if (h.status !== 206 && h.status !== 200) return new Response('error ' + h.status, { status: h.status });\n  var m = /\\/(\\d+)$/.exec(h.headers.get('Content-Range') || '');\n  var size = m ? +m[1] : +h.headers.get('Content-Length');\n  var type = h.headers.get('Content-Type') || 'application/octet-stream';\n  try { if (h.body) h.body.cancel(); } catch (x) {}\n  var pos = 0, reader = null, fails = 0;\n  var stream = new ReadableStream({\n    async pull(c) {\n      for (;;) {\n        if (pos >= size) { c.close(); return; }\n        try {\n          if (!reader) {\n            var r = await fetch(t, { headers: { Range: 'bytes=' + pos + '-' } });\n            if (r.status !== 206 || !r.body) throw new Error('HTTP ' + r.status);\n            reader = r.body.getReader();\n          }\n          var x = await reader.read();\n          if (x.done) { reader = null; continue; }\n          pos += x.value.length; fails = 0;\n          c.enqueue(x.value);\n          return;\n        } catch (err) {\n          reader = null;\n          if (++fails > 8) { c.error(err); return; }\n          await new Promise(function (z) { setTimeout(z, 1000 * fails); });\n        }\n      }\n    },\n    cancel() { if (reader) reader.cancel().catch(function () {}); }\n  });\n  return new Response(stream, { headers: {\n    'Content-Type': type,\n    'Content-Length': String(size),\n    'Content-Disposition': \"attachment; filename*=UTF-8''\" + encodeURIComponent(name),\n    'Cache-Control': 'no-store'\n  } });\n}\n";
const DASH_HTML = "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><title>Telegram Storage</title>\n<style>\n:root{--bg:#f4f5f7;--card:#fff;--tx:#1b1f24;--mut:#6a737d;--bd:#e3e6ea;--ac:#2a7de1;--ok:#1a9d55;--warn:#d98a00;--bad:#d1383d}\n@media(prefers-color-scheme:dark){:root{--bg:#0f1318;--card:#181e26;--tx:#e7ebf0;--mut:#8b96a3;--bd:#2a323d;--ac:#4c9aff;--ok:#38c172;--warn:#f0a928;--bad:#f0605f}}\n*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--tx);font:15px/1.45 system-ui,sans-serif}\n.wrap{max-width:760px;margin:0 auto;padding:14px}\nheader{display:flex;align-items:center;justify-content:space-between;margin:6px 0 14px}\nh1{font-size:19px;margin:0}h2{font-size:16px;margin:0 0 10px}\n.card{background:var(--card);border:1px solid var(--bd);border-radius:14px;padding:14px;margin-bottom:14px}\n.grid{display:grid;grid-template-columns:repeat(2,1fr);gap:10px}\n.stat{background:var(--card);border:1px solid var(--bd);border-radius:12px;padding:10px 12px}\n.stat b{display:block;font-size:20px}.stat span{color:var(--mut);font-size:12px}\n.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.sp{justify-content:space-between}\n.item{border-top:1px solid var(--bd);padding:10px 0}.item:first-of-type{border-top:0}\n.mut{color:var(--mut);font-size:13px}.chip{display:inline-block;font-size:11px;border-radius:99px;padding:1px 8px;border:1px solid var(--bd)}\n.ok{color:var(--ok);border-color:var(--ok)}.warn{color:var(--warn);border-color:var(--warn)}.bad{color:var(--bad);border-color:var(--bad)}\ninput,select{width:100%;padding:10px;border:1px solid var(--bd);border-radius:10px;background:var(--bg);color:var(--tx);font:inherit}\nbutton{padding:8px 12px;border:1px solid var(--bd);border-radius:10px;background:var(--card);color:var(--tx);font:inherit;cursor:pointer}\nbutton.p{background:var(--ac);border-color:var(--ac);color:#fff}button.d{color:var(--bad)}button:disabled{opacity:.5}\n.link{display:flex;gap:6px;margin-top:6px}.link input{font:12px ui-monospace,monospace}\n.bar{height:8px;background:var(--bd);border-radius:6px;overflow:hidden;margin-top:8px}.bar i{display:block;height:100%;background:var(--ac);width:0}\n#toast{position:fixed;left:50%;bottom:20px;transform:translateX(-50%);background:#222;color:#fff;padding:10px 16px;border-radius:10px;display:none;max-width:90%;z-index:9}\n.fname{word-break:break-all}label{display:block;margin:10px 0 4px;font-size:13px;color:var(--mut)}\n</style></head><body><div class=\"wrap\" id=\"app\"></div><div id=\"toast\"></div>\n<script>\nlet ST=null,FILTER=\"\",FILES=[],UP=null,URLJOB=null,PAUSED=false;\nconst $=s=>document.querySelector(s);\nconst esc=s=>String(s??\"\").replace(/[&<>\"']/g,c=>({\"&\":\"&amp;\",\"<\":\"&lt;\",\">\":\"&gt;\",'\"':\"&quot;\",\"'\":\"&#39;\"}[c]));\nconst fmt=n=>{const u=[\"B\",\"KB\",\"MB\",\"GB\",\"TB\"];let i=0;while(n>=1024&&i<4){n/=1024;i++}return (i?n.toFixed(1):n)+\" \"+u[i]};\nconst ago=s=>s==null?\"never\":s<90?s+\"s ago\":s<5400?Math.round(s/60)+\" min ago\":Math.round(s/3600)+\" h ago\";\nfunction toast(m,bad){const t=$(\"#toast\");t.textContent=m;t.style.background=bad?\"#b3282d\":\"#222\";t.style.display=\"block\";clearTimeout(toast.h);toast.h=setTimeout(()=>t.style.display=\"none\",bad?6000:3000)}\nasync function api(path,body){\n  const r=await fetch(path,{method:body===undefined?\"GET\":\"POST\",headers:{\"X-Dash\":\"1\",\"Content-Type\":\"application/json\"},body:body===undefined?undefined:JSON.stringify(body)});\n  let j={};try{j=await r.json()}catch(e){}\n  if(!r.ok)throw new Error(j.error||(\"HTTP \"+r.status));return j}\nasync function act(path,body,ok){try{const j=await api(path,body);if(j.warnings&&j.warnings.length)toast(\"Done, but: \"+j.warnings.join(\"; \"),true);else if(ok)toast(ok);await load();return j}catch(e){toast(e.message,true)}}\nasync function load(){ST=await api(\"/api/state\");if(ST.authed){FILES=await api(\"/api/files\"+(FILTER?\"?project=\"+FILTER:\"\"))}render()}\nfunction render(){\n  const a=$(\"#app\");\n  if(!ST.configured){a.innerHTML=`<header><h1>Telegram Storage</h1></header><div class=\"card\"><h2>First setup</h2>\n  <p class=\"mut\">Enter these once. If the server disk was ever reset, enter the <b>same channel id + any bot token</b> again and everything (bots, projects, links, files) is restored from the channel backup.</p>\n  <label>Admin password (empty = default: admin, change it later)</label><input id=\"s_pw\" type=\"password\" autocomplete=\"new-password\" placeholder=\"admin\">\n  <label>Channel ID (like -1001234567890)</label><input id=\"s_ch\" inputmode=\"text\">\n  <label>First bot token (from @BotFather)</label><input id=\"s_tk\" autocomplete=\"off\">\n  <p><button class=\"p\" onclick=\"doSetup()\">Start</button></p>\n  <label style=\"margin-top:18px\">Or restore from a backup file (no token needed)</label><input id=\"s_bf\" type=\"file\">\n  <p><button onclick=\"doRestore()\">Restore from file</button></p></div>`;return}\n  if(!ST.authed){a.innerHTML=`<header><h1>Telegram Storage</h1></header><div class=\"card\"><h2>Login</h2>\n  <label>Admin password</label><input id=\"l_pw\" type=\"password\" onkeydown=\"if(event.key=='Enter')doLogin()\">\n  <p><button class=\"p\" onclick=\"doLogin()\">Login</button></p></div>`;return}\n  const t=ST.totals,on=ST.bots.filter(b=>b.enabled).length;\n  const dl=(ST.pending_del||ST.del_fail)?`<span class=\"chip bad\">${ST.pending_del} old messages not deleted${ST.del_err?\": \"+esc(ST.del_err):\"\"} - give the bot 'Delete messages' right, then Clean up</span> `:\"\";\n  const bk=dl+(ST.backup_ok===false?`<span class=\"chip bad\">backup failing</span>`:ST.backed_rev===ST.rev?`<span class=\"chip ok\">backup up to date</span>`:`<span class=\"chip warn\">backup ${ago(ST.backup_age)}</span>`);\n  a.innerHTML=`<header><h1>Telegram Storage</h1><div class=\"row\">${bk}<button onclick=\"doLogout()\">Logout</button></div></header>\n  ${ST.default_pw?`<div class=\"card\" style=\"border-color:var(--bad)\"><b style=\"color:var(--bad)\">Default password \"admin\" is still active.</b>\n   <p class=\"mut\">Anyone who finds this link can try it. Change it now.</p><button class=\"p\" onclick=\"chPw()\">Change password</button></div>`:\"\"}\n  <div class=\"grid\" style=\"margin-bottom:14px\">\n   <div class=\"stat\"><b>${t.files}</b><span>files</span></div><div class=\"stat\"><b>${fmt(t.bytes)}</b><span>stored</span></div>\n   <div class=\"stat\"><b>${on}/${ST.bots.length}</b><span>bots enabled</span></div><div class=\"stat\"><b>${ST.projects.length}</b><span>projects</span></div></div>\n  <div class=\"card\"><div class=\"row sp\"><h2>Bots (${ST.bots.length})</h2></div>\n  ${ST.bots.map(b=>`<div class=\"item\"><div class=\"row sp\"><div><b>@${esc(b.name)}</b> <span class=\"mut\">id ${esc(b.id)}</span><br><span class=\"mut\">channel ${esc(b.channel)}${b.channel===ST.channel?\" (main)\":\"\"}</span><br>\n   <span class=\"mut\">${b.chunks} chunks · ${fmt(b.bytes)} · sent ${b.ok}${b.err?` · errors ${b.err}`:\"\"}</span>${b.last_err?`<br><span class=\"mut\" style=\"color:var(--bad)\">${esc(b.last_err)}</span>`:\"\"}</div>\n   <div>${b.cooling?`<span class=\"chip warn\">resting ${b.cooling}s</span> `:\"\"}<span class=\"chip ${b.enabled?\"ok\":\"bad\"}\">${b.enabled?\"enabled\":\"disabled\"}</span></div></div>\n   <div class=\"row\" style=\"margin-top:8px\"><button onclick=\"botToggle('${b.id}')\">${b.enabled?\"Disable\":\"Enable\"}</button>\n   <button onclick=\"botToken('${b.id}')\">Update token</button><button class=\"d\" onclick=\"botRemove('${b.id}')\">Remove</button></div></div>`).join(\"\")}\n  <div class=\"item\"><label>Add bot (token from @BotFather) - no limit</label><input id=\"nb\" autocomplete=\"off\">\n  <label>Channel id for this bot (empty = main channel ${esc(ST.channel)})</label>\n  <div class=\"row\"><input id=\"nbc\" list=\"chl\" style=\"flex:1\" inputmode=\"text\" placeholder=\"-100...\"><button class=\"p\" onclick=\"botAdd()\">Add</button></div>\n  <datalist id=\"chl\">${ST.channels.map(c=>`<option value=\"${esc(c.id)}\">`).join(\"\")}</datalist>\n  <p class=\"mut\">Make the bot an admin of that channel first (Post + Pin messages). A new channel id here simply starts a new channel; files are spread over all channels.</p></div>\n  <p class=\"mut\">Token revoked in BotFather? Use <b>Update token</b> with the new token; stored files stay readable.</p></div>\n  <div class=\"card\"><h2>Channels (${ST.channels.length})</h2>\n  ${ST.channels.map(c=>`<div class=\"item\"><b>${esc(c.id)}</b> ${c.main?`<span class=\"chip ok\">main (manifest backup)</span>`:\"\"}<br>\n   <span class=\"mut\">${c.enabled}/${c.bots} bots enabled · ${c.chunks} chunks · ${fmt(c.bytes)}</span></div>`).join(\"\")}</div>\n  <div class=\"card\"><h2>Projects</h2>\n  ${ST.projects.length?ST.projects.map(p=>{const url=location.origin+\"/p/\"+p.key;return `<div class=\"item\"><div class=\"row sp\"><div><b>${esc(p.name)}</b><br><span class=\"mut\">${p.files} files · ${fmt(p.bytes)}</span>${p.db?`<br><span class=\"mut\">SQL db ${fmt(p.db.size)} · ${p.db.dirty?\"sync pending\":\"synced \"+ago(Math.max(Math.round(Date.now()/1000)-p.db.synced,0))}${p.db.error?` · <span style=\"color:var(--bad)\">${esc(p.db.error)}</span>`:\"\"}</span>`:\"\"}</div>\n   <button onclick=\"setFilter('${p.id}')\">Files</button></div>\n   <div class=\"link\"><input readonly value=\"${esc(url)}\" onclick=\"this.select()\"><button onclick=\"copy('${esc(url)}')\">Copy</button></div>\n   <div class=\"row\" style=\"margin-top:8px\"><button onclick=\"projRotate('${p.id}')\">New link</button><button class=\"d\" onclick=\"projDelete('${p.id}','${esc(p.name).replace(/'/g,\"\")}')\">Delete</button></div></div>`}).join(\"\"):`<p class=\"mut\">No project yet. Create one, then give its link to your app.</p>`}\n  <div class=\"item\"><div class=\"row\"><input id=\"np\" style=\"flex:1\" placeholder=\"New project name\"><button class=\"p\" onclick=\"projCreate()\">Create</button></div></div></div>\n  <div class=\"card\"><h2>Upload</h2>${ST.projects.length?`<select id=\"up_p\">${ST.projects.map(p=>`<option value=\"${p.id}\">${esc(p.name)}</option>`).join(\"\")}</select>\n  <div style=\"margin-top:8px\"><input id=\"up_f\" type=\"file\"></div><p><button class=\"p\" id=\"up_b\" onclick=\"upStart()\">Upload</button></p>\n  <div class=\"bar\"><i id=\"up_bar\"></i></div><div class=\"mut\" id=\"up_t\"></div>\n  <p class=\"mut\" style=\"margin-top:12px\">Parts of a file go up 3 at a time. Upload from a link is not in the Worker version.</p>`:`<p class=\"mut\">Create a project first.</p>`}</div>\n  <div class=\"card\"><h2>SQL</h2>${ST.projects.length?`<select id=\"q_p\">${ST.projects.map(p=>`<option value=\"${p.id}\">${esc(p.name)}</option>`).join(\"\")}</select>\n  <textarea id=\"q_s\" rows=\"4\" placeholder=\"SELECT name FROM sqlite_master\" style=\"width:100%;margin-top:8px;padding:10px;border:1px solid var(--bd);border-radius:10px;background:var(--bg);color:var(--tx);font:13px ui-monospace,monospace\"></textarea>\n  <div class=\"row\" style=\"margin-top:8px\"><button class=\"p\" onclick=\"sqlRun()\">Run</button><button onclick=\"sqlSync()\">Backup now</button></div><div id=\"q_o\" style=\"overflow:auto;margin-top:8px\"></div>\n  <p class=\"mut\" style=\"margin-top:8px\">Apps use POST /p/KEY/sql with {\"sql\":\"...\",\"params\":[...]}, {\"batch\":[...]} or {\"script\":\"...\"}. Changes are backed up to Telegram a few seconds later.</p>`:`<p class=\"mut\">Create a project first.</p>`}</div>\n  <div class=\"card\"><div class=\"row sp\"><h2>Files</h2><select id=\"flt\" style=\"width:auto\" onchange=\"setFilter(this.value)\"><option value=\"\">All projects</option>${ST.projects.map(p=>`<option value=\"${p.id}\" ${FILTER===p.id?\"selected\":\"\"}>${esc(p.name)}</option>`).join(\"\")}</select></div>\n  ${FILES.length?FILES.map(f=>{const pn=(ST.projects.find(p=>p.id===f.project)||{}).name||\"\";return `<div class=\"item\"><div class=\"fname\"><b>${esc(f.name)}</b></div>\n   <div class=\"mut\">${fmt(f.size)} · ${esc(pn)} · ${f.done?\"complete\":Math.round(f.stored/Math.max(f.size,1)*100)+\"% (unfinished)\"} · id ${esc(f.id)}</div>\n   <div class=\"row\" style=\"margin-top:6px\">${f.done?`<button onclick=\"bigDl('${esc(f.id)}')\">Download</button>`:\"\"}${f.done&&!f.share?`<button onclick=\"shareAct('${esc(f.id)}','get')\">Get public link</button>`:\"\"}${f.done&&f.share?`<button onclick=\"copyLink('${esc(f.id)}')\">Copy file link</button><button onclick=\"copyLink('${esc(f.id)}',1)\">Copy player link</button><button onclick=\"shareAct('${esc(f.id)}','off')\">Stop sharing</button>`:\"\"}<button class=\"d\" onclick=\"fileDel('${esc(f.id)}')\">Delete</button></div></div>`}).join(\"\"):`<p class=\"mut\">No files.</p>`}</div>\n  <div class=\"card\"><h2>Settings</h2><p class=\"mut\">Main channel ${esc(ST.channel)} · up ${ago(ST.uptime).replace(\" ago\",\"\")} · chunk ${ST.chunk_mb} MB · manifest rev ${ST.rev}</p>\n  <div class=\"row\"><button onclick=\"act('/api/backup',{},'Backup sent')\">Backup now</button><button onclick=\"dlBackup()\">Download backup</button><button onclick=\"act('/api/cleanup',{},'Clean up done')\">Clean up</button><button onclick=\"chPw()\">Change password</button></div></div>`}\nasync function doSetup(){try{const j=await api(\"/api/setup\",{password:$(\"#s_pw\").value,channel_id:$(\"#s_ch\").value,token:$(\"#s_tk\").value});\n  if(j.restored)toast(\"Backup found and restored. Login with your OLD password.\");else if(j.warnings.length)toast(\"Ready, but: \"+j.warnings.join(\"; \"),true);await load()}catch(e){toast(e.message,true)}}\nasync function doRestore(){const f=$(\"#s_bf\").files[0];if(!f)return toast(\"Choose the backup file first\",true);\n  try{const r=await fetch(\"/api/restore\",{method:\"POST\",headers:{\"X-Dash\":\"1\"},body:f});const j=await r.json().catch(()=>({}));\n    if(!r.ok)throw new Error(j.error||(\"HTTP \"+r.status));toast(\"Restored. Login with your OLD password.\");await load()}catch(e){toast(e.message,true)}}\nasync function dlBackup(){try{const r=await fetch(\"/api/backup/download\",{headers:{\"X-Dash\":\"1\"}});if(!r.ok)throw new Error(\"HTTP \"+r.status);\n  const b=await r.blob(),a=document.createElement(\"a\");a.href=URL.createObjectURL(b);a.download=\"tgstore-backup.json.gz\";document.body.appendChild(a);a.click();a.remove();\n  toast(\"Backup downloaded. Keep it private: it contains your bot tokens.\")}catch(e){toast(e.message,true)}}\nasync function doLogin(){try{await api(\"/api/login\",{password:$(\"#l_pw\").value});await load()}catch(e){toast(e.message,true)}}\nasync function doLogout(){await api(\"/api/logout\",{});await load()}\nconst botAdd=()=>act(\"/api/bot/add\",{token:$(\"#nb\").value.trim(),channel:$(\"#nbc\").value.trim()},\"Bot added\");\nconst botToggle=id=>act(\"/api/bot/toggle\",{id});\nfunction botToken(id){const t=prompt(\"New token for this bot (same bot only):\");if(t)act(\"/api/bot/token\",{id,token:t.trim()},\"Token updated\")}\nfunction botRemove(id){if(confirm(\"Remove this bot?\"))act(\"/api/bot/remove\",{id},\"Bot removed\")}\nconst projCreate=()=>act(\"/api/project/create\",{name:$(\"#np\").value},\"Project created\");\nfunction projRotate(id){if(confirm(\"Old link will stop working. Continue?\"))act(\"/api/project/rotate\",{id},\"New link ready\")}\nfunction projDelete(id,n){if(confirm(\"Delete project '\"+n+\"' and ALL its files?\"))act(\"/api/project/delete\",{id},\"Project deleted\")}\nconst pubLink=(t,n)=>location.origin+\"/s/\"+t+\"/\"+encodeURIComponent(n);\nfunction copyLink(id,pg){const f=FILES.find(x=>x.id===id);if(f&&f.share)copy(pg?location.origin+\"/v/\"+f.share:pubLink(f.share,f.name))}\nfunction shareAct(id,mode){if(mode===\"off\"&&!confirm(\"Stop sharing? The old link will stop working.\"))return;act(\"/api/file/share\",{id,mode},mode===\"off\"?\"Sharing switched off\":\"Public link ready\")}\nfunction fileDel(id){if(confirm(\"Delete this file?\"))act(\"/api/file/delete\",{id},\"File deleted\")}\nfunction setFilter(v){FILTER=v;load()}\nfunction copy(t){if(navigator.clipboard)navigator.clipboard.writeText(t).then(()=>toast(\"Link copied\"),()=>prompt(\"Copy:\",t));else prompt(\"Copy:\",t)}\nfunction chPw(){const o=prompt(\"Old password:\");if(!o)return;const n=prompt(\"New password (min 6):\");if(n)act(\"/api/password\",{old:o,new:n},\"Password changed\")}\nasync function sqlRun(){const o=$('#q_o');o.textContent='...';try{const j=await api('/api/sql',{project:$('#q_p').value,sql:$('#q_s').value});\n  if(!j.columns.length){o.textContent='OK, rows changed: '+j.rowcount;return}\n  const td='padding:3px 8px;border-bottom:1px solid var(--bd);text-align:left';\n  o.innerHTML='<table style=\"border-collapse:collapse;font:12px ui-monospace,monospace\"><tr>'+j.columns.map(c=>'<th style=\"'+td+'\">'+esc(c)+'</th>').join('')+'</tr>'+j.rows.map(r=>'<tr>'+r.map(v=>'<td style=\"'+td+'\">'+esc(v===null?'NULL':(v&&v.$blob)?'[blob]':v)+'</td>').join('')+'</tr>').join('')+'</table>'+(j.truncated?'<p class=\"mut\">result cut off</p>':'')}catch(e){o.textContent='';toast(e.message,true)}}\nasync function sqlSync(){try{const j=await api('/api/db/sync',{project:$('#q_p').value});toast(j.synced?'Backed up to Telegram':'Backup failed: '+(j.error||'?'),!j.synced)}catch(e){toast(e.message,true)}}\nasync function xdl(u,n){try{if(!('serviceWorker' in navigator))throw 0;await navigator.serviceWorker.register('/sw.js');await navigator.serviceWorker.ready;const a=document.createElement('a');a.href='/xdl?u='+encodeURIComponent(u)+'&n='+encodeURIComponent(n);a.download=n;document.body.appendChild(a);a.click();a.remove();toast('Download started')}catch(e){location.href=u}}\nfunction bigDl(id){const f=FILES.find(x=>x.id===id);if(f)xdl('/dl/'+id,f.name)}\nasync function upStart(){\n  const f=$(\"#up_f\").files[0],pid=$(\"#up_p\").value;if(!f)return toast(\"Choose a file first\",true);\n  if(ST.max_file&&f.size>ST.max_file)return toast(\"This file is bigger than the \"+fmt(ST.max_file)+\" limit\",true);\n  $(\"#up_b\").disabled=true;\n  const id=(\"w\"+Math.random().toString(36).slice(2,10)+Date.now().toString(36));\n  const sleep=ms=>new Promise(z=>setTimeout(z,ms));\n  const CH=ST.chunk_bytes||18*1048576,PAR=Math.max(1,ST.up_par||3),total=Math.ceil(f.size/CH);\n  const have=new Set(),prog={};\n  const show=()=>{let b=0;have.forEach(n=>{b+=Math.min(CH,f.size-n*CH)});for(const k in prog)b+=prog[k];const p=f.size?Math.min(b/f.size*100,100):100;\n    $(\"#up_bar\").style.width=p+\"%\";$(\"#up_t\").textContent=p.toFixed(1)+\"% · \"+fmt(Math.min(b,f.size))+\" of \"+fmt(f.size)};\n  async function sha(buf){try{if(window.crypto&&crypto.subtle){const h=await crypto.subtle.digest(\"SHA-256\",buf);return [...new Uint8Array(h)].map(x=>x.toString(16).padStart(2,\"0\")).join(\"\")}}catch(e){}return \"\"}\n  async function one(n){\n    const from=n*CH,end=Math.min(from+CH,f.size);\n    for(let a=0;a<8;a++){\n      try{\n        const blob=f.slice(from,end);let q=\"/api/upload?project=\"+pid+\"&id=\"+id+\"&name=\"+encodeURIComponent(f.name)+\"&offset=\"+from+\"&size=\"+f.size;\n        const h=await sha(await blob.arrayBuffer());if(h)q+=\"&sha=\"+h;\n        const x=await new Promise(res=>{const r=new XMLHttpRequest();r.open(\"POST\",q);r.setRequestHeader(\"X-Dash\",\"1\");\n          r.upload.onprogress=e=>{prog[n]=Math.min(e.loaded,end-from);show()};r.onloadend=()=>res(r);r.send(blob)});\n        delete prog[n];\n        if(x.status===200){have.add(n);show();return}\n        if(x.status===409&&/complete/.test(x.responseText)){have.add(n);return}\n        if(x.status===401||x.status===413||x.status===400)throw new Error((JSON.parse(x.responseText||\"{}\").error)||(\"HTTP \"+x.status));\n      }catch(e){delete prog[n];if(a>=7||/login|bigger|checksum|bad|choose/.test(String(e.message)))throw e}\n      await sleep(1500*(a+1))}\n    throw new Error(\"part \"+(n+1)+\" failed\")}\n  let done=false,lastErr=\"\";\n  for(let round=0;round<6&&!done;round++){\n    try{\n      if(round>0){await sleep(2000);let s=null;try{s=await api(\"/api/status/\"+id)}catch(e){}\n        if(s){if(s.done){done=true;break}have.clear();(s.have||[]).forEach(n=>have.add(n))}}\n      const todo=[];for(let n=0;n<Math.max(total,1);n++)if(!have.has(n))todo.push(n);\n      if(todo.length&&!have.size&&round===0){await one(todo.shift())}   // first part creates the file\n      let i=0;await Promise.all(Array.from({length:Math.min(PAR,todo.length)},async()=>{while(i<todo.length){await one(todo[i++])}}));\n      const s=await api(\"/api/status/\"+id);done=!!s.done;if(!done)lastErr=\"server has \"+(s.have||[]).length+\" of \"+total+\" parts\"\n    }catch(e){lastErr=e.message;if(/login|bigger|checksum|choose/.test(lastErr))break;$(\"#up_t\").textContent=\"interrupted (\"+lastErr+\"), resuming...\"}}\n  $(\"#up_b\").disabled=false;if(done){$(\"#up_bar\").style.width=\"100%\"}toast(done?\"Upload complete\":\"Upload failed\"+(lastErr?\": \"+lastErr:\"\"),!done);await load()}\nload().catch(e=>{$(\"#app\").innerHTML=\"<p>Cannot reach server: \"+esc(e.message)+\"</p>\"});\n</script></body></html>";
const PLAYER_HTML = "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><meta name=\"referrer\" content=\"no-referrer\">\n<title>__TITLE__</title><style>\n:root{--bg:#f4f5f7;--card:#fff;--tx:#1b1f24;--mut:#6a737d;--bd:#e3e6ea;--ac:#2a7de1}\n@media(prefers-color-scheme:dark){:root{--bg:#0f1318;--card:#181e26;--tx:#e7ebf0;--mut:#8b96a3;--bd:#2a323d;--ac:#4c9aff}}\n*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--tx);font:15px/1.45 system-ui,sans-serif}\n.w{max-width:820px;margin:0 auto;padding:14px}h1{font-size:17px;margin:6px 0;word-break:break-all}.m{color:var(--mut);font-size:13px;margin:4px 0 12px}\nvideo,audio,img{width:100%;border-radius:12px;background:#000;display:block;margin-bottom:12px}img{background:none;height:auto}\n.btns{display:flex;flex-wrap:wrap;gap:8px}.b{display:inline-block;padding:10px 14px;border:1px solid var(--bd);border-radius:10px;background:var(--card);color:var(--tx);font:inherit;text-decoration:none;cursor:pointer}\n.b.p{background:var(--ac);border-color:var(--ac);color:#fff}.hide{display:none}\n</style></head><body><div class=\"w\"><h1>__TITLE__</h1><div class=\"m\">__SIZE__</div><div id=\"pl\"></div>\n<div class=\"btns\"><a id=\"oa\" class=\"b p hide\">Open in video player</a><a id=\"ov\" class=\"b hide\">VLC</a><a id=\"om\" class=\"b hide\">MX Player</a>\n<button id=\"cp\" class=\"b\">Copy link</button><a id=\"dl\" class=\"b\">Download</a></div><p class=\"m\" id=\"msg\"></p></div>\n<script>\nconst D=__DATA__,U=location.origin+\"/s/\"+D.t+\"/\"+encodeURIComponent(D.n),$=i=>document.getElementById(i);\nconst ua=navigator.userAgent,android=/Android/i.test(ua),ios=/iPhone|iPad|iPod/i.test(ua);\n$(\"dl\").href=U+\"?dl=1\";$('dl').onclick=async function(e){if(!('serviceWorker' in navigator))return;e.preventDefault();try{await navigator.serviceWorker.register('/sw.js');await navigator.serviceWorker.ready;location.href='/xdl?u='+encodeURIComponent('/s/'+D.t+'/'+encodeURIComponent(D.n))+'&n='+encodeURIComponent(D.n)}catch(x){location.href=U+'?dl=1'}};\n$(\"cp\").onclick=()=>{if(navigator.clipboard)navigator.clipboard.writeText(U).then(()=>$(\"msg\").textContent=\"Link copied. In VLC: Media > Open Network Stream > paste.\",()=>prompt(\"Copy:\",U));else prompt(\"Copy:\",U)};\nif(D.k===\"video\"||D.k===\"audio\"){\n  const v=document.createElement(D.k);v.controls=true;v.preload=\"metadata\";v.src=U;\n  if(D.k===\"video\")v.setAttribute(\"playsinline\",\"\");\n  const ok=v.canPlayType(D.m);\n  if(ok){$(\"pl\").appendChild(v);v.onerror=()=>{v.remove();$(\"msg\").textContent=\"This browser cannot play this format. Use the player buttons or VLC.\"}}\n  else $(\"msg\").textContent=\"This browser cannot play this format directly. Open it in a player app (VLC / MX Player) - it streams, no full download needed.\";\n}else if(D.k===\"image\"){const i=new Image();i.src=U;$(\"pl\").appendChild(i)}\nconst rest=location.host+\"/s/\"+D.t+\"/\"+encodeURIComponent(D.n),type=D.k===\"audio\"?\"audio/*\":\"video/*\";\nconst intent=pk=>\"intent://\"+rest+\"#Intent;scheme=\"+location.protocol.replace(\":\",\"\")+\";type=\"+type+\";\"+(pk?\"package=\"+pk+\";S.browser_fallback_url=\"+encodeURIComponent(\"https://play.google.com/store/apps/details?id=\"+pk)+\";\":\"\")+\"end\";\nif(android&&(D.k===\"video\"||D.k===\"audio\")){\n  $(\"oa\").href=intent(\"\");$(\"oa\").classList.remove(\"hide\");\n  $(\"ov\").href=intent(\"org.videolan.vlc\");$(\"ov\").classList.remove(\"hide\");\n  $(\"om\").href=intent(\"com.mxtech.videoplayer.ad\");$(\"om\").classList.remove(\"hide\");\n}else if(ios&&(D.k===\"video\"||D.k===\"audio\")){\n  $(\"ov\").href=\"vlc://\"+U;$(\"ov\").textContent=\"Open in VLC\";$(\"ov\").classList.remove(\"hide\");\n}\n</script></body></html>";

const START = Date.now();
const ID_RE = /^[A-Za-z0-9_-]{4,64}$/;
const enc = new TextEncoder();
const dec = new TextDecoder();

class TGError extends Error {
  constructor(code, desc, retry = 0) {
    super(`${code} ${desc}`);
    this.code = code;
    this.desc = desc;
    this.retry_after = retry;
  }
}
class ApiError extends Error {
  constructor(code, msg) {
    super(msg);
    this.code = code;
  }
}

// ------------------------------------------------------------------ small helpers
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const unhex = (h) => new Uint8Array((h.match(/../g) || []).map((x) => parseInt(x, 16)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Math.floor(Date.now() / 1000);
const TG = (env) => (env.TG_API || "https://api.telegram.org").replace(/\/+$/, "");
const CHUNK = (env) => Math.round(parseFloat(env.CHUNK_MB || "18") * 1024 * 1024);
const MAX_FILE = (env) => Math.round(parseFloat(env.MAX_FILE_GB || "25") * 1024 ** 3);
const SQL_MAX_ROWS = (env) => Math.max(1, parseInt(env.SQL_MAX_ROWS || "50000", 10));
const SQL_SYNC_SECS = (env) => Math.max(5, parseInt(env.SQL_SYNC_SECS || "20", 10));
const MAX_CHUNKS = (env) => Math.max(1, parseInt(env.MAX_CHUNKS || "22", 10));

function tokenUrlsafe(n) {
  const b = crypto.getRandomValues(new Uint8Array(n));
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
const randHex = (n) => hex(crypto.getRandomValues(new Uint8Array(n)));

function timingEq(a, b) {
  a = String(a);
  b = String(b);
  let d = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return d === 0;
}

function human(n) {
  const u = ["B", "KB", "MB", "GB", "TB"];
  for (let i = 0; i < u.length; i++) {
    if (n < 1024 || i === u.length - 1) return i ? `${n.toFixed(1)} ${u[i]}` : `${n} B`;
    n /= 1024;
  }
}

function headersWith(extra) {
  const h = new Headers();
  for (const [k, v] of Object.entries(extra || {})) h.set(k, v);
  return h;
}
const send = (code, body, ctype, extra) => {
  const h = headersWith(extra);
  h.set("Content-Type", ctype);
  return new Response(body, { status: code, headers: h });
};
const json = (code, obj, extra) => send(code, JSON.stringify(obj), "application/json", extra);
const err = (code, msg, extra) => json(code, Object.assign({ error: msg }, extra || {}));

function parseId(s) {
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : NaN;
}
function basename(p) {
  return String(p).split(/[\\/]/).pop();
}
function guessMime(name) {
  const ext = (name.split(".").pop() || "").toLowerCase();
  const m = {
    mp4: "video/mp4", m4v: "video/mp4", mkv: "video/x-matroska", webm: "video/webm", mov: "video/quicktime",
    avi: "video/x-msvideo", ts: "video/mp2t", mp3: "audio/mpeg", m4a: "audio/mp4", flac: "audio/flac",
    ogg: "audio/ogg", wav: "audio/x-wav", aac: "audio/aac", jpg: "image/jpeg", jpeg: "image/jpeg",
    png: "image/png", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", pdf: "application/pdf",
    txt: "text/plain", json: "application/json", zip: "application/zip", apk: "application/vnd.android.package-archive",
    srt: "application/x-subrip", vtt: "text/vtt", html: "text/html", css: "text/css", js: "text/javascript",
  };
  return m[ext] || "application/octet-stream";
}

// ------------------------------------------------------------------ password + cookie (same format as the Python app)
async function pbkdf2Hex(pw, saltBytes) {
  const key = await crypto.subtle.importKey("raw", enc.encode(pw), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: saltBytes, iterations: 100000 }, key, 256);
  return hex(bits);
}
async function hashPw(pw, salt) {
  salt = salt || randHex(16);
  return salt + "$" + (await pbkdf2Hex(pw, unhex(salt)));
}
async function checkPw(pw, stored) {
  try {
    const [salt] = String(stored).split("$");
    return timingEq(await hashPw(pw, salt), stored);
  } catch (e) {
    return false;
  }
}
async function hmacHex(secret, msg) {
  const k = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", k, enc.encode(msg)));
}
async function makeCookie(s) {
  const exp = String(now() + 30 * 86400);
  return `${exp}.${await hmacHex(s.secret, exp)}`;
}
async function cookieOk(s, val) {
  try {
    const [exp, sig] = val.split(".");
    return parseInt(exp, 10) > now() && timingEq(sig, await hmacHex(s.secret, exp));
  } catch (e) {
    return false;
  }
}
function cookieHeader(url, val, maxage) {
  const sec = url.protocol === "https:" ? "; Secure" : "";
  return { "Set-Cookie": `sid=${val}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxage}${sec}` };
}
async function isAdmin(req, s) {
  if (!configured(s)) return false;
  for (const part of (req.headers.get("Cookie") || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === "sid" && (await cookieOk(s, part.slice(i + 1).trim()))) return true;
  }
  return false;
}
// login with a password from Cloudflare variables (RESET_PASSWORD replaces the stored one, ADMIN_PASSWORD only lets you in)
async function envPwLogin(env, s, pw) {
  pw = String(pw || "").trim();
  const rp = String(env.RESET_PASSWORD || "").trim();
  if (rp.length >= 6 && timingEq(pw, rp)) {
    s.admin_hash = await hashPw(rp);
    await saveSettings(env, s);
    await kvSet(env, "defpw", "0");
    try {
      await backupManifest(env, true);
    } catch (e) {
      console.log("backup after password reset failed:", e.message);
    }
    return true;
  }
  const ap = String(env.ADMIN_PASSWORD || "").trim();
  return ap.length >= 5 && timingEq(pw, ap);
}
const FAILS = new Map();
function throttled(ip, add) {
  const t = Date.now();
  const lst = (FAILS.get(ip) || []).filter((x) => t - x < 600000);
  if (add) lst.push(t);
  FAILS.set(ip, lst);
  return lst.length >= 8;
}

// ------------------------------------------------------------------ D1: settings and key/value
const configured = (s) => !!(s && s.channel && s.admin_hash && s.secret);
async function kvGet(env, k) {
  const r = await env.DB.prepare("SELECT v FROM kv WHERE k = ?").bind(k).first();
  return r ? r.v : null;
}
const kvSetStmt = (env, k, v) => env.DB.prepare("INSERT OR REPLACE INTO kv(k, v) VALUES(?, ?)").bind(k, String(v));
const kvSet = (env, k, v) => kvSetStmt(env, k, v).run();
const revStmt = (env) =>
  env.DB.prepare("INSERT INTO kv(k, v) VALUES('rev', '1') ON CONFLICT(k) DO UPDATE SET v = CAST(v AS INTEGER) + 1");

let SCACHE = { t: 0, v: null };
async function getSettings(env, fresh) {
  if (!fresh && Date.now() - SCACHE.t < 2000) return SCACHE.v;
  const raw = await kvGet(env, "settings");
  const v = raw ? JSON.parse(raw) : null;
  SCACHE = { t: Date.now(), v };
  return v;
}
async function saveSettings(env, s) {
  await env.DB.batch([kvSetStmt(env, "settings", JSON.stringify(s)), revStmt(env)]);
  SCACHE = { t: Date.now(), v: s };
  AGG.t = 0;
}
function botChannel(s, bid) {
  const b = (s.bots || {})[String(bid)] || {};
  return String(b.channel || s.channel);
}
const chunkChannel = (s, row) => String(row.ch || botChannel(s, row.bot));

// ------------------------------------------------------------------ Telegram
async function tg(env, token, method, fields, file) {
  const url = `${TG(env)}/bot${token}/${method}`;
  let init;
  if (file) {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields || {})) fd.append(k, String(v));
    fd.append(file.field, file.data instanceof Blob ? file.data : new Blob([file.data]), file.name);
    init = { method: "POST", body: fd };
  } else {
    init = {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(Object.entries(fields || {}).map(([k, v]) => [k, String(v)])).toString(),
    };
  }
  let res;
  try {
    const r = await fetch(url, init);
    res = await r.json().catch(() => ({ ok: false, error_code: r.status, description: `HTTP ${r.status}` }));
  } catch (e) {
    throw new TGError(0, "network error");
  }
  if (!res.ok) throw new TGError(res.error_code || 0, res.description || "", (res.parameters || {}).retry_after || 0);
  return res.result;
}
async function tgBytes(env, token, fileId) {
  const info = await tg(env, token, "getFile", { file_id: fileId });
  const r = await fetch(`${TG(env)}/file/bot${token}/${info.file_path}`);
  if (!r.ok) throw new TGError(r.status, "download failed");
  return new Uint8Array(await r.arrayBuffer());
}
async function gunzip(bytes) {
  const out = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(out).arrayBuffer());
}
async function gzip(bytes) {
  const out = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(out).arrayBuffer());
}
async function parseManifestBytes(raw) {
  if (raw[0] === 0x1f && raw[1] === 0x8b) raw = await gunzip(raw);
  return JSON.parse(dec.decode(raw));
}
async function fetchRemote(env, token, channel) {
  const chat = await tg(env, token, "getChat", { chat_id: channel });
  const pm = chat.pinned_message;
  const doc = pm && pm.document;
  if (!doc || !["manifest.json", "manifest.json.gz"].includes(doc.file_name)) return null;
  const remote = await parseManifestBytes(await tgBytes(env, token, doc.file_id));
  remote.backup_msg = pm.message_id;
  return remote;
}
async function checkAdmin(env, token, channel, botId) {
  let m;
  try {
    m = await tg(env, token, "getChatMember", { chat_id: channel, user_id: botId });
  } catch (e) {
    return [`could not check bot permissions: ${e.desc || e.message}`];
  }
  if (!["administrator", "creator"].includes(m.status)) return ["bot is not an admin of the channel"];
  const w = [];
  if (m.can_post_messages === false) w.push("bot lacks 'Post messages' right");
  if (m.can_delete_messages === false) w.push("bot lacks 'Delete messages' right (old messages will pile up in the channel)");
  if (m.can_pin_messages === false) w.push("bot lacks 'Pin messages' right (manifest backup cannot be pinned)");
  return w;
}

// Telegram file_path cache (valid for at least an hour on Telegram's side)
const FP = new Map();
async function filePath(env, s, row, fresh) {
  const key = `${row.bot}:${row.tgid}`;
  const c = FP.get(key);
  if (!fresh && c && Date.now() - c.t < 45 * 60000) return c.p;
  const b = (s.bots || {})[String(row.bot)];
  if (!b) throw new TGError(0, `bot ${row.bot} is not configured`);
  const r = await tg(env, b.token, "getFile", { file_id: row.tgid });
  if (FP.size > 5000) FP.clear();
  FP.set(key, { p: r.file_path, t: Date.now() });
  return r.file_path;
}
// ------------------------------------------------------------------ manifest <-> D1
const FILES_SQL = `INSERT OR REPLACE INTO files(id, project, name, size, chunk, stored, done, created, mime, share)
SELECT json_extract(value,'$.id'), json_extract(value,'$.project'), json_extract(value,'$.name'),
 json_extract(value,'$.size'), json_extract(value,'$.chunk'), json_extract(value,'$.stored'),
 json_extract(value,'$.done'), json_extract(value,'$.created'), json_extract(value,'$.mime'),
 json_extract(value,'$.share') FROM json_each(?)`;
const CHUNKS_SQL = `INSERT OR REPLACE INTO chunks(fid, n, bot, ch, msg, tgid, size, sha)
SELECT json_extract(value,'$.fid'), json_extract(value,'$.n'), json_extract(value,'$.bot'),
 json_extract(value,'$.ch'), json_extract(value,'$.msg'), json_extract(value,'$.tgid'),
 json_extract(value,'$.size'), json_extract(value,'$.sha') FROM json_each(?)`;

async function importAll(env, data) {
  const files = Object.values(data.files || {});
  const stmts = [
    env.DB.prepare("DELETE FROM chunks"),
    env.DB.prepare("DELETE FROM files"),
    env.DB.prepare("DELETE FROM pending"),
    env.DB.prepare("DELETE FROM kv"),
  ];
  let fpiece = [], cpiece = [], fsz = 0, csz = 0, nchunks = 0;
  const flushF = () => {
    if (fpiece.length) stmts.push(env.DB.prepare(FILES_SQL).bind(JSON.stringify(fpiece)));
    fpiece = [];
    fsz = 0;
  };
  const flushC = () => {
    if (cpiece.length) stmts.push(env.DB.prepare(CHUNKS_SQL).bind(JSON.stringify(cpiece)));
    cpiece = [];
    csz = 0;
  };
  for (const f of files) {
    const row = {
      id: f.id, project: f.project == null ? null : f.project, name: f.name, size: f.size, chunk: f.chunk,
      stored: f.stored || 0, done: f.done ? 1 : 0, created: f.created || 0,
      mime: f.mime || guessMime(f.name || ""), share: f.share || null,
    };
    fpiece.push(row);
    fsz += 220 + String(row.name).length * 3;
    if (fsz > 300000) flushF();
    for (const c of f.chunks || []) {
      const cr = {
        fid: f.id, n: c.n, bot: String(c.bot), ch: c.ch == null ? null : String(c.ch), msg: c.msg,
        tgid: c.fid, size: c.size, sha: c.sha || "",
      };
      cpiece.push(cr);
      nchunks++;
      csz += 230;
      if (csz > 300000) flushC();
    }
  }
  flushF();
  flushC();
  const kv = (k, v) => stmts.push(kvSetStmt(env, k, v));
  kv("settings", JSON.stringify(data.settings));
  kv("rev", (data.rev || 0) + 1);
  if (data.dbs) kv("dbs", JSON.stringify(data.dbs));
  for (const [pid, rec] of Object.entries(data.sqldb || {})) kv("sqldb:" + pid, JSON.stringify(rec));
  kv("backup", JSON.stringify({ msg: data.backup_msg || null, bot: data.backup_bot || null, edits: 0, at: 0, rev: -1, ok: null }));
  for (const p of data.pending_del || []) {
    stmts.push(env.DB.prepare("INSERT INTO pending(bot, ch, msg) VALUES(?, ?, ?)").bind(String(p.bot), p.ch == null ? null : String(p.ch), p.msg));
  }
  for (let i = 0; i < stmts.length; i += 12) await env.DB.batch(stmts.slice(i, i + 12));
  SCACHE = { t: 0, v: null };
  AGG.t = 0;
  return { files: files.length, chunks: nchunks };
}

async function buildManifest(env) {
  const s = await getSettings(env, true);
  const rev = parseInt((await kvGet(env, "rev")) || "0", 10);
  const b = JSON.parse((await kvGet(env, "backup")) || "{}");
  const frows = (await env.DB.prepare("SELECT * FROM files").all()).results;
  const crows = (await env.DB.prepare("SELECT * FROM chunks ORDER BY fid, n").all()).results;
  const files = {};
  for (const f of frows) {
    const o = { id: f.id, name: f.name, project: f.project, size: f.size, chunk: f.chunk, chunks: [], stored: f.stored, done: !!f.done, created: f.created, mime: f.mime };
    if (f.share) o.share = f.share;
    files[f.id] = o;
  }
  for (const c of crows) {
    const f = files[c.fid];
    if (!f) continue;
    const bn = Number(c.bot);
    const e = { n: c.n, bot: Number.isFinite(bn) ? bn : c.bot, msg: c.msg, fid: c.tgid, size: c.size, sha: c.sha || "" };
    if (c.ch) e.ch = c.ch;
    f.chunks.push(e);
  }
  const data = { rev, files, backup_msg: b.msg || null, settings: s };
  if (b.bot) data.backup_bot = Number(b.bot) || b.bot;
  const dbs = await kvGet(env, "dbs");
  if (dbs) data.dbs = JSON.parse(dbs);
  const sq = (await env.DB.prepare("SELECT k, v FROM kv WHERE k LIKE 'sqldb:%'").all()).results;
  if (sq.length) { data.sqldb = {}; for (const r of sq) data.sqldb[r.k.slice(6)] = JSON.parse(r.v); }
  const pend = (await env.DB.prepare("SELECT bot, ch, msg FROM pending").all()).results;
  if (pend.length) data.pending_del = pend.map((p) => ({ bot: Number(p.bot) || p.bot, msg: p.msg, ch: p.ch || undefined }));
  return { data, rev };
}

// write the manifest to the pinned message of the main channel (edit in place when possible)
async function backupManifest(env, force) {
  const s = await getSettings(env, true);
  if (!configured(s)) return false;
  const st = JSON.parse((await kvGet(env, "backup")) || "{}");
  if (!force && Date.now() - (st.at || 0) < 120000) return !!st.ok;
  if (!force && st.rev === parseInt((await kvGet(env, "rev")) || "0", 10) && st.ok) return true;
  const { data, rev } = await buildManifest(env);
  const snap = await gzip(enc.encode(JSON.stringify(data)));
  const save = (o) => kvSet(env, "backup", JSON.stringify(Object.assign({}, st, o)));
  const enabledMain = Object.entries(s.bots || {}).filter(([, b]) => b.enabled !== false && String(b.channel || s.channel) === String(s.channel));
  const rotate = (st.edits || 0) >= 20;
  if (st.msg && st.bot && !rotate && (s.bots || {})[String(st.bot)]) {
    try {
      await tg(env, s.bots[String(st.bot)].token, "editMessageMedia", {
        chat_id: s.channel, message_id: st.msg,
        media: JSON.stringify({ type: "document", media: "attach://manifest", caption: `manifest rev ${rev}` }),
      }, { field: "manifest", name: "manifest.json.gz", data: snap });
      await save({ edits: (st.edits || 0) + 1, at: Date.now(), rev, ok: true });
      return true;
    } catch (e) {
      if (!/not modified/i.test(e.desc || "")) console.log("edit in place failed:", e.message);
      else {
        await save({ at: Date.now(), rev, ok: true });
        return true;
      }
    }
  }
  const cands = enabledMain.filter(([id]) => !(rotate && String(id) === String(st.bot)));
  for (const [id, b] of (cands.length ? cands : enabledMain).slice(0, 3)) {
    try {
      const m = await tg(env, b.token, "sendDocument", { chat_id: s.channel, caption: `manifest rev ${rev}`, disable_notification: "true" },
        { field: "document", name: "manifest.json.gz", data: snap });
      try {
        await tg(env, b.token, "pinChatMessage", { chat_id: s.channel, message_id: m.message_id, disable_notification: "true" });
      } catch (e) {
        console.log("pin failed (give bot 'Pin messages' right):", e.message);
      }
      if (st.msg) {
        try {
          await tg(env, b.token, "deleteMessage", { chat_id: s.channel, message_id: st.msg });
        } catch (e) { /* old one may belong to another bot; harmless */ }
      }
      await save({ msg: m.message_id, bot: id, edits: 0, at: Date.now(), rev, ok: true });
      return true;
    } catch (e) {
      console.log("backup failed:", e.message);
    }
  }
  await save({ at: Date.now(), ok: false });
  return false;
}
const autoBackup = (env, ctx) => {
  if (env.AUTO_BACKUP === "0") return;
  ctx.waitUntil(backupManifest(env, false).catch((e) => console.log("auto backup:", e.message)));
};

// ------------------------------------------------------------------ setup / restore
async function doSetup(env, pw, ch, tok) {
  pw = (pw || "").trim() || "admin";
  ch = (ch || "").trim();
  tok = (tok || "").trim();
  if (pw.length < 5) throw new ApiError(400, "password must be at least 5 characters (empty = default 'admin')");
  if (!ch || !tok) throw new ApiError(400, "channel id and bot token are required");
  let me, remote;
  try {
    me = await tg(env, tok, "getMe");
    ch = String((await tg(env, tok, "getChat", { chat_id: ch })).id || ch);
    remote = await fetchRemote(env, tok, ch);
  } catch (e) {
    if (e instanceof TGError) throw new ApiError(400, `Telegram says: ${e.desc || e.message} (check token / channel id / bot is admin)`);
    throw e;
  }
  const bid = String(me.id);
  const warns = await checkAdmin(env, tok, ch, me.id);
  const bot = { token: tok, name: me.username || bid, enabled: true, channel: ch };
  const restored = !!(remote && remote.settings);
  let defpw = false;
  if (restored) {
    const st = remote.settings;
    st.channel = ch;
    st.bots = st.bots || {};
    st.bots[bid] = Object.assign({}, st.bots[bid] || {}, bot);
    for (const b of Object.values(st.bots)) if (!b.channel) b.channel = ch;
    st.projects = st.projects || {};
    st.secret = st.secret || randHex(32);
    if (!st.admin_hash) {
      st.admin_hash = await hashPw(pw);
      defpw = pw === "admin";
    }
    remote.files = remote.files || {};
    remote.rev = remote.rev || 0;
    await importAll(env, remote);
  } else {
    const settings = { channel: ch, admin_hash: await hashPw(pw), secret: randHex(32), bots: { [bid]: bot }, projects: {} };
    await importAll(env, { settings, files: {}, rev: 0 });
    defpw = pw === "admin";
  }
  await kvSet(env, "defpw", restored && !defpw ? "0" : defpw ? "1" : "0");
  SCACHE = { t: 0, v: null };
  try {
    await backupManifest(env, true);
  } catch (e) {
    console.log("backup after setup failed:", e.message);
  }
  return { restored, warnings: warns };
}

let AUTOSETUP = { t: 0, err: "" };
async function ensureSetupFromEnv(env) {
  const s = await getSettings(env);
  if (configured(s)) return;
  const ch = (env.CHANNEL_ID || "").trim(), tok = (env.BOT_TOKEN || "").trim();
  if (!ch || !tok || Date.now() - AUTOSETUP.t < 30000) return;
  AUTOSETUP.t = Date.now();
  try {
    await doSetup(env, env.ADMIN_PASSWORD || "", ch, tok);
    AUTOSETUP.err = "";
  } catch (e) {
    AUTOSETUP.err = e.message;
    console.log("auto setup from environment failed:", e.message);
  }
}

// ================================================================== PART 2: schema, bots, upload, download, routes
const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v TEXT)",
  "CREATE TABLE IF NOT EXISTS files(id TEXT PRIMARY KEY, project TEXT, name TEXT, size INTEGER, chunk INTEGER, stored INTEGER DEFAULT 0, done INTEGER DEFAULT 0, created INTEGER, mime TEXT, share TEXT)",
  "CREATE TABLE IF NOT EXISTS chunks(fid TEXT, n INTEGER, bot TEXT, ch TEXT, msg INTEGER, tgid TEXT, size INTEGER, sha TEXT, PRIMARY KEY(fid, n))",
  "CREATE TABLE IF NOT EXISTS pending(id INTEGER PRIMARY KEY AUTOINCREMENT, bot TEXT, ch TEXT, msg INTEGER)",
  "CREATE INDEX IF NOT EXISTS files_share ON files(share)",
  "CREATE INDEX IF NOT EXISTS files_project ON files(project)",
];
let SCHEMA_OK = false;
async function ensureSchema(env) {
  if (SCHEMA_OK) return;
  if (!env.DB) throw new ApiError(500, "D1 binding 'DB' is missing (Settings -> Bindings -> D1 database, variable name DB)");
  await env.DB.batch(SCHEMA.map((q) => env.DB.prepare(q)));
  SCHEMA_OK = true;
}
let AGG = { t: 0, v: null };

// ------------------------------------------------------------------ bot pool (per isolate; Workers are stateless)
const POOL = { until: new Map(), load: new Map(), stat: new Map() };
function enabledBots(s, channel) {
  return Object.entries(s.bots || {})
    .filter(([, b]) => b.enabled !== false && (channel == null || String(b.channel || s.channel) === String(channel)))
    .map(([id]) => id);
}
function pickUp(s, avoid) {
  const ids = enabledBots(s);
  if (!ids.length) throw new TGError(0, "no enabled bot (add or enable one in the dashboard)");
  const c = ids.filter((i) => !avoid.has(i));
  const cands = c.length ? c : ids;
  const t = Date.now();
  const key = (i) => [Math.max((POOL.until.get(i) || 0) - t, 0) > 0 ? 1 : 0, POOL.load.get(i) || 0, Math.random()];
  cands.sort((a, b) => {
    const x = key(a), y = key(b);
    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
  });
  const i = cands[0];
  POOL.load.set(i, (POOL.load.get(i) || 0) + 1);
  return [i, Math.max((POOL.until.get(i) || 0) - t, 0) / 1000]; // seconds to wait before this bot may be used
}
const poolRelease = (i) => POOL.load.set(i, Math.max((POOL.load.get(i) || 0) - 1, 0));
const poolCool = (i, secs) => POOL.until.set(i, Math.max(POOL.until.get(i) || 0, Date.now() + secs * 1000));
function poolStat(i, e) {
  const st = POOL.stat.get(i) || { ok: 0, err: 0, last_err: "" };
  if (e) {
    st.err++;
    st.last_err = String(e.message || e).slice(0, 120);
  } else st.ok++;
  POOL.stat.set(i, st);
}

async function sendChunk(env, s, fid, n, data) {
  const avoid = new Set();
  let last;
  for (let attempt = 0; attempt < 6; attempt++) {
    const [id, wait] = pickUp(s, avoid);
    try {
      if (wait > 0) await sleep(Math.min(wait, 8) * 1000);
      const ch = botChannel(s, id);
      try {
        const m = await tg(env, s.bots[id].token, "sendDocument",
          { chat_id: ch, caption: `${fid}|${n}`, disable_notification: "true" },
          { field: "document", name: `${fid}_${String(n).padStart(6, "0")}.bin`, data });
        poolStat(id);
        return { n, bot: id, ch, msg: m.message_id, tgid: m.document.file_id, size: data.length };
      } catch (e) {
        last = e;
        poolStat(id, e);
        console.log(`send chunk ${n} via bot ${id} failed: ${e.message}`);
        if (e instanceof TGError && e.code === 429) {
          poolCool(id, e.retry_after || 5);
          avoid.add(id);
        } else if (e instanceof TGError && [400, 401, 403, 404].includes(e.code)) {
          poolCool(id, 30);
          avoid.add(id);
        } else await sleep(Math.min(2 ** attempt, 6) * 300);
      }
    } finally {
      poolRelease(id);
    }
  }
  throw last || new Error("send failed");
}

// ------------------------------------------------------------------ deleting Telegram messages (bulk, budget aware)
const DEL_CALLS = 30;
async function noteDelFail(env, e) {
  const d = (e && (e.desc || e.message)) || "";
  if (/not found/i.test(d)) return;
  let st = {};
  try {
    st = JSON.parse((await kvGet(env, "delstate")) || "{}");
  } catch (x) { /* ignore */ }
  st.fail = (st.fail || 0) + 1;
  st.err = String(d).slice(0, 120);
  await kvSet(env, "delstate", JSON.stringify(st));
}
async function queuePending(env, list) {
  for (let i = 0; i < list.length; i += 40) {
    const part = list.slice(i, i + 40);
    await env.DB.batch(part.map((e) =>
      env.DB.prepare("INSERT INTO pending(bot, ch, msg) VALUES(?, ?, ?)").bind(String(e.bot), e.ch == null ? null : String(e.ch), e.msg)));
  }
}
// entries: [{bot, ch, msg}] -> returns the entries that could NOT be deleted (and are not "already gone")
async function deleteMsgsRaw(env, entries) {
  const s = await getSettings(env, true);
  const groups = new Map();
  for (const e of entries) {
    const ch = e.ch ? String(e.ch) : botChannel(s, e.bot);
    const key = `${e.bot}|${ch}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e.msg);
  }
  const failed = [];
  let calls = 0;
  for (const [key, list] of groups) {
    const [bot, ch] = key.split("|");
    const tok = ((s.bots || {})[bot] || {}).token;
    for (let i = 0; i < list.length; i += 100) {
      const slice = list.slice(i, i + 100);
      if (!tok || calls >= DEL_CALLS) {
        failed.push(...slice.map((m) => ({ bot, ch, msg: m })));
        continue;
      }
      calls++;
      try {
        await tg(env, tok, "deleteMessages", { chat_id: ch, message_ids: JSON.stringify(slice) });
      } catch (e) {
        if (e instanceof TGError && /not found/i.test(e.desc || "")) continue;
        if (e instanceof TGError && e.code === 429) await sleep(Math.min(e.retry_after || 2, 5) * 1000);
        await noteDelFail(env, e);
        failed.push(...slice.map((m) => ({ bot, ch, msg: m })));
      }
    }
  }
  return failed;
}
async function deleteMsgs(env, entries) {
  if (!entries.length) return;
  const failed = await deleteMsgsRaw(env, entries);
  if (failed.length) await queuePending(env, failed);
}
async function cleanupPending(env) {
  await kvSet(env, "delstate", JSON.stringify({ fail: 0, err: "" }));
  const rows = (await env.DB.prepare("SELECT id, bot, ch, msg FROM pending ORDER BY id LIMIT 3000").all()).results;
  if (!rows.length) return { done: 0, left: 0 };
  for (let i = 0; i < rows.length; i += 90) {
    await env.DB.batch(rows.slice(i, i + 90).map((r) => env.DB.prepare("DELETE FROM pending WHERE id = ?").bind(r.id)));
  }
  const failed = await deleteMsgsRaw(env, rows);
  if (failed.length) await queuePending(env, failed);
  const left = (await env.DB.prepare("SELECT COUNT(*) AS c FROM pending").first()).c;
  return { done: rows.length - failed.length, left };
}

// ------------------------------------------------------------------ files
const FILE_SELECT = "SELECT f.*, (SELECT COUNT(*) FROM chunks c WHERE c.fid = f.id) AS nchunks FROM files f";
async function getFileRow(env, id) {
  return await env.DB.prepare(`${FILE_SELECT} WHERE f.id = ?`).bind(String(id)).first();
}
const info = (f, extra) =>
  Object.assign({ id: f.id, name: f.name, size: f.size, stored: f.stored, done: !!f.done, chunks: f.nchunks || 0, chunk: f.chunk,
    created: f.created, project: f.project, busy: false, share: f.share || null }, extra || {});
// status of one file for resuming: `stored` = bytes of the continuous part from the start, `have` = chunk numbers already saved
async function statusInfo(env, f) {
  const rows = (await env.DB.prepare("SELECT n FROM chunks WHERE fid = ? ORDER BY n").bind(f.id).all()).results;
  const have = rows.map((r) => r.n);
  let k = 0;
  while (k < have.length && have[k] === k) k++;
  const stored = f.done ? f.size : Math.min(k * f.chunk, f.size);
  return info(f, { stored, have });
}
async function ensureShare(env, id) {
  await env.DB.prepare("UPDATE files SET share = ? WHERE id = ? AND (share IS NULL OR share = '')").bind(tokenUrlsafe(16), id).run();
}
async function projectByKey(env, key) {
  const s = await getSettings(env);
  if (!s) return null;
  for (const [pid, p] of Object.entries(s.projects || {})) if (timingEq(p.key, key)) return pid;
  return null;
}

// ------------------------------------------------------------------ upload
// Every request carries whole chunks (offset must be a multiple of the chunk size, or the last piece of the file).
// A chunk that is already saved is skipped, so retries and parallel pieces are safe.
function bodyReader(req) {
  const reader = req.body ? req.body.getReader() : null;
  let segs = [], have = 0;
  return async function readN(n) {
    while (have < n && reader) {
      const { value, done } = await reader.read();
      if (done) break;
      segs.push(value);
      have += value.length;
    }
    const take = Math.min(n, have);
    const out = new Uint8Array(take);
    let pos = 0;
    while (pos < take) {
      const seg = segs[0];
      const need = take - pos;
      if (seg.length <= need) {
        out.set(seg, pos);
        pos += seg.length;
        segs.shift();
      } else {
        out.set(seg.subarray(0, need), pos);
        segs[0] = seg.subarray(need);
        pos += need;
      }
    }
    have -= take;
    return out;
  };
}

async function handleUpload(env, ctx, req, url, pid) {
  const q = url.searchParams;
  const cl = req.headers.get("Content-Length");
  if (cl == null || !/^\d+$/.test(cl)) return err(411, "Content-Length required");
  const length = parseInt(cl, 10);
  const offset = parseInt(q.get("offset") || "0", 10);
  if (!Number.isFinite(offset) || offset < 0) return err(400, "bad offset");
  const s = await getSettings(env);
  if (!configured(s) || !enabledBots(s).length) return err(503, "no enabled bot: add one in the dashboard");
  const total = q.has("size") ? parseInt(q.get("size"), 10) : offset + length;
  if (!Number.isFinite(total) || total < 0) return err(400, "bad size");
  if (total < offset + length) return err(400, "size smaller than offset + length");
  if (total > MAX_FILE(env)) return err(413, `file is bigger than the ${human(MAX_FILE(env))} limit`);
  const fid = q.get("id") || randHex(8);
  if (!ID_RE.test(fid)) return err(400, "bad id (4-64 chars: letters, digits, _ -)");
  const name = basename(q.get("name") || fid) || fid;

  let f = await getFileRow(env, fid);
  if (f && f.project !== pid) return err(409, "id belongs to another project");
  if (!f) {
    await env.DB.batch([
      env.DB.prepare("INSERT OR IGNORE INTO files(id, project, name, size, chunk, stored, done, created, mime, share) VALUES(?, ?, ?, ?, ?, 0, 0, ?, ?, NULL)")
        .bind(fid, pid, name, total, CHUNK(env), now(), guessMime(name)),
      revStmt(env),
    ]);
    f = await getFileRow(env, fid);
    if (!f || f.project !== pid) return err(409, "id belongs to another project");
  }
  if (f.done) return length === 0 ? json(200, info(f)) : err(409, "already complete", info(f));
  if (f.size !== total) return err(400, "size mismatch", { expected_total: f.size });
  const csize = f.chunk;
  const expect = Math.ceil(total / csize);
  if (total === 0) {
    await env.DB.prepare("UPDATE files SET done = 1 WHERE id = ?").bind(fid).run();
    await ensureShare(env, fid);
    ctx.waitUntil(backupManifest(env, true).catch((e) => console.log("backup:", e.message)));
    return json(200, info(await getFileRow(env, fid)));
  }
  if (offset % csize !== 0) return err(400, "offset must be a multiple of the chunk size", { chunk: csize });
  if (length === 0) return json(200, await statusInfo(env, f));
  if (length % csize !== 0 && offset + length !== total) return err(400, "send whole chunks (or the end of the file)", { chunk: csize });
  const nch = Math.ceil(length / csize);
  const maxUp = Math.max(1, parseInt(env.MAX_UP_CHUNKS || "4", 10));
  if (nch > maxUp) return err(413, `send at most ${maxUp} chunks (${maxUp * csize} bytes) per request`, { chunk: csize, max_chunks: maxUp });

  const first = offset / csize;
  const haveRows = (await env.DB.prepare("SELECT n FROM chunks WHERE fid = ? AND n >= ? AND n < ?").bind(fid, first, first + nch).all()).results;
  const have = new Set(haveRows.map((r) => r.n));
  const readN = bodyReader(req);
  const sha1 = q.get("sha") || "";
  const done = [];
  let failure = null;
  for (let i = 0; i < nch; i++) {
    const n = first + i;
    const want = Math.min(csize, total - n * csize);
    const data = await readN(want);
    if (data.length !== want) {
      failure = new Error("client closed early");
      break;
    }
    if (have.has(n)) continue;
    let sha = nch === 1 ? sha1 : "";
    if (env.HASH_UPLOADS === "1") {
      const h = hex(await crypto.subtle.digest("SHA-256", data));
      if (sha && sha !== h) return err(400, "checksum mismatch, the piece got damaged on the way", { stored: f.stored });
      sha = h;
    }
    try {
      const r = await sendChunk(env, s, fid, n, data);
      r.sha = sha;
      done.push(r);
    } catch (e) {
      failure = e;
      break;
    }
  }
  const stmts = done.map((r) =>
    env.DB.prepare("INSERT OR REPLACE INTO chunks(fid, n, bot, ch, msg, tgid, size, sha) VALUES(?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(fid, r.n, String(r.bot), r.ch == null ? null : String(r.ch), r.msg, r.tgid, r.size, r.sha || ""));
  stmts.push(env.DB.prepare(
    "UPDATE files SET stored = (SELECT COALESCE(SUM(size), 0) FROM chunks WHERE fid = ?1), " +
    "done = CASE WHEN (SELECT COUNT(*) FROM chunks WHERE fid = ?1) >= ?2 THEN 1 ELSE 0 END WHERE id = ?1").bind(fid, expect));
  stmts.push(revStmt(env));
  await env.DB.batch(stmts);
  f = await getFileRow(env, fid);
  if (failure) {
    console.log(`upload ${fid} stopped: ${failure.message}`);
    const st = await statusInfo(env, f);
    return json(502, { error: "upload interrupted", stored: st.stored, have: st.have });
  }
  if (f.done) {
    await ensureShare(env, fid);
    f = await getFileRow(env, fid);
    console.log(`upload complete: ${f.name} (${human(f.size)}, ${f.nchunks} chunks)`);
    ctx.waitUntil(backupManifest(env, true).catch((e) => console.log("backup:", e.message)));
  } else autoBackup(env, ctx);
  return json(200, info(f));
}

// ------------------------------------------------------------------ download (streams the chunks one after another)
async function openChunk2(env, s, row, lo, hi) {
  // returns { body, skip, take }: stream the bytes [lo, hi) of one stored chunk
  let last;
  const whole = lo === 0 && hi >= row.size;
  for (let a = 0; a < 3; a++) {
    try {
      const path = await filePath(env, s, row, a > 0);
      const headers = whole ? {} : { Range: `bytes=${lo}-${hi - 1}` };
      const r = await fetch(`${TG(env)}/file/bot${s.bots[String(row.bot)].token}/${path}`, { headers });
      if (r.ok && r.body) {
        if (!whole && r.status === 206) return { body: r.body, skip: 0, take: hi - lo };
        return { body: r.body, skip: whole ? 0 : lo, take: hi - lo };
      }
      last = new TGError(r.status, "download failed");
      if (r.status === 429) await sleep(Math.min(parseInt(r.headers.get("retry-after") || "2", 10), 6) * 1000);
    } catch (e) {
      last = e;
      if (e instanceof TGError && e.code === 429) await sleep(Math.min(e.retry_after || 2, 6) * 1000);
    }
  }
  throw last || new Error("chunk download failed");
}

async function pumpChunks(env, s, rows, csize, start, end, writable) {
  try {
    for (const row of rows) {
      const cs = row.n * csize;
      const lo = Math.max(start - cs, 0);
      const hi = Math.min(end - cs + 1, row.size);
      const { body, skip, take } = await openChunk2(env, s, row, lo, hi);
      if (skip === 0 && take === row.size) {
        await body.pipeTo(writable, { preventClose: true, preventAbort: true }); // no JS copying: cheapest on the free CPU limit
      } else {
        const reader = body.getReader();
        const w = writable.getWriter();
        let skipped = 0, sent = 0;
        try {
          while (sent < take) {
            const { value, done } = await reader.read();
            if (done) throw new Error("chunk ended early");
            let v = value;
            if (skipped < skip) {
              const cut = Math.min(skip - skipped, v.length);
              skipped += cut;
              v = v.subarray(cut);
              if (!v.length) continue;
            }
            if (sent + v.length > take) v = v.subarray(0, take - sent);
            await w.write(v);
            sent += v.length;
          }
          reader.cancel().catch(() => {});
        } finally {
          w.releaseLock();
        }
      }
    }
    await writable.close();
  } catch (e) {
    console.log("download stream stopped:", e && e.message);
    try {
      await writable.abort(e);
    } catch (x) { /* ignore */ }
  }
}

async function sendFile(env, ctx, req, fid, pid, attach) {
  const f = await env.DB.prepare("SELECT * FROM files WHERE id = ?").bind(String(fid)).first();
  if (!f || !f.done || (pid != null && f.project !== pid)) return err(404, "unknown or unfinished file");
  const s = await getSettings(env);
  const size = f.size;
  let start = 0, end = size - 1, code = 200;
  const rng = req.headers.get("Range");
  if (rng && size) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(rng.trim());
    const a = m ? m[1] : "", b = m ? m[2] : "";
    const bad = () => new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}`, "Content-Length": "0" } });
    if (!m || (a === "" && b === "")) return bad();
    if (a === "") {
      start = Math.max(size - parseInt(b, 10), 0);
      end = size - 1;
    } else {
      start = parseInt(a, 10);
      end = Math.min(b ? parseInt(b, 10) : size - 1, size - 1);
    }
    if (start > end || start >= size) return bad();
    code = 206;
  }
  const csize = f.chunk;
  const first = Math.floor(start / csize);
  let last = Math.floor(end / csize);
  const maxc = MAX_CHUNKS(env);
  let sendEnd = end;
  if (last - first + 1 > maxc) {
    // one Worker response can only fetch so many chunks (subrequest limit): serve the first part, the player/downloader asks again
    last = first + maxc - 1;
    sendEnd = (last + 1) * csize - 1;
    if (code === 206) end = sendEnd; // a plain 200 download just stops early; the client resumes with a Range request
  }
  const headers = {
    "Content-Type": f.mime || "application/octet-stream",
    "Accept-Ranges": "bytes",
    "Content-Disposition": (attach ? "attachment" : "inline") + "; filename*=UTF-8''" + encodeURIComponent(f.name),
    ETag: `"${f.id}-${f.size}"`,
    "Cache-Control": "private, max-age=0",
  };
  const len = Math.max(end - start + 1, 0);
  headers["Content-Length"] = String(len);
  if (code === 206) headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
  if (req.method === "HEAD" || size === 0) return new Response(null, { status: code, headers });
  const rows = (await env.DB.prepare("SELECT * FROM chunks WHERE fid = ? AND n >= ? AND n <= ? ORDER BY n").bind(f.id, first, last).all()).results;
  if (rows.length !== last - first + 1) return err(500, "file is damaged: chunks are missing");
  const { readable, writable } = typeof FixedLengthStream !== "undefined" ? new FixedLengthStream(len) : new TransformStream();
  ctx.waitUntil(pumpChunks(env, s, rows, csize, start, Math.min(sendEnd, end), writable));
  return new Response(readable, { status: code, headers });
}

// ------------------------------------------------------------------ player page
function escHtml(x) {
  return String(x).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
}
function playerPage(f, tok) {
  const mime = f.mime || "application/octet-stream";
  const kind = mime.startsWith("video/") ? "video" : mime.startsWith("audio/") ? "audio" : mime.startsWith("image/") ? "image" : "file";
  const data = JSON.stringify({ t: tok, n: f.name, m: mime, k: kind }).replace(/</g, "\\u003c");
  return PLAYER_HTML.split("__TITLE__").join(escHtml(f.name)).split("__SIZE__").join(human(f.size)).split("__DATA__").join(data);
}

// ------------------------------------------------------------------ admin API
async function state(env) {
  const s = await getSettings(env, true);
  const perBot = {}, perCh = {}, perProj = {};
  const cr = (await env.DB.prepare("SELECT bot, ch, COUNT(*) AS c, SUM(size) AS b FROM chunks GROUP BY bot, ch").all()).results;
  for (const r of cr) {
    const bb = (perBot[String(r.bot)] = perBot[String(r.bot)] || { chunks: 0, bytes: 0 });
    bb.chunks += r.c;
    bb.bytes += r.b || 0;
    const ch = String(r.ch || botChannel(s, r.bot));
    const pc = (perCh[ch] = perCh[ch] || { chunks: 0, bytes: 0 });
    pc.chunks += r.c;
    pc.bytes += r.b || 0;
  }
  const fr = (await env.DB.prepare("SELECT project, COUNT(*) AS c, SUM(stored) AS b FROM files GROUP BY project").all()).results;
  let nfiles = 0, nbytes = 0, nchunks = 0;
  for (const r of fr) {
    perProj[r.project] = { files: r.c, bytes: r.b || 0 };
    nfiles += r.c;
    nbytes += r.b || 0;
  }
  for (const r of cr) nchunks += r.c;
  const t = Date.now();
  const bots = Object.entries(s.bots || {}).map(([bid, b]) => {
    const st = POOL.stat.get(bid) || {};
    return { id: bid, name: b.name || bid, enabled: b.enabled !== false, channel: String(b.channel || s.channel),
      chunks: (perBot[bid] || {}).chunks || 0, bytes: (perBot[bid] || {}).bytes || 0,
      cooling: Math.max(Math.round(((POOL.until.get(bid) || 0) - t) / 1000), 0), ok: st.ok || 0, err: st.err || 0, last_err: st.last_err || "" };
  });
  const chans = { [String(s.channel)]: { bots: 0, enabled: 0 } };
  for (const b of bots) {
    const c = (chans[b.channel] = chans[b.channel] || { bots: 0, enabled: 0 });
    c.bots++;
    if (b.enabled) c.enabled++;
  }
  const channels = Object.entries(chans).map(([cid, c]) => ({ id: cid, main: cid === String(s.channel), bots: c.bots, enabled: c.enabled,
    chunks: (perCh[cid] || {}).chunks || 0, bytes: (perCh[cid] || {}).bytes || 0 }));
  const projects = Object.entries(s.projects || {}).map(([pid, p]) => ({ id: pid, name: p.name, key: p.key, created: p.created || 0,
    files: (perProj[pid] || {}).files || 0, bytes: (perProj[pid] || {}).bytes || 0, db: null }));
  if (env.SQLDB) {
    const recs = (await env.DB.prepare("SELECT k, v FROM kv WHERE k LIKE 'sqldb:%'").all()).results;
    await Promise.all(recs.map(async (r) => {
      const p = projects.find((x) => x.id === r.k.slice(6));
      if (!p) return;
      const rec = JSON.parse(r.v);
      let inf = {};
      try { inf = (await dbCall(env, p.id, "/info"))[1]; } catch (e) { /* ignore */ }
      p.db = { size: inf.size || rec.size || 0, dirty: !!inf.dirty, synced: rec.at || 0, error: inf.error || "" };
    }));
  }
  const rev = parseInt((await kvGet(env, "rev")) || "0", 10);
  const bk = JSON.parse((await kvGet(env, "backup")) || "{}");
  const ds = JSON.parse((await kvGet(env, "delstate")) || "{}");
  const pend = (await env.DB.prepare("SELECT COUNT(*) AS c FROM pending").first()).c;
  return { configured: true, authed: true, channel: s.channel, bots, channels, default_pw: (await kvGet(env, "defpw")) === "1", projects,
    totals: { files: nfiles, bytes: nbytes, chunks: nchunks }, rev, backed_rev: bk.rev == null ? -1 : bk.rev,
    backup_age: bk.at ? Math.round((t - bk.at) / 1000) : null, backup_ok: bk.ok == null ? null : !!bk.ok,
    uptime: Math.round((t - START) / 1000), del_fail: ds.fail || 0, del_err: ds.err || "", pending_del: pend,
    chunk_mb: Math.round(CHUNK(env) / 1048576), chunk_bytes: CHUNK(env), max_file: MAX_FILE(env), up_par: parseInt(env.UP_PAR || "3", 10) };
}

const ownChannel = (s, b) => String(b.channel || s.channel);
function lastBotOfMain(s, bid, onlyEnabled) {
  const me = s.bots[bid];
  if (String(me.channel || s.channel) !== String(s.channel)) return false;
  return !Object.entries(s.bots).some(([k, x]) => k !== bid && (!onlyEnabled || x.enabled !== false) && String(x.channel || s.channel) === String(s.channel));
}

async function adminAction(env, ctx, path, b) {
  const s = await getSettings(env, true);
  if (path === "/api/password") {
    if (!(await checkPw(String(b.old || ""), s.admin_hash))) throw new ApiError(400, "old password is wrong");
    const nw = String(b.new || "");
    if (nw.length < 6) throw new ApiError(400, "new password must be at least 6 characters");
    s.admin_hash = await hashPw(nw);
    await saveSettings(env, s);
    await kvSet(env, "defpw", "0");
    await backupManifest(env, true);
    return { ok: true };
  }
  if (path === "/api/sql" || path === "/api/db/sync") {
    const pid = String(b.project || "");
    if (!(s.projects || {})[pid]) throw new ApiError(404, "unknown project");
    const [c, j] = path === "/api/sql" ? await dbCall(env, pid, "/run", b) : await dbCall(env, pid, "/sync");
    if (c !== 200) throw new ApiError(c, j.error || "sql failed");
    return j;
  }
  if (path.startsWith("/api/url/")) throw new ApiError(501, "Upload from link is not available in the Worker version (a Worker cannot run long background downloads)");
  if (path === "/api/file/share") {
    const fid = String(b.id || ""), mode = String(b.mode || "get");
    const f = await env.DB.prepare("SELECT * FROM files WHERE id = ?").bind(fid).first();
    if (!f || !f.done) throw new ApiError(404, "unknown or unfinished file");
    if (mode === "off") await env.DB.batch([env.DB.prepare("UPDATE files SET share = NULL WHERE id = ?").bind(fid), revStmt(env)]);
    else if (mode === "reset") await env.DB.batch([env.DB.prepare("UPDATE files SET share = ? WHERE id = ?").bind(tokenUrlsafe(16), fid), revStmt(env)]);
    else {
      await ensureShare(env, fid);
      await revStmt(env).run();
    }
    autoBackup(env, ctx);
    const nf = await env.DB.prepare("SELECT share FROM files WHERE id = ?").bind(fid).first();
    return { ok: true, share: nf.share || null };
  }
  if (path === "/api/cleanup") {
    const r = await cleanupPending(env);
    const ds = JSON.parse((await kvGet(env, "delstate")) || "{}");
    return { ok: r.left === 0, deleted: r.done, left: r.left, error: ds.err || "" };
  }
  if (path === "/api/backup") {
    const ok = await backupManifest(env, true);
    return { ok: !!ok };
  }
  if (path === "/api/bot/add") {
    const tok = String(b.token || "").trim();
    let ch = String(b.channel || "").trim() || s.channel;
    const me = await tg(env, tok, "getMe");
    const bid = String(me.id);
    if (s.bots[bid]) throw new ApiError(400, "this bot is already added (use 'Update token' to change its token)");
    try {
      ch = String((await tg(env, tok, "getChat", { chat_id: ch })).id || ch);
    } catch (e) {
      if (e instanceof TGError) throw new ApiError(400, `channel ${ch}: ${e.desc || e.message} (add the bot to that channel as admin first)`);
      throw e;
    }
    const warns = await checkAdmin(env, tok, ch, me.id);
    s.bots[bid] = { token: tok, name: me.username || bid, enabled: true, channel: ch };
    await saveSettings(env, s);
    await backupManifest(env, true);
    return { ok: true, warnings: warns };
  }
  if (["/api/bot/token", "/api/bot/toggle", "/api/bot/remove"].includes(path)) {
    const bid = String(b.id || "");
    if (!s.bots[bid]) throw new ApiError(404, "unknown bot");
    if (path === "/api/bot/token") {
      const tok = String(b.token || "").trim();
      const me = await tg(env, tok, "getMe");
      if (String(me.id) !== bid) throw new ApiError(400, "this token belongs to a different bot (use 'Add bot')");
      s.bots[bid].token = tok;
      s.bots[bid].name = me.username || bid;
      await saveSettings(env, s);
      await backupManifest(env, true);
      return { ok: true, warnings: await checkAdmin(env, tok, botChannel(s, bid), me.id) };
    }
    if (path === "/api/bot/toggle") {
      if (s.bots[bid].enabled !== false && lastBotOfMain(s, bid, true))
        throw new ApiError(400, "this is the last enabled bot of the main channel (it sends the manifest backup). Enable or add another main-channel bot first.");
      s.bots[bid].enabled = s.bots[bid].enabled === false;
      await saveSettings(env, s);
      await backupManifest(env, true);
      return { ok: true };
    }
    if (lastBotOfMain(s, bid, false))
      throw new ApiError(400, "this is the last bot of the main channel (it keeps the manifest backup). Add another bot to the main channel first.");
    const used = (await env.DB.prepare("SELECT COUNT(*) AS c FROM chunks WHERE bot = ?").bind(bid).first()).c;
    if (used) throw new ApiError(400, `this bot holds ${used} stored chunks; removing it would make those files unreadable. Disable it instead (it stays readable, gets no new uploads).`);
    delete s.bots[bid];
    await saveSettings(env, s);
    await backupManifest(env, true);
    return { ok: true };
  }
  if (path === "/api/project/create") {
    const name = String(b.name || "").trim().slice(0, 60);
    if (!name) throw new ApiError(400, "give the project a name");
    const pid = randHex(4);
    s.projects = s.projects || {};
    s.projects[pid] = { name, key: tokenUrlsafe(24), created: now() };
    await saveSettings(env, s);
    await backupManifest(env, true);
    return { ok: true, id: pid };
  }
  if (path === "/api/project/rotate" || path === "/api/project/delete") {
    const pid = String(b.id || "");
    if (!(s.projects || {})[pid]) throw new ApiError(404, "unknown project");
    if (path === "/api/project/rotate") {
      s.projects[pid].key = tokenUrlsafe(24);
      await saveSettings(env, s);
      await backupManifest(env, true);
      return { ok: true };
    }
    const ents = (await env.DB.prepare("SELECT c.bot, c.ch, c.msg FROM chunks c JOIN files f ON f.id = c.fid WHERE f.project = ?").bind(pid).all()).results;
    const nfiles = (await env.DB.prepare("SELECT COUNT(*) AS c FROM files WHERE project = ?").bind(pid).first()).c;
    await env.DB.batch([
      env.DB.prepare("DELETE FROM chunks WHERE fid IN (SELECT id FROM files WHERE project = ?)").bind(pid),
      env.DB.prepare("DELETE FROM files WHERE project = ?").bind(pid),
    ]);
    delete s.projects[pid];
    await saveSettings(env, s);
    await deleteMsgs(env, ents);
    const srec = JSON.parse((await kvGet(env, "sqldb:" + pid)) || "null");
    if (env.SQLDB) { try { await dbCall(env, pid, "/wipe"); } catch (e) { console.log("sql wipe:", e && e.message); } }
    if (srec) {
      await deleteMsgs(env, (srec.parts || []).map((p) => ({ bot: p.bot, ch: p.ch, msg: p.msg })));
      await env.DB.prepare("DELETE FROM kv WHERE k = ?").bind("sqldb:" + pid).run();
    }
    await backupManifest(env, true);
    return { ok: true, deleted_files: nfiles };
  }
  if (path === "/api/file/delete") {
    const fid = String(b.id || "");
    if (!(await env.DB.prepare("SELECT id FROM files WHERE id = ?").bind(fid).first())) throw new ApiError(404, "unknown file");
    await deleteFile(env, ctx, fid, null);
    return { ok: true };
  }
  throw new ApiError(404, "unknown action");
}

async function deleteFile(env, ctx, fid, pid) {
  const f = await env.DB.prepare("SELECT id, project FROM files WHERE id = ?").bind(fid).first();
  if (!f || (pid != null && f.project !== pid)) return false;
  const ents = (await env.DB.prepare("SELECT bot, ch, msg FROM chunks WHERE fid = ?").bind(fid).all()).results;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM chunks WHERE fid = ?").bind(fid),
    env.DB.prepare("DELETE FROM files WHERE id = ?").bind(fid),
    revStmt(env),
  ]);
  await deleteMsgs(env, ents);
  ctx.waitUntil(backupManifest(env, true).catch((e) => console.log("backup:", e.message)));
  return true;
}

async function readJson(req, limit) {
  const n = parseInt(req.headers.get("Content-Length") || "0", 10);
  if (n > (limit || 200000)) throw new ApiError(400, "body too large");
  const txt = await req.text();
  if (txt.length > (limit || 200000)) throw new ApiError(400, "body too large");
  return JSON.parse(txt || "{}");
}

async function apiRoute(env, ctx, req, url, path) {
  const ip = (req.headers.get("CF-Connecting-IP") || req.headers.get("X-Forwarded-For") || "?").split(",")[0].trim();
  const method = req.method;
  const s = await getSettings(env);
  if (path === "/api/state" && method === "GET") {
    if (!configured(s)) return json(200, { configured: false, authed: false });
    if (!(await isAdmin(req, s))) return json(200, { configured: true, authed: false });
    return json(200, await state(env));
  }
  if (path === "/api/setup" && method === "POST") {
    if (configured(s)) return err(400, "already set up");
    const b = await readJson(req);
    try {
      const r = await doSetup(env, String(b.password || ""), String(b.channel_id || ""), String(b.token || ""));
      const s2 = await getSettings(env, true);
      const extra = r.restored ? undefined : cookieHeader(url, await makeCookie(s2), 30 * 86400);
      return json(200, { ok: true, restored: r.restored, warnings: r.warnings }, extra);
    } catch (e) {
      if (e instanceof ApiError) return err(e.code, e.message);
      throw e;
    }
  }
  if (path === "/api/restore" && method === "POST") {
    if (configured(s)) return err(400, "already set up");
    const n = parseInt(req.headers.get("Content-Length") || "0", 10);
    if (!(n > 0) || n > 30000000) return err(400, "bad backup file");
    let d;
    try {
      let raw = new Uint8Array(await req.arrayBuffer());
      if (raw[0] === 0x1f && raw[1] === 0x8b) raw = await gunzip(raw);
      d = JSON.parse(dec.decode(raw));
      const st = d.settings;
      if (!(st.channel && st.admin_hash && st.secret && st.bots)) throw new Error("incomplete");
      d.files = d.files || {};
      d.rev = d.rev || 0;
      st.projects = st.projects || {};
      for (const b2 of Object.values(st.bots)) if (!b2.channel) b2.channel = st.channel;
    } catch (e) {
      return err(400, "this is not a valid backup file");
    }
    await importAll(env, d);
    await kvSet(env, "defpw", "0");
    try {
      await backupManifest(env, true);
    } catch (e) {
      console.log("backup after restore failed:", e.message);
    }
    return json(200, { ok: true });
  }
  if (path === "/api/login" && method === "POST") {
    if (!configured(s)) return err(400, "not set up yet");
    if (throttled(ip)) return err(429, "too many wrong passwords, wait 10 minutes");
    const b = await readJson(req);
    if ((await checkPw(String(b.password || ""), s.admin_hash)) || (await envPwLogin(env, s, b.password))) return json(200, { ok: true }, cookieHeader(url, await makeCookie(s), 30 * 86400));
    throttled(ip, true);
    return err(401, "wrong password");
  }
  if (!(await isAdmin(req, s))) return err(401, "login required");
  if (path === "/api/logout") return json(200, { ok: true }, cookieHeader(url, "", 0));
  if (path === "/api/upload" && (method === "POST" || method === "PUT")) {
    const pid = url.searchParams.get("project") || "";
    if (!(s.projects || {})[pid]) return err(400, "choose a project");
    return handleUpload(env, ctx, req, url, pid);
  }
  if (path.startsWith("/api/status/") && method === "GET") {
    const f = await getFileRow(env, path.slice(12));
    return f ? json(200, await statusInfo(env, f)) : err(404, "unknown id");
  }
  if (path === "/api/files" && method === "GET") {
    const pid = url.searchParams.get("project") || "";
    const rows = pid
      ? (await env.DB.prepare(`${FILE_SELECT} WHERE f.project = ? ORDER BY f.created DESC LIMIT 3000`).bind(pid).all()).results
      : (await env.DB.prepare(`${FILE_SELECT} ORDER BY f.created DESC LIMIT 3000`).all()).results;
    return json(200, rows.map((f) => info(f)));
  }
  if (path === "/api/backup/download" && method === "GET") {
    const { data, rev } = await buildManifest(env);
    const snap = await gzip(enc.encode(JSON.stringify(data)));
    return send(200, snap, "application/gzip", { "Content-Disposition": `attachment; filename="tgstore-backup-rev${rev}.json.gz"`, "Cache-Control": "no-store" });
  }
  if (method !== "POST") return err(404, "not found");
  const b = await readJson(req);
  try {
    return json(200, await adminAction(env, ctx, path, b));
  } catch (e) {
    if (e instanceof ApiError) return err(e.code, e.message);
    if (e instanceof TGError) return err(502, `Telegram: ${e.desc || e.message}`);
    throw e;
  }
}

async function projectRoute(env, ctx, req, url, path) {
  const m = /^\/p\/([^/]+)(\/.*)?$/.exec(path);
  const pid = m ? await projectByKey(env, m[1]) : null;
  if (!pid) return err(404, "unknown project link");
  const sub = m[2] || "/";
  const method = req.method;
  const s = await getSettings(env);
  if (sub === "/" && method === "GET") {
    const r = await env.DB.prepare("SELECT COUNT(*) AS c, COALESCE(SUM(stored), 0) AS b FROM files WHERE project = ?").bind(pid).first();
    return json(200, { project: s.projects[pid].name, files: r.c, bytes: r.b });
  }
  if (sub === "/sql" && method === "POST") {
    const body = await readJson(req, 30000000).catch((e) => { throw e instanceof ApiError ? e : new ApiError(400, "bad json"); });
    return runSql(env, pid, body);
  }
  if (sub === "/db" && method === "GET") { const [c, j] = await dbCall(env, pid, "/info"); return json(c, j); }
  if (sub === "/db/sync" && method === "POST") { const [c, j] = await dbCall(env, pid, "/sync"); return json(c, j); }
  if (sub === "/olddb" && method === "GET") return oldDb(env, ctx, pid, url);
  if (sub === "/upload" && (method === "POST" || method === "PUT")) return handleUpload(env, ctx, req, url, pid);
  if (sub === "/files" && method === "GET") {
    const rows = (await env.DB.prepare(`${FILE_SELECT} WHERE f.project = ? ORDER BY f.created DESC LIMIT 3000`).bind(pid).all()).results;
    return json(200, rows.map((f) => info(f)));
  }
  if (sub.startsWith("/status/") && method === "GET") {
    const f = await getFileRow(env, sub.slice(8));
    if (f && f.project === pid) return json(200, await statusInfo(env, f));
    return err(404, "unknown id");
  }
  if (sub.startsWith("/file/")) {
    const fid = sub.slice(6);
    if (method === "GET" || method === "HEAD") return sendFile(env, ctx, req, fid, pid, false);
    if (method === "DELETE") return (await deleteFile(env, ctx, fid, pid)) ? json(200, { deleted: fid }) : err(404, "unknown id");
  }
  return err(404, "not found");
}

async function route(req, env, ctx) {
  await ensureSchema(env);
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;
  if (path === "/health") return json(200, { ok: true });
  if (path === "/sw.js") return send(200, SW_JS, "application/javascript; charset=utf-8", { "Service-Worker-Allowed": "/", "Cache-Control": "no-cache" });
  if (path === "/xdl") {
    // normally the service worker answers this; without it, fall back to a plain (single response) download
    const t = url.searchParams.get("u") || "";
    if (!/^\/(dl|s)\/[^\/\\]/.test(t) || t.includes("//")) return err(400, "bad link");
    return new Response(null, { status: 302, headers: { Location: t } });
  }
  await ensureSetupFromEnv(env);
  if ((method === "GET" || method === "HEAD") && path === "/") return send(200, DASH_HTML, "text/html; charset=utf-8", { "Cache-Control": "no-store" });
  if (path.startsWith("/p/")) return projectRoute(env, ctx, req, url, path);
  if (path.startsWith("/api/")) {
    if (req.headers.get("X-Dash") !== "1") return err(403, "missing X-Dash header");
    return apiRoute(env, ctx, req, url, path);
  }
  if ((path.startsWith("/v/") || path.startsWith("/s/")) && (method === "GET" || method === "HEAD")) {
    const tok = path.slice(3).split("/")[0];
    const f = tok ? await env.DB.prepare("SELECT * FROM files WHERE share = ? AND done = 1").bind(tok).first() : null;
    if (!f) return err(404, "link not found or switched off");
    if (path.startsWith("/v/")) return send(200, playerPage(f, tok), "text/html; charset=utf-8", { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
    return sendFile(env, ctx, req, f.id, null, url.searchParams.has("dl"));
  }
  if (path.startsWith("/dl/") && (method === "GET" || method === "HEAD")) {
    const s = await getSettings(env);
    if (!(await isAdmin(req, s))) return err(401, "login required");
    return sendFile(env, ctx, req, path.slice(4), null, false);
  }
  return err(404, "not found");
}

// ------------------------------------------------------------------ SQL: one Durable Object (real SQLite) per project
// POST /p/KEY/sql {"sql":"...","params":[...]} | {"batch":[{sql,params},...]} (one transaction) | {"script":"..."} ; "sync":true = back up now.
// The live database is inside the Durable Object. Changes are dumped (gzip JSON) to the Telegram channel a few
// seconds later; if the Durable Object is ever empty, it restores itself from that backup (kept in the pinned manifest).
class BadReq extends Error {}
const toB64 = (u8) => { let s = ""; for (let i = 0; i < u8.length; i += 8192) s += String.fromCharCode.apply(null, u8.subarray(i, i + 8192)); return btoa(s); };
const fromB64 = (s) => { const b = atob(s), u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; };
const sqlEnc = (v) => (v instanceof ArrayBuffer ? { $blob: toB64(new Uint8Array(v)) } : v);
const sqlDec = (v) => (v && typeof v === "object" && typeof v.$blob === "string" ? fromB64(v.$blob).buffer : v === true ? 1 : v === false ? 0 : v);
const sqlQ = (n) => '"' + String(n).replace(/"/g, '""') + '"';
const jd = (code, obj) => new Response(JSON.stringify(obj), { status: code, headers: { "Content-Type": "application/json" } });

// split a script (sqlite3 .dump style) into single statements; triggers end at END;
function splitSql(text) {
  const out = [];
  let cur = "", q = "", i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (q) {
      cur += c;
      if (c === q) { if (text[i + 1] === q) { cur += q; i++; } else q = ""; }
    } else if (c === "'" || c === '"' || c === "`") { q = c; cur += c; }
    else if (c === "-" && text[i + 1] === "-") { while (i < n && text[i] !== "\n") i++; continue; }
    else if (c === "/" && text[i + 1] === "*") { const e = text.indexOf("*/", i + 2); i = e < 0 ? n : e + 2; continue; }
    else if (c === ";") {
      const t = cur.trim();
      if (/^create\s+(temp\s+|temporary\s+)?trigger\b/i.test(t) && !/\bend$/i.test(t)) cur += c;
      else { if (t) out.push(t); cur = ""; }
    } else cur += c;
    i++;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export class ProjDB {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sql = state.storage.sql;
    this.pid = null;
    this.initP = null;
  }
  async remember(pid) {
    if (pid && this.pid !== pid) { this.pid = pid; await this.state.storage.put("pid", pid); }
    if (!this.pid) this.pid = (await this.state.storage.get("pid")) || null;
  }
  async fetch(req) {
    const p = new URL(req.url).pathname;
    try {
      await this.remember(req.headers.get("x-pid"));
      if (!this.pid) throw new BadReq("missing project");
      if (p === "/info") return jd(200, await this.info());
      if (p === "/wipe") { await this.wipe(); return jd(200, { ok: true }); }
      if (p === "/sync") { const ok = await this.backup(true); return jd(200, { synced: ok, error: (await this.state.storage.get("err")) || "" }); }
      if (p === "/dump") { await this.ensureInit(); return jd(200, this.dump()); }
      if (p === "/run") {
        const body = await req.json();
        await this.ensureInit();
        const res = await this.run(body);
        if (body && body.sync) {
          res.synced = await this.backup(true);
          if (!res.synced) res.sync_error = (await this.state.storage.get("err")) || "";
        }
        return jd(200, res);
      }
      return jd(404, { error: "not found" });
    } catch (e) {
      if (e instanceof BadReq) return jd(400, { error: e.message });
      if (e instanceof TGError) return jd(502, { error: "Telegram: " + (e.desc || e.message) });
      console.log("sql error:", e && e.message);
      return jd(400, { error: "sql: " + ((e && e.message) || e) });
    }
  }
  // first use: empty Durable Object -> restore the Telegram backup if there is one
  ensureInit() {
    if (!this.initP) {
      this.initP = (async () => {
        if (await this.state.storage.get("init")) return;
        const rec = JSON.parse((await kvGet(this.env, "sqldb:" + this.pid)) || "null");
        if (rec && rec.parts && rec.parts.length) await this.restore(rec);
        await this.state.storage.put("init", 1);
      })().catch((e) => { this.initP = null; throw e; });
    }
    return this.initP;
  }
  async restore(rec) {
    const s = await getSettings(this.env, true);
    const bufs = [];
    let total = 0;
    for (const p of rec.parts) {
      const path = await filePath(this.env, s, { bot: p.bot, tgid: p.fid }, true);
      const r = await fetch(`${TG(this.env)}/file/bot${s.bots[String(p.bot)].token}/${path}`);
      if (!r.ok) throw new TGError(r.status, "cannot download the SQL backup part " + p.n);
      const u = new Uint8Array(await r.arrayBuffer());
      bufs.push(u);
      total += u.length;
    }
    const all = new Uint8Array(total);
    let o = 0;
    for (const u of bufs) { all.set(u, o); o += u.length; }
    this.load(JSON.parse(dec.decode(await gunzip(all))));
    console.log(`sql ${this.pid}: restored from Telegram (${human(total)})`);
  }
  async run(req) {
    if (!req || typeof req !== "object" || Array.isArray(req)) throw new BadReq("body must be a JSON object");
    const max = SQL_MAX_ROWS(this.env);
    let wrote = false;
    const one = (it) => {
      if (!it || typeof it !== "object") throw new BadReq("each batch item must be an object");
      const q = String(it.sql || "");
      if (!q.trim()) throw new BadReq("sql is empty");
      const prm = it.params == null ? [] : it.params;
      if (!Array.isArray(prm)) throw new BadReq("params must be a list (use ? placeholders; named params are not supported in the Worker version)");
      const cur = this.sql.exec(q, ...prm.map(sqlDec));
      const cols = cur.columnNames || [];
      const rows = [];
      let trunc = false;
      if (cols.length) {
        for (const r of cur.raw()) {
          if (rows.length >= max) { trunc = true; break; }
          rows.push(r.map(sqlEnc));
        }
      } else cur.toArray();
      const isRead = /^\s*(select|with|explain|values|pragma)\b/i.test(q);
      let changes = 0, lastId = null;
      if (!isRead || (cur.rowsWritten || 0) > 0) {
        wrote = true;
        try { const x = this.sql.exec("SELECT changes(), last_insert_rowid()").raw().next().value; changes = x[0]; lastId = x[1]; } catch (e) { /* ignore */ }
      }
      return { columns: cols, rows, rowcount: cols.length ? rows.length : changes, last_id: lastId, truncated: trunc };
    };
    let res;
    const st = this.state.storage;
    if (req.script != null) {
      const stmts = splitSql(String(req.script).replace(/^\s*(BEGIN(\s+TRANSACTION)?|COMMIT|END(\s+TRANSACTION)?)\s*;\s*$/gim, "").replace(/^\s*PRAGMA\s+foreign_keys\s*=\s*\w+\s*;\s*$/gim, ""));
      st.transactionSync(() => { try { this.sql.exec("PRAGMA defer_foreign_keys = ON"); } catch (e) { /* ignore */ } for (const q of stmts) this.sql.exec(q).toArray(); });
      wrote = true;
      res = { ok: true, statements: stmts.length };
    } else if (req.batch != null) {
      if (!Array.isArray(req.batch) || !req.batch.length) throw new BadReq("batch must be a non-empty list");
      res = { results: st.transactionSync(() => req.batch.map(one)) };
    } else res = one(req);
    if (wrote) await this.afterWrite();
    return res;
  }
  async afterWrite() {
    const st = this.state.storage;
    await st.put("dirty", 1);
    if ((await st.getAlarm()) == null) await st.setAlarm(Date.now() + SQL_SYNC_SECS(this.env) * 1000);
  }
  async alarm() {
    await this.remember(null);
    try { await this.backup(false); } catch (e) { console.log("sql backup:", e && e.message); }
  }
  dump() {
    const objs = this.sql.exec("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'").toArray();
    const out = { v: 1, schema: objs, data: {}, seq: [] };
    for (const t of objs.filter((o) => o.type === "table")) {
      const cur = this.sql.exec(`SELECT * FROM ${sqlQ(t.name)}`);
      out.data[t.name] = { cols: cur.columnNames, rows: [...cur.raw()].map((r) => r.map(sqlEnc)) };
    }
    try { out.seq = this.sql.exec("SELECT name, seq FROM sqlite_sequence").toArray(); } catch (e) { /* no autoincrement tables */ }
    return out;
  }
  load(d) {
    this.state.storage.transactionSync(() => {
      try { this.sql.exec("PRAGMA defer_foreign_keys = ON"); } catch (e) { /* ignore */ }
      for (const o of d.schema.filter((x) => x.type === "table")) this.sql.exec(o.sql);
      for (const [name, t] of Object.entries(d.data || {})) {
        if (!t.rows.length) continue;
        const ins = `INSERT INTO ${sqlQ(name)} (${t.cols.map(sqlQ).join(",")}) VALUES (${t.cols.map(() => "?").join(",")})`;
        for (const r of t.rows) this.sql.exec(ins, ...r.map(sqlDec));
      }
      for (const o of d.schema.filter((x) => x.type !== "table")) this.sql.exec(o.sql); // indexes, views, triggers last
      for (const q of d.seq || []) { try { this.sql.exec("INSERT OR REPLACE INTO sqlite_sequence(name, seq) VALUES(?, ?)", q.name, q.seq); } catch (e) { /* ignore */ } }
    });
  }
  async backup(force) {
    const st = this.state.storage;
    if (!force && !(await st.get("dirty"))) return true;
    if (force && !(await st.get("dirty")) && (await st.get("synced"))) return true;
    const s = await getSettings(this.env, true);
    if (!s.projects || !s.projects[this.pid]) { await this.wipe(); return true; } // project was deleted
    await st.put("dirty", 0); // writes that arrive while we upload mark it dirty again
    try {
      const gz = await gzip(enc.encode(JSON.stringify(this.dump())));
      await pushDbBackup(this.env, this.pid, gz, { size: this.sql.databaseSize || 0 });
      await st.put("synced", Date.now());
      await st.put("err", "");
      if (await st.get("dirty")) await st.setAlarm(Date.now() + SQL_SYNC_SECS(this.env) * 1000);
      return true;
    } catch (e) {
      await st.put("dirty", 1);
      await st.put("err", String((e && (e.desc || e.message)) || e).slice(0, 160));
      await st.setAlarm(Date.now() + 60000);
      console.log("sql backup failed:", e && e.message);
      return false;
    }
  }
  async info() {
    const st = this.state.storage;
    let size = 0;
    try { size = this.sql.databaseSize || 0; } catch (e) { /* ignore */ }
    return { init: !!(await st.get("init")), size, dirty: !!(await st.get("dirty")), synced: Math.round(((await st.get("synced")) || 0) / 1000), error: (await st.get("err")) || "" };
  }
  async wipe() {
    try { await this.state.storage.deleteAlarm(); } catch (e) { /* ignore */ }
    await this.state.storage.deleteAll();
    this.initP = null;
  }
}

// upload the gzip dump as 1..n Telegram documents, record it, then delete the previous backup messages
async function pushDbBackup(env, pid, gz, extra) {
  const s = await getSettings(env, true);
  const old = JSON.parse((await kvGet(env, "sqldb:" + pid)) || "null") || {};
  const csz = CHUNK(env), fid = "sqldb_" + pid;
  const parts = [];
  try {
    for (let i = 0, n = Math.max(1, Math.ceil(gz.length / csz)); i < n; i++) parts.push(await sendChunk(env, s, fid, i, gz.subarray(i * csz, (i + 1) * csz)));
  } catch (e) {
    await deleteMsgs(env, parts);
    throw e;
  }
  const rec = Object.assign({ at: now(), gz: gz.length }, extra || {}, {
    parts: parts.map((p) => ({ n: p.n, bot: Number(p.bot) || p.bot, ch: p.ch, msg: p.msg, fid: p.tgid, size: p.size })),
  });
  await env.DB.batch([kvSetStmt(env, "sqldb:" + pid, JSON.stringify(rec)), revStmt(env)]);
  // the pinned manifest must point at the new parts BEFORE the old ones are deleted (it is what restores everything after a wipe)
  try { await backupManifest(env, true); } catch (e) { console.log("manifest backup after sql backup:", e && e.message); }
  await deleteMsgs(env, (old.parts || []).map((p) => ({ bot: p.bot, ch: p.ch, msg: p.msg })));
  return rec;
}

async function dbCall(env, pid, path, body) {
  if (!env.SQLDB) throw new ApiError(501, "SQL needs the Durable Object binding SQLDB (see wrangler.toml)");
  const stub = env.SQLDB.get(env.SQLDB.idFromName("p:" + pid));
  const r = await stub.fetch("https://sql.internal" + path, {
    method: "POST", headers: { "Content-Type": "application/json", "x-pid": pid }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({ error: "bad reply from the SQL object" }));
  return [r.status, j];
}
const runSql = async (env, pid, body) => { const [c, j] = await dbCall(env, pid, "/run", body); return json(c, j); };

// the OLD app kept each project's sqlite file as 1 MB blocks in Telegram (manifest "dbs"). This hands those blocks
// back as the original .sqlite file (a few MB per request; client.py "olddb" loops) so it can be dumped and imported.
async function oldDb(env, ctx, pid, url) {
  const d = (JSON.parse((await kvGet(env, "dbs")) || "{}") || {})[pid];
  const blocks = (d && d.blocks) || [];
  if (!blocks.length) return err(404, "no old SQL database found for this project");
  const from = Math.max(parseInt(url.searchParams.get("from") || "0", 10) || 0, 0);
  if (from >= blocks.length) return err(416, "no more blocks");
  const to = Math.min(from + MAX_CHUNKS(env), blocks.length);
  const sel = blocks.slice(from, to);
  const total = sel.reduce((a, b) => a + (b.size || 0), 0);
  const s = await getSettings(env);
  const { readable, writable } = typeof FixedLengthStream !== "undefined" ? new FixedLengthStream(total) : new TransformStream();
  ctx.waitUntil((async () => {
    try {
      for (const b of sel) {
        const { body } = await openChunk2(env, s, { bot: b.bot, tgid: b.fid, size: b.size }, 0, b.size);
        await body.pipeTo(writable, { preventClose: true, preventAbort: true });
      }
      await writable.close();
    } catch (e) {
      console.log("olddb stream stopped:", e && e.message);
      try { await writable.abort(e); } catch (x) { /* ignore */ }
    }
  })());
  return new Response(readable, { status: 200, headers: { "Content-Type": "application/octet-stream", "Content-Length": String(total),
    "X-Next-Block": to < blocks.length ? String(to) : "", "X-Blocks": String(blocks.length) } });
}

export default {
  async fetch(req, env, ctx) {
    try {
      return await route(req, env, ctx);
    } catch (e) {
      if (e instanceof ApiError) return err(e.code, e.message);
      console.log("handler error:", e && e.stack ? e.stack : e);
      return err(500, "server error");
    }
  },
};
