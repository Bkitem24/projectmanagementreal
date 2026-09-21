import { supabase, supabaseConfigured } from './lib/supabaseClient.js';
import { db, randomId } from './lib/db.js';
import { signUp, signIn, signOut, getSession, onAuthStateChange, fetchProfiles } from './lib/auth.js';
import { listTeams, createTeam, assignTeamManager, createInvite, listInvites, listServices, createService, deleteService } from './lib/teams.js';
import { startPresence, stopPresence, isOnline, onPresenceChange } from './lib/presence.js';
import { compressImage } from './lib/imageCompress.js';
import { imageHasFace } from './lib/faceDetect.js';
import { uploadFile, fileUrl, fetchProtectedUrl, downloadProtectedFile, r2Configured } from './lib/r2.js';
import * as timelog from './lib/timelog.js';
import * as musicPlayer from './lib/music.js';
import { MOODS } from './lib/music.js';
import { connectConfigured, listenForConnects, ring, startLocalSession, endSession } from './lib/connect.js';

// ---------- constants ----------
var ROLES = [
  {key:'outreach_va', label:'Outreach Expert/VA', color:'var(--r-outreach_va)'},
  {key:'sr_video_editor', label:'Sr. Video Editor', color:'var(--r-sr_video_editor)'},
  {key:'jr_video_editor', label:'Jr. Video Editor', color:'var(--r-jr_video_editor)'},
  {key:'packaging_expert', label:'Packaging Expert', color:'var(--r-packaging_expert)'},
  {key:'seo_specialist', label:'SEO Content Specialist', color:'var(--r-seo_specialist)'},
  {key:'manager', label:'Manager', color:'var(--r-manager)'},
  {key:'admin', label:'Admin', color:'var(--r-admin)'}
];
var INVITABLE_ROLES = ROLES.filter(function(r){ return r.key!=='manager' && r.key!=='admin'; });
var CLIENT_COLORS = ['#2f8fd1','#3f6b8a','#7a5ea8','#4f8f6b','#b8567a','#a15c2f'];
var WEEKDAY_NAMES = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

function roleOf(key){ for(var i=0;i<ROLES.length;i++){ if(ROLES[i].key===key) return ROLES[i]; } return null; }
function ordinal(n){ if(n===-1) return 'Last'; var s=['','1st','2nd','3rd','4th']; return s[n]||(n+'th'); }
function escapeHtml(s){ return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];}); }
function todayISO(){ var d=new Date(); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
function isoDate(d){ return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
function fmtDate(iso){ if(!iso) return ''; var p=iso.split('-'); var d=new Date(+p[0],+p[1]-1,+p[2]); return d.toLocaleDateString(undefined,{month:'short',day:'numeric'}); }
function fmtDateFull(iso){ if(!iso) return ''; var p=iso.split('-'); var d=new Date(+p[0],+p[1]-1,+p[2]); return d.toLocaleDateString(undefined,{weekday:'long',month:'long',day:'numeric',year:'numeric'}); }
function fmtDateTime(iso){ if(!iso) return ''; var d=new Date(iso); return d.toLocaleDateString(undefined,{month:'short',day:'numeric'})+' · '+d.toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'}); }
function daysUntil(iso){ var p=iso.split('-'); var d=new Date(+p[0],+p[1]-1,+p[2]); var t=new Date(); t.setHours(0,0,0,0); return Math.round((d-t)/86400000); }
function nthWeekdayOfMonth(year, monthIdx, weekOfMonth, weekday){
  if(weekOfMonth===-1){
    var last=new Date(year,monthIdx+1,0), d=last.getDate();
    while(new Date(year,monthIdx,d).getDay()!==weekday) d--;
    return new Date(year,monthIdx,d);
  }
  var first=new Date(year,monthIdx,1);
  var firstOcc=1+((7+weekday-first.getDay())%7);
  return new Date(year,monthIdx,firstOcc+(weekOfMonth-1)*7);
}
function dueStatus(iso, allDone){
  if(allDone) return 'done';
  var du=daysUntil(iso);
  if(du<0) return 'overdue';
  if(du<=7) return 'due-soon';
  return 'upcoming';
}
function statusLabel(s){ return {overdue:'Overdue', 'due-soon':'Due soon', upcoming:'Upcoming', done:'Done'}[s]||s; }
function uid8(){ return Math.random().toString(36).slice(2,10); }
function currentMonthKey(){ var d=new Date(); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0'); }

// ---------- theme ----------
function applyTheme(mode){
  var root = document.documentElement;
  if(mode==='light' || mode==='dark') root.setAttribute('data-theme', mode);
  else root.removeAttribute('data-theme');
  try{ localStorage.setItem('bko_theme', mode||''); }catch(e){}
}
function initTheme(){
  var saved = ''; try{ saved = localStorage.getItem('bko_theme')||''; }catch(e){}
  applyTheme(saved);
}
function toggleTheme(){
  var root = document.documentElement;
  var current = root.getAttribute('data-theme');
  var prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  var effectiveDark = current ? current==='dark' : prefersDark;
  applyTheme(effectiveDark ? 'light' : 'dark');
}

// ---------- toast ----------
function showToast(type, message){
  var root = document.getElementById('toastRoot');
  var el = document.createElement('div');
  el.className = 'toast '+(type||'');
  el.textContent = message;
  root.appendChild(el);
  setTimeout(function(){
    el.classList.add('leaving');
    setTimeout(function(){ if(el.parentNode) el.parentNode.removeChild(el); }, 200);
  }, 3400);
}
function errMsg(err){ return (err && err.message) ? err.message : 'Something went wrong — please try again.'; }

// ---------- app state ----------
var app = document.getElementById('app');
var myUid=null, myRole=null, myProfile=null, myTeamId=null;
var activeUnsubs = [];
var profileUnsub = null;
var clientNavUnsub = null;
var teamsCache = {}; // id -> team row
var servicesCache = [];
function isAdmin(){ return myRole==='admin'; }
function isManager(){ return myRole==='manager'; }
function canManage(){ return isManager() || isAdmin(); }
function clearSubs(){ activeUnsubs.forEach(function(u){ try{u();}catch(e){} }); activeUnsubs=[]; }
function paint(html){ app.innerHTML = html; app.classList.remove('anim'); void app.offsetWidth; app.classList.add('anim'); }

async function refreshTeamsCache(){
  try{
    var teams = await listTeams();
    teamsCache = {};
    teams.forEach(function(t){ teamsCache[t.id] = t; });
  }catch(e){}
}
async function refreshServicesCache(){
  try{ servicesCache = await listServices(); }catch(e){ servicesCache = []; }
}
function teamName(id){ return (teamsCache[id] && teamsCache[id].name) || '—'; }
function servicesForMyScope(){
  return servicesCache.filter(function(s){ return s.scope==='global' || s.teamId===myTeamId || isAdmin(); });
}

function renderIdentityCard(){
  var box = document.getElementById('roleBox');
  if(!box) return;
  if(!myRole){ box.innerHTML = '<div class="role-box-label">Loading your profile…</div>'; return; }
  var r = roleOf(myRole);
  var avatar = myProfile && myProfile.avatarUrl
    ? '<span class="avatar" style="width:30px;height:30px;font-size:12px;background-image:url(\''+escapeHtml(myProfile.avatarUrl)+'\')"></span>'
    : '<span class="avatar" style="width:30px;height:30px;font-size:12px;background:'+(r?r.color:'#888')+'">'+escapeHtml((myProfile&&myProfile.displayName?myProfile.displayName:'?').trim()[0]||'?')+'</span>';
  box.innerHTML =
    '<div style="display:flex;align-items:center;gap:9px;">'+avatar+
    '<div style="min-width:0;flex:1;"><div class="role-current-label" style="line-height:1.15;">'+escapeHtml((myProfile&&myProfile.displayName)||'')+'</div>'+
    '<div class="team-current-label"><span class="role-dot" style="background:'+(r?r.color:'#888')+';display:inline-block;margin-right:5px;"></span>'+escapeHtml(r?r.label:myRole)+(myTeamId?' · '+escapeHtml(teamName(myTeamId)):'')+'</div></div></div>';
}

// ---------- profile hydration ----------
function profileChip(uid){
  return '<span class="task-done-by" data-profile-id="'+escapeHtml(uid)+'"><span class="avatar" style="background:var(--line)"></span><span class="pname">…</span></span>';
}
function hydrateProfiles(container){
  var els = container.querySelectorAll('[data-profile-id]');
  if(!els.length) return;
  var ids = Array.prototype.map.call(els, function(e){ return e.getAttribute('data-profile-id'); });
  fetchProfiles(ids).then(function(ps){
    Array.prototype.forEach.call(els, function(e){
      var id = e.getAttribute('data-profile-id');
      var p = ps[id];
      var nameEl = e.querySelector('.pname');
      var avEl = e.querySelector('.avatar');
      if(nameEl) nameEl.textContent = (p && p.name) ? p.name : 'Someone';
      if(avEl && p){
        if(p.avatarUrl){ avEl.style.backgroundImage = 'url(\''+p.avatarUrl+'\')'; avEl.style.backgroundColor=''; avEl.textContent=''; }
        else { avEl.style.background = p.color; avEl.textContent = p.initial; }
      }
    });
  }).catch(function(){});
}

// ---------- modal ----------
function openModal(title, innerHtml, onSubmit, submitLabel, opts){
  opts = opts || {};
  var root = document.getElementById('modalRoot');
  root.innerHTML = '<div class="modal-backdrop" id="modalBackdrop"><div class="modal'+(opts.large?' modal-lg':'')+'">'+
    '<div class="modal-head"><h3>'+escapeHtml(title)+'</h3><button type="button" class="modal-close" id="modalClose">✕</button></div>'+
    '<form id="modalForm">'+innerHtml+
    '<div class="field-error" id="modalError" hidden></div>'+
    '<div class="modal-actions"><button type="button" class="btn" id="modalCancel">Cancel</button>'+
    '<button type="submit" class="btn btn-primary" id="modalSubmit" style="width:auto;">'+escapeHtml(submitLabel||'Save')+'</button></div>'+
    '</form></div></div>';
  root.classList.add('open');
  document.getElementById('modalClose').onclick = closeModal;
  document.getElementById('modalCancel').onclick = closeModal;
  document.getElementById('modalBackdrop').addEventListener('click', function(e){ if(e.target.id==='modalBackdrop') closeModal(); });
  document.getElementById('modalForm').addEventListener('submit', function(e){
    e.preventDefault();
    var errEl = document.getElementById('modalError');
    if(errEl){ errEl.hidden = true; errEl.textContent=''; }
    onSubmit(new FormData(e.target), e.target);
  });
  if(opts.afterRender) opts.afterRender(document.getElementById('modalForm'));
}
function closeModal(){ var root=document.getElementById('modalRoot'); root.classList.remove('open'); root.innerHTML=''; }
function setModalBusy(busy, busyLabel){
  var btn = document.getElementById('modalSubmit');
  if(!btn) return;
  btn.disabled = busy;
  if(busy){ btn.setAttribute('data-label', btn.textContent); btn.textContent = busyLabel||'Saving…'; }
  else { btn.textContent = btn.getAttribute('data-label')||btn.textContent; }
}
function showModalError(message){
  var errEl = document.getElementById('modalError');
  if(errEl){ errEl.hidden = false; errEl.textContent = message; }
  setModalBusy(false);
}

// ---------- nav highlighting ----------
function highlightNav(route){
  Array.prototype.forEach.call(document.querySelectorAll('.nav-link'), function(a){
    a.classList.toggle('active', a.getAttribute('data-route')===route);
  });
  Array.prototype.forEach.call(document.querySelectorAll('.client-nav-item'), function(a){
    a.classList.toggle('active', a.getAttribute('data-active-check')===route);
  });
}

// ---------- client nav list ----------
function subscribeClientNav(){
  if(clientNavUnsub){ clientNavUnsub(); }
  clientNavUnsub = db.collection('clients').orderBy('createdAt','asc').onSnapshot(function(snap){
    var list = document.getElementById('clientNavList');
    if(!list) return;
    if(snap.empty){ list.innerHTML = '<div style="padding:8px 10px;font-size:12.5px;color:var(--muted);">No clients yet</div>'; return; }
    var hash = location.hash;
    list.innerHTML = snap.docs.map(function(d,i){
      var c = d.data();
      var href = '#/client/'+d.id;
      return '<a href="'+href+'" class="client-nav-item" data-active-check="'+href+'"><span class="client-dot" style="background:'+escapeHtml(c.color||CLIENT_COLORS[i%CLIENT_COLORS.length])+'"></span>'+escapeHtml(c.name)+'</a>';
    }).join('');
    highlightNav(hash.replace('#',''));
  }, function(){});
}

function generateEpisodesForRule(rule, clientMeta, steps, monthOffsets){
  var out = [];
  var base = new Date();
  monthOffsets.forEach(function(off){
    var y = base.getFullYear(), m = base.getMonth()+off;
    var d = nthWeekdayOfMonth(y, m, rule.weekOfMonth, rule.weekday);
    var iso = isoDate(d);
    if(off===0 && iso < todayISO()) return;
    var period = d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0');
    var epId = 'ep_'+rule.id+'_'+period;
    out.push(
      db.doc('episodes/'+epId).get().then(function(existing){
        if(existing.exists) return null;
        var epDoc = {
          clientId: rule.clientId, clientName: clientMeta.name, templateId: rule.templateId,
          scheduleRuleId: rule.id, title: rule.label, dueDate: iso, period: period,
          paid: !!rule.paid, amount: rule.amount||null, taskCount: steps.length, createdAt: new Date().toISOString()
        };
        return db.doc('episodes/'+epId).set(epDoc).then(function(){
          return Promise.all(steps.map(function(s){
            var taskId = epId+'_'+s.stepId;
            return db.doc('tasks/'+taskId).set({
              episodeId: epId, episodeTitle: rule.label, clientId: rule.clientId, clientName: clientMeta.name,
              role: s.role, label: s.label, group: s.group||'', orderNum: s.order||0,
              dependsOnLabel: s.dependsOnLabel||'', dueDate: iso, done:false, doneByUserId:null, doneAt:null,
              createdAt: new Date().toISOString()
            });
          }));
        });
      })
    );
  });
  return out;
}

// ---------- ROUTER ----------
function route(){
  clearSubs();
  var hash = location.hash.replace(/^#/,'') || '/';
  highlightNav(hash);
  var mClient = hash.match(/^\/client\/([^\/]+)$/);
  var mEpisode = hash.match(/^\/episode\/([^\/]+)$/);
  if(hash==='/') renderHome();
  else if(hash==='/board') renderBoard();
  else if(hash==='/timelog') renderTimeLog();
  else if(hash==='/connect') renderConnect();
  else if(hash==='/team') renderTeamSettings();
  else if(hash==='/admin') renderAdmin();
  else if(mClient) renderClient(mClient[1]);
  else if(mEpisode) renderEpisode(mEpisode[1]);
  else renderHome();
  if(window.innerWidth<=900) document.getElementById('sidebar').classList.remove('open');
  document.getElementById('main').scrollTop = 0;
}
window.addEventListener('hashchange', route);
document.getElementById('navToggle').addEventListener('click', function(){
  document.getElementById('sidebar').classList.toggle('open');
});

// ---------- SPOTLIGHT (Employee of the Month) ----------
function renderSpotlight(container){
  var monthKey = currentMonthKey();
  // Was a one-time .get() — meaning it only ever loaded when this page was
  // first opened. If Admin changed the spotlight while an employee already
  // had Home open, they'd never see it until they navigated away and back.
  // Switched to .onSnapshot() so it updates live like everything else.
  var unsub = db.doc('spotlights/'+monthKey).onSnapshot(function(snap){
    var s = snap.exists ? snap.data() : null;
    function wireEditBtn(){
      // This used to run right after the outer .get()/.onSnapshot()
      // callback fired, but for the "spotlight already set" branch below,
      // the actual innerHTML write happens one tick later inside
      // fetchProfiles().then(...) — so the button didn't exist in the DOM
      // yet when this looked for it, and the click handler silently never
      // attached. That's the "Edit button does nothing" bug: the button
      // was real, it just had no listener. Now this only runs after the
      // HTML that contains the button has actually been written.
      var btn = document.getElementById('spotlightEditBtn');
      if(btn) btn.addEventListener('click', function(){ openSpotlightModal(monthKey, s); });
    }
    if(!s || !s.employeeId){
      if(!canManage()) { container.innerHTML=''; return; }
      container.innerHTML = '<div class="spotlight-banner" style="background:linear-gradient(120deg,var(--line-soft),var(--line));color:var(--ink);">'+
        '<div class="spotlight-body"><div class="spotlight-eyebrow" style="opacity:.7;">Employee of the month</div>'+
        '<div class="spotlight-name">Not set yet</div><div class="spotlight-note">Pick this month\'s spotlight.</div></div>'+
        '<button type="button" class="btn spotlight-edit" id="spotlightEditBtn" style="background:var(--surface);color:var(--ink);border-color:var(--line);">Set spotlight</button></div>';
      wireEditBtn();
    } else {
      fetchProfiles([s.employeeId]).then(function(ps){
        var p = ps[s.employeeId] || {name:'Someone', initial:'?', color:'#888', avatarUrl:''};
        container.innerHTML = '<div class="spotlight-banner">'+
          (p.avatarUrl ? '<img class="spotlight-photo" src="'+escapeHtml(p.avatarUrl)+'">' : '<div class="spotlight-photo" style="display:flex;align-items:center;justify-content:center;font-family:var(--font-display);font-size:28px;font-weight:700;background:'+p.color+';color:#fff;">'+escapeHtml(p.initial)+'</div>')+
          '<div class="spotlight-body"><div class="spotlight-eyebrow">🏆 Employee of the month</div>'+
          '<div class="spotlight-name">'+escapeHtml(p.name)+'</div>'+
          (s.note?'<div class="spotlight-note">'+escapeHtml(s.note)+'</div>':'')+'</div>'+
          (canManage()?'<button type="button" class="btn spotlight-edit" id="spotlightEditBtn">Edit</button>':'')+
          '</div>';
        wireEditBtn();
      }).catch(function(){ container.innerHTML=''; });
    }
  }, function(){ container.innerHTML=''; });
  activeUnsubs.push(unsub);
}

function openSpotlightModal(monthKey, existing){
  var rosterQuery = isAdmin() ? db.collection('profiles').get() : db.collection('profiles').where('teamId','==',myTeamId).get();
  rosterQuery.then(function(snap){
    var opts = snap.docs.map(function(d){ var p=d.data(); return '<option value="'+d.id+'" '+(existing&&existing.employeeId===d.id?'selected':'')+'>'+escapeHtml(p.displayName||p.email)+'</option>'; }).join('');
    openModal('Set Employee of the Month', '<div class="field"><label>Employee</label><select name="employeeId" required>'+opts+'</select></div>'+
      '<div class="field"><label>Note (optional)</label><textarea name="note" placeholder="What made this month great">'+escapeHtml((existing&&existing.note)||'')+'</textarea></div>',
      function(fd){
        setModalBusy(true);
        db.doc('spotlights/'+monthKey).set({
          employeeId: fd.get('employeeId'), note: (fd.get('note')||'').trim(), setBy: myUid, updatedAt: new Date().toISOString()
        }).then(function(){ closeModal(); showToast('success','Spotlight updated'); route(); })
          .catch(function(err){ showModalError(errMsg(err)); });
      }, 'Save');
  }).catch(function(err){ showToast('error', errMsg(err)); });
}

// ---------- HOME ----------
function renderHome(){
  paint(
    '<div id="spotlightBox"></div>'+
    '<div class="page-head"><div><div class="eyebrow">Overview</div><h1 class="page-title">Clients & Shows</h1>'+
    '<div class="page-sub">Every project Blue Kite produces for'+(myTeamId&&!isAdmin()?' — '+escapeHtml(teamName(myTeamId)):'')+'.</div></div></div>'+
    '<div class="section"><div class="section-head"><h2 class="section-title">Due soon</h2></div>'+
    '<div id="dueSoonStrip" class="strip"><div class="skeleton" style="height:44px;"></div></div></div>'+
    '<div class="section"><div class="section-head"><h2 class="section-title">Clients</h2></div>'+
    '<div id="clientGrid" class="card-grid"><div class="skeleton" style="height:150px;"></div></div></div>'
  );
  renderSpotlight(document.getElementById('spotlightBox'));

  var today = todayISO();
  var unsub1 = db.collection('episodes').where('dueDate','>=',today).orderBy('dueDate','asc').limit(6).onSnapshot(function(snap){
    var strip = document.getElementById('dueSoonStrip');
    if(!strip) return;
    if(snap.empty){ strip.innerHTML = '<div class="empty-state">Nothing due yet — generate episodes from a client\'s schedule.</div>'; return; }
    strip.innerHTML = snap.docs.map(function(d){
      var e = d.data();
      var status = dueStatus(e.dueDate,false);
      return '<a class="strip-item" href="#/episode/'+d.id+'">'+
        '<span class="strip-dot" style="background:var(--blue)"></span>'+
        '<div class="strip-main"><div class="strip-title">'+escapeHtml(e.clientName)+' — '+escapeHtml(e.title)+'</div>'+
        '<div class="strip-sub">'+fmtDate(e.dueDate)+(e.paid?' · Paid $'+e.amount:'')+'</div></div>'+
        '<span class="badge badge-'+status+'">'+statusLabel(status)+'</span></a>';
    }).join('');
  }, function(){ var s=document.getElementById('dueSoonStrip'); if(s) s.innerHTML='<div class="empty-state">Could not load.</div>'; });
  activeUnsubs.push(unsub1);

  var unsub2 = db.collection('clients').orderBy('createdAt','asc').onSnapshot(function(snap){
    var grid = document.getElementById('clientGrid');
    if(!grid) return;
    var cards = snap.docs.map(function(d,i){
      var c = d.data();
      var color = c.color || CLIENT_COLORS[i%CLIENT_COLORS.length];
      return '<a class="client-card" href="#/client/'+d.id+'">'+
        '<div class="client-card-rail'+(c.imageUrl?'':' no-image')+'" style="'+(c.imageUrl?'background-image:url(\''+escapeHtml(c.imageUrl)+'\')':'background:linear-gradient(135deg,'+color+',var(--line-soft))')+'"></div>'+
        '<div class="client-card-body">'+
        '<div class="client-card-name">'+escapeHtml(c.name)+'</div>'+
        '<div class="client-card-host">Hosted by '+escapeHtml(c.hostName||'—')+'</div>'+
        '<div class="client-card-tagline">'+escapeHtml(c.tagline||'')+'</div>'+
        '<div class="client-card-foot"><span>'+(c.services?c.services.length:0)+' services</span>'+(c.example?'<span class="badge badge-upcoming">Example</span>':'<span>View board →</span>')+'</div>'+
        '</div></a>';
    }).join('');
    if(canManage()) cards += '<button type="button" class="add-client-card" id="addClientCard">+ Add a client</button>';
    grid.innerHTML = cards || '<div class="empty-state">No clients in your team yet.</div>';
    var btn = document.getElementById('addClientCard');
    if(btn) btn.addEventListener('click', openAddClientModal);
  }, function(){});
  activeUnsubs.push(unsub2);
}

function openAddClientModal(){
  var teamFieldHtml = isAdmin()
    ? '<div class="field"><label>Team</label><select name="teamId" required>'+Object.keys(teamsCache).map(function(id){ return '<option value="'+id+'">'+escapeHtml(teamsCache[id].name)+'</option>'; }).join('')+'</select></div>'
    : '';
  openModal('Add a client', '<div class="field"><label>Client / project name</label><input required name="name" type="text" placeholder="e.g. Fan Club Setlist"></div>'+
    '<div class="field"><label>Host name(s)</label><input name="hostName" type="text" placeholder="e.g. Erica Bonser &amp; Steph Eggar"></div>'+
    '<div class="field"><label>One-line overview</label><textarea name="tagline" placeholder="What this show is about"></textarea></div>'+
    teamFieldHtml,
    function(fd){
      var name = (fd.get('name')||'').trim();
      if(!name){ showModalError('Give the client a name.'); return; }
      setModalBusy(true);
      var teamId = isAdmin() ? fd.get('teamId') : myTeamId;
      db.collection('clients').add({
        name:name, hostName:(fd.get('hostName')||'').trim(), tagline:(fd.get('tagline')||'').trim(),
        services:[], teamId: teamId, imageUrl:null,
        color: CLIENT_COLORS[Math.floor(Math.random()*CLIENT_COLORS.length)],
        example:false, createdAt:new Date().toISOString()
      }).then(function(ref){
        closeModal();
        showToast('success', 'Added '+name);
        location.hash = '#/client/'+ref.id;
      }).catch(function(err){
        showModalError(errMsg(err));
      });
    }, 'Add client');
}

// ---------- CLIENT DETAIL ----------
function renderClient(clientId){
  paint('<div class="skeleton" style="height:120px;margin-bottom:20px;"></div><div class="skeleton" style="height:260px;"></div>');
  var unsub = db.doc('clients/'+clientId).onSnapshot(function(snap){
    if(!snap.exists){ app.innerHTML='<div class="empty-state"><strong>Client not found</strong>It may have been removed.</div>'; return; }
    var c = snap.data();
    var mgr = canManage();
    app.innerHTML =
      '<div class="page-head"><div><div class="eyebrow">Client</div><h1 class="page-title">'+escapeHtml(c.name)+'</h1>'+
      '<div class="page-sub">Hosted by '+escapeHtml(c.hostName||'—')+' · <span id="clientTeamRow">Team: <b>'+escapeHtml(teamName(c.teamId))+'</b>'+(isAdmin()?' <button type="button" class="btn btn-sm" id="editTeamBtn" style="width:auto;padding:1px 8px;font-size:11px;vertical-align:middle;">Change</button>':'')+'</span></div></div>'+
      (mgr?'<button type="button" class="btn btn-primary btn-sm" id="genEpisodesBtn">Generate upcoming episodes</button>':'')+
      '</div>'+
      '<div class="client-card-rail'+(c.imageUrl?'':' no-image')+'" style="margin-bottom:18px;border-radius:14px;height:150px;position:relative;'+(c.imageUrl?'background-image:url(\''+escapeHtml(c.imageUrl)+'\');background-size:cover;background-position:center;':'background:linear-gradient(135deg,var(--blue-soft),var(--line-soft));')+'">'+
      (mgr?'<label class="btn btn-sm" style="position:absolute;bottom:10px;right:10px;cursor:pointer;">Change photo<input type="file" accept="image/*" id="clientImageInput" style="display:none;"></label>':'')+
      '</div>'+
      '<div class="overview-grid">'+
      '<div class="panel"><h3>Overview'+(mgr?' <button type="button" class="btn btn-sm" id="editOverviewBtn" style="float:right;">Edit</button>':'')+'</h3>'+
      '<div id="overviewBox"><p style="font-size:13.5px;color:var(--ink-soft);line-height:1.55;margin-bottom:10px;">'+escapeHtml(c.tagline||'No overview yet.')+'</p></div>'+
      '<div id="serviceTags">'+(c.services||[]).map(function(s){
        var svc = servicesCache.filter(function(x){return x.name===s;})[0];
        return '<span class="tag'+(svc&&svc.scope==='global'?' tag-global':'')+'">'+escapeHtml(s)+(mgr?'<button type="button" class="tag-remove" data-remove-service="'+escapeHtml(s)+'">✕</button>':'')+'</span>';
      }).join('')+'</div>'+
      (mgr?'<div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap;"><button type="button" class="btn btn-sm" id="addServiceBtn">+ Add service</button>'+
        '<button type="button" class="btn btn-sm" id="newServiceTypeBtn">+ New service type</button></div>':'')+
      '</div>'+
      '<div class="panel"><h3>Publishing schedule</h3><div id="scheduleBox"><div class="skeleton" style="height:60px;"></div></div>'+
      (mgr?'<button type="button" class="btn btn-sm" id="addRuleBtn" style="margin-top:10px;">+ Add schedule rule</button>':'')+
      '</div></div>'+
      '<div class="section"><div class="section-head"><h2 class="section-title">Episodes</h2>'+
      (mgr?'<button type="button" class="btn btn-sm" id="addEpisodeBtn">+ One-off episode</button>':'')+
      '</div>'+
      '<div id="episodeList" class="episode-list"><div class="skeleton" style="height:50px;"></div></div></div>'+
      (mgr?'<div class="section"><div class="section-head"><h2 class="section-title">Workflow templates</h2><button type="button" class="btn btn-sm" id="addTemplateBtn">+ New template</button></div><div id="templateBox"></div></div>':'');

    var genBtn = document.getElementById('genEpisodesBtn');
    if(genBtn) genBtn.addEventListener('click', function(){
      genBtn.disabled = true; genBtn.textContent = 'Generating…';
      Promise.all([db.collection('scheduleRules').where('clientId','==',clientId).get(), db.collection('templates').where('clientId','==',clientId).get()]).then(function(res){
        var rulesSnap = res[0], tplSnap = res[1];
        var tplMap = {};
        tplSnap.docs.forEach(function(d){ tplMap[d.id] = d.data().steps||[]; });
        var writes = [];
        var any = false;
        rulesSnap.docs.forEach(function(d){
          var r = d.data(); r.id = d.id;
          if(r.active===false) return;
          any = true;
          writes = writes.concat(generateEpisodesForRule(r, {name:c.name}, tplMap[r.templateId]||[], [0,1,2]));
        });
        if(!any){ showToast('error','No active schedule rules to generate from yet.'); }
        return Promise.all(writes);
      }).then(function(created){
        genBtn.disabled=false; genBtn.textContent='Generate upcoming episodes';
        var made = created.filter(Boolean).length;
        showToast('success', made ? ('Generated '+made+' new episode'+(made===1?'':'s')) : 'Already up to date — nothing new to generate.');
      }).catch(function(err){ genBtn.disabled=false; genBtn.textContent='Generate upcoming episodes'; showToast('error', errMsg(err)); });
    });

    var imgInput = document.getElementById('clientImageInput');
    if(imgInput) imgInput.addEventListener('change', function(){
      var file = imgInput.files[0]; if(!file) return;
      showToast('success','Uploading photo…');
      compressImage(file, {maxWidth:800,maxHeight:800,quality:.85}).then(function(blob){
        var key = 'clients/'+clientId+'/photo_'+Date.now()+'.jpg';
        return uploadFile(new File([blob],'photo.jpg',{type:'image/jpeg'}), key);
      }).then(function(key){
        return db.doc('clients/'+clientId).update({imageUrl: fileUrl(key)});
      }).then(function(){ showToast('success','Photo updated'); }).catch(function(err){ showToast('error', errMsg(err)); });
    });

    var editOverviewBtn = document.getElementById('editOverviewBtn');
    if(editOverviewBtn) editOverviewBtn.addEventListener('click', function(){
      var box = document.getElementById('overviewBox');
      box.innerHTML = '<textarea id="overviewEdit" style="width:100%;min-height:80px;border:1px solid var(--line);background:var(--paper);border-radius:8px;padding:9px 11px;font-size:13.5px;">'+escapeHtml(c.tagline||'')+'</textarea>'+
        '<div style="margin-top:8px;display:flex;gap:8px;"><button type="button" class="btn btn-sm btn-primary" style="width:auto;" id="saveOverviewBtn">Save</button><button type="button" class="btn btn-sm" id="cancelOverviewBtn">Cancel</button></div>';
      document.getElementById('cancelOverviewBtn').addEventListener('click', function(){ route(); });
      document.getElementById('saveOverviewBtn').addEventListener('click', function(){
        var val = document.getElementById('overviewEdit').value;
        db.doc('clients/'+clientId).update({tagline: val}).then(function(){ showToast('success','Overview updated'); }).catch(function(err){ showToast('error', errMsg(err)); });
      });
    });

    // Reassigning a client to a different team — Admin-only per the
    // permissions matrix (a Manager can't move a client out of their own
    // team). This is the "editable afterward" piece for clients that came
    // in without a team (see schema_v3.sql's Team A backfill).
    var editTeamBtn = document.getElementById('editTeamBtn');
    if(editTeamBtn) editTeamBtn.addEventListener('click', function(){
      var row = document.getElementById('clientTeamRow');
      var teamOpts = Object.keys(teamsCache).map(function(id){ return '<option value="'+id+'"'+(id===c.teamId?' selected':'')+'>'+escapeHtml(teamsCache[id].name)+'</option>'; }).join('');
      row.innerHTML = '<select id="teamReassignSelect" style="font-size:12px;padding:2px 4px;">'+teamOpts+'</select> '+
        '<button type="button" class="btn btn-sm" id="saveTeamBtn" style="width:auto;padding:1px 8px;font-size:11px;">Save</button> '+
        '<button type="button" class="btn btn-sm" id="cancelTeamBtn" style="width:auto;padding:1px 8px;font-size:11px;">Cancel</button>';
      document.getElementById('cancelTeamBtn').addEventListener('click', function(){ route(); });
      document.getElementById('saveTeamBtn').addEventListener('click', function(){
        var newTeamId = document.getElementById('teamReassignSelect').value;
        db.doc('clients/'+clientId).update({teamId: newTeamId}).then(function(){ showToast('success','Client moved to '+teamName(newTeamId)); }).catch(function(err){ showToast('error', errMsg(err)); });
      });
    });

    Array.prototype.forEach.call(document.querySelectorAll('[data-remove-service]'), function(btn){
      btn.addEventListener('click', function(){
        var name = btn.getAttribute('data-remove-service');
        var next = (c.services||[]).filter(function(s){ return s!==name; });
        db.doc('clients/'+clientId).update({services: next}).catch(function(err){ showToast('error', errMsg(err)); });
      });
    });
    var addServiceBtn = document.getElementById('addServiceBtn');
    if(addServiceBtn) addServiceBtn.addEventListener('click', function(){ openAddServiceToClientModal(clientId, c.services||[]); });
    var newServiceTypeBtn = document.getElementById('newServiceTypeBtn');
    if(newServiceTypeBtn) newServiceTypeBtn.addEventListener('click', function(){ openCreateServiceTypeModal(clientId); });

    var addRuleBtn = document.getElementById('addRuleBtn');
    if(addRuleBtn) addRuleBtn.addEventListener('click', function(){ openAddRuleModal(clientId); });
    var addEpisodeBtn = document.getElementById('addEpisodeBtn');
    if(addEpisodeBtn) addEpisodeBtn.addEventListener('click', function(){ openAddOneOffEpisodeModal(clientId, c.name); });
    var addTemplateBtn = document.getElementById('addTemplateBtn');
    if(addTemplateBtn) addTemplateBtn.addEventListener('click', function(){ openAddTemplateModal(clientId); });

    var unsubSched = db.collection('scheduleRules').where('clientId','==',clientId).onSnapshot(function(rs){
      var box = document.getElementById('scheduleBox');
      if(!box) return;
      if(rs.empty){ box.innerHTML = '<div class="empty-state" style="padding:16px;"><strong>No schedule yet</strong>Add a recurring rule so episodes generate automatically.</div>'; return; }
      var rows = rs.docs.slice().sort(function(a,b){ return (a.data().weekOfMonth-b.data().weekOfMonth)||(a.data().weekday-b.data().weekday); });
      box.innerHTML = rows.map(function(d){
        var r = d.data();
        return '<div class="schedule-row"><span class="schedule-when">'+ordinal(r.weekOfMonth)+' '+WEEKDAY_NAMES[r.weekday]+'</span>'+
          '<span class="schedule-label">'+escapeHtml(r.label)+(r.active===false?' <span class="badge badge-upcoming">Inactive</span>':'')+'</span>'+
          (r.paid?'<span class="badge badge-paid">$'+r.amount+'</span>':'')+
          (mgr?'<button type="button" class="schedule-remove" data-rule="'+d.id+'">remove</button>':'')+
          '</div>';
      }).join('');
      Array.prototype.forEach.call(box.querySelectorAll('[data-rule]'), function(btn){
        btn.addEventListener('click', function(){
          if(!confirm('Remove this schedule rule? Episodes already generated from it are kept.')) return;
          db.doc('scheduleRules/'+btn.getAttribute('data-rule')).delete().then(function(){ showToast('success','Rule removed'); }).catch(function(err){ showToast('error', errMsg(err)); });
        });
      });
    }, function(){});
    activeUnsubs.push(unsubSched);

    var unsubEp = db.collection('episodes').where('clientId','==',clientId).orderBy('dueDate','asc').limit(30).onSnapshot(function(es){
      var list = document.getElementById('episodeList');
      if(!list) return;
      if(es.empty){ list.innerHTML = '<div class="empty-state"><strong>No episodes yet</strong>'+(mgr?'Add a schedule rule, then generate episodes.':'Ask a manager to set up this client\'s schedule.')+'</div>'; return; }
      list.innerHTML = es.docs.map(function(d){
        var e = d.data();
        var status = dueStatus(e.dueDate,false);
        return '<a class="episode-row" href="#/episode/'+d.id+'">'+
          '<span class="episode-date mono">'+fmtDate(e.dueDate)+'</span>'+
          '<div class="episode-main"><div class="episode-title">'+escapeHtml(e.title)+'</div>'+
          '<div class="episode-sub">'+(e.taskCount||0)+' tasks'+(e.paid?' · Paid $'+e.amount:'')+'</div></div>'+
          '<span class="badge badge-'+status+'">'+statusLabel(status)+'</span></a>';
      }).join('');
    }, function(){});
    activeUnsubs.push(unsubEp);

    if(mgr){
      var unsubTpl = db.collection('templates').where('clientId','==',clientId).onSnapshot(function(ts){
        var box = document.getElementById('templateBox');
        if(!box) return;
        if(ts.empty){ box.innerHTML = '<div class="empty-state"><strong>No templates yet</strong>Templates define the checklist each episode type generates.</div>'; return; }
        box.innerHTML = ts.docs.map(function(d){
          var t = d.data();
          var steps = (t.steps||[]).slice().sort(function(a,b){return (a.order||0)-(b.order||0);});
          return '<div class="panel" style="margin-bottom:12px;" data-tpl-panel="'+d.id+'"><h3>'+escapeHtml(t.name)+'</h3>'+
            '<div class="step-list" data-tpl-steps="'+d.id+'">'+steps.map(function(s,i){
              var r = roleOf(s.role);
              return '<div class="step-edit-row" draggable="true" data-tpl="'+d.id+'" data-step="'+escapeHtml(s.stepId)+'" data-idx="'+i+'">'+
                '<span class="step-drag-handle" title="Drag to reorder">⋮⋮</span>'+
                '<span class="role-chip" style="background:'+(r?r.color:'#888')+'">'+(r?escapeHtml(r.label):s.role)+'</span>'+
                '<span>'+escapeHtml(s.label)+'</span>'+
                '<button type="button" class="step-edit-remove" data-tpl="'+d.id+'" data-step="'+escapeHtml(s.stepId)+'">remove</button></div>';
            }).join('')+'</div>'+
            '<div class="manager-only"><button type="button" class="btn btn-sm" data-add-step="'+d.id+'">+ Add step</button></div>'+
            '</div>';
        }).join('');
        ts.docs.forEach(function(d){
          var t = d.data();
          var steps = (t.steps||[]).slice().sort(function(a,b){return (a.order||0)-(b.order||0);});
          var stepBox = box.querySelector('[data-tpl-steps="'+d.id+'"]');
          if(stepBox) wireStepDrag(stepBox, d.id, steps);
        });
        Array.prototype.forEach.call(box.querySelectorAll('[data-add-step]'), function(btn){
          btn.addEventListener('click', function(){ openAddStepModal(btn.getAttribute('data-add-step')); });
        });
        Array.prototype.forEach.call(box.querySelectorAll('.step-edit-remove'), function(btn){
          btn.addEventListener('click', function(){
            var tplId = btn.getAttribute('data-tpl'), stepId = btn.getAttribute('data-step');
            db.doc('templates/'+tplId).get().then(function(snap2){
              var t2 = snap2.data();
              var steps2 = (t2.steps||[]).filter(function(s){ return s.stepId!==stepId; });
              return db.doc('templates/'+tplId).update({steps:steps2});
            }).catch(function(err){ showToast('error', errMsg(err)); });
          });
        });
      }, function(){});
      activeUnsubs.push(unsubTpl);
    }
  }, function(){ app.innerHTML='<div class="empty-state">Could not load this client.</div>'; });
  activeUnsubs.push(unsub);
}

function wireStepDrag(box, tplId, steps){
  var dragIdx = null;
  Array.prototype.forEach.call(box.querySelectorAll('.step-edit-row'), function(row){
    row.addEventListener('dragstart', function(e){
      dragIdx = parseInt(row.getAttribute('data-idx'),10);
      row.classList.add('dragging');
      try{ e.dataTransfer.effectAllowed='move'; e.dataTransfer.setData('text/plain', String(dragIdx)); }catch(err){}
    });
    row.addEventListener('dragend', function(){ row.classList.remove('dragging'); });
    row.addEventListener('dragover', function(e){ e.preventDefault(); row.classList.add('drag-over'); });
    row.addEventListener('dragleave', function(){ row.classList.remove('drag-over'); });
    row.addEventListener('drop', function(e){
      e.preventDefault();
      row.classList.remove('drag-over');
      var dropIdx = parseInt(row.getAttribute('data-idx'),10);
      if(dragIdx===null || dragIdx===dropIdx) return;
      var reordered = steps.slice();
      var moved = reordered.splice(dragIdx,1)[0];
      reordered.splice(dropIdx,0,moved);
      reordered.forEach(function(s,i){ s.order=i; });
      db.doc('templates/'+tplId).update({steps:reordered}).then(function(){
        showToast('success','Reordered steps');
      }).catch(function(err){ showToast('error', errMsg(err)); });
    });
  });
}

function openAddServiceToClientModal(clientId, existing){
  var available = servicesForMyScope().filter(function(s){ return existing.indexOf(s.name)===-1; });
  if(!available.length){ showToast('error','No more services in the vocabulary to add — create a new service type first.'); return; }
  openModal('Add a service', '<div class="field"><label>Choose from the vocabulary</label>'+
    available.map(function(s){ return '<div class="check-row"><input type="checkbox" name="svc" value="'+escapeHtml(s.name)+'" id="svc_'+escapeHtml(s.id)+'"><label for="svc_'+escapeHtml(s.id)+'">'+escapeHtml(s.name)+(s.scope==='global'?' <span class="tag tag-global" style="margin:0;">global</span>':'')+'</label></div>'; }).join('')+
    '</div>',
    function(fd){
      var picked = fd.getAll('svc');
      if(!picked.length){ showModalError('Pick at least one service.'); return; }
      setModalBusy(true);
      db.doc('clients/'+clientId).update({services: existing.concat(picked)}).then(function(){
        closeModal(); showToast('success','Service'+(picked.length>1?'s':'')+' added');
      }).catch(function(err){ showModalError(errMsg(err)); });
    }, 'Add');
}

function openCreateServiceTypeModal(clientIdToAttach){
  // Admin isn't on any one Team, so "Just my Team" (which reads fine for a
  // Manager) doesn't make sense for them — they need to actually pick which
  // Team a team-scoped service belongs to. The picker itself already
  // existed and worked; this was purely a confusing-label + always-visible
  // issue, now fixed to only show when it's actually relevant.
  var scopeOptions = isAdmin()
    ? '<option value="team">A specific Team</option><option value="global">Every Team (global)</option>'
    : '<option value="team">Just my Team</option>';
  var teamPickerHtml = isAdmin()
    ? '<div class="field" id="teamPickerField"><label>Team</label><select name="teamId">'+Object.keys(teamsCache).map(function(id){ return '<option value="'+id+'">'+escapeHtml(teamsCache[id].name)+'</option>'; }).join('')+'</select></div>'
    : '';
  openModal('New service type', '<div class="field"><label>Service name</label><input required name="name" type="text" placeholder="e.g. Full Production"></div>'+
    '<div class="field"><label>Scope</label><select name="scope" id="scopeSelect">'+scopeOptions+'</select></div>'+
    teamPickerHtml+
    '<div class="field"><label>Sub-tasks (one per line: label / role)</label><textarea name="subtasks" placeholder="Edit trailer / sr_video_editor&#10;Write show notes / seo_specialist" style="min-height:90px;"></textarea>'+
    '<div class="field-hint">Roles: '+ROLES.filter(function(r){return r.key!=='manager'&&r.key!=='admin';}).map(function(r){return r.key;}).join(', ')+'</div></div>'+
    (clientIdToAttach?'<div class="check-row"><input type="checkbox" name="attachTemplate" id="attachTemplate" checked><label for="attachTemplate">Also create a workflow template for this client from these sub-tasks</label></div>':''),
    function(fd){
      var name = (fd.get('name')||'').trim();
      if(!name){ showModalError('Name the service.'); return; }
      var scope = fd.get('scope')||'team';
      var teamId = isAdmin() ? (fd.get('teamId')||myTeamId) : myTeamId;
      var subLines = (fd.get('subtasks')||'').split('\n').map(function(l){return l.trim();}).filter(Boolean);
      var subTasks = subLines.map(function(line){
        var parts = line.split('/');
        var label = (parts[0]||'').trim();
        var role = (parts[1]||'jr_video_editor').trim();
        return { stepId: 's'+uid8(), label: label, role: role, order: 0 };
      }).filter(function(s){ return s.label; });
      subTasks.forEach(function(s,i){ s.order=i; });
      setModalBusy(true);
      createService(name, scope, teamId, subTasks, myUid).then(function(){
        if(clientIdToAttach){
          return db.doc('clients/'+clientIdToAttach).get().then(function(snap){
            var c = snap.data();
            var next = (c.services||[]).concat([name]);
            return db.doc('clients/'+clientIdToAttach).update({services: next}).then(function(){
              if(fd.get('attachTemplate')==='on' && subTasks.length){
                var tplId = 'tpl_'+uid8();
                return db.doc('templates/'+tplId).set({ id: tplId, clientId: clientIdToAttach, name: name, steps: subTasks });
              }
            });
          });
        }
      }).then(function(){
        return refreshServicesCache();
      }).then(function(){
        closeModal(); showToast('success','Service type created'); route();
      }).catch(function(err){ showModalError(errMsg(err)); });
    }, 'Create service', {large:true});
  if(isAdmin()){
    var scopeSelect = document.getElementById('scopeSelect');
    var teamPickerField = document.getElementById('teamPickerField');
    function syncTeamPickerVisibility(){ if(teamPickerField) teamPickerField.style.display = (scopeSelect.value==='global') ? 'none' : ''; }
    if(scopeSelect){ scopeSelect.addEventListener('change', syncTeamPickerVisibility); syncTeamPickerVisibility(); }
  }
}

function openAddOneOffEpisodeModal(clientId, clientName){
  openModal('One-off episode', '<div class="field"><label>Title</label><input required name="title" type="text" placeholder="e.g. Live Q&amp;A special"></div>'+
    '<div class="field"><label>Due date</label><input required name="dueDate" type="date" value="'+todayISO()+'"></div>'+
    '<div class="check-row"><input type="checkbox" id="oneOffPaid" name="paid" style="width:16px;height:16px;"><label for="oneOffPaid">Paid appearance</label></div>'+
    '<div class="field"><label>Amount ($)</label><input name="amount" type="number" placeholder="200"></div>',
    function(fd){
      var title = (fd.get('title')||'').trim();
      if(!title){ showModalError('Give this episode a title.'); return; }
      setModalBusy(true);
      var epId = 'ep_oneoff_'+uid8();
      db.doc('episodes/'+epId).set({
        clientId: clientId, clientName: clientName, templateId: null, scheduleRuleId: null,
        title: title, dueDate: fd.get('dueDate'), period: null,
        paid: fd.get('paid')==='on', amount: fd.get('paid')==='on' ? (parseInt(fd.get('amount'),10)||0) : null,
        taskCount: 0, createdAt: new Date().toISOString()
      }).then(function(){
        closeModal(); showToast('success','Episode added'); location.hash = '#/episode/'+epId;
      }).catch(function(err){ showModalError(errMsg(err)); });
    }, 'Add episode');
}

function openAddTemplateModal(clientId){
  openModal('New workflow template', '<div class="field"><label>Template name</label><input required name="name" type="text" placeholder="e.g. Guest Episode"></div>',
    function(fd){
      var name = (fd.get('name')||'').trim();
      if(!name){ showModalError('Name the template.'); return; }
      setModalBusy(true);
      var tplId = 'tpl_'+uid8();
      db.doc('templates/'+tplId).set({ id: tplId, clientId: clientId, name: name, steps: [] }).then(function(){
        closeModal(); showToast('success','Template created');
      }).catch(function(err){ showModalError(errMsg(err)); });
    }, 'Create');
}

function openAddRuleModal(clientId){
  db.collection('templates').where('clientId','==',clientId).get().then(function(ts){
    var opts = ts.docs.map(function(d){ return '<option value="'+d.id+'">'+escapeHtml(d.data().name)+'</option>'; }).join('');
    openModal('Add schedule rule', '<div class="field"><label>Label</label><input required name="label" type="text" placeholder="e.g. Guest Episode"></div>'+
      '<div class="field-row"><div class="field"><label>Week of month</label><select name="weekOfMonth"><option value="1">1st</option><option value="2">2nd</option><option value="3">3rd</option><option value="4">4th</option><option value="-1">Last</option></select></div>'+
      '<div class="field"><label>Weekday</label><select name="weekday">'+WEEKDAY_NAMES.map(function(w,i){return '<option value="'+i+'">'+w+'</option>';}).join('')+'</select></div></div>'+
      '<div class="field"><label>Workflow template</label><select name="templateId">'+(opts||'<option value="">No templates yet</option>')+'</select></div>'+
      '<div class="check-row"><input type="checkbox" id="paidCheck" name="paid" style="width:16px;height:16px;"><label for="paidCheck">Paid appearance</label></div>'+
      '<div class="field"><label>Amount ($)</label><input name="amount" type="number" placeholder="200"></div>',
      function(fd){
        var label = (fd.get('label')||'').trim();
        if(!label){ showModalError('Give this rule a label.'); return; }
        setModalBusy(true);
        var id = 'rule_'+uid8();
        db.doc('scheduleRules/'+id).set({
          clientId:clientId, templateId:fd.get('templateId')||null, label:label,
          weekOfMonth: parseInt(fd.get('weekOfMonth'),10), weekday: parseInt(fd.get('weekday'),10),
          paid: fd.get('paid')==='on', amount: fd.get('paid')==='on' ? (parseInt(fd.get('amount'),10)||0) : null,
          active:true
        }).then(function(){
          closeModal(); showToast('success', 'Added "'+label+'" to the schedule');
        }).catch(function(err){ showModalError(errMsg(err)); });
      }, 'Add rule');
  }).catch(function(err){ showToast('error', errMsg(err)); });
}

function openAddStepModal(templateId){
  openModal('Add workflow step', '<div class="field"><label>Step description</label><input required name="label" type="text" placeholder="e.g. Edit trailer"></div>'+
    '<div class="field-row"><div class="field"><label>Role</label><select name="role">'+ROLES.filter(function(r){return r.key!=='manager'&&r.key!=='admin';}).map(function(r){return '<option value="'+r.key+'">'+escapeHtml(r.label)+'</option>';}).join('')+'</select></div>'+
    '<div class="field"><label>Group</label><input name="group" type="text" placeholder="e.g. Editing"></div></div>'+
    '<div class="field"><label>Waiting on (optional)</label><input name="dependsOnLabel" type="text" placeholder="e.g. Trailer content extracted"></div>',
    function(fd){
      var label = (fd.get('label')||'').trim();
      if(!label){ showModalError('Describe the step.'); return; }
      setModalBusy(true);
      db.doc('templates/'+templateId).get().then(function(snap){
        var t = snap.data();
        var steps = (t.steps||[]).slice();
        var maxOrder = steps.reduce(function(m,s){return Math.max(m,s.order||0);},0);
        steps.push({stepId:'s'+uid8(), order:maxOrder+1, role:fd.get('role'), group:(fd.get('group')||'').trim(), label:label, dependsOnLabel:(fd.get('dependsOnLabel')||'').trim()});
        return db.doc('templates/'+templateId).update({steps:steps});
      }).then(function(){
        closeModal(); showToast('success', 'Added step');
      }).catch(function(err){ showModalError(errMsg(err)); });
    }, 'Add step');
}

// ---------- EPISODE DETAIL ----------
var expandedTasks = {};
function renderEpisode(episodeId){
  paint('<div class="skeleton" style="height:100px;margin-bottom:20px;"></div><div class="skeleton" style="height:300px;"></div>');
  var unsub = db.doc('episodes/'+episodeId).onSnapshot(function(snap){
    if(!snap.exists){ app.innerHTML='<div class="empty-state"><strong>Episode not found</strong></div>'; return; }
    var e = snap.data();
    app.innerHTML =
      '<div class="page-head"><div><div class="eyebrow"><a href="#/client/'+e.clientId+'" style="color:var(--muted);text-decoration:none;">'+escapeHtml(e.clientName)+'</a></div>'+
      '<h1 class="page-title">'+escapeHtml(e.title)+'</h1>'+
      '<div class="page-sub">'+fmtDateFull(e.dueDate)+(e.paid?' · Paid appearance ($'+e.amount+')':'')+'</div></div>'+
      '<div id="epStatusBadge"></div></div>'+
      '<div class="progress-bar"><div class="progress-fill" id="epProgressFill" style="width:0%"></div></div>'+
      (canManage()?'<div style="margin-top:14px;"><button type="button" class="btn btn-sm" id="addCustomTaskBtn">+ Add custom task</button></div>':'')+
      '<div id="taskGroups" style="margin-top:22px;"><div class="skeleton" style="height:200px;"></div></div>';

    var addCustomBtn = document.getElementById('addCustomTaskBtn');
    if(addCustomBtn) addCustomBtn.addEventListener('click', function(){ openAddCustomTaskModal(episodeId, e); });

    var unsubTasks = db.collection('tasks').where('episodeId','==',episodeId).orderBy('orderNum','asc').onSnapshot(function(ts){
      var box = document.getElementById('taskGroups');
      if(!box) return;
      if(ts.empty){ box.innerHTML = '<div class="empty-state">No tasks on this episode.</div>'; return; }
      var groups = {}; var order = [];
      var doneCount = 0;
      ts.docs.forEach(function(d){
        var t = d.data(); t._id = d.id;
        if(t.done) doneCount++;
        var g = t.group||'Tasks';
        if(!groups[g]){ groups[g]=[]; order.push(g); }
        groups[g].push(t);
      });
      var pct = Math.round(100*doneCount/ts.size);
      var fill = document.getElementById('epProgressFill'); if(fill) fill.style.width = pct+'%';
      var badge = document.getElementById('epStatusBadge');
      if(badge){
        var status = pct===100 ? 'done' : dueStatus(e.dueDate,false);
        badge.innerHTML = '<span class="badge badge-'+status+'">'+statusLabel(status)+' · '+doneCount+'/'+ts.size+'</span>';
      }
      box.innerHTML = order.map(function(g){
        return '<div class="checklist-group"><div class="checklist-group-head"><span class="checklist-group-title">'+escapeHtml(g)+'</span></div>'+
          groups[g].map(function(t){
            var r = roleOf(t.role);
            var canCheck = myRole && (myRole===t.role || canManage());
            return '<div class="task-row '+(t.done?'done':'')+'" style="--role-color:'+(r?r.color:'var(--line)')+'">'+
              '<input type="checkbox" class="task-check" data-task="'+t._id+'" '+(t.done?'checked':'')+' '+(canCheck?'':'disabled')+'>'+
              '<div class="task-body"><div class="task-label">'+escapeHtml(t.label)+(t.custom?' <span class="task-custom-badge">custom</span>':'')+'</div>'+
              '<div class="task-meta"><span class="role-chip" style="background:'+(r?r.color:'#888')+'">'+(r?escapeHtml(r.label):t.role)+'</span>'+
              (t.dependsOnLabel?'<span class="task-waiting">Waiting on: '+escapeHtml(t.dependsOnLabel)+'</span>':'')+
              (t.done && t.doneByUserId?profileChip(t.doneByUserId):'')+
              '</div>'+
              '<button type="button" class="task-expand-btn" data-collab="'+t._id+'">'+(expandedTasks[t._id]?'Hide discussion':'Comments, links & files')+'</button>'+
              '<div class="task-collab" id="collab_'+t._id+'" '+(expandedTasks[t._id]?'':'hidden')+'></div>'+
              '</div></div>';
          }).join('')+
          '</div>';
      }).join('');
      hydrateProfiles(box);
      Array.prototype.forEach.call(box.querySelectorAll('.task-check:not([disabled])'), function(cb){
        cb.addEventListener('change', function(){
          var taskId = cb.getAttribute('data-task');
          var checked = cb.checked;
          db.doc('tasks/'+taskId).update({
            done: checked,
            doneByUserId: checked ? myUid : null,
            doneAt: checked ? new Date().toISOString() : null
          }).catch(function(err){ cb.checked=!checked; showToast('error', errMsg(err)); });
        });
      });
      Array.prototype.forEach.call(box.querySelectorAll('[data-collab]'), function(btn){
        var taskId = btn.getAttribute('data-collab');
        btn.addEventListener('click', function(){
          var panel = document.getElementById('collab_'+taskId);
          if(!panel) return;
          var willShow = panel.hasAttribute('hidden');
          if(willShow){ panel.removeAttribute('hidden'); btn.textContent='Hide discussion'; expandedTasks[taskId]=true; loadTaskCollab(taskId, panel); }
          else { panel.setAttribute('hidden',''); btn.textContent='Comments, links & files'; expandedTasks[taskId]=false; }
        });
        if(expandedTasks[taskId]){
          var panel = document.getElementById('collab_'+taskId);
          if(panel) loadTaskCollab(taskId, panel);
        }
      });
    }, function(){});
    activeUnsubs.push(unsubTasks);
  }, function(){ app.innerHTML='<div class="empty-state">Could not load this episode.</div>'; });
  activeUnsubs.push(unsub);
}

function openAddCustomTaskModal(episodeId, episode){
  openModal('Add a custom task', '<div class="field"><label>What needs doing</label><input required name="label" type="text" placeholder="e.g. Cut a bonus 60-second teaser"></div>'+
    '<div class="field-row"><div class="field"><label>Role</label><select name="role">'+ROLES.filter(function(r){return r.key!=='manager'&&r.key!=='admin';}).map(function(r){return '<option value="'+r.key+'">'+escapeHtml(r.label)+'</option>';}).join('')+'</select></div>'+
    '<div class="field"><label>Group</label><input name="group" type="text" placeholder="e.g. Editing"></div></div>',
    function(fd){
      var label = (fd.get('label')||'').trim();
      if(!label){ showModalError('Describe the task.'); return; }
      setModalBusy(true);
      var taskId = episodeId+'_custom_'+uid8();
      db.doc('tasks/'+taskId).set({
        episodeId: episodeId, episodeTitle: episode.title, clientId: episode.clientId, clientName: episode.clientName,
        role: fd.get('role'), label: label, group: (fd.get('group')||'').trim(), orderNum: 999, dependsOnLabel: '',
        dueDate: episode.dueDate, done:false, doneByUserId:null, doneAt:null, custom:true, createdAt: new Date().toISOString()
      }).then(function(){
        closeModal(); showToast('success','Custom task added');
      }).catch(function(err){ showModalError(errMsg(err)); });
    }, 'Add task');
}

function loadTaskCollab(taskId, panel){
  panel.innerHTML = '<div class="skeleton" style="height:40px;"></div>';
  Promise.all([
    supabase.from('taskComments').select('*').eq('taskId', taskId).order('createdAt', { ascending: true }),
    supabase.from('taskLinks').select('*').eq('taskId', taskId).order('createdAt', { ascending: true }),
    supabase.from('taskAttachments').select('*').eq('taskId', taskId).order('createdAt', { ascending: true }),
  ]).then(function(res){
    var comments = res[0].data||[], links = res[1].data||[], attachments = res[2].data||[];
    var ids = comments.map(function(c){return c.authorId;}).concat(links.map(function(l){return l.addedBy;})).concat(attachments.map(function(a){return a.uploadedBy;})).filter(Boolean);
    return fetchProfiles(ids).then(function(ps){
      function who(id){ return (ps[id]&&ps[id].name)||'Someone'; }
      panel.innerHTML =
        '<div class="collab-list">'+comments.map(function(c){
          return '<div class="comment-row"><span class="comment-author">'+escapeHtml(who(c.authorId))+'</span>'+escapeHtml(c.body)+' <span class="comment-time">'+fmtDateTime(c.createdAt)+'</span></div>';
        }).join('')+'</div>'+
        (links.length?'<div class="collab-list">'+links.map(function(l){ return '<div class="link-row">🔗 <a href="'+escapeHtml(l.url)+'" target="_blank" rel="noopener">'+escapeHtml(l.label||l.url)+'</a></div>'; }).join('')+'</div>':'')+
        (attachments.length?'<div class="collab-list">'+attachments.map(function(a){ return '<div class="attachment-row">📎 <a href="#" data-download-key="'+escapeHtml(a.r2Key)+'" data-download-name="'+escapeHtml(a.fileName)+'">'+escapeHtml(a.fileName)+'</a></div>'; }).join('')+'</div>':'')+
        '<div class="collab-input-row"><input type="text" id="commentInput_'+taskId+'" placeholder="Add a comment…"><button type="button" class="btn btn-sm" id="commentSend_'+taskId+'">Send</button></div>'+
        '<div class="collab-input-row"><input type="url" id="linkInput_'+taskId+'" placeholder="Paste a link…"><button type="button" class="btn btn-sm" id="linkSend_'+taskId+'">Add</button></div>'+
        '<div class="collab-input-row"><label class="btn btn-sm" style="cursor:pointer;">Attach file<input type="file" id="fileInput_'+taskId+'" style="display:none;"></label><span id="fileStatus_'+taskId+'" style="font-size:11.5px;color:var(--muted);"></span></div>';

      document.getElementById('commentSend_'+taskId).addEventListener('click', function(){
        var input = document.getElementById('commentInput_'+taskId);
        var body = input.value.trim();
        if(!body) return;
        supabase.from('taskComments').insert({ id:'cm_'+uid8(), taskId:taskId, authorId: myUid, body: body }).then(function(res2){
          if(res2.error){ showToast('error', errMsg(res2.error)); return; }
          input.value=''; loadTaskCollab(taskId, panel);
        });
      });
      document.getElementById('linkSend_'+taskId).addEventListener('click', function(){
        var input = document.getElementById('linkInput_'+taskId);
        var url = input.value.trim();
        if(!url) return;
        supabase.from('taskLinks').insert({ id:'lk_'+uid8(), taskId:taskId, addedBy: myUid, url: url }).then(function(res2){
          if(res2.error){ showToast('error', errMsg(res2.error)); return; }
          input.value=''; loadTaskCollab(taskId, panel);
        });
      });
      Array.prototype.forEach.call(panel.querySelectorAll('[data-download-key]'), function(a){
        a.addEventListener('click', function(ev){
          ev.preventDefault();
          if(a.dataset.downloading) return; // ignore rapid double-clicks while one is already in flight
          a.dataset.downloading = '1';
          var originalText = a.textContent;
          a.textContent = 'Downloading…';
          downloadProtectedFile(a.getAttribute('data-download-key'), a.getAttribute('data-download-name'))
            .then(function(saved){
              a.textContent = originalText;
              delete a.dataset.downloading;
              if(saved) showToast('success', 'Downloaded '+(a.getAttribute('data-download-name')||'file'));
            })
            .catch(function(err){
              a.textContent = originalText;
              delete a.dataset.downloading;
              showToast('error', errMsg(err));
            });
        });
      });
      document.getElementById('fileInput_'+taskId).addEventListener('change', function(ev){
        var file = ev.target.files[0]; if(!file) return;
        var statusEl = document.getElementById('fileStatus_'+taskId);
        statusEl.textContent = 'Uploading…';
        var key = 'attachments/'+taskId+'/'+Date.now()+'_'+file.name;
        uploadFile(file, key).then(function(){
          return supabase.from('taskAttachments').insert({ id:'att_'+uid8(), taskId:taskId, uploadedBy: myUid, r2Key:key, fileName:file.name, fileType:file.type, fileSize:file.size });
        }).then(function(res2){
          if(res2 && res2.error) throw res2.error;
          loadTaskCollab(taskId, panel);
        }).catch(function(err){ statusEl.textContent=''; showToast('error', errMsg(err)); });
      });
    });
  }).catch(function(err){ panel.innerHTML = '<div class="empty-state" style="padding:10px;">Could not load discussion.</div>'; });
}

// ---------- MY BOARD ----------
function renderBoard(){
  if(!myRole){
    paint('<div class="page-head"><div><div class="eyebrow">My Board</div><h1 class="page-title">Loading…</h1></div></div>');
    return;
  }
  var r = roleOf(myRole);
  var showingAll = myRole==='manager' || myRole==='admin';
  paint(
    '<div class="page-head"><div><div class="eyebrow">My Board</div><h1 class="page-title">'+(showingAll?'All open tasks':escapeHtml(r.label)+"'s tasks")+'</h1>'+
    '<div class="page-sub">'+(showingAll?'Everything across your team\'s clients, grouped by due date.':'Everything assigned to your role, across your team\'s clients.')+'</div></div></div>'+
    '<div id="boardBody"><div class="skeleton" style="height:60px;margin-bottom:10px;"></div><div class="skeleton" style="height:60px;"></div></div>'
  );

  var q = db.collection('tasks').where('done','==',false);
  if(!showingAll) q = q.where('role','==', myRole);
  q = q.orderBy('dueDate','asc').limit(200);

  var unsub = q.onSnapshot(function(snap){
    var box = document.getElementById('boardBody');
    if(!box) return;
    if(snap.empty){ box.innerHTML = '<div class="empty-state"><strong>Nothing open</strong>Every task for this view is checked off.</div>'; return; }
    var groups = {overdue:[], 'due-soon':[], upcoming:[]};
    snap.docs.forEach(function(d){
      var t = d.data(); t._id = d.id;
      var s = dueStatus(t.dueDate,false);
      (groups[s]||groups.upcoming).push(t);
    });
    var order = [['overdue','Overdue'], ['due-soon','Due within 7 days'], ['upcoming','Upcoming']];
    box.innerHTML = order.filter(function(o){ return groups[o[0]].length; }).map(function(o){
      return '<div class="board-group"><div class="board-group-title">'+o[1]+'</div>'+
        groups[o[0]].map(function(t){
          var rr = roleOf(t.role);
          return '<div class="board-task" style="border-left:3px solid '+(rr?rr.color:'var(--line)')+'">'+
            '<input type="checkbox" class="task-check" data-task="'+t._id+'">'+
            '<div class="task-body"><div class="task-label">'+escapeHtml(t.label)+'</div>'+
            '<div class="board-task-client">'+escapeHtml(t.clientName)+(showingAll?' <span class="role-chip" style="background:'+(rr?rr.color:'#888')+'">'+(rr?escapeHtml(rr.label):t.role)+'</span>':'')+'</div>'+
            '<div class="board-task-episode">'+escapeHtml(t.episodeTitle)+' · due '+fmtDate(t.dueDate)+'</div>'+
            (t.dependsOnLabel?'<div class="task-meta"><span class="task-waiting">Waiting on: '+escapeHtml(t.dependsOnLabel)+'</span></div>':'')+
            '</div></div>';
        }).join('')+
        '</div>';
    }).join('');
    Array.prototype.forEach.call(box.querySelectorAll('.task-check'), function(cb){
      cb.addEventListener('change', function(){
        var taskId = cb.getAttribute('data-task');
        db.doc('tasks/'+taskId).update({done:true, doneByUserId:myUid, doneAt:new Date().toISOString()}).catch(function(err){ cb.checked=false; showToast('error', errMsg(err)); });
      });
    });
  }, function(){ var b=document.getElementById('boardBody'); if(b) b.innerHTML='<div class="empty-state">Could not load your board.</div>'; });
  activeUnsubs.push(unsub);
}

// ---------- TIMELOG ----------
function renderTimeLog(){
  paint(
    '<div class="page-head"><div><div class="eyebrow">TimeLog</div><h1 class="page-title">Your time & activity</h1>'+
    '<div class="page-sub">Screenshots and activity are recorded automatically while you\'re clocked in. You can view your own history here, but not delete it.</div></div>'+
    '<button type="button" class="timelog-badge'+(timelog.isClockedIn()?'':' off')+'" id="clockToggleBtn">'+(timelog.isClockedIn()?'● Clocked in — stop':'Clock in')+'</button>'+
    '</div>'+
    (canManage()?'<div class="field" style="max-width:320px;margin-bottom:20px;"><label>Viewing</label><select id="timelogWho"></select></div>':'')+
    '<div class="section-head"><h2 class="section-title">Recent screenshots</h2></div>'+
    '<div id="shotGrid" class="shot-grid"><div class="skeleton" style="height:100px;"></div></div>'
  );
  document.getElementById('clockToggleBtn').addEventListener('click', function(){
    if(timelog.isClockedIn()) timelog.clockOut().then(route).catch(function(err){ showToast('error', errMsg(err)); });
    else timelog.clockIn(myUid).then(route).catch(function(err){ showToast('error', errMsg(err)); });
  });

  function loadFor(uid){
    var grid = document.getElementById('shotGrid');
    grid.innerHTML = '<div class="skeleton" style="height:100px;"></div>';
    timelog.listScreenshots(uid, 60).then(function(shots){
      if(!shots.length){ grid.innerHTML = '<div class="empty-state">No screenshots recorded yet.</div>'; return; }
      grid.innerHTML = shots.map(function(s){
        return '<div class="shot-thumb" data-shot-key="'+escapeHtml(s.r2Key)+'"><img loading="lazy"><span class="shot-time">'+fmtDateTime(s.takenAt)+'</span></div>';
      }).join('');
      // Screenshots require an authenticated fetch (see r2.js), so each
      // thumbnail's real image loads in after the fact rather than via a
      // plain src= URL.
      Array.prototype.forEach.call(grid.querySelectorAll('[data-shot-key]'), function(thumb){
        var key = thumb.getAttribute('data-shot-key');
        var img = thumb.querySelector('img');
        fetchProtectedUrl(key).then(function(url){ img.src = url; }).catch(function(){ thumb.style.opacity='.4'; });
      });
    }).catch(function(err){ grid.innerHTML = '<div class="empty-state">Could not load screenshots.</div>'; });
  }

  if(canManage()){
    var teamQuery = isAdmin() ? db.collection('profiles').get() : db.collection('profiles').where('teamId','==',myTeamId).get();
    teamQuery.then(function(snap){
      var sel = document.getElementById('timelogWho');
      sel.innerHTML = snap.docs.map(function(d){ var p=d.data(); return '<option value="'+d.id+'"'+(d.id===myUid?' selected':'')+'>'+escapeHtml(p.displayName||p.email)+(d.id===myUid?' (you)':'')+'</option>'; }).join('');
      sel.addEventListener('change', function(){ loadFor(sel.value); });
      loadFor(myUid);
    });
  } else {
    loadFor(myUid);
  }
}

// ---------- CONNECT ----------
function renderConnect(){
  paint(
    '<div class="page-head"><div><div class="eyebrow">Connect</div><h1 class="page-title">Who\'s around</h1>'+
    '<div class="page-sub">Online teammates can be reached instantly — no ringing, it just connects.</div></div>'+
    '<button type="button" class="btn btn-primary btn-sm" id="groupConnectBtn" style="width:auto;">Start a group Connect</button></div>'+
    (connectConfigured?'':'<div class="empty-state" style="margin-bottom:20px;"><strong>Connect isn\'t wired up yet</strong>This needs a Cloudflare Realtime App ID/Token — see README.md. The roster and online/offline status below already work.</div>')+
    '<div id="roster"><div class="skeleton" style="height:50px;"></div></div>'
  );
  document.getElementById('groupConnectBtn').addEventListener('click', function(){
    showToast(connectConfigured?'success':'error', connectConfigured ? 'Starting a group Connect…' : 'Connect isn\'t configured yet — see README.md.');
  });

  // Root cause of "employee doesn't see admin online" (one-directional
  // presence): this used to filter non-admins down to `.where('teamId','==',
  // myTeamId)`, which always excludes Admin — Admin's own profile has no
  // teamId at all. Presence itself was never one-directional; the roster
  // *query* just never asked for Admin's row in the first place. Dropping
  // the explicit filter and letting RLS scope the result (own team + any
  // Admins, or everyone for Admin) fixes it without weakening access.
  var q = db.collection('profiles').get();
  q.then(function(snap){
    var roster = document.getElementById('roster');
    var rows = snap.docs.filter(function(d){ return d.id!==myUid; });
    if(!rows.length){ roster.innerHTML = '<div class="empty-state">No teammates yet.</div>'; return; }
    function paintRoster(){
      roster.innerHTML = rows.map(function(d){
        var p = d.data();
        var r = roleOf(p.role);
        var online = isOnline(d.id);
        return '<div class="roster-row"><span class="presence-dot'+(online?' online':'')+'"></span>'+
          '<div><div class="roster-name">'+escapeHtml(p.displayName||p.email)+'</div><div class="roster-role">'+(r?escapeHtml(r.label):p.role)+'</div></div>'+
          '<button type="button" class="connect-btn" data-connect="'+d.id+'" '+(online?'':'disabled')+'>'+(online?'Connect':'Offline')+'</button></div>';
      }).join('');
      Array.prototype.forEach.call(roster.querySelectorAll('[data-connect]:not([disabled])'), function(btn){
        btn.addEventListener('click', function(){
          showToast(connectConfigured?'success':'error', connectConfigured ? 'Connecting…' : 'Connect isn\'t configured yet — see README.md.');
        });
      });
    }
    paintRoster();
    var offPresence = onPresenceChange(paintRoster);
    activeUnsubs.push(offPresence);
  }).catch(function(err){ showToast('error', errMsg(err)); });
}

// ---------- TEAM SETTINGS (Manager) ----------
function renderTeamSettings(){
  paint(
    '<div class="page-head"><div><div class="eyebrow">Team</div><h1 class="page-title">'+escapeHtml(teamName(myTeamId))+'</h1>'+
    '<div class="page-sub">Roster, invites, and your team\'s service vocabulary.</div></div>'+
    '<button type="button" class="btn btn-primary btn-sm" id="inviteBtn" style="width:auto;">+ Invite teammate</button></div>'+
    '<div class="section-head"><h2 class="section-title">Roster</h2></div><div id="rosterBox"><div class="skeleton" style="height:50px;"></div></div>'+
    '<div class="section"><div class="section-head"><h2 class="section-title">Pending invites</h2></div><div id="invitesBox"><div class="skeleton" style="height:40px;"></div></div></div>'+
    '<div class="section"><div class="section-head"><h2 class="section-title">Team services</h2><button type="button" class="btn btn-sm" id="newServiceBtn2">+ New service type</button></div><div id="teamServicesBox"></div></div>'
  );
  document.getElementById('inviteBtn').addEventListener('click', openInviteModal);
  document.getElementById('newServiceBtn2').addEventListener('click', function(){ openCreateServiceTypeModal(null); });

  db.collection('profiles').where('teamId','==',myTeamId).get().then(function(snap){
    var box = document.getElementById('rosterBox');
    box.innerHTML = snap.docs.map(function(d){
      var p = d.data(); var r = roleOf(p.role);
      return '<div class="roster-row"><span class="presence-dot'+(isOnline(d.id)?' online':'')+'"></span>'+
        '<div><div class="roster-name">'+escapeHtml(p.displayName||p.email)+'</div><div class="roster-role">'+(r?escapeHtml(r.label):p.role)+'</div></div></div>';
    }).join('') || '<div class="empty-state">No teammates yet — invite your first one.</div>';
  });

  listInvites(myTeamId).then(function(invites){
    var box = document.getElementById('invitesBox');
    var pending = invites.filter(function(i){ return !i.usedAt; });
    box.innerHTML = pending.length ? pending.map(function(i){
      return '<div class="roster-row"><div><div class="roster-name">'+escapeHtml(i.email)+'</div><div class="roster-role">'+escapeHtml(roleOf(i.role)?roleOf(i.role).label:i.role)+' · code <span class="mono">'+escapeHtml(i.id)+'</span></div></div></div>';
    }).join('') : '<div class="empty-state">No pending invites.</div>';
  }).catch(function(){ document.getElementById('invitesBox').innerHTML = '<div class="empty-state">Could not load invites.</div>'; });

  var svcBox = document.getElementById('teamServicesBox');
  var mine = servicesCache.filter(function(s){ return s.teamId===myTeamId; });
  svcBox.innerHTML = mine.length ? mine.map(function(s){ return '<span class="tag">'+escapeHtml(s.name)+' <button type="button" class="tag-remove" data-del-svc="'+s.id+'">✕</button></span>'; }).join('') : '<div class="empty-state">No team-specific services yet.</div>';
  Array.prototype.forEach.call(svcBox.querySelectorAll('[data-del-svc]'), function(btn){
    btn.addEventListener('click', function(){
      if(!confirm('Delete this service from the vocabulary?')) return;
      deleteService(btn.getAttribute('data-del-svc')).then(function(){ refreshServicesCache().then(function(){ route(); }); }).catch(function(err){ showToast('error', errMsg(err)); });
    });
  });
}

// A plain alert() box was the old way of showing a freshly-created invite
// code — its text isn't reliably selectable/copyable in a webview, which is
// exactly what was reported. This shows the code in a real input with a
// Copy button instead, using the clipboard API with an execCommand
// fallback for older webview builds.
function showInviteCodeModal(email, roleLabel, code){
  openModal('Invite created',
    '<div class="field"><label>Invite code for '+escapeHtml(email)+(roleLabel?' ('+escapeHtml(roleLabel)+')':'')+'</label>'+
    '<div style="display:flex;gap:8px;"><input type="text" id="inviteCodeField" value="'+escapeHtml(code)+'" readonly style="flex:1;font-family:monospace;font-size:15px;letter-spacing:.5px;"><button type="button" class="btn btn-sm" id="copyInviteBtn" style="width:auto;flex-shrink:0;">Copy</button></div></div>'+
    '<p style="font-size:12.5px;color:var(--muted);margin-top:10px;">Send this to them along with the sign-up screen — they\'ll need this exact code plus this exact email to create their account.</p>',
    function(){ closeModal(); }, 'Done');
  var field = document.getElementById('inviteCodeField');
  var copyBtn = document.getElementById('copyInviteBtn');
  if(copyBtn) copyBtn.addEventListener('click', function(){
    function copied(){ copyBtn.textContent = 'Copied!'; setTimeout(function(){ copyBtn.textContent = 'Copy'; }, 1500); }
    if(navigator.clipboard && navigator.clipboard.writeText){
      navigator.clipboard.writeText(code).then(copied).catch(function(){ fallbackCopy(); });
    } else { fallbackCopy(); }
    function fallbackCopy(){
      try{ field.focus(); field.select(); document.execCommand('copy'); copied(); }
      catch(e){ showToast('error', 'Could not copy — select the code and copy it manually.'); }
    }
  });
}

function openInviteModal(){
  openModal('Invite a teammate', '<div class="field"><label>Email</label><input required name="email" type="email" placeholder="name@bluekitemedia.com"></div>'+
    '<div class="field"><label>Role</label><select name="role">'+INVITABLE_ROLES.map(function(r){return '<option value="'+r.key+'">'+escapeHtml(r.label)+'</option>';}).join('')+'</select></div>',
    function(fd){
      var email = (fd.get('email')||'').trim();
      if(!email){ showModalError('Enter their email.'); return; }
      setModalBusy(true);
      var roleLabel = (INVITABLE_ROLES.filter(function(r){ return r.key===fd.get('role'); })[0]||{}).label;
      createInvite(email, fd.get('role'), myTeamId, myUid).then(function(invite){
        showInviteCodeModal(email, roleLabel, invite.id);
        route();
      }).catch(function(err){ showModalError(errMsg(err)); });
    }, 'Create invite');
}

// ---------- ADMIN ----------
function renderAdmin(){
  paint(
    '<div class="page-head"><div><div class="eyebrow">Admin</div><h1 class="page-title">Teams & company settings</h1>'+
    '<div class="page-sub">Only visible to you.</div></div>'+
    '<button type="button" class="btn btn-primary btn-sm" id="newTeamBtn" style="width:auto;">+ New Team</button></div>'+
    '<div id="teamsBox"><div class="skeleton" style="height:80px;"></div></div>'+
    '<div class="section"><div class="section-head"><h2 class="section-title">Global services</h2><button type="button" class="btn btn-sm" id="newGlobalServiceBtn">+ New service type</button></div><div id="globalServicesBox"></div></div>'
  );
  document.getElementById('newTeamBtn').addEventListener('click', function(){
    openModal('New Team', '<div class="field"><label>Team name</label><input required name="name" type="text" placeholder="e.g. Team B"></div>',
      function(fd){
        var name = (fd.get('name')||'').trim();
        if(!name){ showModalError('Name the team.'); return; }
        setModalBusy(true);
        createTeam(name).then(function(){ closeModal(); showToast('success','Team created'); refreshTeamsCache().then(route); }).catch(function(err){ showModalError(errMsg(err)); });
      }, 'Create');
  });
  document.getElementById('newGlobalServiceBtn').addEventListener('click', function(){ openCreateServiceTypeModal(null); });

  Promise.all([listTeams(), db.collection('profiles').get()]).then(function(res){
    var teams = res[0], profiles = res[1].docs.map(function(d){ return Object.assign({id:d.id}, d.data()); });
    var box = document.getElementById('teamsBox');
    box.innerHTML = teams.map(function(t){
      var manager = profiles.filter(function(p){ return p.id===t.managerId; })[0];
      var memberOpts = profiles.filter(function(p){ return p.role!=='admin'; }).map(function(p){ return '<option value="'+p.id+'"'+(p.id===t.managerId?' selected':'')+'>'+escapeHtml(p.displayName||p.email)+(p.teamId?' ('+escapeHtml(teamName(p.teamId))+')':'')+'</option>'; }).join('');
      return '<div class="panel" style="margin-bottom:12px;"><h3>'+escapeHtml(t.name)+'</h3>'+
        '<div style="font-size:13px;color:var(--muted);margin-bottom:10px;">Manager: '+(manager?escapeHtml(manager.displayName||manager.email):'— none assigned —')+'</div>'+
        '<div class="field-row"><div class="field"><label>Assign/change Manager (promotes an existing profile)</label><select data-assign-mgr="'+t.id+'"><option value="">— choose —</option>'+memberOpts+'</select></div>'+
        '<div class="field"><label>Or invite a new Manager by email</label><input type="email" placeholder="name@bluekitemedia.com" data-invite-mgr="'+t.id+'"></div></div>'+
        '</div>';
    }).join('') || '<div class="empty-state">No teams yet — create your first one.</div>';

    Array.prototype.forEach.call(box.querySelectorAll('[data-assign-mgr]'), function(sel){
      sel.addEventListener('change', function(){
        if(!sel.value) return;
        assignTeamManager(sel.getAttribute('data-assign-mgr'), sel.value).then(function(){ showToast('success','Manager assigned'); route(); }).catch(function(err){ showToast('error', errMsg(err)); });
      });
    });
    Array.prototype.forEach.call(box.querySelectorAll('[data-invite-mgr]'), function(input){
      input.addEventListener('keydown', function(ev){
        if(ev.key!=='Enter') return;
        ev.preventDefault();
        var email = input.value.trim();
        if(!email) return;
        createInvite(email, 'manager', input.getAttribute('data-invite-mgr'), myUid).then(function(invite){
          input.value='';
          showInviteCodeModal(email, 'Manager', invite.id);
          route();
        }).catch(function(err){ showToast('error', errMsg(err)); });
      });
    });
  });

  var gBox = document.getElementById('globalServicesBox');
  var globals = servicesCache.filter(function(s){ return s.scope==='global'; });
  gBox.innerHTML = globals.length ? globals.map(function(s){ return '<span class="tag tag-global">'+escapeHtml(s.name)+' <button type="button" class="tag-remove" data-del-svc="'+s.id+'">✕</button></span>'; }).join('') : '<div class="empty-state">No global services yet.</div>';
  Array.prototype.forEach.call(gBox.querySelectorAll('[data-del-svc]'), function(btn){
    btn.addEventListener('click', function(){
      if(!confirm('Delete this global service?')) return;
      deleteService(btn.getAttribute('data-del-svc')).then(function(){ refreshServicesCache().then(route); }).catch(function(err){ showToast('error', errMsg(err)); });
    });
  });
}

document.getElementById('navAddClient').addEventListener('click', openAddClientModal);

// ---------- AUTH SCREEN ----------
var pendingAvatarBlob = null;
function renderAuthScreen(mode){
  mode = mode || 'signin';
  var shell = document.getElementById('shell');
  if(shell) shell.style.display = 'none';
  var existing = document.getElementById('authScreen');
  var isSignup = mode === 'signup';
  var html =
    '<div class="login-card">'+
    '<div class="login-brand"><div class="brand-mark"><img src="/logo-mark.png" alt="Blue Kite Media"></div><div><div class="brand-name">Blue Kite Media</div><div class="brand-sub">Production Ops</div></div></div>'+
    '<div class="login-title">'+(isSignup?'Create your account':'Sign in')+'</div>'+
    '<div class="login-sub">'+(isSignup?'You\'ll need the invite code your manager or admin sent you — unless you\'re the very first person setting this up.':'Use your Blue Kite Ops account.')+'</div>'+
    '<div class="login-error" id="authError"></div>'+
    '<form id="authForm">'+
    (isSignup?'<div class="login-field"><label>Your name</label><input name="displayName" type="text" placeholder="Jane Doe" required></div>':'')+
    '<div class="login-field"><label>Email</label><input required name="email" type="email" placeholder="you@bluekitemedia.com"></div>'+
    '<div class="login-field"><label>Password</label><input required name="password" type="password" placeholder="••••••••" minlength="6"></div>'+
    (isSignup?'<div class="login-field"><label>Invite code (leave blank only if you\'re the first-ever account)</label><input name="inviteCode" type="text" placeholder="e.g. 9f2ac1"></div>':'')+
    (isSignup?'<div class="login-field"><label>Profile photo (must show your face)</label><div class="avatar-drop" id="avatarDrop"><div class="avatar-drop-hint" id="avatarHint">Click to choose a photo</div><input type="file" accept="image/*" id="avatarInput" style="display:none;"></div></div>':'')+
    (isSignup?'<div class="login-field"><label>What do you prefer listening to when working?</label><div class="mood-grid" id="moodGrid">'+MOODS.map(function(m){return '<button type="button" class="mood-pick" data-mood="'+m.key+'">'+escapeHtml(m.label)+'</button>';}).join('')+'</div><input type="hidden" name="musicMood"></div>':'')+
    '<button type="submit" class="btn btn-primary" id="authSubmit">'+(isSignup?'Create account':'Sign in')+'</button>'+
    '</form>'+
    '<div class="login-switch">'+(isSignup?'Already have an account? <button type="button" id="authSwitch">Sign in</button>':'New here (have an invite code)? <button type="button" id="authSwitch">Create an account</button>')+'</div>'+
    '<div class="login-note">Your account is scoped to this Blue Kite Ops project.</div>'+
    '</div>';

  if(existing){ existing.innerHTML = html; }
  else {
    var el = document.createElement('div');
    el.id = 'authScreen';
    el.innerHTML = html;
    document.body.appendChild(el);
  }
  document.getElementById('authSwitch').addEventListener('click', function(){ pendingAvatarBlob=null; renderAuthScreen(isSignup?'signin':'signup'); });

  if(isSignup){
    var moodGrid = document.getElementById('moodGrid');
    var moodInput = document.querySelector('input[name=musicMood]');
    Array.prototype.forEach.call(moodGrid.querySelectorAll('.mood-pick'), function(btn){
      btn.addEventListener('click', function(){
        Array.prototype.forEach.call(moodGrid.querySelectorAll('.mood-pick'), function(b){ b.classList.remove('selected'); });
        btn.classList.add('selected');
        moodInput.value = btn.getAttribute('data-mood');
      });
    });
    var avatarDrop = document.getElementById('avatarDrop');
    var avatarInput = document.getElementById('avatarInput');
    avatarDrop.addEventListener('click', function(){ avatarInput.click(); });
    avatarInput.addEventListener('change', function(){
      var file = avatarInput.files[0]; if(!file) return;
      var hint = document.getElementById('avatarHint');
      hint.textContent = 'Checking for a face…';
      imageHasFace(file).then(function(ok){
        if(!ok){ hint.textContent = 'No face detected — please choose a clear photo of yourself.'; pendingAvatarBlob=null; return; }
        return compressImage(file, {maxWidth:400,maxHeight:400,quality:.85}).then(function(blob){
          pendingAvatarBlob = blob;
          var url = URL.createObjectURL(blob);
          avatarDrop.innerHTML = '<img src="'+url+'"><div class="avatar-drop-hint">Looks good — click to change</div>';
          avatarDrop.appendChild(avatarInput);
        });
      }).catch(function(){ hint.textContent = 'Could not check this photo — click to try another.'; });
    });
  }

  document.getElementById('authForm').addEventListener('submit', function(e){
    e.preventDefault();
    var fd = new FormData(e.target);
    var email = (fd.get('email')||'').trim();
    var password = fd.get('password')||'';
    var errEl = document.getElementById('authError');
    var btn = document.getElementById('authSubmit');
    errEl.textContent = '';
    if(isSignup && !pendingAvatarBlob){ errEl.textContent = 'A profile photo with your face is required.'; return; }
    btn.disabled = true; btn.textContent = isSignup ? 'Creating…' : 'Signing in…';
    var task = isSignup
      ? signUp(email, password, (fd.get('displayName')||'').trim(), (fd.get('inviteCode')||'').trim())
      : signIn(email, password);
    task.then(function(result){
      if(isSignup && result && result.user){
        var uid = result.user.id;
        var musicMood = fd.get('musicMood')||'';
        var key = 'avatars/'+uid+'/photo.jpg';
        // These two used to be chained (mood-save only ran after the avatar
        // upload succeeded), so a single failed/slow upload silently took
        // both down with it and the error never surfaced anywhere — just a
        // console.warn nobody sees. Now they're independent: each saves on
        // its own and reports its own failure via a toast once the app has
        // loaded, instead of quietly leaving the profile half-filled-in.
        var avatarDone = uploadFile(new File([pendingAvatarBlob],'photo.jpg',{type:'image/jpeg'}), key)
          .then(function(){ return db.doc('profiles/'+uid).update({ avatarUrl: fileUrl(key) }); })
          .catch(function(err){
            console.warn('[blue-kite-ops] avatar upload failed:', err);
            setTimeout(function(){ showToast('error', 'Your profile photo didn\'t save ('+errMsg(err)+'). Ask an admin to help you re-add it.'); }, 800);
          });
        var moodDone = musicMood
          ? db.doc('profiles/'+uid).update({ musicMood: musicMood }).catch(function(err){
              console.warn('[blue-kite-ops] music mood save failed:', err);
              setTimeout(function(){ showToast('error', 'Your music mood didn\'t save ('+errMsg(err)+'). Ask an admin to help you set it.'); }, 800);
            })
          : Promise.resolve();
        return Promise.all([avatarDone, moodDone]);
      }
    }).then(function(){
      // onAuthStateChange (wired in boot()) takes it from here.
    }).catch(function(err){
      btn.disabled = false; btn.textContent = isSignup ? 'Create account' : 'Sign in';
      errEl.textContent = errMsg(err);
    });
  });
}

function hideAuthScreen(){
  var el = document.getElementById('authScreen');
  if(el) el.remove();
  var shell = document.getElementById('shell');
  if(shell) shell.style.display = '';
}

// ---------- CLOCK-IN OVERLAY ----------
function showClockInOverlay(){
  if(document.getElementById('clockinOverlay')) return;
  var el = document.createElement('div');
  el.id = 'clockinOverlay';
  el.className = 'clockin-overlay';
  el.innerHTML = '<div class="clockin-card">'+
    '<button type="button" class="clockin-close" id="clockinCloseBtn">✕</button>'+
    '<div class="clockin-icon">⏱</div>'+
    '<div class="clockin-title">Ready to start your day?</div>'+
    '<div class="clockin-sub">Clocking in starts your hourly timer. While you\'re clocked in, Blue Kite Ops takes occasional screenshots and tracks keyboard/mouse activity — you can review your own history under TimeLog any time.</div>'+
    '<button type="button" class="btn btn-primary" id="clockinStartBtn">Clock in</button>'+
    '<div id="clockinStatus"></div>'+
    '</div>';
  document.body.appendChild(el);
  document.getElementById('clockinCloseBtn').addEventListener('click', function(){ el.remove(); });
  document.getElementById('clockinStartBtn').addEventListener('click', function(){
    timelog.clockIn(myUid).then(function(){
      document.getElementById('clockinStatus').innerHTML = '<div class="clockin-status"><span class="pulse-dot"></span> Clocked in — you can close this.</div>';
      setTimeout(function(){ el.remove(); if(location.hash.replace('#','')==='/timelog') route(); }, 1400);
    }).catch(function(err){ showToast('error', errMsg(err)); });
  });
}

// ---------- BOOT ----------
(function boot(){
  initTheme();
  // See src/lib/timelog.js — screenshot/activity capture failures used to
  // be swallowed silently (console.warn at best), which is exactly why
  // testing showed no visible symptom at all. Now they surface as a toast.
  timelog.setCaptureErrorHandler(function(message){ showToast('error', message); });
  if(!supabaseConfigured){
    document.getElementById('shell').style.display = 'none';
    var el = document.createElement('div');
    el.id = 'authScreen';
    el.innerHTML = '<div class="login-card"><div class="login-brand"><div class="brand-mark"><img src="/logo-mark.png" alt="Blue Kite Media"></div><div><div class="brand-name">Blue Kite Media</div><div class="brand-sub">Production Ops</div></div></div>'+
      '<div class="login-title">Not configured yet</div>'+
      '<div class="login-sub">Copy <code>.env.example</code> to <code>.env</code>, fill in your Supabase project URL and anon key, then restart the app. See README.md for the full setup.</div></div>';
    document.body.appendChild(el);
    return;
  }

  var themeToggle = document.getElementById('themeToggle');
  if(themeToggle) themeToggle.addEventListener('click', toggleTheme);

  var boundOnce = false;
  var lastUid = null;

  onAuthStateChange(function(session){
    if(!session){
      clearSubs();
      if(profileUnsub){ profileUnsub(); profileUnsub = null; }
      myUid = null; myRole = null; myProfile = null; myTeamId = null; lastUid = null; boundOnce = false;
      stopPresence();
      renderAuthScreen('signin');
      return;
    }
    myUid = session.user.id;
    hideAuthScreen();
    var who = document.getElementById('whoAmI');
    if(who) who.textContent = session.user.user_metadata && session.user.user_metadata.display_name ? session.user.user_metadata.display_name : session.user.email;
    var signOutBtn = document.getElementById('signOutBtn');
    if(signOutBtn){
      signOutBtn.hidden = false;
      signOutBtn.onclick = function(){ timelog.clockOut().catch(function(){}); signOut().catch(function(err){ showToast('error', errMsg(err)); }); };
    }

    if(!boundOnce){
      boundOnce = true;
      subscribeClientNav();
      refreshTeamsCache();
    }

    if(lastUid !== myUid){
      lastUid = myUid;
      if(profileUnsub){ profileUnsub(); profileUnsub = null; }
      profileUnsub = db.doc('profiles/'+myUid).onSnapshot(function(snap){
        var wasFirstLoad = !myProfile;
        var p = snap.exists ? snap.data() : null;
        myProfile = p;
        myRole = p ? p.role : null;
        myTeamId = p ? p.teamId : null;
        document.getElementById('navAddClient').hidden = !canManage();
        var teamNav = document.getElementById('navTeam'); if(teamNav) teamNav.hidden = myRole!=='manager';
        var adminNav = document.getElementById('navAdmin'); if(adminNav) adminNav.hidden = !isAdmin();
        renderIdentityCard();
        Promise.all([refreshTeamsCache(), refreshServicesCache()]).then(route);
        if(wasFirstLoad && p){
          startPresence(myUid, { displayName: p.displayName });
          listenForConnects(myUid, function(payload){
            showToast('success', (payload.from&&payload.from.name||'Someone')+' is connecting with you…');
          });
          if(p.musicMood && p.musicMood!=='none'){ mountMusicPlayer(); musicPlayer.initPlayer('ytMusicMount', p.musicMood); }
          setTimeout(showClockInOverlay, 600);
        }
      }, function(){ renderRoleBoxFallback(); route(); });
    }
  });
})();
var musicPlayerBuilt = false;
function mountMusicPlayer(){
  var box = document.getElementById('musicPlayerBox');
  if(!box) return;
  if(!musicPlayerBuilt){
    musicPlayerBuilt = true;
    // Built once and never replaced wholesale afterward: #ytMusicMount gets
    // handed to the YouTube IFrame API as a live player instance, and
    // regenerating this markup on every state change (as the old
    // self-hosted-<audio> version safely could) would tear that player
    // down and reconnect it constantly.
    box.innerHTML =
      '<div class="music-player">'+
        '<div class="music-frame" id="ytMusicMount"></div>'+
        '<div class="music-meta" id="musicMeta">—</div>'+
        '<div class="music-row">'+
          '<button type="button" class="music-btn" id="musicToggleBtn" title="Play/pause">▶</button>'+
          '<button type="button" class="music-btn" id="musicSkipBtn" title="Change track">⏭</button>'+
          '<button type="button" class="music-btn" id="musicMuteBtn" title="Mute">🔊</button>'+
          '<input type="range" class="music-volume" id="musicVolume" min="0" max="100" value="70" title="Volume">'+
        '</div>'+
        '<select class="music-mood-select" id="musicMoodSelect">'+MOODS.filter(function(m){return m.key!=='none';}).map(function(m){return '<option value="'+m.key+'">'+escapeHtml(m.label)+'</option>';}).join('')+'</select>'+
      '</div>';
    document.getElementById('musicToggleBtn').addEventListener('click', musicPlayer.toggle);
    document.getElementById('musicSkipBtn').addEventListener('click', musicPlayer.next);
    document.getElementById('musicMuteBtn').addEventListener('click', musicPlayer.toggleMute);
    document.getElementById('musicVolume').addEventListener('input', function(e){ musicPlayer.setVolume(+e.target.value); });
    document.getElementById('musicMoodSelect').addEventListener('change', function(e){ musicPlayer.setMood(e.target.value); });
  }
  musicPlayer.onPlayerChange(function(s){
    var meta = document.getElementById('musicMeta');
    var toggleBtn = document.getElementById('musicToggleBtn');
    var muteBtn = document.getElementById('musicMuteBtn');
    var volume = document.getElementById('musicVolume');
    var moodSelect = document.getElementById('musicMoodSelect');
    if(!meta) return; // widget got torn down (e.g. sign-out) — nothing to update
    if(!s.hasTracks){
      meta.textContent = 'No tracks in "'+(s.moodLabel||s.mood||'')+'" yet';
      return;
    }
    meta.textContent = (s.track && s.track.title) ? s.track.title : (s.moodLabel||'Loading…');
    if(toggleBtn) toggleBtn.textContent = s.playing ? '❚❚' : '▶';
    if(muteBtn) muteBtn.textContent = s.muted ? '🔇' : '🔊';
    if(volume && document.activeElement!==volume) volume.value = s.volume;
    if(moodSelect && moodSelect.value!==s.mood) moodSelect.value = s.mood;
  });
}

function renderRoleBoxFallback(){ var box=document.getElementById('roleBox'); if(box) box.innerHTML='<div class="role-box-label">Could not load your profile.</div>'; }
