/* Elbow Rehab: eccentric wrist extension tracker. All data is stored locally on the device. */
(function () {
  'use strict';

  // ---------- Protocol ----------
  var PHASES = [
    { from: 1, to: 1, sets: 3, reps: 15 },
    { from: 2, to: 3, sets: 3, reps: 12 },
    { from: 4, to: 5, sets: 4, reps: 10 },
    { from: 6, to: 8, sets: 4, reps: 8 },
    { from: 9, to: 12, sets: 4, reps: 6 },
    { from: 13, to: 999, sets: 4, reps: 6, extra: true }
  ];
  var PROGRAM_WEEKS = 12;
  var STORE_KEY = 'elbowRehab.v1';
  var DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var DOW_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  var MON_FIRST = [1, 2, 3, 4, 5, 6, 0];

  // ---------- State ----------
  var defaults = {
    setupDone: false,
    settings: {
      startDate: null,
      days: [1, 3, 5],
      reminderTime: '17:30',
      nudge: true,
      nudgeTime: '20:30',
      painLimit: 5,
      morningCheck: true,
      morningTime: '08:00',
      beep: true,
      tempoDown: 3,
      tempoUp: 3,
      restSec: 150
    },
    sessions: [],
    draftWeight: null,
    active: null
  };

  var state = load();
  var ui = { editingWeight: false, sheet: null };
  var tickTimer = null;
  var wakeLock = null;
  var audioCtx = null;

  function load() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        var s = JSON.parse(raw);
        s.settings = Object.assign({}, defaults.settings, s.settings || {});
        s.sessions = s.sessions || [];
        return s;
      }
    } catch (e) { /* ignore */ }
    return JSON.parse(JSON.stringify(defaults));
  }
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) { /* ignore */ }
  }

  // ---------- Helpers ----------
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function ymd(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function parse(k) { var p = k.split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); }
  function addDays(d, n) { var x = new Date(d.getTime()); x.setDate(x.getDate() + n); return x; }
  function todayKey() { return ymd(new Date()); }
  function daysBetween(a, b) { return Math.round((parse(b) - parse(a)) / 864e5); }
  function mondayOf(d) { var x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); var dow = (x.getDay() + 6) % 7; return addDays(x, -dow); }
  function fmtDate(d) { return d.getDate() + ' ' + MONTHS[d.getMonth()].slice(0, 3); }
  function fmtKg(n) { return (Math.round(n * 10) / 10).toFixed(1); }
  function fmtTotal(n) {
    var r = Math.round(n * 10) / 10;
    var s = (r % 1 === 0 ? String(r) : r.toFixed(1));
    var parts = s.split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
    return parts.join('.');
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function weekOf(key) {
    if (!state.settings.startDate) return 1;
    var diff = daysBetween(state.settings.startDate, key);
    return Math.max(1, Math.floor(diff / 7) + 1);
  }
  function phaseFor(week) {
    for (var i = 0; i < PHASES.length; i++) {
      if (week >= PHASES[i].from && week <= PHASES[i].to) return Object.assign({ index: i }, PHASES[i]);
    }
    return Object.assign({ index: 0 }, PHASES[0]);
  }
  function sortedSessions() {
    return state.sessions.slice().sort(function (a, b) { return a.startedAt - b.startedAt; });
  }
  function lastSession() { var s = sortedSessions(); return s[s.length - 1] || null; }
  function sessionVolume(s) { return s.reps.reduce(function (a, b) { return a + b; }, 0) * s.weight; }
  function isFlagged(s) {
    var lim = state.settings.painLimit;
    if (s.pain != null && s.pain > lim) return true;
    if (s.morningPain != null && (s.morningPain > lim || (s.pain != null && s.morningPain > s.pain))) return true;
    return false;
  }
  function currentWeight() {
    if (state.draftWeight != null) return state.draftWeight;
    var l = lastSession();
    return l ? l.weight : 2.0;
  }
  function icon(name) {
    var p = {
      bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
      x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
      back: '<path d="m15 18-6-6 6-6"/>',
      play: '<path d="M7 4v16l13-8z" fill="currentColor"/>',
      check: '<path d="M20 6 9 17l-5-5"/>',
      warn: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
      download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
      cal: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4"/><path d="M8 2v4"/><path d="M3 10h18"/><path d="M12 14v4"/><path d="M10 16h4"/>',
      sound: '<path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/>',
      plus: '<path d="M12 5v14"/><path d="M5 12h14"/>'
    }[name];
    return '<svg class="icon" aria-hidden="true" viewBox="0 0 24 24">' + p + '</svg>';
  }

  // ---------- Audio ----------
  function ensureAudio() {
    if (!audioCtx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (AC) audioCtx = new AC();
    }
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
  }
  function beep(freq, dur, when) {
    if (!state.settings.beep || !audioCtx) return;
    var t = audioCtx.currentTime + (when || 0);
    var o = audioCtx.createOscillator();
    var g = audioCtx.createGain();
    o.type = 'sine';
    o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.25, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(audioCtx.destination);
    o.start(t); o.stop(t + dur + 0.02);
  }
  function tick() { if (audioCtx && state.settings.beep) beep(1800, 0.02); }

  async function requestWake() {
    try { if ('wakeLock' in navigator && !wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', function () { wakeLock = null; }); } } catch (e) { /* ignore */ }
  }
  function releaseWake() { try { if (wakeLock) wakeLock.release(); } catch (e) { /* ignore */ } wakeLock = null; }

  // ---------- Router ----------
  var app = document.getElementById('app');
  var tabs = document.getElementById('tabs');

  function route() {
    var h = (location.hash || '#today').slice(1);
    if (!state.setupDone) h = 'setup';
    if (h === 'session' && !state.active) h = 'today';
    if (h === 'complete' && !(state.active && state.active.done.length)) h = 'today';
    return h;
  }

  function render() {
    stopTick();
    var r = route();
    var noTabs = r === 'session' || r === 'complete' || r === 'setup' || r === 'settings';
    document.body.classList.toggle('no-tabs', noTabs);
    Array.prototype.forEach.call(tabs.querySelectorAll('a'), function (a) {
      var on = a.getAttribute('data-tab') === r;
      a.classList.toggle('active', on);
      if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    var views = { setup: viewSetup, today: viewToday, session: viewSession, complete: viewComplete, progress: viewProgress, program: viewProgram, log: viewLog, settings: viewSettings };
    app.innerHTML = (views[r] || viewToday)();
    if (r === 'today') bindDial();
    if (r === 'session') startTick();
    if (ui.sheet) renderSheet();
  }

  function go(hash) { if (location.hash === '#' + hash) render(); else location.hash = hash; }

  // ---------- Setup ----------
  function viewSetup() {
    var s = state.settings;
    var start = s.startDate || ymd(mondayOf(new Date()));
    return '' +
      '<div class="header"><div><span class="sub">Welcome</span><h1>Elbow Rehab</h1></div></div>' +
      '<div class="info">12 weeks of eccentric wrist extension for the right arm. Start light, lower slowly (3 s) and raise slowly (3 s), increase the weight as reps drop.</div>' +
      '<div class="card"><div class="field"><label for="setup-start">Program start date (week 1, day 1)</label><input id="setup-start" type="date" value="' + start + '"></div></div>' +
      '<div class="card"><span class="eyebrow">Training days</span>' + daysChips(s.days) + '</div>' +
      '<div class="card"><div class="field"><label for="setup-weight">Starting weight (kg)</label><input id="setup-weight" type="number" inputmode="decimal" step="0.1" min="0" value="' + fmtKg(currentWeight()) + '"></div></div>' +
      '<button class="btn" data-action="finish-setup">Start program</button>';
  }

  function daysChips(sel) {
    return '<div class="days">' + MON_FIRST.map(function (d) {
      var on = sel.indexOf(d) >= 0;
      return '<button aria-pressed="' + on + '" aria-label="' + DOW_LONG[d] + '" data-action="toggle-day" data-day="' + d + '">' + DOW[d][0] + '</button>';
    }).join('') + '</div>';
  }

  // ---------- Today ----------
  function viewToday() {
    var now = new Date();
    var tk = todayKey();
    var week = weekOf(tk);
    var ph = phaseFor(week);
    var w = currentWeight();
    var last = lastSession();
    var doneToday = state.sessions.filter(function (x) { return x.date === tk; });
    var html = '';

    html += '<div class="header"><div><span class="sub">' + DOW_LONG[now.getDay()] + ' ' + now.getDate() + ' ' + MONTHS[now.getMonth()] + '</span><h1>Today</h1></div>' +
      '<a href="#settings" class="round-btn" aria-label="Reminders and settings">' + icon('bell') + '</a></div>';

    // Morning pain check
    var pending = pendingMorningCheck();
    if (pending) {
      html += '<div class="card"><div class="row-between"><span class="card-title">Morning check</span><span class="small muted">' + fmtDate(parse(pending.date)) + ' session · pain ' + pending.pain + '</span></div>' +
        '<span class="small muted">How does the elbow feel this morning? 0 = no pain, 10 = worst imaginable.</span>' +
        painGrid(null, 'morning-pain') +
        '<button class="btn ghost" data-action="skip-morning">Skip</button></div>';
    }

    // Warning from last session
    if (last && isFlagged(last)) {
      var why = last.morningPain != null && (last.morningPain > state.settings.painLimit || last.morningPain > last.pain)
        ? 'Morning pain ' + last.morningPain + ' after a session score of ' + last.pain + '.'
        : 'Pain ' + last.pain + ' was above your limit of ' + state.settings.painLimit + '.';
      html += '<div class="alert" role="alert">' + icon('warn') + '<div><strong>Last session was flagged</strong><p>' + why + ' Hold the weight at ' + fmtKg(last.weight) + ' kg rather than increasing. If it keeps getting worse, talk to your physiotherapist.</p></div></div>';
    }

    // Week card
    var pct = Math.min(100, Math.round(((week - 1) + 0.0) / PROGRAM_WEEKS * 100));
    html += '<div class="card"><div class="row-between"><span class="eyebrow">' + (week <= PROGRAM_WEEKS ? 'Week ' + week + ' of ' + PROGRAM_WEEKS : 'Week ' + week + ' · extended') + '</span>' +
      '<span class="small accent" style="font-weight:600">Phase ' + (ph.index + 1) + ' · ' + ph.sets + ' × ' + ph.reps + 'RM</span></div>' +
      '<div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + pct + '" aria-label="Program progress"><span style="width:' + Math.max(pct, 2) + '%"></span></div>' +
      weekStrip() + '</div>';

    // Session card
    var vol = ph.sets * ph.reps * w;
    html += '<div class="card" style="gap:16px">' +
      '<div><span class="small muted" style="font-weight:500">Eccentric wrist extension · Right arm</span>' +
      '<div style="display:flex;align-items:baseline;gap:10px"><span class="num" style="font-size:64px">' + ph.sets + ' × ' + ph.reps + '</span><span class="muted">sets × reps</span></div></div>' +
      '<div class="chips"><span class="chip">' + state.settings.tempoDown + ' s down</span><span class="chip">' + state.settings.tempoUp + ' s up</span><span class="chip">Rest ' + restLabel() + '</span></div>' +
      '<div class="dial-wrap">' + dialMarkup(w) +
      '<div class="weight-read" id="weight-read">' + weightReadout(w, last) + '</div></div>' +
      '<div class="row-between small" style="border-top:1px solid var(--line);padding-top:12px;font-size:13px"><span class="muted">Planned volume</span><span style="font-weight:600" id="planned-vol">' + ph.sets + ' × ' + ph.reps + ' × ' + fmtKg(w) + ' = ' + fmtTotal(vol) + ' kg</span></div>' +
      '</div>';

    if (doneToday.length) {
      html += '<div class="info">' + icon('check').replace('class="icon"', 'class="icon" style="width:16px;height:16px;vertical-align:-3px;color:var(--accent)"') + ' Session logged today: ' + doneToday[0].reps.length + ' × ' + doneToday[0].reps[0] + ' @ ' + fmtKg(doneToday[0].weight) + ' kg.</div>';
      html += '<button class="btn secondary" data-action="start-session">' + icon('play') + 'Start another session</button>';
    } else {
      html += '<button class="btn" data-action="start-session">' + icon('play') + 'Start session</button>';
    }
    return html;
  }

  function restLabel() {
    var r = state.settings.restSec;
    var m = Math.floor(r / 60), s = r % 60;
    return m + ':' + pad(s) + ' min';
  }

  function weekStrip() {
    var mon = mondayOf(new Date());
    var tk = todayKey();
    var doneDates = {};
    state.sessions.forEach(function (s) { doneDates[s.date] = true; });
    var out = '<div class="week">';
    for (var i = 0; i < 7; i++) {
      var d = addDays(mon, i);
      var k = ymd(d);
      var cls = 'd';
      if (k === tk) cls += ' today';
      else if (doneDates[k]) cls += ' done';
      else if (state.settings.days.indexOf(d.getDay()) >= 0 && k > tk) cls += ' plan';
      var label = DOW_LONG[d.getDay()] + ' ' + d.getDate() + (doneDates[k] ? ', trained' : (state.settings.days.indexOf(d.getDay()) >= 0 ? ', training day' : ''));
      out += '<div><span class="l" aria-hidden="true">' + DOW[d.getDay()][0] + '</span><span class="' + cls + '" aria-label="' + label + '">' + (doneDates[k] && k !== tk ? '✓' : d.getDate()) + '</span></div>';
    }
    return out + '</div>';
  }

  function weightReadout(w, last) {
    var main = ui.editingWeight
      ? '<label class="sr-only" for="weight-input">Weight in kg</label><input id="weight-input" class="weight-input" type="number" inputmode="decimal" step="0.1" min="0" max="100" value="' + fmtKg(w) + '">'
      : '<button class="weight-btn" data-action="edit-weight" aria-label="Type weight, currently ' + fmtKg(w) + ' kg"><span class="num">' + fmtKg(w) + '<span class="unit"> kg</span></span></button>';
    return main +
      '<span class="small muted" style="font-weight:500">Turn the dial<br>1 round = 1 kg</span>' +
      '<span class="small" style="color:var(--text-2);font-weight:500;margin-top:4px">' + (last ? 'Last session: ' + fmtKg(last.weight) + ' kg' : 'Tap the number to type') + '</span>';
  }

  function dialMarkup(w) {
    var ticks = '';
    for (var i = 0; i < 20; i++) {
      var a = i * Math.PI / 10, major = i % 2 === 0, r1 = major ? 50 : 54;
      ticks += '<line x1="' + (70 + r1 * Math.sin(a)).toFixed(1) + '" y1="' + (70 - r1 * Math.cos(a)).toFixed(1) + '" x2="' + (70 + 58 * Math.sin(a)).toFixed(1) + '" y2="' + (70 - 58 * Math.cos(a)).toFixed(1) + '" stroke="#4A525E" stroke-width="' + (major ? 2 : 1.5) + '" stroke-linecap="round"/>';
    }
    return '<div class="dial" id="dial" tabindex="0" role="slider" aria-label="Weight dial. One full turn equals 1 kilo" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + fmtKg(w) + '" aria-valuetext="' + fmtKg(w) + ' kg">' +
      '<svg viewBox="0 0 140 140" aria-hidden="true">' +
      '<circle cx="70" cy="70" r="66" fill="none" stroke="#262B33" stroke-width="6"/>' +
      '<path id="dial-arc" d="" fill="none" stroke="#C6F432" stroke-width="6" stroke-linecap="round"/>' +
      ticks +
      '<g id="dial-knob"><circle cx="70" cy="70" r="44" fill="#1E232A" stroke="#2C323B" stroke-width="1"/>' +
      '<circle cx="70" cy="70" r="36" fill="none" stroke="#262B33" stroke-width="1" stroke-dasharray="2 5"/>' +
      '<circle cx="70" cy="38" r="6" fill="#C6F432"/></g>' +
      '</svg></div>';
  }

  function updateDialVisual(w) {
    var frac = ((w % 1) + 1) % 1;
    var ang = frac * 360;
    var knob = document.getElementById('dial-knob');
    if (knob) knob.setAttribute('transform', 'rotate(' + ang.toFixed(1) + ' 70 70)');
    var arc = document.getElementById('dial-arc');
    if (arc) {
      if (frac < 0.001) arc.setAttribute('d', '');
      else {
        var rad = ang * Math.PI / 180;
        var x = 70 + 66 * Math.sin(rad), y = 70 - 66 * Math.cos(rad);
        arc.setAttribute('d', 'M70 4 A66 66 0 ' + (ang > 180 ? 1 : 0) + ' 1 ' + x.toFixed(2) + ' ' + y.toFixed(2));
      }
    }
    var dial = document.getElementById('dial');
    if (dial) { dial.setAttribute('aria-valuenow', fmtKg(w)); dial.setAttribute('aria-valuetext', fmtKg(w) + ' kg'); }
  }

  function setWeight(w, fromDial) {
    w = Math.max(0, Math.min(100, Math.round(w * 10) / 10));
    if (w === currentWeight() && state.draftWeight != null) return;
    state.draftWeight = w;
    save();
    updateDialVisual(w);
    if (!ui.editingWeight) {
      var read = document.getElementById('weight-read');
      if (read) read.innerHTML = weightReadout(w, lastSession());
    }
    var ph = phaseFor(weekOf(todayKey()));
    var pv = document.getElementById('planned-vol');
    if (pv) pv.textContent = ph.sets + ' × ' + ph.reps + ' × ' + fmtKg(w) + ' = ' + fmtTotal(ph.sets * ph.reps * w) + ' kg';
    if (fromDial) tick();
  }

  function bindDial() {
    var dial = document.getElementById('dial');
    if (!dial) return;
    updateDialVisual(currentWeight());
    var dragging = false, lastAngle = 0, accum = 0, baseW = 0;
    function angleOf(e) {
      var r = dial.getBoundingClientRect();
      var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      return Math.atan2(e.clientX - cx, -(e.clientY - cy)) * 180 / Math.PI;
    }
    dial.addEventListener('pointerdown', function (e) {
      ensureAudio();
      dragging = true; lastAngle = angleOf(e); accum = 0; baseW = currentWeight();
      dial.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    dial.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      var a = angleOf(e);
      var d = a - lastAngle;
      if (d > 180) d -= 360;
      if (d < -180) d += 360;
      lastAngle = a;
      accum += d;
      var target = Math.round((baseW + accum / 360) * 10) / 10;
      if (target < 0) { target = 0; accum = -baseW * 360; }
      if (target !== currentWeight()) setWeight(target, true);
    });
    function end() { dragging = false; }
    dial.addEventListener('pointerup', end);
    dial.addEventListener('pointercancel', end);
    dial.addEventListener('keydown', function (e) {
      var step = { ArrowUp: 0.1, ArrowRight: 0.1, ArrowDown: -0.1, ArrowLeft: -0.1, PageUp: 1, PageDown: -1 }[e.key];
      if (step) { e.preventDefault(); setWeight(currentWeight() + step, false); }
    });
  }

  function pendingMorningCheck() {
    if (!state.settings.morningCheck) return null;
    var tk = todayKey();
    var now = new Date();
    var mt = state.settings.morningTime.split(':');
    var afterTime = now.getHours() * 60 + now.getMinutes() >= (+mt[0]) * 60 + (+mt[1]);
    var list = sortedSessions().filter(function (s) { return s.wantsMorning && s.morningPain == null && !s.morningSkipped && s.date < tk && daysBetween(s.date, tk) <= 2; });
    if (!list.length || !afterTime) return null;
    return list[list.length - 1];
  }

  function painGrid(selected, action) {
    var out = '<div class="pain-grid">';
    for (var n = 0; n <= 10; n++) {
      var hi = n > state.settings.painLimit;
      out += '<button class="' + (hi ? 'high' : '') + '" aria-pressed="' + (selected === n) + '" aria-label="Pain ' + n + ' of 10" data-action="' + action + '" data-n="' + n + '">' + n + '</button>';
    }
    return out + '</div>';
  }

  // ---------- Session ----------
  function startSession() {
    var tk = todayKey();
    var week = weekOf(tk);
    var ph = phaseFor(week);
    state.active = {
      startedAt: Date.now(), date: tk, week: week, phase: ph.index,
      weight: currentWeight(), sets: ph.sets, target: ph.reps,
      done: [], mode: 'ready', tempoStart: 0, pausedAt: 0, restEnd: 0, repsInput: ph.reps,
      pain: null, wantsMorning: state.settings.morningCheck, note: ''
    };
    save();
    ensureAudio();
    requestWake();
    go('session');
  }

  function viewSession() {
    var a = state.active;
    var setNo = Math.min(a.done.length + 1, a.sets);
    var html = '<div class="header"><button class="round-btn" data-action="end-session" aria-label="End session">' + icon('x') + '</button>' +
      '<div style="display:flex;flex-direction:column;align-items:center"><span class="eyebrow">Set ' + setNo + ' of ' + a.sets + '</span><span style="font-weight:600">' + fmtKg(a.weight) + ' kg · ' + a.target + ' reps</span></div>' +
      '<span id="elapsed" class="small muted" style="width:44px;text-align:right;font-variant-numeric:tabular-nums"></span></div>';

    html += '<div class="set-pills" style="grid-template-columns:repeat(' + a.sets + ',minmax(0,1fr))">';
    for (var i = 0; i < a.sets; i++) {
      var cls = 'set-pill', v = '–';
      if (i < a.done.length) { cls += ' done'; v = a.done[i] + ' ✓'; }
      else if (i === a.done.length && a.mode !== 'rest') { cls += ' now'; v = 'Now'; }
      else if (i === a.done.length && a.mode === 'rest') { v = 'Next'; }
      html += '<div class="' + cls + '"><span class="t">SET ' + (i + 1) + '</span><span class="v">' + v + '</span></div>';
    }
    html += '</div>';

    var C = 2 * Math.PI * 136;
    html += '<div class="ring"><svg viewBox="0 0 300 300" aria-hidden="true"><circle cx="150" cy="150" r="136" fill="none" stroke="#1E232A" stroke-width="14"/>' +
      '<circle id="ring-arc" cx="150" cy="150" r="136" fill="none" stroke="#C6F432" stroke-width="14" stroke-linecap="round" stroke-dasharray="0 ' + C.toFixed(1) + '" transform="rotate(-90 150 150)"/></svg>' +
      '<div class="center" id="ring-center"></div></div>';

    if (a.mode === 'tempo' || a.mode === 'ready') {
      html += '<div class="legend"><span><i class="dot" style="background:#C6F432"></i>' + state.settings.tempoDown + ' s down</span><span><i class="dot" style="background:#7FD4FF"></i>' + state.settings.tempoUp + ' s up</span>' +
        '<button class="pill-btn" data-action="toggle-beep" aria-pressed="' + state.settings.beep + '">' + icon('sound') + (state.settings.beep ? 'Beep on' : 'Beep off') + '</button></div>';
    }

    if (a.mode === 'adjust') {
      html += '<div class="card"><div class="row-between"><div><div style="font-weight:600">Reps completed</div><div class="small muted">Adjust if you could not finish</div></div>' +
        '<div class="stepper"><button class="step-btn" data-action="reps-dec" aria-label="Fewer reps">−</button><span class="num" id="reps-val">' + a.repsInput + '</span><button class="step-btn" data-action="reps-inc" aria-label="More reps">+</button></div></div></div>';
    }

    html += '<div style="flex-grow:1"></div><div style="display:flex;flex-direction:column;gap:10px">';
    if (a.mode === 'ready') {
      html += '<button class="btn" data-action="start-set">' + icon('play') + 'Start set ' + setNo + '</button>' +
        '<button class="btn ghost" data-action="log-without-tempo">Log set without tempo guide</button>';
    } else if (a.mode === 'tempo') {
      html += '<button class="btn secondary" data-action="finish-set-early">Finish set now</button>' +
        '<button class="btn ghost" data-action="pause">' + (a.pausedAt ? 'Resume tempo guide' : 'Pause tempo guide') + '</button>';
    } else if (a.mode === 'adjust') {
      var last = a.done.length + 1 >= a.sets;
      html += '<button class="btn" data-action="complete-set">' + (last ? 'Complete set · finish session' : 'Complete set · start ' + restShort() + ' rest') + '</button>';
    } else if (a.mode === 'rest') {
      html += '<button class="btn" data-action="skip-rest">Skip rest · start set ' + (a.done.length + 1) + '</button>' +
        '<button class="btn ghost" data-action="add-rest">+30 s</button>';
    }
    html += '</div>';
    return html;
  }

  function restShort() { var r = state.settings.restSec; return Math.floor(r / 60) + ':' + pad(r % 60); }

  function startTick() {
    stopTick();
    sessionTick();
    tickTimer = setInterval(sessionTick, 100);
  }
  function stopTick() { if (tickTimer) clearInterval(tickTimer); tickTimer = null; }

  var lastCue = '';
  function sessionTick() {
    var a = state.active;
    if (!a) return;
    var now = Date.now();
    var el = document.getElementById('elapsed');
    if (el) { var sec = Math.floor((now - a.startedAt) / 1000); el.textContent = pad(Math.floor(sec / 60)) + ':' + pad(sec % 60); }
    var center = document.getElementById('ring-center');
    var arc = document.getElementById('ring-arc');
    if (!center || !arc) return;
    var C = 2 * Math.PI * 136;
    var frac = 0, html = '';

    if (a.mode === 'ready') {
      html = '<span class="phase">Ready</span><span class="big">' + a.target + '</span><span class="muted">reps at ' + fmtKg(a.weight) + ' kg</span>';
      frac = 0;
    } else if (a.mode === 'tempo') {
      var down = state.settings.tempoDown * 1000, up = state.settings.tempoUp * 1000, cyc = down + up;
      var ref = a.pausedAt || now;
      var elapsed = ref - a.tempoStart;
      if (elapsed < 0) {
        // Get-ready countdown
        var c = Math.ceil(-elapsed / 1000);
        html = '<span class="phase">Get ready</span><span class="big">' + c + '</span><span class="muted">Rep 1 of ' + a.target + '</span>';
        frac = 0;
        cue('ready' + c, function () { beep(660, 0.08); });
      } else {
        var rep = Math.floor(elapsed / cyc) + 1;
        if (rep > a.target) {
          a.mode = 'adjust'; a.repsInput = a.target; save();
          beep(880, 0.12); beep(1175, 0.18, 0.15);
          render();
          return;
        }
        var within = elapsed % cyc;
        var isDown = within < down;
        var phaseLeft = isDown ? down - within : cyc - within;
        var phaseLen = isDown ? down : up;
        frac = 1 - phaseLeft / phaseLen;
        html = '<span class="phase ' + (isDown ? '' : 'up') + '">' + (a.pausedAt ? 'Paused' : (isDown ? 'Lower slowly' : 'Raise slowly')) + '</span>' +
          '<span class="big">' + Math.ceil(phaseLeft / 1000) + '</span><span class="muted">Rep ' + rep + ' of ' + a.target + '</span>';
        if (!a.pausedAt) cue(rep + (isDown ? 'd' : 'u'), function () { beep(isDown ? 880 : 520, 0.1); });
      }
      arc.setAttribute('stroke', (elapsed >= 0 && (elapsed % cyc) >= down) ? '#7FD4FF' : '#C6F432');
    } else if (a.mode === 'adjust') {
      html = '<span class="phase">Set done</span><span class="big">' + a.repsInput + '</span><span class="muted">reps × ' + fmtKg(a.weight) + ' kg</span>';
      frac = 1;
    } else if (a.mode === 'rest') {
      var left = Math.max(0, a.restEnd - now);
      var total = state.settings.restSec * 1000;
      frac = Math.min(1, left / Math.max(total, left));
      var s = Math.ceil(left / 1000);
      html = '<span class="phase up">Rest</span><span class="big time">' + Math.floor(s / 60) + ':' + pad(s % 60) + '</span><span class="muted">Next: set ' + (a.done.length + 1) + ' of ' + a.sets + '</span>';
      arc.setAttribute('stroke', '#7FD4FF');
      if (left <= 0) {
        beep(880, 0.15); beep(880, 0.15, 0.25); beep(1320, 0.3, 0.5);
        a.mode = 'ready'; save(); render(); return;
      }
    }
    if (center.innerHTML !== html) center.innerHTML = html;
    arc.setAttribute('stroke-dasharray', (frac * C).toFixed(1) + ' ' + C.toFixed(1));
  }
  function cue(key, fn) { if (key !== lastCue) { lastCue = key; fn(); } }

  // ---------- Complete ----------
  function viewComplete() {
    var a = state.active;
    var totalReps = a.done.reduce(function (x, y) { return x + y; }, 0);
    var vol = totalReps * a.weight;
    var mins = Math.round((Date.now() - a.startedAt) / 60000);
    var limit = state.settings.painLimit;
    var over = a.pain != null && a.pain > limit;
    var html = '<div class="hero"><div class="badge">' + icon('check').replace('class="icon"', 'class="icon" style="width:30px;height:30px;stroke-width:3"') + '</div>' +
      '<h1>Session complete</h1><span class="small muted" style="font-size:13px">Week ' + a.week + ' · ' + a.done.length + ' × ' + a.target + ' @ ' + fmtKg(a.weight) + ' kg · ' + mins + ' min</span></div>';
    html += '<div class="card trio" style="display:grid">' +
      '<div><div class="small muted">Weight</div><span class="num">' + fmtKg(a.weight) + '<span class="unit"> kg</span></span></div>' +
      '<div><div class="small muted">Reps</div><span class="num">' + totalReps + '<span class="unit"> / ' + (a.sets * a.target) + '</span></span></div>' +
      '<div><div class="small muted">Volume</div><span class="num">' + fmtTotal(vol) + '<span class="unit"> kg</span></span></div></div>';
    html += '<div class="card"><div class="row-between"><span class="card-title">Pain during training</span><span class="small" style="font-weight:600;color:' + (over ? 'var(--warn)' : 'var(--accent)') + '">' + (a.pain == null ? 'Required' : a.pain + (over ? ' · Above limit' : '')) + '</span></div>' +
      painGrid(a.pain, 'session-pain') +
      '<div class="row-between small muted"><span>0 = no pain</span><span>10 = worst imaginable</span></div>' +
      '<div style="display:flex;align-items:center;gap:8px;border-top:1px solid var(--line);padding-top:10px" class="small muted"><i class="dot" style="background:var(--warn)"></i>Your limit is ' + limit + '. Scores above it are flagged.</div></div>';
    if (over) {
      html += '<div class="alert" role="alert">' + icon('warn') + '<div><strong>Pain ' + a.pain + ' is above your limit of ' + limit + '</strong><p>Hold the weight at ' + fmtKg(a.weight) + ' kg next session instead of increasing. If the elbow is still worse tomorrow morning, talk to your physiotherapist.</p></div></div>';
    }
    html += '<div class="card"><div class="row-between"><div><div style="font-weight:500">Morning pain check</div><div class="small muted">Asks tomorrow from ' + state.settings.morningTime + ' when you open the app</div></div>' +
      '<button class="toggle" aria-label="Morning pain check" aria-pressed="' + !!a.wantsMorning + '" data-action="toggle-wants-morning"></button></div></div>';
    html += '<div class="field"><label for="note">Note (optional)</label><input id="note" type="text" placeholder="E.g. felt stiff in the last set" value="' + esc(a.note) + '"></div>';
    html += '<button class="btn" data-action="save-session"' + (a.pain == null ? ' disabled' : '') + '>Save session</button>';
    return html;
  }

  function saveSession() {
    var a = state.active;
    var noteEl = document.getElementById('note');
    if (noteEl) a.note = noteEl.value.trim();
    state.sessions.push({
      id: 's' + a.startedAt, date: a.date, startedAt: a.startedAt, durationSec: Math.round((Date.now() - a.startedAt) / 1000),
      week: a.week, phase: a.phase, targetSets: a.sets, targetReps: a.target, weight: a.weight, reps: a.done.slice(),
      pain: a.pain, morningPain: null, wantsMorning: !!a.wantsMorning, note: a.note
    });
    state.active = null;
    state.draftWeight = null;
    save();
    releaseWake();
    go('today');
  }

  // ---------- Progress ----------
  function viewProgress() {
    var ss = sortedSessions();
    var html = '<div class="header"><h1>Progress</h1></div>';
    if (!ss.length) return html + '<div class="card empty">Complete your first session to see progress here.</div>';
    var first = ss[0], last = ss[ss.length - 1];
    var total = ss.reduce(function (t, s) { return t + sessionVolume(s); }, 0);
    var planned = plannedToDate();
    var uniqueDays = {}; ss.forEach(function (s) { uniqueDays[s.date] = true; });
    var doneCount = Object.keys(uniqueDays).length;
    var adherence = planned ? Math.min(100, Math.round(doneCount / planned * 100)) : 100;
    var totalPlanned = PROGRAM_WEEKS * state.settings.days.length;
    var diff = last.weight - first.weight;
    html += '<div class="stats">' +
      stat('Current weight', fmtKg(last.weight), 'kg', (diff >= 0 ? '+' : '') + fmtKg(diff) + ' kg since start') +
      stat('Total lifted', fmtTotal(total), 'kg', ss.length + ' session' + (ss.length === 1 ? '' : 's')) +
      stat('Sessions', String(ss.length), '/ ' + totalPlanned, adherence + ' % on schedule') +
      stat('Pain, last session', last.pain == null ? '–' : String(last.pain), '/ 10', painTrendText(ss), isFlagged(last)) +
      '</div>';
    html += '<div class="card"><div class="row-between"><span class="card-title">Weight per session</span><span class="small muted">kg · by week</span></div>' + weightChart(ss) + '</div>';
    html += '<div class="card"><div class="row-between"><span class="card-title">Volume per session</span><span class="small muted">sets × reps × kg</span></div>' + volumeChart(ss) + '</div>';
    html += '<div class="card"><div class="row-between"><span class="card-title">Pain per session</span><span class="small muted">0–10 · limit ' + state.settings.painLimit + '</span></div>' + painChart(ss) + '</div>';
    return html;
  }
  function stat(label, value, unit, sub, warn) {
    return '<div class="stat"><span class="small muted" style="font-weight:500">' + label + '</span><span class="num">' + value + '<span class="unit"> ' + unit + '</span></span><span class="small" style="font-weight:600;color:' + (warn ? 'var(--warn)' : 'var(--accent)') + '">' + sub + '</span></div>';
  }
  function painTrendText(ss) {
    var withPain = ss.filter(function (s) { return s.pain != null; });
    if (withPain.length < 2) return 'Limit ' + state.settings.painLimit;
    var f = withPain[0].pain, l = withPain[withPain.length - 1].pain;
    if (l < f) return 'Down from ' + f + ' at start';
    if (l > f) return 'Up from ' + f + ' at start';
    return 'Same as at start';
  }
  function plannedToDate() {
    if (!state.settings.startDate) return 0;
    var start = parse(state.settings.startDate);
    var tk = todayKey();
    var n = 0;
    for (var d = new Date(start); ymd(d) <= tk; d = addDays(d, 1)) {
      if (state.settings.days.indexOf(d.getDay()) >= 0) {
        var k = ymd(d);
        if (k < tk || state.sessions.some(function (s) { return s.date === k; })) n++;
      }
    }
    return n;
  }

  // Charts: x axis = program day (0..84+), y = value
  function chartFrame(W, H) { return { W: W, H: H, l: 8, r: W - 26, t: 14, b: H - 22 }; }
  function xForDate(key, f, maxDay) {
    var day = state.settings.startDate ? daysBetween(state.settings.startDate, key) : 0;
    return f.l + Math.max(0, day) / maxDay * (f.r - f.l);
  }
  function maxDayFor(ss) {
    var lastDay = state.settings.startDate ? daysBetween(state.settings.startDate, ss[ss.length - 1].date) : 0;
    return Math.max(PROGRAM_WEEKS * 7, lastDay + 3);
  }
  function phaseLines(f, maxDay) {
    var out = '';
    var labels = [];
    PHASES.forEach(function (p, i) {
      var startDay = (p.from - 1) * 7;
      if (startDay > maxDay) return;
      var x = f.l + startDay / maxDay * (f.r - f.l);
      if (i > 0) out += '<line x1="' + x.toFixed(1) + '" y1="' + f.t + '" x2="' + x.toFixed(1) + '" y2="' + f.b + '" stroke="#2C323B"/>';
      var endDay = Math.min(p.extra ? maxDay : p.to * 7, maxDay);
      var cx = f.l + (startDay + endDay) / 2 / maxDay * (f.r - f.l);
      if (endDay - startDay >= 5) labels.push('<text x="' + cx.toFixed(1) + '" y="' + (f.H - 6) + '" fill="#8B94A1" font-size="10" text-anchor="middle">' + p.reps + (i === 4 ? ' reps' : '') + '</text>');
    });
    return out + labels.join('');
  }
  function gridY(f, max, step, unit) {
    var out = '';
    for (var v = step; v <= max; v += step) {
      var y = f.b - v / max * (f.b - f.t);
      out += '<line x1="' + f.l + '" y1="' + y.toFixed(1) + '" x2="' + f.r + '" y2="' + y.toFixed(1) + '" stroke="#232830"/>' +
        '<text x="' + (f.W - 2) + '" y="' + (y + 3.5).toFixed(1) + '" fill="#8B94A1" font-size="10" text-anchor="end">' + v + (unit || '') + '</text>';
    }
    return out;
  }
  function weightChart(ss) {
    var f = chartFrame(340, 160);
    var maxW = Math.max(4, Math.ceil(Math.max.apply(null, ss.map(function (s) { return s.weight; })) / 2) * 2 + 2);
    var step = maxW <= 10 ? 2 : (maxW <= 20 ? 5 : 10);
    var maxDay = maxDayFor(ss);
    var pts = ss.map(function (s) { return [xForDate(s.date, f, maxDay), f.b - s.weight / maxW * (f.b - f.t)]; });
    var line = '<polyline points="' + pts.map(function (p) { return p[0].toFixed(1) + ',' + p[1].toFixed(1); }).join(' ') + '" fill="none" stroke="#C6F432" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>';
    var dots = pts.map(function (p, i) { return '<circle cx="' + p[0].toFixed(1) + '" cy="' + p[1].toFixed(1) + '" r="' + (i === pts.length - 1 ? 4 : 2.5) + '" fill="#C6F432"/>'; }).join('');
    var lastP = pts[pts.length - 1];
    var lbl = '<text x="' + Math.min(lastP[0] + 6, f.r - 30).toFixed(1) + '" y="' + (lastP[1] - 8).toFixed(1) + '" fill="#F2F4F7" font-size="11" font-weight="600">' + fmtKg(ss[ss.length - 1].weight) + '</text>';
    var desc = 'Weight from ' + fmtKg(ss[0].weight) + ' kg to ' + fmtKg(ss[ss.length - 1].weight) + ' kg over ' + ss.length + ' sessions';
    return '<svg class="chart" viewBox="0 0 ' + f.W + ' ' + f.H + '" role="img" aria-label="' + desc + '" font-family="Inter, system-ui, sans-serif">' + gridY(f, maxW, step) + phaseLines(f, maxDay) + line + dots + lbl + '</svg>';
  }
  function volumeChart(ss) {
    var recent = ss.slice(-12);
    var W = 340, H = 140, base = 112, top = 14;
    var max = Math.max.apply(null, recent.map(sessionVolume)) || 1;
    var n = recent.length, gap = 8;
    var bw = Math.min(28, (W - 16 - gap * (n - 1)) / n);
    var out = '';
    recent.forEach(function (s, i) {
      var v = sessionVolume(s);
      var h = Math.max(3, v / max * (base - top));
      var x = 8 + i * (bw + gap);
      out += '<rect x="' + x.toFixed(1) + '" y="' + (base - h).toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + h.toFixed(1) + '" rx="5" fill="' + (i === n - 1 ? '#C6F432' : '#5B6B2A') + '"><title>' + fmtDate(parse(s.date)) + ': ' + fmtTotal(v) + ' kg</title></rect>';
    });
    var lastX = 8 + (n - 1) * (bw + gap) + bw;
    out += '<text x="8" y="' + (H - 6) + '" fill="#8B94A1" font-size="10">' + fmtDate(parse(recent[0].date)) + '</text>';
    out += '<text x="' + lastX.toFixed(1) + '" y="' + (H - 6) + '" fill="#F2F4F7" font-size="10" font-weight="600" text-anchor="end">' + fmtTotal(sessionVolume(recent[n - 1])) + ' kg</text>';
    return '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Volume for the last ' + n + ' sessions, latest ' + fmtTotal(sessionVolume(recent[n - 1])) + ' kg" font-family="Inter, system-ui, sans-serif">' + out + '</svg>';
  }
  function painChart(ss) {
    var f = chartFrame(340, 130);
    var maxDay = maxDayFor(ss);
    var lim = state.settings.painLimit;
    var yOf = function (v) { return f.b - v / 10 * (f.b - f.t); };
    var out = gridY(f, 10, 5);
    out += '<line x1="' + f.l + '" y1="' + yOf(lim).toFixed(1) + '" x2="' + f.r + '" y2="' + yOf(lim).toFixed(1) + '" stroke="#FFB547" stroke-dasharray="4 4"/>';
    var pts = ss.filter(function (s) { return s.pain != null; }).map(function (s) { return [xForDate(s.date, f, maxDay), yOf(s.pain), s]; });
    if (pts.length > 1) out += '<polyline points="' + pts.map(function (p) { return p[0].toFixed(1) + ',' + p[1].toFixed(1); }).join(' ') + '" fill="none" stroke="#9AA3AF" stroke-width="2" stroke-linejoin="round"/>';
    pts.forEach(function (p) { out += '<circle cx="' + p[0].toFixed(1) + '" cy="' + p[1].toFixed(1) + '" r="3.5" fill="' + (isFlagged(p[2]) ? '#FFB547' : '#C6F432') + '"/>'; });
    ss.forEach(function (s) {
      if (s.morningPain != null) {
        var x = xForDate(s.date, f, maxDay) + 3, y = yOf(s.morningPain);
        out += '<rect x="' + (x - 3).toFixed(1) + '" y="' + (y - 3).toFixed(1) + '" width="6" height="6" fill="none" stroke="#7FD4FF" stroke-width="1.5"/>';
      }
    });
    out += '<text x="' + f.l + '" y="' + (f.H - 6) + '" fill="#8B94A1" font-size="10">● after session   ▢ next morning</text>';
    return '<svg class="chart" viewBox="0 0 ' + f.W + ' ' + f.H + '" role="img" aria-label="Pain scores per session against a limit of ' + lim + '" font-family="Inter, system-ui, sans-serif">' + out + '</svg>';
  }

  // ---------- Program ----------
  function viewProgram() {
    var s = state.settings;
    var week = weekOf(todayKey());
    var start = s.startDate ? parse(s.startDate) : new Date();
    var dayNames = MON_FIRST.filter(function (d) { return s.days.indexOf(d) >= 0; }).map(function (d) { return DOW[d]; }).join(', ');
    var html = '<div class="header"><div><h1>Program</h1><span class="sub">Started ' + DOW[start.getDay()] + ' ' + fmtDate(start) + ' ' + start.getFullYear() + ' · ' + (dayNames || 'no days set') + '</span></div></div>';
    html += '<div style="display:flex;flex-direction:column;gap:8px">';
    PHASES.forEach(function (p, i) {
      var st = week > p.to ? 'done' : (week >= p.from ? 'now' : 'next');
      var cls = 'phase-row ' + (p.extra && st !== 'now' ? 'extra' : st);
      var weeks = p.extra ? 'Week 13+' : (p.from === p.to ? 'Week ' + p.from : 'Weeks ' + p.from + '–' + p.to);
      var inPhase = sortedSessions().filter(function (x) { return x.phase === i; });
      var note;
      if (st === 'done') note = inPhase.length ? 'Completed · ' + fmtKg(inPhase[0].weight) + ' → ' + fmtKg(inPhase[inPhase.length - 1].weight) + ' kg' : 'Completed';
      else if (st === 'now') {
        var perWeek = Math.max(1, s.days.length);
        var total = ((p.extra ? week : p.to) - p.from + 1) * perWeek;
        note = 'Current · week ' + week + (p.extra ? '' : ', session ' + Math.min(total, inPhase.length + 1) + ' of ' + total);
      } else note = p.extra ? 'Optional · continue or taper' : 'Starts ' + DOW[1] + ' ' + fmtDate(addDays(start, (p.from - 1) * 7));
      html += '<div class="' + cls + '"><div class="phase-dot">' + (st === 'done' ? '✓' : (st === 'now' ? '●' : '')) + '</div>' +
        '<div style="flex-grow:1;display:flex;flex-direction:column;gap:2px"><span class="eyebrow" style="letter-spacing:.8px">' + weeks + '</span><span class="small" style="font-size:13px;font-weight:500;color:' + (st === 'now' ? 'var(--accent)' : 'var(--muted)') + '">' + note + '</span></div>' +
        '<span class="scheme">' + p.sets + ' × ' + p.reps + '</span></div>';
    });
    html += '</div>';
    html += '<div class="card"><span class="card-title">How it works</span><div style="display:flex;flex-direction:column;gap:8px;font-size:13px;color:var(--text-2)">' +
      '<span><b style="color:var(--text)">RM</b>, repetition maximum: the heaviest weight you can lift exactly that many times with good form.</span>' +
      '<span><b style="color:var(--text)">Tempo</b> ' + s.tempoDown + ' s down, ' + s.tempoUp + ' s up on every rep.</span>' +
      '<span><b style="color:var(--text)">Rest</b> 2–3 min between sets.</span>' +
      '<span><b style="color:var(--text)">Pain</b> up to your limit (' + s.painLimit + '/10) is accepted. It should settle by the next morning.</span></div></div>';
    return html;
  }

  // ---------- Log ----------
  function viewLog() {
    var ss = sortedSessions();
    var html = '<div class="header"><h1>Log</h1><div style="display:flex;gap:8px">' +
      '<button class="pill-btn" data-action="add-session">' + icon('plus') + 'Add</button>' +
      (ss.length ? '<button class="pill-btn" data-action="export-csv" aria-label="Export CSV">' + icon('download') + 'CSV</button>' : '') + '</div></div>';
    if (!ss.length) return html + '<div class="card empty">No sessions yet. Tap Add to log a session you have already done.</div>';
    var total = 0, sets = 0, reps = 0;
    ss.forEach(function (s) { total += sessionVolume(s); sets += s.reps.length; reps += s.reps.reduce(function (a, b) { return a + b; }, 0); });
    html += '<div class="card trio" style="display:grid">' +
      '<div><div class="small muted">Total lifted</div><span class="num">' + fmtTotal(total) + '<span class="unit"> kg</span></span></div>' +
      '<div><div class="small muted">Sets</div><span class="num">' + sets + '</span></div>' +
      '<div><div class="small muted">Reps</div><span class="num">' + reps + '</span></div></div>';
    var byWeek = {};
    ss.forEach(function (s) { (byWeek[s.week] = byWeek[s.week] || []).push(s); });
    Object.keys(byWeek).map(Number).sort(function (a, b) { return b - a; }).forEach(function (wk) {
      var list = byWeek[wk].slice().reverse();
      var ph = phaseFor(wk);
      var wt = list.reduce(function (t, s) { return t + sessionVolume(s); }, 0);
      html += '<div style="display:flex;flex-direction:column;gap:6px"><div class="group-head"><span>WEEK ' + wk + ' · ' + ph.sets + ' × ' + ph.reps + 'RM</span><span>' + fmtTotal(wt) + ' kg</span></div><div class="card flush">';
      list.forEach(function (s) {
        var d = parse(s.date);
        var allSame = s.reps.every(function (r) { return r === s.reps[0]; });
        var scheme = allSame ? s.reps.length + ' × ' + s.reps[0] : s.reps.join('/');
        var flag = isFlagged(s);
        html += '<button class="log-row" data-action="edit-session" data-id="' + s.id + '" aria-label="Edit session ' + DOW_LONG[d.getDay()] + ' ' + fmtDate(d) + '">' +
          '<div class="date"><span class="dow">' + DOW[d.getDay()].toUpperCase() + '</span><span class="day">' + d.getDate() + '</span></div>' +
          '<div class="main"><span style="font-weight:600">' + scheme + ' @ ' + fmtKg(s.weight) + ' kg</span><span class="small muted" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + s.reps.join(' · ') + ' reps' + (s.note ? ' · ' + esc(s.note) : '') + '</span></div>' +
          '<div class="right"><span style="font-weight:600;font-variant-numeric:tabular-nums">' + fmtTotal(sessionVolume(s)) + ' kg</span>' +
          (s.pain != null ? '<span class="pain-chip' + (flag ? ' flag' : '') + '">Pain ' + s.pain + (s.morningPain != null ? ' · AM ' + s.morningPain : '') + '</span>' : '') + '</div></button>';
      });
      html += '</div></div>';
    });
    return html;
  }

  // ---------- Settings ----------
  function viewSettings() {
    var s = state.settings;
    var html = '<div class="header"><div class="header-left"><a href="#today" class="round-btn" aria-label="Back to Today">' + icon('back') + '</a><h1 style="font-size:26px">Reminders</h1></div></div>';
    html += '<div class="card"><span class="eyebrow">Training days</span>' + daysChips(s.days) + '<span class="small muted">' + s.days.length + ' sessions per week</span></div>';
    html += '<div class="card flush">' +
      '<div class="list-row"><label for="rem-time">Reminder time</label><input id="rem-time" type="time" value="' + s.reminderTime + '" data-setting="reminderTime"></div>' +
      '<div class="list-row"><div><div class="label">Nudge if not done</div><div class="small muted">Second alert</div></div><div style="display:flex;gap:10px;align-items:center">' +
      (s.nudge ? '<label class="sr-only" for="nudge-time">Nudge time</label><input id="nudge-time" type="time" value="' + s.nudgeTime + '" data-setting="nudgeTime">' : '') +
      '<button class="toggle" aria-label="Nudge if not done" aria-pressed="' + s.nudge + '" data-action="toggle-setting" data-key="nudge"></button></div></div></div>';
    html += '<div class="card"><div style="display:flex;gap:12px;align-items:flex-start"><div style="width:40px;height:40px;border-radius:12px;background:var(--accent-dim);color:var(--accent);display:flex;align-items:center;justify-content:center;flex-shrink:0">' + icon('cal') + '</div>' +
      '<div><div style="font-weight:600">Add to iPhone Calendar</div><div class="small muted" style="font-size:13px">Creates repeating events with alerts for the whole program. Works even when the app is closed. Download again if you change days or times.</div></div></div>' +
      '<button class="btn small" data-action="download-ics">Download calendar file (.ics)</button>' +
      '<span class="small muted">If nothing happens in the Home Screen app, open the app in Safari and tap the button there.</span></div>';
    html += '<div class="card flush">' +
      '<div class="list-row"><div><div class="label">Pain limit</div><div class="small muted">Scores above this are flagged</div></div><div class="stepper"><button class="step-btn" data-action="limit-dec" aria-label="Lower limit">−</button><span class="num" style="font-size:26px;width:28px">' + s.painLimit + '</span><button class="step-btn" data-action="limit-inc" aria-label="Raise limit">+</button></div></div>' +
      '<div class="list-row"><div><div class="label">Morning pain check</div><div class="small muted">Asked when you open the app</div></div><div style="display:flex;gap:10px;align-items:center">' +
      (s.morningCheck ? '<label class="sr-only" for="morning-time">Morning check from</label><input id="morning-time" type="time" value="' + s.morningTime + '" data-setting="morningTime">' : '') +
      '<button class="toggle" aria-label="Morning pain check" aria-pressed="' + s.morningCheck + '" data-action="toggle-setting" data-key="morningCheck"></button></div></div></div>';
    html += '<div class="card flush">' +
      '<div class="list-row"><label for="start-date">Program start</label><input id="start-date" type="date" value="' + (s.startDate || '') + '" data-setting="startDate"></div>' +
      '<div class="list-row"><div class="label">Rest between sets</div><div class="stepper"><button class="step-btn" data-action="rest-dec" aria-label="Shorter rest">−</button><span style="font-weight:600;width:44px;text-align:center">' + restShort() + '</span><button class="step-btn" data-action="rest-inc" aria-label="Longer rest">+</button></div></div>' +
      '<div class="list-row"><div class="label">Beep on tempo</div><button class="toggle" aria-label="Beep on tempo" aria-pressed="' + s.beep + '" data-action="toggle-setting" data-key="beep"></button></div></div>';
    html += '<div class="card"><span class="eyebrow">Backup</span><span class="small muted" style="font-size:13px">Your data is stored only on this phone. Export a backup now and then, for example to Files or iCloud Drive.</span>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px"><button class="btn small secondary" data-action="export-json">Export</button>' +
      '<label class="btn small secondary" for="import-file" style="cursor:pointer">Import</label><input id="import-file" type="file" accept="application/json,.json" class="sr-only"></div></div>';
    html += '<p class="small muted" style="text-align:center">Elbow Rehab · v1.1</p>';
    return html;
  }

  // ---------- Sheet (edit session) ----------
  function renderSheet() {
    var old = document.getElementById('sheet');
    if (old) old.remove();
    if (!ui.sheet) return;
    var isNew = ui.sheet.mode === 'new';
    var s;
    if (isNew) {
      var dk = ui.sheet.date || ymd(addDays(new Date(), -1));
      var ph0 = phaseFor(weekOf(dk));
      var lastW = lastSession();
      s = { date: dk, weight: lastW ? lastW.weight : currentWeight(), reps: Array(ph0.sets).fill(ph0.reps), pain: null, morningPain: null, note: '' };
    } else {
      s = state.sessions.filter(function (x) { return x.id === ui.sheet.id; })[0];
    }
    if (!s) { ui.sheet = null; return; }
    var d = parse(s.date);
    var el = document.createElement('div');
    el.id = 'sheet';
    el.className = 'sheet-backdrop';
    el.innerHTML = '<div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title">' +
      '<div class="row-between"><h2 id="sheet-title">' + (isNew ? 'Add past session' : DOW_LONG[d.getDay()] + ' ' + fmtDate(d)) + '</h2><button class="round-btn" data-action="close-sheet" aria-label="Close">' + icon('x') + '</button></div>' +
      (isNew ? '<div class="field"><label for="e-date">Date</label><input id="e-date" type="date" max="' + todayKey() + '" value="' + s.date + '"></div>' +
        '<span class="small muted" id="e-phase">Week ' + weekOf(s.date) + ' · ' + phaseFor(weekOf(s.date)).sets + ' × ' + phaseFor(weekOf(s.date)).reps + 'RM</span>' : '') +
      '<div class="field"><label for="e-weight">Weight (kg)</label><input id="e-weight" type="number" inputmode="decimal" step="0.1" min="0" value="' + fmtKg(s.weight) + '"></div>' +
      '<div class="field"><label for="e-reps">Reps per set, separated by commas</label><input id="e-reps" type="text" inputmode="numeric" value="' + s.reps.join(', ') + '"></div>' +
      '<div class="field"><label for="e-pain">Pain after session (0–10)</label><input id="e-pain" type="number" inputmode="numeric" min="0" max="10" value="' + (s.pain == null ? '' : s.pain) + '"></div>' +
      '<div class="field"><label for="e-mpain">Pain next morning (0–10, optional)</label><input id="e-mpain" type="number" inputmode="numeric" min="0" max="10" value="' + (s.morningPain == null ? '' : s.morningPain) + '"></div>' +
      '<div class="field"><label for="e-note">Note</label><input id="e-note" type="text" value="' + esc(s.note) + '"></div>' +
      '<button class="btn" data-action="save-edit">' + (isNew ? 'Add session' : 'Save changes') + '</button>' +
      (isNew ? '' : '<button class="btn ghost" data-action="delete-session" style="color:var(--warn)">Delete session</button>') + '</div>';
    document.body.appendChild(el);
  }

  function intOrNull(v) { if (v === '' || v == null) return null; var n = Math.round(+v); return isNaN(n) ? null : Math.max(0, Math.min(10, n)); }

  // ---------- Exports ----------
  function downloadFile(name, mime, text) {
    var blob = new Blob([text], { type: mime });
    var file;
    try { file = new File([blob], name, { type: mime }); } catch (e) { file = null; }
    if (file && navigator.canShare && navigator.canShare({ files: [file] }) && mime !== 'text/calendar') {
      navigator.share({ files: [file], title: name }).catch(function () {});
      return;
    }
    var a = document.createElement('a');
    if (mime === 'text/calendar') a.href = 'data:text/calendar;charset=utf-8,' + encodeURIComponent(text);
    else a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { a.remove(); }, 1000);
  }

  function exportCSV() {
    var rows = [['date', 'week', 'sets_x_reps_target', 'weight_kg', 'reps_per_set', 'total_reps', 'volume_kg', 'pain', 'morning_pain', 'flagged', 'duration_min', 'note']];
    sortedSessions().forEach(function (s) {
      var tr = s.reps.reduce(function (a, b) { return a + b; }, 0);
      rows.push([s.date, s.week, s.targetSets + 'x' + s.targetReps, fmtKg(s.weight), s.reps.join('/'), tr, (Math.round(sessionVolume(s) * 10) / 10), s.pain == null ? '' : s.pain, s.morningPain == null ? '' : s.morningPain, isFlagged(s) ? 'yes' : 'no', Math.round((s.durationSec || 0) / 60), s.note || '']);
    });
    var csv = rows.map(function (r) { return r.map(function (c) { var v = String(c); return /[",;\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }).join(','); }).join('\n');
    downloadFile('elbow-rehab-log-' + todayKey() + '.csv', 'text/csv', csv);
  }

  function exportJSON() {
    var data = JSON.stringify({ app: 'elbow-rehab', version: 1, exportedAt: new Date().toISOString(), settings: state.settings, sessions: state.sessions }, null, 2);
    downloadFile('elbow-rehab-backup-' + todayKey() + '.json', 'application/json', data);
  }

  function importJSON(file) {
    var r = new FileReader();
    r.onload = function () {
      try {
        var d = JSON.parse(r.result);
        if (!d || !Array.isArray(d.sessions)) throw new Error('bad');
        if (!confirm('Replace the data on this phone with ' + d.sessions.length + ' sessions from the backup?')) return;
        state.settings = Object.assign({}, defaults.settings, d.settings || {});
        state.sessions = d.sessions;
        state.setupDone = true;
        save();
        alert('Backup imported.');
        render();
      } catch (e) { alert('That file is not an Elbow Rehab backup.'); }
    };
    r.readAsText(file);
  }

  function buildICS() {
    var s = state.settings;
    var start = parse(s.startDate);
    var byday = MON_FIRST.filter(function (d) { return s.days.indexOf(d) >= 0; }).map(function (d) { return ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'][d]; }).join(',');
    var t = s.reminderTime.split(':');
    var stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
    function dt(d, hh, mm) { return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + 'T' + pad(hh) + pad(mm) + '00'; }
    var lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Elbow Rehab//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:Elbow Rehab'];
    var nudgeMin = 0;
    if (s.nudge) {
      var n = s.nudgeTime.split(':');
      nudgeMin = (+n[0] * 60 + +n[1]) - (+t[0] * 60 + +t[1]);
    }
    PHASES.forEach(function (p, i) {
      if (p.extra) return;
      var ps = addDays(start, (p.from - 1) * 7);
      var pe = addDays(start, p.to * 7 - 1);
      if (ymd(pe) < todayKey()) return;
      // first matching day on/after phase start
      var first = ps;
      for (var k = 0; k < 7; k++) { if (s.days.indexOf(first.getDay()) >= 0) break; first = addDays(first, 1); }
      if (!byday) return;
      var endT = new Date(first.getTime()); var startMin = +t[0] * 60 + +t[1] + 30;
      lines.push('BEGIN:VEVENT',
        'UID:elbow-rehab-phase' + (i + 1) + '-' + s.startDate + '@elbow-rehab',
        'DTSTAMP:' + stamp,
        'DTSTART:' + dt(first, +t[0], +t[1]),
        'DTEND:' + dt(endT, Math.floor(startMin / 60) % 24, startMin % 60),
        'RRULE:FREQ=WEEKLY;BYDAY=' + byday + ';UNTIL=' + dt(pe, 23, 59).replace(/00$/, '59'),
        'SUMMARY:Elbow rehab · ' + p.sets + ' × ' + p.reps + 'RM',
        'DESCRIPTION:Eccentric wrist extension\\, right arm. ' + p.sets + ' sets × ' + p.reps + ' reps\\, 3 s down / 3 s up\\, rest 2–3 min. Log it in Elbow Rehab.',
        'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Time for elbow rehab', 'TRIGGER:PT0M', 'END:VALARM');
      if (s.nudge && nudgeMin > 0) {
        lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Elbow rehab not done yet?', 'TRIGGER:PT' + nudgeMin + 'M', 'END:VALARM');
      }
      lines.push('END:VEVENT');
    });
    lines.push('END:VCALENDAR');
    return lines.join('\r\n');
  }

  // ---------- Events ----------
  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-action]');
    if (!t) return;
    var act = t.getAttribute('data-action');
    var s = state.settings;
    var a = state.active;
    switch (act) {
      case 'toggle-day': {
        var d = +t.getAttribute('data-day');
        var i = s.days.indexOf(d);
        if (i >= 0) s.days.splice(i, 1); else s.days.push(d);
        s.days.sort(); save();
        if (route() === 'setup') { var keep = document.getElementById('setup-start').value; var kw = document.getElementById('setup-weight').value; render(); document.getElementById('setup-start').value = keep; document.getElementById('setup-weight').value = kw; }
        else render();
        break;
      }
      case 'finish-setup': {
        var sd = document.getElementById('setup-start').value;
        var w0 = parseFloat(document.getElementById('setup-weight').value);
        if (!sd) { alert('Choose a start date.'); return; }
        s.startDate = sd;
        if (!isNaN(w0)) state.draftWeight = Math.round(w0 * 10) / 10;
        state.setupDone = true; save(); go('today');
        break;
      }
      case 'edit-weight': {
        ui.editingWeight = true;
        var read = document.getElementById('weight-read');
        read.innerHTML = weightReadout(currentWeight(), lastSession());
        var inp = document.getElementById('weight-input');
        inp.focus(); inp.select();
        var commit = function () {
          var v = parseFloat(inp.value);
          ui.editingWeight = false;
          if (!isNaN(v)) setWeight(v, false);
          var r2 = document.getElementById('weight-read');
          if (r2) r2.innerHTML = weightReadout(currentWeight(), lastSession());
        };
        inp.addEventListener('blur', commit, { once: true });
        inp.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') inp.blur(); });
        break;
      }
      case 'start-session': startSession(); break;
      case 'end-session':
        if (a.done.length) {
          if (confirm('End the session now? Your ' + a.done.length + ' completed set' + (a.done.length > 1 ? 's' : '') + ' will be saved.')) { a.mode = 'done'; save(); go('complete'); }
        } else if (confirm('Cancel this session? Nothing has been logged yet.')) { state.active = null; save(); releaseWake(); go('today'); }
        break;
      case 'start-set':
        ensureAudio(); requestWake();
        a.mode = 'tempo'; a.tempoStart = Date.now() + 3000; a.pausedAt = 0; lastCue = ''; save(); render();
        break;
      case 'log-without-tempo': a.mode = 'adjust'; a.repsInput = a.target; save(); render(); break;
      case 'finish-set-early': {
        var cyc = (s.tempoDown + s.tempoUp) * 1000;
        var el = (a.pausedAt || Date.now()) - a.tempoStart;
        a.repsInput = Math.max(0, Math.min(a.target, Math.floor(Math.max(0, el) / cyc)));
        a.mode = 'adjust'; a.pausedAt = 0; save(); render();
        break;
      }
      case 'pause':
        if (a.pausedAt) { a.tempoStart += Date.now() - a.pausedAt; a.pausedAt = 0; }
        else a.pausedAt = Date.now();
        save(); render();
        break;
      case 'reps-dec': a.repsInput = Math.max(0, a.repsInput - 1); save(); document.getElementById('reps-val').textContent = a.repsInput; break;
      case 'reps-inc': a.repsInput = Math.min(50, a.repsInput + 1); save(); document.getElementById('reps-val').textContent = a.repsInput; break;
      case 'complete-set':
        a.done.push(a.repsInput);
        if (a.done.length >= a.sets) { a.mode = 'done'; save(); go('complete'); }
        else { a.mode = 'rest'; a.restEnd = Date.now() + s.restSec * 1000; save(); render(); }
        break;
      case 'skip-rest': a.mode = 'ready'; save(); render(); break;
      case 'add-rest': a.restEnd += 30000; save(); break;
      case 'toggle-beep': s.beep = !s.beep; ensureAudio(); save(); render(); break;
      case 'session-pain': {
        var note = document.getElementById('note');
        if (note) a.note = note.value;
        a.pain = +t.getAttribute('data-n'); save(); render();
        break;
      }
      case 'toggle-wants-morning': {
        var note2 = document.getElementById('note');
        if (note2) a.note = note2.value;
        a.wantsMorning = !a.wantsMorning; save(); render();
        break;
      }
      case 'save-session': saveSession(); break;
      case 'morning-pain': {
        var p = pendingMorningCheck();
        if (p) { p.morningPain = +t.getAttribute('data-n'); save(); render(); }
        break;
      }
      case 'skip-morning': { var p2 = pendingMorningCheck(); if (p2) { p2.morningSkipped = true; save(); render(); } break; }
      case 'toggle-setting': { var key = t.getAttribute('data-key'); s[key] = !s[key]; save(); render(); break; }
      case 'limit-dec': s.painLimit = Math.max(0, s.painLimit - 1); save(); render(); break;
      case 'limit-inc': s.painLimit = Math.min(10, s.painLimit + 1); save(); render(); break;
      case 'rest-dec': s.restSec = Math.max(30, s.restSec - 15); save(); render(); break;
      case 'rest-inc': s.restSec = Math.min(600, s.restSec + 15); save(); render(); break;
      case 'download-ics':
        if (!s.days.length) { alert('Choose at least one training day first.'); return; }
        downloadFile('elbow-rehab.ics', 'text/calendar', buildICS());
        break;
      case 'export-csv': exportCSV(); break;
      case 'export-json': exportJSON(); break;
      case 'edit-session': ui.sheet = { id: t.getAttribute('data-id') }; renderSheet(); break;
      case 'close-sheet': ui.sheet = null; renderSheet(); break;
      case 'add-session': ui.sheet = { mode: 'new' }; renderSheet(); break;
      case 'save-edit': {
        var w = parseFloat(document.getElementById('e-weight').value);
        var reps = document.getElementById('e-reps').value.split(/[,;\s]+/).map(function (x) { return parseInt(x, 10); }).filter(function (x) { return !isNaN(x) && x >= 0; });
        if (isNaN(w) || !reps.length) { alert('Check weight and reps.'); return; }
        var ss;
        if (ui.sheet.mode === 'new') {
          var nd = document.getElementById('e-date').value;
          if (!nd || nd > todayKey()) { alert('Choose a date up to today.'); return; }
          var nwk = weekOf(nd), nph = phaseFor(nwk);
          var t0 = parse(nd); t0.setHours(12, 0, 0, 0);
          var nid = 's' + t0.getTime();
          while (state.sessions.some(function (x) { return x.id === nid; })) nid += 'b';
          ss = { id: nid, date: nd, startedAt: t0.getTime(), durationSec: 0, week: nwk, phase: nph.index, targetSets: nph.sets, targetReps: nph.reps, wantsMorning: false, manual: true };
          state.sessions.push(ss);
        } else {
          ss = state.sessions.filter(function (x) { return x.id === ui.sheet.id; })[0];
        }
        ss.weight = Math.round(w * 10) / 10; ss.reps = reps;
        ss.pain = intOrNull(document.getElementById('e-pain').value);
        ss.morningPain = intOrNull(document.getElementById('e-mpain').value);
        ss.note = document.getElementById('e-note').value.trim();
        save(); ui.sheet = null; renderSheet(); render();
        break;
      }
      case 'delete-session':
        if (confirm('Delete this session permanently?')) {
          state.sessions = state.sessions.filter(function (x) { return x.id !== ui.sheet.id; });
          save(); ui.sheet = null; renderSheet(); render();
        }
        break;
    }
  });

  document.addEventListener('click', function (e) {
    if (e.target.id === 'sheet') { ui.sheet = null; renderSheet(); }
  });

  document.addEventListener('change', function (e) {
    var t = e.target;
    if (t.id === 'import-file' && t.files && t.files[0]) { importJSON(t.files[0]); t.value = ''; return; }
    if (t.id === 'e-date' && t.value) {
      var ph = phaseFor(weekOf(t.value));
      var lbl = document.getElementById('e-phase');
      if (lbl) lbl.textContent = 'Week ' + weekOf(t.value) + ' · ' + ph.sets + ' × ' + ph.reps + 'RM';
      var r = document.getElementById('e-reps');
      if (r) r.value = Array(ph.sets).fill(ph.reps).join(', ');
      return;
    }
    if (t.getAttribute && t.getAttribute('data-setting') === 'startDate' && t.value) {
      state.settings.startDate = t.value;
      state.sessions.forEach(function (s) { s.week = weekOf(s.date); s.phase = phaseFor(s.week).index; });
      save();
      return;
    }
    var key = t.getAttribute && t.getAttribute('data-setting');
    if (key && t.value) { state.settings[key] = t.value; save(); }
  });

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') {
      if (route() === 'session') requestWake();
      if (route() === 'today') render();
    }
  });

  window.addEventListener('hashchange', render);

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    window.addEventListener('load', function () { navigator.serviceWorker.register('sw.js').catch(function () {}); });
  }

  // Resume an unfinished session
  if (state.active && state.setupDone && !location.hash) {
    location.hash = state.active.mode === 'done' ? 'complete' : 'session';
  }
  render();

  // Expose for testing
  window.__elbow = { state: function () { return state; }, buildICS: buildICS };
})();