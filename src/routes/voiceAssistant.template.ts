/**
 * VOICE-6 — Server-rendered HTML for the voice assistant page (GET /voice).
 *
 * Same pattern as trackingPage.template.ts: a single self-contained RTL
 * Hebrew page emitted as a string — no static-file middleware, no external
 * assets (system fonts, inline CSS/JS only).
 *
 * The embedded script deliberately avoids template literals (backticks) so
 * this outer TypeScript template literal stays trivially safe.
 *
 * Flow: ?u=<personal token> → POST /voice/session → OpenAI Realtime WebRTC
 * (mic + remote audio + data channel) → function calls are executed through
 * POST /voice/tool and the results are pushed back over the data channel.
 */

import { ROBOT_DATA_URI, hasRobotImage } from './voiceAssets';

const BRAND_GREEN = '#6aa84f';

/**
 * Robot avatar markup: the branded image when embedded, else an emoji
 * placeholder. `#robotPh` exists only in the placeholder path (the page JS
 * guards on it).
 */
function robotAvatarInner(): string {
  return hasRobotImage()
    ? `<img src="${ROBOT_DATA_URI}" alt="גלי" />`
    : `<span class="ph" id="robotPh">🤖</span>`;
}

/** Favicon / apple-touch-icon link tags — branded image when available. */
function iconLinks(): string {
  if (!hasRobotImage()) {
    // A tiny inline SVG robot keeps the tab from showing a blank/broken icon.
    const svg =
      `data:image/svg+xml,` +
      encodeURIComponent(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">` +
          `<rect width="64" height="64" rx="14" fill="${BRAND_GREEN}"/>` +
          `<text x="50%" y="54%" font-size="38" text-anchor="middle" dominant-baseline="middle">🤖</text>` +
        `</svg>`,
      );
    return `<link rel="icon" href="${svg}">`;
  }
  return (
    `<link rel="icon" type="image/png" href="${ROBOT_DATA_URI}">` +
    `<link rel="apple-touch-icon" href="${ROBOT_DATA_URI}">`
  );
}

/**
 * The PWA page. When installed ("Add to Home Screen") it launches standalone
 * with the גלי icon + splash — driven by /voice/manifest.webmanifest.
 */
export function renderVoicePage(): string {
  return `<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, user-scalable=no">
<meta name="robots" content="noindex, nofollow">
<title>גלי — העוזרת הקולית</title>
<!-- manifest href gets the personal token appended at runtime so the installed
     app launches already identified (see the inline script at the top of body). -->
<link rel="manifest" id="pwaManifest" href="/voice/manifest.webmanifest">
<script>
  (function () {
    var u = new URLSearchParams(location.search).get('u');
    if (u) {
      var l = document.getElementById('pwaManifest');
      if (l) l.setAttribute('href', '/voice/manifest.webmanifest?u=' + encodeURIComponent(u));
    }
  })();
</script>
<meta name="theme-color" content="${BRAND_GREEN}">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="apple-mobile-web-app-title" content="גלי">
${iconLinks()}
<style>
  :root {
    --bg1: #f4faf3; --bg2: #eaf5e8; --card: #ffffff;
    --line: #e2ece0; --text: #1f2937; --dim: #6b7f6a;
    --brand: #6aa84f; --brand-dark: #4e7d38; --brand-soft: #eef7ea;
    --accent2: #6aa84f; --danger: #dc2626;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { height: 100%; }
  body {
    font-family: -apple-system, "Segoe UI", Roboto, "Heebo", Arial, sans-serif;
    background:
      radial-gradient(900px 500px at 82% -8%, #dcefd6 0%, transparent 60%),
      radial-gradient(760px 480px at -8% 108%, #e4f2df 0%, transparent 55%),
      linear-gradient(165deg, var(--bg1), var(--bg2));
    color: var(--text);
    display: flex; flex-direction: column; align-items: center;
    min-height: 100dvh; padding: 18px 14px calc(18px + env(safe-area-inset-bottom));
  }
  .shell { width: 100%; max-width: 560px; display: flex; flex-direction: column; gap: 14px; flex: 1; }
  header { display: flex; align-items: center; justify-content: space-between; padding: 2px 4px; }
  .brand { display: flex; align-items: center; gap: 10px; }
  .brand h1 { font-size: 18px; font-weight: 800; letter-spacing: .2px; color: var(--brand-dark); }
  .brand small { display: block; color: var(--dim); font-size: 12px; font-weight: 400; }
  .status { display: flex; align-items: center; gap: 7px; font-size: 12.5px; color: var(--dim); }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: #b8c6b5; transition: background .25s; }
  .dot.live { background: var(--brand); box-shadow: 0 0 10px rgba(106,168,79,.7); }
  .dot.err { background: var(--danger); }

  /* ── Robot avatar (center of the page) ── */
  .stage { position: relative; display: grid; place-items: center; padding: 20px 0 8px; }
  .avatar {
    position: relative; width: 188px; height: 188px; border-radius: 50%;
    border: none; cursor: pointer; outline: none; padding: 0;
    background: #fff; overflow: hidden;
    box-shadow: 0 12px 34px rgba(78,125,56,.22), 0 0 0 4px #fff, 0 0 0 7px var(--brand);
    transition: transform .18s ease, box-shadow .3s;
    -webkit-tap-highlight-color: transparent;
  }
  .avatar img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .avatar:active { transform: scale(.97); }
  /* Placeholder shown until the real robot image is embedded */
  .avatar .ph {
    width: 100%; height: 100%; display: grid; place-items: center; font-size: 74px;
    background: radial-gradient(circle at 50% 38%, #f2f9ef, #e6f2e0);
  }
  .avatar .label {
    position: absolute; bottom: -32px; right: 50%; transform: translateX(50%);
    font-size: 13.5px; color: var(--dim); white-space: nowrap; font-weight: 500;
  }
  .ring { position: absolute; width: 188px; height: 188px; border-radius: 50%; pointer-events: none; opacity: 0; }
  .listening .ring { opacity: 1; animation: pulse 1.9s ease-out infinite; border: 3px solid rgba(106,168,79,.75); }
  .speaking  .ring { opacity: 1; animation: pulse 1.15s ease-out infinite; border: 3px solid rgba(106,168,79,.95); }
  @keyframes pulse { 0% { transform: scale(1); opacity: .85; } 100% { transform: scale(1.42); opacity: 0; } }
  .listening .avatar { box-shadow: 0 12px 34px rgba(106,168,79,.34), 0 0 0 4px #fff, 0 0 0 7px var(--brand); }
  .speaking  .avatar { animation: nod .9s ease-in-out infinite alternate; }
  @keyframes nod { from { transform: translateY(0); } to { transform: translateY(-4px); } }
  .connecting .avatar { animation: breathe 1.2s ease-in-out infinite alternate; }
  @keyframes breathe { from { filter: brightness(.94); } to { filter: brightness(1.06); } }

  .hint { text-align: center; color: var(--dim); font-size: 13px; min-height: 20px; padding: 24px 8px 0; }
  .hint b { color: var(--brand-dark); font-weight: 700; }

  .panel {
    flex: 1; min-height: 170px; background: var(--card); border: 1px solid var(--line);
    border-radius: 18px; padding: 14px; overflow-y: auto; display: flex;
    flex-direction: column; gap: 9px; box-shadow: 0 4px 18px rgba(78,125,56,.06);
  }
  .empty { color: var(--dim); font-size: 13.5px; text-align: center; margin: auto; line-height: 1.9; }
  .msg { max-width: 86%; padding: 9px 13px; border-radius: 15px; font-size: 14.5px; line-height: 1.55; word-break: break-word; }
  .msg.user { align-self: flex-start; background: #eef2ff; border: 1px solid #dbe3ff; color: #27324d; border-bottom-right-radius: 5px; }
  .msg.bot  { align-self: flex-end;   background: var(--brand-soft); border: 1px solid #d8ead0; color: #24421a; border-bottom-left-radius: 5px; }
  .chip {
    align-self: flex-end; display: inline-flex; align-items: center; gap: 7px;
    font-size: 12.5px; color: var(--brand-dark); background: var(--brand-soft);
    border: 1px solid #d3e6ca; border-radius: 999px; padding: 5px 12px;
  }
  .chip.ok  { color: #2f7d1e; background: #e9f6e3; border-color: #c3e3b6; }
  .chip.err { color: #b91c1c; background: #fdeaea; border-color: #f4c9c9; }
  .spin { width: 11px; height: 11px; border: 2px solid rgba(106,168,79,.3); border-top-color: var(--brand); border-radius: 50%; animation: rot .8s linear infinite; }
  @keyframes rot { to { transform: rotate(360deg); } }

  .banner {
    display: none; background: #fdeaea; border: 1px solid #f4c9c9;
    color: #b91c1c; border-radius: 14px; padding: 11px 14px; font-size: 13.5px; line-height: 1.6;
  }
  .banner.show { display: block; }

  .foot { display: flex; justify-content: center; gap: 10px; }
  .btn {
    border: 1px solid var(--line); background: #fff; color: var(--text);
    padding: 9px 22px; border-radius: 999px; font-size: 13.5px; cursor: pointer;
    font-family: inherit; transition: background .2s; box-shadow: 0 2px 8px rgba(78,125,56,.06);
  }
  .btn:hover { background: #f3f8f1; }
  .btn.end { color: #b91c1c; border-color: #f0cccc; display: none; }
  .btn.end.show { display: inline-block; }
</style>
</head>
<body>
<div class="shell">
  <header>
    <div class="brand">
      <h1>גלי <small id="subtitle">העוזרת הקולית של גלית</small></h1>
    </div>
    <div class="status"><span id="statusText">מנותקת</span><span class="dot" id="dot"></span></div>
  </header>

  <div class="banner" id="banner"></div>

  <div class="stage" id="stage">
    <div class="ring"></div>
    <button class="avatar" id="orb" aria-label="התחלת שיחה">
      ${robotAvatarInner()}
      <span class="label" id="orbLabel">לחצו כדי לדבר איתי</span>
    </button>
  </div>

  <div class="hint" id="hint">אפשר לומר למשל: <b>"מה הבדיקות שלי היום?"</b></div>

  <div class="panel" id="panel">
    <div class="empty" id="empty">
      כאן יופיע תמלול השיחה 💬<br>
      "יצאתי ללקוח" · "כמה חריגים יש?" · "תזמני בדיקה מחר בעשר"<br>
      "מה יש לי ביומן?" · "תוסיפי משימה" · "שלחי הודעה לדני"
    </div>
  </div>

  <div class="foot">
    <button class="btn end" id="endBtn">סיום שיחה</button>
  </div>
</div>

<script>
(function () {
  'use strict';

  var TOKEN = new URLSearchParams(location.search).get('u') || '';

  var TOOL_LABELS = {
    get_my_inspections: 'בודקת את רשימת הבדיקות',
    get_inspection_details: 'שולפת פרטי בדיקה',
    update_inspection_status: 'מעדכנת סטטוס בדיקה',
    decline_inspection: 'מדווחת על דחייה',
    report_problem: 'מדווחת על בעיה למשרד',
    report_missing_info: 'מדווחת שחסר מידע',
    report_missing_equipment: 'מדווחת על ציוד חסר',
    add_inspection_notes: 'שומרת הערות',
    get_day_summary: 'מסכמת את היום',
    correct_site_details: 'מתקנת פרטי אתר',
    schedule_inspection_visit: 'מתזמנת ביקור',
    get_calendar_events: 'קוראת את היומן',
    create_calendar_event: 'קובעת אירוע ביומן',
    create_crm_task: 'יוצרת משימה ב-CRM',
    update_crm_task: 'מעדכנת משימה ב-CRM',
    list_my_crm_tasks: 'שולפת משימות מה-CRM',
    send_whatsapp_message: 'שולחת הודעת וואטסאפ',
    management_snapshot: 'מכינה תמונת מצב',
    list_all_inspections: 'שולפת בדיקות הארגון',
    list_exceptions: 'בודקת חריגים',
    workers_overview: 'סוקרת את העובדים',
    worker_day_detail: 'בודקת עובד ספציפי',
    search_inspections: 'מחפשת בדיקות',
    list_pending_leads: 'בודקת לידים ממתינים',
    assign_lead: 'משייכת ליד',
    reassign_task: 'משייכת משימה מחדש',
    enable_worker_tracking: 'מפעילה מעקב מיקום'
  };

  var stage = document.getElementById('stage');
  var orb = document.getElementById('orb');
  var robotPh = document.getElementById('robotPh'); // placeholder emoji (null once real image is embedded)
  var orbLabel = document.getElementById('orbLabel');
  var statusText = document.getElementById('statusText');
  var dot = document.getElementById('dot');
  var banner = document.getElementById('banner');
  var panel = document.getElementById('panel');
  var emptyEl = document.getElementById('empty');
  var hint = document.getElementById('hint');
  var endBtn = document.getElementById('endBtn');
  var subtitle = document.getElementById('subtitle');

  var pc = null, dc = null, micStream = null, audioEl = null;
  var state = 'idle';
  var botBubble = null;
  var pendingCalls = 0;

  function setState(s, label) {
    state = s;
    stage.className = 'stage ' + (s === 'listening' ? 'listening' : s === 'speaking' ? 'speaking' : s === 'connecting' ? 'connecting' : '');
    statusText.textContent = label;
    dot.className = 'dot' + (s === 'listening' || s === 'speaking' ? ' live' : s === 'error' ? ' err' : '');
    // The robot image carries the personality now; only swap the placeholder
    // emoji when the real image hasn't been embedded yet.
    if (s === 'idle')       { if (robotPh) robotPh.textContent = '🤖'; orbLabel.textContent = 'לחצו כדי לדבר איתי'; }
    if (s === 'connecting') { if (robotPh) robotPh.textContent = '⏳'; orbLabel.textContent = 'מתחברת…'; }
    if (s === 'listening')  { if (robotPh) robotPh.textContent = '🎧'; orbLabel.textContent = 'מקשיבה — דברו חופשי'; }
    if (s === 'speaking')   { if (robotPh) robotPh.textContent = '💬'; orbLabel.textContent = 'גלי מדברת (אפשר לקטוע)'; }
    endBtn.className = 'btn end' + (s === 'idle' || s === 'error' ? '' : ' show');
  }

  function showError(msg) {
    banner.textContent = msg;
    banner.className = 'banner show';
    setState('error', 'שגיאה');
  }
  function clearError() { banner.className = 'banner'; }

  function clearEmpty() { if (emptyEl) { emptyEl.remove(); emptyEl = null; } }

  function addBubble(kind, text) {
    if (!text) return null;
    clearEmpty();
    var el = document.createElement('div');
    el.className = 'msg ' + kind;
    el.textContent = text;
    panel.appendChild(el);
    panel.scrollTop = panel.scrollHeight;
    return el;
  }

  function addChip(toolName) {
    clearEmpty();
    var el = document.createElement('div');
    el.className = 'chip';
    var sp = document.createElement('span'); sp.className = 'spin';
    var tx = document.createElement('span');
    tx.textContent = (TOOL_LABELS[toolName] || toolName) + '…';
    el.appendChild(sp); el.appendChild(tx);
    panel.appendChild(el);
    panel.scrollTop = panel.scrollHeight;
    return { el: el, tx: tx, sp: sp };
  }

  function finishChip(chip, ok, note) {
    chip.sp.remove();
    chip.el.className = 'chip ' + (ok ? 'ok' : 'err');
    chip.tx.textContent = (ok ? '✓ ' : '✗ ') + chip.tx.textContent.replace('…', '') + (note ? ' — ' + note : '');
    panel.scrollTop = panel.scrollHeight;
  }

  function dcSend(obj) {
    if (dc && dc.readyState === 'open') dc.send(JSON.stringify(obj));
  }

  async function runTool(name, callId, argsJson) {
    var chip = addChip(name);
    var args = {};
    try { args = JSON.parse(argsJson || '{}'); } catch (e) { /* keep {} */ }
    var result;
    try {
      var res = await fetch('/voice/tool', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: TOKEN, name: name, args: args })
      });
      result = await res.json();
    } catch (e) {
      result = { ok: false, error: 'תקלת תקשורת מול השרת' };
    }
    finishChip(chip, !!result.ok, result.ok ? '' : (result.error || ''));
    dcSend({
      type: 'conversation.item.create',
      item: { type: 'function_call_output', call_id: callId, output: JSON.stringify(result) }
    });
    pendingCalls--;
    if (pendingCalls <= 0) { pendingCalls = 0; dcSend({ type: 'response.create' }); }
  }

  function handleEvent(ev) {
    var t = ev.type || '';

    if (t === 'conversation.item.input_audio_transcription.completed') {
      addBubble('user', (ev.transcript || '').trim());
      return;
    }
    if (t === 'response.output_audio_transcript.delta' || t === 'response.audio_transcript.delta') {
      if (!botBubble) botBubble = addBubble('bot', ev.delta || ' ');
      else { botBubble.textContent += (ev.delta || ''); panel.scrollTop = panel.scrollHeight; }
      return;
    }
    if (t === 'response.output_audio_transcript.done' || t === 'response.audio_transcript.done') {
      botBubble = null;
      return;
    }
    if (t === 'output_audio_buffer.started') { setState('speaking', 'גלי מדברת'); return; }
    if (t === 'output_audio_buffer.stopped' || t === 'output_audio_buffer.cleared') {
      if (state !== 'idle' && state !== 'error') setState('listening', 'מקשיבה');
      return;
    }
    if (t === 'response.done') {
      var out = (ev.response && ev.response.output) || [];
      var calls = [];
      for (var i = 0; i < out.length; i++) {
        if (out[i] && out[i].type === 'function_call') calls.push(out[i]);
      }
      if (calls.length > 0) {
        pendingCalls = calls.length;
        for (var j = 0; j < calls.length; j++) {
          runTool(calls[j].name, calls[j].call_id, calls[j].arguments);
        }
      }
      return;
    }
    if (t === 'error') {
      var m = (ev.error && ev.error.message) || 'שגיאה בשיחה';
      console.error('realtime error', ev);
      addBubble('bot', '⚠️ ' + m);
      return;
    }
  }

  async function start() {
    clearError();
    if (!TOKEN) { showError('חסר קישור אישי. יש לפתוח את הדף מהקישור שנשלח אליכם.'); return; }
    setState('connecting', 'מתחברת…');

    var session;
    try {
      var res = await fetch('/voice/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: TOKEN })
      });
      session = await res.json();
      if (!res.ok) { showError(session.error || 'הקישור לא תקף'); return; }
    } catch (e) {
      showError('אין תקשורת עם השרת — בדקו חיבור אינטרנט'); return;
    }

    subtitle.textContent = 'שלום ' + (session.user && session.user.name ? session.user.name : '') + ' 👋';

    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      showError('אין הרשאת מיקרופון. יש לאשר גישה למיקרופון בדפדפן ולנסות שוב.'); return;
    }

    try {
      pc = new RTCPeerConnection();
      audioEl = document.createElement('audio');
      audioEl.autoplay = true;
      audioEl.setAttribute('playsinline', 'true');
      pc.ontrack = function (e) { audioEl.srcObject = e.streams[0]; };
      micStream.getTracks().forEach(function (tr) { pc.addTrack(tr, micStream); });

      dc = pc.createDataChannel('oai-events');
      dc.onmessage = function (e) {
        try { handleEvent(JSON.parse(e.data)); } catch (err) { /* ignore non-json */ }
      };
      dc.onopen = function () { setState('listening', 'מקשיבה'); hint.innerHTML = ''; };

      pc.onconnectionstatechange = function () {
        if (!pc) return;
        if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
          if (state !== 'idle') showError('החיבור נותק — אפשר להתחיל שיחה חדשה.');
          cleanup();
        }
      };

      var offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      var sdpRes = await fetch('https://api.openai.com/v1/realtime/calls?model=' + encodeURIComponent(session.model), {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + session.client_secret, 'Content-Type': 'application/sdp' },
        body: offer.sdp
      });
      if (!sdpRes.ok) { showError('פתיחת השיחה נכשלה (' + sdpRes.status + ') — נסו שוב.'); cleanup(); return; }
      var answer = await sdpRes.text();
      await pc.setRemoteDescription({ type: 'answer', sdp: answer });
    } catch (e) {
      console.error(e);
      showError('פתיחת השיחה נכשלה — נסו לרענן את הדף.');
      cleanup();
    }
  }

  function cleanup() {
    if (dc) { try { dc.close(); } catch (e) {} dc = null; }
    if (pc) { try { pc.close(); } catch (e) {} pc = null; }
    if (micStream) { micStream.getTracks().forEach(function (t) { t.stop(); }); micStream = null; }
    botBubble = null; pendingCalls = 0;
  }

  function end() {
    cleanup();
    setState('idle', 'מנותקת');
    addBubble('bot', 'השיחה הסתיימה. אפשר להתחיל חדשה בלחיצה על הכפתור 🎤');
  }

  orb.addEventListener('click', function () {
    if (state === 'idle' || state === 'error') start();
  });
  endBtn.addEventListener('click', end);

  setState('idle', 'מנותקת');
})();
</script>
</body>
</html>`;
}
