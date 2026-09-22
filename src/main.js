import { supabase, supabaseConfigured } from './lib/supabaseClient.js';
import { db, randomId } from './lib/db.js';
import { signUp, signIn, signOut, getSession, onAuthStateChange, fetchProfiles, updateEmail, updatePassword } from './lib/auth.js';
import { listTeams, createTeam, assignTeamManager, clearTeamManager, createInvite, listInvites, cancelInvite, listServices, createService, deleteService, listAllRoles, listRolesFor, assignRoles } from './lib/teams.js';
import { startPresence, stopPresence, isOnline, onPresenceChange } from './lib/presence.js';
import { compressImage } from './lib/imageCompress.js';
import { imageHasFace } from './lib/faceDetect.js';
import { uploadFile, fileUrl, fetchProtectedUrl, downloadProtectedFile, deleteRemoteFile, r2Configured } from './lib/r2.js';
import * as timelog from './lib/timelog.js';
import * as musicPlayer from './lib/music.js';
import { MOODS } from './lib/music.js';
import { connectConfigured, listenForConnects, newCallId, ring, declineRing, joinCallRoom, startLocalSession, pullRemoteTrack, endSession } from './lib/connect.js';

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
// Everything an Admin can hand out to an existing employee or a fresh
// invite, short of the (single, effectively-permanent) Admin role itself -
// this is what lets multiple people share 'manager' on the same team, since
// it's just a per-person role+team assignment, not a one-slot field.
var ASSIGNABLE_ROLES = ROLES.filter(function(r){ return r.key!=='admin'; });
var CLIENT_COLORS = ['#2f8fd1','#3f6b8a','#7a5ea8','#4f8f6b','#b8567a','#a15c2f'];
var WEEKDAY_NAMES = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

function roleOf(key){ for(var i=0;i<ROLES.length;i++){ if(ROLES[i].key===key) return ROLES[i]; } return null; }
// ---------- MULTIPLE DEPENDENCIES (2026-09-22) ----------
// A step (and the tasks generated from it) can now wait on more than one
// other step, not just one. Both helpers below fall back to the old
// single-value field (dependsOnStepId) when the new array field
// (dependsOnStepIds) isn't set - this is what lets a template step or a
// task generated BEFORE this round keep working exactly as it did,
// without any data migration: nothing has to rewrite old rows, they just
// read as a one-item array.
function stepDepIds(step){
  if(step && step.dependsOnStepIds && step.dependsOnStepIds.length) return step.dependsOnStepIds;
  if(step && step.dependsOnStepId) return [step.dependsOnStepId];
  return [];
}
function taskDepStepIds(task){
  if(task && task.dependsOnStepIds && task.dependsOnStepIds.length) return task.dependsOnStepIds;
  if(task && task.dependsOnStepId) return [task.dependsOnStepId];
  return [];
}
// ---------- LIVE DEPENDENCY LOOKUP (2026-09-23) ----------
// taskDepStepIds() above reads a task's OWN copy of its dependency, baked in
// once at the moment its episode was generated from a template (see
// generateEpisodesForRule) - editing a step's dependency in Workflows after
// that never reached any episode already generated from it, which is
// exactly what Humayun reported as a dependency "still" not showing up on
// the checklist. Per his explicit call, a dependency edit should apply
// everywhere immediately, not just to episodes generated afterward - so
// both the episode page and My Board now look up a task's dependency LIVE,
// straight off the current template step, and only fall back to the task's
// own baked-in copy when there's no live step to check at all: a custom
// task (openAddCustomTaskModal - never had a template step to begin with),
// a one-off episode (no template), or a step that's since been deleted from
// the template (fails open onto the old snapshot rather than leaving the
// task locked forever on something that no longer exists).
//
// A task's own stepId isn't stored as its own field - it's the second half
// of its deterministic id (episodeId + '_' + stepId, see
// generateEpisodesForRule) - so it's recovered here by stripping the
// episodeId prefix rather than needing a schema change. `stepById` is a
// plain {stepId: step} map built once per template fetch by the caller
// (renderEpisode fetches its one template; renderBoard fetches every
// distinct template its visible tasks span) - callers with no template at
// all (or while it's still loading) pass {}, which safely falls through to
// the old baked-in behavior below.
function liveDepStepIds(t, stepById){
  var prefix = (t && t.episodeId ? t.episodeId : '')+'_';
  var stepId = (t && t._id && t._id.indexOf(prefix)===0) ? t._id.slice(prefix.length) : null;
  var liveStep = (stepId && stepById) ? stepById[stepId] : null;
  return liveStep ? stepDepIds(liveStep) : taskDepStepIds(t);
}
function ordinal(n){ if(n===-1) return 'Last'; var s=['','1st','2nd','3rd','4th']; return s[n]||(n+'th'); }
function escapeHtml(s){ return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];}); }
// Turns bare URLs typed into plain comment text into real clickable links -
// previously only the dedicated "Paste a link…" field produced a clickable
// result, so a URL typed straight into a comment just sat there as text.
// Operates on already-escapeHtml()'d text (safe: the pattern below can't
// match anything that would introduce a tag), so it's fine to inject the
// resulting <a> markup straight into innerHTML.
function linkifyHtml(escaped){
  return escaped.replace(/((?:https?:\/\/|www\.)[^\s<]+)/gi, function(match){
    // Trim off trailing punctuation that's almost always part of the
    // sentence, not the URL (e.g. "check this out: https://x.com/y." or a
    // link in parentheses).
    var trail = '';
    var m = match.match(/[).,;:!?]+$/);
    if(m){ trail = m[0]; match = match.slice(0, -trail.length); }
    if(!match) return match + trail;
    var href = /^https?:\/\//i.test(match) ? match : 'https://' + match;
    return '<a href="' + href + '" target="_blank" rel="noopener">' + match + '</a>' + trail;
  });
}
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

// A short beep, embedded as base64 so a screenshot notice never depends on
// an extra asset file shipping correctly. Generated once (8kHz, ~0.15s tone
// with a linear fade-out) - see the punch-list notes for how it was made.
var SCREENSHOT_BEEP = 'data:audio/wav;base64,UklGRoQJAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YWAJAAAAAE4irC4/HTT5jdl60nToaQ3BKWsrYhFP7NvTmdcc9YMZli2MJDcEQOH10Q/gggJNI4YtsRre9u7Y9tMY64QP/CmgKbgOeeoE1KfZvvcLGwktRiKrAQ7g4NKA4ukEIiRBLCIYqfR62I7Vte18EQ0qwCcaDMnoVdTF2076ahxYLPYfOP8H3+3T9OQzB8wk3iqXFZTyMNg910rwUBP1Kc0liwlA583U8N3J/KAdgyufHd78Kt4Z1WrnYAlMJWEpEBOi8BDYAtnT8v4UtynKIw0H3uVp1SbgLv+tHo4qRBuf+nbdY9bd6WwLoyXMJ5IQ0u4X2NvaTvWHFlIpuiGiBKXkKNZi4noBkh95KegYffjs3MfXTOxYDdElICYeDiftRNjD3Ln36RfKKJ8fTQKT4wjXpOSsA04gRyiMFnr2idxE2bTuIg/ZJWIktwug65fYut4S+iQZHyh7HRAAqeIH2OjmwgXhIPsmNRSW9E7c1toT8ckQuyWSIl8JP+oO2bzgV/w5GlMnUxvs/efhItks6bsHTiGWJeMR0/I53HzcZfNMEngltSAYBwPpptnG4oX+JxtqJicZ4vtL4VjabOuWCZQhGySaDzLxSdwz3qr1qxMSJcwe5QTt517a1uSbAO4bYyX7FvT51+Cm26ftUQu0IY0iXA2z737c+N/e9+YUiyTaHMcC/eY12+rmlwKQHEMk0hQj+IfgCt3a7+wMsCHuICwLV+7U3MnhAPr8FeUj4hq/ADLmJ9z+6HkECx0KI60ScfZd4IHeA/JlDokhQB8LCR7tS92j4w787hYhI+YY0f6M5TTdEes/BmIdvCGQEN/0VuAK4CD0vA9AIYcd+wYJ7OLdhOUF/rsXQCLoFvz8C+VY3h/t5weVHVogfA5s83HgoeEu9vEQ1yDDG/4EGOuV3mnn5v9kGEch7BRD+67kkt8n73AJph3nHnMMG/Ku4ETjLPgDElAg+RkWA0rqZN9Q6awB6Rg1IPQSpvlz5N/gJ/HbCpQdZR14CuvwCuHx5Bf68xKrHyoYRQGg6U3gNutZA0sZDh8BESb4XOQ+4hvzJQxiHdgbjQjc74Xhpubu+8AT7B5aFo7/GelN4Rnt6gSKGdQdFg/F9mXkq+MC9U8NER1AGrQG8O4b4l/or/1qFBMeiRTu/bPoYuL37l8GqBmJHDYNgvWO5CTl2vZZDqIcoRjuBCXuzeIa6ln/8xQkHbsSafxw6IrjzfC2B6YZLxtiC1/01eSo5qL4QQ8YHP0WPQN77Zfj1uvpAFoVHxzyEAD7TejD5Jny8AiFGckZnQlc8znlMuhW+gkQdBtWFaIB8+x35I/tYQKgFQgbMA+z+UnoCuZZ9AsKRhlaGOgHefK55cLp9/uwELcarxMgAIzsbOVE774DxxXgGXgNhPhk6F7nDPYGC+sY4hZFBrbxUuZV64L9NhHkGQoSt/5E7HTm8fD/BM4VqhjLC3L3nei76K/34wt0GGUVtQQT8QPn6ez1/p0R/BhpEGf9HOyM55byIwa4FWgXKwp/9vHoIepB+aEM5RflEzoDj/DK53ruUADkEQMYzg4z/BLss+gx9CsHhRUbFpoIqvVf6Yvrv/o/DT4XZRLWASvwpegI8JIBDRL5FjwNGfsl7OXpvvUVCDcVxxQaB/P05un57Cn8vg2CFuYQigDl75HpkPG6AhgS4RW1Cx36VOwh6z334gjPFG4TrQVb9ITqZ+5+/R8OsxVrD1f/ve+O6g/zxgMHEr0UOgo8+Z7sZeyr+JEJTxQSElME4fM369Tvu/5iDtEU9g09/rHvmeuE9LgE2xGQE80IefgB7a7tB/oiCrgTtRAPA4Tz/es98eD/iA7gE4gMPf3C76/s7fWNBZQRXBJwB9P3e+367lD7lgoNE1kP4QFF89TsofLsAJIO4hIlC1j87u/O7Un3RgY1ESIRJQZK9wvuR/CF/OwKUBIBDsoAIvO77f3z3gGBDtgRzQmO+zPw9e6U+OIGvhDlD+wE3vaw7pPxo/0mC4ERrgzO/xvzru5P9bYCVQ7FEIQI4PqQ8CHwz/liBzMQpw7IA472Z+/b8qr+RAujEGML6f4v863vlfZzAxAOqw9JB076A/FP8fb6xgeTD2sNugJa9i7wHfSZ/0cLuQ8hCh7+XPO18M73FgS0DYwOHwbY+Yzxf/IK/A4I4g4yDMIBQvYE8Vj1bgAwC8QO6whu/aLzxPH4+JwEQg1qDQgFfvko8q3zCf06CCAO/wriAET25/GK9isBAAvGDcMH2Pz/89fyEvoIBbsMSAwEBD/51fLX9PH9TAhQDdMJGgBg9tTysPfOAbgKwQypBl38cfTt8xn7WAUhDCcLFQMa+ZLz/PXC/kQIdAyxCGz/lPbJ88n4VwJZCrgLnwX9+/j0A/UN/I0FdgsKCjwCEfld9Br3e/8iCI4LmgfX/uD2xfTT+cYC5gmtCqgEuPuR9Rj27PyoBbwK8gh7ASD5NPUt+BoA6QegCpAGXP5B98X1zfoaA14JoQnEA437OvYp97X9qQX1CeIH0ABJ+RX2NvmiAJgHrAmVBfr9uPfH9rX7UwPFCJgI9AJ8+/P2NPho/pEFIgncBj8Aifn99jL6DwEyB7QIqgSz/UL4yfeK/HMDGwiSBzoChfu49zj5A/9hBUUI4QXH/9/56/ce+2MBuAa6B9EDhv3d+Mn4S/15A2MHkgaWAab7ifgx+ob/GgVhB/MEZ/9L+t34+/udASoGwAYLA3L9iPnF+fb9ZgOeBpoFCgHf+2L5IPvx/7wEeAYUBCH/y/rQ+cb8vgGMBckFWQJ4/UH6uvqK/joDzwWrBJYAMPxD+gH8QQBJBIwFRQP0/l37w/p+/cUB3gTVBLwBlv0H+6j7CP/3AvYEyQM6AJX8KfvT/HkAwwOeBIgC4f7/+7P7If6zASIE6QM2Ac391/uM/G3/nQIXBPMC+P8Q/RL8lf2YACsDsQPeAef+sfyf/K/+iAFbAwQDyAAb/q/8ZP27/y4CMwMtAs7/nf38/EX+nQCDAsYCSAEG/3H9hP0n/0YBiQIqAnEAf/6O/S7+7/+rAU0CdwG+/zz+5P3i/ooAywHhAcgAPf88/mD+h//tAK8BWwEyAPj+cf7q/gkAFQFmAdMAxv/s/sr+a/9dAAcBAgFeAIz/Ef8y/9D/fgDPAJsADACF/1f/lP8MAG0AgABDAOj/qv+r/97/GQA3AC0ACwDy/+3/+P8=';

// Brief on-screen notice + sound when a TimeLog screenshot is captured, so
// it's something the employee can actually notice happening in the moment
// rather than a silent background action. Visible ~5s total, separate from
// the toast system (top-of-screen, camera icon) so it doesn't get lost
// among ordinary error/success toasts.
function showScreenshotNotice(){
  var existing = document.getElementById('screenshotNotice');
  if(existing && existing.parentNode) existing.parentNode.removeChild(existing);
  var el = document.createElement('div');
  el.id = 'screenshotNotice';
  el.className = 'screenshot-notice';
  el.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2Z"/><circle cx="12" cy="13" r="4"/></svg><span>Screenshot captured</span>';
  document.body.appendChild(el);
  try{
    var audio = new Audio(SCREENSHOT_BEEP);
    audio.volume = 0.5;
    audio.play().catch(function(){});
  }catch(e){}
  setTimeout(function(){
    el.classList.add('leaving');
    setTimeout(function(){ if(el.parentNode) el.parentNode.removeChild(el); }, 300);
  }, 4700);
}
function errMsg(err){ return (err && err.message) ? err.message : 'Something went wrong - please try again.'; }

// ---------- app state ----------
var app = document.getElementById('app');
var myUid=null, myRole=null, myProfile=null, myTeamId=null;
// myRoles (round 8.7/schema_v10, 2026-09-24): the FULL set of roles the
// signed-in person holds - Manager/Admin included, since Humayun confirmed
// 2026-09-24 those can now be held alongside job-title roles rather than
// being a single separate access level. myRole above is kept in sync as
// myRoles[0] purely as a legacy fallback for any display spot that still
// reads it; every actual access check below reads myRoles instead.
var myRoles = [];
var activeUnsubs = [];
var profileUnsub = null;
var clientNavUnsub = null;
var teamsCache = {}; // id -> team row
var servicesCache = [];
function isAdmin(){ return myRoles.indexOf('admin')>-1; }
function isManager(){ return myRoles.indexOf('manager')>-1; }
function canManage(){ return isManager() || isAdmin(); }
function clearSubs(){ activeUnsubs.forEach(function(u){ try{u();}catch(e){} }); activeUnsubs=[]; }

// ---------- back-button history stack ----------
// A real stack of actually-visited hashes, not a fixed "parent page" lookup
// (which is what would've had to special-case every single page type, and
// still wouldn't get "go back to whatever I was on before" right for a
// multi-hop path like Connect -> Home -> a client -> back, back, back).
// route() below pushes onto this every time the hash genuinely changes to
// something new; goBack() pops it and navigates there directly, marking
// that one hashchange as "don't push" so going back doesn't also count as
// a new forward visit.
var navBackStack = [];
var navSkipPush = false;
var navCurrentHash = null;
function goBack(){
  if(!navBackStack.length) return;
  var prev = navBackStack.pop();
  navSkipPush = true;
  location.hash = prev;
}
function paint(html){
  var backHtml = navBackStack.length ? '<button type="button" class="page-back-btn" id="pageBackBtn" title="Back">'+ICON_BACK+'Back</button>' : '';
  app.innerHTML = backHtml + html;
  if(backHtml) document.getElementById('pageBackBtn').addEventListener('click', goBack);
  app.classList.remove('anim'); void app.offsetWidth; app.classList.add('anim');
}

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
function teamName(id){ return (teamsCache[id] && teamsCache[id].name) || '-'; }
// Every team <select> in the app used to list teams in creation order
// (teamsCache/listTeams() is ordered by createdAt) - alphabetical is what
// people actually expect once there's more than a couple of teams. This is
// the one place that builds team <option> lists now.
function sortedTeamList(){
  return Object.keys(teamsCache).map(function(id){ return teamsCache[id]; }).sort(function(a,b){ return (a.name||'').localeCompare(b.name||''); });
}
function teamOptionsHtml(selectedId, includeBlank){
  var opts = (includeBlank ? '<option value="">- no team -</option>' : '') +
    sortedTeamList().map(function(t){ return '<option value="'+t.id+'"'+(t.id===selectedId?' selected':'')+'>'+escapeHtml(t.name)+'</option>'; }).join('');
  return opts;
}
function servicesForMyScope(){
  return servicesCache.filter(function(s){ return s.scope==='global' || s.teamId===myTeamId || isAdmin(); });
}

function renderIdentityCard(){
  var box = document.getElementById('roleBox');
  if(!box) return;
  if(!myRoles.length){ box.innerHTML = '<div class="role-box-label">Loading your profile…</div>'; return; }
  var r = roleOf(myRoles[0]);
  // Multiple roles (round 8.7/schema_v10, 2026-09-24): lists every role
  // held, not just one - corrected 2026-09-23's plan already promised this
  // ("the identity card and My Board just list every role someone holds,
  // no single label to pick"), this is that promise actually built.
  var roleLabels = myRoles.map(function(k){ var rr=roleOf(k); return rr?rr.label:k; }).join(', ');
  var avatar = myProfile && myProfile.avatarUrl
    ? '<span class="avatar" style="width:30px;height:30px;font-size:12px;background-image:url(\''+escapeHtml(myProfile.avatarUrl)+'\')"></span>'
    : '<span class="avatar" style="width:30px;height:30px;font-size:12px;background:'+(r?r.color:'#888')+'">'+escapeHtml((myProfile&&myProfile.displayName?myProfile.displayName:'?').trim()[0]||'?')+'</span>';
  box.innerHTML =
    '<div style="display:flex;align-items:center;gap:9px;">'+avatar+
    '<div style="min-width:0;flex:1;"><div class="role-current-label" style="line-height:1.15;">'+escapeHtml((myProfile&&myProfile.displayName)||'')+'</div>'+
    '<div class="team-current-label"><span class="role-dot" style="background:'+(r?r.color:'#888')+';display:inline-block;margin-right:5px;"></span>'+escapeHtml(roleLabels)+(myTeamId?' · '+escapeHtml(teamName(myTeamId)):'')+'</div></div>'+
    // Used to be a bare 13px "✎" character with no border or background - a
    // real button, but nothing about it looked clickable, which is almost
    // certainly why "there's no way to change my profile picture or name"
    // kept coming up even after this was built. A visibly bordered icon
    // button reads as UI chrome instead of decoration.
    '<button type="button" id="editProfileBtn" class="identity-edit-btn" title="Edit your profile - name, photo, email, password">'+ICON_PENCIL+'</button></div>';
  var editBtn = document.getElementById('editProfileBtn');
  if(editBtn) editBtn.addEventListener('click', openEditProfileModal);
}

// Every logged-in account could see their own photo/name/role at the top of
// the sidebar, but there was no way to actually change any of it once
// signed up (aside from an Admin editing role/team, which is a different
// thing). This covers the rest: display name, photo, email, password.
var pendingProfileAvatarBlob = null;
function openEditProfileModal(){
  pendingProfileAvatarBlob = null;
  var currentAvatar = myProfile && myProfile.avatarUrl;
  openModal('Edit your profile',
    '<div class="field"><label>Profile photo</label><div class="avatar-drop" id="profileAvatarDrop">'+
      (currentAvatar ? '<img src="'+escapeHtml(currentAvatar)+'">' : '<div class="avatar-drop-hint">Click to choose a photo</div>')+
      '<input type="file" accept="image/*" id="profileAvatarInput" style="display:none;"></div></div>'+
    '<div class="field"><label>Your name</label><input name="displayName" type="text" value="'+escapeHtml((myProfile&&myProfile.displayName)||'')+'" required></div>'+
    '<div class="field"><label>Email</label><input name="email" type="email" value="'+escapeHtml((myProfile&&myProfile.email)||'')+'"><div class="field-hint">Changing this sends a confirmation link to your new address - the change only takes effect once you click it.</div></div>'+
    '<div class="field"><label>New password (leave blank to keep your current one)</label><input name="password" type="password" minlength="6" placeholder="••••••••"></div>',
    function(fd){
      var displayName = (fd.get('displayName')||'').trim();
      if(!displayName){ showModalError('Enter your name.'); return; }
      var newEmail = (fd.get('email')||'').trim();
      var newPassword = fd.get('password')||'';
      setModalBusy(true);
      var work = [];
      var avatarWork = pendingProfileAvatarBlob
        ? uploadFile(new File([pendingProfileAvatarBlob],'photo.jpg',{type:'image/jpeg'}), 'avatars/'+myUid+'/photo.jpg').then(function(){
            return db.doc('profiles/'+myUid).update({ avatarUrl: fileUrl('avatars/'+myUid+'/photo.jpg') });
          })
        : Promise.resolve();
      work.push(avatarWork);
      work.push(db.doc('profiles/'+myUid).update({ displayName: displayName }));
      if(newEmail && myProfile && newEmail !== myProfile.email) work.push(updateEmail(newEmail));
      if(newPassword) work.push(updatePassword(newPassword));
      Promise.all(work).then(function(){
        closeModal();
        showToast('success','Profile updated'+(newEmail && myProfile && newEmail!==myProfile.email ? ' - check your inbox to confirm the new email' : ''));
      }).catch(function(err){ showModalError(errMsg(err)); });
    }, 'Save changes');

  var drop = document.getElementById('profileAvatarDrop');
  var input = document.getElementById('profileAvatarInput');
  drop.addEventListener('click', function(){ input.click(); });
  input.addEventListener('change', function(){
    var file = input.files[0]; if(!file) return;
    drop.innerHTML = '<div class="avatar-drop-hint">Checking for a face…</div>';
    imageHasFace(file).then(function(ok){
      if(!ok){ drop.innerHTML = '<div class="avatar-drop-hint">No face detected - click to try another photo.</div>'; drop.appendChild(input); pendingProfileAvatarBlob=null; return; }
      return compressImage(file, {maxWidth:400,maxHeight:400,quality:.85}).then(function(blob){
        pendingProfileAvatarBlob = blob;
        var url = URL.createObjectURL(blob);
        drop.innerHTML = '<img src="'+url+'">';
        drop.appendChild(input);
      });
    }).catch(function(){ drop.innerHTML = '<div class="avatar-drop-hint">Could not check this photo - click to try another.</div>'; drop.appendChild(input); });
  });
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
  if(activeLightboxKeydown){ document.removeEventListener('keydown', activeLightboxKeydown); activeLightboxKeydown = null; }
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
// Set only while the image lightbox's own Ctrl+/Ctrl-/Ctrl0/Escape zoom
// listener is attached (see showImageLightbox) - cleared defensively here
// AND at the top of openModal, so that listener can never outlive
// #modalRoot's content changing out from under it (e.g. some other modal
// opening on top of, or instead of, an open lightbox) and keep hijacking
// zoom/Escape keystrokes for a lightbox that isn't showing anymore.
var activeLightboxKeydown = null;
function closeModal(){
  var root=document.getElementById('modalRoot'); root.classList.remove('open'); root.innerHTML='';
  if(activeLightboxKeydown){ document.removeEventListener('keydown', activeLightboxKeydown); activeLightboxKeydown = null; }
}
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
              dependsOnStepIds: stepDepIds(s), dueDate: iso, done:false, doneByUserId:null, doneAt:null,
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
  if(navCurrentHash!==null && navCurrentHash!==hash){
    if(navSkipPush) navSkipPush = false;
    else { navBackStack.push(navCurrentHash); if(navBackStack.length>50) navBackStack.shift(); }
  }
  navCurrentHash = hash;
  highlightNav(hash);
  var mClient = hash.match(/^\/client\/([^\/]+)$/);
  var mEpisode = hash.match(/^\/episode\/([^\/]+)$/);
  if(hash==='/') renderHome();
  else if(hash==='/board') renderBoard();
  else if(hash==='/timelog') renderTimeLog();
  else if(hash==='/connect') renderConnect();
  else if(hash==='/team') renderTeamSettings();
  else if(hash==='/admin') renderAdmin();
  else if(hash==='/workflows') renderWorkflows();
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

// ---------- APP-WIDE ZOOM (Ctrl/Cmd +/-/0) ----------
// Same hotkeys as any browser's own page zoom, applied here via the CSS
// `zoom` property (supported by the Chromium engine Tauri uses for its
// Windows webview - WebView2 - which is the only target this ships to
// today; see build.rs/windows-app-manifest.xml). Kept as a plain in-memory
// variable rather than something persisted to disk - it resets to 100% on
// each launch, which is the same "always starts predictable" choice as not
// remembering window position.
var APP_ZOOM_MIN = 0.6, APP_ZOOM_MAX = 2, APP_ZOOM_STEP = 0.1;
var appZoomLevel = 1;
function applyAppZoom(){ document.body.style.zoom = appZoomLevel; }
document.addEventListener('keydown', function(e){
  // The image lightbox (showImageLightbox) has its own Ctrl+/-/0 handling
  // for zooming just the enlarged image while it's open - don't also zoom
  // the whole app underneath it for the same keystroke.
  if(activeLightboxKeydown) return;
  if(!(e.ctrlKey||e.metaKey)) return;
  if(e.key==='='||e.key==='+'){ e.preventDefault(); appZoomLevel = Math.min(APP_ZOOM_MAX, appZoomLevel+APP_ZOOM_STEP); applyAppZoom(); }
  else if(e.key==='-'){ e.preventDefault(); appZoomLevel = Math.max(APP_ZOOM_MIN, appZoomLevel-APP_ZOOM_STEP); applyAppZoom(); }
  else if(e.key==='0'){ e.preventDefault(); appZoomLevel = 1; applyAppZoom(); }
});

// ---------- EXIT CONFIRMATION + CLOCK-OUT ON CLOSE ----------
// Added 2026-09-21: clicking the window's own close ("X") button used to
// just end the process outright - no confirmation, and (worse, while
// clocked in) no chance to ever run clockOut(), so the timeEntries row was
// left open until the 10-minute heartbeat-staleness sweep eventually closed
// it out on its own. This intercepts that close, confirms it, and - if
// clocked in - clocks out for real (server-write, not just the local UI)
// before actually letting the window close, exactly like the explicit
// "Sign out" button already does (see signOutBtn.onclick below).
//
// Round 8 (2026-09-22): switched the confirmation itself from the browser's
// own window.confirm() to the Tauri dialog plugin's confirm() (see the
// dialogMod import below). This is a well-documented Tauri/WebView2 gap:
// window.confirm() only reliably shows when it's called directly inside a
// synchronous DOM click handler with a live "user activation" flag - every
// OTHER confirm() in this file is wired that way (delete/archive buttons,
// etc.) and those were never reported broken. This one is different: it
// fires from appWindow.onCloseRequested(), which arrives asynchronously
// over Tauri's own IPC/event system after the OS "X" button is clicked, not
// as a direct click handler - by the time it runs, that activation flag is
// gone, so window.confirm() silently no-ops (observed as "it still doesn't
// confirm or give a warning" - it wasn't skipping the dialog on purpose, it
// was trying to show one that WebView2 wouldn't render). Tauri's own
// plugin-dialog confirm() goes through the Rust side instead, so it renders
// a real native dialog regardless of gesture context. That plugin is
// already a project dependency (see src/lib/r2.js's Save-As flow) and
// already registered in src-tauri/src/main.rs, so this needed no new Cargo
// dependency - only the "dialog:allow-message" permission added to
// src-tauri/capabilities/default.json (confirm()/ask() are both thin
// wrappers around the plugin's single "message" command).
(async function wireCloseConfirmation(){
  var appWindow, dialogConfirm;
  try {
    var mod = await import('@tauri-apps/api/window');
    appWindow = mod.getCurrentWindow();
    var dialogMod = await import('@tauri-apps/plugin-dialog');
    dialogConfirm = dialogMod.confirm;
  } catch (e) { return; } // not running inside the Tauri shell (e.g. `npm run dev` in a plain browser) - nothing to wire up
  appWindow.onCloseRequested(async function(event){
    event.preventDefault();
    var clockedIn = timelog.isClockedIn();
    var message = clockedIn
      ? 'You\'re currently clocked in - exiting will clock you out. Exit Blue Kite Ops?'
      : 'Exit Blue Kite Ops?';
    var ok = false;
    try { ok = await dialogConfirm(message, { title: 'Blue Kite Ops', kind: 'warning' }); } catch (e) { ok = confirm(message); } // fall back to window.confirm() if the plugin call itself throws, rather than silently exiting with no prompt at all
    if(!ok) return;
    if(clockedIn){
      // Race against a short timeout rather than awaiting the network write
      // unconditionally - someone who just confirmed "Exit" while offline
      // should still see the app actually close promptly; the heartbeat-
      // staleness sweep is exactly the existing safety net for a clock-out
      // that couldn't reach the server in time.
      try { await Promise.race([timelog.clockOut(), new Promise(function(r){ setTimeout(r, 5000); })]); } catch (e) {}
    }
    try { appWindow.destroy(); } catch (e) { console.error('[blue-kite-ops] could not close the window:', e); }
  });
})();

// ---------- SPOTLIGHT (Employee of the Month) ----------
function renderSpotlight(container){
  var monthKey = currentMonthKey();
  // Was a one-time .get() - meaning it only ever loaded when this page was
  // first opened. If Admin changed the spotlight while an employee already
  // had Home open, they'd never see it until they navigated away and back.
  // Switched to .onSnapshot() so it updates live like everything else.
  var unsub = db.doc('spotlights/'+monthKey).onSnapshot(function(snap){
    var s = snap.exists ? snap.data() : null;
    function wireEditBtn(){
      // This used to run right after the outer .get()/.onSnapshot()
      // callback fired, but for the "spotlight already set" branch below,
      // the actual innerHTML write happens one tick later inside
      // fetchProfiles().then(...) - so the button didn't exist in the DOM
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
    '<div class="page-sub">Every project Blue Kite produces for'+(myTeamId&&!isAdmin()?' - '+escapeHtml(teamName(myTeamId)):'')+'.</div></div></div>'+
    '<div class="section"><div class="section-head"><h2 class="section-title">Due soon</h2></div>'+
    '<div id="dueSoonStrip" class="strip"><div class="skeleton" style="height:44px;"></div></div></div>'+
    '<div class="section"><div class="section-head"><h2 class="section-title">Clients</h2>'+
    (canManage()?'<label style="font-size:12px;color:var(--muted);display:flex;align-items:center;gap:6px;cursor:pointer;"><input type="checkbox" id="showArchivedClientsToggle"> Show archived</label>':'')+
    '</div>'+
    '<div id="clientGrid" class="card-grid"><div class="skeleton" style="height:150px;"></div></div></div>'
  );
  renderSpotlight(document.getElementById('spotlightBox'));

  var today = todayISO();
  // Archived episodes shouldn't show up as "due soon" - they're meant to
  // be out of the way, not still nudging someone toward them.
  var unsub1 = db.collection('episodes').where('dueDate','>=',today).orderBy('dueDate','asc').limit(20).onSnapshot(function(snap){
    var strip = document.getElementById('dueSoonStrip');
    if(!strip) return;
    var docs = snap.docs.filter(function(d){ return !d.data().archived; }).slice(0,6);
    if(!docs.length){ strip.innerHTML = '<div class="empty-state">Nothing due yet - generate episodes from a client\'s schedule.</div>'; return; }
    strip.innerHTML = docs.map(function(d){
      var e = d.data();
      var status = dueStatus(e.dueDate,false);
      return '<a class="strip-item" href="#/episode/'+d.id+'">'+
        '<span class="strip-dot" style="background:var(--blue)"></span>'+
        '<div class="strip-main"><div class="strip-title">'+escapeHtml(e.clientName)+' - '+escapeHtml(e.title)+'</div>'+
        '<div class="strip-sub">'+fmtDate(e.dueDate)+(e.paid?' · Paid $'+e.amount:'')+'</div></div>'+
        '<span class="badge badge-'+status+'">'+statusLabel(status)+'</span></a>';
    }).join('');
  }, function(){ var s=document.getElementById('dueSoonStrip'); if(s) s.innerHTML='<div class="empty-state">Could not load.</div>'; });
  activeUnsubs.push(unsub1);

  // Archived clients are kept out of the main grid by default - kept as a
  // client-side filter (not a query filter) so toggling "Show archived"
  // doesn't need a second subscription, just a re-render of the same data.
  var lastClientSnap = null;
  var showArchivedClients = false;
  function renderClientGrid(){
    var grid = document.getElementById('clientGrid');
    if(!grid || !lastClientSnap) return;
    var docs = lastClientSnap.docs.filter(function(d){ return showArchivedClients || !d.data().archived; });
    var cards = docs.map(function(d,i){
      var c = d.data();
      var color = c.color || CLIENT_COLORS[i%CLIENT_COLORS.length];
      return '<a class="client-card" href="#/client/'+d.id+'">'+
        '<div class="client-card-rail'+(c.imageUrl?'':' no-image')+'" style="'+(c.imageUrl?'background-image:url(\''+escapeHtml(c.imageUrl)+'\')':'background:linear-gradient(135deg,'+color+',var(--line-soft))')+'"></div>'+
        '<div class="client-card-body">'+
        '<div class="client-card-name">'+escapeHtml(c.name)+'</div>'+
        '<div class="client-card-host">Hosted by '+escapeHtml(c.hostName||'-')+'</div>'+
        '<div class="client-card-tagline">'+escapeHtml(c.tagline||'')+'</div>'+
        '<div class="client-card-foot"><span>'+(c.services?c.services.length:0)+' services</span>'+(isAdmin()?'<span class="badge badge-team">'+escapeHtml(teamName(c.teamId))+'</span>':'')+(c.archived?'<span class="badge" style="background:var(--line-soft);">Archived</span>':'')+(c.example?'<span class="badge badge-upcoming">Example</span>':'<span>View board →</span>')+'</div>'+
        '</div></a>';
    }).join('');
    if(canManage()) cards += '<button type="button" class="add-client-card" id="addClientCard">+ Add a client</button>';
    grid.innerHTML = cards || '<div class="empty-state">No clients'+(showArchivedClients?' in your team yet':' - toggle "Show archived" above if you\'re looking for one you archived')+'.</div>';
    var btn = document.getElementById('addClientCard');
    if(btn) btn.addEventListener('click', openAddClientModal);
  }
  var unsub2 = db.collection('clients').orderBy('createdAt','asc').onSnapshot(function(snap){
    lastClientSnap = snap;
    renderClientGrid();
  }, function(){});
  activeUnsubs.push(unsub2);
  var archToggle = document.getElementById('showArchivedClientsToggle');
  if(archToggle) archToggle.addEventListener('change', function(){ showArchivedClients = archToggle.checked; renderClientGrid(); });
}

function openAddClientModal(){
  var teamFieldHtml = isAdmin()
    ? '<div class="field"><label>Team</label><select name="teamId" required>'+teamOptionsHtml()+'</select></div>'
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
    if(!snap.exists){ paint('<div class="empty-state"><strong>Client not found</strong>It may have been removed.</div>'); return; }
    var c = snap.data();
    var mgr = canManage();
    paint(
      '<div class="page-head"><div><div class="eyebrow">Client</div><h1 class="page-title">'+escapeHtml(c.name)+(c.archived?' <span class="badge" style="background:var(--line-soft);vertical-align:middle;">Archived</span>':'')+'</h1>'+
      '<div class="page-sub">Hosted by '+escapeHtml(c.hostName||'-')+' · <span id="clientTeamRow">Team: <b>'+escapeHtml(teamName(c.teamId))+'</b>'+(isAdmin()?' <button type="button" class="btn btn-sm" id="editTeamBtn" style="width:auto;padding:1px 8px;font-size:11px;vertical-align:middle;">Change</button>':'')+'</span></div></div>'+
      '<div style="display:flex;align-items:flex-start;gap:8px;flex-wrap:wrap;">'+
      (mgr?'<button type="button" class="btn btn-sm" id="archiveClientBtn">'+(c.archived?'Unarchive':'Archive')+'</button><button type="button" class="btn btn-sm btn-danger" id="deleteClientBtn">Delete permanently</button>':'')+
      (mgr?'<button type="button" class="btn btn-primary btn-sm" id="genEpisodesBtn">Generate upcoming episodes</button>':'')+
      '</div>'+
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
      '<div style="display:flex;align-items:center;gap:10px;">'+
      (mgr?'<label style="font-size:12px;color:var(--muted);display:flex;align-items:center;gap:6px;cursor:pointer;"><input type="checkbox" id="showArchivedEpisodesToggle"> Show archived</label>':'')+
      (mgr?'<button type="button" class="btn btn-sm" id="addEpisodeBtn">+ One-off episode</button>':'')+
      '</div>'+
      '</div>'+
      '<div id="episodeList" class="episode-list"><div class="skeleton" style="height:50px;"></div></div></div>'+
      (mgr?'<div class="section"><div class="section-head"><h2 class="section-title">Workflow templates</h2><button type="button" class="btn btn-sm" id="addTemplateBtn">+ New template</button></div><div id="templateBox"></div></div>':'')
    );

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
        showToast('success', made ? ('Generated '+made+' new episode'+(made===1?'':'s')) : 'Already up to date - nothing new to generate.');
      }).catch(function(err){ genBtn.disabled=false; genBtn.textContent='Generate upcoming episodes'; showToast('error', errMsg(err)); });
    });

    var archiveClientBtn = document.getElementById('archiveClientBtn');
    if(archiveClientBtn) archiveClientBtn.addEventListener('click', function(){
      var next = !c.archived;
      if(!confirm(next ? 'Archive '+c.name+'? It will be hidden from the main client list but all its episodes, tasks, comments and attachments are kept - you can unarchive it later.' : 'Unarchive '+c.name+'?')) return;
      db.doc('clients/'+clientId).update({archived: next}).then(function(){ showToast('success', next?'Client archived':'Client unarchived'); }).catch(function(err){ showToast('error', errMsg(err)); });
    });
    var deleteClientBtn = document.getElementById('deleteClientBtn');
    if(deleteClientBtn) deleteClientBtn.addEventListener('click', function(){
      // A permanent delete cascades away every episode, task, template,
      // schedule rule, comment and attachment tied to this client (the
      // database's own foreign keys already do this cleanly - see
      // schema.sql) - real, irreversible history loss, so this asks for
      // the client's exact name typed back rather than just a yes/no
      // confirm, the same weight as any other "type to confirm" delete.
      var typed = prompt('This permanently deletes "'+c.name+'" and ALL of its episodes, tasks, comments and attachments. This cannot be undone.\n\nType the client\'s name to confirm:');
      if(typed===null) return;
      if(typed.trim()!==c.name){ showToast('error','Name didn\'t match - nothing was deleted.'); return; }
      db.doc('clients/'+clientId).delete().then(function(){
        showToast('success', c.name+' deleted');
        location.hash = '#/';
      }).catch(function(err){ showToast('error', errMsg(err)); });
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

    // Reassigning a client to a different team - Admin-only per the
    // permissions matrix (a Manager can't move a client out of their own
    // team). This is the "editable afterward" piece for clients that came
    // in without a team (see schema_v3.sql's Team A backfill).
    var editTeamBtn = document.getElementById('editTeamBtn');
    if(editTeamBtn) editTeamBtn.addEventListener('click', function(){
      var row = document.getElementById('clientTeamRow');
      var teamOpts = teamOptionsHtml(c.teamId);
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

    var lastEpSnap = null;
    var showArchivedEpisodes = false;
    function renderEpisodeList(){
      var list = document.getElementById('episodeList');
      if(!list || !lastEpSnap) return;
      var docs = lastEpSnap.docs.filter(function(d){ return showArchivedEpisodes || !d.data().archived; });
      if(!docs.length){ list.innerHTML = '<div class="empty-state"><strong>No episodes yet</strong>'+(mgr?'Add a schedule rule, then generate episodes.':'Ask a manager to set up this client\'s schedule.')+'</div>'; return; }
      list.innerHTML = docs.map(function(d){
        var e = d.data();
        var status = dueStatus(e.dueDate,false);
        return '<a class="episode-row" href="#/episode/'+d.id+'">'+
          '<span class="episode-date mono">'+fmtDate(e.dueDate)+'</span>'+
          '<div class="episode-main"><div class="episode-title">'+escapeHtml(e.title)+(e.archived?' <span class="badge" style="background:var(--line-soft);">Archived</span>':'')+'</div>'+
          '<div class="episode-sub">'+(e.taskCount||0)+' tasks'+(e.paid?' · Paid $'+e.amount:'')+'</div></div>'+
          '<span class="badge badge-'+status+'">'+statusLabel(status)+'</span></a>';
      }).join('');
    }
    var unsubEp = db.collection('episodes').where('clientId','==',clientId).orderBy('dueDate','asc').limit(30).onSnapshot(function(es){
      lastEpSnap = es;
      renderEpisodeList();
    }, function(){});
    activeUnsubs.push(unsubEp);
    var epArchToggle = document.getElementById('showArchivedEpisodesToggle');
    if(epArchToggle) epArchToggle.addEventListener('change', function(){ showArchivedEpisodes = epArchToggle.checked; renderEpisodeList(); });

    if(mgr){
      var tplBox = document.getElementById('templateBox');
      if(tplBox) activeUnsubs.push(mountTemplatesBox(clientId, tplBox));
    }
  }, function(){ paint('<div class="empty-state">Could not load this client.</div>'); });
  activeUnsubs.push(unsub);
}

// Renders a client's workflow templates + steps into `box`, and keeps it
// live. Shared by the Client Detail page's own "Workflow templates" section
// and the centralized Workflows nav page (renderWorkflows) below - added
// 2026-09-21 so admin/manager have ONE place to define step-to-step
// dependencies instead of typing a free-text "waiting on" label onto every
// generated task by hand (see openSetStepDependencyModal).
function mountTemplatesBox(clientId, box){
  var unsub = db.collection('templates').where('clientId','==',clientId).onSnapshot(function(ts){
    if(ts.empty){ box.innerHTML = '<div class="empty-state"><strong>No templates yet</strong>Templates define the checklist each episode type generates, and the "waits for" links between their steps.</div>'; return; }
    var stepById = {};
    ts.docs.forEach(function(d){ (d.data().steps||[]).forEach(function(s){ stepById[s.stepId] = s; }); });
    box.innerHTML = ts.docs.map(function(d){
      var t = d.data();
      var steps = (t.steps||[]).slice().sort(function(a,b){return (a.order||0)-(b.order||0);});
      return '<div class="panel" style="margin-bottom:12px;" data-tpl-panel="'+d.id+'"><h3>'+escapeHtml(t.name)+'</h3>'+
        '<div class="step-list" data-tpl-steps="'+d.id+'">'+steps.map(function(s,i){
          var r = roleOf(s.role);
          var deps = stepDepIds(s).map(function(id){ return stepById[id]; }).filter(Boolean);
          return '<div class="step-edit-row" draggable="true" data-tpl="'+d.id+'" data-step="'+escapeHtml(s.stepId)+'" data-idx="'+i+'">'+
            '<span class="step-drag-handle" title="Drag to reorder">⋮⋮</span>'+
            '<span class="role-chip" style="background:'+(r?r.color:'#888')+'">'+(r?escapeHtml(r.label):s.role)+'</span>'+
            '<span style="flex:1;">'+escapeHtml(s.label)+(deps.length?' <span class="task-waiting">⛔ waits for: '+deps.map(function(dd){return escapeHtml(dd.label);}).join(', ')+'</span>':'')+'</span>'+
            '<button type="button" class="step-edit-remove" data-set-dep data-tpl="'+d.id+'" data-step="'+escapeHtml(s.stepId)+'" title="Choose which steps this waits on">'+(deps.length?'Change dependencies':'+ Depends on')+'</button>'+
            '<button type="button" class="step-edit-remove" data-remove-step data-tpl="'+d.id+'" data-step="'+escapeHtml(s.stepId)+'">remove</button></div>';
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
    Array.prototype.forEach.call(box.querySelectorAll('[data-set-dep]'), function(btn){
      btn.addEventListener('click', function(){ openSetStepDependencyModal(btn.getAttribute('data-tpl'), btn.getAttribute('data-step')); });
    });
    Array.prototype.forEach.call(box.querySelectorAll('[data-remove-step]'), function(btn){
      btn.addEventListener('click', function(){
        var tplId = btn.getAttribute('data-tpl'), stepId = btn.getAttribute('data-step');
        db.doc('templates/'+tplId).get().then(function(snap2){
          var t2 = snap2.data();
          var steps2 = (t2.steps||[]).filter(function(s){ return s.stepId!==stepId; });
          // A step that depended on the one being removed would otherwise
          // stay permanently blocked on a dependency that no longer exists -
          // drop just that one id from its list instead of leaving a
          // dangling reference (the old single-value field is cleared too,
          // for a step that was never edited since the multi-dependency
          // change and still only has that field).
          steps2.forEach(function(s){
            if(s.dependsOnStepId===stepId) s.dependsOnStepId=null;
            if(s.dependsOnStepIds && s.dependsOnStepIds.indexOf(stepId)>-1){
              s.dependsOnStepIds = s.dependsOnStepIds.filter(function(id){ return id!==stepId; });
            }
          });
          return db.doc('templates/'+tplId).update({steps:steps2});
        }).catch(function(err){ showToast('error', errMsg(err)); });
      });
    });
  }, function(){});
  return unsub;
}

// "Depends on" is set ONCE per template step (not per generated task/
// episode) - every task generated from this step, for every future
// episode, inherits the block automatically. See renderEpisode's task
// checklist for where this is enforced (checkbox disabled + "Waiting on:"
// shown, computed live from the sibling task's done state - never a
// hand-typed label that can drift out of sync).
function openSetStepDependencyModal(tplId, stepId){
  db.doc('templates/'+tplId).get().then(function(snap){
    var t = snap.data();
    var steps = (t.steps||[]).slice().sort(function(a,b){return (a.order||0)-(b.order||0);});
    var self = steps.filter(function(s){ return s.stepId===stepId; })[0];
    if(!self){ showToast('error','That step no longer exists - try refreshing.'); return; }
    var selfDeps = stepDepIds(self);
    var choices = steps.filter(function(s){ return s.stepId!==stepId; });
    var checksHtml = choices.length ? choices.map(function(s){
      return '<div class="check-row"><input type="checkbox" name="dependsOnStepIds" value="'+escapeHtml(s.stepId)+'" id="dep_'+escapeHtml(s.stepId)+'" '+(selfDeps.indexOf(s.stepId)>-1?'checked':'')+'><label for="dep_'+escapeHtml(s.stepId)+'">'+escapeHtml(s.label)+'</label></div>';
    }).join('') : '<div class="field-hint">No other steps on this template yet.</div>';
    openModal('Set dependencies for "'+escapeHtml(self.label)+'"',
      '<div class="field"><label>This step can\'t be checked off until ALL of these are done:</label>'+checksHtml+'</div>'+
      '<div class="field-hint">Applies to every future episode generated from this template. Episodes already generated keep whatever was set when they were created.</div>',
      function(fd){
        setModalBusy(true);
        var chosen = fd.getAll('dependsOnStepIds');
        // Guard against a dependency loop (A waits on B which, directly or
        // through others, waits back on A) - that would leave every task
        // in the cycle permanently unable to check off, with no way out
        // except editing the template again. Now that a step can depend on
        // several others at once, this is a real graph search (does any
        // path out of any chosen step lead back to this one), not just a
        // single chain to walk.
        var stepById2 = {}; steps.forEach(function(s){ stepById2[s.stepId]=s; });
        function leadsBackToSelf(fromId, seen){
          if(fromId===stepId) return true;
          if(seen[fromId]) return false;
          seen[fromId] = true;
          var s = stepById2[fromId];
          if(!s) return false;
          return stepDepIds(s).some(function(id){ return leadsBackToSelf(id, seen); });
        }
        var loop = chosen.some(function(id){ return leadsBackToSelf(id, {}); });
        if(loop){ showModalError('That would create a loop - one of these steps (directly or through others) already waits on this one. Choose different steps.'); return; }
        var updated = steps.map(function(s){ return s.stepId===stepId ? Object.assign({}, s, { dependsOnStepIds: chosen, dependsOnStepId: null }) : s; });
        db.doc('templates/'+tplId).update({steps:updated}).then(function(){
          closeModal(); showToast('success', chosen.length ? 'Dependencies set' : 'Dependencies cleared');
        }).catch(function(err){ showModalError(errMsg(err)); });
      }, 'Save');
  }).catch(function(err){ showToast('error', errMsg(err)); });
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
  if(!available.length){ showToast('error','No more services in the vocabulary to add - create a new service type first.'); return; }
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
  // Manager) doesn't make sense for them - they need to actually pick which
  // Team a team-scoped service belongs to. The picker itself already
  // existed and worked; this was purely a confusing-label + always-visible
  // issue, now fixed to only show when it's actually relevant.
  var scopeOptions = isAdmin()
    ? '<option value="team">A specific Team</option><option value="global">Every Team (global)</option>'
    : '<option value="team">Just my Team</option>';
  var teamPickerHtml = isAdmin()
    ? '<div class="field" id="teamPickerField"><label>Team</label><select name="teamId">'+teamOptionsHtml()+'</select></div>'
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

// ---------- WORKFLOWS (centralized template + dependency builder) ----------
// Added 2026-09-21: the per-client "Workflow templates" section on the
// Client Detail page (still there, unchanged, for convenience while
// looking at one client) was easy to lose track of - it's what Humayun
// meant by "the workflow builder is gone", even though the code was never
// actually removed. This page puts every client's templates in one place,
// reachable from its own nav item, which is also where admin/manager now
// define step dependencies (see openSetStepDependencyModal) instead of
// typing a "waiting on:" label onto every generated task by hand.
var workflowsSelectedClientId = null;
function renderWorkflows(){
  if(!canManage()){ paint('<div class="empty-state"><strong>Not available</strong>Only managers and admins can define workflow templates.</div>'); return; }
  paint(
    '<div class="page-head"><div><div class="eyebrow">Workflows</div><h1 class="page-title">Templates &amp; dependencies</h1>'+
    '<div class="page-sub">Build each client\'s checklist once, and link steps together so, say, editing can\'t start until booking is done - every episode generated from a template inherits it automatically.</div></div></div>'+
    '<div class="workflows-layout"><div class="workflows-client-list" id="workflowsClientList"><div class="skeleton" style="height:32px;margin-bottom:6px;"></div></div>'+
    '<div class="workflows-panel" id="workflowsPanel"><div class="empty-state">Pick a client on the left.</div></div></div>'
  );
  var unsub = db.collection('clients').orderBy('name','asc').onSnapshot(function(snap){
    var list = document.getElementById('workflowsClientList');
    if(!list) return;
    if(snap.empty){ list.innerHTML = '<div class="empty-state" style="padding:12px;">No clients yet.</div>'; return; }
    var clients = snap.docs.map(function(d){ var c=d.data(); c._id=d.id; return c; });
    if(!workflowsSelectedClientId || !clients.some(function(c){ return c._id===workflowsSelectedClientId; })){
      workflowsSelectedClientId = clients[0]._id;
    }
    list.innerHTML = clients.map(function(c){
      return '<button type="button" class="workflows-client-item'+(c._id===workflowsSelectedClientId?' active':'')+'" data-wf-client="'+c._id+'">'+escapeHtml(c.name)+
        (isAdmin()?'<span class="workflows-client-team">'+escapeHtml(teamName(c.teamId))+'</span>':'')+'</button>';
    }).join('');
    Array.prototype.forEach.call(list.querySelectorAll('[data-wf-client]'), function(btn){
      btn.addEventListener('click', function(){
        workflowsSelectedClientId = btn.getAttribute('data-wf-client');
        Array.prototype.forEach.call(list.querySelectorAll('[data-wf-client]'), function(b){ b.classList.toggle('active', b===btn); });
        mountWorkflowsPanel(clients.filter(function(c){ return c._id===workflowsSelectedClientId; })[0]);
      });
    });
    mountWorkflowsPanel(clients.filter(function(c){ return c._id===workflowsSelectedClientId; })[0]);
  }, function(){ var l=document.getElementById('workflowsClientList'); if(l) l.innerHTML='<div class="empty-state">Could not load clients.</div>'; });
  activeUnsubs.push(unsub);
}
var workflowsPanelUnsub = null;
function mountWorkflowsPanel(client){
  if(workflowsPanelUnsub){ try{ workflowsPanelUnsub(); }catch(e){} workflowsPanelUnsub = null; }
  var panel = document.getElementById('workflowsPanel');
  if(!panel || !client) return;
  panel.innerHTML = '<div class="section-head" style="margin-bottom:10px;"><h2 class="section-title">'+escapeHtml(client.name)+'</h2>'+
    '<button type="button" class="btn btn-sm" id="wfAddTemplateBtn">+ New template</button></div>'+
    '<div id="wfTemplateBox"></div>';
  document.getElementById('wfAddTemplateBtn').addEventListener('click', function(){ openAddTemplateModal(client._id); });
  workflowsPanelUnsub = mountTemplatesBox(client._id, document.getElementById('wfTemplateBox'));
  activeUnsubs.push(workflowsPanelUnsub);
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
  db.doc('templates/'+templateId).get().then(function(snap){
    var t = snap.data();
    var existingSteps = (t.steps||[]).slice().sort(function(a,b){return (a.order||0)-(b.order||0);});
    var checksHtml = existingSteps.length ? existingSteps.map(function(s){
      return '<div class="check-row"><input type="checkbox" name="dependsOnStepIds" value="'+escapeHtml(s.stepId)+'" id="newdep_'+escapeHtml(s.stepId)+'"><label for="newdep_'+escapeHtml(s.stepId)+'">'+escapeHtml(s.label)+'</label></div>';
    }).join('') : '<div class="field-hint">No other steps yet.</div>';
    openModal('Add workflow step', '<div class="field"><label>Step description</label><input required name="label" type="text" placeholder="e.g. Edit trailer"></div>'+
      '<div class="field-row"><div class="field"><label>Role</label><select name="role">'+ROLES.filter(function(r){return r.key!=='manager'&&r.key!=='admin';}).map(function(r){return '<option value="'+r.key+'">'+escapeHtml(r.label)+'</option>';}).join('')+'</select></div>'+
      '<div class="field"><label>Group</label><input name="group" type="text" placeholder="e.g. Editing"></div></div>'+
      '<div class="field"><label>Depends on (optional, pick any number)</label>'+checksHtml+'</div>'+
      '<div class="field-hint">Every task generated from this step - in every future episode - is locked until ALL chosen steps are checked off. You can change this later from the step\'s "Change dependencies" button.</div>',
      function(fd){
        var label = (fd.get('label')||'').trim();
        if(!label){ showModalError('Describe the step.'); return; }
        setModalBusy(true);
        var dependsOnStepIds = fd.getAll('dependsOnStepIds');
        var newStep = {stepId:'s'+uid8(), order:0, role:fd.get('role'), group:(fd.get('group')||'').trim(), label:label, dependsOnStepIds: dependsOnStepIds};
        db.doc('templates/'+templateId).get().then(function(freshSnap){
          var ft = freshSnap.data();
          var freshSteps = (ft.steps||[]).slice();
          var maxOrder = freshSteps.reduce(function(m,s){return Math.max(m,s.order||0);},0);
          newStep.order = maxOrder+1;
          freshSteps.push(newStep);
          return db.doc('templates/'+templateId).update({steps:freshSteps});
        }).then(function(){
          // Backfill onto episodes already on the board. Before this, a
          // brand-new step only ever affected FUTURE episodes
          // (generateEpisodesForRule below) - an episode already
          // generated never got a task for it at all, on either its own
          // checklist or the workboard, because nothing ever wrote a new
          // `tasks` row for it (unlike a dependency edit on an EXISTING
          // step, which liveDepStepIds above already looks up live).
          // Mirror generateEpisodesForRule's own task shape here for
          // every still-open (non-archived) episode already generated
          // from this template, so the new step shows up everywhere
          // immediately instead of only on episodes generated from now on.
          return db.collection('episodes').where('templateId','==',templateId).get();
        }).then(function(epSnap){
          // Filtered client-side (not archived != true in the query) to
          // match how archived-filtering is done everywhere else in this
          // file, rather than relying on Postgres's not-null-safe `!=`.
          var openDocs = epSnap.docs.filter(function(d){ return !d.data().archived; });
          return Promise.all(openDocs.map(function(epDoc){
            var e = epDoc.data();
            var taskId = epDoc.id+'_'+newStep.stepId;
            return db.doc('tasks/'+taskId).set({
              episodeId: epDoc.id, episodeTitle: e.title, clientId: e.clientId, clientName: e.clientName,
              role: newStep.role, label: newStep.label, group: newStep.group||'', orderNum: newStep.order||0,
              dependsOnStepIds: newStep.dependsOnStepIds||[], dueDate: e.dueDate, done:false, doneByUserId:null, doneAt:null,
              createdAt: new Date().toISOString()
            }).then(function(){
              return db.doc('episodes/'+epDoc.id).update({ taskCount: (e.taskCount||0) + 1 });
            });
          }));
        }).then(function(){
          closeModal(); showToast('success', 'Added step');
        }).catch(function(err){ showModalError(errMsg(err)); });
      }, 'Add step');
  }).catch(function(err){ showToast('error', errMsg(err)); });
}

// ---------- EPISODE DETAIL ----------
var expandedTasks = {};
function renderEpisode(episodeId){
  paint('<div class="skeleton" style="height:100px;margin-bottom:20px;"></div><div class="skeleton" style="height:300px;"></div>');
  var unsub = db.doc('episodes/'+episodeId).onSnapshot(function(snap){
    if(!snap.exists){ paint('<div class="empty-state"><strong>Episode not found</strong></div>'); return; }
    var e = snap.data();
    paint(
      '<div class="page-head"><div><div class="eyebrow"><a href="#/client/'+e.clientId+'" style="color:var(--muted);text-decoration:none;">'+escapeHtml(e.clientName)+'</a></div>'+
      '<h1 class="page-title">'+escapeHtml(e.title)+(e.archived?' <span class="badge" style="background:var(--line-soft);vertical-align:middle;">Archived</span>':'')+'</h1>'+
      '<div class="page-sub">'+fmtDateFull(e.dueDate)+(e.paid?' · Paid appearance ($'+e.amount+')':'')+'</div></div>'+
      '<div style="display:flex;align-items:flex-start;gap:8px;">'+
      (canManage()?'<button type="button" class="btn btn-sm" id="archiveEpisodeBtn">'+(e.archived?'Unarchive':'Archive')+'</button><button type="button" class="btn btn-sm btn-danger" id="deleteEpisodeBtn">Delete</button>':'')+
      '<div id="epStatusBadge"></div></div></div>'+
      '<div class="progress-bar"><div class="progress-fill" id="epProgressFill" style="width:0%"></div></div>'+
      (canManage()?'<div style="margin-top:14px;"><button type="button" class="btn btn-sm" id="addCustomTaskBtn">+ Add custom task</button></div>':'')+
      '<div id="taskGroups" style="margin-top:22px;"><div class="skeleton" style="height:200px;"></div></div>'+
      '<div class="section"><div class="section-head"><h2 class="section-title">Discussion</h2></div>'+
      '<div class="page-sub" style="margin:-6px 0 12px;">General chat about this episode as a whole - for a specific subtask, use "Comments, links & files" on that task instead.</div>'+
      '<div id="epCollab"></div></div>'
    );

    var addCustomBtn = document.getElementById('addCustomTaskBtn');
    if(addCustomBtn) addCustomBtn.addEventListener('click', function(){ openAddCustomTaskModal(episodeId, e); });
    var archiveEpBtn = document.getElementById('archiveEpisodeBtn');
    if(archiveEpBtn) archiveEpBtn.addEventListener('click', function(){
      var next = !e.archived;
      if(!confirm(next ? 'Archive "'+e.title+'"? It will be hidden from the client\'s episode list but all its tasks and discussion are kept - you can unarchive it later.' : 'Unarchive "'+e.title+'"?')) return;
      db.doc('episodes/'+episodeId).update({archived: next}).then(function(){ showToast('success', next?'Episode archived':'Episode unarchived'); }).catch(function(err){ showToast('error', errMsg(err)); });
    });
    var deleteEpBtn = document.getElementById('deleteEpisodeBtn');
    if(deleteEpBtn) deleteEpBtn.addEventListener('click', function(){
      if(!confirm('Permanently delete "'+e.title+'" and all of its tasks, comments and attachments? This cannot be undone.')) return;
      db.doc('episodes/'+episodeId).delete().then(function(){
        showToast('success', 'Episode deleted');
        location.hash = '#/client/'+e.clientId;
      }).catch(function(err){ showToast('error', errMsg(err)); });
    });
    loadCollab('episode', episodeId, document.getElementById('epCollab'));

    // Fetch this episode's template once (recurring episodes only - a
    // one-off has no templateId) so the checklist below can look up each
    // task's dependency LIVE off the current template step, rather than the
    // fixed copy baked into the task at generation time - see
    // liveDepStepIds() for why. A plain .get(), not a live subscription:
    // editing a dependency while this exact page is already open just needs
    // a reload to pick up, same as any other template edit.
    var tplStepByIdPromise = e.templateId
      ? db.doc('templates/'+e.templateId).get().then(function(tplSnap){
          var stepById = {};
          ((tplSnap.exists && tplSnap.data().steps) || []).forEach(function(s){ stepById[s.stepId] = s; });
          return stepById;
        }).catch(function(){ return {}; }) // fails open - a template fetch error shouldn't block the checklist from rendering, just means dependencies fall back to each task's own baked-in copy
      : Promise.resolve({});

    tplStepByIdPromise.then(function(liveStepById){
    var unsubTasks = db.collection('tasks').where('episodeId','==',episodeId).orderBy('orderNum','asc').onSnapshot(function(ts){
      var box = document.getElementById('taskGroups');
      if(!box) return;
      if(ts.empty){ box.innerHTML = '<div class="empty-state">No tasks on this episode.</div>'; return; }
      var groups = {}; var order = [];
      var completed = [];
      var doneCount = 0;
      var taskById = {};
      // Build the full lookup table first, in one pass over every sibling
      // task (this query isn't filtered by done, unlike the Board's) - a
      // dependency lookup below needs every task, done or not, already
      // available regardless of grouping.
      ts.docs.forEach(function(d){
        var t = d.data(); t._id = d.id;
        taskById[t._id] = t;
        if(t.done) doneCount++;
      });
      // Live step order (Phase 2.5 batch A): a task's position used to be
      // permanently baked into its own orderNum at the moment it was
      // created, exactly the trap dependencies were in before round 8.5 -
      // dragging steps into a new order on the Workflows page updated the
      // TEMPLATE, but every already-generated episode kept showing its
      // tasks in the old order forever. Since a task's id is always
      // "<episodeId>_<stepId>" (custom tasks are the one exception, id
      // "<episodeId>_custom_<xxxx>", which simply won't match any live
      // step and falls back to its own orderNum below - custom tasks were
      // never part of a template's order anyway), the live step is just a
      // lookup away, same liveStepById already fetched for dependencies.
      function liveOrderNum(t){
        var stepId = t._id.indexOf(episodeId+'_')===0 ? t._id.slice(episodeId.length+1) : null;
        var liveStep = stepId ? liveStepById[stepId] : null;
        return liveStep ? (liveStep.order||0) : (t.orderNum||0);
      }
      var liveOrderedDocs = ts.docs.slice().sort(function(a,b){ return liveOrderNum(taskById[a.id]) - liveOrderNum(taskById[b.id]); });
      // Second pass: sort each task into its open group, or - added
      // 2026-09-22 - into a separate "Completed" bucket instead, so a
      // finished task moves out of the working checklist rather than
      // staying interleaved (still checked, just no longer where you're
      // looking for what's left to do).
      liveOrderedDocs.forEach(function(d){
        var t = taskById[d.id];
        if(t.done){ completed.push(t); return; }
        var g = t.group||'Tasks';
        if(!groups[g]){ groups[g]=[]; order.push(g); }
        groups[g].push(t);
      });
      // Dependencies are defined on the template step (dependsOnStepIds -
      // see openSetStepDependencyModal) and inherited by every task
      // generated from it, instead of a free-text label typed onto each
      // task by hand. A step (and so a task) can wait on more than one
      // other step since 2026-09-22 - depTasksFor returns every
      // prerequisite task doc it can find (a missing one, e.g. its step
      // was removed from the template after this episode was generated,
      // is just skipped - fails OPEN rather than leaving the task
      // permanently locked on something that no longer exists). Reads the
      // dependency LIVE off the current template (liveStepById, fetched
      // above) rather than each task's own baked-in copy - see
      // liveDepStepIds() - so an edit made in Workflows shows up here
      // immediately, on this episode, without needing to be regenerated.
      function depTasksFor(t){
        return liveDepStepIds(t, liveStepById).map(function(sid){ return taskById[t.episodeId+'_'+sid]; }).filter(Boolean);
      }
      var pct = Math.round(100*doneCount/ts.size);
      var fill = document.getElementById('epProgressFill'); if(fill) fill.style.width = pct+'%';
      var badge = document.getElementById('epStatusBadge');
      if(badge){
        var status = pct===100 ? 'done' : dueStatus(e.dueDate,false);
        badge.innerHTML = '<span class="badge badge-'+status+'">'+statusLabel(status)+' · '+doneCount+'/'+ts.size+'</span>';
      }
      // Comment-count badge on "Comments, links & files" (Phase 2.5 batch
      // A): one grouped query for every task on this episode, rather than
      // one query per task row - counted client-side same as
      // listAllRoles() groups profileRoles by userId. Not a live
      // subscription of its own: it refreshes whenever this episode's task
      // list itself re-fires (a task added/checked/deleted), same
      // "Reload to see the latest" tradeoff the rest of the app already
      // has for anything not on its own realtime channel.
      var taskIds = ts.docs.map(function(d){ return d.id; });
      (taskIds.length ? db.collection('taskComments').where('taskId','in',taskIds).get() : Promise.resolve({docs:[]}))
        .then(function(cSnap){
          var counts = {};
          cSnap.docs.forEach(function(d){ var row=d.data(); counts[row.taskId]=(counts[row.taskId]||0)+1; });
          renderChecklist(counts);
        })
        .catch(function(){ renderChecklist({}); }); // fails open - still render the checklist without counts if this one query fails

      function taskRowHtml(t, commentCounts){
        var r = roleOf(t.role);
        var unmet = depTasksFor(t).filter(function(dt){ return !dt.done; });
        var isBlocked = unmet.length>0;
        var canCheck = (myRoles.indexOf(t.role)>-1 || canManage()) && !isBlocked;
        var waitingLabel = unmet.map(function(dt){ return dt.label; }).join(', ');
        var cCount = commentCounts[t._id]||0;
        return '<div class="task-row '+(t.done?'done':'')+(isBlocked?' task-blocked':'')+'" style="--role-color:'+(r?r.color:'var(--line)')+'">'+
          '<input type="checkbox" class="task-check" data-task="'+t._id+'" '+(t.done?'checked':'')+' '+(canCheck?'':'disabled')+' '+(isBlocked?'title="Locked until \''+escapeHtml(waitingLabel)+'\' '+(unmet.length>1?'are':'is')+' done"':'')+'>'+
          '<div class="task-body"><div class="task-label">'+escapeHtml(t.label)+(t.custom?' <span class="task-custom-badge">custom</span>':'')+'</div>'+
          '<div class="task-meta"><span class="role-chip" style="background:'+(r?r.color:'#888')+'">'+(r?escapeHtml(r.label):t.role)+'</span>'+
          (isBlocked?'<span class="task-waiting">⛔ Waiting on: '+escapeHtml(waitingLabel)+'</span>':'')+
          (t.done && t.doneByUserId?profileChip(t.doneByUserId):'')+
          '</div>'+
          '<button type="button" class="task-expand-btn" data-collab="'+t._id+'">'+(expandedTasks[t._id]?'Hide discussion':'Comments, links & files'+(cCount?' ('+cCount+')':''))+'</button>'+
          '<div class="task-collab" id="collab_'+t._id+'" '+(expandedTasks[t._id]?'':'hidden')+'></div>'+
          '</div>'+
          (canManage()?'<button type="button" class="icon-btn" data-delete-task="'+t._id+'" data-label="'+escapeHtml(t.label)+'" title="Delete task">'+ICON_TRASH+'</button>':'')+
          '</div>';
      }
      function renderChecklist(commentCounts){
      function rowHtml(t){ return taskRowHtml(t, commentCounts); }
      box.innerHTML = order.map(function(g){
        return '<div class="checklist-group"><div class="checklist-group-head"><span class="checklist-group-title">'+escapeHtml(g)+'</span></div>'+
          groups[g].map(rowHtml).join('')+
          '</div>';
      }).join('') + (completed.length ? '<div class="checklist-group checklist-completed"><div class="checklist-group-head"><span class="checklist-group-title">Completed ('+completed.length+')</span></div>'+completed.map(rowHtml).join('')+'</div>' : '');
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
      Array.prototype.forEach.call(box.querySelectorAll('[data-delete-task]'), function(btn){
        btn.addEventListener('click', function(){
          var taskId = btn.getAttribute('data-delete-task');
          var label = btn.getAttribute('data-label');
          if(!confirm('Delete "'+label+'"? Its comments, links and attachments go with it. This cannot be undone.')) return;
          db.doc('tasks/'+taskId).delete().then(function(){
            showToast('success','Task deleted');
          }).catch(function(err){ showToast('error', errMsg(err)); });
        });
      });
      Array.prototype.forEach.call(box.querySelectorAll('[data-collab]'), function(btn){
        var taskId = btn.getAttribute('data-collab');
        btn.addEventListener('click', function(){
          var panel = document.getElementById('collab_'+taskId);
          if(!panel) return;
          var willShow = panel.hasAttribute('hidden');
          if(willShow){ panel.removeAttribute('hidden'); btn.textContent='Hide discussion'; expandedTasks[taskId]=true; loadTaskCollab(taskId, panel); }
          else { panel.setAttribute('hidden',''); btn.textContent='Comments, links & files'+(commentCounts[taskId]?' ('+commentCounts[taskId]+')':''); expandedTasks[taskId]=false; }
        });
        if(expandedTasks[taskId]){
          var panel = document.getElementById('collab_'+taskId);
          if(panel) loadTaskCollab(taskId, panel);
        }
      });
      } // end renderChecklist
    }, function(){});
    activeUnsubs.push(unsubTasks);
    }); // end tplStepByIdPromise.then
  }, function(){ paint('<div class="empty-state">Could not load this episode.</div>'); });
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
        role: fd.get('role'), label: label, group: (fd.get('group')||'').trim(), orderNum: 999, dependsOnStepIds: [],
        dueDate: episode.dueDate, done:false, doneByUserId:null, doneAt:null, custom:true, createdAt: new Date().toISOString()
      }).then(function(){
        closeModal(); showToast('success','Custom task added');
      }).catch(function(err){ showModalError(errMsg(err)); });
    }, 'Add task');
}

// ---------- comments/links/attachments (shared by per-subtask AND
// per-episode discussion threads) ----------
function isImageAttachment(a){
  return ((a&&a.fileType)||'').indexOf('image/')===0 || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test((a&&a.fileName)||'');
}
function attachmentIcon(a){
  var type = ((a&&a.fileType)||'').toLowerCase();
  var name = ((a&&a.fileName)||'').toLowerCase();
  if(type.indexOf('pdf')>-1 || /\.pdf$/.test(name)) return '📕';
  if(type.indexOf('zip')>-1 || /\.(zip|rar|7z)$/.test(name)) return '🗜️';
  if(type.indexOf('video')>-1 || /\.(mp4|mov|avi|mkv|webm)$/.test(name)) return '🎞️';
  if(type.indexOf('audio')>-1 || /\.(mp3|wav|m4a|aac)$/.test(name)) return '🎵';
  if(/\.(doc|docx)$/.test(name)) return '📄';
  if(/\.(xls|xlsx|csv)$/.test(name)) return '📊';
  if(/\.(ppt|pptx)$/.test(name)) return '📽️';
  return '📎';
}
// A simple full-screen preview for image attachments - clicking a thumbnail
// used to just be a download link with no way to actually look at the
// picture without saving it to disk first.
// Zoom in/out on the enlarged image - added 2026-09-21. Ctrl/Cmd +, Ctrl/Cmd
// -, Ctrl/Cmd 0 (reset) match what every browser already does for page zoom,
// so nothing new to learn; Ctrl/Cmd + scroll-wheel zooms too, and the on-
// screen +/-/reset buttons make it discoverable for anyone who'd never try
// the hotkey. The listener is added/removed with the lightbox itself so it
// never lingers and steals +/-/0 keystrokes once the lightbox is closed.
//
// Round 8.5 (2026-09-23): rebuilt zoom + added real click-and-drag panning,
// after Humayun reported zoom as "very glitchy" with no way to drag around
// a zoomed-in image and a Reset button that didn't work. Root cause of
// both: the old version only ever set `transform: scale(...)` on the img
// and relied on the container's native `overflow:auto` to scroll around
// once zoomed - but a CSS transform changes how an element is PAINTED, not
// its layout/scroll size, so the container never actually gained any extra
// scrollable area to pan into. Zooming in just visually grew the image from
// its top-left corner and clipped whatever fell outside the frame, with
// genuinely no way to reach it - not a minor bug, there was nothing to
// scroll. Reset (`zoom=1`) was technically correct but looked "broken" for
// the same reason: it un-scaled the image, but nothing about the old code
// ever moved it back into view either, since panning was never implemented.
// Fixed by dropping native scrolling entirely and driving both zoom and
// pan through the same transform in JS - `translate(panX,panY) scale(zoom)`
// - with pan tracked in panX/panY and clamped so the image can never be
// dragged fully out of the frame. Reset now zeroes zoom AND pan together.
var LIGHTBOX_ZOOM_MIN = 1, LIGHTBOX_ZOOM_MAX = 5, LIGHTBOX_ZOOM_STEP = 0.25;
function showImageLightbox(url, title){
  var root = document.getElementById('modalRoot');
  root.innerHTML = '<div class="modal-backdrop" id="modalBackdrop"><div class="lightbox-frame">'+
    '<button type="button" class="modal-close lightbox-close" id="modalClose">✕</button>'+
    '<div class="lightbox-zoom-controls">'+
      '<button type="button" id="lightboxZoomOut" title="Zoom out (Ctrl -)">−</button>'+
      '<span id="lightboxZoomLevel">100%</span>'+
      '<button type="button" id="lightboxZoomIn" title="Zoom in (Ctrl +)">+</button>'+
      '<button type="button" id="lightboxZoomReset" title="Reset zoom (Ctrl 0)">Reset</button>'+
    '</div>'+
    '<div class="lightbox-img-scroll" id="lightboxScroll"><img id="lightboxImg" src="'+escapeHtml(url)+'" alt="'+escapeHtml(title||'')+'" draggable="false"></div></div></div>';
  root.classList.add('open');
  var zoom = 1, panX = 0, panY = 0;
  var img = document.getElementById('lightboxImg');
  var scroll = document.getElementById('lightboxScroll');
  var levelEl = document.getElementById('lightboxZoomLevel');
  // Keeps the image from ever being dragged (or left, after a zoom-out)
  // fully out of the frame - based on the image's own LAID-OUT size
  // (offsetWidth/Height, unaffected by the transform below, since
  // transform never changes layout) vs. that same size scaled up by the
  // current zoom. At zoom 1 the allowed range is always exactly 0, so this
  // alone is what snaps pan back to 0,0 on every zoom-out past 100%, not
  // just on an explicit Reset.
  function clampPan(){
    var baseW = img.offsetWidth, baseH = img.offsetHeight;
    var maxPanX = Math.max(0, (baseW*zoom - baseW)/2);
    var maxPanY = Math.max(0, (baseH*zoom - baseH)/2);
    panX = Math.max(-maxPanX, Math.min(maxPanX, panX));
    panY = Math.max(-maxPanY, Math.min(maxPanY, panY));
  }
  function render(){
    img.style.transform = 'translate('+panX+'px,'+panY+'px) scale('+zoom+')';
    levelEl.textContent = Math.round(zoom*100)+'%';
    img.style.cursor = zoom>1 ? 'grab' : 'zoom-in';
  }
  function applyZoom(){
    zoom = Math.max(LIGHTBOX_ZOOM_MIN, Math.min(LIGHTBOX_ZOOM_MAX, zoom));
    clampPan();
    render();
  }
  function resetZoom(){ zoom=1; panX=0; panY=0; render(); }
  function zoomBy(delta){ zoom += delta; applyZoom(); }
  function closeLightbox(){ closeModal(); } // closeModal() itself clears activeLightboxKeydown
  function onKeydown(e){
    if(e.key==='Escape'){ closeLightbox(); return; }
    if(!(e.ctrlKey||e.metaKey)) return;
    if(e.key==='='||e.key==='+'){ e.preventDefault(); e.stopImmediatePropagation(); zoomBy(LIGHTBOX_ZOOM_STEP); }
    else if(e.key==='-'){ e.preventDefault(); e.stopImmediatePropagation(); zoomBy(-LIGHTBOX_ZOOM_STEP); }
    else if(e.key==='0'){ e.preventDefault(); e.stopImmediatePropagation(); resetZoom(); }
  }
  activeLightboxKeydown = onKeydown;
  document.addEventListener('keydown', onKeydown);
  scroll.addEventListener('wheel', function(e){
    if(!(e.ctrlKey||e.metaKey)) return;
    e.preventDefault();
    zoomBy(e.deltaY<0 ? LIGHTBOX_ZOOM_STEP : -LIGHTBOX_ZOOM_STEP);
  }, { passive:false });
  document.getElementById('lightboxZoomIn').addEventListener('click', function(){ zoomBy(LIGHTBOX_ZOOM_STEP); });
  document.getElementById('lightboxZoomOut').addEventListener('click', function(){ zoomBy(-LIGHTBOX_ZOOM_STEP); });
  document.getElementById('lightboxZoomReset').addEventListener('click', resetZoom);
  document.getElementById('modalClose').onclick = closeLightbox;
  document.getElementById('modalBackdrop').addEventListener('click', function(e){ if(e.target.id==='modalBackdrop') closeLightbox(); });

  // Click-and-drag panning once zoomed in. Pointer events (not mouse
  // events) so a single capture handles the drag even if the cursor moves
  // off the image mid-drag - no document-level listeners to remember to
  // clean up. The transition is switched off for the duration of a drag so
  // panning tracks the cursor instantly instead of catching up on a delay
  // (the CSS transition stays on for button/hotkey/wheel zoom, where a
  // brief animated step still looks right).
  var dragging = false, dragStartX = 0, dragStartY = 0, panStartX = 0, panStartY = 0;
  img.addEventListener('dragstart', function(e){ e.preventDefault(); }); // stop the browser's own native image-drag-ghost from fighting with this
  img.addEventListener('pointerdown', function(e){
    if(zoom<=1) return;
    dragging = true;
    dragStartX = e.clientX; dragStartY = e.clientY;
    panStartX = panX; panStartY = panY;
    img.style.transition = 'none';
    img.style.cursor = 'grabbing';
    try { img.setPointerCapture(e.pointerId); } catch(err){}
  });
  img.addEventListener('pointermove', function(e){
    if(!dragging) return;
    panX = panStartX + (e.clientX - dragStartX);
    panY = panStartY + (e.clientY - dragStartY);
    clampPan();
    img.style.transform = 'translate('+panX+'px,'+panY+'px) scale('+zoom+')';
  });
  function endDrag(e){
    if(!dragging) return;
    dragging = false;
    img.style.transition = '';
    img.style.cursor = zoom>1 ? 'grab' : 'zoom-in';
    try { img.releasePointerCapture(e.pointerId); } catch(err){}
  }
  img.addEventListener('pointerup', endDrag);
  img.addEventListener('pointercancel', endDrag);

  render();
}

// kind is 'task' or 'episode' - same comments/links/attachments UI, just
// pointed at a different set of tables (see supabase/schema_v2.sql for
// taskComments/taskLinks/taskAttachments and schema_v4.sql for the episode-
// level equivalents added for the general per-episode discussion thread).
var COLLAB_TABLES = {
  // Both prefixes start with 'attachments/' on purpose - worker-r2 only
  // requires an authenticated GET for keys under 'screenshots/' or
  // 'attachments/' (see worker-r2/src/index.js's isSensitiveKey()); a
  // different prefix here would have made episode-level files readable by
  // anyone with the URL, no login required.
  task: { idField:'taskId', comments:'taskComments', links:'taskLinks', attachments:'taskAttachments', keyPrefix:'attachments/' },
  episode: { idField:'episodeId', comments:'episodeComments', links:'episodeLinks', attachments:'episodeAttachments', keyPrefix:'attachments/episode/' }
};
function loadTaskCollab(taskId, panel){ return loadCollab('task', taskId, panel); }
var ICON_PENCIL = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>';
var ICON_BACK = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5"/><path d="M12 19l-7-7 7-7"/></svg>';
var ICON_TRASH = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0-1 14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2L4 6"/></svg>';
// kind is 'task' or 'episode' - same comments/links/attachments UI, just
// pointed at a different set of tables. Rewritten (Phase 1 final fixes) to
// feel like an actual chat/discussion tool instead of a flat list: grouped
// author/avatar rows, inline edit-in-place with an "(edited)" tag, delete
// with confirmation, and hover-revealed actions - closer to Slack/ClickUp
// than the plain stacked-text version this replaced. Edit is author-only;
// delete is the author or a Manager/Admin (moderation), matching how those
// same apps split the two permissions - see supabase/schema_v5.sql.
//
// Composer overhaul (2026-09-21): the separate "paste a link" row is gone -
// linkifyHtml() already turns a URL typed straight into a message into a
// real link, so a second input for the same thing was redundant. Attaching
// a file is no longer its own fire-and-forget action either: picking a
// file now just stages it as a chip above the composer, and ONE Send
// either posts text alone, an attachment alone, or both together as a
// single message (schema_v6.sql adds "commentId" to the attachments
// tables so a file can actually belong to a specific message instead of
// floating in a separate unordered grid). Also added: a real
// auto-expanding textarea (like this very chat box), and emoji reactions
// per message.
var REACTION_EMOJI = ['👍','❤️','😂','😮','😢','🙏','🎉','👀'];
function loadCollab(kind, id, panel){
  var cfg = COLLAB_TABLES[kind];
  panel.innerHTML = '<div class="skeleton" style="height:40px;"></div>';
  Promise.all([
    supabase.from(cfg.comments).select('*').eq(cfg.idField, id).order('createdAt', { ascending: true }),
    supabase.from(cfg.links).select('*').eq(cfg.idField, id).order('createdAt', { ascending: true }),
    supabase.from(cfg.attachments).select('*').eq(cfg.idField, id).order('createdAt', { ascending: true }),
  ]).then(function(res){
    var comments = res[0].data||[], links = res[1].data||[], attachments = res[2].data||[];
    var commentIds = comments.map(function(c){ return c.id; });
    var reactionsPromise = commentIds.length
      ? supabase.from('commentReactions').select('*').eq('kind', kind).in('commentId', commentIds)
      : Promise.resolve({ data: [] });
    return reactionsPromise.then(function(rres){
      var reactions = (rres && rres.data) || [];
      var ids = comments.map(function(c){return c.authorId;}).concat(links.map(function(l){return l.addedBy;})).concat(attachments.map(function(a){return a.uploadedBy;})).concat(reactions.map(function(r){return r.userId;})).filter(Boolean);
      return fetchProfiles(ids).then(function(ps){
      var editingComment = null, editingLink = null; // id of the row currently in inline-edit mode, if any
      var pendingFile = null; // File staged for the NEXT send, via the composer's attach button
      var openPicker = null; // commentId whose reaction picker is currently open, if any
      function who(uid){ return (ps[uid]&&ps[uid].name)||'Someone'; }
      function avatarFor(uid){
        var p = ps[uid]||{};
        return p.avatarUrl ? '<span class="avatar" style="background-image:url(\''+escapeHtml(p.avatarUrl)+'\')"></span>' : '<span class="avatar" style="background:'+(p.color||'#888')+'">'+escapeHtml(p.initial||'?')+'</span>';
      }
      function canEditRow(authorUid){ return authorUid===myUid; }
      function canDeleteRow(authorUid){ return authorUid===myUid || canManage(); }
      function actionButtons(editAttr, deleteAttr, authorUid){
        var edit = canEditRow(authorUid) ? '<button type="button" class="icon-btn" data-'+editAttr+' title="Edit">'+ICON_PENCIL+'</button>' : '';
        var del = canDeleteRow(authorUid) ? '<button type="button" class="icon-btn" data-'+deleteAttr+' title="Delete">'+ICON_TRASH+'</button>' : '';
        return (edit||del) ? '<span class="comment-actions">'+edit+del+'</span>' : '';
      }

      // Reactions grouped by comment - {emoji -> {emoji,count,mine,users[]}}
      var reactionsByComment = {};
      reactions.forEach(function(r){
        var bucket = reactionsByComment[r.commentId] || (reactionsByComment[r.commentId] = {});
        var e = bucket[r.emoji] || (bucket[r.emoji] = { emoji:r.emoji, count:0, mine:false, users:[] });
        e.count++; e.users.push(r.userId);
        if(r.userId===myUid) e.mine = true;
      });
      // Attachments that were sent as part of a specific message render
      // inline under that message instead of the flat grid at the bottom -
      // the grid is now only ever legacy attachments from before this
      // change (no commentId).
      var attachmentsByComment = {}, standaloneAttachments = [];
      attachments.forEach(function(a){
        if(a.commentId){ (attachmentsByComment[a.commentId]=attachmentsByComment[a.commentId]||[]).push(a); }
        else standaloneAttachments.push(a);
      });
      function attachmentDeleteBtn(a){
        return canDeleteRow(a.uploadedBy) ? '<button type="button" class="icon-btn attachment-delete" data-delete-attachment="'+a.id+'" data-key="'+escapeHtml(a.r2Key)+'" title="Delete">'+ICON_TRASH+'</button>' : '';
      }
      function attachmentItemHtml(a){
        if(isImageAttachment(a)) return '<div class="attachment-thumb" data-img-key="'+escapeHtml(a.r2Key)+'" data-img-name="'+escapeHtml(a.fileName)+'"><img loading="lazy"><span class="attachment-name">'+escapeHtml(a.fileName)+'</span>'+attachmentDeleteBtn(a)+'</div>';
        return '<div class="attachment-file"><a href="#" data-download-key="'+escapeHtml(a.r2Key)+'" data-download-name="'+escapeHtml(a.fileName)+'"><span class="attachment-file-icon">'+attachmentIcon(a)+'</span>'+escapeHtml(a.fileName)+'</a>'+attachmentDeleteBtn(a)+'</div>';
      }
      function renderReactions(commentId){
        var bucket = reactionsByComment[commentId] || {};
        var pills = Object.keys(bucket).map(function(em){
          var r = bucket[em];
          return '<button type="button" class="reaction-pill'+(r.mine?' mine':'')+'" data-react="'+commentId+'" data-emoji="'+em+'" title="'+escapeHtml(r.users.map(who).join(', '))+'">'+em+' <span>'+r.count+'</span></button>';
        }).join('');
        var pickerOpen = openPicker===commentId;
        return '<div class="reaction-row">'+pills+
          '<button type="button" class="reaction-add-btn" data-react-toggle-picker="'+commentId+'" title="Add a reaction">🙂+</button>'+
          (pickerOpen?'<div class="reaction-picker">'+REACTION_EMOJI.map(function(em){ return '<button type="button" data-react="'+commentId+'" data-emoji="'+em+'">'+em+'</button>'; }).join('')+'</div>':'')+
          '</div>';
      }

      function renderComment(c){
        if(editingComment===c.id){
          return '<div class="comment-row" data-id="'+c.id+'">'+avatarFor(c.authorId)+
            '<div class="comment-main"><div class="comment-row-head"><span class="comment-author">'+escapeHtml(who(c.authorId))+'</span></div>'+
            '<div class="comment-edit-box"><textarea class="comment-edit-input" data-comment-edit-input>'+escapeHtml(c.body)+'</textarea>'+
            '<div class="comment-edit-actions"><button type="button" class="btn btn-sm" data-save-comment="'+c.id+'">Save</button><button type="button" class="btn btn-sm btn-ghost" data-cancel-comment>Cancel</button></div></div></div></div>';
        }
        var attHtml = attachmentsByComment[c.id] ? '<div class="attachment-grid comment-inline-attachments">'+attachmentsByComment[c.id].map(attachmentItemHtml).join('')+'</div>' : '';
        return '<div class="comment-row" data-id="'+c.id+'">'+avatarFor(c.authorId)+
          '<div class="comment-main"><div class="comment-row-head">'+
          '<span class="comment-author">'+escapeHtml(who(c.authorId))+'</span>'+
          '<span class="comment-time">'+fmtDateTime(c.createdAt)+'</span>'+
          (c.editedAt?'<span class="comment-edited-tag">(edited)</span>':'')+
          actionButtons('edit-comment="'+c.id+'"', 'delete-comment="'+c.id+'"', c.authorId)+
          '</div>'+(c.body?'<div class="comment-body">'+linkifyHtml(escapeHtml(c.body))+'</div>':'')+
          attHtml+renderReactions(c.id)+
          '</div></div>';
      }
      function renderLink(l){
        if(editingLink===l.id){
          return '<div class="link-row" data-id="'+l.id+'"><span class="link-icon">🔗</span>'+
            '<div class="link-edit-box"><input type="url" class="link-edit-url" data-link-edit-url value="'+escapeHtml(l.url)+'" placeholder="URL">'+
            '<input type="text" class="link-edit-label" data-link-edit-label value="'+escapeHtml(l.label||'')+'" placeholder="Label (optional)">'+
            '<button type="button" class="btn btn-sm" data-save-link="'+l.id+'">Save</button><button type="button" class="btn btn-sm btn-ghost" data-cancel-link>Cancel</button></div></div>';
        }
        return '<div class="link-row" data-id="'+l.id+'"><span class="link-icon">🔗</span>'+
          '<a href="'+escapeHtml(l.url)+'" target="_blank" rel="noopener">'+escapeHtml(l.label||l.url)+'</a>'+
          (l.editedAt?'<span class="comment-edited-tag">(edited)</span>':'')+
          actionButtons('edit-link="'+l.id+'"', 'delete-link="'+l.id+'"', l.addedBy)+
          '</div>';
      }

      function render(){
        panel.innerHTML =
          '<div class="collab-list">'+
            (comments.length ? comments.map(renderComment).join('') : '<div class="collab-empty">No comments yet - start the discussion below.</div>') +
          '</div>'+
          (links.length?'<div class="collab-list collab-links">'+links.map(renderLink).join('')+'</div>':'')+
          (standaloneAttachments.length?'<div class="attachment-grid">'+standaloneAttachments.map(attachmentItemHtml).join('')+'</div>':'')+
          '<div class="composer">'+
          '<div class="composer-chip-row" id="composerChipRow_'+id+'"'+(pendingFile?'':' hidden')+'>'+
            (pendingFile?'<span class="composer-file-chip"><span class="attachment-file-icon">'+attachmentIcon({fileName:pendingFile.name,fileType:pendingFile.type})+'</span>'+escapeHtml(pendingFile.name)+'<button type="button" id="composerChipRemove_'+id+'" title="Remove">✕</button></span>':'')+
          '</div>'+
          '<div class="composer-input-row">'+
            '<label class="composer-attach-btn" title="Attach a file">📎<input type="file" id="fileInput_'+id+'" style="display:none;"></label>'+
            '<textarea class="composer-textarea" id="commentInput_'+id+'" placeholder="Message the team…" rows="1"></textarea>'+
            '<button type="button" class="composer-send-btn" id="commentSend_'+id+'" title="Send"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4 20-7Z"/></svg></button>'+
          '</div>'+
          '</div>';
        wire();
      }

      function autoGrow(ta){
        ta.style.height = 'auto';
        ta.style.height = Math.min(ta.scrollHeight, 160) + 'px';
      }

      function sendComposerMessage(){
        var input = document.getElementById('commentInput_'+id);
        var sendBtn = document.getElementById('commentSend_'+id);
        var body = input.value.trim();
        if(!body && !pendingFile) return; // nothing to send - matches the spec: text alone, file alone, or both, never neither
        var file = pendingFile;
        sendBtn.disabled = true;
        var commentId = 'cm_'+uid8();
        var row = { id:commentId, authorId: myUid, body: body };
        row[cfg.idField] = id;
        var uploadStep = file ? uploadFile(file, cfg.keyPrefix+id+'/'+Date.now()+'_'+file.name) : Promise.resolve(null);
        uploadStep.then(function(key){
          return supabase.from(cfg.comments).insert(row).then(function(res2){
            if(res2.error) throw res2.error;
            if(!key) return;
            var attRow = { id:'att_'+uid8(), uploadedBy: myUid, r2Key:key, fileName:file.name, fileType:file.type, fileSize:file.size, commentId: commentId };
            attRow[cfg.idField] = id;
            return supabase.from(cfg.attachments).insert(attRow).then(function(res3){ if(res3.error) throw res3.error; });
          });
        }).then(function(){
          pendingFile = null;
          loadCollab(kind, id, panel);
        }).catch(function(err){
          sendBtn.disabled = false;
          showToast('error', errMsg(err));
        });
      }

      function wire(){
        var textarea = document.getElementById('commentInput_'+id);
        document.getElementById('commentSend_'+id).addEventListener('click', sendComposerMessage);
        textarea.addEventListener('keydown', function(ev){
          if(ev.key==='Enter' && !ev.shiftKey){ ev.preventDefault(); sendComposerMessage(); }
        });
        textarea.addEventListener('input', function(){ autoGrow(textarea); });
        autoGrow(textarea);
        document.getElementById('fileInput_'+id).addEventListener('change', function(ev){
          var file = ev.target.files[0]; if(!file) return;
          pendingFile = file;
          render(); // repaints the chip row + re-focuses nothing, but the textarea keeps whatever was typed since render() only rebuilds markup, not app state
          document.getElementById('commentInput_'+id).focus();
        });
        var chipRemove = document.getElementById('composerChipRemove_'+id);
        if(chipRemove) chipRemove.addEventListener('click', function(){ pendingFile = null; render(); });

        // ---- reactions ----
        Array.prototype.forEach.call(panel.querySelectorAll('[data-react-toggle-picker]'), function(btn){
          btn.addEventListener('click', function(){
            var cid = btn.getAttribute('data-react-toggle-picker');
            openPicker = (openPicker===cid) ? null : cid;
            render();
          });
        });
        Array.prototype.forEach.call(panel.querySelectorAll('[data-react]'), function(btn){
          btn.addEventListener('click', function(){
            var cid = btn.getAttribute('data-react');
            var emoji = btn.getAttribute('data-emoji');
            var bucket = reactionsByComment[cid];
            var already = bucket && bucket[emoji] && bucket[emoji].mine;
            openPicker = null;
            var op = already
              ? supabase.from('commentReactions').delete().eq('kind', kind).eq('commentId', cid).eq('userId', myUid).eq('emoji', emoji)
              : supabase.from('commentReactions').insert({ id:'rx_'+uid8(), kind: kind, commentId: cid, userId: myUid, emoji: emoji });
            op.then(function(res2){
              if(res2.error){ showToast('error', errMsg(res2.error)); return; }
              loadCollab(kind, id, panel);
            });
          });
        });

        // ---- comment edit / delete ----
        Array.prototype.forEach.call(panel.querySelectorAll('[data-edit-comment]'), function(btn){
          btn.addEventListener('click', function(){ editingComment = btn.getAttribute('data-edit-comment'); render(); });
        });
        var cancelCommentBtn = panel.querySelector('[data-cancel-comment]');
        if(cancelCommentBtn) cancelCommentBtn.addEventListener('click', function(){ editingComment = null; render(); });
        var saveCommentBtn = panel.querySelector('[data-save-comment]');
        if(saveCommentBtn) saveCommentBtn.addEventListener('click', function(){
          var cid = saveCommentBtn.getAttribute('data-save-comment');
          var newBody = panel.querySelector('[data-comment-edit-input]').value.trim();
          if(!newBody) return;
          supabase.from(cfg.comments).update({ body: newBody, editedAt: new Date().toISOString() }).eq('id', cid).then(function(res2){
            if(res2.error){ showToast('error', errMsg(res2.error)); return; }
            editingComment = null; loadCollab(kind, id, panel);
          });
        });
        Array.prototype.forEach.call(panel.querySelectorAll('[data-delete-comment]'), function(btn){
          btn.addEventListener('click', function(){
            if(!confirm('Delete this comment?')) return;
            supabase.from(cfg.comments).delete().eq('id', btn.getAttribute('data-delete-comment')).then(function(res2){
              if(res2.error){ showToast('error', errMsg(res2.error)); return; }
              loadCollab(kind, id, panel);
            });
          });
        });

        // ---- link edit / delete ----
        Array.prototype.forEach.call(panel.querySelectorAll('[data-edit-link]'), function(btn){
          btn.addEventListener('click', function(){ editingLink = btn.getAttribute('data-edit-link'); render(); });
        });
        var cancelLinkBtn = panel.querySelector('[data-cancel-link]');
        if(cancelLinkBtn) cancelLinkBtn.addEventListener('click', function(){ editingLink = null; render(); });
        var saveLinkBtn = panel.querySelector('[data-save-link]');
        if(saveLinkBtn) saveLinkBtn.addEventListener('click', function(){
          var lid = saveLinkBtn.getAttribute('data-save-link');
          var newUrl = panel.querySelector('[data-link-edit-url]').value.trim();
          var newLabel = panel.querySelector('[data-link-edit-label]').value.trim();
          if(!newUrl) return;
          supabase.from(cfg.links).update({ url: newUrl, label: newLabel, editedAt: new Date().toISOString() }).eq('id', lid).then(function(res2){
            if(res2.error){ showToast('error', errMsg(res2.error)); return; }
            editingLink = null; loadCollab(kind, id, panel);
          });
        });
        Array.prototype.forEach.call(panel.querySelectorAll('[data-delete-link]'), function(btn){
          btn.addEventListener('click', function(){
            if(!confirm('Delete this link?')) return;
            supabase.from(cfg.links).delete().eq('id', btn.getAttribute('data-delete-link')).then(function(res2){
              if(res2.error){ showToast('error', errMsg(res2.error)); return; }
              loadCollab(kind, id, panel);
            });
          });
        });

        // ---- attachment delete ----
        Array.prototype.forEach.call(panel.querySelectorAll('[data-delete-attachment]'), function(btn){
          btn.addEventListener('click', function(ev){
            ev.stopPropagation();
            if(!confirm('Delete this attachment?')) return;
            var attId = btn.getAttribute('data-delete-attachment');
            var key = btn.getAttribute('data-key');
            supabase.from(cfg.attachments).delete().eq('id', attId).then(function(res2){
              if(res2.error){ showToast('error', errMsg(res2.error)); return; }
              // Best-effort - the row is already gone either way, so a failure
              // here just means an orphaned object in the bucket, not a stuck UI.
              deleteRemoteFile(key).catch(function(){});
              loadCollab(kind, id, panel);
            });
          });
        });

        Array.prototype.forEach.call(panel.querySelectorAll('[data-img-key]'), function(thumb){
          var key = thumb.getAttribute('data-img-key');
          var name = thumb.getAttribute('data-img-name');
          var img = thumb.querySelector('img');
          fetchProtectedUrl(key).then(function(url){
            img.src = url;
            img.addEventListener('click', function(){ showImageLightbox(url, name); });
          }).catch(function(){ thumb.style.opacity='.4'; });
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
      }

      render();
      });
    });
  }).catch(function(err){ panel.innerHTML = '<div class="empty-state" style="padding:10px;">Could not load discussion.</div>'; });
}

// ---------- MY BOARD ----------
function renderBoard(){
  if(!myRoles.length){
    paint('<div class="page-head"><div><div class="eyebrow">My Board</div><h1 class="page-title">Loading…</h1></div></div>');
    return;
  }
  // round 8.8/schema_v10: someone can now hold more than one job-title role
  // at once, so "my board" needs to show tasks matching ANY role they hold,
  // not just a single myRole - the heading joins every role's label rather
  // than assuming there's exactly one.
  var myRoleLabels = myRoles.map(function(k){ var rr=roleOf(k); return rr?rr.label:k; }).join(' & ');
  var showingAll = canManage();
  paint(
    '<div class="page-head"><div><div class="eyebrow">My Board</div><h1 class="page-title">'+(showingAll?'All open tasks':escapeHtml(myRoleLabels)+"'s tasks")+'</h1>'+
    '<div class="page-sub">'+(showingAll?'Everything across your team\'s clients, grouped by due date.':'Everything assigned to your role, across your team\'s clients.')+'</div></div></div>'+
    '<div id="boardBody"><div class="skeleton" style="height:60px;margin-bottom:10px;"></div><div class="skeleton" style="height:60px;"></div></div>'
  );

  var q = db.collection('tasks').where('done','==',false);
  if(!showingAll) q = q.where('role','in', myRoles);
  q = q.orderBy('dueDate','asc').limit(200);

  var unsub = q.onSnapshot(function(snap){
    var box = document.getElementById('boardBody');
    if(!box) return;
    if(snap.empty){ box.innerHTML = '<div class="empty-state"><strong>Nothing open</strong>Every task for this view is checked off.</div>'; return; }
    var tasks = snap.docs.map(function(d){ var t=d.data(); t._id=d.id; return t; });
    // Same live-dependency-lookup as the episode page (see
    // liveDepStepIds()) - a dependency a task waits on is read off the
    // CURRENT template step, not the fixed copy baked in when the episode
    // was generated, so an edit made in Workflows shows up here
    // immediately too. The board spans many different episodes/clients at
    // once (unlike the episode page's single template), so this fetches
    // each distinct episode referenced by the visible tasks to find its
    // templateId, then each distinct template those point at, before it
    // knows which steps to check - two small batched round trips, bounded
    // by however many different episodes/templates are actually in view
    // (this board's own query is already capped at 200 tasks).
    var episodeIds = tasks.map(function(t){ return t.episodeId; }).filter(function(id,i,arr){ return arr.indexOf(id)===i; });
    Promise.all(episodeIds.map(function(id){ return db.doc('episodes/'+id).get().catch(function(){ return {exists:false}; }); }))
      .then(function(epSnaps){
        var templateIdByEpisodeId = {};
        var templateIds = [];
        epSnaps.forEach(function(s,i){
          var tplId = (s.exists && s.data().templateId) || null;
          templateIdByEpisodeId[episodeIds[i]] = tplId;
          if(tplId && templateIds.indexOf(tplId)===-1) templateIds.push(tplId);
        });
        return Promise.all(templateIds.map(function(id){ return db.doc('templates/'+id).get().catch(function(){ return {exists:false}; }); }))
          .then(function(tplSnaps){
            var stepsByTemplateId = {};
            tplSnaps.forEach(function(s,i){ stepsByTemplateId[templateIds[i]] = (s.exists && s.data().steps) || []; });
            var liveStepByEpisodeId = {};
            episodeIds.forEach(function(epId){
              var stepById = {};
              (stepsByTemplateId[templateIdByEpisodeId[epId]]||[]).forEach(function(s){ stepById[s.stepId] = s; });
              liveStepByEpisodeId[epId] = stepById;
            });
            return liveStepByEpisodeId;
          });
      })
      .then(function(liveStepByEpisodeId){
        // Unlike the episode page (which already has every sibling task,
        // including done ones, in one query), this board's query excludes
        // done tasks entirely - so a prerequisite that's ALREADY done (the
        // normal case once someone finishes it) won't be in `tasks` at
        // all. Fetch each referenced prerequisite by its deterministic id
        // (episodeId + '_' + stepId, same scheme generateEpisodesForRule
        // uses) instead of assuming it's in this snapshot. A task can wait
        // on more than one step since 2026-09-22, so this flattens every
        // task's full (live) dependency list first.
        var depIds = [];
        tasks.forEach(function(t){ liveDepStepIds(t, liveStepByEpisodeId[t.episodeId]).forEach(function(sid){ depIds.push(t.episodeId+'_'+sid); }); });
        depIds = depIds.filter(function(id,i){ return depIds.indexOf(id)===i; });
        Promise.all(depIds.map(function(id){ return db.doc('tasks/'+id).get().catch(function(){ return {exists:false}; }); }))
          .then(function(depSnaps){
            var depById = {};
            depSnaps.forEach(function(s,i){ if(s.exists) depById[depIds[i]] = s.data(); });
            renderBoardBody(box, tasks, depById, showingAll, liveStepByEpisodeId);
          });
      });
  }, function(){ var b=document.getElementById('boardBody'); if(b) b.innerHTML='<div class="empty-state">Could not load your board.</div>'; });
  activeUnsubs.push(unsub);
}

function renderBoardBody(box, tasks, depById, showingAll, liveStepByEpisodeId){
  var groups = {overdue:[], 'due-soon':[], upcoming:[]};
  tasks.forEach(function(t){
    var s = dueStatus(t.dueDate,false);
    (groups[s]||groups.upcoming).push(t);
  });
  var order = [['overdue','Overdue'], ['due-soon','Due within 7 days'], ['upcoming','Upcoming']];
  box.innerHTML = order.filter(function(o){ return groups[o[0]].length; }).map(function(o){
    return '<div class="board-group"><div class="board-group-title">'+o[1]+'</div>'+
      groups[o[0]].map(function(t){
        var rr = roleOf(t.role);
        var depTasks = liveDepStepIds(t, liveStepByEpisodeId[t.episodeId]).map(function(sid){ return depById[t.episodeId+'_'+sid]; }).filter(Boolean);
        var unmet = depTasks.filter(function(dt){ return !dt.done; });
        var isBlocked = unmet.length>0;
        var canCheck = (myRoles.indexOf(t.role)>-1 || canManage()) && !isBlocked;
        var waitingLabel = unmet.map(function(dt){ return dt.label; }).join(', ');
        return '<div class="board-task'+(isBlocked?' task-blocked':'')+'" style="border-left:3px solid '+(rr?rr.color:'var(--line)')+'">'+
          '<input type="checkbox" class="task-check" data-task="'+t._id+'" '+(canCheck?'':'disabled')+' '+(isBlocked?'title="Locked until \''+escapeHtml(waitingLabel)+'\' '+(unmet.length>1?'are':'is')+' done"':'')+'>'+
          '<div class="task-body"><div class="task-label">'+escapeHtml(t.label)+'</div>'+
          '<div class="board-task-client">'+escapeHtml(t.clientName)+(showingAll?' <span class="role-chip" style="background:'+(rr?rr.color:'#888')+'">'+(rr?escapeHtml(rr.label):t.role)+'</span>':'')+'</div>'+
          '<div class="board-task-episode">'+escapeHtml(t.episodeTitle)+' · due '+fmtDate(t.dueDate)+'</div>'+
          (isBlocked?'<div class="task-meta"><span class="task-waiting">⛔ Waiting on: '+escapeHtml(waitingLabel)+'</span></div>':'')+
          '</div></div>';
      }).join('')+
      '</div>';
  }).join('');
  Array.prototype.forEach.call(box.querySelectorAll('.task-check:not([disabled])'), function(cb){
    cb.addEventListener('change', function(){
      var taskId = cb.getAttribute('data-task');
      db.doc('tasks/'+taskId).update({done:true, doneByUserId:myUid, doneAt:new Date().toISOString()}).catch(function(err){ cb.checked=false; showToast('error', errMsg(err)); });
    });
  });
}

// ---------- TIMELOG ----------
// Full-size screenshot + whatever activity (keys/mouse) was recorded in the
// window overlapping when it was taken - activity is flushed every 5
// minutes while screenshots land every 5-15, so this looks for the window
// that actually contains the screenshot's timestamp, falling back to the
// closest one if none lines up exactly (e.g. right at clock-in/out).
function showScreenshotDetail(s, imgUrl){
  var title = 'Screenshot - '+fmtDateTime(s.takenAt);
  var root = document.getElementById('modalRoot');
  root.innerHTML = '<div class="modal-backdrop" id="modalBackdrop"><div class="modal modal-lg">'+
    '<div class="modal-head"><h3>'+escapeHtml(title)+'</h3><button type="button" class="modal-close" id="modalClose">✕</button></div>'+
    '<div style="padding:17px 19px;display:flex;flex-direction:column;gap:14px;max-height:78vh;overflow-y:auto;">'+
    // Fixed at this modal's own width, which is nowhere near enough to make
    // out real detail in a screenshot - added 2026-09-22: click (or the
    // explicit button, for anyone who wouldn't think to click the image
    // itself) opens the SAME full-size, zoomable lightbox already used for
    // comment/chat image attachments (Ctrl +/-/0, Ctrl+wheel, on-screen
    // buttons all already work there) instead of only ever showing this
    // capped-width preview.
    '<div style="position:relative;">'+
    '<img src="'+escapeHtml(imgUrl)+'" id="shotThumb" style="width:100%;border-radius:10px;border:1px solid var(--line);display:block;cursor:zoom-in;">'+
    '<button type="button" class="btn btn-sm" id="shotFullSizeBtn" style="position:absolute;bottom:10px;right:10px;">View full size</button>'+
    '</div>'+
    '<div id="shotActivityBox"><div class="skeleton" style="height:50px;"></div></div>'+
    '</div></div></div>';
  root.classList.add('open');
  document.getElementById('modalClose').onclick = closeModal;
  document.getElementById('modalBackdrop').addEventListener('click', function(e){ if(e.target.id==='modalBackdrop') closeModal(); });
  var openFullSize = function(){ showImageLightbox(imgUrl, title); };
  document.getElementById('shotThumb').addEventListener('click', openFullSize);
  document.getElementById('shotFullSizeBtn').addEventListener('click', openFullSize);

  var box = document.getElementById('shotActivityBox');
  if(!s.timeEntryId){ box.innerHTML = '<div class="empty-state">No activity data linked to this screenshot.</div>'; return; }
  timelog.listActivityForEntry(s.timeEntryId).then(function(samples){
    var taken = new Date(s.takenAt).getTime();
    var match = samples.filter(function(a){ return new Date(a.windowStart).getTime() <= taken && taken <= new Date(a.windowEnd).getTime(); })[0];
    var approximate = false;
    if(!match && samples.length){
      approximate = true;
      match = samples.reduce(function(best,a){
        var d = Math.min(Math.abs(new Date(a.windowStart).getTime()-taken), Math.abs(new Date(a.windowEnd).getTime()-taken));
        return (!best || d<best._d) ? {row:a, _d:d} : best;
      }, null).row;
    }
    if(!match){ box.innerHTML = '<div class="empty-state">No activity recorded around this time.</div>'; return; }
    box.innerHTML =
      '<h3 style="font-size:14px;margin-bottom:2px;">Activity '+(approximate?'near ':'')+escapeHtml(fmtDateTime(match.windowStart))+' – '+escapeHtml(fmtDateTime(match.windowEnd))+'</h3>'+
      (approximate?'<div class="field-hint" style="margin-bottom:8px;">No activity window lined up exactly with this screenshot - showing the closest one recorded.</div>':'')+
      '<div class="field-row" style="margin:8px 0;">'+
      '<div class="panel" style="flex:1;text-align:center;padding:12px;"><div style="font-size:22px;font-weight:700;">'+(match.keyCount||0)+'</div><div style="font-size:11.5px;color:var(--muted);">Keys pressed</div></div>'+
      '<div class="panel" style="flex:1;text-align:center;padding:12px;"><div style="font-size:22px;font-weight:700;">'+(match.mouseDistance||0)+'</div><div style="font-size:11.5px;color:var(--muted);">Mouse distance (px)</div></div>'+
      '</div>'+
      (match.keyLog?'<div class="field-hint" style="margin-bottom:4px;">What was typed in this window</div><div style="font-family:var(--font-mono);font-size:11.5px;background:var(--paper);border:1px solid var(--line);border-radius:8px;padding:8px 10px;max-height:120px;overflow-y:auto;white-space:pre-wrap;word-break:break-word;">'+escapeHtml(match.keyLog)+'</div>':'');
  }).catch(function(){ box.innerHTML = '<div class="empty-state">Could not load activity for this window.</div>'; });
}

// A crude but useful "how busy were they" heuristic for one 5-minute
// activitySamples window: keystrokes and mouse movement don't share a
// scale, so each is normalized against a rough "clearly active" threshold
// and the bar shows whichever one is higher (someone deep in a mouse-only
// tool like an editor timeline shouldn't read as idle just because they
// aren't typing). This is intentionally approximate - it's for an
// at-a-glance bar, like Kimai/Upwork's timeline, not a precise metric.
function activityScore(sample){
  var keyScore = Math.min(1, (sample.keyCount||0) / 80);
  var mouseScore = Math.min(1, (sample.mouseDistance||0) / 6000);
  return Math.max(keyScore, mouseScore);
}
function activityLevelClass(score){
  if(score >= 0.55) return 'high';
  if(score >= 0.12) return 'med';
  return 'low';
}
function sessionDurationLabel(e){
  var start = new Date(e.clockInAt).getTime();
  var end = e.clockOutAt ? new Date(e.clockOutAt).getTime() : Date.now();
  var mins = Math.max(0, Math.round((end-start)/60000));
  var h = Math.floor(mins/60), m = mins%60;
  return (h?h+'h ':'')+m+'m'+(e.clockOutAt?'':' so far');
}
function sessionWhenLabel(e){
  var start = new Date(e.clockInAt);
  var dateLabel = start.toLocaleDateString(undefined,{weekday:'short',month:'short',day:'numeric'});
  var startTime = start.toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'});
  var endTime = e.clockOutAt ? new Date(e.clockOutAt).toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'}) : 'now';
  return dateLabel+' · '+startTime+' – '+endTime;
}

function renderTimeLog(){
  paint(
    '<div class="page-head"><div><div class="eyebrow">TimeLog</div><h1 class="page-title">Your time & activity</h1>'+
    '<div class="page-sub">Screenshots and activity are recorded automatically while you\'re clocked in, organized below by clock-in session. You can view your own history here, but not delete it.</div></div>'+
    '<button type="button" class="timelog-badge'+(timelog.isClockedIn()?'':' off')+'" id="clockToggleBtn">'+(timelog.isClockedIn()?'● Clocked in - stop':'Clock in')+'</button>'+
    '</div>'+
    (canManage()?'<div class="field" style="max-width:320px;margin-bottom:20px;"><label>Viewing</label><select id="timelogWho"></select></div>':'')+
    '<div id="sessionList"><div class="skeleton" style="height:120px;margin-bottom:12px;"></div><div class="skeleton" style="height:120px;"></div></div>'
  );
  document.getElementById('clockToggleBtn').addEventListener('click', toggleClock);

  function loadFor(uid){
    var box = document.getElementById('sessionList');
    box.innerHTML = '<div class="skeleton" style="height:120px;margin-bottom:12px;"></div><div class="skeleton" style="height:120px;"></div>';
    timelog.listTimeEntries(uid, 25).then(function(entries){
      if(!entries.length){ box.innerHTML = '<div class="empty-state">No clock-in sessions recorded yet.</div>'; return; }
      box.innerHTML = entries.map(function(e,i){
        return '<div class="session-card" id="session_'+i+'">'+
          '<div class="session-head">'+
          '<div class="session-when">'+(!e.clockOutAt?'<span class="session-live-dot"></span>':'')+'<strong>'+escapeHtml(sessionWhenLabel(e))+'</strong></div>'+
          '<div class="session-duration">'+escapeHtml(sessionDurationLabel(e))+'</div>'+
          '</div>'+
          '<div class="session-activity" id="sessionActivity_'+i+'"><div class="skeleton" style="height:26px;"></div></div>'+
          '<div class="session-shots" id="sessionShots_'+i+'"></div>'+
          '</div>';
      }).join('');
      entries.forEach(function(e,i){ loadSessionDetail(e,i); });
    }).catch(function(){ box.innerHTML = '<div class="empty-state">Could not load your TimeLog history.</div>'; });
  }

  function loadSessionDetail(e, i){
    Promise.all([
      timelog.listActivityForEntry(e.id).catch(function(){ return []; }),
      timelog.listScreenshotsForEntry(e.id, 40).catch(function(){ return []; }),
    ]).then(function(res){
      var samples = res[0], shots = res[1];
      var activityBox = document.getElementById('sessionActivity_'+i);
      var shotsBox = document.getElementById('sessionShots_'+i);
      if(!activityBox || !shotsBox) return; // navigated away before this resolved

      if(!samples.length){
        activityBox.innerHTML = '<div class="session-activity-empty">No activity recorded yet for this session.</div>';
      } else {
        var totalKeys = samples.reduce(function(sum,s){ return sum+(s.keyCount||0); }, 0);
        var totalMouse = samples.reduce(function(sum,s){ return sum+(s.mouseDistance||0); }, 0);
        activityBox.innerHTML =
          '<div class="activity-bar">'+samples.map(function(s){
            var score = activityScore(s);
            var level = activityLevelClass(score);
            var title = fmtDateTime(s.windowStart)+' – '+fmtDateTime(s.windowEnd)+': '+(s.keyCount||0)+' keys, '+Math.round(s.mouseDistance||0)+'px mouse';
            return '<div class="activity-seg activity-'+level+'" title="'+escapeHtml(title)+'"></div>';
          }).join('')+'</div>'+
          '<div class="session-activity-stats"><span>'+totalKeys+' keys pressed</span><span>'+Math.round(totalMouse)+'px mouse movement</span></div>';
      }

      if(!shots.length){
        shotsBox.innerHTML = '';
      } else {
        shotsBox.innerHTML = '<div class="shot-grid compact">'+shots.map(function(s,si){
          return '<div class="shot-thumb" data-shot-key="'+escapeHtml(s.r2Key)+'" data-shot-i="'+si+'"><img loading="lazy"><span class="shot-time">'+fmtDateTime(s.takenAt)+'</span></div>';
        }).join('')+'</div>';
        // Screenshots require an authenticated fetch (see r2.js), so each
        // thumbnail's real image loads in after the fact rather than via a
        // plain src= URL.
        Array.prototype.forEach.call(shotsBox.querySelectorAll('[data-shot-key]'), function(thumb){
          var key = thumb.getAttribute('data-shot-key');
          var idx = +thumb.getAttribute('data-shot-i');
          var img = thumb.querySelector('img');
          fetchProtectedUrl(key).then(function(url){
            img.src = url;
            thumb.addEventListener('click', function(){ showScreenshotDetail(shots[idx], url); });
          }).catch(function(){ thumb.style.opacity='.4'; });
        });
      }
    });
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

// ---------- CONNECT: call state ----------
// Rebuilt 2026-09-21 from a 1:1-only ring/answer handshake into a real N-way
// call: group Connect (pick anyone online), joining a call already in
// progress, and adding a participant mid-call (for a 1:1 call too, not just
// group). See lib/connect.js's top-of-file comment for the full design -
// short version: everyone on a call shares one callId and tracks Supabase
// Presence on a room named after it, so "someone joined" (initial join,
// mid-call add, or arriving late to a group call already going) is a single
// code path, not three. This has been checked against Cloudflare's current
// API reference but NOT run end-to-end against a live call yet - that needs
// Humayun to actually try it on two+ machines/accounts once worker-realtime
// is deployed.
var activeCall = null;
// {
//   callId, pc, localStream, sessionId, muted, hadOtherParticipant,
//   room: { leave() },
//   participants: { [uid]: { uid, name, sessionId, audioEl } },
//   pendingPullUids: [], // FIFO - see wireRemoteAudio's comment
// }
// An incoming ring waiting on Accept/Decline - only ever set for someone
// who's clocked out (see handleIncomingRing). { callId, fromUid, timer }.
// Kept separate from activeCall since it's the pre-answer state, not a call
// we've actually joined yet.
var pendingRingCall = null;
var RING_TIMEOUT_MS = 30000; // confirmed with Humayun 2026-09-23

// ---------- RINGTONE (soft, synthesized - no bundled audio file, so
// nothing to source/license/ship) ----------
// A gentle two-note chime (Web Audio oscillators, not a sample), repeating
// every ~2.2s while a call is ringing and someone's not yet accepted or
// declined it. Kept deliberately quiet/soft per Humayun's ask, not a loud
// alarm-style ring. Each ring gets its own fresh AudioContext, closed again
// in stopRingtone() - simplest way to guarantee nothing keeps playing (or
// keeps a context alive) after the popup is gone, without having to track
// a shared context's lifecycle across unrelated calls.
var ringtoneCtx = null, ringtoneTimer = null;
function startRingtone(){
  stopRingtone();
  try { ringtoneCtx = new (window.AudioContext || window.webkitAudioContext)(); }
  catch(e){ return; } // no Web Audio support - ring silently rather than error
  // Some webviews create a fresh AudioContext already suspended until a user
  // gesture resumes it; by the time any ring can arrive here someone has
  // already signed in and clicked around, so this should already be
  // allowed, but resume() is the standard, harmless way to ask anyway.
  try { ringtoneCtx.resume(); } catch(e){}
  function chime(){
    if(!ringtoneCtx) return;
    var now = ringtoneCtx.currentTime;
    [523.25, 659.25].forEach(function(freq, i){ // soft two-note chime (C5, E5)
      var osc = ringtoneCtx.createOscillator();
      var gain = ringtoneCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      var t = now + i*0.18;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.12, t+0.03); // soft attack, modest volume
      gain.gain.exponentialRampToValueAtTime(0.0001, t+0.5); // gentle decay
      osc.connect(gain); gain.connect(ringtoneCtx.destination);
      osc.start(t); osc.stop(t+0.55);
    });
  }
  chime();
  ringtoneTimer = setInterval(chime, 2200);
}
function stopRingtone(){
  if(ringtoneTimer){ clearInterval(ringtoneTimer); ringtoneTimer = null; }
  if(ringtoneCtx){ try{ ringtoneCtx.close(); }catch(e){} ringtoneCtx = null; }
}

// ---------- CALL-CONNECTED BEEP (round 8.7, 2026-09-24 - soft, synthesized,
// same reasoning as the ringtone above: no bundled audio file to source or
// license). Plays once whenever a participant's audio actually connects -
// see pullParticipant() below, the one place both "the other side of a 1:1
// call just answered" and "someone new just joined a group call" funnel
// through, so one hook covers both cases Humayun asked for. Deliberately a
// one-shot context (not shared/reused like the ringtone's) since this can
// fire several times in quick succession in a group call as people join.
function playCallConnectedBeep(){
  try {
    var ctx = new (window.AudioContext || window.webkitAudioContext)();
    var now = ctx.currentTime;
    [660, 880].forEach(function(freq, i){ // soft rising two-note beep (E5, A5) - distinct from the ringtone's chime so the two are never confused
      var osc = ctx.createOscillator();
      var gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      var t = now + i*0.09;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.1, t+0.02); // soft attack, modest volume
      gain.gain.exponentialRampToValueAtTime(0.0001, t+0.28); // quick, gentle decay
      osc.connect(gain); gain.connect(ctx.destination);
      osc.start(t); osc.stop(t+0.3);
    });
    setTimeout(function(){ try{ ctx.close(); }catch(e){} }, 500);
  } catch(e){} // no Web Audio support - fail silently, same as the ringtone
}

// ---------- INCOMING CALL POPUP (Accept/Decline, only shown when the
// person being rung is clocked out - see handleIncomingRing) ----------
// A standalone fixed-position card appended straight to document.body,
// same pattern as renderCallBar()'s #connectBar - it needs to appear
// un-asked-for on top of whatever page is currently showing, which the
// generic openModal() isn't built for (it expects an explicit user action
// to open it, and its backdrop-click-to-dismiss would let a ring be
// swallowed by an accidental click).
function showIncomingCallPopup(fromProfile, onAccept, onDecline){
  hideIncomingCallPopup();
  var el = document.createElement('div');
  el.id = 'incomingCallPopup';
  el.className = 'incoming-call-popup';
  el.innerHTML =
    '<div><div class="incoming-call-name">'+escapeHtml((fromProfile&&fromProfile.name)||'Someone')+'</div>'+
    '<div class="incoming-call-sub">is calling…</div></div>'+
    '<div class="incoming-call-actions">'+
      '<button type="button" class="btn btn-sm btn-danger" id="incomingCallDecline">Decline</button>'+
      '<button type="button" class="btn btn-sm incoming-call-accept" id="incomingCallAccept">Accept</button>'+
    '</div>';
  document.body.appendChild(el);
  document.getElementById('incomingCallAccept').addEventListener('click', function(){ onAccept(); });
  document.getElementById('incomingCallDecline').addEventListener('click', function(){ onDecline('declined'); });
  startRingtone();
}
function hideIncomingCallPopup(){
  var el = document.getElementById('incomingCallPopup');
  if(el) el.remove();
  stopRingtone();
}

function wireRemoteAudio(call){
  // One RTCPeerConnection, one /pull per remote participant - each pull
  // that actually adds a track fires `ontrack` once more. Correlating which
  // track belongs to which participant isn't given to us directly by the
  // event, so pullParticipant() below pushes the uid it's about to pull
  // BEFORE awaiting the pull, and this shifts that same queue - pulls are
  // always awaited one at a time (see connect.js's pullChain), so the order
  // a track arrives in always matches the order it was requested in.
  call.pc.ontrack = function(ev){
    var uid = call.pendingPullUids.shift();
    var p = uid && call.participants[uid];
    if(!p) return; // stray/late track for someone who already left - drop it
    if(!p.audioEl){
      p.audioEl = document.createElement('audio');
      p.audioEl.autoplay = true;
      document.body.appendChild(p.audioEl);
    }
    p.audioEl.srcObject = ev.streams[0];
  };
}

function renderCallBar(){
  // Uses the pre-existing .connect-bar CSS (style.css) rather than
  // inventing a new class, so this actually renders styled instead of
  // looking like unstyled plain text/buttons.
  var bar = document.getElementById('connectBar');
  if(!activeCall){ if(bar) bar.remove(); return; }
  if(!bar){
    bar = document.createElement('div');
    bar.id = 'connectBar';
    bar.className = 'connect-bar';
    document.body.appendChild(bar);
  }
  var names = Object.keys(activeCall.participants).map(function(uid){ return activeCall.participants[uid].name || 'Someone'; });
  var status = names.length ? ('On a call with '+names.join(', ')) : 'Calling…';
  bar.innerHTML = '<span class="connect-bar-status">'+escapeHtml(status)+'</span>'+
    '<button type="button" class="btn btn-sm" id="callAddBtn">+ Add</button>'+
    '<button type="button" class="btn btn-sm" id="callMuteBtn">'+(activeCall.muted?'Unmute':'Mute')+'</button>'+
    '<button type="button" class="btn btn-sm btn-danger" id="callHangupBtn">Hang up</button>';
  document.getElementById('callMuteBtn').addEventListener('click', function(){
    if(!activeCall || !activeCall.localStream) return;
    activeCall.muted = !activeCall.muted;
    activeCall.localStream.getAudioTracks().forEach(function(t){ t.enabled = !activeCall.muted; });
    renderCallBar();
  });
  document.getElementById('callHangupBtn').addEventListener('click', function(){ hangupCall(); });
  document.getElementById('callAddBtn').addEventListener('click', openAddToCallModal);
}

function hangupCall(){
  if(!activeCall) return;
  var call = activeCall;
  Object.keys(call.participants).forEach(function(uid){
    var p = call.participants[uid];
    if(p.audioEl){ try{ p.audioEl.remove(); }catch(e){} }
  });
  if(call.room) call.room.leave(); // this alone is the hangup signal - see connect.js
  endSession(call);
  activeCall = null;
  renderCallBar();
}

// Pulls one participant's audio in and tracks them on the call. Shared by
// the initial join (called once per person already in the room) and by
// someone arriving later (called once more, whenever that happens) - same
// function either way, per the room-model design above.
function pullParticipant(call, meta){
  if(!call.pc || !meta || !meta.sessionId || call.participants[meta.uid]) return Promise.resolve();
  call.participants[meta.uid] = { uid: meta.uid, name: meta.name, sessionId: meta.sessionId };
  call.hadOtherParticipant = true;
  call.pendingPullUids.push(meta.uid);
  renderCallBar();
  return pullRemoteTrack(call.sessionId, meta.sessionId, 'mic', call.pc).then(function(){
    playCallConnectedBeep();
  }).catch(function(err){
    delete call.participants[meta.uid];
    renderCallBar();
    showToast('error', 'Could not hear '+(meta.name||'a participant')+': '+errMsg(err));
  });
}

function enterCallRoom(call){
  call.room = joinCallRoom(call.callId, { id: myUid, name: (myProfile&&myProfile.displayName)||'' }, call.sessionId, {
    onParticipant: function(meta){ return pullParticipant(call, meta); },
    onLeft: function(meta){
      if(activeCall!==call) return; // stale handler from a call we've already left
      var p = call.participants[meta.uid];
      if(p && p.audioEl){ try{ p.audioEl.remove(); }catch(e){} }
      delete call.participants[meta.uid];
      renderCallBar();
      // If we've had someone else with us at some point and now there's no
      // one left, the call is over for us too - covers both a 1:1 hangup
      // and a group call emptying out, with no separate code path for
      // either. The hadOtherParticipant guard matters so this doesn't
      // fire while we're still alone waiting for the first ring to be
      // picked up.
      if(call.hadOtherParticipant && Object.keys(call.participants).length===0) hangupCall();
    },
  });
}

// Starts a brand-new call (1:1 or group - targetUids is always an array,
// even for one person), OR, if we're already on a call, rings the given
// uid(s) to ADD them to it - the exact same ring()+room-join mechanism
// handles both, so there's no separate "invite mid-call" implementation.
function startCall(targetUids, names){
  if(!targetUids || !targetUids.length) return;
  var fromProfile = { id: myUid, name: (myProfile&&myProfile.displayName)||'' };
  if(activeCall){
    var callId = activeCall.callId;
    Promise.all(targetUids.map(function(uid){ return ring(uid, fromProfile, callId, true); }))
      .then(function(){
        showToast('success', targetUids.length>1 ? 'Ringing '+targetUids.length+' people to join…' : 'Ringing '+(names[targetUids[0]]||'them')+' to join…');
      }).catch(function(err){ showToast('error', errMsg(err)); });
    return;
  }
  if(!connectConfigured){ showToast('error','Connect isn\'t configured yet - see README.md.'); return; }
  var newId = newCallId();
  activeCall = { callId: newId, participants:{}, pendingPullUids: [], hadOtherParticipant:false, muted:false };
  renderCallBar();
  startLocalSession().then(function(session){
    if(!activeCall || activeCall.callId!==newId){ endSession(session); return; } // hung up before this resolved
    activeCall.pc = session.pc; activeCall.localStream = session.localStream; activeCall.sessionId = session.sessionId;
    wireRemoteAudio(activeCall);
    enterCallRoom(activeCall);
    // Fallback safety net for a genuine 1:1 ring, on top of the explicit
    // declineRing()/'ring-missed' signal handled by handleRingMissed above -
    // that signal only ever arrives if the other side's app is actually
    // open and running to send it. If it never shows up at all (their app
    // isn't running, crashed, lost network mid-ring...) this is what stops
    // us waiting on "Calling…" forever: give their own ~30s ring window a
    // several-second head start, then give up too if still nobody's here.
    // Deliberately only for a single target - a multi-person ring shouldn't
    // auto-abandon itself just because one of several people hasn't picked
    // up yet.
    if(targetUids.length===1){
      setTimeout(function(){
        if(activeCall && activeCall.callId===newId && Object.keys(activeCall.participants).length===0){
          showToast('info', (names[targetUids[0]]||'They')+' didn\'t answer.');
          hangupCall();
        }
      }, RING_TIMEOUT_MS + 8000);
    }
    return Promise.all(targetUids.map(function(uid){ return ring(uid, fromProfile, newId, targetUids.length>1); }));
  }).catch(function(err){
    showToast('error', errMsg(err));
    if(activeCall && activeCall.callId===newId){ if(activeCall.room) activeCall.room.leave(); activeCall = null; renderCallBar(); }
  });
}

// Someone rang us - either a brand-new call, an invite into a call already
// in progress, or (per the no-call-waiting rule below) something we have to
// ignore because we're busy. Per the original spec there's no accept/
// decline step while we're online - joining the room IS answering, and
// that's still exactly what happens here for anyone currently clocked in.
//
// 2026-09-23: clocked OUT changes this - Humayun's ask was that someone who
// clocked out shouldn't have every call just barge straight in on them
// unannounced. Instead this shows a real Accept/Decline popup with a soft
// ringtone (see above) and a ~30s window; Accept does exactly what the
// always-instant path below does, Decline (or the timeout) tells the
// caller via declineRing()/'ring-missed' (see connect.js) rather than just
// silently never answering, so the caller isn't left staring at "Calling…"
// forever with no idea what happened.
function joinRingedCall(callId){
  activeCall = { callId: callId, participants:{}, pendingPullUids: [], hadOtherParticipant:false, muted:false };
  renderCallBar();
  startLocalSession().then(function(session){
    if(!activeCall || activeCall.callId!==callId){ endSession(session); return; }
    activeCall.pc = session.pc; activeCall.localStream = session.localStream; activeCall.sessionId = session.sessionId;
    wireRemoteAudio(activeCall);
    enterCallRoom(activeCall);
  }).catch(function(err){
    showToast('error', 'Could not join call: '+errMsg(err));
    if(activeCall && activeCall.callId===callId){ if(activeCall.room) activeCall.room.leave(); activeCall=null; renderCallBar(); }
  });
}
function handleIncomingRing(payload){
  var fromUid = payload.from && payload.from.id;
  var callId = payload.callId;
  if(!fromUid || !callId) return;
  if(activeCall || pendingRingCall) return; // already on a call, or already ringing on an unanswered one - no call-waiting, same as before
  if(timelog.isClockedIn()){ joinRingedCall(callId); return; }
  var myProfileForDecline = { id: myUid, name: (myProfile&&myProfile.displayName)||'' };
  function finishRing(reason){
    if(pendingRingCall && pendingRingCall.timer) clearTimeout(pendingRingCall.timer);
    pendingRingCall = null;
    hideIncomingCallPopup();
    if(reason) declineRing(fromUid, myProfileForDecline, callId, reason).catch(function(){});
  }
  pendingRingCall = { callId: callId, fromUid: fromUid, timer: setTimeout(function(){ finishRing('timeout'); }, RING_TIMEOUT_MS) };
  showIncomingCallPopup(payload.from,
    function onAccept(){ finishRing(null); joinRingedCall(callId); },
    function onDecline(reason){ finishRing(reason); }
  );
}

// The caller-side half of the 2026-09-23 accept-required-when-clocked-out
// change - the only way we ever find out a ring we sent was declined or
// went unanswered, since presence (what tells us someone ACCEPTED) simply
// never fires for either of those. Only acts on it if that call is still
// the one we're actually waiting on, and still empty - if other people
// already joined a group ring, one holdout declining shouldn't end it for
// everyone else.
function handleRingMissed(payload){
  var callId = payload.callId;
  if(!activeCall || activeCall.callId!==callId) return;
  if(Object.keys(activeCall.participants).length>0) return; // someone else is already with us - not the whole call falling through
  var name = (payload.from && payload.from.name) || 'They';
  showToast('info', name+(payload.reason==='timeout' ? ' didn\'t answer.' : ' declined the call.'));
  hangupCall();
}

// Modal: online teammates not already on the current call, to ring in.
function callPickerBody(people){
  return '<div class="field"><label>Who do you want to add?</label>'+
    people.map(function(p){
      return '<div class="check-row"><input type="checkbox" name="uids" value="'+p.id+'" id="callpick_'+p.id+'"><label for="callpick_'+p.id+'">'+escapeHtml(p.name)+'</label></div>';
    }).join('')+'</div>';
}
function getOnlineTeammates(excludeUids){
  var exclude = {}; (excludeUids||[]).forEach(function(u){ exclude[u]=true; });
  return db.collection('profiles').get().then(function(snap){
    return snap.docs.filter(function(d){ return d.id!==myUid && !exclude[d.id] && isOnline(d.id); })
      .map(function(d){ var p=d.data(); return { id:d.id, name:p.displayName||p.email }; });
  });
}
function openAddToCallModal(){
  if(!activeCall) return;
  getOnlineTeammates(Object.keys(activeCall.participants)).then(function(people){
    if(!people.length){ showToast('error','No one else is online to add.'); return; }
    openModal('Add to call', callPickerBody(people), function(fd){
      var uids = fd.getAll('uids');
      if(!uids.length){ showModalError('Pick at least one person.'); return; }
      var names = {}; people.forEach(function(p){ names[p.id]=p.name; });
      closeModal();
      startCall(uids, names);
    }, 'Add');
  }).catch(function(err){ showToast('error', errMsg(err)); });
}
function openStartGroupCallModal(){
  if(activeCall){ showToast('error','You\'re already on a call.'); return; }
  if(!connectConfigured){ showToast('error','Connect isn\'t configured yet - see README.md.'); return; }
  getOnlineTeammates([]).then(function(people){
    if(!people.length){ showToast('error','No one else is online right now.'); return; }
    openModal('Start a group Connect', callPickerBody(people), function(fd){
      var uids = fd.getAll('uids');
      if(!uids.length){ showModalError('Pick at least one person.'); return; }
      var names = {}; people.forEach(function(p){ names[p.id]=p.name; });
      closeModal();
      startCall(uids, names);
    }, 'Start call');
  }).catch(function(err){ showToast('error', errMsg(err)); });
}

// ---------- CONNECT ----------
function renderConnect(){
  paint(
    '<div class="page-head"><div><div class="eyebrow">Connect</div><h1 class="page-title">Who\'s around</h1>'+
    '<div class="page-sub">Online teammates who are clocked in connect instantly - no ringing. Someone clocked out gets a real ring they can accept or decline.</div></div>'+
    '<button type="button" class="btn btn-primary btn-sm" id="groupConnectBtn" style="width:auto;">Start a group Connect</button></div>'+
    (connectConfigured?'':'<div class="empty-state" style="margin-bottom:20px;"><strong>Connect isn\'t wired up yet</strong>This needs a Cloudflare Realtime App ID/Token - see README.md. The roster and online/offline status below already work.</div>')+
    '<div id="roster"><div class="skeleton" style="height:50px;"></div></div>'
  );
  document.getElementById('groupConnectBtn').addEventListener('click', openStartGroupCallModal);

  // Root cause of "employee doesn't see admin online" (one-directional
  // presence): this used to filter non-admins down to `.where('teamId','==',
  // myTeamId)`, which always excludes Admin - Admin's own profile has no
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
          if(!connectConfigured){ showToast('error', 'Connect isn\'t configured yet - see README.md.'); return; }
          var targetUid = btn.getAttribute('data-connect');
          var nameEl = btn.parentElement && btn.parentElement.querySelector('.roster-name');
          var name = nameEl ? nameEl.textContent : 'them';
          var names = {}; names[targetUid] = name;
          startCall([targetUid], names);
        });
      });
    }
    paintRoster();
    var offPresence = onPresenceChange(paintRoster);
    activeUnsubs.push(offPresence);
  }).catch(function(err){ showToast('error', errMsg(err)); });
}

// Shared by both places a pending-invites list is rendered (Team Settings'
// own team, Admin's across every team) - added 2026-09-23, there was
// previously no way to cancel an invite at all once created, even a
// mistyped email or one sent to the wrong role/team. Needs schema_v9.sql
// (adds the missing delete policy on `invites` - RLS denies every delete
// on that table without it, so this call would otherwise just silently
// affect zero rows).
function wireCancelInviteButtons(box){
  Array.prototype.forEach.call(box.querySelectorAll('[data-cancel-invite]'), function(btn){
    btn.addEventListener('click', function(){
      var id = btn.getAttribute('data-cancel-invite');
      var email = btn.getAttribute('data-email');
      if(!confirm('Cancel the invite for '+email+'? Its code stops working immediately - they will need a brand new invite if you change your mind.')) return;
      btn.disabled = true;
      cancelInvite(id).then(function(){ showToast('success','Invite canceled'); route(); }).catch(function(err){ btn.disabled=false; showToast('error', errMsg(err)); });
    });
  });
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

  // round 8.8/schema_v10: a teammate can hold more than one role now, so the
  // roster needs everyone's full role list (listAllRoles(), one query) -
  // not just the legacy single profiles.role column.
  Promise.all([db.collection('profiles').where('teamId','==',myTeamId).get(), listAllRoles()]).then(function(res){
    var snap = res[0], rolesByUser = res[1];
    var box = document.getElementById('rosterBox');
    box.innerHTML = snap.docs.map(function(d){
      var p = d.data();
      var roleKeys = rolesByUser[d.id] && rolesByUser[d.id].length ? rolesByUser[d.id] : (p.role?[p.role]:[]);
      var roleLabel = roleKeys.map(function(k){ var rr=roleOf(k); return rr?rr.label:k; }).join(', ') || '-';
      return '<div class="roster-row"><span class="presence-dot'+(isOnline(d.id)?' online':'')+'"></span>'+
        '<div><div class="roster-name">'+escapeHtml(p.displayName||p.email)+'</div><div class="roster-role">'+escapeHtml(roleLabel)+'</div></div></div>';
    }).join('') || '<div class="empty-state">No teammates yet - invite your first one.</div>';
  });

  listInvites(myTeamId).then(function(invites){
    var box = document.getElementById('invitesBox');
    var pending = invites.filter(function(i){ return !i.usedAt; });
    box.innerHTML = pending.length ? pending.map(function(i){
      var roleKeys = (i.roles && i.roles.length) ? i.roles : (i.role?[i.role]:[]);
      var roleLabel = roleKeys.map(function(k){ var rr=roleOf(k); return rr?rr.label:k; }).join(', ') || '-';
      return '<div class="roster-row"><div><div class="roster-name">'+escapeHtml(i.email)+'</div><div class="roster-role">'+escapeHtml(roleLabel)+' · code <span class="mono">'+escapeHtml(i.id)+'</span></div></div>'+
        '<button type="button" class="btn btn-sm btn-danger" data-cancel-invite="'+escapeHtml(i.id)+'" data-email="'+escapeHtml(i.email)+'" style="margin-left:auto;">Cancel</button></div>';
    }).join('') : '<div class="empty-state">No pending invites.</div>';
    wireCancelInviteButtons(box);
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
// code - its text isn't reliably selectable/copyable in a webview, which is
// exactly what was reported. This shows the code in a real input with a
// Copy button instead, using the clipboard API with an execCommand
// fallback for older webview builds.
function showInviteCodeModal(email, roleLabel, code){
  openModal('Invite created',
    '<div class="field"><label>Invite code for '+escapeHtml(email)+(roleLabel?' ('+escapeHtml(roleLabel)+')':'')+'</label>'+
    '<div style="display:flex;gap:8px;"><input type="text" id="inviteCodeField" value="'+escapeHtml(code)+'" readonly style="flex:1;font-family:monospace;font-size:15px;letter-spacing:.5px;"><button type="button" class="btn btn-sm" id="copyInviteBtn" style="width:auto;flex-shrink:0;">Copy</button></div></div>'+
    '<p style="font-size:12.5px;color:var(--muted);margin-top:10px;">Send this to them along with the sign-up screen - they\'ll need this exact code plus this exact email to create their account.</p>',
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
      catch(e){ showToast('error', 'Could not copy - select the code and copy it manually.'); }
    }
  });
}

// round 8.8/schema_v10: an invite can now grant more than one role at once
// (same as an existing employee's role set), so this is a checkbox group -
// same "check-row" pattern as the workflow "depends on" picker - not a
// single-value <select>, and createInvite() takes the whole checked array.
function openInviteModal(){
  var roleChecksHtml = INVITABLE_ROLES.map(function(r){
    return '<div class="check-row"><input type="checkbox" name="roles" value="'+r.key+'" id="invrole_'+r.key+'"><label for="invrole_'+r.key+'">'+escapeHtml(r.label)+'</label></div>';
  }).join('');
  openModal('Invite a teammate', '<div class="field"><label>Email</label><input required name="email" type="email" placeholder="name@bluekitemedia.com"></div>'+
    '<div class="field"><label>Role(s)</label>'+roleChecksHtml+'</div>',
    function(fd){
      var email = (fd.get('email')||'').trim();
      if(!email){ showModalError('Enter their email.'); return; }
      var roles = fd.getAll('roles');
      if(!roles.length){ showModalError('Pick at least one role.'); return; }
      setModalBusy(true);
      var roleLabel = INVITABLE_ROLES.filter(function(r){ return roles.indexOf(r.key)>-1; }).map(function(r){return r.label;}).join(', ');
      createInvite(email, roles, myTeamId, myUid).then(function(invite){
        showInviteCodeModal(email, roleLabel, invite.id);
        route();
      }).catch(function(err){ showModalError(errMsg(err)); });
    }, 'Create invite');
}

// Admin-only: same idea as openInviteModal above, but Admin isn't scoped to
// one Team, so this one also asks which Team and allows Manager as a role
// (a Manager, per RLS, can never invite someone in as 'manager' - only
// Admin can, which is exactly what this modal is for). Also a checkbox
// group (round 8.8/schema_v10) so Admin can grant, say, Manager + a
// job-title role to the same invite at once.
function openAdminInviteModal(){
  var roleChecksHtml = ASSIGNABLE_ROLES.map(function(r){
    return '<div class="check-row"><input type="checkbox" name="roles" value="'+r.key+'" id="adminvrole_'+r.key+'"><label for="adminvrole_'+r.key+'">'+escapeHtml(r.label)+'</label></div>';
  }).join('');
  openModal('Invite someone', '<div class="field"><label>Email</label><input required name="email" type="email" placeholder="name@bluekitemedia.com"></div>'+
    '<div class="field-row"><div class="field"><label>Role(s)</label>'+roleChecksHtml+'</div>'+
    '<div class="field"><label>Team</label><select name="teamId" required>'+teamOptionsHtml()+'</select></div></div>',
    function(fd){
      var email = (fd.get('email')||'').trim();
      if(!email){ showModalError('Enter their email.'); return; }
      var roles = fd.getAll('roles');
      if(!roles.length){ showModalError('Pick at least one role.'); return; }
      setModalBusy(true);
      var roleLabel = ASSIGNABLE_ROLES.filter(function(r){ return roles.indexOf(r.key)>-1; }).map(function(r){return r.label;}).join(', ');
      createInvite(email, roles, fd.get('teamId'), myUid).then(function(invite){
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
    '<div class="section"><div class="section-head"><h2 class="section-title">All employees</h2><button type="button" class="btn btn-sm" id="adminInviteBtn">+ Invite someone</button></div>'+
    '<div class="page-sub" style="margin:-6px 0 12px;">Change anyone\'s role or team here - this is also how you move someone off a team they\'re stuck on, or make more than one person a Manager on the same team.</div>'+
    '<div id="employeesBox"><div class="skeleton" style="height:80px;"></div></div></div>'+
    '<div class="section"><div class="section-head"><h2 class="section-title">Pending invites</h2></div>'+
    '<div class="page-sub" style="margin:-6px 0 12px;">Across every team - this used to only be visible from a Manager\'s own Team page.</div>'+
    '<div id="allInvitesBox"><div class="skeleton" style="height:40px;"></div></div></div>'+
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
  document.getElementById('adminInviteBtn').addEventListener('click', openAdminInviteModal);

  // Ported over from the Manager's Team Settings page (renderTeamSettings) -
  // that page only ever showed a Manager their OWN team's pending invites,
  // and Admin had no equivalent view at all across any team. listInvites()
  // with no teamId returns every invite (see src/lib/teams.js).
  listInvites().then(function(invites){
    var box = document.getElementById('allInvitesBox');
    if(!box) return;
    var pending = invites.filter(function(i){ return !i.usedAt; });
    box.innerHTML = pending.length ? pending.map(function(i){
      var roleKeys = (i.roles && i.roles.length) ? i.roles : (i.role?[i.role]:[]);
      var roleLabel = roleKeys.map(function(k){ var rr=roleOf(k); return rr?rr.label:k; }).join(', ') || '-';
      return '<div class="roster-row"><div><div class="roster-name">'+escapeHtml(i.email)+'</div><div class="roster-role">'+escapeHtml(roleLabel)+' · '+escapeHtml(teamName(i.teamId))+' · code <span class="mono">'+escapeHtml(i.id)+'</span></div></div>'+
        '<button type="button" class="btn btn-sm btn-danger" data-cancel-invite="'+escapeHtml(i.id)+'" data-email="'+escapeHtml(i.email)+'" style="margin-left:auto;">Cancel</button></div>';
    }).join('') : '<div class="empty-state">No pending invites.</div>';
    wireCancelInviteButtons(box);
  }).catch(function(){ var b=document.getElementById('allInvitesBox'); if(b) b.innerHTML = '<div class="empty-state">Could not load invites.</div>'; });

  // round 8.8/schema_v10: listAllRoles() gives every employee's full role
  // set in one query ({ [userId]: ['role1','role2',...] }) - every spot
  // below that used to check the legacy single profiles.role column
  // (admin-label, "actual managers", All employees roster/filter) now
  // checks this map instead, so someone holding Manager AND a job-title
  // role (or Admin AND anything else) is recognized correctly everywhere.
  Promise.all([listTeams(), db.collection('profiles').get(), listAllRoles()]).then(function(res){
    var teams = res[0].slice().sort(function(a,b){ return (a.name||'').localeCompare(b.name||''); });
    var profiles = res[1].docs.map(function(d){ return Object.assign({id:d.id}, d.data()); });
    var rolesByUser = res[2];
    function empRoles(uid){ var r = rolesByUser[uid]; return (r && r.length) ? r : []; }
    function empHasRole(uid, role){ return empRoles(uid).indexOf(role)>-1; }
    var box = document.getElementById('teamsBox');
    // Anyone (including Admin) who's picked here as a team's Manager/point
    // of contact - but an Admin picked here keeps their Admin role as-is
    // (they already have full access everywhere; this just labels them as
    // this team's contact). A non-admin picked here is actually promoted:
    // role becomes 'manager' with this teamId, same as before. Multiple
    // people can hold 'manager' on the same team at once - RLS only ever
    // checks role+teamId, never this single managerId field, so this was
    // already technically possible; "Managers" below just makes it visible.
    box.innerHTML = teams.map(function(t){
      var manager = profiles.filter(function(p){ return p.id===t.managerId; })[0];
      var actualManagers = profiles.filter(function(p){ return empHasRole(p.id,'manager') && p.teamId===t.id; });
      var memberOpts = profiles.map(function(p){ return '<option value="'+p.id+'"'+(p.id===t.managerId?' selected':'')+'>'+escapeHtml(p.displayName||p.email)+(empHasRole(p.id,'admin')?' (Admin)':(p.teamId?' ('+escapeHtml(teamName(p.teamId))+')':''))+'</option>'; }).join('');
      var teamServices = servicesCache.filter(function(s){ return s.teamId===t.id; });
      return '<div class="panel" style="margin-bottom:12px;"><h3>'+escapeHtml(t.name)+'</h3>'+
        '<div style="font-size:13px;color:var(--muted);margin-bottom:4px;">Point of contact: '+(manager?escapeHtml(manager.displayName||manager.email):'- none assigned -')+'</div>'+
        '<div style="font-size:13px;color:var(--muted);margin-bottom:10px;">Managers on this team: '+(actualManagers.length?actualManagers.map(function(m){return escapeHtml(m.displayName||m.email);}).join(', '):'- none yet -')+'</div>'+
        '<div class="field-row"><div class="field"><label>Assign/change point of contact (promotes a non-admin to Manager)</label><select data-assign-mgr="'+t.id+'"><option value="">(no point of contact)</option>'+memberOpts+'</select></div>'+
        '<div class="field"><label>Or invite a new Manager by email</label><input type="email" placeholder="name@bluekitemedia.com" data-invite-mgr="'+t.id+'"></div></div>'+
        '<div style="margin-top:10px;"><label style="font-size:12px;color:var(--muted);display:block;margin-bottom:4px;">This team\'s services</label>'+
        (teamServices.length ? teamServices.map(function(s){ return '<span class="tag">'+escapeHtml(s.name)+' <button type="button" class="tag-remove" data-del-svc="'+s.id+'">✕</button></span>'; }).join('') : '<span style="font-size:12.5px;color:var(--muted);">None yet.</span>')+
        '</div></div>';
    }).join('') || '<div class="empty-state">No teams yet - create your first one.</div>';
    // Same delete handler the "Global services" section below uses -
    // team-scoped services created for any team (via the scope picker in
    // "+ New service type") now show up and can be removed from here too,
    // not just from that one team's own Manager-facing Team page.
    Array.prototype.forEach.call(box.querySelectorAll('[data-del-svc]'), function(btn){
      btn.addEventListener('click', function(){
        if(!confirm('Delete this service from the vocabulary?')) return;
        deleteService(btn.getAttribute('data-del-svc')).then(function(){ refreshServicesCache().then(route); }).catch(function(err){ showToast('error', errMsg(err)); });
      });
    });

    Array.prototype.forEach.call(box.querySelectorAll('[data-assign-mgr]'), function(sel){
      sel.addEventListener('change', function(){
        var teamId = sel.getAttribute('data-assign-mgr');
        // "(no point of contact)" is a real, selectable choice now, not just
        // an inert placeholder - picking it clears the team's point of
        // contact without demoting whoever currently holds the 'manager'
        // role there (a team can have Managers and no designated point of
        // contact at the same time; those are two separate things).
        if(!sel.value){
          clearTeamManager(teamId).then(function(){ showToast('success', 'Point of contact cleared'); refreshTeamsCache().then(route); }).catch(function(err){ showToast('error', errMsg(err)); });
          return;
        }
        var picked = profiles.filter(function(p){ return p.id===sel.value; })[0];
        var pickedIsAdmin = picked && empHasRole(picked.id,'admin');
        var task = pickedIsAdmin
          // Admin picked: just point teams.managerId at them for display -
          // never touch an Admin's own role/team.
          ? db.doc('teams/'+teamId).update({managerId: sel.value})
          : assignTeamManager(teamId, sel.value);
        task.then(function(){ showToast('success', pickedIsAdmin ? 'Set as point of contact' : 'Manager assigned'); refreshTeamsCache().then(route); }).catch(function(err){ showToast('error', errMsg(err)); });
      });
    });
    Array.prototype.forEach.call(box.querySelectorAll('[data-invite-mgr]'), function(input){
      input.addEventListener('keydown', function(ev){
        if(ev.key!=='Enter') return;
        ev.preventDefault();
        var email = input.value.trim();
        if(!email) return;
        createInvite(email, ['manager'], input.getAttribute('data-invite-mgr'), myUid).then(function(invite){
          input.value='';
          showInviteCodeModal(email, 'Manager', invite.id);
          route();
        }).catch(function(err){ showToast('error', errMsg(err)); });
      });
    });

    // ---- All employees: change anyone's role(s) and/or team ----
    // round 8.8/schema_v10: the single Role <select> is now a multi-select
    // checkbox group (same "pick several" pattern as the invite modals
    // above) wired to assignRoles(uid, roles) - the diff-based writer in
    // teams.js - instead of overwriting the legacy profiles.role column
    // directly. empHasRole()/empRoles() come from listAllRoles() (see the
    // Promise.all above), not the single p.role field.
    var empBox = document.getElementById('employeesBox');
    var employees = profiles.filter(function(p){ return !empHasRole(p.id,'admin'); }).sort(function(a,b){ return (a.displayName||a.email||'').localeCompare(b.displayName||b.email||''); });
    empBox.innerHTML = employees.length ? '<div class="roster-table">'+employees.map(function(p){
      var roleChecksHtml = ASSIGNABLE_ROLES.map(function(r){
        var checked = empHasRole(p.id, r.key);
        return '<label style="display:flex;align-items:center;gap:4px;font-size:12px;white-space:nowrap;"><input type="checkbox" value="'+r.key+'" '+(checked?'checked':'')+' style="width:14px;height:14px;">'+escapeHtml(r.label)+'</label>';
      }).join('');
      return '<div class="roster-row" style="justify-content:space-between;align-items:flex-start;">'+
        '<span class="presence-dot'+(isOnline(p.id)?' online':'')+'" style="margin-top:4px;"></span>'+
        '<div style="min-width:0;flex:1;"><div class="roster-name">'+escapeHtml(p.displayName||p.email)+'</div><div class="roster-role">'+escapeHtml(p.email)+'</div></div>'+
        '<div class="field-row" style="flex:none;gap:8px;align-items:flex-start;">'+
        '<div data-emp-roles="'+p.id+'" style="display:flex;flex-wrap:wrap;gap:4px 10px;max-width:220px;">'+roleChecksHtml+'</div>'+
        '<select data-emp-team="'+p.id+'" style="width:auto;">'+teamOptionsHtml(p.teamId, true)+'</select>'+
        '</div></div>';
    }).join('')+'</div>' : '<div class="empty-state">No employees yet - invite your first one.</div>';

    function saveEmployeeField(uid, patch){
      db.doc('profiles/'+uid).update(patch).then(function(){ showToast('success','Updated'); }).catch(function(err){ showToast('error', errMsg(err)); });
    }
    Array.prototype.forEach.call(empBox.querySelectorAll('[data-emp-roles]'), function(rolesBox){
      var uid = rolesBox.getAttribute('data-emp-roles');
      Array.prototype.forEach.call(rolesBox.querySelectorAll('input[type=checkbox]'), function(cb){
        cb.addEventListener('change', function(){
          var checked = Array.prototype.filter.call(rolesBox.querySelectorAll('input[type=checkbox]'), function(c){ return c.checked; }).map(function(c){ return c.value; });
          if(!checked.length){ cb.checked = true; showToast('error','Must keep at least one role.'); return; }
          assignRoles(uid, checked).then(function(){ showToast('success','Updated'); }).catch(function(err){ cb.checked = !cb.checked; showToast('error', errMsg(err)); });
        });
      });
    });
    Array.prototype.forEach.call(empBox.querySelectorAll('[data-emp-team]'), function(sel){
      sel.addEventListener('change', function(){ saveEmployeeField(sel.getAttribute('data-emp-team'), {teamId: sel.value||null}); });
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
    '<div class="login-sub">'+(isSignup?'You\'ll need the invite code your manager or admin sent you - unless you\'re the very first person setting this up.':'Use your Blue Kite Ops account.')+'</div>'+
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
        if(!ok){ hint.textContent = 'No face detected - please choose a clear photo of yourself.'; pendingAvatarBlob=null; return; }
        return compressImage(file, {maxWidth:400,maxHeight:400,quality:.85}).then(function(blob){
          pendingAvatarBlob = blob;
          var url = URL.createObjectURL(blob);
          avatarDrop.innerHTML = '<img src="'+url+'"><div class="avatar-drop-hint">Looks good - click to change</div>';
          avatarDrop.appendChild(avatarInput);
        });
      }).catch(function(){ hint.textContent = 'Could not check this photo - click to try another.'; });
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
        // both down with it and the error never surfaced anywhere - just a
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

// ---------- PERSISTENT CLOCK CONTROL ----------
// Previously only lived on the TimeLog page itself - clocking out required
// navigating there first, which is exactly the friction Humayun asked to
// remove. This one control backs both the TimeLog page's own badge AND a
// fixed, always-visible badge (added to document.body once at sign-in,
// alongside connectBar/clockinOverlay's existing pattern of body-level
// elements that survive page navigation), so either one can be clicked and
// both - plus the TimeLog page's session list, if it's the one open right
// now - stay in sync.
function toggleClock(){
  if(timelog.isClockedIn()) timelog.clockOut().then(updateClockUI).catch(function(err){ showToast('error', errMsg(err)); });
  else timelog.clockIn(myUid).then(updateClockUI).catch(function(err){ showToast('error', errMsg(err)); });
}
function updateClockUI(){
  var clockedIn = timelog.isClockedIn();
  var label = clockedIn ? '● Clocked in - stop' : 'Clock in';
  var badge = document.getElementById('globalClockBadge');
  if(badge){ badge.classList.toggle('off', !clockedIn); badge.textContent = label; }
  var pageBtn = document.getElementById('clockToggleBtn');
  if(pageBtn){ pageBtn.classList.toggle('off', !clockedIn); pageBtn.textContent = label; }
  // Refresh the TimeLog page's own session list immediately if it's open,
  // rather than only after the next manual reload.
  if(location.hash.replace(/^#/,'')==='/timelog') route();
}
function ensureGlobalClockBadge(){
  if(document.getElementById('globalClockBadge')) { updateClockUI(); return; }
  var btn = document.createElement('button');
  btn.type = 'button';
  btn.id = 'globalClockBadge';
  btn.className = 'timelog-badge global-clock-badge';
  btn.addEventListener('click', toggleClock);
  document.body.appendChild(btn);
  updateClockUI();
}
function removeGlobalClockBadge(){
  var badge = document.getElementById('globalClockBadge');
  if(badge) badge.remove();
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
    '<div class="clockin-sub">Clocking in starts your hourly timer. While you\'re clocked in, Blue Kite Ops takes occasional screenshots and tracks keyboard/mouse activity - you can review your own history under TimeLog any time.</div>'+
    '<button type="button" class="btn btn-primary" id="clockinStartBtn">Clock in</button>'+
    '<div id="clockinStatus"></div>'+
    '</div>';
  document.body.appendChild(el);
  document.getElementById('clockinCloseBtn').addEventListener('click', function(){ el.remove(); });
  document.getElementById('clockinStartBtn').addEventListener('click', function(){
    timelog.clockIn(myUid).then(function(){
      updateClockUI();
      document.getElementById('clockinStatus').innerHTML = '<div class="clockin-status"><span class="pulse-dot"></span> Clocked in - you can close this.</div>';
      setTimeout(function(){ el.remove(); }, 1400);
    }).catch(function(err){ showToast('error', errMsg(err)); });
  });
}

// Idle detector force-pause warning (2026-09-21) - see
// src/lib/timelog.js's setIdleWarningHandler for the detection side. Kept
// visually distinct from the clock-in overlay (red-tinted, no close button)
// since dismissing it shouldn't be as easy as the clock-in prompt - the
// entire point is that not responding actually does something (auto clock-
// out), so it can't be a silent little toast easy to miss.
function showIdleWarningOverlay(secondsRemaining){
  var el = document.getElementById('idleWarningOverlay');
  if(!el){
    el = document.createElement('div');
    el.id = 'idleWarningOverlay';
    el.className = 'clockin-overlay idle-warning-overlay';
    el.innerHTML = '<div class="clockin-card">'+
      '<div class="clockin-icon">⏸</div>'+
      '<div class="clockin-title">Still there?</div>'+
      '<div class="clockin-sub">No activity has been seen for a while. You\'ll be automatically clocked out in <b id="idleWarningSeconds"></b> unless you move your mouse or press a key.</div>'+
      '<button type="button" class="btn btn-primary" id="idleWarningDismissBtn">I\'m still here</button>'+
      '</div>';
    document.body.appendChild(el);
    // The click itself already resets the idle timer (the same global
    // keyboard/mouse hook that detects idling also sees this click) - this
    // button just gives an obvious, reassuring thing to click instead of
    // silently waving the mouse around and hoping it registered.
    document.getElementById('idleWarningDismissBtn').addEventListener('click', function(){ el.remove(); });
  }
  var secEl = document.getElementById('idleWarningSeconds');
  if(secEl) secEl.textContent = secondsRemaining+'s';
}
function hideIdleWarningOverlay(){
  var el = document.getElementById('idleWarningOverlay');
  if(el) el.remove();
}

// ---------- BOOT ----------
(function boot(){
  initTheme();
  // See src/lib/timelog.js - screenshot/activity capture failures used to
  // be swallowed silently (console.warn at best), which is exactly why
  // testing showed no visible symptom at all. Now they surface as a toast.
  timelog.setCaptureErrorHandler(function(message){ showToast('error', message); });
  timelog.setScreenshotTakenHandler(function(){ showScreenshotNotice(); });
  // See src/lib/timelog.js + schema_v6.sql: a session left open by a
  // force-kill/uninstall gets auto-closed the next time the app opens,
  // instead of silently being resumed as if nothing happened - this is
  // what tells the person that actually occurred, so "why am I being asked
  // to clock in again?" has an obvious answer instead of being a mystery.
  timelog.setSessionAutoClosedHandler(function(lastSeenAt){
    showToast('info', 'Your last clock-in wasn\'t closed properly (the app likely closed or crashed while you were clocked in) - it\'s been ended as of '+new Date(lastSeenAt).toLocaleString()+'. Go ahead and clock in again.');
  });
  // Idle detector force-pause - see src/lib/timelog.js.
  timelog.setIdleWarningHandler(function(secondsRemaining){ showIdleWarningOverlay(secondsRemaining); });
  timelog.setIdleClearedHandler(function(){ hideIdleWarningOverlay(); });
  timelog.setIdleForcePausedHandler(function(lastActiveAt){
    hideIdleWarningOverlay();
    updateClockUI();
    showToast('info', 'Clocked out after being idle since '+new Date(lastActiveAt).toLocaleString()+'. Clock back in whenever you\'re ready.');
  });
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
  // A plain full reload - the simplest fix for the case where something
  // changed in a table Realtime doesn't push (e.g. an Admin moves a client
  // or an employee to a different Team: that's a write to `clients`/
  // `profiles`, not to `tasks`, so a task list already subscribed elsewhere
  // has no live signal to refetch against). Everyone re-subscribes fresh on
  // reload, so this always picks up permission/team changes immediately.
  var reloadBtn = document.getElementById('reloadBtn');
  if(reloadBtn) reloadBtn.addEventListener('click', function(){ location.reload(); });

  var boundOnce = false;
  var lastUid = null;

  onAuthStateChange(function(session){
    if(!session){
      clearSubs();
      if(profileUnsub){ profileUnsub(); profileUnsub = null; }
      myUid = null; myRole = null; myRoles = []; myProfile = null; myTeamId = null; lastUid = null; boundOnce = false;
      stopPresence();
      hangupCall();
      if(pendingRingCall){ if(pendingRingCall.timer) clearTimeout(pendingRingCall.timer); pendingRingCall = null; }
      hideIncomingCallPopup();
      removeGlobalClockBadge();
      navBackStack = []; navSkipPush = false; navCurrentHash = null;
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
        myTeamId = p ? p.teamId : null;
        // myRoles (round 8.7/schema_v10): the profile doc's own onSnapshot
        // doesn't carry profileRoles rows (a separate table), so those are
        // fetched here every time the profile itself changes - cheap (one
        // small query, one row per role this one person holds) and it means
        // an Admin granting/revoking a role updates this person's own
        // access immediately via the realtime subscription that already
        // re-fires this whole callback on ANY profiles row write, without
        // needing a second live subscription on profileRoles just for this.
        (p ? listRolesFor(myUid) : Promise.resolve([])).then(function(roles){
        myRoles = roles.length ? roles : (p && p.role ? [p.role] : []);
        myRole = myRoles.length ? myRoles[0] : null; // legacy fallback, kept in sync - see myRoles' own comment above
        document.getElementById('navAddClient').hidden = !canManage();
        // 2026-09-21: Admin used to also see this "Team" link, redirected
        // to point at #/admin - but that made it a second nav item leading
        // to the exact same place as "Admin" right below it. Now that Admin
        // has every capability Team Settings had (roster with presence,
        // pending invites across every team, and each team's own services -
        // see renderAdmin), there's nothing left for Admin to reach here
        // that "Admin" doesn't already cover, so this is Manager-only again
        // and always points at their own Team page.
        var teamNav = document.getElementById('navTeam');
        if(teamNav){
          teamNav.hidden = !isManager();
          teamNav.setAttribute('href', '#/team');
        }
        var adminNav = document.getElementById('navAdmin'); if(adminNav) adminNav.hidden = !isAdmin();
        var workflowsNav = document.getElementById('navWorkflows'); if(workflowsNav) workflowsNav.hidden = !canManage();
        renderIdentityCard();
        Promise.all([refreshTeamsCache(), refreshServicesCache()]).then(route);
        if(wasFirstLoad && p){
          startPresence(myUid, { displayName: p.displayName });
          listenForConnects(myUid, { onRing: handleIncomingRing, onRingMissed: handleRingMissed });
          if(p.musicMood && p.musicMood!=='none'){ mountMusicPlayer(); musicPlayer.initPlayer('ytMusicMount', p.musicMood); }
          // Reconnect to an already-open clock-in (e.g. after a reload)
          // before ever deciding whether to show the "ready to start your
          // day?" prompt - showing that prompt to someone who's already
          // clocked in was the visible symptom of the reload/clock-out
          // desync bug (a reload used to silently stop capture without
          // actually clocking anyone out server-side).
          timelog.resumeIfClockedIn(myUid).then(function(){
            ensureGlobalClockBadge();
            if(!timelog.isClockedIn()) setTimeout(showClockInOverlay, 600);
          });
        }
        }); // end listRolesFor(...).then - myRoles block
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
        '<div class="music-meta" id="musicMeta">-</div>'+
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
    if(!meta) return; // widget got torn down (e.g. sign-out) - nothing to update
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
