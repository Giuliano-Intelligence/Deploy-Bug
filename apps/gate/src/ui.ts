export const ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="96" fill="#000"/><circle cx="256" cy="270" r="120" fill="none" stroke="#fff" stroke-width="28"/><path d="M256 150v240M136 270h240M190 160l-40-50M322 160l40-50" stroke="#fff" stroke-width="28" stroke-linecap="round"/></svg>`;

export const MANIFEST = JSON.stringify({ name: "Deploy Bug", short_name: "Deploy Bug", start_url: "/", display: "standalone", background_color: "#000000", theme_color: "#000000", icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any maskable" }] });

export const DASHBOARD = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#000000"><link rel="manifest" href="/manifest.webmanifest"><link rel="icon" href="/icon.svg"><title>Deploy Bug</title>
<link rel="stylesheet" href="https://rsms.me/inter/inter.css"><style>
:root{color-scheme:dark;--b:#1f1f1f;--b2:#2e2e2e;--m:#8a8a8a}*{box-sizing:border-box}html{font-family:Inter,ui-sans-serif,system-ui,sans-serif;font-feature-settings:"cv11","ss01"}
body{margin:0;background:radial-gradient(1200px 600px at 50% -200px,#1a1a1a,#000 60%) fixed;color:#fff;font-size:15px;line-height:1.45;padding:0 16px 40px;-webkit-font-smoothing:antialiased}
header{position:sticky;top:0;z-index:5;display:flex;align-items:center;gap:12px;margin:0 -16px 18px;padding:max(14px,env(safe-area-inset-top)) 16px 14px;background:rgba(0,0,0,.55);backdrop-filter:blur(18px) saturate(1.4);-webkit-backdrop-filter:blur(18px) saturate(1.4);border-bottom:1px solid rgba(255,255,255,.08)}
header img{width:34px;height:34px}h1{font-size:19px;margin:0;letter-spacing:-.025em;font-weight:650}.sub{color:var(--m);font-size:12.5px}
.grid{display:grid;gap:14px;grid-template-columns:1fr;max-width:1100px;margin:0 auto}@media(min-width:760px){.grid{grid-template-columns:1fr 1fr}.wide{grid-column:1/-1}}
.card{border:1px solid var(--b);border-radius:18px;padding:16px;background:linear-gradient(180deg,rgba(255,255,255,.035),rgba(255,255,255,.01))}.card h2{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.14em;color:var(--m);margin:0 0 12px}
.kpis{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:6px}.kpi{border:1px solid var(--b);border-radius:14px;padding:12px}.kpi b{display:block;font-size:24px;font-weight:650;letter-spacing:-.03em}.kpi span{color:var(--m);font-size:12px}
.row{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:10px 0;border-top:1px solid #141414}.row:first-of-type{border-top:0}.muted{color:var(--m)}.pill{border:1px solid #fff;border-radius:999px;padding:2px 9px;font-size:11.5px;font-weight:500;white-space:nowrap}.pill.dim{border-color:#3a3a3a;color:var(--m)}
.tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(104px,1fr));gap:10px}
.tile{min-height:96px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:12px 8px;border:1px solid var(--b);border-radius:16px;background:#0b0b0b;color:#fff;font:inherit;font-size:13px;font-weight:500;cursor:pointer;transition:transform .15s ease,border-color .2s,background .2s;-webkit-tap-highlight-color:transparent}
.tile:hover{border-color:#5a5a5a;background:#111;transform:translateY(-2px)}.tile:active{transform:scale(.96)}
.tile .lg{width:40px;height:40px;border-radius:11px;background:#fff;display:grid;place-items:center}.tile .lg img{width:26px;height:26px;object-fit:contain}
.tile .st{font-size:10.5px;color:var(--m);border:1px solid #2e2e2e;border-radius:999px;padding:1px 8px}.tile.on{border-color:#fff}.tile.on .st{background:#fff;color:#000;border-color:#fff}
#sheet{position:fixed;inset:auto 0 0 0;z-index:9;background:rgba(12,12,12,.9);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);border-top:1px solid var(--b2);border-radius:22px 22px 0 0;padding:20px 18px max(20px,env(safe-area-inset-bottom))}#sheet ol{padding-left:18px}#sheet code{word-break:break-all;background:#1a1a1a;padding:2px 6px;border-radius:6px}#sheet button{min-height:48px;width:100%;border-radius:14px;border:0;background:#fff;color:#000;font:inherit;font-weight:600;margin-top:10px}
#login{max-width:420px;margin:20vh auto;text-align:center}#login p{color:var(--m)}
</style></head><body>
<div id="login" hidden><img src="/icon.svg" width="56" alt=""><h1>Deploy Bug</h1><p>Open the one-time link from your phone to sign in.</p></div>
<main id="app" hidden>
<header><img src="/icon.svg" alt=""><div><h1>Deploy Bug</h1><div class="sub" id="sub">Agent firewall</div></div></header>
<div class="grid">
<section class="card"><h2>Status</h2><div class="kpis"><div class="kpi"><b id="k-pending">0</b><span>pending</span></div><div class="kpi"><b id="k-queue">0</b><span>queue</span></div><div class="kpi"><b id="k-runs">0</b><span>open runs</span></div></div><div class="row"><span class="muted">Mode</span><span id="mode" class="pill"></span></div><div class="row"><span class="muted">Telegram</span><span id="tg" class="pill"></span></div></section>
<section class="card wide"><h2>Connectors</h2><div class="tiles" id="conn"></div></section>
<section class="card"><h2>Tickets</h2><div id="tickets"></div></section>
<section class="card"><h2>Recent activity</h2><div id="audit"></div></section>
</div></main><div id="sheet" hidden></div>
<script>
const $=id=>document.getElementById(id);const esc=s=>String(s??"").replace(/[&<>"']/g,c=>"&#"+c.charCodeAt(0)+";");
const row=(a,b,dim)=>'<div class="row"><span>'+a+'</span><span class="pill'+(dim?' dim':'')+'">'+b+'</span></div>';
fetch("/ui/data",{credentials:"same-origin"}).then(r=>{if(!r.ok)throw 0;return r.json()}).then(d=>{
$("app").hidden=false;$("sub").textContent=d.workers.length+" workers · "+d.models.brain;
$("k-pending").textContent=d.tickets.filter(t=>t.status==="pending").length;$("k-queue").textContent=d.queue.running+"/"+d.queue.concurrency;$("k-runs").textContent=d.runs.length;
$("mode").textContent=d.dryRun?"dry run":"live";$("tg").textContent=d.telegram?"connected":"off";
$("conn").innerHTML=d.connectors.map(c=>{const on=d.connected.includes(c.slug);return '<button class="tile'+(on?' on':'')+'" data-slug="'+esc(c.slug)+'" data-via="'+esc(c.via)+'"><span class="lg"><img loading="lazy" alt="" src="/logo/'+encodeURIComponent(c.slug)+'"></span>'+esc(c.name)+'<span class="st">'+(on?'Connected':c.via==="custom_mcp"?'Setup':'Connect')+'</span></button>'}).join("");
$("conn").onclick=async e=>{const b=e.target.closest("button[data-slug]");if(!b)return;const custom=b.dataset.via==="custom_mcp";const w=custom?null:window.open("about:blank","_blank");
const r=await fetch("/ui/connect/"+encodeURIComponent(b.dataset.slug),{method:"POST",credentials:"same-origin"});const j=await r.json().catch(()=>({}));
if(j.url){if(w)w.location=j.url;else location.href=j.url;return}if(w)w.close();
const s=$("sheet");if(j.setup){s.innerHTML='<h2 style="margin:0 0 8px">'+esc(j.setup.name)+' setup</h2><p class="muted">Endpoint <code>'+esc(j.setup.mcp)+'</code> · '+esc(j.setup.auth)+'</p><ol>'+j.setup.steps.map(x=>'<li>'+esc(x)+'</li>').join("")+'</ol><button id="x">Done</button>'}else{s.innerHTML='<p>'+esc(j.status||j.error||"Could not create a link")+'</p><button id="x">Close</button>'}s.hidden=false;$("x").onclick=()=>s.hidden=true};
$("tickets").innerHTML=d.tickets.slice(0,12).map(t=>row(esc((t.summary||"").split("\\n")[0].slice(0,60)),esc(t.status),t.status!=="pending")).join("")||'<p class="muted">No tickets</p>';
$("audit").innerHTML=d.audit.slice(0,12).map(a=>row(esc(a.verdict||a.status||Object.keys(a).filter(k=>k!=="at")[0]),esc(new Date(a.at).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})),true)).join("")||'<p class="muted">Nothing yet</p>';
}).catch(()=>{$("login").hidden=false});
</script></body></html>`;
