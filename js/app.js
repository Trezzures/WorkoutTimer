'use strict';

/* ════════════════════════════════════════════════════════════
   CONSTANTS
   ════════════════════════════════════════════════════════════ */
const BODY_PARTS   = ['Arms/Chest', 'Legs', 'Abs', 'Back'];
const PHASE_LABELS = { 1:'Beginner', 2:'Intermediate', 3:'Advanced', 4:'Pro' };
const PART_COLORS  = { 'Arms/Chest':'arms', 'Legs':'legs', 'Abs':'abs', 'Back':'back' };
const PART_ICONS   = { 'Arms/Chest':'💪', 'Legs':'🦵', 'Abs':'🔥', 'Back':'🏋️' };
const HISTORY_KEY  = 'dailyreps_history';
const TIMER_CIRC   = 553;   /* 2π × 88 — matches SVG r="88" */
const REST_CIRC    = 427;   /* 2π × 68 — matches SVG r="68" */

/* ════════════════════════════════════════════════════════════
   STATE
   ════════════════════════════════════════════════════════════ */
let EXERCISES = {};

// Setup selections
let selectedBodyPart  = null;
let selectedPhase     = null;
let selectedExercises = [];
let selectedSets      = 3;
let selectedRest      = 30;   // seconds

// Circuit engine
let circuitSlots   = [];
let currentSlotIdx = 0;

// Workout timer
let workoutInterval = null;
let workoutSeconds  = 0;

// Rest timer
let restInterval    = null;
let restRemaining   = 0;
let restCallback    = null;   // called when rest ends

// History view
let historyWeekOffset = 0;

/* ════════════════════════════════════════════════════════════
   BOOT
   ════════════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', async () => {
  try {
    const res = await fetch('data/exercises.json');
    EXERCISES = await res.json();
  } catch {
    document.body.innerHTML =
      '<p style="color:#ff5c7c;padding:40px;font-family:sans-serif;">'+
      '⚠️ Could not load exercises.json. Open via a local server '+
      '(e.g. <code>npx serve .</code> or VS Code Live Server).</p>';
    return;
  }
  initSetup();
  renderWeekStrip();
});

/* ════════════════════════════════════════════════════════════
   SUPABASE CLIENT
   ─────────────────────────────────────────────────────────────
   SETUP (one-time, ~5 minutes):

   1. Create a free account at https://supabase.com
   2. Create a new project (pick any region, remember your DB password)
   3. In the Supabase dashboard go to Table Editor → New Table:
        Name:  workouts
        Columns (add each one):
          id               bigint        primary key, default: gen_random_uuid() — actually use int8 identity
          created_at       timestamptz   default: now()
          date             text          not null
          body_part        text          not null
          phase            int4          not null
          sets             int4          not null
          duration_seconds int4          not null
          exercises        jsonb         not null   ← stores the array of exercise names
      Leave RLS off for now (you can enable it later when you add auth)
   4. Go to Project Settings → API:
        Copy "Project URL"  → paste as SUPABASE_URL below
        Copy "anon public"  → paste as SUPABASE_ANON_KEY below
   5. Save and refresh the page — history now reads/writes from Postgres

   COLUMN NAME NOTE:
   Supabase uses snake_case. The JS objects in this file use camelCase.
   The toRecord() / fromRecord() helpers below translate between them.
   ════════════════════════════════════════════════════════════ */

const SUPABASE_URL      = 'https://bvwndtboqgybhcvzhfln.supabase.co/rest/v1/';   // ← replace
const SUPABASE_ANON_KEY = 'sb_publishable_PlPqkfU7J2HvGJsmEqHiGg_QGhGsEzl';                    // ← replace

const db = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

/* Translate a JS workout object → Supabase row */
function toRecord(w) {
  return {
    date:             w.date,
    body_part:        w.bodyPart,
    phase:            w.phase,
    sets:             w.sets,
    duration_seconds: w.durationSeconds,
    exercises:        w.exercises,   // jsonb accepts a JS array directly
  };
}

/* Translate a Supabase row → JS workout object */
function fromRecord(row) {
  return {
    id:              row.id,
    date:            row.date,
    bodyPart:        row.body_part,
    phase:           row.phase,
    sets:            row.sets,
    durationSeconds: row.duration_seconds,
    exercises:       row.exercises,  // already parsed from jsonb
  };
}

/* ── Core storage functions ─────────────────────────────────
   All three are async — everything that calls them uses await.
   ─────────────────────────────────────────────────────────── */

async function getHistory() {
  const { data, error } = await db
    .from('workouts')
    .select('*')
    .order('date', { ascending: false });

  if (error) {
    console.error('getHistory error:', error.message);
    return [];
  }
  return (data || []).map(fromRecord);
}

async function saveWorkout(record) {
  const { error } = await db
    .from('workouts')
    .insert(toRecord(record));

  if (error) {
    console.error('saveWorkout error:', error.message);
    showToast('⚠️ Could not save workout');
    return false;
  }
  return true;
}

async function deleteWorkoutById(id) {
  const { error } = await db
    .from('workouts')
    .delete()
    .eq('id', id);

  if (error) {
    console.error('deleteWorkout error:', error.message);
    showToast('⚠️ Could not delete workout');
    return false;
  }
  return true;
}

/* ════════════════════════════════════════════════════════════
   WEEK HELPERS  (all async because getHistory is async)
   ════════════════════════════════════════════════════════════ */
function getStartOfWeek(date) {
  const d = new Date(date);
  d.setHours(0,0,0,0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d;
}
async function getWorkoutsInWeek(ws) {
  const we = new Date(ws); we.setDate(ws.getDate() + 7);
  const all = await getHistory();
  return all.filter(w => { const d=new Date(w.date); return d>=ws && d<we; });
}
async function getCurrentWeekWorkouts() { return getWorkoutsInWeek(getStartOfWeek(new Date())); }
async function getPartsThisWeek()       { return (await getCurrentWeekWorkouts()).map(w => w.bodyPart); }

/* ════════════════════════════════════════════════════════════
   WEEK STRIP
   ════════════════════════════════════════════════════════════ */
async function renderWeekStrip() {
  const strip = document.getElementById('week-strip');
  const ww    = await getCurrentWeekWorkouts();
  strip.innerHTML = BODY_PARTS.map(part => {
    const isDone = done.includes(part);
    const count  = ww.filter(w => w.bodyPart === part).length;
    return `<div class="week-card ${isDone?'done':''}" onclick="quickSelectBodyPart('${part}')">
      ${isDone ? '<div class="week-done-badge">✓</div>' : ''}
      <div class="week-card-icon">${PART_ICONS[part]}</div>
      <div class="week-card-label">${part}</div>
      <div class="week-card-count">${count>0 ? count+' this week' : 'Not done yet'}</div>
    </div>`;
  }).join('');
}

function quickSelectBodyPart(part) {
  document.querySelectorAll('#bodypart-pills .pill')
    .forEach(p => p.classList.toggle('selected', p.dataset.part === part));
  selectedBodyPart  = part;
  selectedExercises = [];
  renderExerciseList();
  updateStartButton();
}

/* ════════════════════════════════════════════════════════════
   SETUP
   ════════════════════════════════════════════════════════════ */
function initSetup() {
  document.getElementById('bodypart-pills').innerHTML = BODY_PARTS.map(part =>
    `<div class="pill" data-part="${part}" onclick="selectBodyPart(this)">${PART_ICONS[part]} ${part}</div>`
  ).join('');
  document.getElementById('sets-value').textContent = selectedSets;
  document.getElementById('rest-value').textContent = selectedRest;
  updateSetsStepper();
  updateRestStepper();
}

function selectBodyPart(el) {
  document.querySelectorAll('#bodypart-pills .pill').forEach(p => p.classList.remove('selected'));
  el.classList.add('selected');
  selectedBodyPart  = el.dataset.part;
  selectedExercises = [];
  renderExerciseList();
  updateStartButton();
}

function selectPhase(el) {
  document.querySelectorAll('#phase-pills .pill').forEach(p => p.classList.remove('selected'));
  el.classList.add('selected');
  selectedPhase     = parseInt(el.dataset.phase);
  selectedExercises = [];
  renderExerciseList();
  updateStartButton();
}

function renderExerciseList() {
  const group = document.getElementById('exercise-select-group');
  if (!selectedBodyPart || !selectedPhase) { group.style.display='none'; return; }
  const list = EXERCISES[selectedBodyPart]?.[String(selectedPhase)] || [];
  if (!list.length) { group.style.display='none'; return; }
  group.style.display = 'block';
  document.getElementById('exercise-list').innerHTML = list.map((ex,i) =>
    `<div class="exercise-item" onclick="toggleExercise(this,${i})">
      <div class="exercise-check"></div>
      <div class="exercise-name">${ex.name}</div>
    </div>`
  ).join('');
  updateExCountLabel();
}

function toggleExercise(el, idx) {
  const ex  = EXERCISES[selectedBodyPart][String(selectedPhase)][idx];
  const pos = selectedExercises.findIndex(e => e.name === ex.name);
  if (pos===-1) { selectedExercises.push(ex); el.classList.add('selected'); }
  else          { selectedExercises.splice(pos,1); el.classList.remove('selected'); }
  updateExCountLabel();
  updateStartButton();
}

function updateExCountLabel() {
  const n = selectedExercises.length;
  const l = document.getElementById('ex-count-label');
  l.textContent = n===0 ? '(pick 1 or more)' : `(${n} selected)`;
  l.style.color = n>=1 ? 'var(--teal)' : 'var(--text-dim)';
}
function updateStartButton() {
  document.getElementById('btn-start').disabled =
    !(selectedBodyPart && selectedPhase && selectedExercises.length>=1);
}

function changeSets(delta) {
  selectedSets = Math.max(1, Math.min(6, selectedSets+delta));
  document.getElementById('sets-value').textContent = selectedSets;
  updateSetsStepper();
}
function updateSetsStepper() {
  document.getElementById('sets-dec').disabled = selectedSets<=1;
  document.getElementById('sets-inc').disabled = selectedSets>=6;
}

function changeRest(delta) {
  selectedRest = Math.max(0, Math.min(120, selectedRest+delta));
  document.getElementById('rest-value').textContent = selectedRest;
  updateRestStepper();
}
function updateRestStepper() {
  document.getElementById('rest-dec').disabled = selectedRest<=0;
  document.getElementById('rest-inc').disabled = selectedRest>=120;
}

/* ════════════════════════════════════════════════════════════
   CIRCUIT ENGINE
   ════════════════════════════════════════════════════════════ */
function buildCircuit(exercises, sets) {
  const slots = [];
  for (let round=1; round<=sets; round++)
    for (let ei=0; ei<exercises.length; ei++)
      slots.push({ exercise:exercises[ei], exIndex:ei, setNumber:round, totalSets:sets });
  return slots;
}

/* ════════════════════════════════════════════════════════════
   START WORKOUT
   ════════════════════════════════════════════════════════════ */
function startWorkout() {
  circuitSlots   = buildCircuit(selectedExercises, selectedSets);
  currentSlotIdx = 0;
  workoutSeconds = 0;

  showPanel('workout');
  document.getElementById('workout-title').textContent =
    `${PART_ICONS[selectedBodyPart]} ${selectedBodyPart} — Phase ${selectedPhase}`;

  renderQueue();
  showSlot(0);
  startWorkoutTimer();
}

/* ════════════════════════════════════════════════════════════
   SHOW SLOT
   ════════════════════════════════════════════════════════════ */
function showSlot(idx) {
  const slot   = circuitSlots[idx];
  const isLast = idx === circuitSlots.length - 1;

  // Round label
  document.getElementById('current-ex-round').textContent =
    `Round ${slot.setNumber} of ${slot.totalSets}  ·  Exercise ${slot.exIndex+1} of ${selectedExercises.length}`;

  // Name
  document.getElementById('current-ex-name').textContent = slot.exercise.name;

  // Tip
  const tipEl = document.getElementById('current-ex-tip');
  tipEl.innerHTML = slot.exercise.tip || '';

  // Set dots — show progress for THIS exercise across all its sets
  renderSetDots(slot);

  // Done button label
  document.getElementById('btn-done').textContent = isLast ? 'Complete Workout 🎉' : 'Done — Next →';
}

function renderSetDots(slot) {
  // How many sets of this exercise are already done?
  const doneCount = circuitSlots
    .slice(0, currentSlotIdx)
    .filter(s => s.exIndex === slot.exIndex).length;

  const label = document.getElementById('set-progress-label');
  label.textContent = `${slot.exercise.name} — Set ${slot.setNumber} of ${slot.totalSets}`;

  document.getElementById('set-dots').innerHTML = Array.from({length: slot.totalSets}, (_,i) => {
    const cls = i < doneCount ? 'done' : i === doneCount ? 'current' : '';
    return `<div class="set-dot ${cls}"></div>`;
  }).join('');
}

/* ════════════════════════════════════════════════════════════
   QUEUE
   ════════════════════════════════════════════════════════════ */
function renderQueue() {
  document.getElementById('queue-list').innerHTML = selectedExercises.map((ex, ei) => {
    const doneCount = circuitSlots.slice(0, currentSlotIdx).filter(s => s.exIndex===ei).length;
    const isCurrent = circuitSlots[currentSlotIdx]?.exIndex === ei;
    const allDone   = doneCount >= selectedSets;
    const cls       = allDone ? 'done' : isCurrent ? 'current' : '';
    const setLabel  = allDone   ? `${selectedSets}/${selectedSets} ✓`
                    : isCurrent ? `Set ${circuitSlots[currentSlotIdx].setNumber}/${selectedSets}`
                    : doneCount > 0 ? `${doneCount}/${selectedSets}`
                    : `0/${selectedSets}`;
    return `<div class="queue-item ${cls}">
      <span>${ex.name}</span>
      <span class="queue-item-sets">${setLabel}</span>
    </div>`;
  }).join('');
}

/* ════════════════════════════════════════════════════════════
   MARK DONE
   ════════════════════════════════════════════════════════════ */
function markDone() {
  const isLast = currentSlotIdx === circuitSlots.length - 1;

  if (isLast) {
    // Stop workout timer, show celebration, then complete panel
    stopWorkoutTimer();
    showCelebration(() => finishWorkout());
  } else {
    // Advance index first
    currentSlotIdx++;
    renderQueue();

    // Show rest timer if rest > 0, else go straight to next slot
    if (selectedRest > 0) {
      const nextName = circuitSlots[currentSlotIdx].exercise.name;
      startRest(selectedRest, `Up next: ${nextName}`, () => {
        showSlot(currentSlotIdx);
      });
    } else {
      showSlot(currentSlotIdx);
    }
  }
}

/* ════════════════════════════════════════════════════════════
   WORKOUT TIMER
   ════════════════════════════════════════════════════════════ */
function startWorkoutTimer() {
  clearInterval(workoutInterval);
  workoutSeconds = 0;
  tickWorkoutTimer();
  workoutInterval = setInterval(tickWorkoutTimer, 1000);
}

function tickWorkoutTimer() {
  workoutSeconds++;
  const m = Math.floor(workoutSeconds/60);
  const s = (workoutSeconds%60).toString().padStart(2,'0');
  document.getElementById('timer-display').textContent = `${m}:${s}`;

  // Ring fill — 20 min target
  const progress = Math.min(workoutSeconds / (20*60), 1);
  const offset   = TIMER_CIRC - TIMER_CIRC * progress;
  const fill     = document.getElementById('timer-fill');
  fill.style.strokeDashoffset = offset;
  fill.style.stroke = progress < 0.5 ? '#00c6a2' : progress < 0.85 ? '#6c63ff' : '#ff5c7c';
}

function stopWorkoutTimer() { clearInterval(workoutInterval); workoutInterval = null; }

/* ════════════════════════════════════════════════════════════
   REST TIMER
   ════════════════════════════════════════════════════════════ */
function startRest(seconds, nextLabel, onDone) {
  restRemaining = seconds;
  restCallback  = onDone;

  document.getElementById('rest-next-label').textContent = nextLabel;
  document.getElementById('rest-countdown').textContent  = restRemaining;
  updateRestRing(restRemaining, seconds);

  showOverlay('rest-overlay');

  clearInterval(restInterval);
  restInterval = setInterval(() => {
    restRemaining--;
    document.getElementById('rest-countdown').textContent = restRemaining;
    updateRestRing(restRemaining, seconds);
    if (restRemaining <= 0) finishRest();
  }, 1000);
}

function updateRestRing(remaining, total) {
  const progress = remaining / total;
  document.getElementById('rest-fill').style.strokeDashoffset = REST_CIRC - REST_CIRC * progress;
}

function finishRest() {
  clearInterval(restInterval);
  hideOverlay('rest-overlay');
  if (restCallback) { const cb = restCallback; restCallback = null; cb(); }
}

function skipRest() { restRemaining = 0; finishRest(); }

/* ════════════════════════════════════════════════════════════
   CELEBRATION OVERLAY
   ════════════════════════════════════════════════════════════ */
async function showCelebration(onDone) {
  const unique = [...new Set(await getPartsThisWeek())];
  document.getElementById('celebration-sub').textContent =
    unique.length >= 4
      ? 'Full week done — all 4 body parts. You showed up every time.'
      : `${unique.length} of 4 body parts this week. Keep stacking those wins.`;

  const m = Math.floor(workoutSeconds/60);
  const s = (workoutSeconds%60).toString().padStart(2,'0');
  document.getElementById('celebration-stats').innerHTML = `
    <div class="cel-stat"><div class="cel-stat-val">${m}:${s}</div><div class="cel-stat-lbl">Time</div></div>
    <div class="cel-stat"><div class="cel-stat-val">${selectedExercises.length}</div><div class="cel-stat-lbl">Exercises</div></div>
    <div class="cel-stat"><div class="cel-stat-val">${selectedSets}</div><div class="cel-stat-lbl">Sets each</div></div>
  `;

  showOverlay('celebration-overlay');

  // Auto-dismiss after 3.2s, or tap to skip
  const el = document.getElementById('celebration-overlay');
  let dismissed = false;
  const dismiss = () => {
    if (dismissed) return;
    dismissed = true;
    hideOverlay('celebration-overlay');
    onDone();
  };
  setTimeout(dismiss, 3200);
  el.addEventListener('click', dismiss, { once: true });
}

/* ════════════════════════════════════════════════════════════
   FINISH WORKOUT  (called after celebration)
   ════════════════════════════════════════════════════════════ */
async function finishWorkout() {
  const record = {
    date: new Date().toISOString(),
    bodyPart: selectedBodyPart, phase: selectedPhase,
    sets: selectedSets, exercises: selectedExercises.map(e=>e.name),
    durationSeconds: workoutSeconds,
  };

  const saved = await saveWorkout(record);

  const m = Math.floor(workoutSeconds/60);
  const s = (workoutSeconds%60).toString().padStart(2,'0');
  document.getElementById('stat-time').textContent      = `${m}:${s}`;
  document.getElementById('stat-exercises').textContent = selectedExercises.length;
  document.getElementById('stat-sets').textContent      = selectedSets;

  const unique = [...new Set(await getPartsThisWeek())];
  document.getElementById('complete-sub').textContent = unique.length>=4
    ? 'Full week locked in — all 4 body parts done!'
    : `${unique.length} of 4 body parts done this week. Keep going!`;

  showPanel('complete');
  await renderWeekStrip();
  showToast(saved ? `${selectedBodyPart} session saved ✓` : '⚠️ Session not saved — check connection');
}

/* ════════════════════════════════════════════════════════════
   END EARLY / RESET
   ════════════════════════════════════════════════════════════ */
function confirmEndWorkout() {
  if (!confirm("End this workout early? Progress won't be saved.")) return;
  stopWorkoutTimer();
  clearInterval(restInterval);
  hideOverlay('rest-overlay');
  hideOverlay('celebration-overlay');
  resetToSetup();
}

function resetToSetup() {
  stopWorkoutTimer();
  selectedExercises = [];
  selectedBodyPart  = null;
  selectedPhase     = null;
  document.querySelectorAll('.pill').forEach(p => p.classList.remove('selected'));
  document.getElementById('exercise-select-group').style.display = 'none';
  document.getElementById('exercise-list').innerHTML = '';
  updateStartButton();
  renderWeekStrip();
  showPanel('setup');
}

/* ════════════════════════════════════════════════════════════
   PANEL SWITCHER
   ════════════════════════════════════════════════════════════ */
function showPanel(name) {
  document.getElementById('setup-panel').style.display    = name==='setup'    ? 'block' : 'none';
  document.getElementById('workout-panel').style.display  = name==='workout'  ? 'block' : 'none';
  document.getElementById('complete-panel').style.display = name==='complete' ? 'block' : 'none';
}

/* ════════════════════════════════════════════════════════════
   OVERLAY HELPERS
   ════════════════════════════════════════════════════════════ */
function showOverlay(id) { document.getElementById(id).style.display = 'flex'; }
function hideOverlay(id) { document.getElementById(id).style.display = 'none'; }

/* ════════════════════════════════════════════════════════════
   HISTORY VIEW
   ════════════════════════════════════════════════════════════ */
async function renderHistory() {
  const now  = new Date();
  const tgt  = new Date(now); tgt.setDate(now.getDate() + historyWeekOffset*7);
  const ws   = getStartOfWeek(tgt);
  const we   = new Date(ws); we.setDate(ws.getDate()+7);
  const fmt  = d => d.toLocaleDateString('en-US',{month:'short',day:'numeric'});
  const list = document.getElementById('history-list');

  document.getElementById('history-week-label').textContent = historyWeekOffset===0
    ? `This Week (${fmt(ws)} – ${fmt(new Date(we-86400000))})`
    : `${fmt(ws)} – ${fmt(new Date(we-86400000))}`;

  // Show loading state while fetching
  list.innerHTML = `<div class="empty-state"><div class="empty-text" style="opacity:0.5">Loading…</div></div>`;

  const ww = await getWorkoutsInWeek(ws);

  if (!ww.length) {
    list.innerHTML = `<div class="empty-state"><div class="empty-icon">📋</div><div class="empty-text">No workouts logged this week.</div></div>`;
    return;
  }

  list.innerHTML = ww.map(w => {
    const d   = new Date(w.date);
    const cls = PART_COLORS[w.bodyPart] || 'back';
    const m   = Math.floor(w.durationSeconds/60);
    const s   = (w.durationSeconds%60).toString().padStart(2,'0');
    return `<div class="history-item" data-id="${w.id}">
      <div class="history-item-top">
        <div class="history-item-top-left">
          <div class="history-date">${d.toLocaleDateString('en-US',{weekday:'long',month:'short',day:'numeric'})} · ${d.toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'})}</div>
          <div class="history-item-body">${PART_ICONS[w.bodyPart]||''} ${w.bodyPart} — Phase ${w.phase} (${PHASE_LABELS[w.phase]})</div>
        </div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px;flex-shrink:0;">
          <div class="history-duration">${m}:${s}</div>
          <button class="btn-delete-workout" onclick="deleteWorkout(${w.id})">Delete</button>
        </div>
      </div>
      <div class="history-exercises">${w.exercises.join(', ')}</div>
      <div class="history-tags">
        <span class="history-tag ${cls}">${w.bodyPart}</span>
        <span class="history-tag">Phase ${w.phase}</span>
        <span class="history-tag">${w.sets||'?'} sets</span>
        <span class="history-tag">${w.exercises.length} exercises</span>
      </div>
    </div>`;
  }).join('');
}

async function deleteWorkout(id) {
  if (!confirm('Delete this workout from your history?')) return;
  const ok = await deleteWorkoutById(id);
  if (ok) {
    await renderHistory();
    await renderWeekStrip();
    showToast('Workout deleted');
  }
}

function changeWeekOffset(delta) {
  historyWeekOffset = Math.min(0, historyWeekOffset+delta);
  renderHistory();
}

/* ════════════════════════════════════════════════════════════
   NAV
   ════════════════════════════════════════════════════════════ */
function showView(view) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
  document.getElementById(`view-${view}`).classList.add('active');
  document.querySelectorAll('.nav-tab').forEach(t => { if(t.dataset.view===view) t.classList.add('active'); });
  if (view==='history') renderHistory();  // renderHistory is async but fire-and-forget here is fine
}

/* ════════════════════════════════════════════════════════════
   TOAST
   ════════════════════════════════════════════════════════════ */
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(()=>t.classList.remove('show'), 2800);
}
