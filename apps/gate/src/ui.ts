export const ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="96" fill="#000"/><circle cx="256" cy="270" r="120" fill="none" stroke="#fff" stroke-width="28"/><path d="M256 150v240M136 270h240M190 160l-40-50M322 160l40-50" stroke="#fff" stroke-width="28" stroke-linecap="round"/></svg>`;

export const MANIFEST = JSON.stringify({ name: "Deploy Bug", short_name: "Deploy Bug", start_url: "/", display: "standalone", background_color: "#000000", theme_color: "#000000", icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any maskable" }] });

export const DASHBOARD = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#000000"><link rel="manifest" href="/manifest.webmanifest"><link rel="icon" href="/icon.svg"><title>Deploy Bug</title>
<style>
:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;background:#000;color:#fff;font:15px/1.45 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;padding:max(16px,env(safe-area-inset-top)) 16px 32px}
header{display:flex;align-items:center;gap:10px;margin-bottom:18px}header img{width:34px;height:34px}h1{font-size:20px;margin:0;letter-spacing:-.02em}.sub{color:#8a8a8a;font-size:13px}
.grid{display:grid;gap:12px;grid-template-columns:1fr}@media(min-width:760px){.grid{grid-template-columns:1fr 1fr}}
.card{border:1px solid #262626;border-radius:16px;padding:14px 16px;background:#0a0a0a}.card h2{font-size:12px;text-transform:uppercase;letter-spacing:.12em;color:#8a8a8a;margin:0 0 10px}
.kpis{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}.kpi{border:1px solid #262626;border-radius:12px;padding:10px}.kpi b{display:block;font-size:22px}.kpi span{color:#8a8a8a;font-size:12px}
.row{display:flex;justify-content:space-between;gap:10px;padding:8px 0;border-top:1px solid #1a1a1a}.row:first-of-type{border-top:0}.muted{color:#8a8a8a}.pill{border:1px solid #fff;border-radius:999px;padding:1px 8px;font-size:12px;white-space:nowrap}.pill.dim{border-color:#444;color:#8a8a8a}
.chips{display:flex;flex-wrap:wrap;gap:6px}.chip{border:1px solid #333;border-radius:999px;padding:4px 10px;font-size:13px}.chip.on{background:#fff;color:#000;border-color:#fff}
#login{max-width:420px;margin:20vh auto;text-align:center}#login p{color:#8a8a8a}
</style></head><body>
<div id="login" hidden><img src="/icon.svg" width="56" alt=""><h1>Deploy Bug</h1><p>Open the one-time link from your phone to sign in.</p></div>
<main id="app" hidden>
<header><img src="/icon.svg" alt=""><div><h1>Deploy Bug</h1><div class="sub" id="sub">Agent firewall</div></div></header>
<div class="grid">
<section class="card"><h2>Status</h2><div class="kpis"><div class="kpi"><b id="k-pending">0</b><span>pending</span></div><div class="kpi"><b id="k-queue">0</b><span>queue</span></div><div class="kpi"><b id="k-runs">0</b><span>open runs</span></div></div><div class="row"><span class="muted">Mode</span><span id="mode" class="pill"></span></div><div class="row"><span class="muted">Telegram</span><span id="tg" class="pill"></span></div></section>
<section class="card"><h2>Connectors</h2><div class="chips" id="conn"></div></section>
<section class="card"><h2>Tickets</h2><div id="tickets"></div></section>
<section class="card"><h2>Recent activity</h2><div id="audit"></div></section>
</div></main>
<script>
const $=id=>document.getElementById(id);const esc=s=>String(s??"").replace(/[&<>"']/g,c=>"&#"+c.charCodeAt(0)+";");
const row=(a,b,dim)=>'<div class="row"><span>'+a+'</span><span class="pill'+(dim?' dim':'')+'">'+b+'</span></div>';
fetch("/ui/data",{credentials:"same-origin"}).then(r=>{if(!r.ok)throw 0;return r.json()}).then(d=>{
$("app").hidden=false;$("sub").textContent=d.workers.length+" workers · "+d.models.brain;
$("k-pending").textContent=d.tickets.filter(t=>t.status==="pending").length;$("k-queue").textContent=d.queue.running+"/"+d.queue.concurrency;$("k-runs").textContent=d.runs.length;
$("mode").textContent=d.dryRun?"dry run":"live";$("tg").textContent=d.telegram?"connected":"off";
$("conn").innerHTML=d.connectors.map(c=>'<span class="chip'+(d.connected.includes(c.slug)?' on':'')+'">'+esc(c.name)+'</span>').join("");
$("tickets").innerHTML=d.tickets.slice(0,12).map(t=>row(esc((t.summary||"").split("\\n")[0].slice(0,60)),esc(t.status),t.status!=="pending")).join("")||'<p class="muted">No tickets</p>';
$("audit").innerHTML=d.audit.slice(0,12).map(a=>row(esc(a.verdict||a.status||Object.keys(a).filter(k=>k!=="at")[0]),esc(new Date(a.at).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})),true)).join("")||'<p class="muted">Nothing yet</p>';
}).catch(()=>{$("login").hidden=false});
</script></body></html>`;
