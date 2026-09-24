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
import * as meetingsLib from './lib/meetings.js';
import { MeetingRecorder, getRecordingsFolder, setRecordingsFolder, pickRecordingsFolder, revealInFolder } from './lib/recorder.js';

// ---------- constants ----------
// Roles used to be this exact array, hardcoded - Phase 3 ("fully dynamic
// role system: Admin can create/rename/delete roles from the Admin panel,
// no code changes needed for future roster changes", design confirmed
// 2026-09-21) replaces it with a live-loaded cache off the new `roles`
// table (schema_v15.sql), same "empty until refreshRolesCache() resolves
// once at boot, refreshed again after any mutation" pattern already used
// for teamsCache/servicesCache just below. Admin and Manager are seeded
// rows in that table too (for one consistent label/color source across
// every role, admin-editable or not) but the Admin panel's own UI never
// offers to edit or delete those two specifically - see renderAdmin's
// roles section.
var ROLES = [];
var INVITABLE_ROLES = [];
// Everything an Admin can hand out to an existing employee or a fresh
// invite, short of the (single, effectively-permanent) Admin role itself -
// this is what lets multiple people share 'manager' on the same team, since
// it's just a per-person role+team assignment, not a one-slot field.
var ASSIGNABLE_ROLES = [];
var CLIENT_COLORS = ['#2f8fd1','#3f6b8a','#7a5ea8','#4f8f6b','#b8567a','#a15c2f'];
var WEEKDAY_NAMES = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

function roleOf(key){ for(var i=0;i<ROLES.length;i++){ if(ROLES[i].key===key) return ROLES[i]; } return null; }
// ---------- ROLES ACROSS TEAMS (round 26, corrected round 28) ----------
// Round 26 made roles.teamId HIDE a role from every other Team's dropdowns
// - wrong call, and a real regression Humayun reported ("the already
// created roles just got erased"). The actual design he wants: role LABELS
// (Outreach Expert/VA, SEO Specialist, etc.) are shared across every Team -
// the same name, held by different people on different Teams - but holding
// a role on Team A must never grant any access to Team B's stuff, and vice
// versa. That isolation was ALREADY fully handled independently of roles:
// every task/episode/client is Team-scoped at the RLS level itself (see
// public.task_team()/current_team() in schema_v2.sql) - a Team B person
// literally cannot query a Team A task regardless of what role they hold.
// The one real gap was notifyRoleAssignment() pinging a role's holders
// company-wide - fixed there (it now only notifies holders on the SAME
// Team as the task). So: every job-title role is visible/assignable for
// EVERY Team again, same as before round 26 - roles.teamId (schema_v24.sql)
// is kept as an optional label for Admin's own reference (e.g. "this one's
// really just for Team B"), but nothing hides on it anymore.
function jobTitleRoles(){ return ROLES.filter(function(r){ return r.key!=='manager' && r.key!=='admin'; }); }
function rolesForTeam(){ return jobTitleRoles(); }
// A checklist item (this app's own "task") can be assigned to Manager too,
// not just a job-title role (2026-09-30, Humayun's ask) - a Manager can be
// the actual doer of a step, not only an overseer. Admin stays excluded
// (never asked for, and Admin isn't scoped to a Team anyway). Used
// wherever a template step or a custom task picks WHO does the work;
// rolesForTeam() alone is still what employee-role-assignment/invites use,
// since holding "Manager" as an assignable-work role isn't the same thing
// as actually being promoted to the Manager tier.
function assignableTaskRoles(teamId){
  var mgr = ROLES.filter(function(r){ return r.key==='manager'; });
  return mgr.concat(rolesForTeam(teamId));
}
// A workflow step (and the task generated from it) can be done by more
// than one role now (2026-09-30, Humayun's ask) - e.g. either a Sr. or Jr.
// Video Editor can pick up the same step. Same backward-compatible-array
// pattern already used for step dependencies just below (stepDepIds()/
// taskDepStepIds()): a new plural array field, falling back to the old
// singular field for anything created before this - nothing already
// stored needs to change. `role`/`t.role` are still kept in sync (set to
// the FIRST picked role) purely so anything not yet updated to read the
// plural field - a CSS var lookup, a notification, an old query - still
// gets a sane single answer instead of breaking.
function stepRoleKeys(step){
  if(step && step.roles && step.roles.length) return step.roles;
  if(step && step.role) return [step.role];
  return [];
}
function taskRoleKeys(t){
  if(t && t.roles && t.roles.length) return t.roles;
  if(t && t.role) return [t.role];
  return [];
}
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
// Highlights "@Full Name" in an already-escaped+linkified comment body with
// a light background, like every modern chat app (Slack/Discord/Teams) -
// operates on the real mentioned-id list (the comment's own `mentions`
// column), not a guess from the text, so it only highlights people who
// were actually notified. `nameOf(uid)` is the caller's own uid->display-
// name lookup (renderComment's `who()`, or getMentionRoster()'s map).
function mentionifyHtml(html, mentionedIds, nameOf){
  if(!mentionedIds || !mentionedIds.length) return html;
  mentionedIds.forEach(function(uid){
    var name = nameOf(uid);
    if(!name || name==='Someone') return;
    var esc = escapeHtml('@'+name);
    var pattern = esc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    html = html.replace(new RegExp(pattern, 'g'), '<span class="mention-highlight">'+esc+'</span>');
  });
  return html;
}
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
// Phase 2.5 batch B: the deadline (dueDate) is now computed as the publish
// date minus a configurable number of days, not the same date - see
// generateEpisodesForRule and openAddOneOffEpisodeModal.
function addDaysISO(iso, days){ var p=iso.split('-'); var d=new Date(+p[0],+p[1]-1,+p[2]); d.setDate(d.getDate()+(days||0)); return isoDate(d); }
function fmtDate(iso){ if(!iso) return ''; var p=iso.split('-'); var d=new Date(+p[0],+p[1]-1,+p[2]); return d.toLocaleDateString(undefined,{month:'short',day:'numeric'}); }
function fmtDateFull(iso){ if(!iso) return ''; var p=iso.split('-'); var d=new Date(+p[0],+p[1]-1,+p[2]); return d.toLocaleDateString(undefined,{weekday:'long',month:'long',day:'numeric',year:'numeric'}); }
function fmtDateTime(iso){ if(!iso) return ''; var d=new Date(iso); return d.toLocaleDateString(undefined,{month:'short',day:'numeric'})+' · '+d.toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'}); }
// Time only, no date - the hover-reveal gutter timestamp on a "grouped"
// chat message (round 12) that already sits right under its own group's
// full author+date header, so repeating the date would be redundant.
function fmtTimeShort(iso){ if(!iso) return ''; var d=new Date(iso); return d.toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'}); }
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
// Native title bar sync (2026-09-30): decorations aren't disabled (no
// custom title bar exists), so the title bar is drawn by Windows itself -
// by default it stays whatever the OS's own theme is, light or dark,
// regardless of the in-app toggle. setTheme() asks Tauri to tell Windows
// to draw ITS chrome (title bar background/text/min-max-close glyphs) to
// match, so it actually looks seamless against a dark app body instead of
// a light bar sitting on top of a dark page. Lazily imported/cached like
// wireCloseConfirmation's own appWindow - a no-op outside the Tauri shell
// (e.g. `npm run dev` in a plain browser tab).
var nativeWindowRef = null;
function getNativeWindow(){
  if(nativeWindowRef) return Promise.resolve(nativeWindowRef);
  return import('@tauri-apps/api/window').then(function(mod){
    nativeWindowRef = mod.getCurrentWindow();
    return nativeWindowRef;
  }).catch(function(){ return null; });
}
function syncNativeTitleBarTheme(mode){
  getNativeWindow().then(function(win){
    if(!win) return;
    var theme = (mode==='light' || mode==='dark') ? mode : null; // null = follow the OS, same as the app body's own CSS media query
    win.setTheme(theme).catch(function(){});
  });
}
function applyTheme(mode){
  var root = document.documentElement;
  if(mode==='light' || mode==='dark') root.setAttribute('data-theme', mode);
  else root.removeAttribute('data-theme');
  try{ localStorage.setItem('bko_theme', mode||''); }catch(e){}
  syncNativeTitleBarTheme(mode);
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
// Set by showToast() whenever an "Undo" action toast is showing, so
// Ctrl/Cmd+Z (wired further down, near the other app-wide keyboard
// shortcuts) can trigger the same reversal a click on the button would.
var pendingUndoTrigger = null;
function showToast(type, message, opts){
  opts = opts || {};
  var root = document.getElementById('toastRoot');
  var el = document.createElement('div');
  el.className = 'toast '+(type||'');
  var msgEl = document.createElement('span');
  msgEl.className = 'toast-msg';
  msgEl.textContent = message;
  el.appendChild(msgEl);
  function dismiss(){
    el.classList.add('leaving');
    setTimeout(function(){ if(el.parentNode) el.parentNode.removeChild(el); }, 200);
  }
  if(opts.actionLabel && opts.onAction){
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toast-action';
    btn.textContent = opts.actionLabel;
    function trigger(){ opts.onAction(); dismiss(); if(pendingUndoTrigger===trigger) pendingUndoTrigger=null; }
    btn.addEventListener('click', trigger);
    el.appendChild(btn);
    // Ctrl/Cmd+Z for the Undo toast specifically (2026-09-28, asked for
    // after shipping the click-only version) - only the most recent
    // undo-able toast is reachable this way, matching there only ever
    // being one Undo button visible at a time in practice. Cleared the
    // moment it's used, dismissed, or its own window naturally expires -
    // see the global keydown listener below.
    if(opts.actionLabel==='Undo'){
      pendingUndoTrigger = trigger;
      setTimeout(function(){ if(pendingUndoTrigger===trigger) pendingUndoTrigger=null; }, opts.duration||3400);
    }
  }
  root.appendChild(el);
  setTimeout(dismiss, opts.duration||3400);
}

// Undo toast for destructive actions (Phase 2.5 batch D, item #7: "a brief
// toast with an Undo button appears right after a destructive/consequential
// action" - Humayun's confirmed scope, 2026-09-26).
//
// REVISED 2026-09-28 (Humayun, after testing round 12): the first version
// DELAYED the actual write for 6 seconds so Undo could just mean "never
// run it" - correct by construction, but it made every delete genuinely
// FEEL slow (nothing visibly happened until the delay passed), which is a
// worse trade than the problem it solved. Flipped around: the caller
// performs the write IMMEDIATELY (no delay at all - same speed as any
// other action in this app) and passes `undoFn`, a compensating write
// built from data snapshotted right before deleting (re-insert the row(s),
// or restore a previous field value) - Undo now means "reverse what
// happened," not "it never happened." For a single row this is trivial;
// for something that cascades (an episode takes its tasks down with it, a
// client takes everything down with it - see schema.sql's "on delete
// cascade" foreign keys) the caller fetches the full subtree BEFORE
// deleting and re-inserts all of it, parents first, if Undo is clicked -
// see deleteEpisodeWithUndo()/deleteClientWithUndo() below for the two
// deep cases (restoreSnapshot() is the shared "write these rows back,
// wave by wave" helper both use); everything else here just needs the one
// row it already had in hand from the page's own render data.
var UNDO_WINDOW_MS = 6000;
function actionWithUndo(message, undoFn){
  showToast('success', message, {
    duration: UNDO_WINDOW_MS,
    actionLabel: 'Undo',
    onAction: function(){ undoFn(); showToast('info', 'Undone'); }
  });
}
// Restores a snapshot taken before a cascading delete, respecting foreign
// key order: `waves` is an array of batches ({col,id,data} rows), each
// batch written in parallel via db.doc(col/id).set(data), one batch fully
// finishing before the next starts - e.g. [ [client], [templates, rules,
// episodes], [tasks], [comments/links/attachments] ] so a child row is
// never written before the parent it references exists yet.
function restoreSnapshot(waves){
  return waves.reduce(function(p, wave){
    return p.then(function(){
      return Promise.all(wave.map(function(row){ return db.doc(row.col+'/'+row.id).set(row.data); }));
    });
  }, Promise.resolve());
}
function tuples(col, docs){ return docs.map(function(d){ return {col:col, id:d.id, data:d.data()}; }); }

// Deletes an episode (and everything under it) with a real undo - snapshots
// the episode, its tasks, and every comment/link/attachment on either the
// episode itself or any of its tasks BEFORE deleting, so Undo can write it
// all back. Navigates to the client page immediately either way, same as
// before - there's nothing left to look at once the episode's gone.
function deleteEpisodeWithUndo(episodeId, title, clientId){
  Promise.all([
    db.doc('episodes/'+episodeId).get(),
    db.collection('tasks').where('episodeId','==',episodeId).get(),
    db.collection('episodeComments').where('episodeId','==',episodeId).get(),
    db.collection('episodeLinks').where('episodeId','==',episodeId).get(),
    db.collection('episodeAttachments').where('episodeId','==',episodeId).get(),
  ]).then(function(res){
    var episodeData = res[0].data();
    var tasks = tuples('tasks', res[1].docs);
    var epChildren = tuples('episodeComments', res[2].docs).concat(tuples('episodeLinks', res[3].docs)).concat(tuples('episodeAttachments', res[4].docs));
    var taskIds = tasks.map(function(t){ return t.id; });
    return Promise.all([
      taskIds.length ? db.collection('taskComments').where('taskId','in',taskIds).get() : Promise.resolve({docs:[]}),
      taskIds.length ? db.collection('taskLinks').where('taskId','in',taskIds).get() : Promise.resolve({docs:[]}),
      taskIds.length ? db.collection('taskAttachments').where('taskId','in',taskIds).get() : Promise.resolve({docs:[]}),
    ]).then(function(subs){
      var taskChildren = tuples('taskComments', subs[0].docs).concat(tuples('taskLinks', subs[1].docs)).concat(tuples('taskAttachments', subs[2].docs));
      return db.doc('episodes/'+episodeId).delete().then(function(){
        actionWithUndo('"'+title+'" deleted (with all its tasks, comments and attachments)', function(){
          restoreSnapshot([
            [{col:'episodes', id:episodeId, data:episodeData}],
            tasks,
            epChildren.concat(taskChildren)
          ]).then(function(){ showToast('success','Restored'); }).catch(function(err){ showToast('error','Restore failed - '+errMsg(err)); });
        });
      });
    });
  }).catch(function(err){ showToast('error', errMsg(err)); });
}

// Same idea, one level deeper: a client takes its templates, schedule
// rules, episodes and every one of THEIR tasks/comments/links/attachments
// down with it. Fetches the whole subtree before deleting, same reasoning
// as deleteEpisodeWithUndo above.
function deleteClientWithUndo(clientId, clientName){
  Promise.all([
    db.doc('clients/'+clientId).get(),
    db.collection('templates').where('clientId','==',clientId).get(),
    db.collection('scheduleRules').where('clientId','==',clientId).get(),
    db.collection('episodes').where('clientId','==',clientId).get(),
    db.collection('tasks').where('clientId','==',clientId).get(),
  ]).then(function(res){
    var clientData = res[0].data();
    var templates = tuples('templates', res[1].docs);
    var rules = tuples('scheduleRules', res[2].docs);
    var episodes = tuples('episodes', res[3].docs);
    var tasks = tuples('tasks', res[4].docs);
    var episodeIds = episodes.map(function(e){ return e.id; });
    var taskIds = tasks.map(function(t){ return t.id; });
    return Promise.all([
      taskIds.length ? db.collection('taskComments').where('taskId','in',taskIds).get() : Promise.resolve({docs:[]}),
      taskIds.length ? db.collection('taskLinks').where('taskId','in',taskIds).get() : Promise.resolve({docs:[]}),
      taskIds.length ? db.collection('taskAttachments').where('taskId','in',taskIds).get() : Promise.resolve({docs:[]}),
      episodeIds.length ? db.collection('episodeComments').where('episodeId','in',episodeIds).get() : Promise.resolve({docs:[]}),
      episodeIds.length ? db.collection('episodeLinks').where('episodeId','in',episodeIds).get() : Promise.resolve({docs:[]}),
      episodeIds.length ? db.collection('episodeAttachments').where('episodeId','in',episodeIds).get() : Promise.resolve({docs:[]}),
    ]).then(function(subs){
      var children = tuples('taskComments', subs[0].docs).concat(tuples('taskLinks', subs[1].docs)).concat(tuples('taskAttachments', subs[2].docs))
        .concat(tuples('episodeComments', subs[3].docs)).concat(tuples('episodeLinks', subs[4].docs)).concat(tuples('episodeAttachments', subs[5].docs));
      return db.doc('clients/'+clientId).delete().then(function(){
        actionWithUndo(clientName+' deleted (with everything under it)', function(){
          restoreSnapshot([
            [{col:'clients', id:clientId, data:clientData}],
            templates.concat(rules).concat(episodes),
            tasks,
            children
          ]).then(function(){ showToast('success','Restored'); }).catch(function(err){ showToast('error','Restore failed - '+errMsg(err)); });
        });
      });
    });
  }).catch(function(err){ showToast('error', errMsg(err)); });
}

// Shared by the client detail page's own Delete button AND the home page's
// per-card delete action (2026-09-28 ask: delete/edit a client without
// opening it first) - the "type the name back" gate is the same weight
// either way, a permanent delete is a permanent delete regardless of which
// page it's clicked from. Returns true if the delete actually ran (caller
// decides what to do next - the detail page navigates home, the card just
// lets the live grid subscription drop the card).
function confirmAndDeleteClient(clientId, clientName){
  var typed = prompt('This permanently deletes "'+clientName+'" and ALL of its episodes, tasks, comments and attachments (a few seconds\' Undo is offered right after, but not longer than that).\n\nType the client\'s name to confirm:');
  if(typed===null) return false;
  if(typed.trim()!==clientName){ showToast('error','Name didn\'t match - nothing was deleted.'); return false; }
  deleteClientWithUndo(clientId, clientName);
  return true;
}

// Shared by the client detail page's pencil button AND the home page's
// per-card edit action - see confirmAndDeleteClient's comment above for
// why both exist.
function openEditClientNameModal(clientId, c){
  openModal('Edit podcast name & host', '<div class="field"><label>Podcast name</label><input required name="name" type="text" value="'+escapeHtml(c.name)+'"></div>'+
    '<div class="field"><label>Host name(s)</label><input name="hostName" type="text" value="'+escapeHtml(c.hostName||'')+'" placeholder="e.g. Erica Bonser &amp; Steph Eggar"></div>',
    function(fd){
      var name = (fd.get('name')||'').trim();
      if(!name){ showModalError('Name the podcast.'); return; }
      setModalBusy(true);
      db.doc('clients/'+clientId).update({name:name, hostName:(fd.get('hostName')||'').trim()}).then(function(){
        closeModal(); showToast('success','Updated');
      }).catch(function(err){ showModalError(errMsg(err)); });
    }, 'Save');
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
  if(!soundsMuted){
    try{
      var audio = new Audio(SCREENSHOT_BEEP);
      audio.volume = 0.5;
      audio.play().catch(function(){});
    }catch(e){}
  }
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
// Set by renderMeetingRoom() while a meeting page is open; route() calls
// this (then clears it) before rendering wherever navigation is headed
// next - see route()'s own comment for why a plain live-subscription
// unsubscribe (clearSubs()) isn't enough for a meeting room on its own.
var activeMeetingRoomCleanup = null;
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
// Phase 3: loads ROLES from the live `roles` table instead of a hardcoded
// array - see that var's own comment above. Fails open to whatever ROLES
// already held (not an empty array) on a transient fetch error, so a
// flaky connection doesn't wipe every role chip/dropdown in the app blank.
async function refreshRolesCache(){
  try{
    var snap = await db.collection('roles').orderBy('sortOrder','asc').get();
    if(snap.docs.length) ROLES = snap.docs.map(function(d){ return d.data(); });
  }catch(e){ console.warn('[blue-kite-ops] could not refresh roles cache:', e); }
  INVITABLE_ROLES = ROLES.filter(function(r){ return r.key!=='manager' && r.key!=='admin'; });
  ASSIGNABLE_ROLES = ROLES.filter(function(r){ return r.key!=='admin'; });
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

// ---------- ACTIVITY LOG (2026-09-30, schema_v25.sql) ----------
// Manager/Admin-only history of what happened and when - see renderActivity().
// Every write is fire-and-forget from the caller's point of view (never
// blocks or fails the actual action it's recording) since a missed log
// entry is a lot less bad than, say, a task failing to save because
// logging it hit a snag.
var _clientTeamIdCache = {};
function clientTeamIdCached(clientId){
  if(!clientId) return Promise.resolve(null);
  if(clientId in _clientTeamIdCache) return Promise.resolve(_clientTeamIdCache[clientId]);
  return db.doc('clients/'+clientId).get().then(function(s){
    var t = (s.data()||{}).teamId || null;
    _clientTeamIdCache[clientId] = t;
    return t;
  }).catch(function(){ return null; });
}
// fields needs EITHER a `teamId` (already known - e.g. a Connect call,
// which has no client) OR a `clientId` (teamId gets resolved from it).
function logActivity(category, eventType, fields){
  function commit(teamId){
    var row = Object.assign({}, fields, {
      id: 'al_'+uid8(), category: category, eventType: eventType,
      actorUserId: myUid, actorRole: (myRoles&&myRoles[0])||null,
      teamId: teamId, createdAt: new Date().toISOString()
    });
    supabase.from('activityLog').insert(row).catch(function(err){ console.warn('[blue-kite-ops] activity log write failed:', err); });
  }
  if('teamId' in fields) commit(fields.teamId);
  else clientTeamIdCached(fields.clientId).then(commit);
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
// Same idea as activeLightboxKeydown above, for the hero image editor's
// drag-to-reposition handlers (openHeroEditModal) - those attach to
// `document` (need to keep tracking the drag even if the mouse leaves the
// small preview box mid-drag), so they need the same explicit cleanup on
// close or a second "Edit hero image" open would stack duplicate listeners.
var activeHeroDragMove = null, activeHeroDragUp = null;
function closeModal(){
  var root=document.getElementById('modalRoot'); root.classList.remove('open'); root.innerHTML='';
  if(activeLightboxKeydown){ document.removeEventListener('keydown', activeLightboxKeydown); activeLightboxKeydown = null; }
  if(activeHeroDragMove){ document.removeEventListener('mousemove', activeHeroDragMove); activeHeroDragMove = null; }
  if(activeHeroDragUp){ document.removeEventListener('mouseup', activeHeroDragUp); activeHeroDragUp = null; }
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
    var publishIso = isoDate(d);
    if(off===0 && publishIso < todayISO()) return;
    // Deadline (dueDate - what drives overdue badges/sorting/"waiting on"
    // urgency) is the publish date minus this rule's own offset, not the
    // publish date itself - Phase 2.5 batch B, see schema_v12.sql.
    var dueIso = addDaysISO(publishIso, -(rule.daysBeforePublish||2));
    var period = d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0');
    var epId = 'ep_'+rule.id+'_'+period;
    out.push(
      db.doc('episodes/'+epId).get().then(function(existing){
        if(existing.exists) return null;
        var epDoc = {
          clientId: rule.clientId, clientName: clientMeta.name, templateId: rule.templateId,
          scheduleRuleId: rule.id, title: rule.label, dueDate: dueIso, publishDate: publishIso, period: period,
          paid: !!rule.paid, amount: rule.amount||null, taskCount: steps.length, createdAt: new Date().toISOString()
        };
        return db.doc('episodes/'+epId).set(epDoc).then(function(){
          return Promise.all(steps.map(function(s){
            var taskId = epId+'_'+s.stepId;
            var roles = stepRoleKeys(s);
            return db.doc('tasks/'+taskId).set({
              episodeId: epId, episodeTitle: rule.label, clientId: rule.clientId, clientName: clientMeta.name,
              role: roles[0]||null, roles: roles, label: s.label, group: s.group||'', orderNum: s.order||0,
              dependsOnStepIds: stepDepIds(s), dueDate: dueIso, done:false, doneByUserId:null, doneAt:null,
              createdAt: new Date().toISOString()
            });
          }));
        }).then(function(){
          // One notification per ROLE on this episode, not one per task -
          // a template with several steps for the same role would
          // otherwise spam that role's holders with a separate ping for
          // every single task on the same "Generate upcoming episodes"
          // click. A step with multiple roles contributes to EACH of
          // their groups, so every eligible role gets notified.
          var link = '#/episode/'+epId;
          var byRole = {};
          steps.forEach(function(s){ stepRoleKeys(s).forEach(function(rk){ (byRole[rk]=byRole[rk]||[]).push(s.label); }); });
          Object.keys(byRole).forEach(function(role){
            var labels = byRole[role];
            var taskLabel = labels.length>1 ? labels.length+' new tasks' : labels[0];
            notifyRoleAssignment(role, taskLabel, rule.label, clientMeta.name, link, rule.clientId);
          });
        });
      })
    );
  });
  return out;
}

// ---------- ROUTER ----------
function route(){
  // A meeting room isn't just a live subscription (clearSubs() below
  // handles those) - it holds actual WebRTC sessions and possibly an
  // in-progress recording, which need a real teardown (leave the room,
  // close sessions, stop recording) whenever navigation moves away from
  // it, not just an unsubscribe. See renderMeetingRoom().
  if(activeMeetingRoomCleanup){ activeMeetingRoomCleanup(); activeMeetingRoomCleanup=null; }
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
  var mMeeting = hash.match(/^\/meeting\/([^\/]+)$/);
  if(hash==='/') renderHome();
  else if(hash==='/board') renderBoard();
  else if(hash==='/timelog') renderTimeLog();
  else if(hash==='/connect') renderConnect();
  else if(hash==='/team') renderTeamSettings();
  else if(hash==='/admin') renderAdmin();
  else if(hash==='/workflows') renderWorkflows();
  else if(hash==='/activity') renderActivity();
  else if(hash==='/meetings') renderMeetingsList();
  else if(mClient) renderClient(mClient[1]);
  else if(mEpisode) renderEpisode(mEpisode[1]);
  else if(mMeeting) renderMeetingRoom(mMeeting[1]);
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

// Ctrl/Cmd+Z triggers the most recent undo-able toast (2026-09-28, asked
// for after shipping the click-only Undo button) - pendingUndoTrigger is
// set by showToast() whenever an "Undo" action toast is shown, and cleared
// the moment it's used, clicked, or its own window expires. Skipped while
// focus is inside a text field/contentEditable so this doesn't hijack the
// browser's own native undo-my-typing behavior there - genuinely different
// things, and a person editing a comment when a delete's undo window
// happens to still be open should get their typing undone, not someone
// else's delete reversed.
document.addEventListener('keydown', function(e){
  if(!(e.ctrlKey||e.metaKey) || e.shiftKey) return;
  if(e.key!=='z' && e.key!=='Z') return;
  if(!pendingUndoTrigger) return;
  var t = e.target;
  var editable = t && (t.tagName==='INPUT' || t.tagName==='TEXTAREA' || t.isContentEditable);
  if(editable) return;
  e.preventDefault();
  pendingUndoTrigger();
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
// Hero photo + its pan position (2026-09-29: "I want the hero banner image
// on the homepage fully editable... admin only privilege") - a single
// settings row (schema_v20.sql's appSettings/hero), falling back to the
// built-in /hero-banner.webp at its original position if no admin has
// customized it yet. Longhand background-* properties (not the `background`
// shorthand) so this can override just the photo layer while the darkening
// gradient overlay - kept on purpose, per Humayun's explicit "do retain the
// opacity filter" - stays as a fixed rule in style.css independently.
function heroBackgroundStyle(hero){
  var url = (hero && hero.heroImageUrl) || '/hero-banner.webp';
  var x = (hero && hero.heroPosX!=null) ? hero.heroPosX : 53;
  var y = (hero && hero.heroPosY!=null) ? hero.heroPosY : 56;
  return 'background-image:linear-gradient(100deg,rgba(10,22,48,.55) 0%,rgba(10,22,48,.08) 55%,transparent 80%),url(\''+escapeHtml(url)+'\');'+
    'background-position:0 0,'+x+'% '+y+'%;background-size:auto,cover;background-repeat:no-repeat,no-repeat;';
}
// Zoom beyond a plain cover fit (see openHeroEditModal's own applyZoom for
// the full reasoning) needs the image's real natural dimensions, which
// aren't known synchronously while building the inline style string above -
// this runs right after the banner element actually exists in the DOM and
// swaps in an explicit pixel background-size for just the photo layer once
// the image has loaded, leaving the gradient layer (layer 1) alone. A
// no-op whenever zoom is unset/100 (the common case), so nothing async
// happens at all unless someone's actually used the zoom control.
function applyHeroZoomToBanner(bannerEl, hero){
  if(!bannerEl || !hero || !hero.heroZoom || hero.heroZoom<=100) return;
  var img = new Image();
  img.onload = function(){
    var rect = bannerEl.getBoundingClientRect();
    var coverScale = Math.max(rect.width/img.naturalWidth, rect.height/img.naturalHeight);
    var w = img.naturalWidth*coverScale*(hero.heroZoom/100), h = img.naturalHeight*coverScale*(hero.heroZoom/100);
    bannerEl.style.backgroundSize = 'auto, '+w+'px '+h+'px';
  };
  img.src = hero.heroImageUrl || '/hero-banner.webp';
}

function renderSpotlight(container){
  var monthKey = currentMonthKey();
  var latestHero = null; // appSettings/hero row, or null (use the built-in default)
  var latestSpotlightSnap = 'pending'; // 'pending' until the first snapshot arrives, so neither listener renders before both have a real value at least once
  var mgr = canManage();

  function render(){
    if(latestSpotlightSnap==='pending') return; // wait for the spotlight's own first snapshot - the hero photo alone isn't enough to draw the banner (need to know "set" vs "not set yet")
    var s = latestSpotlightSnap;
    var heroBtn = mgr ? '<button type="button" class="icon-btn spotlight-hero-edit" id="heroEditBtn" title="Change hero image">'+ICON_PENCIL+'</button>' : '';
    function wireCommon(){
      var btn = document.getElementById('spotlightEditBtn');
      if(btn) btn.addEventListener('click', function(){ openSpotlightModal(monthKey, s); });
      var hbtn = document.getElementById('heroEditBtn');
      if(hbtn) hbtn.addEventListener('click', function(){ openHeroEditModal(latestHero); });
    }
    if(!s || !s.employeeId){
      if(!mgr){ container.innerHTML=''; return; }
      container.innerHTML = '<div class="spotlight-banner" style="'+heroBackgroundStyle(latestHero)+'">'+heroBtn+
        '<div class="spotlight-body"><div class="spotlight-eyebrow">Employee of the month</div>'+
        '<div class="spotlight-name">Not set yet</div><div class="spotlight-note">Pick this month\'s spotlight.</div></div>'+
        '<button type="button" class="btn spotlight-edit" id="spotlightEditBtn"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg> Set spotlight</button></div>';
      wireCommon();
      applyHeroZoomToBanner(container.querySelector('.spotlight-banner'), latestHero);
    } else {
      fetchProfiles([s.employeeId]).then(function(ps){
        var p = ps[s.employeeId] || {name:'Someone', initial:'?', color:'#888', avatarUrl:''};
        container.innerHTML = '<div class="spotlight-banner" style="'+heroBackgroundStyle(latestHero)+'">'+heroBtn+
          (p.avatarUrl ? '<img class="spotlight-photo" src="'+escapeHtml(p.avatarUrl)+'">' : '<div class="spotlight-photo" style="display:flex;align-items:center;justify-content:center;font-family:var(--font-display);font-size:28px;font-weight:700;background:'+p.color+';color:#fff;">'+escapeHtml(p.initial)+'</div>')+
          '<div class="spotlight-body"><div class="spotlight-eyebrow">Employee of the month</div>'+
          '<div class="spotlight-name">'+escapeHtml(p.name)+'</div>'+
          (s.note?'<div class="spotlight-note">'+escapeHtml(s.note)+'</div>':'')+'</div>'+
          (mgr?'<button type="button" class="btn spotlight-edit" id="spotlightEditBtn">Edit</button>':'')+
          '</div>';
        wireCommon();
        applyHeroZoomToBanner(container.querySelector('.spotlight-banner'), latestHero);
      }).catch(function(){ container.innerHTML=''; });
    }
  }

  // Was a one-time .get() for the spotlight itself - meaning it only ever
  // loaded when this page was first opened. If Admin changed the spotlight
  // (or now, the hero photo) while an employee already had Home open,
  // they'd never see it until they navigated away and back. Both are now
  // .onSnapshot()s so either changing re-renders live, same as everything
  // else in this app.
  var unsub1 = db.doc('spotlights/'+monthKey).onSnapshot(function(snap){
    latestSpotlightSnap = snap.exists ? snap.data() : null;
    render();
  }, function(){ container.innerHTML=''; });
  var unsub2 = db.doc('appSettings/hero').onSnapshot(function(snap){
    latestHero = snap.exists ? snap.data() : null;
    render();
  }, function(){ /* fails open - just keeps the built-in default hero image */ });
  activeUnsubs.push(unsub1, unsub2);
}

// Admin-only hero photo editor (2026-09-29) - upload any image, drag to
// reposition it within the banner, save. Position is stored as a plain
// background-position percentage pair rather than real pixel coordinates,
// so it stays correct at any window size the same way background-position
// always does.
function openHeroEditModal(existingHero){
  if(activeHeroDragMove){ document.removeEventListener('mousemove', activeHeroDragMove); activeHeroDragMove = null; }
  if(activeHeroDragUp){ document.removeEventListener('mouseup', activeHeroDragUp); activeHeroDragUp = null; }
  var posX = (existingHero && existingHero.heroPosX!=null) ? existingHero.heroPosX : 53;
  var posY = (existingHero && existingHero.heroPosY!=null) ? existingHero.heroPosY : 56;
  var zoom = (existingHero && existingHero.heroZoom!=null) ? existingHero.heroZoom : 100;
  var imageUrl = (existingHero && existingHero.heroImageUrl) || '/hero-banner.webp';
  var pendingBlob = null;
  var naturalW = null, naturalH = null;

  openModal('Edit hero image', '<div class="field">'+
    '<div class="hero-edit-preview" id="heroEditPreview" style="background-image:url(\''+escapeHtml(imageUrl)+'\');background-position:'+posX+'% '+posY+'%;">'+
    '<div class="hero-edit-hint">Drag to reposition</div></div>'+
    '</div>'+
    '<div class="field"><label>Zoom</label><input type="range" id="heroZoomInput" min="100" max="250" value="'+zoom+'"></div>'+
    '<div class="field"><label>Replace image</label><input type="file" accept="image/*" id="heroImageFileInput"></div>'+
    '<div class="field-hint">Position and zoom save automatically as you adjust them - "Save" just confirms it.</div>',
    function(){
      setModalBusy(true);
      var uploadStep = pendingBlob
        ? uploadFile(new File([pendingBlob],'hero.jpg',{type:'image/jpeg'}), 'settings/hero_'+Date.now()+'.jpg').then(fileUrl)
        : Promise.resolve(imageUrl);
      uploadStep.then(function(url){
        return db.doc('appSettings/hero').set({ heroImageUrl:url, heroPosX:posX, heroPosY:posY, heroZoom:zoom, updatedBy:myUid, updatedAt:new Date().toISOString() });
      }).then(function(){ closeModal(); showToast('success','Hero image updated'); route(); })
        .catch(function(err){ showModalError(errMsg(err)); });
    }, 'Save', {large:true});

  var preview = document.getElementById('heroEditPreview');
  var fileInput = document.getElementById('heroImageFileInput');
  var zoomInput = document.getElementById('heroZoomInput');

  // Zoom (2026-09-29 ask: "there should also be an option to zoom in, zoom
  // out on the photo so I can position it perfectly"). background-size:
  // cover alone has no "amount" to dial up - to zoom BEYOND a plain cover
  // fit, this computes the image's own cover-equivalent pixel size for the
  // preview box's actual current dimensions, then scales that by the zoom
  // percentage and sets background-size in real pixels. Needs the image's
  // natural (unscaled) dimensions, so this waits for it to load once per
  // image (existing photo on open, or a freshly uploaded one).
  function applyZoom(){
    if(zoom<=100 || !naturalW){ preview.style.backgroundSize = 'cover'; return; }
    var rect = preview.getBoundingClientRect();
    var coverScale = Math.max(rect.width/naturalW, rect.height/naturalH);
    var w = naturalW*coverScale*(zoom/100), h = naturalH*coverScale*(zoom/100);
    preview.style.backgroundSize = w+'px '+h+'px';
  }
  function loadNaturalDims(url){
    naturalW = null; naturalH = null;
    var img = new Image();
    img.onload = function(){ naturalW = img.naturalWidth; naturalH = img.naturalHeight; applyZoom(); };
    img.src = url;
  }
  loadNaturalDims(imageUrl);
  zoomInput.addEventListener('input', function(){ zoom = +zoomInput.value; applyZoom(); });

  fileInput.addEventListener('change', function(){
    var file = fileInput.files[0]; if(!file) return;
    // Wide banner crop, not square - kept at generous resolution since,
    // unlike a small avatar/card thumbnail, this renders at full page
    // width. No forced aspect crop: background-size:cover (or the zoomed
    // pixel size above) handles fitting whatever shape is uploaded, same
    // as the built-in hero image.
    compressImage(file, {maxWidth:2400, maxHeight:900, quality:.85}).then(function(blob){
      pendingBlob = blob;
      imageUrl = URL.createObjectURL(blob);
      preview.style.backgroundImage = "url('"+imageUrl+"')";
      loadNaturalDims(imageUrl);
    }).catch(function(err){ showToast('error', errMsg(err)); });
  });

  var dragging = false, dragMoved = false, startMouseX=0, startMouseY=0, startPosX=posX, startPosY=posY;
  preview.addEventListener('mousedown', function(ev){
    dragging = true; dragMoved = false; startMouseX = ev.clientX; startMouseY = ev.clientY; startPosX = posX; startPosY = posY;
    preview.classList.add('dragging');
    ev.preventDefault();
  });
  activeHeroDragMove = function(ev){
    if(!dragging) return;
    dragMoved = true;
    var rect = preview.getBoundingClientRect();
    // Dragging right/down should visually move the PHOTO right/down (the
    // way dragging a photo under your finger works everywhere else), which
    // means revealing more of its opposite edge - background-position
    // moves the other way from the mouse.
    var dx = ((ev.clientX-startMouseX)/rect.width)*100;
    var dy = ((ev.clientY-startMouseY)/rect.height)*100;
    posX = Math.max(0, Math.min(100, startPosX - dx));
    posY = Math.max(0, Math.min(100, startPosY - dy));
    preview.style.backgroundPosition = posX+'% '+posY+'%';
  };
  activeHeroDragUp = function(){
    if(dragging){
      dragging=false;
      preview.classList.remove('dragging');
      // Real bug (2026-09-29): dragging far enough (toward an extreme
      // left/right/top/bottom position) can end with the mouse outside the
      // small preview box, over the modal's dark backdrop - the browser
      // then fires a click there, which openModal()'s own "click the
      // backdrop to close" handler treats as "close the modal", even
      // though the intent was just finishing a drag. One capturing click-
      // swallower, used once, stops that single synthesized click from
      // ever reaching the backdrop's own listener - only armed when a real
      // drag happened (dragMoved), so an ordinary click elsewhere still
      // closes the modal normally.
      if(dragMoved) document.addEventListener('click', function swallow(ev){ ev.stopPropagation(); }, {capture:true, once:true});
    }
  };
  document.addEventListener('mousemove', activeHeroDragMove);
  document.addEventListener('mouseup', activeHeroDragUp);
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
      // Cover-art card (2026-09-29): the square photo is the whole point of
      // the card now - podcast/album-cover-art convention, same square
      // treatment as the client detail page's own cover art. Hosted-by and
      // overview text are gone per Humayun's explicit ask (services/team/
      // view-board are the only footer info that remains) - the client's
      // name stays as a minimal caption directly on the photo itself
      // (gradient scrim, same idea as a Spotify/Apple Music tile) rather
      // than disappearing completely, since a card with literally no label
      // at all would make the grid unusable for actually finding a client.
      return '<a class="client-card" href="#/client/'+d.id+'">'+
        '<div class="client-card-photo'+(c.imageUrl?'':' no-image')+'" style="'+(c.imageUrl?'background-image:url(\''+escapeHtml(c.imageUrl)+'\')':'background:linear-gradient(135deg,'+color+',var(--line-soft))')+'">'+
        (canManage()?'<div class="client-card-actions"><button type="button" class="icon-btn" data-edit-client-card="'+d.id+'" title="Edit name/host">'+ICON_PENCIL+'</button><button type="button" class="icon-btn" data-delete-client-card="'+d.id+'" title="Delete client">'+ICON_TRASH+'</button></div>':'')+
        '<div class="client-card-caption">'+escapeHtml(c.name)+'</div>'+
        '</div>'+
        '<div class="client-card-foot"><span>'+(c.services?c.services.length:0)+' services</span>'+(isAdmin()?'<span class="badge badge-team">'+escapeHtml(teamName(c.teamId))+'</span>':'')+(c.archived?'<span class="badge" style="background:var(--line-soft);">Archived</span>':'')+(c.example?'<span class="badge badge-upcoming">Example</span>':'<span>View board →</span>')+'</div>'+
        '</a>';
    }).join('');
    if(canManage()) cards += '<button type="button" class="add-client-card" id="addClientCard">+ Add a client</button>';
    grid.innerHTML = cards || '<div class="empty-state">No clients'+(showArchivedClients?' in your team yet':' - toggle "Show archived" above if you\'re looking for one you archived')+'.</div>';
    var btn = document.getElementById('addClientCard');
    if(btn) btn.addEventListener('click', openAddClientModal);
    // Edit/delete straight from the card (2026-09-28 ask: shouldn't have
    // to open a client just to rename or delete it) - both buttons sit
    // inside the card's own <a>, so each needs to stop the click from
    // ALSO navigating into the client.
    Array.prototype.forEach.call(grid.querySelectorAll('[data-edit-client-card]'), function(btn2){
      btn2.addEventListener('click', function(ev){
        ev.preventDefault(); ev.stopPropagation();
        var cid = btn2.getAttribute('data-edit-client-card');
        var doc = docs.filter(function(d){ return d.id===cid; })[0];
        if(doc) openEditClientNameModal(cid, doc.data());
      });
    });
    Array.prototype.forEach.call(grid.querySelectorAll('[data-delete-client-card]'), function(btn2){
      btn2.addEventListener('click', function(ev){
        ev.preventDefault(); ev.stopPropagation();
        var cid = btn2.getAttribute('data-delete-client-card');
        var doc = docs.filter(function(d){ return d.id===cid; })[0];
        if(!doc) return;
        var card = btn2.closest('.client-card');
        if(confirmAndDeleteClient(cid, doc.data().name) && card) card.classList.add('pending-remove');
      });
    });
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
      // Cover art (square, podcast-art proportions - 2026-09-29) sits beside
      // the header instead of a full-width banner strip above it, same
      // "art beside metadata" layout convention podcast/album pages use.
      '<div class="client-hero">'+
      '<div class="client-cover'+(c.imageUrl?'':' no-image')+'" style="'+(c.imageUrl?'background-image:url(\''+escapeHtml(c.imageUrl)+'\')':'')+'">'+
      (mgr?'<label class="client-cover-change" title="Change photo">'+ICON_PENCIL+'<input type="file" accept="image/*" id="clientImageInput" style="display:none;"></label>':'')+
      '</div>'+
      '<div class="client-hero-info">'+
      '<div class="page-head" style="margin:0;"><div><div class="eyebrow">Client</div><h1 class="page-title">'+escapeHtml(c.name)+(c.archived?' <span class="badge" style="background:var(--line-soft);vertical-align:middle;">Archived</span>':'')+(mgr?' <button type="button" class="icon-btn" id="editClientNameBtn" title="Edit podcast name / host">'+ICON_PENCIL+'</button>':'')+'</h1>'+
      '<div class="page-sub">Hosted by '+escapeHtml(c.hostName||'-')+' · <span id="clientTeamRow">Team: <b>'+escapeHtml(teamName(c.teamId))+'</b>'+(isAdmin()?' <button type="button" class="btn btn-sm" id="editTeamBtn" style="width:auto;padding:1px 8px;font-size:11px;vertical-align:middle;">Change</button>':'')+'</span></div></div></div>'+
      '<div style="display:flex;align-items:flex-start;gap:8px;flex-wrap:wrap;margin-top:14px;">'+
      (mgr?'<button type="button" class="btn btn-sm" id="archiveClientBtn">'+(c.archived?'Unarchive':'Archive')+'</button><button type="button" class="btn btn-sm btn-danger" id="deleteClientBtn">Delete permanently</button>':'')+
      (mgr?'<button type="button" class="btn btn-primary btn-sm" id="genEpisodesBtn">Generate upcoming episodes</button>':'')+
      '</div>'+
      '</div>'+
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
      // Used to always generate 3 months (current + next 2) of episodes -
      // and every task on every one of them - in a single click, with no
      // way to ask for less. Each schedule rule only ever produces one
      // episode per calendar month (it fires on a specific "2nd Tuesday",
      // "last Friday", etc. of the month), so the real unit of "how much"
      // here is months, not weeks - offering a week-granularity choice
      // would be misleading since a 1-2 week span usually contains zero or
      // one occurrence of the rule's weekday anyway. Asking up front how
      // many months out to generate (2026-09-30) is what actually avoids
      // blasting everyone with 3 months of notifications when someone only
      // meant to queue up the next one.
      openModal('Generate upcoming episodes', '<div class="field">'+
        '<label>How far ahead should this generate episodes (and notify everyone assigned)?</label>'+
        '<select name="monthSpan">'+
        '<option value="1">This month only</option>'+
        '<option value="2">This month + next month</option>'+
        '<option value="3" selected>This month + next 2 months</option>'+
        '<option value="custom">Custom number of months…</option>'+
        '</select></div>'+
        '<div class="field" id="genCustomMonthsField" hidden><label>Number of months ahead (starting this month)</label>'+
        '<input name="customMonths" type="number" min="1" max="12" value="3"></div>',
        function(fd){
          var span = fd.get('monthSpan');
          var n = span==='custom' ? parseInt(fd.get('customMonths'),10) : parseInt(span,10);
          if(!n || n<1){ showModalError('Enter at least 1 month.'); return; }
          n = Math.min(n, 12);
          var monthOffsets = []; for(var i=0;i<n;i++) monthOffsets.push(i);
          setModalBusy(true, 'Generating…');
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
              writes = writes.concat(generateEpisodesForRule(r, {name:c.name}, tplMap[r.templateId]||[], monthOffsets));
            });
            if(!any){ showToast('error','No active schedule rules to generate from yet.'); }
            return Promise.all(writes);
          }).then(function(created){
            closeModal();
            var made = created.filter(Boolean).length;
            showToast('success', made ? ('Generated '+made+' new episode'+(made===1?'':'s')) : 'Already up to date - nothing new to generate.');
          }).catch(function(err){ setModalBusy(false); showModalError(errMsg(err)); });
        }, 'Generate'
      );
      var spanSelect = document.querySelector('#modalForm [name="monthSpan"]');
      var customField = document.getElementById('genCustomMonthsField');
      if(spanSelect) spanSelect.addEventListener('change', function(){ customField.hidden = spanSelect.value!=='custom'; });
    });

    var archiveClientBtn = document.getElementById('archiveClientBtn');
    if(archiveClientBtn) archiveClientBtn.addEventListener('click', function(){
      var next = !c.archived;
      if(!confirm(next ? 'Archive '+c.name+'? It will be hidden from the main client list but all its episodes, tasks, comments and attachments are kept - you can unarchive it later.' : 'Unarchive '+c.name+'?')) return;
      db.doc('clients/'+clientId).update({archived: next}).then(function(){ showToast('success', next?'Client archived':'Client unarchived'); }).catch(function(err){ showToast('error', errMsg(err)); });
    });
    var deleteClientBtn = document.getElementById('deleteClientBtn');
    if(deleteClientBtn) deleteClientBtn.addEventListener('click', function(){
      if(confirmAndDeleteClient(clientId, c.name)) location.hash = '#/';
    });

    var imgInput = document.getElementById('clientImageInput');
    if(imgInput) imgInput.addEventListener('change', function(){
      var file = imgInput.files[0]; if(!file) return;
      showToast('success','Uploading photo…');
      // Square cover-art crop (2026-09-29, podcast/album-art convention,
      // matches the client-cover display which is a real square, not just
      // square via CSS) - 1200px is already far sharper than this ever
      // needs to render at in the UI (the cover art tops out at ~190px on
      // screen, more on a big monitor's home-page grid), so this stays well
      // short of literally shipping a 3000x3000 file for no visible gain.
      compressImage(file, {maxWidth:1200,maxHeight:1200,quality:.88,square:true}).then(function(blob){
        var key = 'clients/'+clientId+'/photo_'+Date.now()+'.jpg';
        return uploadFile(new File([blob],'photo.jpg',{type:'image/jpeg'}), key);
      }).then(function(key){
        return db.doc('clients/'+clientId).update({imageUrl: fileUrl(key)});
      }).then(function(){ showToast('success','Photo updated'); }).catch(function(err){ showToast('error', errMsg(err)); });
    });

    // Podcast name + host - real fields since Phase 1 (openAddClientModal
    // already writes both at creation) but never had an edit affordance
    // afterward - flagged 2026-09-28. No schema change needed, both
    // columns already exist.
    var editClientNameBtn = document.getElementById('editClientNameBtn');
    if(editClientNameBtn) editClientNameBtn.addEventListener('click', function(){ openEditClientNameModal(clientId, c); });

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
          var ruleId = btn.getAttribute('data-rule');
          var ruleDoc = rows.filter(function(x){ return x.id===ruleId; })[0];
          var data = ruleDoc && ruleDoc.data();
          db.doc('scheduleRules/'+ruleId).delete().then(function(){
            actionWithUndo('Rule removed (episodes already generated from it are kept)', function(){
              if(data) db.doc('scheduleRules/'+ruleId).set(data).catch(function(err){ showToast('error', errMsg(err)); });
            });
          }).catch(function(err){ showToast('error', errMsg(err)); });
        });
      });
    }, function(){});
    activeUnsubs.push(unsubSched);

    var lastEpSnap = null;
    var showArchivedEpisodes = false;
    // Completed-episode segment (Phase 2.5 batch B, item #2): an episode
    // where every one of its tasks is done moves into its own "Completed"
    // section instead of staying mixed in with open ones, the same idea
    // already shipped for individual tasks within an episode's own
    // checklist (round 8). Whether an episode is fully done isn't a field
    // on the episode doc itself (there's no cached "done count" to drift
    // out of sync, on purpose - see CLAUDE.md's "live lookup over baked-in
    // value" convention) - it's computed live from a single grouped query
    // over every task for this client, the same "one query covers every
    // row, refetch on any relevant change" shape as the comment-count
    // badge fix (round 8.9-fix).
    var lastTaskCounts = {};
    function isEpisodeComplete(d){
      var c = lastTaskCounts[d.id];
      return !!(c && c.total>0 && c.done===c.total);
    }
    function renderEpisodeList(){
      var list = document.getElementById('episodeList');
      if(!list || !lastEpSnap) return;
      var docs = lastEpSnap.docs.filter(function(d){ return showArchivedEpisodes || !d.data().archived; });
      if(!docs.length){ list.innerHTML = '<div class="empty-state"><strong>No episodes yet</strong>'+(mgr?'Add a schedule rule, then generate episodes.':'Ask a manager to set up this client\'s schedule.')+'</div>'; return; }
      function rowHtml(d){
        var e = d.data();
        var status = dueStatus(e.dueDate,false);
        return '<a class="episode-row" href="#/episode/'+d.id+'">'+
          '<span class="episode-date mono">'+fmtDate(e.dueDate)+'</span>'+
          '<div class="episode-main"><div class="episode-title">'+escapeHtml(e.title)+(e.archived?' <span class="badge" style="background:var(--line-soft);">Archived</span>':'')+'</div>'+
          '<div class="episode-sub">'+(e.taskCount||0)+' tasks'+(e.paid?' · Paid $'+e.amount:'')+'</div></div>'+
          '<span class="badge badge-'+status+'">'+statusLabel(status)+'</span>'+
          (mgr?'<button type="button" class="icon-btn episode-row-delete" data-delete-episode-row="'+d.id+'" data-title="'+escapeHtml(e.title)+'" title="Delete episode">'+ICON_TRASH+'</button>':'')+
          '</a>';
      }
      var open = docs.filter(function(d){ return !isEpisodeComplete(d); });
      var done = docs.filter(isEpisodeComplete);
      // Not wrapped in a single container div: #episodeList is a flex
      // column with its own gap between direct children (.episode-list),
      // so the header and each "done" row are emitted as flat siblings,
      // same as the open rows above, to keep that spacing consistent
      // instead of collapsing to 0 inside one wrapped block.
      list.innerHTML = open.map(rowHtml).join('') +
        (done.length ? '<div class="checklist-group-head checklist-completed" style="margin-top:6px;"><span class="checklist-group-title">'+ICON_CHECK_CIRCLE+' Completed ('+done.length+')</span></div>'+done.map(rowHtml).join('') : '');
      // Delete straight from the list (2026-09-28 ask: shouldn't have to
      // open an episode just to delete it) - the button sits inside the
      // row's own <a>, so it needs to stop the click from ALSO navigating.
      Array.prototype.forEach.call(list.querySelectorAll('[data-delete-episode-row]'), function(btn){
        btn.addEventListener('click', function(ev){
          ev.preventDefault(); ev.stopPropagation();
          var epId = btn.getAttribute('data-delete-episode-row');
          var title = btn.getAttribute('data-title');
          var row = btn.closest('.episode-row');
          if(row) row.classList.add('pending-remove');
          deleteEpisodeWithUndo(epId, title, clientId);
        });
      });
    }
    var unsubEp = db.collection('episodes').where('clientId','==',clientId).orderBy('dueDate','asc').limit(30).onSnapshot(function(es){
      lastEpSnap = es;
      renderEpisodeList();
    }, function(){});
    activeUnsubs.push(unsubEp);
    var unsubEpTasks = db.collection('tasks').where('clientId','==',clientId).onSnapshot(function(tsSnap){
      var counts = {};
      tsSnap.docs.forEach(function(d){
        var t = d.data();
        if(!counts[t.episodeId]) counts[t.episodeId] = {done:0, total:0};
        counts[t.episodeId].total++;
        if(t.done) counts[t.episodeId].done++;
      });
      lastTaskCounts = counts;
      renderEpisodeList();
    }, function(){});
    activeUnsubs.push(unsubEpTasks);
    var epArchToggle = document.getElementById('showArchivedEpisodesToggle');
    if(epArchToggle) epArchToggle.addEventListener('change', function(){ showArchivedEpisodes = epArchToggle.checked; renderEpisodeList(); });

    if(mgr){
      var tplBox = document.getElementById('templateBox');
      if(tplBox) activeUnsubs.push(mountTemplatesBox(clientId, tplBox));
    }
  }, function(){ paint('<div class="empty-state">Could not load this client.</div>'); });
  activeUnsubs.push(unsub);
}

// Group picker shared by the add-step and edit-step modals (Phase 2.5
// batch B, "group dropdown" - item #3's first bullet): a free-text Group
// input let two steps end up in "Editing" and "editing " as two visually-
// identical-looking but functionally separate header groups on the
// checklist, just from a typo. Existing group names on this template are
// now offered as a dropdown instead, with a "+ New group" choice that
// reveals a plain text input for a genuinely new name - see
// wireGroupPicker/resolveGroupChoice.
function groupOptionsHtml(steps, selected){
  var names = [];
  (steps||[]).forEach(function(s){
    var g = (s.group||'').trim() || 'Tasks';
    if(names.indexOf(g)===-1) names.push(g);
  });
  if(selected && names.indexOf(selected)===-1) names.push(selected);
  return names.map(function(g){ return '<option value="'+escapeHtml(g)+'"'+(g===selected?' selected':'')+'>'+escapeHtml(g)+'</option>'; }).join('') +
    '<option value="__new__"'+(!selected?' selected':'')+'>+ New group…</option>';
}
function wireGroupPicker(form){
  var select = form.querySelector('[name="groupChoice"]');
  var newField = form.querySelector('[data-group-new-field]');
  if(!select || !newField) return;
  function sync(){ newField.style.display = select.value==='__new__' ? '' : 'none'; }
  select.addEventListener('change', sync);
  sync();
}
function resolveGroupChoice(fd){
  var choice = fd.get('groupChoice');
  return choice==='__new__' ? (fd.get('groupNew')||'').trim() : (choice||'').trim();
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
            '<button type="button" class="step-edit-remove" data-edit-step data-tpl="'+d.id+'" data-step="'+escapeHtml(s.stepId)+'" title="Change this step\'s name, role or group">edit</button>'+
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
    Array.prototype.forEach.call(box.querySelectorAll('[data-edit-step]'), function(btn){
      btn.addEventListener('click', function(){ openEditStepModal(btn.getAttribute('data-tpl'), btn.getAttribute('data-step')); });
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
    '<div class="field-hint">Roles: '+jobTitleRoles().map(function(r){return r.key;}).join(', ')+'</div></div>'+
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
    '<div class="field"><label>Publish/air date</label><input required name="publishDate" type="date" value="'+todayISO()+'"></div>'+
    '<div class="field"><label>Deadline is this many days before that</label><input name="daysBeforePublish" type="number" min="0" value="2"></div>'+
    '<div class="check-row"><input type="checkbox" id="oneOffPaid" name="paid" style="width:16px;height:16px;"><label for="oneOffPaid">Paid appearance</label></div>'+
    '<div class="field"><label>Amount ($)</label><input name="amount" type="number" placeholder="200"></div>',
    function(fd){
      var title = (fd.get('title')||'').trim();
      if(!title){ showModalError('Give this episode a title.'); return; }
      setModalBusy(true);
      var epId = 'ep_oneoff_'+uid8();
      var publishDate = fd.get('publishDate');
      var dueDate = addDaysISO(publishDate, -(parseInt(fd.get('daysBeforePublish'),10)||0));
      db.doc('episodes/'+epId).set({
        clientId: clientId, clientName: clientName, templateId: null, scheduleRuleId: null,
        title: title, dueDate: dueDate, publishDate: publishDate, period: null,
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
      '<div class="field"><label>Deadline is this many days before the publish date</label><input name="daysBeforePublish" type="number" min="0" value="2"></div>'+
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
          daysBeforePublish: parseInt(fd.get('daysBeforePublish'),10) || 0,
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
    return db.doc('clients/'+t.clientId).get().then(function(cSnap){
      return { t: t, teamId: (cSnap.data()||{}).teamId };
    });
  }).then(function(ctx){
    var t = ctx.t;
    var existingSteps = (t.steps||[]).slice().sort(function(a,b){return (a.order||0)-(b.order||0);});
    var checksHtml = existingSteps.length ? existingSteps.map(function(s){
      return '<div class="check-row"><input type="checkbox" name="dependsOnStepIds" value="'+escapeHtml(s.stepId)+'" id="newdep_'+escapeHtml(s.stepId)+'"><label for="newdep_'+escapeHtml(s.stepId)+'">'+escapeHtml(s.label)+'</label></div>';
    }).join('') : '<div class="field-hint">No other steps yet.</div>';
    var roleChecksHtml = assignableTaskRoles(ctx.teamId).map(function(r){
      return '<label style="display:flex;align-items:center;gap:5px;font-size:12.5px;padding:2px 0;"><input type="checkbox" name="roles" value="'+r.key+'">'+escapeHtml(r.label)+'</label>';
    }).join('');
    openModal('Add workflow step', '<div class="field"><label>Step description</label><input required name="label" type="text" placeholder="e.g. Edit trailer"></div>'+
      '<div class="field-row"><div class="field"><label>Role(s) - pick any number</label><div style="max-height:140px;overflow:auto;border:1px solid var(--line);border-radius:8px;padding:6px 8px;">'+roleChecksHtml+'</div></div>'+
      '<div class="field"><label>Group</label><select name="groupChoice">'+groupOptionsHtml(existingSteps, null)+'</select>'+
      '<input name="groupNew" type="text" placeholder="e.g. Editing" data-group-new-field style="margin-top:6px;"></div></div>'+
      '<div class="field"><label>Depends on (optional, pick any number)</label>'+checksHtml+'</div>'+
      '<div class="field-hint">Every task generated from this step - in every future episode - is locked until ALL chosen steps are checked off. You can change this later from the step\'s "Change dependencies" button.</div>',
      function(fd){
        var label = (fd.get('label')||'').trim();
        if(!label){ showModalError('Describe the step.'); return; }
        var roles = fd.getAll('roles');
        if(!roles.length){ showModalError('Pick at least one role.'); return; }
        setModalBusy(true);
        var dependsOnStepIds = fd.getAll('dependsOnStepIds');
        var newStep = {stepId:'s'+uid8(), order:0, role:roles[0], roles:roles, group:resolveGroupChoice(fd), label:label, dependsOnStepIds: dependsOnStepIds};
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
              role: newStep.role, roles: stepRoleKeys(newStep), label: newStep.label, group: newStep.group||'', orderNum: newStep.order||0,
              dependsOnStepIds: newStep.dependsOnStepIds||[], dueDate: e.dueDate, done:false, doneByUserId:null, doneAt:null,
              createdAt: new Date().toISOString()
            }).then(function(){
              return db.doc('episodes/'+epDoc.id).update({ taskCount: (e.taskCount||0) + 1 });
            }).then(function(){
              stepRoleKeys(newStep).forEach(function(rk){ notifyRoleAssignment(rk, newStep.label, e.title, e.clientName, '#/episode/'+epDoc.id, e.clientId); });
            });
          }));
        }).then(function(){
          closeModal(); showToast('success', 'Added step');
        }).catch(function(err){ showModalError(errMsg(err)); });
      }, 'Add step', {afterRender: wireGroupPicker});
  }).catch(function(err){ showToast('error', errMsg(err)); });
}

// Editable step role/name/group (Phase 2.5 batch B, item #3's second
// bullet) - previously the only way to change an existing step's label/
// role/group was remove-and-re-add, which loses its dependencies and
// orphans any tasks already generated from it. Editing in place needs a
// real decision every time: does this change apply to episodes that
// already exist, or only ones generated from now on - collected as a
// second step right after this one, see openStepEditScopeModal. Per
// Humayun's 2026-09-26 scope call: (A) everyone, current and future,
// (B) future episodes only, (C) only tasks/episodes due on or after a
// chosen date.
function openEditStepModal(tplId, stepId){
  db.doc('templates/'+tplId).get().then(function(snap){
    var t = snap.data();
    return db.doc('clients/'+t.clientId).get().then(function(cSnap){
      return { t: t, teamId: (cSnap.data()||{}).teamId };
    });
  }).then(function(ctx){
    var t = ctx.t;
    var steps = (t.steps||[]).slice().sort(function(a,b){return (a.order||0)-(b.order||0);});
    var self = steps.filter(function(s){ return s.stepId===stepId; })[0];
    if(!self){ showToast('error','That step no longer exists - try refreshing.'); return; }
    var selfGroup = (self.group||'').trim() || 'Tasks';
    // Whatever role(s) this step already holds always stay valid options,
    // even if one belongs to a different team than the client's current
    // one (e.g. the role since got reassigned) - otherwise the checkbox
    // would silently disappear and Save would quietly drop it even though
    // nobody unchecked it.
    var selfRoles = stepRoleKeys(self);
    var roleOptions = assignableTaskRoles(ctx.teamId);
    selfRoles.forEach(function(rk){
      if(!roleOptions.some(function(r){ return r.key===rk; })){
        var currentRole = roleOf(rk);
        if(currentRole) roleOptions.push(currentRole);
      }
    });
    var roleChecksHtml = roleOptions.map(function(r){
      return '<label style="display:flex;align-items:center;gap:5px;font-size:12.5px;padding:2px 0;"><input type="checkbox" name="roles" value="'+r.key+'"'+(selfRoles.indexOf(r.key)>-1?' checked':'')+'>'+escapeHtml(r.label)+'</label>';
    }).join('');
    openModal('Edit "'+escapeHtml(self.label)+'"',
      '<div class="field"><label>Step description</label><input required name="label" type="text" value="'+escapeHtml(self.label)+'"></div>'+
      '<div class="field-row"><div class="field"><label>Role(s) - pick any number</label><div style="max-height:140px;overflow:auto;border:1px solid var(--line);border-radius:8px;padding:6px 8px;">'+roleChecksHtml+'</div></div>'+
      '<div class="field"><label>Group</label><select name="groupChoice">'+groupOptionsHtml(steps, selfGroup)+'</select>'+
      '<input name="groupNew" type="text" placeholder="e.g. Editing" data-group-new-field style="margin-top:6px;"></div></div>',
      function(fd){
        var label = (fd.get('label')||'').trim();
        if(!label){ showModalError('Describe the step.'); return; }
        var roles = fd.getAll('roles');
        if(!roles.length){ showModalError('Pick at least one role.'); return; }
        var changes = { label: label, role: roles[0], roles: roles, group: resolveGroupChoice(fd) };
        openStepEditScopeModal(tplId, stepId, changes);
      }, 'Next', {afterRender: wireGroupPicker});
  }).catch(function(err){ showToast('error', errMsg(err)); });
}

function openStepEditScopeModal(tplId, stepId, changes){
  openModal('Apply this change to…',
    '<div class="field">'+
      '<div class="check-row"><input type="radio" name="scope" value="all" id="scopeAll" checked><label for="scopeAll">Every task - current episodes and future ones</label></div>'+
      '<div class="check-row"><input type="radio" name="scope" value="future" id="scopeFuture"><label for="scopeFuture">Future episodes only - leave already-generated tasks as they are</label></div>'+
      '<div class="check-row"><input type="radio" name="scope" value="cutoff" id="scopeCutoff"><label for="scopeCutoff">Only tasks/episodes due on or after a date</label></div>'+
      '<input name="cutoffDate" type="date" value="'+todayISO()+'" data-cutoff-field style="margin-top:6px;margin-left:24px;">'+
    '</div>'+
    '<div class="field-hint">The workflow template itself always updates right away, so every future episode picks up the new name/role/group automatically - this choice only controls whether tasks on episodes that already exist get updated too.</div>',
    function(fd){
      setModalBusy(true);
      var scope = fd.get('scope');
      var cutoff = fd.get('cutoffDate');
      db.doc('templates/'+tplId).get().then(function(freshSnap){
        var ft = freshSnap.data();
        var freshSteps = (ft.steps||[]).map(function(s){
          return s.stepId===stepId ? Object.assign({}, s, changes) : s;
        });
        return db.doc('templates/'+tplId).update({steps: freshSteps});
      }).then(function(){
        if(scope==='future') return null;
        // Existing tasks are found the same way the new-step backfill
        // does (round 8.7): every episode generated from this template has
        // a deterministic task id, <episodeId>_<stepId> - no separate
        // "which step did this task come from" column needed on tasks at
        // all, so this is a direct .doc().update() per eligible episode,
        // not a tasks query. A task that's missing for some episode (step
        // added after that episode was generated, since backfilled - or
        // genuinely never backfilled) is skipped rather than failing the
        // whole batch.
        return db.collection('episodes').where('templateId','==',tplId).get().then(function(epSnap){
          var eligible = epSnap.docs.filter(function(d){
            var e = d.data();
            if(e.archived) return false;
            if(scope==='cutoff' && cutoff && e.dueDate < cutoff) return false;
            return true;
          });
          return Promise.all(eligible.map(function(epDoc){
            var taskId = epDoc.id+'_'+stepId;
            return db.doc('tasks/'+taskId).update({ role: changes.role, roles: changes.roles, label: changes.label, group: changes.group }).catch(function(){});
          }));
        });
      }).then(function(){
        closeModal(); showToast('success', 'Step updated');
      }).catch(function(err){ showModalError(errMsg(err)); });
    }, 'Apply', {afterRender: function(form){
      var cutoffField = form.querySelector('[data-cutoff-field]');
      function sync(){ cutoffField.style.display = form.querySelector('[name="scope"]:checked').value==='cutoff' ? '' : 'none'; }
      Array.prototype.forEach.call(form.querySelectorAll('[name="scope"]'), function(r){ r.addEventListener('change', sync); });
      sync();
    }});
}

// ---------- EPISODE DETAIL ----------
var expandedTasks = {};
var taskDescSaveTimers = {}; // taskId -> pending debounce timer for the task-desc textarea (see wireTaskDescBoxes)
// Per-task description box (2026-09-30) - a manager-editable notes/links
// field distinct from "Comments, links & files" (that's a chat-style
// feed of separate messages; this is one persistent field, more like a
// task's own short brief). Auto-grows with content (no internal scrollbar)
// and autosaves shortly after typing stops, plus immediately on blur so a
// quick click-away never drops the last few keystrokes.
function wireTaskDescBoxes(scopeEl){
  Array.prototype.forEach.call(scopeEl.querySelectorAll('.task-desc'), function(ta){
    function resize(){ ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; }
    resize();
    var taskId = ta.getAttribute('data-desc');
    function save(){
      clearTimeout(taskDescSaveTimers[taskId]);
      delete taskDescSaveTimers[taskId];
      db.doc('tasks/'+taskId).update({description: ta.value}).catch(function(err){ showToast('error', errMsg(err)); });
    }
    ta.addEventListener('input', function(){
      resize();
      clearTimeout(taskDescSaveTimers[taskId]);
      taskDescSaveTimers[taskId] = setTimeout(save, 800);
    });
    ta.addEventListener('blur', function(){ if(taskDescSaveTimers[taskId]) save(); });
  });
}
// One instance per episode page (not a loop over many rows, unlike
// wireTaskDescBoxes) - same auto-grow/autosave-on-idle-and-blur behavior,
// just pointed at the episode doc instead of a task doc.
function wireEpisodeDescBox(episodeId){
  var ta = document.getElementById('episodeDescInput');
  if(!ta) return;
  function resize(){ ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; }
  resize();
  var timer = null;
  function save(){
    clearTimeout(timer); timer = null;
    db.doc('episodes/'+episodeId).update({description: ta.value}).catch(function(err){ showToast('error', errMsg(err)); });
  }
  ta.addEventListener('input', function(){ resize(); clearTimeout(timer); timer = setTimeout(save, 800); });
  ta.addEventListener('blur', function(){ if(timer) save(); });
}
function renderEpisode(episodeId){
  paint('<div class="skeleton" style="height:100px;margin-bottom:20px;"></div><div class="skeleton" style="height:300px;"></div>');
  var unsub = db.doc('episodes/'+episodeId).onSnapshot(function(snap){
    if(!snap.exists){ paint('<div class="empty-state"><strong>Episode not found</strong></div>'); return; }
    var e = snap.data();
    delete discussionReadThresholdCache[episodeId]; // fresh page visit - see this cache's own comment for why
    var discussionCollapsed = isDiscussionCollapsed(episodeId);
    paint(
      '<div class="page-head"><div><div class="eyebrow"><a href="#/client/'+e.clientId+'" style="color:var(--muted);text-decoration:none;">'+escapeHtml(e.clientName)+'</a></div>'+
      '<h1 class="page-title">'+escapeHtml(e.title)+(e.archived?' <span class="badge" style="background:var(--line-soft);vertical-align:middle;">Archived</span>':'')+'</h1>'+
      '<div class="page-sub">'+(e.publishDate && e.publishDate!==e.dueDate ? 'Airs '+fmtDateFull(e.publishDate)+' · Deadline '+fmtDateFull(e.dueDate) : fmtDateFull(e.publishDate||e.dueDate))+(e.paid?' · Paid appearance ($'+e.amount+')':'')+'</div></div>'+
      '<div style="display:flex;align-items:flex-start;gap:8px;">'+
      (canManage()?'<button type="button" class="btn btn-sm" id="archiveEpisodeBtn">'+(e.archived?'Unarchive':'Archive')+'</button><button type="button" class="btn btn-sm btn-danger" id="deleteEpisodeBtn">Delete</button>':'')+
      '<div id="epStatusBadge"></div></div></div>'+
      // Two-column layout (Phase 2.5 batch C, item #5's first bullet): the
      // episode's own "Discussion" used to be one more stacked section
      // below the whole checklist - scroll past every task to reach it,
      // and scroll back up to see both at once. Now a persistent,
      // independently-scrolling right-hand panel (.episode-side-panel,
      // see style.css) alongside the checklist instead, same idea as
      // Slack/Linear's own side-panel discussion - loadCollab() itself is
      // unchanged, #epCollab just lives in a different place in the page
      // now. Falls back to a single column under 900px (see the
      // .episode-layout media query) since there's no room for two columns
      // on anything narrower.
      '<div class="episode-layout">'+
      '<div class="episode-main-col">'+
      // Episode-level description (2026-09-30, schema_v26.sql) - separate
      // from the per-task description boxes (each checklist item's own
      // notes/links field, delivered earlier this round and deliberately
      // left untouched) - this one is for the episode as a whole, e.g. a
      // brief or reference links that apply to every task on it.
      (canManage()
        ? '<textarea class="task-desc" id="episodeDescInput" style="margin:0 0 14px;" placeholder="Add a description for this episode as a whole - links, brief, notes…" rows="1">'+escapeHtml(e.description||'')+'</textarea>'
        : (e.description ? '<div class="task-desc-view" style="margin:0 0 14px;">'+linkifyHtml(escapeHtml(e.description))+'</div>' : ''))+
      '<div class="progress-bar"><div class="progress-fill" id="epProgressFill" style="width:0%"></div></div>'+
      (canManage()?'<div style="margin-top:14px;"><button type="button" class="btn btn-sm" id="addCustomTaskBtn">+ Add custom task</button></div>':'')+
      '<div id="taskGroups" style="margin-top:22px;"><div class="skeleton" style="height:200px;"></div></div>'+
      '</div>'+
      '<div class="episode-side-col"><div class="episode-side-panel">'+
      // Collapsible (2026-09-24 request) - the header row itself toggles
      // it, with an unread badge that only shows while collapsed (once
      // you've actually opened it, seeing it counts as read - see
      // updateDiscussionHeaderAndReadState() in loadCollab).
      '<div class="section-head discussion-head" id="discussionHeadRow"><h2 class="section-title">Discussion</h2>'+
      '<div id="discussionUnreadBadge" style="display:flex;gap:6px;"></div>'+
      '<button type="button" class="task-expand-btn" id="discussionToggleBtn" style="margin-left:auto;">'+(discussionCollapsed?'Show':'Hide')+'</button>'+
      '</div>'+
      '<div id="discussionBody"'+(discussionCollapsed?' hidden':'')+'>'+
      '<div class="page-sub" style="margin:-6px 0 12px;">General chat about this episode as a whole - for a specific subtask, use "Comments, links &amp; files" on that task instead.</div>'+
      '<div id="epCollab" class="episode-side-scroll"><div class="skeleton" style="height:120px;"></div></div>'+
      '</div>'+
      '</div></div>'+
      '</div>'
    );
    (function(){
      var toggleBtn = document.getElementById('discussionToggleBtn');
      var body = document.getElementById('discussionBody');
      if(toggleBtn && body) toggleBtn.addEventListener('click', function(){
        var collapsed = body.hasAttribute('hidden');
        if(collapsed){
          body.removeAttribute('hidden');
          var badge = document.getElementById('discussionUnreadBadge'); if(badge) badge.innerHTML='';
          markDiscussionRead('episode', episodeId);
        } else {
          body.setAttribute('hidden','');
        }
        setDiscussionCollapsed(episodeId, !collapsed);
        toggleBtn.textContent = collapsed ? 'Hide' : 'Show';
      });
    })();

    wireEpisodeDescBox(episodeId);
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
      deleteEpisodeWithUndo(episodeId, e.title, e.clientId);
      location.hash = '#/client/'+e.clientId;
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
          var tplData = (tplSnap.exists && tplSnap.data()) || {};
          var stepById = {};
          (tplData.steps||[]).forEach(function(s){ stepById[s.stepId] = s; });
          return { stepById: stepById };
        }).catch(function(){ return { stepById: {} }; }) // fails open - a template fetch error shouldn't block the checklist from rendering, just means dependencies fall back to each task's own baked-in copy
      : Promise.resolve({ stepById: {} });

    tplStepByIdPromise.then(function(tplInfo){
    var liveStepById = tplInfo.stepById;
    // Comment-count badge on "Comments, links & files" (Phase 2.5 batch A,
    // fixed 2026-09-27): refreshCountsNow always points at the CURRENT
    // tasks-snapshot's own fetch-and-render closure (reassigned every time
    // the tasks listener below fires) - see the separate taskComments
    // subscription a little further down for why this indirection exists.
    var refreshCountsNow = null;
    var unsubTasks = db.collection('tasks').where('episodeId','==',episodeId).orderBy('orderNum','asc').onSnapshot(function(ts){
      var box = document.getElementById('taskGroups');
      if(!box) return;
      if(ts.empty){ box.innerHTML = '<div class="empty-state">No tasks on this episode.</div>'; return; }
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
      // Group HEADER blocks (re-fixed 2026-09-28, replacing the "stable
      // groupOrder" approach from Phase 2.5 batch A). That earlier fix
      // pinned every group name to ONE fixed header slot, independent of
      // step order - which stopped one step's drag from dragging its whole
      // group's header along with it, but broke a different, more literal
      // expectation: dragging a step OUT of its own group's run and into
      // the middle of another group's steps should show that step under
      // its OWN group's header, right where it landed - splitting the
      // group it landed inside into two separate header blocks around it
      // (e.g. drag "xyz" from "Editing" to between two "Publishing"
      // steps -> Publishing, then a one-item "Editing" block, then
      // Publishing continues). A fixed one-slot-per-name order can never
      // show that split. Fixed for real by deriving header blocks straight
      // from live step order: walk the live-ordered tasks and start a NEW
      // block every time the group changes from the previous task, even if
      // that group name was already seen earlier. Within a block, tasks
      // are already in liveOrderNum order since blocks are built by
      // walking liveOrderedDocs in order.
      //
      // A done task is NOT pulled out into a separate "Completed" bucket
      // any more (reverted 2026-09-28, per Humayun: a task should stay
      // exactly where it sits in its group when checked off, not jump to
      // the bottom of the checklist) - it just flows into its block like
      // any other task, in the same live step-order position, and gets its
      // usual dimmed/struck-through ".done" styling (taskRowHtml/style.css)
      // right there. This is now just about episodes, not individual
      // tasks - see the client detail page's episode list for the
      // completed-EPISODE segment (Phase 2.5 batch B, round 10).
      var blocks = [];
      liveOrderedDocs.forEach(function(d){
        var t = taskById[d.id];
        var g = t.group||'Tasks';
        var last = blocks[blocks.length-1];
        if(!last || last.group!==g){ last = {group:g, tasks:[]}; blocks.push(last); }
        last.tasks.push(t);
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
      // Comment-count badge: one grouped query for every task on this
      // episode, rather than one query per task row - counted client-side
      // same as listAllRoles() groups profileRoles by userId.
      //
      // Fixed 2026-09-27 (originally shipped batch A, confirmed broken:
      // "Comments counts still doesn't exist"): this query used to only
      // ever run when the TASK list itself re-fired (a task added, checked
      // off, or deleted) - but posting, editing or deleting a COMMENT only
      // ever writes to the taskComments table, never to tasks, so nothing
      // told this page to re-fetch counts after the one thing that
      // actually changes them. From a fresh page load the very first count
      // fetch below still ran and should have shown existing comments, but
      // the badge could then never advance again without some unrelated
      // task change forcing a re-render - which is exactly "count never
      // shows" from the perspective of someone who opens a discussion,
      // posts a comment, and closes it again expecting the number to
      // appear. Fix: a SEPARATE live subscription on taskComments itself
      // (set up once, right after unsubTasks below) now calls whatever
      // this constant's current closure is via refreshCountsNow, so any
      // comment add/edit/delete - anywhere - re-fetches counts and
      // re-renders this episode's checklist with them, the same "global
      // table subscription, filtered query on each refetch" pattern the
      // tasks listener itself already uses.
      function fetchCommentCounts(){
        var taskIds = ts.docs.map(function(d){ return d.id; });
        return (taskIds.length ? db.collection('taskComments').where('taskId','in',taskIds).get() : Promise.resolve({docs:[]}))
          .then(function(cSnap){
            var counts = {};
            cSnap.docs.forEach(function(d){ var row=d.data(); counts[row.taskId]=(counts[row.taskId]||0)+1; });
            return counts;
          })
          .catch(function(){ return {}; }); // fails open - still render the checklist without counts if this one query fails
      }
      // Phase 5 fix (2026-09-29, "the screen starts loading" every time a
      // message is sent): this used to call renderChecklist(counts) - a
      // full box.innerHTML rebuild of every task row - on EVERY taskComments
      // change anywhere in the episode (see unsubComments below, which has
      // no filter). That tore down and recreated every already-expanded
      // "Comments, links & files" panel's DOM node from scratch, which lost
      // the data-collab-ready flag loadCollab() relies on to skip its
      // blank-skeleton loading state on a reload - so sending your own
      // message re-triggered the exact jarring blank-screen flash that fix
      // was supposed to prevent. refreshCountsNow now only does that full
      // rebuild on the very first render (when the task list itself needs
      // building); every later comment-driven refresh just patches each
      // closed task's count label in place and re-loads an already-open
      // panel on its EXISTING node (loadCollab's own fade-in path handles
      // that smoothly) - nothing gets torn down.
      refreshCountsNow = function(){
        fetchCommentCounts().then(function(counts){
          Array.prototype.forEach.call(box.querySelectorAll('[data-collab]'), function(btn){
            var taskId = btn.getAttribute('data-collab');
            if(expandedTasks[taskId]){
              var panel = document.getElementById('collab_'+taskId);
              if(panel) loadTaskCollab(taskId, panel);
            } else {
              btn.textContent = 'Comments, links & files'+(counts[taskId]?' ('+counts[taskId]+')':'');
            }
          });
        });
      };
      fetchCommentCounts().then(renderChecklist);

      function taskRowHtml(t, commentCounts){
        var roleKeys = taskRoleKeys(t);
        var r = roleOf(roleKeys[0]); // first role's color drives the row's left-border accent
        var unmet = depTasksFor(t).filter(function(dt){ return !dt.done; });
        var isBlocked = unmet.length>0;
        var canCheck = (roleKeys.some(function(rk){ return myRoles.indexOf(rk)>-1; }) || canManage()) && !isBlocked;
        var waitingLabel = unmet.map(function(dt){ return dt.label; }).join(', ');
        var cCount = commentCounts[t._id]||0;
        var roleChipsHtml = roleKeys.length ? roleKeys.map(function(rk){
          var rr = roleOf(rk);
          return '<span class="role-chip" style="background:'+(rr?rr.color:'#888')+'">'+(rr?escapeHtml(rr.label):escapeHtml(rk))+'</span>';
        }).join('') : '';
        return '<div class="task-row '+(t.done?'done':'')+(isBlocked?' task-blocked':'')+'" style="--role-color:'+(r?r.color:'var(--line)')+'">'+
          '<input type="checkbox" class="task-check" data-task="'+t._id+'" '+(t.done?'checked':'')+' '+(canCheck?'':'disabled')+' '+(isBlocked?'title="Locked until \''+escapeHtml(waitingLabel)+'\' '+(unmet.length>1?'are':'is')+' done"':'')+'>'+
          '<div class="task-body"><div class="task-label">'+escapeHtml(t.label)+(t.custom?' <span class="task-custom-badge">custom</span>':'')+'</div>'+
          '<div class="task-meta">'+roleChipsHtml+
          (isBlocked?'<span class="task-waiting">⛔ Waiting on: '+escapeHtml(waitingLabel)+'</span>':'')+
          (t.done && t.doneByUserId?profileChip(t.doneByUserId):'')+
          '</div>'+
          (canManage()
            ? '<textarea class="task-desc" data-desc="'+t._id+'" placeholder="Add a description, links, or notes for this task…" rows="1">'+escapeHtml(t.description||'')+'</textarea>'
            : (t.description ? '<div class="task-desc-view">'+linkifyHtml(escapeHtml(t.description))+'</div>' : ''))+
          '<button type="button" class="task-expand-btn" data-collab="'+t._id+'">'+(expandedTasks[t._id]?'Hide discussion':'Comments, links & files'+(cCount?' ('+cCount+')':''))+'</button>'+
          '<div class="task-collab" id="collab_'+t._id+'" '+(expandedTasks[t._id]?'':'hidden')+'></div>'+
          '</div>'+
          (canManage()?'<button type="button" class="icon-btn" data-delete-task="'+t._id+'" data-label="'+escapeHtml(t.label)+'" title="Delete task">'+ICON_TRASH+'</button>':'')+
          '</div>';
      }
      function renderChecklist(commentCounts){
      function rowHtml(t){ return taskRowHtml(t, commentCounts); }
      box.innerHTML = blocks.map(function(block){
        return '<div class="checklist-group"><div class="checklist-group-head"><span class="checklist-group-title">'+escapeHtml(block.group)+'</span></div>'+
          block.tasks.map(rowHtml).join('')+
          '</div>';
      }).join('');
      hydrateProfiles(box);
      wireTaskDescBoxes(box);
      Array.prototype.forEach.call(box.querySelectorAll('.task-check:not([disabled])'), function(cb){
        cb.addEventListener('change', function(){
          var taskId = cb.getAttribute('data-task');
          var checked = cb.checked;
          db.doc('tasks/'+taskId).update({
            done: checked,
            doneByUserId: checked ? myUid : null,
            doneAt: checked ? new Date().toISOString() : null
          }).then(function(){
            if(!checked) return;
            var t = taskById[taskId];
            if(!t) return;
            logActivity('task', 'task_item_done', { clientId: t.clientId, episodeId: t.episodeId, taskId: taskId, label: t.label });
            // Whole-episode completion (Humayun's "every time the entire
            // task got completed" - in this app's own vocabulary, an
            // episode's checklist IS its "task", so this fires once the
            // LAST checklist item on it gets checked off).
            db.collection('tasks').where('episodeId','==',t.episodeId).get().then(function(snap){
              var allDone = snap.docs.every(function(d){ return d.id===taskId || d.data().done; });
              if(allDone) logActivity('task', 'episode_completed', { clientId: t.clientId, episodeId: t.episodeId, label: t.episodeTitle||t.label });
            }).catch(function(){});
          }).catch(function(err){ cb.checked=!checked; showToast('error', errMsg(err)); });
        });
      });
      Array.prototype.forEach.call(box.querySelectorAll('[data-delete-task]'), function(btn){
        btn.addEventListener('click', function(){
          var taskId = btn.getAttribute('data-delete-task');
          var label = btn.getAttribute('data-label');
          var row = btn.closest('.task-row');
          if(row) row.classList.add('pending-remove');
          // taskById's entries carry a JS-side-only "_id" field (set above,
          // for lookups - not a real column) - stripped here before using
          // this as a restore snapshot, otherwise the shim's upsert sends
          // it straight through and Postgres rejects the whole write with
          // "Could not find the '_id' column of 'tasks' in the schema
          // cache" (confirmed 2026-09-28 - Undo failed for a deleted task/
          // step specifically, while every other Undo already worked,
          // because nothing else builds its restore snapshot from this
          // particular cache).
          var taskData = taskById[taskId] ? Object.assign({}, taskById[taskId]) : null;
          if(taskData) delete taskData._id;
          Promise.all([
            db.collection('taskComments').where('taskId','==',taskId).get(),
            db.collection('taskLinks').where('taskId','==',taskId).get(),
            db.collection('taskAttachments').where('taskId','==',taskId).get(),
          ]).then(function(subs){
            var children = tuples('taskComments', subs[0].docs).concat(tuples('taskLinks', subs[1].docs)).concat(tuples('taskAttachments', subs[2].docs));
            return db.doc('tasks/'+taskId).delete().then(function(){
              actionWithUndo('"'+label+'" deleted', function(){
                restoreSnapshot([[{col:'tasks', id:taskId, data:taskData}], children])
                  .then(function(){ showToast('success','Restored'); })
                  .catch(function(err){ showToast('error','Restore failed - '+errMsg(err)); });
              });
            });
          }).catch(function(err){ showToast('error', errMsg(err)); if(row) row.classList.remove('pending-remove'); });
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
    // See fetchAndRenderCounts above - this is what actually makes the
    // comment-count badge move without needing an unrelated task change to
    // force a re-render. No filter on the channel (same as every other
    // db.collection(...).onSnapshot() in this file) - any comment change
    // anywhere just re-runs the CURRENT tasks snapshot's own filtered
    // count query, which is cheap and already how the rest of this page's
    // "live" data works.
    var unsubComments = db.collection('taskComments').onSnapshot(function(){
      if(refreshCountsNow) refreshCountsNow();
    }, function(){});
    activeUnsubs.push(unsubComments);
    }); // end tplStepByIdPromise.then
  }, function(){ paint('<div class="empty-state">Could not load this episode.</div>'); });
  activeUnsubs.push(unsub);
}

function openAddCustomTaskModal(episodeId, episode){
  db.doc('clients/'+episode.clientId).get().then(function(cSnap){
    var teamId = (cSnap.data()||{}).teamId;
    var roleChecksHtml = assignableTaskRoles(teamId).map(function(r){
      return '<label style="display:flex;align-items:center;gap:5px;font-size:12.5px;padding:2px 0;"><input type="checkbox" name="roles" value="'+r.key+'">'+escapeHtml(r.label)+'</label>';
    }).join('');
    openModal('Add a custom task', '<div class="field"><label>What needs doing</label><input required name="label" type="text" placeholder="e.g. Cut a bonus 60-second teaser"></div>'+
    '<div class="field-row"><div class="field"><label>Role(s) - pick any number</label><div style="max-height:140px;overflow:auto;border:1px solid var(--line);border-radius:8px;padding:6px 8px;">'+roleChecksHtml+'</div></div>'+
    '<div class="field"><label>Group</label><input name="group" type="text" placeholder="e.g. Editing"></div></div>',
    function(fd){
      var label = (fd.get('label')||'').trim();
      if(!label){ showModalError('Describe the task.'); return; }
      var roles = fd.getAll('roles');
      if(!roles.length){ showModalError('Pick at least one role.'); return; }
      setModalBusy(true);
      var taskId = episodeId+'_custom_'+uid8();
      db.doc('tasks/'+taskId).set({
        episodeId: episodeId, episodeTitle: episode.title, clientId: episode.clientId, clientName: episode.clientName,
        role: roles[0], roles: roles, label: label, group: (fd.get('group')||'').trim(), orderNum: 999, dependsOnStepIds: [],
        dueDate: episode.dueDate, done:false, doneByUserId:null, doneAt:null, custom:true, createdAt: new Date().toISOString()
      }).then(function(){
        closeModal(); showToast('success','Custom task added');
        roles.forEach(function(rk){ notifyRoleAssignment(rk, label, episode.title, episode.clientName, '#/episode/'+episodeId, episode.clientId); });
      }).catch(function(err){ showModalError(errMsg(err)); });
    }, 'Add task');
  }).catch(function(err){ showToast('error', errMsg(err)); });
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

// ---- Discussion unread tracking (2026-09-24, schema_v30.sql) ----
// Episode-level "Discussion" only (explicitly NOT the per-task "Comments,
// links & files" boxes - those keep their existing behavior untouched).
// One row per (person, thread) recording "I've seen this up to here" -
// read/written for the CURRENT user only, so the plain upsert via
// db.doc(...).set() is safe (see schema_v30.sql's own comment on why this
// isn't the notifications upsert pitfall from CLAUDE.md).
function discussionReadId(threadType, threadId){ return myUid+':'+threadType+':'+threadId; }
function getDiscussionLastRead(threadType, threadId){
  return db.doc('discussionReads/'+discussionReadId(threadType, threadId)).get()
    .then(function(s){ return (s.exists && s.data().lastReadAt) ? new Date(s.data().lastReadAt) : null; })
    .catch(function(){ return null; });
}
function markDiscussionRead(threadType, threadId){
  return db.doc('discussionReads/'+discussionReadId(threadType, threadId)).set({
    userId: myUid, threadType: threadType, threadId: threadId, lastReadAt: new Date().toISOString()
  }).catch(function(){});
}
// Cached per episodeId for the length of ONE page visit (cleared at the top
// of renderEpisode's onSnapshot) - loadCollab() reloads itself after every
// send/edit/delete/react on THIS SAME visit, and re-fetching (and thereby
// advancing) the read marker on each of those reloads would make the "New"
// highlighting vanish the instant you, say, sent a reply - not because you
// actually went and re-read the older messages, just because the panel
// happened to redraw. Freezing the threshold for the whole visit and only
// ever WRITING a fresh one (never reading it back into this cache) is what
// keeps "what's new since I last opened this" stable for as long as you're
// looking at it.
var discussionReadThresholdCache = {};
function collapsedDiscussionKey(episodeId){ return 'bko_discussionCollapsed_'+episodeId; }
function isDiscussionCollapsed(episodeId){ try{ return localStorage.getItem(collapsedDiscussionKey(episodeId))==='1'; }catch(e){ return false; } }
function setDiscussionCollapsed(episodeId, collapsed){ try{ localStorage.setItem(collapsedDiscussionKey(episodeId), collapsed?'1':'0'); }catch(e){} }
var ICON_PENCIL = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>';
var ICON_BACK = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5"/><path d="M12 19l-7-7 7-7"/></svg>';
var ICON_TRASH = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0-1 14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2L4 6"/></svg>';
var ICON_SOUND_ON = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="4 9 9 9 13 5 13 19 9 15 4 15 4 9"/><path d="M17.5 8.5a5 5 0 0 1 0 7"/><path d="M20.3 6a9 9 0 0 1 0 12"/></svg>';
var ICON_SOUND_OFF = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="4 9 9 9 13 5 13 19 9 15 4 15 4 9"/><line x1="17" y1="9" x2="23" y2="15"/><line x1="23" y1="9" x2="17" y2="15"/></svg>';
var ICON_REPLY = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 17 4 12l5-5"/><path d="M4 12h10a4 4 0 0 1 4 4v2"/></svg>';
var ICON_CHECK_CIRCLE = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="M22 4 12 14.01l-3-3"/></svg>';
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
// @mention autocomplete roster (Phase 4) - every profile, fetched once per
// session and cached (not per-panel) since it barely ever changes and
// every composer on every task/episode discussion needs the same list.
var mentionRosterCache = null;
function getMentionRoster(){
  if(mentionRosterCache) return Promise.resolve(mentionRosterCache);
  return db.collection('profiles').get().then(function(snap){
    mentionRosterCache = snap.docs.map(function(d){ var p=d.data(); return {id:d.id, name:p.displayName||p.email||'Someone'}; });
    return mentionRosterCache;
  }).catch(function(){ return []; });
}
function loadCollab(kind, id, panel){
  var cfg = COLLAB_TABLES[kind];
  // Phase 5 polish: this used to blank the whole thread to a shimmering
  // skeleton on EVERY reload, including right after sending your own
  // message - meaning the message you just typed, the composer, and the
  // rest of the thread all flashed away and reloaded from scratch on every
  // single send. Only do that jarring full-blank on the true first load;
  // every reload after that (send/edit/delete/react/etc., all of which
  // call this same function to refresh) now keeps the current thread
  // visible while refetching, then fades the refreshed content in.
  var isReload = panel.getAttribute('data-collab-ready')==='1';
  if(!isReload) panel.innerHTML = '<div class="skeleton" style="height:40px;"></div>';
  // Episode discussion only - see discussionReadThresholdCache's own
  // comment for why this is cached per page-visit instead of re-fetched
  // (and thereby re-advanced) on every one of this function's own reloads.
  var discussionReadPromise = kind==='episode'
    ? (id in discussionReadThresholdCache ? Promise.resolve(discussionReadThresholdCache[id]) : getDiscussionLastRead('episode', id).then(function(t){ discussionReadThresholdCache[id]=t; return t; }))
    : Promise.resolve(null);
  Promise.all([
    supabase.from(cfg.comments).select('*').eq(cfg.idField, id).order('createdAt', { ascending: true }),
    supabase.from(cfg.links).select('*').eq(cfg.idField, id).order('createdAt', { ascending: true }),
    supabase.from(cfg.attachments).select('*').eq(cfg.idField, id).order('createdAt', { ascending: true }),
    discussionReadPromise,
  ]).then(function(res){
    var comments = res[0].data||[], links = res[1].data||[], attachments = res[2].data||[];
    var discussionReadThreshold = res[3]; // Date|null, episode kind only
    var commentIds = comments.map(function(c){ return c.id; });
    var reactionsPromise = commentIds.length
      ? supabase.from('commentReactions').select('*').eq('kind', kind).in('commentId', commentIds)
      : Promise.resolve({ data: [] });
    return reactionsPromise.then(function(rres){
      var reactions = (rres && rres.data) || [];
      // Real bug (2026-09-29): mentioned people weren't in this list at all,
      // only authors/link-adders/uploaders/reactors - so who(uid) fell back
      // to "Someone" for anyone mentioned who hadn't ALSO posted something
      // else in this exact thread, and mentionifyHtml() deliberately skips
      // highlighting a "Someone". Looked like a task-vs-episode difference
      // (worked in one discussion, not another) but was really just "does
      // this thread happen to already include the mentioned person" -
      // mentioned ids now always get fetched too.
      var ids = comments.map(function(c){return c.authorId;}).concat(links.map(function(l){return l.addedBy;})).concat(attachments.map(function(a){return a.uploadedBy;})).concat(reactions.map(function(r){return r.userId;})).concat(comments.reduce(function(acc,c){return acc.concat(c.mentions||[]);},[])).filter(Boolean);
      return fetchProfiles(ids).then(function(ps){
      var editingComment = null, editingLink = null; // id of the row currently in inline-edit mode, if any
      var pendingFile = null; // File staged for the NEXT send, via the composer's attach button
      var openPicker = null; // commentId whose reaction picker is currently open, if any
      // Reply-to-comment threading (Phase 2.5 batch C, one level deep - see
      // schema_v13.sql): the id of the TOP-LEVEL comment the next message
      // will be posted as a reply to, or null for an ordinary top-level
      // message. Only top-level comments show their own "Reply" button
      // (renderComment's isReply flag), so this can never point at a
      // reply itself - a reply to a reply just joins the same thread.
      var replyingTo = null;
      // @mentions (Phase 4) - id -> display name, for whoever's been
      // picked from the autocomplete since the composer was last cleared.
      // Cleared on send; NOT reset by a plain render() (someone attaching
      // a file after already picking a mention shouldn't lose it).
      var pendingMentions = {};
      // Unread tracking (episode discussion only) - "unread" means posted
      // by someone else, after the threshold fetched at the top of this
      // page visit. firstUnread anchors the single "New" divider; the rest
      // just get the highlighted-row treatment.
      var unreadComments = (kind==='episode' && discussionReadThreshold)
        ? comments.filter(function(c){ return c.authorId!==myUid && new Date(c.createdAt) > discussionReadThreshold; })
        : [];
      var firstUnread = unreadComments.length ? unreadComments.reduce(function(a,b){ return new Date(a.createdAt)<new Date(b.createdAt)?a:b; }) : null;
      var hasUnreadMention = unreadComments.some(function(c){ return (c.mentions||[]).indexOf(myUid)>-1; });
      function isUnreadComment(c){ return unreadComments.indexOf(c)>-1; }
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

      // Consecutive-message grouping (round 12): the single biggest reason
      // a plain comment list reads as dated/"IRC-like" is repeating the
      // same avatar+name+timestamp on every line even when one person
      // just sent three messages in a row. Same author, within 5 minutes
      // of the previous message, in the same list (top-level feed or one
      // reply thread - callers reset prev between the two) -> grouped: no
      // avatar/name/date header, just the text, with the exact time
      // available on hover in the gutter where the avatar would be.
      var GROUP_WINDOW_MS = 5*60*1000;
      function isContinuation(prev, cur){
        if(!prev || prev.authorId!==cur.authorId) return false;
        var dt = new Date(cur.createdAt) - new Date(prev.createdAt);
        return dt>=0 && dt<GROUP_WINDOW_MS;
      }
      function renderComment(c, isReply, grouped){
        if(editingComment===c.id){
          return '<div class="comment-row" data-id="'+c.id+'">'+avatarFor(c.authorId)+
            '<div class="comment-main"><div class="comment-row-head"><span class="comment-author">'+escapeHtml(who(c.authorId))+'</span></div>'+
            '<div class="comment-edit-box"><textarea class="comment-edit-input" data-comment-edit-input>'+escapeHtml(c.body)+'</textarea>'+
            '<div class="comment-edit-actions"><button type="button" class="btn btn-sm" data-save-comment="'+c.id+'">Save</button><button type="button" class="btn btn-sm btn-ghost" data-cancel-comment>Cancel</button></div></div></div></div>';
        }
        var attHtml = attachmentsByComment[c.id] ? '<div class="attachment-grid comment-inline-attachments">'+attachmentsByComment[c.id].map(attachmentItemHtml).join('')+'</div>' : '';
        // Reply is only offered on a top-level comment (isReply falsy) -
        // replying to a reply just joins the same thread instead of
        // nesting further, see the note above `replyingTo`.
        var replyBtn = !isReply ? '<button type="button" class="icon-btn" data-reply-comment="'+c.id+'" title="Reply">'+ICON_REPLY+'</button>' : '';
        // Built directly (not via the shared actionButtons() links also
        // use) so the reply button can live in the same floating toolbar
        // as edit/delete instead of a separate control.
        var editBtn = canEditRow(c.authorId) ? '<button type="button" class="icon-btn" data-edit-comment="'+c.id+'" title="Edit">'+ICON_PENCIL+'</button>' : '';
        var delBtn = canDeleteRow(c.authorId) ? '<button type="button" class="icon-btn" data-delete-comment="'+c.id+'" title="Delete">'+ICON_TRASH+'</button>' : '';
        var actions = (replyBtn||editBtn||delBtn) ? '<span class="comment-actions">'+replyBtn+editBtn+delBtn+'</span>' : '';
        var gutter = grouped
          ? '<span class="comment-gutter-time" title="'+escapeHtml(fmtDateTime(c.createdAt))+'">'+fmtTimeShort(c.createdAt)+'</span>'
          : avatarFor(c.authorId);
        var head = grouped ? '' :
          '<div class="comment-row-head">'+
          '<span class="comment-author">'+escapeHtml(who(c.authorId))+'</span>'+
          '<span class="comment-time">'+fmtDateTime(c.createdAt)+'</span>'+
          (c.editedAt?'<span class="comment-edited-tag">(edited)</span>':'')+
          '</div>';
        // A grouped message has no header to hang "(edited)" off of - put
        // it inline after the body instead, so that info still shows up.
        var editedInline = (grouped && c.editedAt) ? ' <span class="comment-edited-tag">(edited)</span>' : '';
        var html = '<div class="comment-row'+(grouped?' comment-row-grouped':'')+(isUnreadComment(c)?' comment-unread':'')+'" data-id="'+c.id+'">'+gutter+
          '<div class="comment-main">'+actions+head+
          (c.body?'<div class="comment-body">'+mentionifyHtml(linkifyHtml(escapeHtml(c.body)), c.mentions, who)+editedInline+'</div>':'')+
          attHtml+renderReactions(c.id)+
          '</div></div>';
        // The single "New" divider - anchors the "Jump to unread" button
        // below, and marks where THIS person's own unseen messages start.
        if(firstUnread && firstUnread.id===c.id) html = '<div class="discussion-unread-divider" id="unreadDivider_'+id+'"><span>New</span></div>'+html;
        return html;
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

      // Clears every message in this discussion at once (Humayun's ask,
      // 2026-09-29) - a manager/admin-only bulk action, same access tier
      // the existing per-comment delete RLS policy already grants for
      // someone else's comment (see supabase/schema_v5.sql's "...delete"
      // policies: author, admin, or a manager of that comment's own team -
      // canManage() here is just the client-side mirror of that same
      // check). Reactions have no FK cascade onto the comment tables (see
      // schema_v6.sql), so they're deleted explicitly; attachments DO
      // cascade at the database level, so they're only snapshotted here
      // (for Undo) and not separately deleted.
      function clearAllComments(){
        if(!comments.length) return;
        var n = comments.length;
        if(!confirm('Delete all '+n+' message'+(n===1?'':'s')+' in this discussion? This also removes their attachments and reactions - use Undo right after if you change your mind.')) return;
        var commentIds = comments.map(function(c){ return c.id; });
        var reactionSnap = reactions.filter(function(r){ return commentIds.indexOf(r.commentId)>-1; });
        var attachmentSnap = attachments.filter(function(a){ return a.commentId && commentIds.indexOf(a.commentId)>-1; });
        var commentTuples = comments.map(function(c){ return {col:cfg.comments, id:c.id, data:c}; });
        var reactionTuples = reactionSnap.map(function(r){ return {col:'commentReactions', id:r.id, data:r}; });
        var attachmentTuples = attachmentSnap.map(function(a){ return {col:cfg.attachments, id:a.id, data:a}; });
        Promise.all(
          commentIds.map(function(cid){ return db.doc(cfg.comments+'/'+cid).delete(); })
            .concat(reactionSnap.map(function(r){ return db.doc('commentReactions/'+r.id).delete(); }))
        ).then(function(){
          actionWithUndo('Cleared '+n+' message'+(n===1?'':'s'), function(){
            restoreSnapshot([commentTuples, reactionTuples.concat(attachmentTuples)])
              .then(function(){ showToast('success','Restored'); loadCollab(kind,id,panel); })
              .catch(function(err){ showToast('error','Restore failed - '+errMsg(err)); });
          });
          loadCollab(kind,id,panel);
        }).catch(function(err){ showToast('error', errMsg(err)); });
      }

      function render(){
        // Thread the flat comments list into top-level messages + their
        // replies (one level deep - see the note above `replyingTo`).
        // Reads live off the just-fetched `comments` array every render,
        // so a reply posted by someone else lands in the right thread the
        // next time this panel reloads, same as any other comment.
        var topLevelComments = comments.filter(function(c){ return !c.parentId; });
        var repliesByParent = {};
        comments.forEach(function(c){ if(c.parentId) (repliesByParent[c.parentId]=repliesByParent[c.parentId]||[]).push(c); });
        var replyTarget = replyingTo ? comments.filter(function(c){ return c.id===replyingTo; })[0] : null;
        if(replyingTo && !replyTarget) replyingTo = null; // its parent got deleted from under us - fails open, back to an ordinary top-level message
        // Consecutive-message grouping (round 12) - see isContinuation():
        // tracked per list, reset between the top-level feed and each
        // individual reply thread, so a thread's first reply is never
        // "grouped" against whatever the last top-level message happened
        // to be.
        var prevTop = null;
        panel.setAttribute('data-collab-ready','1');
        panel.innerHTML =
          (firstUnread ? '<button type="button" class="discussion-jump-unread-btn" id="jumpUnreadBtn_'+id+'">'+(hasUnreadMention?'🔔 Jump to where you were mentioned':'↓ Jump to new messages')+'</button>' : '')+
          (comments.length && canManage() ? '<button type="button" class="collab-clear-all-btn" id="clearAllBtn_'+id+'">Clear all messages</button>' : '')+
          '<div class="collab-list collab-fade-in">'+
            (topLevelComments.length ? topLevelComments.map(function(c){
              var topGrouped = isContinuation(prevTop, c);
              prevTop = c;
              var replies = repliesByParent[c.id]||[];
              var prevReply = null;
              var repliesHtml = replies.map(function(r){
                var rGrouped = isContinuation(prevReply, r);
                prevReply = r;
                return renderComment(r,true,rGrouped);
              }).join('');
              return renderComment(c,false,topGrouped) + (replies.length ? '<div class="comment-thread">'+repliesHtml+'</div>' : '');
            }).join('') : '<div class="collab-empty">No comments yet - start the discussion below.</div>') +
          '</div>'+
          (links.length?'<div class="collab-list collab-links">'+links.map(renderLink).join('')+'</div>':'')+
          (standaloneAttachments.length?'<div class="attachment-grid">'+standaloneAttachments.map(attachmentItemHtml).join('')+'</div>':'')+
          '<div class="composer">'+
          (replyTarget?'<div class="composer-reply-banner">Replying to <strong>'+escapeHtml(who(replyTarget.authorId))+'</strong>'+(replyTarget.body?' · '+escapeHtml(replyTarget.body.length>80?replyTarget.body.slice(0,80)+'…':replyTarget.body):'')+'<button type="button" id="cancelReply_'+id+'" title="Cancel reply">✕</button></div>':'')+
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
        if(kind==='episode') updateDiscussionHeaderAndReadState();
      }

      // Header badge lives outside this panel (renderEpisode's own
      // #discussionUnreadBadge, next to the collapse toggle) so it stays
      // visible even while the panel body is collapsed - see
      // #discussionBody in renderEpisode. Only shows while collapsed:
      // once the body is actually visible, that already counts as "seen",
      // same as Slack/Gmail clearing an unread badge the moment you open
      // the thread (the highlighted rows + "New" divider inside stick
      // around for the rest of THIS viewing, though - see
      // discussionReadThresholdCache's comment for why).
      function updateDiscussionHeaderAndReadState(){
        var body = document.getElementById('discussionBody');
        var expanded = !body || !body.hasAttribute('hidden');
        var badge = document.getElementById('discussionUnreadBadge');
        if(badge){
          badge.innerHTML = (!expanded && unreadComments.length)
            ? (hasUnreadMention
                ? '<span class="badge" style="background:var(--overdue-soft);color:var(--overdue);">@ you</span>'
                : '<span class="badge" style="background:var(--blue-soft);color:var(--blue-2);">'+unreadComments.length+' new</span>')
            : '';
        }
        // Always bump the read marker while expanded, even with nothing
        // currently unread - a brand-new discussion has no marker at all
        // yet (discussionReadThreshold starts out null, so nothing is
        // flagged unread on that very first visit), and without writing
        // ONE here there'd never be a baseline for a LATER visit to
        // compare against - the whole feature would silently never turn on.
        if(expanded) markDiscussionRead('episode', id);
      }

      function autoGrow(ta){
        ta.style.height = 'auto';
        ta.style.height = Math.min(ta.scrollHeight, 160) + 'px';
      }

      // Finds the episode a mention notification should link to - trivial
      // for the episode discussion itself, needs one lookup for a task
      // comment since tasks don't have their own route (only their parent
      // episode's checklist does).
      function mentionLinkFor(){
        if(kind==='episode') return Promise.resolve('#/episode/'+id);
        return db.doc('tasks/'+id).get().then(function(snap){
          var t = snap.exists && snap.data();
          return t ? '#/episode/'+t.episodeId : '#/';
        }).catch(function(){ return '#/'; });
      }
      // Whoever was actually CLICKED from the autocomplete is always
      // included, but that alone turned out to miss real mentions - typing
      // "@Name" and hitting Enter before the suggestion list finished
      // loading (or before clicking it) left `pendingMentions` empty, so
      // nothing was ever recorded and notifyMentions() below had nothing
      // to do (confirmed 2026-09-28: a real mention sent no notification
      // at all). Backstop: also scan the final message text for "@Full
      // Name" matching a real teammate exactly, even if it was never
      // clicked - catches that case without requiring the click to have
      // happened.
      function resolveMentionedIds(body, clickedIds){
        return getMentionRoster().then(function(roster){
          var ids = {};
          clickedIds.forEach(function(uid){ ids[uid] = true; });
          var lowerBody = body.toLowerCase();
          roster.forEach(function(p){
            if(lowerBody.indexOf('@'+p.name.toLowerCase())>-1) ids[p.id] = true;
          });
          return Object.keys(ids);
        }).catch(function(){ return clickedIds; });
      }
      function notifyMentions(mentionedIds, body){
        if(!mentionedIds.length) return;
        mentionLinkFor().then(function(link){
          var fromName = (myProfile && myProfile.displayName) || 'Someone';
          var snippet = body.length>60 ? body.slice(0,60)+'…' : body;
          mentionedIds.forEach(function(uid){
            if(uid===myUid) return; // mentioning yourself doesn't need a notification
            insertNotification({
              userId: uid, type:'mention',
              message: fromName+' mentioned you: "'+snippet+'"',
              link: link, fromUserId: myUid, readAt: null, createdAt: new Date().toISOString()
            }).catch(function(err){
              // Was a silent no-op before - real failures (e.g. schema_v18.sql
              // not run yet) need to actually surface, not vanish, or a real
              // bug here looks identical to "nothing happened."
              console.warn('[blue-kite-ops] mention notification failed:', err);
              showToast('error', 'A mention notification failed to send - '+errMsg(err));
            });
          });
        });
      }

      function sendComposerMessage(){
        var input = document.getElementById('commentInput_'+id);
        var sendBtn = document.getElementById('commentSend_'+id);
        var body = input.value.trim();
        if(!body && !pendingFile) return; // nothing to send - matches the spec: text alone, file alone, or both, never neither
        var file = pendingFile;
        var mentionedIds = Object.keys(pendingMentions);
        sendBtn.disabled = true;
        var commentId = 'cm_'+uid8();
        var row = { id:commentId, authorId: myUid, body: body, parentId: replyingTo||null, mentions: mentionedIds };
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
          resolveMentionedIds(body, mentionedIds).then(function(allMentionedIds){
            notifyMentions(allMentionedIds, body);
            // Backfill the comment row's own "mentions" column if the text
            // scan above found more than what was actually clicked - keeps
            // the stored record consistent with who was actually notified.
            if(allMentionedIds.length !== mentionedIds.length){
              supabase.from(cfg.comments).update({mentions: allMentionedIds}).eq('id', commentId).then(function(){});
            }
          });
          // Activity log (round 27) - a file-only message (no text) logs as
          // its own "attachment" event since that's genuinely a distinct
          // thing to want in the log; text-with-or-without-a-file logs as
          // a normal comment/reply. Needs this thread's clientId, which
          // this composer doesn't otherwise carry (it only knows `kind`/
          // `id` - a task or episode id) - looked up fresh rather than
          // trusting a maybe-stale cache, since this fires once per
          // message sent, not often enough to matter.
          (kind==='task' ? db.doc('tasks/'+id).get() : db.doc('episodes/'+id).get()).then(function(s){
            var d = s.data()||{};
            var evt = (file && !body) ? 'attachment' : (replyingTo ? 'reply' : 'comment');
            var lbl = (file && !body) ? file.name : (body.length>80 ? body.slice(0,80)+'…' : body);
            logActivity('social', evt, {
              clientId: d.clientId||null,
              episodeId: kind==='episode' ? id : (d.episodeId||null),
              taskId: kind==='task' ? id : null,
              label: lbl
            });
          }).catch(function(){});
          loadCollab(kind, id, panel);
        }).catch(function(err){
          sendBtn.disabled = false;
          showToast('error', errMsg(err));
        });
      }

      // @mention autocomplete (Phase 4) - a small suggestion list under the
      // composer while typing "@something", click one to insert "@Name "
      // and remember that person's id for notifyMentions() at send time.
      // Deliberately click-only (no arrow-key navigation/highlight) to
      // keep this simple - Enter always sends the message rather than
      // needing to first dismiss a suggestion list.
      var mentionBox = null;
      function hideMentionBox(){ if(mentionBox){ mentionBox.remove(); mentionBox = null; } }
      function wire(){
        var clearAllBtn = document.getElementById('clearAllBtn_'+id);
        if(clearAllBtn) clearAllBtn.addEventListener('click', clearAllComments);
        var jumpUnreadBtn = document.getElementById('jumpUnreadBtn_'+id);
        if(jumpUnreadBtn) jumpUnreadBtn.addEventListener('click', function(){
          var target = document.getElementById('unreadDivider_'+id);
          if(target) target.scrollIntoView({behavior:'smooth', block:'center'});
        });
        var textarea = document.getElementById('commentInput_'+id);
        document.getElementById('commentSend_'+id).addEventListener('click', sendComposerMessage);
        textarea.addEventListener('keydown', function(ev){
          if(ev.key==='Escape'){ hideMentionBox(); return; }
          if(ev.key==='Enter' && !ev.shiftKey){ ev.preventDefault(); hideMentionBox(); sendComposerMessage(); }
        });
        textarea.addEventListener('input', function(){
          autoGrow(textarea);
          var val = textarea.value;
          var caret = textarea.selectionStart;
          var m = val.slice(0, caret).match(/@([a-zA-Z0-9_.' -]{0,25})$/);
          if(!m){ hideMentionBox(); return; }
          var fragment = m[1];
          var rangeStart = caret - m[0].length;
          getMentionRoster().then(function(roster){
            if(textarea.selectionStart!==caret) return; // caret moved on since this lookup started - stale
            var lower = fragment.toLowerCase();
            var matches = roster.filter(function(p){ return p.name.toLowerCase().indexOf(lower)>-1; }).slice(0,6);
            hideMentionBox();
            if(!matches.length) return;
            mentionBox = document.createElement('div');
            mentionBox.className = 'mention-suggest';
            mentionBox.innerHTML = matches.map(function(p){ return '<button type="button" class="mention-suggest-item" data-mention-id="'+escapeHtml(p.id)+'">'+escapeHtml(p.name)+'</button>'; }).join('');
            var composerEl = textarea.closest('.composer');
            if(composerEl) composerEl.appendChild(mentionBox);
            Array.prototype.forEach.call(mentionBox.querySelectorAll('[data-mention-id]'), function(btn){
              // mousedown (not click) so this fires before the textarea's
              // own blur would otherwise dismiss the list first.
              btn.addEventListener('mousedown', function(ev2){
                ev2.preventDefault();
                var pid = btn.getAttribute('data-mention-id');
                var person = matches.filter(function(p){ return p.id===pid; })[0];
                if(!person) return;
                var insertText = '@'+person.name+' ';
                textarea.value = val.slice(0, rangeStart) + insertText + val.slice(caret);
                var newPos = rangeStart + insertText.length;
                textarea.setSelectionRange(newPos, newPos);
                pendingMentions[pid] = person.name;
                hideMentionBox();
                textarea.focus();
                autoGrow(textarea);
              });
            });
          });
        });
        textarea.addEventListener('blur', function(){ setTimeout(hideMentionBox, 150); });
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

        // ---- reply ----
        Array.prototype.forEach.call(panel.querySelectorAll('[data-reply-comment]'), function(btn){
          btn.addEventListener('click', function(){
            replyingTo = btn.getAttribute('data-reply-comment');
            render();
            var ta = document.getElementById('commentInput_'+id); if(ta) ta.focus();
          });
        });
        var cancelReplyBtn = document.getElementById('cancelReply_'+id);
        if(cancelReplyBtn) cancelReplyBtn.addEventListener('click', function(){ replyingTo = null; render(); });

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
            var cid = btn.getAttribute('data-delete-comment');
            var row = btn.closest('.comment-row');
            if(row) row.classList.add('pending-remove');
            var commentData = comments.filter(function(c){ return c.id===cid; })[0];
            supabase.from(cfg.comments).delete().eq('id', cid).then(function(res2){
              if(res2.error){ showToast('error', errMsg(res2.error)); if(row) row.classList.remove('pending-remove'); return; }
              actionWithUndo('Comment deleted', function(){
                if(!commentData) return;
                supabase.from(cfg.comments).insert(commentData).then(function(res3){
                  if(res3.error){ showToast('error', errMsg(res3.error)); return; }
                  loadCollab(kind, id, panel);
                });
              });
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
            var lid = btn.getAttribute('data-delete-link');
            var row = btn.closest('.link-row');
            if(row) row.classList.add('pending-remove');
            var linkData = links.filter(function(l){ return l.id===lid; })[0];
            supabase.from(cfg.links).delete().eq('id', lid).then(function(res2){
              if(res2.error){ showToast('error', errMsg(res2.error)); if(row) row.classList.remove('pending-remove'); return; }
              actionWithUndo('Link deleted', function(){
                if(!linkData) return;
                supabase.from(cfg.links).insert(linkData).then(function(res3){
                  if(res3.error){ showToast('error', errMsg(res3.error)); return; }
                  loadCollab(kind, id, panel);
                });
              });
              loadCollab(kind, id, panel);
            });
          });
        });

        // ---- attachment delete ----
        Array.prototype.forEach.call(panel.querySelectorAll('[data-delete-attachment]'), function(btn){
          btn.addEventListener('click', function(ev){
            ev.stopPropagation();
            var attId = btn.getAttribute('data-delete-attachment');
            var key = btn.getAttribute('data-key');
            var row = btn.closest('.attachment-thumb, .attachment-file');
            if(row) row.classList.add('pending-remove');
            var attData = attachments.filter(function(a){ return a.id===attId; })[0];
            supabase.from(cfg.attachments).delete().eq('id', attId).then(function(res2){
              if(res2.error){ showToast('error', errMsg(res2.error)); if(row) row.classList.remove('pending-remove'); return; }
              // The DB row is gone right away (so Undo can just re-insert
              // it), but the R2 file itself is only ever deleted once - so
              // THAT half stays behind the undo window rather than firing
              // immediately: best-effort, and if Undo is clicked the
              // scheduled deletion is simply never allowed to run, leaving
              // the file untouched for the row to point back at again.
              var fileDeleteTimer = setTimeout(function(){ deleteRemoteFile(key).catch(function(){}); }, UNDO_WINDOW_MS);
              actionWithUndo('Attachment deleted', function(){
                clearTimeout(fileDeleteTimer);
                if(!attData) return;
                supabase.from(cfg.attachments).insert(attData).then(function(res3){
                  if(res3.error){ showToast('error', errMsg(res3.error)); return; }
                  loadCollab(kind, id, panel);
                });
              });
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

  // Multi-role tasks (schema_v29.sql, tasks.roles) mean "does this task
  // match one of my roles" can no longer be a plain `role in myRoles`
  // filter - that would miss a task where I only hold its SECOND or
  // third role, not its primary one. A raw supabase .or() (role in
  // myRoles OR roles overlaps myRoles) covers both old single-role tasks
  // (roles is null, only `role` matches) and new multi-role ones in one
  // query - the db.js shim's own where()/in() can't express an OR across
  // two different fields, so this bypasses it for just this one query,
  // hand-rolling the same live-subscription shape (see db.js's own
  // onSnapshot) so the rest of this function's existing code (which
  // expects snap.docs/snap.empty) needs no changes at all.
  function fetchBoardTasksQuery(){
    var query = supabase.from('tasks').select('*').eq('done', false);
    if(!showingAll) query = query.or('role.in.('+myRoles.join(',')+'),roles.ov.{'+myRoles.join(',')+'}');
    return query.order('dueDate', { ascending: true }).limit(200);
  }
  function subscribeBoardTasks(onData, onError){
    var live = true;
    function emit(){
      fetchBoardTasksQuery().then(function(res){
        if(!live) return;
        if(res.error) throw res.error;
        var rows = res.data || [];
        onData({ docs: rows.map(function(r){ return { id: r.id, exists: true, data: function(){ return r; } }; }), empty: rows.length===0 });
      }).catch(function(e){ if(live && onError) onError(e); });
    }
    emit();
    var channel = supabase.channel('board_tasks_'+Math.random().toString(36).slice(2))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks' }, emit)
      .subscribe();
    return function(){ live = false; supabase.removeChannel(channel); };
  }

  var unsub = subscribeBoardTasks(function(snap){
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
        var roleKeys = taskRoleKeys(t);
        var rr = roleOf(roleKeys[0]);
        var depTasks = liveDepStepIds(t, liveStepByEpisodeId[t.episodeId]).map(function(sid){ return depById[t.episodeId+'_'+sid]; }).filter(Boolean);
        var unmet = depTasks.filter(function(dt){ return !dt.done; });
        var isBlocked = unmet.length>0;
        var canCheck = (roleKeys.some(function(rk){ return myRoles.indexOf(rk)>-1; }) || canManage()) && !isBlocked;
        var waitingLabel = unmet.map(function(dt){ return dt.label; }).join(', ');
        var roleChipsHtml = showingAll ? roleKeys.map(function(rk){
          var r2 = roleOf(rk);
          return ' <span class="role-chip" style="background:'+(r2?r2.color:'#888')+'">'+(r2?escapeHtml(r2.label):escapeHtml(rk))+'</span>';
        }).join('') : '';
        return '<div class="board-task'+(isBlocked?' task-blocked':'')+'" style="border-left:3px solid '+(rr?rr.color:'var(--line)')+'">'+
          '<input type="checkbox" class="task-check" data-task="'+t._id+'" '+(canCheck?'':'disabled')+' '+(isBlocked?'title="Locked until \''+escapeHtml(waitingLabel)+'\' '+(unmet.length>1?'are':'is')+' done"':'')+'>'+
          '<div class="task-body"><div class="task-label">'+escapeHtml(t.label)+'</div>'+
          '<div class="board-task-client">'+escapeHtml(t.clientName)+roleChipsHtml+'</div>'+
          '<div class="board-task-episode">'+escapeHtml(t.episodeTitle)+' · due '+fmtDate(t.dueDate)+'</div>'+
          (isBlocked?'<div class="task-meta"><span class="task-waiting">⛔ Waiting on: '+escapeHtml(waitingLabel)+'</span></div>':'')+
          '</div></div>';
      }).join('')+
      '</div>';
  }).join('');
  Array.prototype.forEach.call(box.querySelectorAll('.task-check:not([disabled])'), function(cb){
    cb.addEventListener('change', function(){
      var taskId = cb.getAttribute('data-task');
      db.doc('tasks/'+taskId).update({done:true, doneByUserId:myUid, doneAt:new Date().toISOString()}).then(function(){
        var t = tasks.filter(function(x){ return x._id===taskId; })[0];
        if(!t) return;
        logActivity('task', 'task_item_done', { clientId: t.clientId, episodeId: t.episodeId, taskId: taskId, label: t.label });
        db.collection('tasks').where('episodeId','==',t.episodeId).get().then(function(snap){
          var allDone = snap.docs.every(function(d){ return d.id===taskId || d.data().done; });
          if(allDone) logActivity('task', 'episode_completed', { clientId: t.clientId, episodeId: t.episodeId, label: t.episodeTitle||t.label });
        }).catch(function(){});
      }).catch(function(err){ cb.checked=false; showToast('error', errMsg(err)); });
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
    '<div style="display:flex;gap:8px;">'+
    '<button type="button" class="timelog-badge'+(timelog.isClockedIn()?'':' off')+'" id="clockToggleBtn">'+(timelog.isClockedIn()?'● Clocked in - stop':'Clock in')+'</button>'+
    '<button type="button" class="timelog-badge standby-badge'+(timelog.isOnStandby()?' on':'')+'" id="standbyToggleBtn"'+(timelog.isClockedIn()?'':' hidden')+' title="Waiting on something external (a render, an export, etc.) - pauses screenshots/activity without clocking out">'+(timelog.isOnStandby()?'● Standby - resume':'Standby')+'</button>'+
    '</div>'+
    '</div>'+
    (canManage()?'<div class="field" style="max-width:320px;margin-bottom:20px;"><label>Viewing</label><select id="timelogWho"></select></div>':'')+
    '<div id="sessionList"><div class="skeleton" style="height:120px;margin-bottom:12px;"></div><div class="skeleton" style="height:120px;"></div></div>'
  );
  document.getElementById('clockToggleBtn').addEventListener('click', toggleClock);
  document.getElementById('standbyToggleBtn').addEventListener('click', toggleStandby);

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
          '<div class="session-standby" id="sessionStandby_'+i+'"></div>'+
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
      timelog.listStandbyForEntry(e.id).catch(function(){ return []; }),
    ]).then(function(res){
      var samples = res[0], shots = res[1], standbyPeriods = res[2];
      var activityBox = document.getElementById('sessionActivity_'+i);
      var shotsBox = document.getElementById('sessionShots_'+i);
      var standbyBox = document.getElementById('sessionStandby_'+i);
      if(!activityBox || !shotsBox) return; // navigated away before this resolved

      // Standby windows (Phase 2.5 batch D) - shown so a gap in the
      // activity bar/screenshots below reads as "self-reported waiting on
      // something external," not as something broken or worth questioning.
      if(standbyBox){
        standbyBox.innerHTML = standbyPeriods.length ? standbyPeriods.map(function(sb){
          var startLabel = new Date(sb.startedAt).toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'});
          var endLabel = sb.endedAt ? new Date(sb.endedAt).toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'}) : 'now';
          return '<span class="standby-pill">On Standby '+escapeHtml(startLabel)+' – '+escapeHtml(endLabel)+'</span>';
        }).join('') : '';
      }

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

// ---------- SOUND MUTE (Phase 5, per Humayun's own brainstormed idea: "an
// in-app sound-effects mute/unmute toggle") - covers every synthesized
// sound this app plays: the ringtone, the call-connected beep, the mention
// ping, and the TimeLog screenshot-captured beep. Persisted to
// localStorage so it survives a reload/relaunch, per-device (not synced -
// there's no natural "account setting" home for this, and a per-device
// mute is what someone actually wants if e.g. they're in a shared office).
var soundsMuted = (function(){ try { return localStorage.getItem('bko_soundsMuted')==='1'; } catch(e){ return false; } })();
function setSoundsMuted(muted){
  soundsMuted = !!muted;
  try { localStorage.setItem('bko_soundsMuted', soundsMuted?'1':'0'); } catch(e){}
  var btn = document.getElementById('soundMuteBtn');
  if(btn){
    btn.innerHTML = soundsMuted ? ICON_SOUND_OFF : ICON_SOUND_ON;
    btn.title = soundsMuted ? 'Sound effects muted - click to unmute' : 'Mute sound effects';
  }
}

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
  if(soundsMuted) return; // ring silently - the incoming-call popup itself still shows
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
  if(soundsMuted) return;
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

// Notification sound for a new @mention (Phase 4's last two items: real
// @mentions + a notification path, and "general UI sound effects" - the
// punch list already narrowed that second one down to notification sounds
// specifically). Same synthesized-tone technique as the ringtone/connected
// beep above (no licensed audio asset), a bright, quick two-note "ping" -
// deliberately shorter and higher than the call-connected beep so the two
// are never confused.
function playMentionPing(){
  if(soundsMuted) return;
  try {
    var ctx = new (window.AudioContext || window.webkitAudioContext)();
    var now = ctx.currentTime;
    [988, 1319].forEach(function(freq, i){ // B5, E6
      var osc = ctx.createOscillator();
      var gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      var t = now + i*0.06;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.09, t+0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, t+0.16);
      osc.connect(gain); gain.connect(ctx.destination);
      osc.start(t); osc.stop(t+0.18);
    });
    setTimeout(function(){ try{ ctx.close(); }catch(e){} }, 400);
  } catch(e){}
}

// ---------- NOTIFICATIONS ----------
// A real inbox (public.notifications, schema_v18.sql), not just a same-
// session toast - the whole point of a mention is reaching someone who
// ISN'T currently looking at that comment thread. "type" is kept generic
// so a future notification kind can reuse this same table/UI instead of
// needing its own.
var notificationsCache = [];
var notificationsUnsub = null;
var seenNotificationIds = null; // null until the first snapshot - see startNotificationsListener()
function unreadNotifCount(){ return notificationsCache.filter(function(n){ return !n.readAt; }).length; }
function updateNotifBadge(){
  var badge = document.getElementById('notifBadge');
  if(!badge) return;
  var n = unreadNotifCount();
  badge.hidden = !n;
  badge.textContent = n>99 ? '99+' : String(n);
}
function startNotificationsListener(){
  if(notificationsUnsub) return;
  seenNotificationIds = null;
  notificationsUnsub = db.collection('notifications').where('userId','==',myUid).orderBy('createdAt','desc').limit(50).onSnapshot(function(snap){
    notificationsCache = snap.docs.map(function(d){ var n=d.data(); n._id=d.id; return n; });
    // First snapshot after (re)connecting just establishes the baseline -
    // nobody wants every already-unread notification from days ago to pop
    // a toast + play a sound the moment the app opens. Only notifications
    // that show up in a LATER snapshot, that weren't in the previous one,
    // are genuinely "new right now."
    if(seenNotificationIds){
      notificationsCache.forEach(function(n){
        if(!n.readAt && !seenNotificationIds[n._id]){
          showToast('info', n.message, { duration: 5000 });
          playMentionPing();
        }
      });
    }
    seenNotificationIds = {};
    notificationsCache.forEach(function(n){ seenNotificationIds[n._id] = true; });
    updateNotifBadge();
  }, function(){});
}
function stopNotificationsListener(){
  if(notificationsUnsub){ try{ notificationsUnsub(); }catch(e){} notificationsUnsub = null; }
  notificationsCache = []; seenNotificationIds = null;
  updateNotifBadge();
}
function openNotificationsPanel(){
  var rows = notificationsCache;
  openModal('Notifications',
    (rows.length ? '<div class="notif-list">'+rows.map(function(n){
      return '<a href="'+(n.link?escapeHtml(n.link):'#')+'" class="notif-row'+(n.readAt?'':' unread')+'" data-notif-open="'+n._id+'">'+
        '<div class="notif-msg">'+escapeHtml(n.message)+'</div>'+
        '<div class="notif-time">'+fmtDateTime(n.createdAt)+'</div>'+
        '</a>';
    }).join('')+'</div>' : '<div class="empty-state">No notifications yet.</div>')+
    (rows.some(function(n){return !n.readAt;}) ? '<div class="field-hint" style="margin-top:10px;"><button type="button" class="btn btn-sm" id="markAllReadBtn">Mark all read</button></div>' : ''),
    function(){ closeModal(); }, 'Close', {afterRender: function(form){
      Array.prototype.forEach.call(form.querySelectorAll('[data-notif-open]'), function(a){
        a.addEventListener('click', function(){
          var nid = a.getAttribute('data-notif-open');
          db.doc('notifications/'+nid).update({readAt: new Date().toISOString()}).catch(function(){});
          closeModal();
        });
      });
      var markAllBtn = document.getElementById('markAllReadBtn');
      if(markAllBtn) markAllBtn.addEventListener('click', function(){
        var unread = rows.filter(function(n){ return !n.readAt; });
        Promise.all(unread.map(function(n){ return db.doc('notifications/'+n._id).update({readAt: new Date().toISOString()}).catch(function(){}); })).then(function(){
          closeModal(); showToast('success','All caught up');
        });
      });
    }});
}

// New-task-for-your-role notifications (2026-09-28 ask, on top of Phase
// 4's original @mentions scope): whoever holds `role` gets a notification
// naming the task, episode and client - not just the mentioning-someone-
// directly case. Reused by every place a task gets created with a role
// already attached: generateEpisodesForRule (recurring episodes), the
// one-off custom task modal, and a new workflow step's backfill onto
// already-generated episodes. Doesn't exclude whoever triggered the
// action - this is "a new work item matches your role," not a social
// mention, so even the person who happened to trigger it should still
// hear about their own new task the same as anyone else holding that role.
// Real bug (2026-09-29, found by the user, not guessed): a mention
// notification failed with "new row violates row-level security policy
// for table notifications" even after schema_v19.sql re-issued the
// insertable policy. Root cause was never the INSERT policy - it was that
// db.doc(...).set(...) goes through the shim's upsert path (INSERT ... ON
// CONFLICT (id) DO UPDATE), and Postgres validates the UPDATE policy's
// WITH CHECK for that statement shape regardless of whether a real
// conflict occurs (ids here are freshly random, so one never does). The
// notifications UPDATE policy is "userId = auth.uid()" (only you can mark
// your own notifications read) - satisfied when you're notifying
// yourself, never satisfied when notifying someone else, which is
// obviously the common case for a mention or task-assignment notification.
// Fix: a genuine bare INSERT (no ON CONFLICT clause at all), which only
// ever needs the INSERT policy. Deliberately NOT db.collection(...).add() -
// that shim chains .select().single() to hand back the new id, and
// PostgREST silently filters a RETURNING row through the table's SELECT
// policy ("userId = auth.uid()") before deciding what to hand back - since
// the recipient isn't the sender, that would swap this bug for a
// different one (.single() throwing on zero rows returned) instead of
// actually fixing it. No RLS policy needed to change for any of this.
function insertNotification(row){
  return supabase.from('notifications').insert(Object.assign({id:'nf_'+uid8()}, row)).then(function(res){
    if(res.error) throw res.error;
  });
}

// 2026-09-30 (round 28): role labels (Outreach Expert/VA etc.) are shared
// across every Team - the SAME role name is held by different people on
// different Teams, on purpose (Humayun: "if an employee on Team A is
// assigned Outreach Expert/VA they are only that for Team A... Team B
// doesn't get any access for Team A"). Task/episode/client visibility is
// already fully Team-scoped at the RLS level regardless of role (see
// public.task_team()/current_team() in schema_v2.sql) - a Team B person
// can't even query a Team A task. The ONE place that role sharing could
// leak across Teams was notifications: this used to ping EVERY holder of
// a role company-wide, so a Team A task could ping Team B's own Outreach
// VA just for sharing the same job title. Now takes `clientId` to resolve
// the task's own Team and only notifies role-holders on THAT Team - a
// person with no Team on file (shouldn't happen for a real employee) or a
// task with no resolvable Team fails OPEN (still notified) rather than
// silently dropping a real notification over an edge case.
// Manager CAN now be assigned a task's role too (Humayun's ask) - only
// Admin stays excluded, since Admin was never "assigned" job-title work.
function notifyRoleAssignment(role, taskLabel, episodeTitle, clientName, link, clientId){
  if(!role || role==='admin') return;
  Promise.all([
    db.collection('profileRoles').where('role','==',role).get(),
    clientTeamIdCached(clientId)
  ]).then(function(res){
    var snap = res[0], teamId = res[1];
    var uids = snap.docs.map(function(d){ return d.data().userId; });
    if(!uids.length) return;
    return db.collection('profiles').where('id','in',uids).get().then(function(profSnap){
      var r = roleOf(role);
      var roleLabel = r ? r.label : role;
      profSnap.docs.forEach(function(d){
        var p = d.data();
        if(teamId && p.teamId && p.teamId!==teamId) return; // same role, different Team - not who this is for
        insertNotification({
          userId: d.id, type:'task_assigned',
          message: 'New '+roleLabel+' task: "'+taskLabel+'" on "'+episodeTitle+'" ('+clientName+')',
          link: link, fromUserId: null, readAt: null, createdAt: new Date().toISOString()
        }).catch(function(err){ console.warn('[blue-kite-ops] task-assignment notification failed:', err); });
      });
    });
  }).catch(function(err){ console.warn('[blue-kite-ops] could not look up role holders to notify:', err); });
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
  if(call.hadOtherParticipant && call.startedAt){
    var names = Object.keys(call.participants).map(function(uid){ return call.participants[uid].name||'Someone'; });
    logActivity('social', 'call', {
      teamId: myTeamId,
      label: 'Call with '+(names.join(', ')||'someone'),
      durationSec: Math.round((Date.now()-call.startedAt)/1000)
    });
  }
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
  if(!call.hadOtherParticipant) call.startedAt = Date.now(); // first real connection - see hangupCall()'s activity-log duration
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
      var row = btn.closest('.roster-row');
      if(row) row.classList.add('pending-remove');
      db.doc('invites/'+id).get().then(function(snap){
        var data = snap.data();
        return cancelInvite(id).then(function(){
          actionWithUndo('Invite for '+email+' canceled', function(){
            if(!data) return;
            db.doc('invites/'+id).set(data).then(function(){ route(); }).catch(function(err){ showToast('error', errMsg(err)); });
          });
          route();
        });
      }).catch(function(err){ if(row) row.classList.remove('pending-remove'); showToast('error', errMsg(err)); });
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
    '<div class="section"><div class="section-head"><h2 class="section-title">Team services</h2><button type="button" class="btn btn-sm" id="newServiceBtn2">+ New service type</button></div><div id="teamServicesBox"></div></div>'+
    '<div class="section"><div class="section-head"><h2 class="section-title">Meetings usage</h2></div><div id="meetingsUsageBox"><div class="skeleton" style="height:20px;"></div></div></div>'
  );
  document.getElementById('inviteBtn').addEventListener('click', openInviteModal);
  document.getElementById('newServiceBtn2').addEventListener('click', function(){ openCreateServiceTypeModal(null); });
  renderMeetingsUsageMeter(document.getElementById('meetingsUsageBox'));

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
      var svcId = btn.getAttribute('data-del-svc');
      var tag = btn.closest('.tag');
      if(tag) tag.classList.add('pending-remove');
      var svcData = servicesCache.filter(function(s){ return s.id===svcId; })[0];
      deleteService(svcId).then(function(){
        return refreshServicesCache().then(function(){
          actionWithUndo('Service deleted', function(){
            if(!svcData) return;
            db.doc('services/'+svcId).set(svcData).then(function(){ return refreshServicesCache(); }).then(function(){ route(); }).catch(function(err){ showToast('error', errMsg(err)); });
          });
          route();
        });
      }).catch(function(err){ if(tag) tag.classList.remove('pending-remove'); showToast('error', errMsg(err)); });
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
  // Scoped to the inviter's own Team (myTeamId) - a Manager only ever
  // invites into their own Team, so unlike Admin's own invite modal below
  // there's no Team picker needed here at all.
  var roleChecksHtml = rolesForTeam(myTeamId).map(function(r){
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

// ---------- ACTIVITY (round 27, schema_v25.sql) ----------
// Manager/Admin-only. A Manager only ever sees their own Team (myTeamId,
// no picker needed); Admin isn't on any one Team, so gets a "which Team am
// I currently looking at" switcher, persisted separately from anything
// else (round 26 gave the roles page its own similar switcher, but round
// 28 removed that one - roles turned out not to need Team-scoping at all,
// see the "ROLES ACROSS TEAMS" note near jobTitleRoles()).
var ACTIVITY_EVENT_LABELS = {
  task_item_done: 'marked a task done',
  episode_completed: 'completed the whole episode',
  comment: 'commented',
  reply: 'replied',
  attachment: 'attached a file',
  call: 'was on a call'
};
var activityCategory = 'task';
// Date-range + "filter to one person" (2026-09-24 request) - both reset
// back to defaults on a fresh renderActivity() call (e.g. switching Team)
// rather than persisting, since they're meant as a quick narrow-down for
// the page you're already looking at, not a sticky preference like the
// Team switcher above.
var activityDateRange = 'all'; // 'all' | 'today' | '7d' | '30d'
var activityActorUid = null;
var activityActorName = '';
var ACTIVITY_RANGE_LABELS = { all:'All time', today:'Today', '7d':'Last 7 days', '30d':'Last 30 days' };
function activityRangeSinceIso(range){
  var d = new Date();
  if(range==='today'){ d.setHours(0,0,0,0); return d.toISOString(); }
  if(range==='7d'){ d.setDate(d.getDate()-7); return d.toISOString(); }
  if(range==='30d'){ d.setDate(d.getDate()-30); return d.toISOString(); }
  return null;
}
function loadActivityTeamId(){
  var saved = null; try{ saved = localStorage.getItem('bko_adminActivityTeam'); }catch(e){}
  var list = sortedTeamList();
  if(saved && list.some(function(t){ return t.id===saved; })) return saved;
  return list.length ? list[0].id : null;
}
function saveActivityTeamId(teamId){ try{ localStorage.setItem('bko_adminActivityTeam', teamId||''); }catch(e){} }
function formatDurationShort(sec){
  sec = sec||0;
  if(sec<60) return sec+'s';
  var m = Math.floor(sec/60), s = sec%60;
  return m+'m'+(s?' '+s+'s':'');
}
function renderActivity(){
  if(!canManage()){ paint('<div class="empty-state"><strong>Not available</strong>Only managers and admins can view activity logs.</div>'); return; }
  var teamId = isAdmin() ? loadActivityTeamId() : myTeamId;
  paint(
    '<div class="page-head"><div><div class="eyebrow">Activity</div><h1 class="page-title">Who did what, and when</h1>'+
    '<div class="page-sub">'+(isAdmin()?'Scoped to whichever Team you pick below.':'Your Team only.')+'</div></div>'+
    (isAdmin() && sortedTeamList().length>1 ? '<select id="activityTeamFilter" style="width:auto;">'+teamOptionsHtml(teamId)+'</select>' : '')+
    '</div>'+
    '<div class="segmented" id="activityTabs">'+
    '<button type="button" class="segmented-btn'+(activityCategory==='task'?' active':'')+'" data-cat="task">Task activity</button>'+
    '<button type="button" class="segmented-btn'+(activityCategory==='social'?' active':'')+'" data-cat="social">Comments, files &amp; calls</button>'+
    '</div>'+
    '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:14px;">'+
    '<div class="segmented" id="activityRangeTabs">'+
    Object.keys(ACTIVITY_RANGE_LABELS).map(function(k){ return '<button type="button" class="segmented-btn'+(activityDateRange===k?' active':'')+'" data-range="'+k+'">'+ACTIVITY_RANGE_LABELS[k]+'</button>'; }).join('')+
    '</div>'+
    (activityActorUid ? '<button type="button" class="badge" id="activityActorClearBtn" style="border:none;cursor:pointer;background:var(--blue-soft);color:var(--blue-2);">Filtering by '+escapeHtml(activityActorName||'this person')+' &times;</button>' : '')+
    '</div>'+
    '<div id="activityListBox"><div class="skeleton" style="height:60px;"></div></div>'
  );
  var teamFilter = document.getElementById('activityTeamFilter');
  if(teamFilter) teamFilter.addEventListener('change', function(){ saveActivityTeamId(teamFilter.value); activityActorUid=null; activityActorName=''; renderActivity(); });
  Array.prototype.forEach.call(document.querySelectorAll('#activityTabs [data-cat]'), function(btn){
    btn.addEventListener('click', function(){ activityCategory = btn.getAttribute('data-cat'); renderActivity(); });
  });
  Array.prototype.forEach.call(document.querySelectorAll('#activityRangeTabs [data-range]'), function(btn){
    btn.addEventListener('click', function(){ activityDateRange = btn.getAttribute('data-range'); renderActivity(); });
  });
  var clearBtn = document.getElementById('activityActorClearBtn');
  if(clearBtn) clearBtn.addEventListener('click', function(){ activityActorUid=null; activityActorName=''; renderActivity(); });
  loadActivityList(teamId, activityCategory);
}
// A plain .get() (not a live subscription) - this is a historical log
// people check in on, not something that needs to visibly update itself
// while the page sits open, and a snapshot listener on a growing
// append-only table is a needless ongoing cost for that.
function loadActivityList(teamId, category){
  var box = document.getElementById('activityListBox');
  if(!box) return;
  if(!teamId){ box.innerHTML = '<div class="empty-state">No team to show yet.</div>'; return; }
  var q = db.collection('activityLog').where('teamId','==',teamId).where('category','==',category);
  if(activityActorUid) q = q.where('actorUserId','==',activityActorUid);
  var sinceIso = activityRangeSinceIso(activityDateRange);
  if(sinceIso) q = q.where('createdAt','>=',sinceIso);
  q.orderBy('createdAt','desc').limit(150).get().then(function(snap){
    box = document.getElementById('activityListBox'); // route() may have moved on by the time this resolves
    if(!box) return;
    if(snap.empty){ box.innerHTML = '<div class="empty-state">Nothing recorded here'+(activityActorUid||sinceIso?' for this filter':' yet')+'.</div>'; return; }
    box.innerHTML = snap.docs.map(function(d){
      var r = d.data();
      var verb = ACTIVITY_EVENT_LABELS[r.eventType] || r.eventType;
      var extra = (r.eventType==='call' && r.durationSec) ? ' ('+formatDurationShort(r.durationSec)+')' : '';
      var roleLabel = r.actorRole ? (roleOf(r.actorRole)||{}).label || r.actorRole : '';
      // The actor chip doubles as a "filter to just this person" button -
      // clicking a name is the request's exact wording ("filter... by
      // clicking on name of the employee").
      return '<div class="roster-row"><button type="button" class="activity-actor-btn" data-uid="'+escapeHtml(r.actorUserId)+'" title="Show only this person\'s activity">'+profileChip(r.actorUserId)+'</button>'+
        '<div style="min-width:0;flex:1;"><div style="font-size:13px;">'+verb+(r.label?': <strong>'+escapeHtml(r.label)+'</strong>':'')+extra+'</div>'+
        '<div style="font-size:11.5px;color:var(--muted);">'+fmtDateTime(r.createdAt)+(roleLabel?' · '+escapeHtml(roleLabel):'')+'</div></div>'+
        '</div>';
    }).join('');
    hydrateProfiles(box);
    Array.prototype.forEach.call(box.querySelectorAll('.activity-actor-btn'), function(btn){
      btn.addEventListener('click', function(){
        activityActorUid = btn.getAttribute('data-uid');
        var nameEl = btn.querySelector('.pname');
        activityActorName = nameEl ? nameEl.textContent : '';
        renderActivity();
      });
    });
  }).catch(function(err){ box.innerHTML = '<div class="empty-state">Could not load activity - '+errMsg(err)+'</div>'; });
}

// ---------- MEETINGS (video calls, screen share, host recording) ----------
// A separate feature from Connect (audio-only huddles, above) - built the
// same way (Supabase Realtime signaling + Cloudflare Realtime SFU media)
// but with its own library (src/lib/meetings.js), its own Worker
// (worker-meetings/), and its own code path through this file, so nothing
// here can ever regress Connect. See docs/phase-3-punch-list.md's Meetings
// round for the full design writeup, and schema_v27.sql for the tables.
var ICON_MIC = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v1a7 7 0 0 1-14 0v-1"/><line x1="12" y1="18" x2="12" y2="22"/></svg>';
var ICON_MIC_OFF = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="2" y1="2" x2="22" y2="22"/><path d="M9 9v3a3 3 0 0 0 4.6 2.55M15 9.34V5a3 3 0 0 0-5.94-.6"/><path d="M19 10v1a7 7 0 0 1-.11 1.23M5 10v1a7 7 0 0 0 11.6 5.29"/><line x1="12" y1="18" x2="12" y2="22"/></svg>';
var ICON_CAM = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>';
var ICON_CAM_OFF = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 16v1a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h1"/><path d="M23 7l-7 5 7 5V7z"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
var ICON_SCREEN = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></svg>';
var ICON_RECORD = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="7"/></svg>';
var ICON_SETTINGS = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2.2"/><circle cx="12" cy="12" r="2.2"/><circle cx="19" cy="12" r="2.2"/></svg>';
// Was an incomplete phone-icon path (a curve cut off partway through, not
// a rendering bug) - reported 2026-09-30 as "looks half cut out", which is
// literally what it was. Replaced with a plain, guaranteed-to-render-right
// X rather than risk another hand-drawn curve.
var ICON_HANGUP = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>';

function meetingIsHost(m){ return !!(m && (m.hostUserId===myUid || isAdmin())); }
// Returns a human countdown string, or null once it's actually time (the
// caller then proceeds straight into the real room instead of a waiting
// screen). 2026-09-30 fix: opening a scheduled meeting used to jump
// straight into turning your camera on regardless of whether it had
// actually started yet.
function formatMeetingCountdown(scheduledIso){
  if(!scheduledIso) return null;
  var target = new Date(scheduledIso);
  var now = new Date();
  var sameDay = target.toDateString() === now.toDateString();
  if(!sameDay){
    return 'Meeting starts on '+target.toLocaleDateString(undefined,{weekday:'long',month:'long',day:'numeric'})+' at '+target.toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'});
  }
  var msLeft = target.getTime() - now.getTime();
  if(msLeft<=0) return null;
  var totalMinutes = Math.max(1, Math.ceil(msLeft/60000));
  var hours = Math.floor(totalMinutes/60), minutes = totalMinutes%60;
  if(hours>0) return 'Meeting starts in '+hours+' hour'+(hours!==1?'s':'')+(minutes>0?' and '+minutes+' minute'+(minutes!==1?'s':''):'');
  return 'Meeting starts in '+minutes+' minute'+(minutes!==1?'s':'');
}
function renderMeetingWaitingScreen(meetingId, m, canHost){
  paint(
    '<div class="page-head"><div><div class="eyebrow">Meeting</div><h1 class="page-title">'+escapeHtml(m.title)+'</h1></div></div>'+
    '<div class="empty-state" style="padding:60px 20px;"><strong id="meetingCountdownText" style="font-size:16px;">'+escapeHtml(formatMeetingCountdown(m.scheduledAt)||'Meeting starts soon')+'</strong>'+
    (canHost?'<div style="margin-top:16px;"><button type="button" class="btn btn-primary" id="startNowBtn" style="width:auto;">Start now</button></div>'
      :'<div style="margin-top:10px;color:var(--muted);">You\'ll join automatically once it\'s time, or as soon as the host starts it.</div>')+
    '</div>'
  );
  var startBtn = document.getElementById('startNowBtn');
  if(startBtn) startBtn.addEventListener('click', function(){
    db.doc('meetings/'+meetingId).update({status:'live', startedAt:new Date().toISOString()}).then(route).catch(function(err){ showToast('error', errMsg(err)); });
  });
  var interval = setInterval(function(){
    var el = document.getElementById('meetingCountdownText');
    if(!el){ clearInterval(interval); return; }
    var text = formatMeetingCountdown(m.scheduledAt);
    if(!text){ clearInterval(interval); route(); return; }
    el.textContent = text;
  }, 15000);
  var unsub = db.doc('meetings/'+meetingId).onSnapshot(function(s){
    if(s.exists && s.data().status==='live'){ clearInterval(interval); route(); }
  }, function(){});
  activeUnsubs.push(unsub);
  activeMeetingRoomCleanup = function(){ clearInterval(interval); };
}

// Cost-guardrail usage meter (Phase 5's ask) - approximate, not exact
// billing (Cloudflare bills real egress bytes; this estimates from known
// quality settings instead) but enough for an early-warning "you're
// getting close to the free 1,000 GB/month" signal. RLS on
// meetingParticipantLogs already scopes this correctly with NO extra
// filtering needed here: Admin sees every row, a Manager only ever sees
// their own Team's meetings' rows (plus their own personal ones) - same
// current_team()/is_admin() pattern as Activity Logs.
function renderMeetingsUsageMeter(box){
  if(!box) return;
  var startOfMonth = new Date(); startOfMonth.setDate(1); startOfMonth.setHours(0,0,0,0);
  db.collection('meetingParticipantLogs').where('joinedAt','>=', startOfMonth.toISOString()).get().then(function(snap){
    var totalMinutes = 0;
    snap.docs.forEach(function(d){
      var r = d.data();
      var end = r.leftAt ? new Date(r.leftAt).getTime() : Date.now();
      totalMinutes += Math.max(0, (end - new Date(r.joinedAt).getTime())/60000);
    });
    // ~6 MB/participant-minute is a rough blend of this app's default
    // video+audio quality settings (small camera tiles, occasional screen
    // share) - a real number would need to come from Cloudflare's own
    // billing dashboard, this is only meant as an early-warning estimate.
    var estGB = (totalMinutes * 6) / 1024;
    box.innerHTML = '<div class="page-sub">This month so far: <strong>'+Math.round(totalMinutes).toLocaleString()+' participant-minutes</strong> of Meetings (~'+estGB.toFixed(1)+' GB estimated, out of the 1,000 GB Cloudflare gives free every month - check Cloudflare\'s own Billing dashboard for the real figure).</div>';
  }).catch(function(){ box.innerHTML = ''; });
}

// ---- list page ----
function renderMeetingsList(){
  paint(
    '<div class="page-head"><div><div class="eyebrow">Meetings</div><h1 class="page-title">Video meetings</h1>'+
    '<div class="page-sub">Camera, screen share, optional recording - separate from Connect\'s quick audio huddles.</div></div>'+
    '<div style="display:flex;gap:8px;flex-wrap:wrap;"><button type="button" class="btn btn-sm" id="recSettingsBtn">Recording folder</button>'+
    '<button type="button" class="btn btn-sm" id="scheduleMeetingBtn">+ Schedule</button>'+
    '<button type="button" class="btn btn-primary btn-sm" id="newInstantMeetingBtn" style="width:auto;">+ Start instant meeting</button></div></div>'+
    '<div class="section"><div class="section-head"><h2 class="section-title">Upcoming &amp; live</h2></div><div id="upcomingMeetingsBox"><div class="skeleton" style="height:60px;"></div></div></div>'+
    '<div class="section"><div class="section-head"><h2 class="section-title">Past</h2></div><div id="pastMeetingsBox"><div class="skeleton" style="height:60px;"></div></div></div>'
  );
  if(!meetingsLib.meetingsConfigured){
    showToast('error','Meetings isn\'t set up yet - deploy worker-meetings and set VITE_MEETINGS_WORKER_URL (see README.md).');
  }
  document.getElementById('recSettingsBtn').addEventListener('click', openRecordingSettingsModal);
  document.getElementById('newInstantMeetingBtn').addEventListener('click', createAndJoinInstantMeeting);
  document.getElementById('scheduleMeetingBtn').addEventListener('click', function(){ openScheduleMeetingModal(); });

  var unsub = db.collection('meetings').orderBy('createdAt','desc').limit(100).onSnapshot(function(snap){
    var list = snap.docs.map(function(d){ var m=d.data(); m._id=d.id; return m; });
    renderMeetingsGroup('upcomingMeetingsBox', list.filter(function(m){ return m.status!=='ended'; }), true);
    renderMeetingsGroup('pastMeetingsBox', list.filter(function(m){ return m.status==='ended'; }), false);
    checkUpcomingMeetingReminders(list);
  }, function(err){
    // Was a silent no-op before - a real query failure (e.g. the RLS
    // recursion bug schema_v28.sql fixes) left both boxes stuck on their
    // initial skeleton loader forever, with no visible error at all.
    var msg = '<div class="empty-state">Could not load meetings - '+errMsg(err)+'</div>';
    var up = document.getElementById('upcomingMeetingsBox'); if(up) up.innerHTML = msg;
    var past = document.getElementById('pastMeetingsBox'); if(past) past.innerHTML = msg;
  });
  activeUnsubs.push(unsub);
}
function renderMeetingsGroup(boxId, list, isUpcoming){
  var box = document.getElementById(boxId);
  if(!box) return;
  box.innerHTML = list.length ? list.map(function(m){
    var when = m.status==='live' ? 'Live now' : (m.scheduledAt ? fmtDateTime(m.scheduledAt) : fmtDateTime(m.createdAt));
    return '<div class="roster-row"><div style="min-width:0;flex:1;"><div class="roster-name">'+escapeHtml(m.title)+
      (m.status==='live'?' <span class="badge" style="background:var(--overdue-soft);color:var(--overdue);">Live</span>':'')+'</div>'+
      '<div class="roster-role">'+escapeHtml(when)+'</div></div>'+
      (isUpcoming ? '<a href="#/meeting/'+m._id+'" class="btn btn-sm btn-primary" style="width:auto;">'+(m.status==='live'?'Join':'Open')+'</a>' : '')+
      '</div>';
  }).join('') : '<div class="empty-state">Nothing here yet.</div>';
}
// Best-effort "meeting starting soon" nudge - checked whenever the
// Meetings list page loads/refreshes. A real "ping me even if I'm not
// looking at this page right now" reminder would need a server-side
// scheduled job (e.g. Supabase pg_cron), which doesn't exist in this
// project yet - see docs/phase-3-punch-list.md's Meetings round for this
// known limitation.
var remindedMeetingIds = {};
function checkUpcomingMeetingReminders(list){
  var now = Date.now();
  list.forEach(function(m){
    if(m.status!=='scheduled' || !m.scheduledAt || remindedMeetingIds[m._id]) return;
    var startsInMs = new Date(m.scheduledAt).getTime() - now;
    if(startsInMs <= 2*60*1000 && startsInMs > -5*60*1000){
      remindedMeetingIds[m._id] = true;
      showToast('info', '"'+m.title+'" is starting soon', { duration: 6000 });
    }
  });
}

function openRecordingSettingsModal(){
  getRecordingsFolder().then(function(folder){
    openModal('Recording folder', '<div class="field"><label>Meeting recordings save to</label><input type="text" id="recFolderDisplay" value="'+escapeHtml(folder)+'" readonly></div>'+
      '<div class="field-hint">Only affects new recordings started after you change this.</div>',
      function(){ closeModal(); }, 'Done');
    var field = document.querySelector('#modalForm .field');
    if(!field) return;
    var btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'btn btn-sm'; btn.style.marginTop = '8px'; btn.textContent = 'Choose a different folder…';
    btn.addEventListener('click', function(){
      pickRecordingsFolder().then(function(path){
        if(!path) return;
        setRecordingsFolder(path);
        var input = document.getElementById('recFolderDisplay'); if(input) input.value = path;
        showToast('success','Recordings will now save here');
      }).catch(function(err){ showToast('error', errMsg(err)); });
    });
    field.appendChild(btn);
  });
}

// Real bug (2026-09-30, "when I start an instant meeting, it's just me
// in it... no one can join me"): this never invited anyone at all, and
// `meetings`' own SELECT policy only lets the host, an admin, a Manager
// of the same Team, or an actual invitee see a meeting - a plain
// teammate had literally no way to even discover it existed. An instant
// meeting now auto-invites the whole Team (everyone with the same
// teamId, minus the host) - same mechanism a scheduled meeting already
// uses (meetingInvitees + a notification each), just applied to
// everyone by default instead of hand-picked, since "instant meeting"
// implies "my team can drop in."
function createAndJoinInstantMeeting(){
  var id = meetingsLib.newMeetingId();
  var title = ((myProfile&&myProfile.displayName)||'Someone')+"'s meeting";
  var nowIso = new Date().toISOString();
  db.doc('meetings/'+id).set({
    id:id, title:title, hostUserId:myUid, teamId:myTeamId, status:'live', isInstant:true,
    scheduledAt:null, startedAt:nowIso, endedAt:null, createdAt:nowIso
  }).then(function(){
    return db.collection('profiles').where('teamId','==',myTeamId).get();
  }).then(function(snap){
    var teammateIds = snap.docs.map(function(d){ return d.id; }).filter(function(uid){ return uid!==myUid; });
    return Promise.all(teammateIds.map(function(uid){
      return supabase.from('meetingInvitees').insert({ id:'mi_'+uid8(), meetingId:id, userId:uid, createdAt:nowIso }).then(function(){
        insertNotification({
          userId: uid, type:'meeting_invite', message: 'Meeting starting now: "'+title+'"',
          link: '#/meeting/'+id, fromUserId: myUid, readAt: null, createdAt: nowIso
        }).catch(function(err){ console.warn('[blue-kite-ops] meeting invite notification failed:', err); });
      });
    }));
  }).then(function(){
    location.hash = '#/meeting/'+id;
  }).catch(function(err){ showToast('error', errMsg(err)); });
}

// Calendar reminders (2026-09-30, Humayun's ask): a real Google Calendar
// API integration needs its own Google Cloud OAuth app/consent screen -
// meaningful setup, similar to the Drive music service-account work - and
// only helps people who use Google Calendar specifically. A .ics file is
// the plain-text calendar-invite FORMAT every major calendar (Google,
// Outlook, Apple) already knows how to import with one click, needs no
// API/OAuth/Google Cloud project at all, and works for anyone regardless
// of which calendar they use - the pragmatic choice here over a deeper
// integration that would only serve part of the team anyway.
function buildIcsForMeeting(title, scheduledIso, meetingId){
  function fmt(d){ return d.toISOString().replace(/[-:]/g,'').split('.')[0]+'Z'; }
  var start = new Date(scheduledIso);
  var end = new Date(start.getTime() + 60*60*1000); // 1hr default block - editable by the person after importing, same as any calendar invite
  return [
    'BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Blue Kite Ops//Meetings//EN','BEGIN:VEVENT',
    'UID:'+meetingId+'@blue-kite-ops','DTSTAMP:'+fmt(new Date()),'DTSTART:'+fmt(start),'DTEND:'+fmt(end),
    'SUMMARY:'+title.replace(/[\r\n]+/g,' '),
    'DESCRIPTION:Join from the Blue Kite Ops Meetings page.',
    'END:VEVENT','END:VCALENDAR'
  ].join('\r\n');
}
function downloadIcsForMeeting(title, scheduledIso, meetingId){
  var blob = new Blob([buildIcsForMeeting(title, scheduledIso, meetingId)], { type:'text/calendar' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url; a.download = title.replace(/[^a-z0-9]+/gi,'-').slice(0,60)+'.ics';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(function(){ URL.revokeObjectURL(url); }, 4000);
}
function showMeetingScheduledModal(title, scheduledIso, meetingId){
  openModal('Meeting scheduled', '<div class="field-hint">"'+escapeHtml(title)+'" - '+escapeHtml(fmtDateTime(scheduledIso))+'. Everyone invited already got a notification - add it to your own calendar too if you\'d like a reminder there.</div>',
    function(){ closeModal(); }, 'Done');
  var actions = document.querySelector('.modal-actions');
  if(actions){
    var btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'btn btn-sm'; btn.style.width = 'auto'; btn.textContent = 'Add to calendar (.ics)';
    btn.addEventListener('click', function(){ downloadIcsForMeeting(title, scheduledIso, meetingId); });
    actions.insertBefore(btn, actions.firstChild);
  }
}

function openScheduleMeetingModal(){
  db.collection('profiles').get().then(function(snap){
    var profiles = snap.docs.map(function(d){ var p=d.data(); p.id=d.id; return p; }).filter(function(p){ return p.id!==myUid; });
    var byTeam = {};
    profiles.forEach(function(p){ var t=p.teamId||'_none'; (byTeam[t]=byTeam[t]||[]).push(p); });
    var teamIds = Object.keys(byTeam).sort(function(a,b){ return (a==='_none'?'zzz':teamName(a)).localeCompare(b==='_none'?'zzz':teamName(b)); });
    var inviteesHtml = teamIds.map(function(tid){
      var members = byTeam[tid].sort(function(a,b){ return (a.displayName||a.email||'').localeCompare(b.displayName||b.email||''); });
      return '<div style="margin-bottom:10px;"><label style="font-weight:700;font-size:12px;display:flex;align-items:center;gap:6px;"><input type="checkbox" data-select-team="'+tid+'"> '+escapeHtml(tid==='_none'?'No team':teamName(tid))+'</label>'+
        '<div style="margin-left:20px;">'+members.map(function(p){
          return '<label style="display:flex;align-items:center;gap:6px;font-size:12.5px;padding:2px 0;"><input type="checkbox" name="invitees" value="'+p.id+'" data-team="'+tid+'">'+escapeHtml(p.displayName||p.email)+'</label>';
        }).join('')+'</div></div>';
    }).join('') || '<div class="empty-state">No one else to invite yet.</div>';
    openModal('Schedule a meeting',
      '<div class="field"><label>Title</label><input required name="title" type="text" placeholder="e.g. Weekly sync"></div>'+
      '<div class="check-row"><input type="checkbox" id="scheduleLaterCheck" name="scheduleLater"><label for="scheduleLaterCheck">Schedule for later (unchecked = start right now)</label></div>'+
      '<div class="field" id="scheduleWhenField" hidden><label>Date &amp; time</label><input type="datetime-local" name="scheduledAt"></div>'+
      '<div class="field"><label>Invite</label><div style="max-height:220px;overflow:auto;border:1px solid var(--line);border-radius:8px;padding:8px;">'+inviteesHtml+'</div></div>',
      function(fd){
        var title = (fd.get('title')||'').trim();
        if(!title){ showModalError('Give the meeting a title.'); return; }
        var invitees = fd.getAll('invitees');
        var later = fd.get('scheduleLater')==='on';
        var scheduledAtRaw = fd.get('scheduledAt');
        if(later && !scheduledAtRaw){ showModalError('Pick a date and time, or uncheck "Schedule for later".'); return; }
        setModalBusy(true, later?'Scheduling…':'Starting…');
        var id = meetingsLib.newMeetingId();
        var nowIso = new Date().toISOString();
        var scheduledIso = later ? new Date(scheduledAtRaw).toISOString() : null;
        db.doc('meetings/'+id).set({
          id:id, title:title, hostUserId:myUid, teamId:myTeamId,
          status: later?'scheduled':'live', isInstant: !later,
          scheduledAt: scheduledIso, startedAt: later?null:nowIso, endedAt:null, createdAt:nowIso
        }).then(function(){
          return Promise.all(invitees.map(function(uid){
            return supabase.from('meetingInvitees').insert({ id:'mi_'+uid8(), meetingId:id, userId:uid, createdAt:nowIso });
          }));
        }).then(function(){
          invitees.forEach(function(uid){
            insertNotification({
              userId: uid, type:'meeting_invite',
              message: (later ? 'Invited to a meeting: "'+title+'" at '+fmtDateTime(scheduledIso) : 'Meeting starting now: "'+title+'"'),
              link: '#/meeting/'+id, fromUserId: myUid, readAt: null, createdAt: nowIso
            }).catch(function(err){ console.warn('[blue-kite-ops] meeting invite notification failed:', err); });
          });
        }).then(function(){
          closeModal();
          if(later){ showMeetingScheduledModal(title, scheduledIso, id); route(); }
          else location.hash = '#/meeting/'+id;
        }).catch(function(err){ showModalError(errMsg(err)); });
      }, 'Create');
    var laterCheck = document.getElementById('scheduleLaterCheck');
    var whenField = document.getElementById('scheduleWhenField');
    if(laterCheck) laterCheck.addEventListener('change', function(){ whenField.hidden = !laterCheck.checked; });
    Array.prototype.forEach.call(document.querySelectorAll('[data-select-team]'), function(cb){
      cb.addEventListener('change', function(){
        var tid = cb.getAttribute('data-select-team');
        Array.prototype.forEach.call(document.querySelectorAll('[data-team="'+tid+'"]'), function(m){ m.checked = cb.checked; });
      });
    });
  }).catch(function(err){ showToast('error', errMsg(err)); });
}

// Shown right before actually calling getDisplayMedia - covers two of
// Humayun's 2026-09-30 reports in one small step: the "voice keeps
// echoing" issue (a headphones nudge - see startScreenShareSession's own
// comment for why muting the mic doesn't help) and the "appears extremely
// bright" HDR issue (an opt-in workaround, remembered per device so it's
// not re-asked every single share once set).
function openScreenShareOptionsModal(onProceed){
  var savedHdr = false; try{ savedHdr = localStorage.getItem('bko_hdrCompensate')==='1'; }catch(e){}
  openModal('Share your screen',
    '<div class="field-hint">If you plan to share audio (a video, music, etc.), use headphones if you can - sharing your speaker output back out is what causes the other person to hear an echo of their own voice, not your microphone.</div>'+
    '<div class="check-row" style="margin-top:10px;"><input type="checkbox" id="hdrCompCheck" name="hdr" '+(savedHdr?'checked':'')+'><label for="hdrCompCheck">My screen looks washed out/overly bright to others (HDR display) - try to compensate</label></div>',
    function(fd){
      var hdr = fd.get('hdr')==='on';
      try{ localStorage.setItem('bko_hdrCompensate', hdr?'1':'0'); }catch(e){}
      closeModal();
      onProceed({ hdrCompensate: hdr });
    }, 'Continue');
}

function showRecordingSavedModal(path){
  openModal('Recording saved',
    '<div class="field"><label>Saved to</label><input type="text" readonly value="'+escapeHtml(path)+'"></div>',
    function(){ closeModal(); }, 'Done');
  var actions = document.querySelector('.modal-actions');
  if(actions){
    var btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'btn btn-sm'; btn.style.width='auto'; btn.textContent = 'Open folder';
    btn.addEventListener('click', function(){ revealInFolder(path).catch(function(err){ showToast('error', errMsg(err)); }); });
    actions.insertBefore(btn, actions.firstChild);
  }
}

// ---- the room itself ----
function renderMeetingRoom(meetingId){
  paint('<div class="skeleton" style="height:100px;margin-bottom:20px;"></div><div class="skeleton" style="height:400px;"></div>');

  var mainSession = null, screenSession = null;
  var roomHandle = null;
  var pendingPulls = []; // {uid, trackName} - FIFO, matches pc.ontrack order (see wireRemoteAudio's own comment on this same pattern for Connect)
  var remoteMeta = {};   // uid -> latest presence meta
  var remoteStreamsForRecording = {}; // uid -> MediaStream (mic) - kept so the recorder can mix in whoever's currently in the room
  var myParticipantLogId = null;
  var recorder = null;
  var iAmRecording = false;
  var leftAlready = false;
  var meetingUnsub = null;

  function cleanup(){
    if(leftAlready) return;
    leftAlready = true;
    if(iAmRecording && recorder){ recorder.stop().catch(function(){}); }
    if(roomHandle){ roomHandle.leave(); }
    meetingsLib.endSession(mainSession);
    meetingsLib.endSession(screenSession);
    if(myParticipantLogId){
      supabase.from('meetingParticipantLogs').update({ leftAt: new Date().toISOString() }).eq('id', myParticipantLogId).then(function(){});
    }
  }
  activeMeetingRoomCleanup = cleanup;

  db.doc('meetings/'+meetingId).get().then(function(snap){
    if(!snap.exists){ paint('<div class="empty-state"><strong>Meeting not found</strong>It may have been removed, or you weren\'t invited to it.</div>'); activeMeetingRoomCleanup=null; return; }
    var m = snap.data();
    var canHost = meetingIsHost(m);

    // Real bug (2026-09-24, "when I end a call for everyone it quits but
    // reappears under live calls"): a participant whose camera/mic
    // permission was still resolving when the host ended the meeting would
    // finish joining a moment later and unconditionally write status:'live'
    // back onto an already-ended meeting (see the join-time write below,
    // now also guarded). Never even starting to join an ended meeting's
    // room closes off that whole race at the source, on top of guarding the
    // write itself.
    if(m.status==='ended'){
      paint('<div class="empty-state"><strong>This meeting has ended</strong>'+(m.endedAt?fmtDateTime(m.endedAt)+'. ':'')+'Go back to <a href="#/meetings">Meetings</a> to see past meetings or start a new one.</div>');
      activeMeetingRoomCleanup = null;
      return;
    }

    // Not time yet - show a countdown instead of turning the camera on.
    // 5-minute grace window so people can join a little early without
    // staring at a countdown for the last few minutes.
    if(m.status==='scheduled' && m.scheduledAt && (new Date(m.scheduledAt).getTime() - Date.now()) > 5*60*1000){
      renderMeetingWaitingScreen(meetingId, m, canHost);
      return;
    }

    paint(
      '<div class="meeting-room">'+
      '<div class="meeting-header"><div class="meeting-title-row"><h1 class="page-title" style="margin:0;">'+escapeHtml(m.title)+'</h1>'+
      '<span id="meetingRecBanner"></span></div>'+
      '<div style="display:flex;gap:8px;">'+
      (canHost?'<button type="button" class="btn btn-sm btn-danger" id="endMeetingBtn">End for everyone</button>':'')+
      '</div></div>'+
      '<div class="meeting-grid" id="meetingGrid"></div>'+
      '<div class="meeting-controls">'+
      '<div class="meeting-ctrl-group"><button type="button" class="meeting-ctrl-btn active" id="micBtn">'+ICON_MIC+'</button><div class="meeting-ctrl-label">Mic</div></div>'+
      '<div class="meeting-ctrl-group"><button type="button" class="meeting-ctrl-btn active" id="camBtn">'+ICON_CAM+'</button><div class="meeting-ctrl-label">Camera</div></div>'+
      '<div class="meeting-ctrl-group"><button type="button" class="meeting-ctrl-btn" id="screenBtn">'+ICON_SCREEN+'</button><div class="meeting-ctrl-label">Share</div></div>'+
      '<div class="meeting-ctrl-group"><button type="button" class="meeting-ctrl-btn" id="devicesBtn">'+ICON_SETTINGS+'</button><div class="meeting-ctrl-label">Devices</div></div>'+
      (canHost?'<div class="meeting-ctrl-group"><button type="button" class="meeting-ctrl-btn" id="recordBtn">'+ICON_RECORD+'</button><div class="meeting-ctrl-label">Record</div></div>':'')+
      '<div class="meeting-ctrl-group"><button type="button" class="meeting-ctrl-btn danger" id="leaveBtn">'+ICON_HANGUP+'</button><div class="meeting-ctrl-label">Leave</div></div>'+
      '</div></div>'
    );

    function setRecBanner(on){
      var el = document.getElementById('meetingRecBanner');
      if(el) el.innerHTML = on ? '<span class="meeting-recording-banner"><span class="pulse-dot"></span> Recording</span>' : '';
    }

    function tileId(uid){ return 'meetingTile_'+uid; }
    function currentTileContainer(){
      // While a screen share is active, new tiles need to land in the
      // visible camera strip, not the hidden #meetingGrid (its children
      // got moved into the strip when the share started - see
      // showScreenShare/hideScreenShare) - otherwise someone joining
      // mid-share would be invisible until sharing stops.
      return document.getElementById('meetingCamStrip') || document.getElementById('meetingGrid');
    }
    function ensureTile(uid, name){
      var grid = currentTileContainer();
      if(!grid || document.getElementById(tileId(uid))) return;
      var el = document.createElement('div');
      el.className = 'meeting-tile';
      el.id = tileId(uid);
      el.innerHTML = '<div class="meeting-tile-noVideo">'+escapeHtml((name||'?').trim()[0]||'?').toUpperCase()+'</div>'+
        '<video autoplay playsinline'+(uid==='me'?' muted':'')+'></video>'+
        '<div class="meeting-tile-label"><span class="mic-off-icon" style="display:none;">'+ICON_MIC_OFF+'</span><span class="tile-name">'+escapeHtml(name||'Someone')+'</span></div>'+
        (canHost && uid!=='me' ? '<div class="meeting-host-panel"><button type="button" data-host-mute="'+uid+'">Mute</button><button type="button" data-host-remove="'+uid+'">Remove</button></div>' : '');
      grid.appendChild(el);
      wireHostPanelButtons(el);
      syncRecorderTiles();
    }
    function wireHostPanelButtons(el){
      var muteBtn = el.querySelector('[data-host-mute]');
      if(muteBtn) muteBtn.addEventListener('click', function(){ roomHandle.sendHostControl('mute', muteBtn.getAttribute('data-host-mute')); });
      var removeBtn = el.querySelector('[data-host-remove]');
      if(removeBtn) removeBtn.addEventListener('click', function(){ roomHandle.sendHostControl('remove', removeBtn.getAttribute('data-host-remove')); });
    }
    function removeTile(uid){
      var el = document.getElementById(tileId(uid));
      if(el) el.remove();
      syncRecorderTiles();
    }
    function setTileVideo(uid, stream){
      var el = document.getElementById(tileId(uid));
      if(!el) return;
      var v = el.querySelector('video');
      v.srcObject = stream;
      var noVid = el.querySelector('.meeting-tile-noVideo');
      if(noVid) noVid.style.display = 'none';
    }
    function setTileMicIcon(uid, micOn){
      var el = document.getElementById(tileId(uid));
      if(!el) return;
      var icon = el.querySelector('.mic-off-icon');
      if(icon) icon.style.display = micOn ? 'none' : '';
    }
    function updateTileName(uid, name){
      var el = document.getElementById(tileId(uid));
      if(!el) return;
      var n = el.querySelector('.tile-name'); if(n) n.textContent = name||'Someone';
    }

    // Hidden <audio> element per remote participant's mic - not shown as
    // its own tile (the tile's <video> carries the camera picture; audio
    // just needs to actually play).
    var audioEls = {};
    function playRemoteAudio(uid, stream){
      if(!audioEls[uid]){ audioEls[uid] = document.createElement('audio'); audioEls[uid].autoplay = true; document.body.appendChild(audioEls[uid]); }
      audioEls[uid].srcObject = stream;
      remoteStreamsForRecording[uid] = stream;
      syncRecorderAudio();
    }

    var screenState = { uid: null, videoEl: null }; // who's currently sharing, if anyone
    function showScreenShare(uid, name, stream){
      var grid = document.getElementById('meetingGrid');
      if(!grid) return;
      hideScreenShare();
      grid.classList.add('has-screen');
      var wrap = document.createElement('div');
      wrap.className = 'meeting-screen-row';
      wrap.id = 'meetingScreenRow';
      var screenTile = document.createElement('div');
      screenTile.className = 'meeting-tile screen-tile';
      var v = document.createElement('video');
      v.autoplay = true; v.playsInline = true; v.srcObject = stream;
      screenTile.appendChild(v);
      var label = document.createElement('div');
      label.className = 'meeting-tile-label'; label.textContent = name+' is presenting'; // .textContent, not innerHTML - no escaping needed
      screenTile.appendChild(label);
      var strip = document.createElement('div');
      strip.className = 'meeting-cam-strip';
      strip.id = 'meetingCamStrip';
      wrap.appendChild(screenTile); wrap.appendChild(strip);
      grid.parentNode.insertBefore(wrap, grid);
      grid.style.display = 'none';
      // Move every existing tile into the strip so they're still visible
      // (small) alongside the shared screen.
      Array.prototype.forEach.call(grid.children, function(t){ strip.appendChild(t); });
      screenState = { uid: uid, videoEl: v };
      syncRecorderTiles();
    }
    function hideScreenShare(){
      var row = document.getElementById('meetingScreenRow');
      var grid = document.getElementById('meetingGrid');
      if(row){
        var strip = document.getElementById('meetingCamStrip');
        if(strip && grid) Array.prototype.forEach.call(Array.prototype.slice.call(strip.children), function(t){ grid.appendChild(t); });
        row.remove();
      }
      if(grid){ grid.style.display=''; grid.classList.remove('has-screen'); }
      screenState = { uid: null, videoEl: null };
      syncRecorderTiles();
    }

    function syncRecorderTiles(){
      if(!recorder) return;
      var tiles = [];
      if(screenState.uid) tiles.push({ videoEl: screenState.videoEl, isScreen: true, label: '' });
      Array.prototype.forEach.call(document.querySelectorAll('#meetingGrid .meeting-tile, #meetingCamStrip .meeting-tile'), function(el){
        var v = el.querySelector('video');
        var name = el.querySelector('.tile-name');
        tiles.push({ videoEl: v, isScreen: false, label: name?name.textContent:'' });
      });
      recorder.setTiles(tiles);
    }
    function syncRecorderAudio(){
      if(!recorder) return;
      Object.keys(remoteStreamsForRecording).forEach(function(uid){ recorder.addAudioSource(remoteStreamsForRecording[uid]); });
    }

    // ---- join local media + the room ----
    meetingsLib.startLocalSession(true).then(function(session){
      mainSession = session;
      ensureTile('me', (myProfile&&myProfile.displayName)||'You');
      setTileVideo('me', session.stream);
      updateTileName('me', 'You');

      var nowIso = new Date().toISOString();
      var patch = { status:'live' };
      if(!m.startedAt) patch.startedAt = nowIso;
      // .neq('status','ended') instead of db.doc(...).update() - a genuine
      // race (host ends the meeting while someone else's camera/mic
      // permission prompt is still pending) can land this write AFTER the
      // 'ended' one; this makes an 'ended' status win no matter which write
      // lands last, instead of silently flipping the meeting back to live.
      supabase.from('meetings').update(patch).eq('id', meetingId).neq('status','ended').then(function(){});

      var logId = 'mpl_'+uid8();
      myParticipantLogId = logId;
      supabase.from('meetingParticipantLogs').insert({ id: logId, meetingId: meetingId, userId: myUid, joinedAt: nowIso }).then(function(){});

      mainSession.pc.ontrack = function(ev){
        var item = pendingPulls.shift();
        if(!item) return;
        if(item.trackName==='mic') playRemoteAudio(item.uid, ev.streams[0]);
        else if(item.trackName==='camera') setTileVideo(item.uid, ev.streams[0]);
        else if(item.trackName==='screen'){
          var meta = remoteMeta[item.uid];
          showScreenShare(item.uid, (meta&&meta.name)||'Someone', ev.streams[0]);
        } else if(item.trackName==='screenAudio'){
          if(!audioEls['screen_'+item.uid]){ audioEls['screen_'+item.uid]=document.createElement('audio'); audioEls['screen_'+item.uid].autoplay=true; document.body.appendChild(audioEls['screen_'+item.uid]); }
          audioEls['screen_'+item.uid].srcObject = ev.streams[0];
        }
      };

      roomHandle = meetingsLib.joinMeetingRoom(meetingId, { id: myUid, name: (myProfile&&myProfile.displayName)||'' }, {
        sessionId: mainSession.sessionId, camOn:true, micOn:true, screenSessionId:null, recording:false
      }, {
        onTrack: function(meta, sessionId, trackName){
          remoteMeta[meta.uid] = meta;
          ensureTile(meta.uid, meta.name);
          updateTileName(meta.uid, meta.name);
          pendingPulls.push({ uid: meta.uid, trackName: trackName });
          return meetingsLib.pullRemoteTrack(mainSession.sessionId, sessionId, trackName, mainSession.pc);
        },
        onMeta: function(uid, meta){
          remoteMeta[uid] = meta;
          ensureTile(uid, meta.name);
          updateTileName(uid, meta.name);
          setTileMicIcon(uid, meta.micOn!==false);
          if(!meta.screenSessionId && screenState.uid===uid) hideScreenShare();
          if(meta.recording) setRecBanner(true); else if(!Object.keys(remoteMeta).some(function(u){ return remoteMeta[u].recording; }) && !iAmRecording) setRecBanner(false);
        },
        onLeft: function(uid){
          delete remoteMeta[uid];
          delete remoteStreamsForRecording[uid];
          if(audioEls[uid]){ audioEls[uid].remove(); delete audioEls[uid]; }
          if(audioEls['screen_'+uid]){ audioEls['screen_'+uid].remove(); delete audioEls['screen_'+uid]; }
          if(screenState.uid===uid) hideScreenShare();
          removeTile(uid);
          syncRecorderAudio();
        },
        onHostControl: function(payload){
          if(payload.targetUid !== myUid) return;
          if(payload.action==='mute'){
            mainSession.stream.getAudioTracks().forEach(function(t){ t.enabled=false; });
            roomHandle.updateMeta({ micOn:false });
            updateMicBtn(false);
            showToast('info','The host muted your microphone');
          } else if(payload.action==='remove'){
            showToast('info','The host removed you from this meeting');
            location.hash = '#/meetings';
          }
        }
      });
    }).catch(function(err){
      showToast('error', errMsg(err));
    });

    // ---- controls ----
    var micOn = true, camOn = true;
    function updateMicBtn(on){
      micOn = on;
      var btn = document.getElementById('micBtn');
      if(btn){ btn.classList.toggle('off', !on); btn.classList.toggle('active', on); btn.innerHTML = on?ICON_MIC:ICON_MIC_OFF; }
    }
    function updateCamBtn(on){
      camOn = on;
      var btn = document.getElementById('camBtn');
      if(btn){ btn.classList.toggle('off', !on); btn.classList.toggle('active', on); btn.innerHTML = on?ICON_CAM:ICON_CAM_OFF; }
    }
    document.getElementById('micBtn').addEventListener('click', function(){
      if(!mainSession) return;
      var next = !micOn;
      mainSession.stream.getAudioTracks().forEach(function(t){ t.enabled = next; });
      // Muting used to only touch the mic session's own audio track - if
      // screen sharing with system audio is active, that's a completely
      // separate outgoing audio track (screenAudio) that "mute" silently
      // did nothing about. Mute now covers both, matching what someone
      // actually expects "mute" to mean.
      if(screenSession) screenSession.stream.getAudioTracks().forEach(function(t){ t.enabled = next; });
      updateMicBtn(next);
      if(roomHandle) roomHandle.updateMeta({ micOn: next });
    });
    document.getElementById('camBtn').addEventListener('click', function(){
      if(!mainSession) return;
      var next = !camOn;
      mainSession.stream.getVideoTracks().forEach(function(t){ t.enabled = next; });
      updateCamBtn(next);
      if(roomHandle) roomHandle.updateMeta({ camOn: next });
    });
    document.getElementById('screenBtn').addEventListener('click', function(){
      var btn = document.getElementById('screenBtn');
      if(screenSession){
        meetingsLib.endSession(screenSession);
        screenSession = null;
        hideScreenShare();
        if(roomHandle) roomHandle.updateMeta({ screenSessionId: null });
        btn.classList.remove('active');
        return;
      }
      openScreenShareOptionsModal(function(opts){
        meetingsLib.startScreenShareSession(opts).then(function(session){
          screenSession = session;
          if(!micOn) session.stream.getAudioTracks().forEach(function(t){ t.enabled = false; }); // stay muted through a screen share started while already muted
          showScreenShare('me', 'You', session.stream);
          if(roomHandle) roomHandle.updateMeta({ screenSessionId: session.sessionId });
          btn.classList.add('active');
          var vTrack = session.stream.getVideoTracks()[0];
          if(vTrack) vTrack.onended = function(){
            meetingsLib.endSession(screenSession);
            screenSession = null;
            hideScreenShare();
            if(roomHandle) roomHandle.updateMeta({ screenSessionId: null });
            btn.classList.remove('active');
          };
        }).catch(function(err){ showToast('error', errMsg(err)); });
      });
    });
    document.getElementById('devicesBtn').addEventListener('click', function(){
      if(!mainSession) return;
      var curMic = mainSession.stream.getAudioTracks()[0], curCam = mainSession.stream.getVideoTracks()[0];
      meetingsLib.listMediaDevices().then(function(res){
        var micOptions = res.mics.map(function(d,i){ return '<option value="'+escapeHtml(d.deviceId)+'"'+((curMic&&curMic.getSettings().deviceId===d.deviceId)?' selected':'')+'>'+escapeHtml(d.label||'Microphone '+(i+1))+'</option>'; }).join('');
        var camOptions = res.cameras.map(function(d,i){ return '<option value="'+escapeHtml(d.deviceId)+'"'+((curCam&&curCam.getSettings().deviceId===d.deviceId)?' selected':'')+'>'+escapeHtml(d.label||'Camera '+(i+1))+'</option>'; }).join('');
        openModal('Camera & microphone',
          '<div class="field"><label>Microphone</label><select name="micId">'+(micOptions||'<option value="">No microphones found</option>')+'</select></div>'+
          '<div class="field"><label>Camera</label><select name="camId">'+(camOptions||'<option value="">No cameras found</option>')+'</select></div>',
          function(fd){
            setModalBusy(true);
            var micId = fd.get('micId'), camId = fd.get('camId');
            Promise.all([
              (micId && (!curMic || curMic.getSettings().deviceId!==micId)) ? meetingsLib.switchDevice(mainSession, 'mic', micId) : Promise.resolve(),
              (camId && (!curCam || curCam.getSettings().deviceId!==camId)) ? meetingsLib.switchDevice(mainSession, 'camera', camId) : Promise.resolve(),
            ]).then(function(){
              closeModal(); showToast('success','Devices updated');
            }).catch(function(err){ showModalError(errMsg(err)); });
          }, 'Save');
      }).catch(function(err){ showToast('error', errMsg(err)); });
    });
    var recordBtn = document.getElementById('recordBtn');
    if(recordBtn) recordBtn.addEventListener('click', function(){
      if(iAmRecording){
        recordBtn.disabled = true;
        recorder.stop().then(function(path){
          iAmRecording = false;
          recordBtn.disabled = false;
          recordBtn.classList.remove('active');
          setRecBanner(false);
          if(roomHandle) roomHandle.updateMeta({ recording:false });
          if(path) showRecordingSavedModal(path);
        }).catch(function(err){ recordBtn.disabled=false; showToast('error', errMsg(err)); });
        return;
      }
      recorder = new MeetingRecorder();
      syncRecorderTiles();
      if(mainSession) recorder.addAudioSource(mainSession.stream);
      syncRecorderAudio();
      recorder.start({ title: m.title }).then(function(){
        iAmRecording = true;
        recordBtn.classList.add('active');
        setRecBanner(true);
        if(roomHandle) roomHandle.updateMeta({ recording:true });
        showToast('success','Recording started');
      }).catch(function(err){ showToast('error', errMsg(err)); recorder=null; });
    });
    var endMeetingBtn = document.getElementById('endMeetingBtn');
    if(endMeetingBtn) endMeetingBtn.addEventListener('click', function(){
      if(!confirm('End this meeting for everyone? Anyone still in it will be disconnected.')) return;
      db.doc('meetings/'+meetingId).update({ status:'ended', endedAt: new Date().toISOString() }).then(function(){
        location.hash = '#/meetings';
      }).catch(function(err){ showToast('error', errMsg(err)); });
    });
    document.getElementById('leaveBtn').addEventListener('click', function(){
      if(iAmRecording && !confirm('You\'re recording this meeting - stop recording and leave?')) return;
      location.hash = '#/meetings';
    });

    // If the host ends the meeting, every other participant's own page
    // needs to know - a plain onSnapshot on the meeting doc itself.
    meetingUnsub = db.doc('meetings/'+meetingId).onSnapshot(function(s){
      if(s.exists && s.data().status==='ended' && !meetingIsHost(s.data())){
        showToast('info','The host ended this meeting');
        location.hash = '#/meetings';
      }
    }, function(){});
    activeUnsubs.push(meetingUnsub);
  }).catch(function(err){
    paint('<div class="empty-state"><strong>Could not open this meeting</strong>'+escapeHtml(errMsg(err))+'</div>');
    activeMeetingRoomCleanup = null;
  });
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
    '<div class="section"><div class="section-head"><h2 class="section-title">Job-title roles</h2><button type="button" class="btn btn-sm" id="newRoleBtn">+ New role</button></div>'+
    '<div class="page-sub" style="margin:-6px 0 12px;">Shared across every Team, separate from Manager/Admin.</div>'+
    '<div id="rolesBox"></div></div>'+
    '<div class="section"><div class="section-head"><h2 class="section-title">Global services</h2><button type="button" class="btn btn-sm" id="newGlobalServiceBtn">+ New service type</button></div><div id="globalServicesBox"></div></div>'+
    '<div class="section"><div class="section-head"><h2 class="section-title">Meetings usage</h2></div><div id="meetingsUsageBox"><div class="skeleton" style="height:20px;"></div></div></div>'
  );
  renderMeetingsUsageMeter(document.getElementById('meetingsUsageBox'));
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
  document.getElementById('newRoleBtn').addEventListener('click', function(){ openRoleModal(null); });
  renderRolesBox();

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
        var svcId = btn.getAttribute('data-del-svc');
        var tag = btn.closest('.tag');
        if(tag) tag.classList.add('pending-remove');
        var svcData = servicesCache.filter(function(s){ return s.id===svcId; })[0];
        deleteService(svcId).then(function(){
          return refreshServicesCache().then(function(){
            actionWithUndo('Service deleted', function(){
              if(!svcData) return;
              db.doc('services/'+svcId).set(svcData).then(function(){ return refreshServicesCache(); }).then(route).catch(function(err){ showToast('error', errMsg(err)); });
            });
            route();
          });
        }).catch(function(err){ if(tag) tag.classList.remove('pending-remove'); showToast('error', errMsg(err)); });
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
          // Role change (Phase 2.5 batch D, item #7 - named explicitly as
          // an undo-toast candidate) - the checkbox already flips instantly
          // (native browser behavior, before this handler even runs).
          // Commits right away; Undo reverts the checkbox AND re-runs
          // assignRoles with the set this role held just before the click.
          var justChecked = cb.checked;
          var previousChecked = justChecked ? checked.filter(function(v){ return v!==cb.value; }) : checked.concat([cb.value]);
          assignRoles(uid, checked).then(function(){
            actionWithUndo('Role updated', function(){
              cb.checked = !justChecked;
              assignRoles(uid, previousChecked).catch(function(err){ showToast('error', errMsg(err)); });
            });
          }).catch(function(err){ cb.checked = !justChecked; showToast('error', errMsg(err)); });
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
      var svcId = btn.getAttribute('data-del-svc');
      var tag = btn.closest('.tag');
      if(tag) tag.classList.add('pending-remove');
      var svcData = servicesCache.filter(function(s){ return s.id===svcId; })[0];
      deleteService(svcId).then(function(){
        return refreshServicesCache().then(function(){
          actionWithUndo('Global service deleted', function(){
            if(!svcData) return;
            db.doc('services/'+svcId).set(svcData).then(function(){ return refreshServicesCache(); }).then(route).catch(function(err){ showToast('error', errMsg(err)); });
          });
          route();
        });
      }).catch(function(err){ if(tag) tag.classList.remove('pending-remove'); showToast('error', errMsg(err)); });
    });
  });
}

// Phase 3 - Admin panel role management (create/rename/delete a job-title
// role, see schema_v15.sql and the ROLES cache comment near the top of
// this file). "Rename" only ever updates label/color, never the row's own
// `key` - see openRoleModal - so nothing that already references a role by
// key (profileRoles, tasks, invites, template steps) can ever be orphaned
// by a rename. Delete uses the same commit-immediately-offer-undo pattern
// as every other destructive action (Phase 2.5 batch D) on top of its own
// confirm() - a role's blast radius (every dropdown/assignment company-
// wide) is bigger than a single row, so it keeps a touch more friction
// than a plain undo toast alone, same reasoning as client delete keeping
// its own "type the name back" gate. Nothing needs cleaning up if a role
// that's still in use gets deleted - every place that reads a role already
// falls back gracefully (roleOf() returning null shows the raw key or a
// grey chip instead of breaking) if the role it points at is gone.
function renderRolesBox(){
  var box = document.getElementById('rolesBox');
  if(!box) return;
  var editable = jobTitleRoles();
  box.innerHTML = editable.length ? editable.map(function(r){
    return '<div class="roster-row"><span class="role-chip" style="background:'+escapeHtml(r.color)+'">'+escapeHtml(r.label)+'</span>'+
      '<div style="margin-left:auto;display:flex;gap:8px;">'+
      '<button type="button" class="btn btn-sm" data-edit-role="'+escapeHtml(r.key)+'">Edit</button>'+
      '<button type="button" class="btn btn-sm btn-danger" data-delete-role="'+escapeHtml(r.key)+'">Delete</button>'+
      '</div></div>';
  }).join('') : '<div class="empty-state">No roles yet - add your first one.</div>';
  Array.prototype.forEach.call(box.querySelectorAll('[data-edit-role]'), function(btn){
    btn.addEventListener('click', function(){ openRoleModal(btn.getAttribute('data-edit-role')); });
  });
  Array.prototype.forEach.call(box.querySelectorAll('[data-delete-role]'), function(btn){
    btn.addEventListener('click', function(){
      var key = btn.getAttribute('data-delete-role');
      var roleData = ROLES.filter(function(r){ return r.key===key; })[0];
      if(!confirm('Delete "'+(roleData?roleData.label:key)+'"? Anyone or any task already assigned it keeps showing it - this only stops it from being offered for new assignments.')) return;
      db.doc('roles/'+key).delete().then(function(){
        return refreshRolesCache().then(function(){
          actionWithUndo('"'+(roleData?roleData.label:key)+'" deleted', function(){
            if(!roleData) return;
            db.doc('roles/'+key).set(roleData).then(function(){ return refreshRolesCache(); }).then(route).catch(function(err){ showToast('error', errMsg(err)); });
          });
          route();
        });
      }).catch(function(err){ showToast('error', errMsg(err)); });
    });
  });
}

function slugifyRoleKey(label){
  var base = label.toLowerCase().trim().replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,'');
  return base || 'role';
}

function openRoleModal(existingKey){
  var existing = existingKey ? ROLES.filter(function(r){ return r.key===existingKey; })[0] : null;
  openModal(existing ? 'Edit role' : 'New role',
    '<div class="field"><label>Label</label><input required name="label" type="text" value="'+(existing?escapeHtml(existing.label):'')+'" placeholder="e.g. Audio Engineer"></div>'+
    '<div class="field"><label>Color</label><input name="color" type="color" value="'+(existing?escapeHtml(existing.color):'#5b6472')+'" style="height:38px;width:70px;padding:2px;"></div>'+
    '<div class="field-hint">Role labels are always shown in white text on this color - pick something mid-to-dark so it stays readable.</div>',
    function(fd){
      var label = (fd.get('label')||'').trim();
      if(!label){ showModalError('Name the role.'); return; }
      var color = fd.get('color') || '#5b6472';
      setModalBusy(true);
      if(existing){
        db.doc('roles/'+existing.key).update({label:label, color:color}).then(function(){
          return refreshRolesCache();
        }).then(function(){
          closeModal(); showToast('success','Role updated'); route();
        }).catch(function(err){ showModalError(errMsg(err)); });
      } else {
        var base = slugifyRoleKey(label);
        var key = base, n = 2;
        while(ROLES.some(function(r){ return r.key===key; })){ key = base+'_'+n; n++; }
        var maxOrder = ROLES.reduce(function(m,r){ return Math.max(m, r.sortOrder||0); }, 0);
        db.doc('roles/'+key).set({key:key, label:label, color:color, sortOrder:maxOrder+1, createdAt:new Date().toISOString()}).then(function(){
          return refreshRolesCache();
        }).then(function(){
          closeModal(); showToast('success','Role created'); route();
        }).catch(function(err){ showModalError(errMsg(err)); });
      }
    }, existing?'Save':'Create');
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
    '<div class="login-brand"><div class="brand-mark"><img src="/logo-mark.png" alt="Blue Kite Media"></div><div><div class="brand-name">Blue Kite Media</div><div class="brand-sub">Take Flight</div></div></div>'+
    '<div class="login-title">'+(isSignup?'Create your account':'Sign in')+'</div>'+
    '<div class="login-sub">'+(isSignup?'You\'ll need the invite code your manager or admin sent you - unless you\'re the very first person setting this up.':'Use your Blue Kite Ops account.')+'</div>'+
    '<div class="login-error" id="authError"></div>'+
    '<form id="authForm">'+
    (isSignup?'<div class="login-field"><label>Your name</label><input name="displayName" type="text" placeholder="Jane Doe" required></div>':'')+
    '<div class="login-field"><label>Email</label><input required name="email" type="email" placeholder="you@bluekitemedia.com"></div>'+
    '<div class="login-field"><label>Password</label><input required name="password" type="password" placeholder="••••••••" minlength="6"></div>'+
    (isSignup?'<div class="login-field"><label>Invite code (leave blank only if you\'re the first-ever account)</label><input name="inviteCode" type="text" placeholder="e.g. 9f2ac1"></div>':'')+
    (isSignup?'<div class="login-field"><label>Profile photo (must show your face)</label><div class="avatar-drop" id="avatarDrop"><div class="avatar-drop-hint" id="avatarHint">Click to choose a photo</div><input type="file" accept="image/*" id="avatarInput" style="display:none;"></div></div>':'')+
    (isSignup?'<div class="login-field"><label>What do you prefer listening to when working? (pick any number)</label><div class="mood-grid" id="moodGrid">'+MOODS.map(function(m){return '<button type="button" class="mood-pick" data-mood="'+m.key+'">'+escapeHtml(m.label)+'</button>';}).join('')+'</div><input type="hidden" name="musicMoods"></div>':'')+
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
    var moodInput = document.querySelector('input[name=musicMoods]');
    // Phase 4: multi-select (was one mood, click-to-replace) - any number
    // of moods can be picked, and playback shuffles across all of them by
    // default (see src/lib/music.js). "I'd rather not" stays mutually
    // exclusive with everything else, same as before, since picking it
    // means no music at all, not "shuffle between no-music and a mood."
    function syncMoodInput(){
      var picked = Array.prototype.filter.call(moodGrid.querySelectorAll('.mood-pick'), function(b){ return b.classList.contains('selected'); }).map(function(b){ return b.getAttribute('data-mood'); });
      moodInput.value = picked.join(',');
    }
    Array.prototype.forEach.call(moodGrid.querySelectorAll('.mood-pick'), function(btn){
      btn.addEventListener('click', function(){
        var isNone = btn.getAttribute('data-mood')==='none';
        if(isNone){
          Array.prototype.forEach.call(moodGrid.querySelectorAll('.mood-pick'), function(b){ b.classList.remove('selected'); });
          btn.classList.add('selected');
        } else {
          var noneBtn = moodGrid.querySelector('[data-mood="none"]');
          if(noneBtn) noneBtn.classList.remove('selected');
          btn.classList.toggle('selected');
        }
        syncMoodInput();
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
        var musicMoods = (fd.get('musicMoods')||'').split(',').filter(Boolean);
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
        var moodDone = musicMoods.length
          ? db.doc('profiles/'+uid).update({ musicMoods: musicMoods }).catch(function(err){
              console.warn('[blue-kite-ops] music mood save failed:', err);
              setTimeout(function(){ showToast('error', 'Your music mood(s) didn\'t save ('+errMsg(err)+'). Ask an admin to help you set them.'); }, 800);
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
  else timelog.clockIn(myUid).then(function(){ updateClockUI(); musicPlayer.notifyClockedIn(); }).catch(function(err){ showToast('error', errMsg(err)); });
}
// Standby (Phase 2.5 batch D, item #8) - only meaningful while clocked in;
// the button itself is hidden/disabled otherwise (see updateClockUI), but
// guard here too in case this ever fires from somewhere else.
function toggleStandby(){
  if(!timelog.isClockedIn()) return;
  if(timelog.isOnStandby()) timelog.exitStandby().then(updateClockUI).catch(function(err){ showToast('error', errMsg(err)); });
  else timelog.enterStandby().then(updateClockUI).catch(function(err){ showToast('error', errMsg(err)); });
}
function updateClockUI(){
  var clockedIn = timelog.isClockedIn();
  var onStandby = timelog.isOnStandby();
  var label = clockedIn ? '● Clocked in - stop' : 'Clock in';
  var standbyLabel = onStandby ? '● Standby - resume' : 'Standby';
  var badge = document.getElementById('globalClockBadge');
  if(badge){ badge.classList.toggle('off', !clockedIn); badge.textContent = label; }
  var pageBtn = document.getElementById('clockToggleBtn');
  if(pageBtn){ pageBtn.classList.toggle('off', !clockedIn); pageBtn.textContent = label; }
  var sBadge = document.getElementById('globalStandbyBadge');
  if(sBadge){ sBadge.hidden = !clockedIn; sBadge.disabled = !clockedIn; sBadge.classList.toggle('on', onStandby); sBadge.textContent = standbyLabel; }
  var sPageBtn = document.getElementById('standbyToggleBtn');
  if(sPageBtn){ sPageBtn.hidden = !clockedIn; sPageBtn.disabled = !clockedIn; sPageBtn.classList.toggle('on', onStandby); sPageBtn.textContent = standbyLabel; }
  // Refresh the TimeLog page's own session list immediately if it's open,
  // rather than only after the next manual reload.
  if(location.hash.replace(/^#/,'')==='/timelog') route();
}
function ensureGlobalClockBadge(){
  if(document.getElementById('globalClockGroup')) { updateClockUI(); return; }
  var group = document.createElement('div');
  group.id = 'globalClockGroup';
  group.className = 'global-clock-group';
  var btn = document.createElement('button');
  btn.type = 'button';
  btn.id = 'globalClockBadge';
  btn.className = 'timelog-badge';
  btn.addEventListener('click', toggleClock);
  var sBtn = document.createElement('button');
  sBtn.type = 'button';
  sBtn.id = 'globalStandbyBadge';
  sBtn.className = 'timelog-badge standby-badge';
  sBtn.title = 'Waiting on something external (a render, an export, etc.) - pauses screenshots/activity without clocking out';
  sBtn.addEventListener('click', toggleStandby);
  group.appendChild(btn);
  group.appendChild(sBtn);
  document.body.appendChild(group);
  updateClockUI();
}
function removeGlobalClockBadge(){
  var group = document.getElementById('globalClockGroup');
  if(group) group.remove();
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
      musicPlayer.notifyClockedIn();
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
    el.innerHTML = '<div class="login-card"><div class="login-brand"><div class="brand-mark"><img src="/logo-mark.png" alt="Blue Kite Media"></div><div><div class="brand-name">Blue Kite Media</div><div class="brand-sub">Take Flight</div></div></div>'+
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
  var notifBellBtn = document.getElementById('notifBellBtn');
  if(notifBellBtn) notifBellBtn.addEventListener('click', openNotificationsPanel);
  var soundMuteBtn = document.getElementById('soundMuteBtn');
  if(soundMuteBtn){
    setSoundsMuted(soundsMuted); // paints the right icon/title for whatever localStorage already said
    soundMuteBtn.addEventListener('click', function(){ setSoundsMuted(!soundsMuted); });
  }

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
      stopNotificationsListener();
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
        var activityNav = document.getElementById('navActivity'); if(activityNav) activityNav.hidden = !canManage();
        // Real bug (2026-09-29, "my own role/everyone's role shows as a raw
        // lowercase key, even after reloading"): this render call used to
        // be the ONLY place renderIdentityCard() ever runs, and it fired
        // synchronously here - BEFORE refreshRolesCache() below has even
        // started, let alone finished. ROLES starts as a genuinely empty
        // array (see its own var declaration), so roleOf() always returned
        // null on this first paint, correctly falling back to showing the
        // raw role key - and since nothing ever called renderIdentityCard()
        // again afterward, that wrong render just stayed forever, on every
        // single load, reload included, regardless of the roles table's
        // own data (which was never actually the problem). Still called
        // immediately here for a snappy first paint (ROLES may well
        // already be populated from earlier in the session), but now also
        // re-run once refreshRolesCache() actually resolves, so it's
        // guaranteed to reflect real data at least once per load.
        renderIdentityCard();
        Promise.all([refreshTeamsCache(), refreshServicesCache(), refreshRolesCache()]).then(function(){ renderIdentityCard(); route(); });
        // Real bug (2026-09-29, reported as "the music player never shows
        // up for employees at all" - true even before the YouTube->Drive
        // switch, so it was never about either backend): this used to be
        // wasFirstLoad-only, meaning it got exactly ONE chance, on the
        // very first profiles snapshot of the session, to see musicMoods
        // already populated. If that field saved a moment AFTER the first
        // snapshot fired (e.g. right after signup - see the independent
        // avatar/mood save above, which is deliberately NOT chained before
        // the profile even exists) or was set/changed by an admin later in
        // the same session, profileMoods(p) came back empty on that one
        // and only chance and the player permanently never mounted for the
        // rest of the session - every later snapshot (with the real moods
        // now in place) was simply never looked at again. Moved outside
        // the wasFirstLoad gate: mountMusicPlayer()/initPlayer() already
        // guard themselves against re-running (musicPlayerBuilt, the
        // `if(audioEl) return` in initPlayer), so calling this on every
        // snapshot is safe and just means it mounts as soon as real data
        // is actually available, however many snapshots that takes.
        if(p && !hasOptedOutOfMusic(p)){
          var moods = profileMoods(p);
          mountMusicPlayer(moods); musicPlayer.initPlayer('ytMusicMount', moods);
        }
        if(wasFirstLoad && p){
          startPresence(myUid, { displayName: p.displayName });
          listenForConnects(myUid, { onRing: handleIncomingRing, onRingMissed: handleRingMissed });
          startNotificationsListener();
          // Reconnect to an already-open clock-in (e.g. after a reload)
          // before ever deciding whether to show the "ready to start your
          // day?" prompt - showing that prompt to someone who's already
          // clocked in was the visible symptom of the reload/clock-out
          // desync bug (a reload used to silently stop capture without
          // actually clocking anyone out server-side).
          timelog.resumeIfClockedIn(myUid).then(function(){
            ensureGlobalClockBadge();
            if(!timelog.isClockedIn()) setTimeout(showClockInOverlay, 600);
            else musicPlayer.notifyClockedIn(); // already clocked in from before relaunch - no fresh click here, so this may just arm the next one (see notifyClockedIn's own comment)
          });
        }
        }); // end listRolesFor(...).then - myRoles block
      }, function(){ renderRoleBoxFallback(); route(); });
    }
  });
})();
// Phase 4: profiles.musicMood (one mood) is superseded by
// profiles.musicMoods (an array) - falls back to wrapping the old single
// value in a one-item array for anyone who signed up before this round,
// same "live value, fall back to the old baked-in one" shape used
// elsewhere in this file (e.g. stepDepIds()).
function profileMoods(p){
  if(p && p.musicMoods && p.musicMoods.length) return p.musicMoods;
  if(p && p.musicMood && p.musicMood!=='none') return [p.musicMood];
  return [];
}
// Real bug (2026-09-29): the music player was gated on profileMoods(p)
// having at least one entry - which conflated two very different things
// as if they were the same: someone who explicitly picked "I'd rather
// not" at signup (musicMoods: ['none'], a real, deliberate value) versus
// an account with NO mood data recorded at all (musicMoods: [], musicMood:
// null - confirmed via a live DB check on a real account from 2026-09-21,
// predating the mood-picker feature entirely). Both produced an empty
// array from profileMoods() and both silently never mounted the player -
// but only the first one is an actual opt-out. Someone in the second
// group had no way to ever fix this themselves either, since the mood
// dropdown that could change their pick IS the player widget, which never
// showed up in the first place - a real chicken-and-egg gap, not just a
// missing default. Now only a genuine explicit "none" skips mounting;
// anyone else (including empty/never-set data) gets the player defaulting
// to Mixed, exactly like a brand-new account with no signup preference
// captured at all should.
function hasOptedOutOfMusic(p){
  if(!p) return false;
  if(p.musicMoods && p.musicMoods.length===1 && p.musicMoods[0]==='none') return true;
  if((!p.musicMoods || !p.musicMoods.length) && p.musicMood==='none') return true;
  return false;
}
var musicPlayerBuilt = false;
var ICON_PLAY = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M7 4l14 8-14 8V4z"/></svg>';
var ICON_PAUSE = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>';
var ICON_SKIP = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M5 4l12 8-12 8V4z"/><rect x="18" y="4" width="2.5" height="16" rx="1"/></svg>';

// Rebuilt entirely for the Drive-backed player (2026-09-29) - no more
// visible video frame (#ytMusicMount was the YouTube IFrame API's required
// minimum-visible-size embed; real <audio> needs no on-screen element at
// all), restyled to match the app's own icon language instead of emoji
// glyphs, and the mood dropdown now lists EVERY mood plus Mixed, not just
// whatever this person happened to pick at signup - see music.js's header
// comment for why that changed (it was the direct cause of "I can only
// ever choose Electronic or Mixed").
// Remembers where this person last dragged the floating music widget to,
// per device (same reasoning as the sound-mute toggle's own localStorage
// use - a personal placement preference, not something to sync across
// devices/accounts). Falls back to a sensible bottom-left default (near
// where it used to sit, docked in the sidebar) the first time, or if
// localStorage throws (private window, blocked storage, etc.).
function loadMusicBoxPos(){
  try{
    var raw = localStorage.getItem('bko_musicBoxPos');
    if(raw){
      var p = JSON.parse(raw);
      // Sanity-clamp against the CURRENT window size, not just "is it a
      // number" - a position saved on a bigger window (or from the
      // off-screen-default bug this is fixing) could otherwise land
      // permanently out of view with no way to reach the drag handle to
      // fix it.
      if(typeof p.left==='number' && typeof p.top==='number' && p.left>=0 && p.top>=0 && p.left<window.innerWidth-40 && p.top<window.innerHeight-20) return p;
    }
  }catch(e){}
  return null;
}
function saveMusicBoxPos(left, top){
  try{ localStorage.setItem('bko_musicBoxPos', JSON.stringify({left:left, top:top})); }catch(e){}
}
function mountMusicPlayer(moods){
  var box = document.getElementById('musicPlayerBox');
  if(!box) return;
  if(!musicPlayerBuilt){
    musicPlayerBuilt = true;
    var moodOptions = '<option value="">Mixed (all moods)</option>'+MOODS.filter(function(m){return m.key!=='none';}).map(function(m){
      return '<option value="'+escapeHtml(m.key)+'">'+escapeHtml(m.label)+'</option>';
    }).join('');
    box.innerHTML =
      '<div class="music-player">'+
        '<div class="music-now-playing" id="musicDragHandle" title="Drag to move"><div class="music-note-icon">'+ICON_SOUND_ON+'</div><div class="music-meta" id="musicMeta">-</div></div>'+
        '<div class="music-row">'+
          '<button type="button" class="music-btn" id="musicToggleBtn" title="Play/pause">'+ICON_PLAY+'</button>'+
          '<button type="button" class="music-btn" id="musicSkipBtn" title="Change track">'+ICON_SKIP+'</button>'+
          '<button type="button" class="music-btn music-btn-ghost" id="musicMuteBtn" title="Mute">'+ICON_SOUND_ON+'</button>'+
          '<input type="range" class="music-volume" id="musicVolume" min="0" max="100" value="70" title="Volume">'+
        '</div>'+
        '<select class="music-mood-select" id="musicMoodSelect">'+moodOptions+'</select>'+
      '</div>';
    document.getElementById('musicToggleBtn').addEventListener('click', musicPlayer.toggle);
    document.getElementById('musicSkipBtn').addEventListener('click', musicPlayer.next);
    document.getElementById('musicMuteBtn').addEventListener('click', musicPlayer.toggleMute);
    document.getElementById('musicVolume').addEventListener('input', function(e){ musicPlayer.setVolume(+e.target.value); });
    document.getElementById('musicMoodSelect').addEventListener('change', function(e){ musicPlayer.setFilter(e.target.value||null); });

    // Draggable anywhere in the app (2026-09-29 ask) - moved out of the
    // sidebar's own flow in index.html into a position:fixed box so it can
    // float over any page, not just sit docked where the sidebar put it.
    // Only the "now playing" row is the actual drag handle - the buttons/
    // slider/dropdown below it need normal clicks to keep working.
    // Real bug (2026-09-29, "music plays but the box is invisible"): this
    // used to measure the box's position via getBoundingClientRect() BEFORE
    // giving it any explicit left/top - but #musicPlayerBox now lives
    // outside the sidebar's own layout flow (moved to be a direct child of
    // <body> in index.html so it can float over the whole app), and a
    // position:fixed element with no left/top set renders at its normal
    // in-flow "static" position, which - right after #shell, a full-height
    // flex row - is BELOW THE VISIBLE VIEWPORT. That off-screen coordinate
    // was exactly what got saved/applied as its position on every mount.
    // Fixed: give it a real on-screen position FIRST (temporary, so the
    // size measurement below is meaningful), then compute a proper
    // bottom-left default from that if nothing's been saved yet.
    var saved = loadMusicBoxPos();
    box.style.left = '16px';
    box.style.top = '16px';
    if(saved){
      box.style.left = saved.left+'px';
      box.style.top = saved.top+'px';
    } else {
      var boxRect0 = box.getBoundingClientRect();
      box.style.top = Math.max(12, window.innerHeight - boxRect0.height - 16) + 'px';
    }
    var handle = document.getElementById('musicDragHandle');
    var dragging = false, startMouseX=0, startMouseY=0, startLeft=0, startTop=0;
    handle.addEventListener('mousedown', function(ev){
      dragging = true;
      startMouseX = ev.clientX; startMouseY = ev.clientY;
      var rect = box.getBoundingClientRect();
      startLeft = rect.left; startTop = rect.top;
      ev.preventDefault();
    });
    document.addEventListener('mousemove', function(ev){
      if(!dragging) return;
      var rect = box.getBoundingClientRect();
      var maxLeft = window.innerWidth - rect.width - 4, maxTop = window.innerHeight - rect.height - 4;
      var left = Math.max(4, Math.min(maxLeft, startLeft + (ev.clientX-startMouseX)));
      var top = Math.max(4, Math.min(maxTop, startTop + (ev.clientY-startMouseY)));
      box.style.left = left+'px'; box.style.top = top+'px';
    });
    document.addEventListener('mouseup', function(){
      if(!dragging) return;
      dragging = false;
      var rect = box.getBoundingClientRect();
      saveMusicBoxPos(rect.left, rect.top);
    });
  }
  musicPlayer.onPlayerChange(function(s){
    var meta = document.getElementById('musicMeta');
    var toggleBtn = document.getElementById('musicToggleBtn');
    var muteBtn = document.getElementById('musicMuteBtn');
    var volume = document.getElementById('musicVolume');
    var moodSelect = document.getElementById('musicMoodSelect');
    if(!meta) return; // widget got torn down (e.g. sign-out) - nothing to update
    if(!s.hasTracks){
      meta.textContent = 'No tracks in "'+(s.moodLabel||'')+'" yet';
      return;
    }
    // Track title text stays hidden once something's actually playing
    // (Phase 5 ask) - only the mood name/"Loading…" status shows.
    meta.textContent = (s.track && s.track.title) ? (s.moodLabel||'Playing') : (s.moodLabel || 'Loading…');
    if(toggleBtn) toggleBtn.innerHTML = s.playing ? ICON_PAUSE : ICON_PLAY;
    if(muteBtn) muteBtn.innerHTML = s.muted ? ICON_SOUND_OFF : ICON_SOUND_ON;
    if(volume && document.activeElement!==volume) volume.value = s.volume;
    if(moodSelect && document.activeElement!==moodSelect) moodSelect.value = s.moodFilter || '';
  });
}

function renderRoleBoxFallback(){ var box=document.getElementById('roleBox'); if(box) box.innerHTML='<div class="role-box-label">Could not load your profile.</div>'; }
