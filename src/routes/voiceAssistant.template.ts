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

export function renderVoicePage(): string {
  return `<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<title>גלי — העוזרת הקולית</title>
<style>
  :root {
    --bg1: #0b1026; --bg2: #101936; --card: rgba(255,255,255,.055);
    --line: rgba(255,255,255,.09); --text: #eef2ff; --dim: #93a0c4;
    --accent: #7c9cff; --accent2: #34d399; --danger: #f87171; --amber: #fbbf24;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { height: 100%; }
  body {
    font-family: -apple-system, "Segoe UI", Roboto, "Heebo", Arial, sans-serif;
    background: radial-gradient(1200px 700px at 80% -10%, #1b2a5e 0%, transparent 60%),
                radial-gradient(900px 600px at -10% 110%, #14224d 0%, transparent 55%),
                linear-gradient(160deg, var(--bg1), var(--bg2));
    color: var(--text);
    display: flex; flex-direction: column; align-items: center;
    min-height: 100dvh; padding: 18px 14px calc(18px + env(safe-area-inset-bottom));
  }
  .shell { width: 100%; max-width: 560px; display: flex; flex-direction: column; gap: 14px; flex: 1; }
  header { display: flex; align-items: center; justify-content: space-between; padding: 2px 4px; }
  .brand { display: flex; align-items: center; gap: 10px; }
  .brand .logo {
    width: 38px; height: 38px; border-radius: 12px; display: grid; place-items: center;
    background: linear-gradient(135deg, #6366f1, #22d3ee); font-size: 19px;
    box-shadow: 0 6px 18px rgba(99,102,241,.35);
  }
  .brand h1 { font-size: 17px; font-weight: 700; letter-spacing: .2px; }
  .brand small { display: block; color: var(--dim); font-size: 12px; font-weight: 400; }
  .status { display: flex; align-items: center; gap: 7px; font-size: 12.5px; color: var(--dim); }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: #64748b; transition: background .25s; }
  .dot.live { background: var(--accent2); box-shadow: 0 0 10px rgba(52,211,153,.8); }
  .dot.err { background: var(--danger); }

  .stage {
    position: relative; display: grid; place-items: center; padding: 18px 0 6px;
  }
  .orb {
    position: relative; width: 148px; height: 148px; border-radius: 50%;
    border: none; cursor: pointer; outline: none;
    background: radial-gradient(circle at 32% 28%, #8ea6ff, #4f46e5 58%, #2a2f8f);
    box-shadow: 0 14px 44px rgba(79,70,229,.45), inset 0 -8px 22px rgba(0,0,0,.28);
    display: grid; place-items: center; transition: transform .18s ease, box-shadow .3s;
    -webkit-tap-highlight-color: transparent;
  }
  .orb:active { transform: scale(.97); }
  .orb .ic { font-size: 46px; filter: drop-shadow(0 3px 6px rgba(0,0,0,.35)); }
  .orb .label {
    position: absolute; bottom: -34px; right: 50%; transform: translateX(50%);
    font-size: 13.5px; color: var(--dim); white-space: nowrap;
  }
  .ring { position: absolute; width: 148px; height: 148px; border-radius: 50%; pointer-events: none; opacity: 0; }
  .listening .ring { opacity: 1; animation: pulse 1.9s ease-out infinite; border: 2px solid rgba(52,211,153,.8); }
  .speaking  .ring { opacity: 1; animation: pulse 1.15s ease-out infinite; border: 2px solid rgba(124,156,255,.9); }
  @keyframes pulse { 0% { transform: scale(1); opacity: .85; } 100% { transform: scale(1.55); opacity: 0; } }
  .listening .orb { background: radial-gradient(circle at 32% 28%, #7ef0c3, #059669 58%, #064e3b); box-shadow: 0 14px 44px rgba(16,185,129,.4), inset 0 -8px 22px rgba(0,0,0,.28); }
  .speaking .orb  { background: radial-gradient(circle at 32% 28%, #9db4ff, #4338ca 58%, #1e1b6e); }
  .connecting .orb { animation: breathe 1.2s ease-in-out infinite alternate; }
  @keyframes breathe { from { filter: brightness(.85); } to { filter: brightness(1.15); } }

  .hint { text-align: center; color: var(--dim); font-size: 13px; min-height: 20px; padding: 26px 8px 0; }
  .hint b { color: #c7d2fe; font-weight: 600; }

  .panel {
    flex: 1; min-height: 180px; background: var(--card); border: 1px solid var(--line);
    border-radius: 18px; padding: 14px; overflow-y: auto; display: flex;
    flex-direction: column; gap: 9px; backdrop-filter: blur(8px);
  }
  .empty { color: var(--dim); font-size: 13.5px; text-align: center; margin: auto; line-height: 1.9; }
  .msg { max-width: 86%; padding: 9px 13px; border-radius: 15px; font-size: 14.5px; line-height: 1.55; word-break: break-word; }
  .msg.user { align-self: flex-start; background: rgba(124,156,255,.16); border: 1px solid rgba(124,156,255,.22); border-bottom-right-radius: 5px; }
  .msg.bot  { align-self: flex-end;   background: rgba(255,255,255,.07);  border: 1px solid var(--line); border-bottom-left-radius: 5px; }
  .chip {
    align-self: flex-end; display: inline-flex; align-items: center; gap: 7px;
    font-size: 12.5px; color: #c4b5fd; background: rgba(139,92,246,.12);
    border: 1px solid rgba(139,92,246,.28); border-radius: 999px; padding: 5px 12px;
  }
  .chip.ok  { color: #86efac; background: rgba(52,211,153,.1);  border-color: rgba(52,211,153,.3); }
  .chip.err { color: #fca5a5; background: rgba(248,113,113,.1); border-color: rgba(248,113,113,.3); }
  .spin { width: 11px; height: 11px; border: 2px solid rgba(196,181,253,.35); border-top-color: #c4b5fd; border-radius: 50%; animation: rot .8s linear infinite; }
  @keyframes rot { to { transform: rotate(360deg); } }

  .banner {
    display: none; background: rgba(248,113,113,.12); border: 1px solid rgba(248,113,113,.35);
    color: #fecaca; border-radius: 14px; padding: 11px 14px; font-size: 13.5px; line-height: 1.6;
  }
  .banner.show { display: block; }

  .foot { display: flex; justify-content: center; gap: 10px; }
  .btn {
    border: 1px solid var(--line); background: rgba(255,255,255,.06); color: var(--text);
    padding: 9px 22px; border-radius: 999px; font-size: 13.5px; cursor: pointer;
    font-family: inherit; transition: background .2s;
  }
  .btn:hover { background: rgba(255,255,255,.11); }
  .btn.end { color: #fecaca; border-color: rgba(248,113,113,.4); display: none; }
  .btn.end.show { display: inline-block; }
</style>
</head>
<body>
<div class="shell">
  <header>
    <div class="brand">
      <div class="logo">🎙️</div>
      <h1>גלי <small id="subtitle">העוזרת הקולית של המערכת</small></h1>
    </div>
    <div class="status"><span id="statusText">מנותקת</span><span class="dot" id="dot"></span></div>
  </header>

  <div class="banner" id="banner"></div>

  <div class="stage" id="stage">
    <div class="ring"></div>
    <button class="orb" id="orb" aria-label="התחלת שיחה">
      <span class="ic" id="orbIcon">🎤</span>
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
  var orbIcon = document.getElementById('orbIcon');
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
    if (s === 'idle') { orbIcon.textContent = '🎤'; orbLabel.textContent = 'לחצו כדי לדבר איתי'; }
    if (s === 'connecting') { orbIcon.textContent = '⏳'; orbLabel.textContent = 'מתחברת…'; }
    if (s === 'listening') { orbIcon.textContent = '🎧'; orbLabel.textContent = 'מקשיבה — דברו חופשי'; }
    if (s === 'speaking') { orbIcon.textContent = '💬'; orbLabel.textContent = 'גלי מדברת (אפשר לקטוע)'; }
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
