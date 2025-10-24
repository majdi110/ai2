/* public/app.ui.js */
/* Minimal ai2 UI helpers: plan (SSE via fetch), jobs, plans, logs. */

(() => {
  const API = (window.AI2_API_BASE || '/ai2').replace(/\/+$/, ''); // allow override via window.AI2_API_BASE
  const TOKEN_KEY = 'ai2_token';
  const IDEM = () => `ui-${Date.now()}-${Math.random().toString(36).slice(2,6)}`;

  // --- token helpers ---
  function setToken(tok) {
    if (tok) sessionStorage.setItem(TOKEN_KEY, tok);
    else sessionStorage.removeItem(TOKEN_KEY);
  }
  function getToken() {
    return sessionStorage.getItem(TOKEN_KEY) || '';
  }
  window.ai2SetToken = setToken; // expose a simple setter

  // --- headers (auth + csrf-ish) ---
  function authHeaders(extra = {}) {
    const h = {
      'X-Requested-With': 'ai2-ui',
      ...extra
    };
    const t = getToken();
    if (t) h['Authorization'] = `Bearer ${t}`;
    return h;
  }

  // --- tiny event helper to append text to <pre>/<textarea> ---
  function appendLine(el, line) {
    if (!el) return;
    if (el.tagName === 'TEXTAREA') {
      el.value += line + '\n';
      el.scrollTop = el.scrollHeight;
    } else {
      el.textContent += line + '\n';
    }
  }

  // --- SSE over fetch (so we can send Authorization headers) ---
  async function fetchSSE(url, { method = 'POST', headers = {}, bodyObj = {}, onEvent } = {}) {
    const res = await fetch(url, {
      method,
      headers: {
        'Accept': 'text/event-stream',
        'Content-Type': 'application/json',
        ...headers
      },
      body: JSON.stringify(bodyObj)
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${txt.slice(0, 300)}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      // SSE frames separated by blank line; each line begins with "data: "
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const frame = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 2);
        const dataLine = frame.split('\n').find(l => l.startsWith('data: '));
        if (!dataLine) continue;
        const jsonStr = dataLine.slice(6);
        try {
          const evt = JSON.parse(jsonStr);
          if (typeof onEvent === 'function') onEvent(evt);
        } catch (e) {
          console.warn('SSE parse error', e, frame);
        }
      }
    }
  }

  // --- Plan: stream events to a DOM target (optional) and a callback ---
  async function planStream({
    prompt,
    include_files = [],
    preview_only = true,
    return_combined_diff = false,
    fallback_steps = null,
    idempotencyKey = IDEM(),
    eventsTargetId = null,
    onEvent = null
  }) {
    const body = {
      prompt,
      include_files,
      preview_only,
      return_combined_diff
    };
    if (fallback_steps) body.fallback_steps = fallback_steps;

    const target = eventsTargetId ? document.getElementById(eventsTargetId) : null;
    const seen = [];

    function handle(evt) {
      seen.push(evt);
      if (target) appendLine(target, JSON.stringify(evt));
      if (onEvent) onEvent(evt);
    }

    await fetchSSE(`${API}/plan?stream=1`, {
      headers: authHeaders({ 'X-Idempotency-Key': idempotencyKey }),
      bodyObj: body,
      onEvent: handle
    });

    return seen;
  }

  // --- Jobs list ---
  async function jobsList(state = 'queue', limit = 50) {
    const res = await fetch(`${API}/jobs/list?state=${encodeURIComponent(state)}&limit=${limit}`, {
      headers: authHeaders()
    });
    if (!res.ok) throw new Error(`jobs_list ${res.status}`);
    return res.json();
  }

  // --- Job log: file can be job-*.json or *.log ---
  async function jobLog(file, lines = 200) {
    const q = `file=${encodeURIComponent(file)}&lines=${lines}`;
    const res = await fetch(`${API}/jobs/log?${q}`, { headers: authHeaders() });
    if (!res.ok) throw new Error(`jobs_log ${res.status}`);
    const ctype = res.headers.get('content-type') || '';
    if (ctype.startsWith('application/json')) return res.json();
    return res.text();
  }

  // --- Plans ---
  async function plansList(limit = 50) {
    const res = await fetch(`${API}/plans/list?limit=${limit}`, { headers: authHeaders() });
    if (!res.ok) throw new Error(`plans_list ${res.status}`);
    return res.json();
  }
  async function planRead(id) {
    const res = await fetch(`${API}/plans/read?id=${encodeURIComponent(id)}`, { headers: authHeaders() });
    if (!res.ok) throw new Error(`plan_read ${res.status}`);
    return res.json();
  }

  // --- Repo read (auth) ---
  async function repoRead(pathRel) {
    const res = await fetch(`${API}/repo/read?path=${encodeURIComponent(pathRel)}`, { headers: authHeaders() });
    if (!res.ok) throw new Error(`repo_read ${res.status}`);
    return res.text();
  }

  // --- Preview once and show combined diff (uses return_combined_diff) ---
  async function previewAndShowDiff({ prompt, include_files = [] }) {
    const diffEl = document.getElementById('ai2-diff');
    if (diffEl) diffEl.textContent = '';
    const eventsEl = document.getElementById('ai2-events');
    if (eventsEl) eventsEl.value = '';

    let finalPlanId = null;
    await planStream({
      prompt,
      include_files,
      preview_only: true,
      return_combined_diff: true,
      idempotencyKey: IDEM(),
      eventsTargetId: 'ai2-events',
      onEvent: (evt) => {
        if (evt.event === 'final' && evt.plan && evt.plan.id) {
          finalPlanId = evt.plan.id;
        }
      }
    });

    if (!finalPlanId) {
      if (diffEl) diffEl.textContent = '(no plan id from preview)';
      return;
    }
    try {
    const j = await planRead(finalPlanId);
    const p = j && (j.plan || j);              // preview: root; applied: {plan:{...}}
    const txt = p && p.combined_diff ? p.combined_diff : '(no diff)';
    if (diffEl) diffEl.textContent = txt;

    } catch (e) {
      if (diffEl) diffEl.textContent = `Failed to load plan ${finalPlanId}: ${e.message}`;
    }
  }

  // --- Apply with an optional fallback commands step (used if planner returns no steps) ---
  async function applyWithFallback({ prompt, include_files = [], fallbackSteps = [] }) {
    const eventsEl = document.getElementById('ai2-events');
    if (eventsEl) eventsEl.value = '';
    const fb = (fallbackSteps || []).filter(Boolean);

    const payload = {
      prompt,
      include_files,
      preview_only: false,
      return_combined_diff: false
    };
    if (fb.length) {
      payload.fallback_steps = [{
        type: 'commands',
        schema: 1,
        // omit workdir to let the server default to REPO_ROOT
        steps: fb
      }];
    }

    await planStream({
      ...payload,
      idempotencyKey: IDEM(),
      eventsTargetId: 'ai2-events'
    });
  }

  // --- Attach a tiny UI helper if elements exist ---
  async function initWiring() {
    const btnPlan = document.getElementById('ai2-plan-btn');
    const btnApply = document.getElementById('ai2-apply-btn');
    const taEvents = document.getElementById('ai2-events');
    const inpPrompt = document.getElementById('ai2-prompt');
    const inpToken = document.getElementById('ai2-token');
    const plansUl = document.getElementById('ai2-plans');
    const jobsUl = document.getElementById('ai2-jobs');
    const taFallback = document.getElementById('ai2-fallback');

    if (inpToken) {
      inpToken.addEventListener('change', () => setToken(inpToken.value.trim()));
      const prev = getToken();
      if (prev) inpToken.value = prev;
    }

    if (btnPlan && inpPrompt) {
      btnPlan.addEventListener('click', async () => {
        if (taEvents) taEvents.value = '';
        try {
          await previewAndShowDiff({
            prompt: inpPrompt.value,
            include_files: ['public/index.html']
          });
        } catch (e) {
          appendLine(taEvents, `ERROR: ${e.message}`);
        }
      });
    }

    if (btnApply && inpPrompt) {
      btnApply.addEventListener('click', async () => {
        if (taEvents) taEvents.value = '';
        try {
          const fb = taFallback
            ? taFallback.value.split(/\r?\n/).map(s => s.trim()).filter(Boolean)
            : [];
          await applyWithFallback({
            prompt: inpPrompt.value,
            include_files: ['public/index.html', 'public/app.ui.js'],
            fallbackSteps: fb
          });
        } catch (e) {
          appendLine(taEvents, `ERROR: ${e.message}`);
        }
      });
    }

    // simple loaders
    async function refreshPlans() {
      if (!plansUl) return;
      const j = await plansList(10);
      plansUl.innerHTML = '';
      (j.items || []).forEach(it => {
        const li = document.createElement('li');
        const id = it.file.replace(/\.json$/, '');
        li.textContent = id;
        li.style.cursor = 'pointer';
        li.onclick = async () => {
          const d = await planRead(id);
          alert(JSON.stringify(d, null, 2));
        };
        plansUl.appendChild(li);
      });
    }
    async function refreshJobs() {
      if (!jobsUl) return;
      const j = await jobsList('queue', 20);
      jobsUl.innerHTML = '';
      (j.items || []).forEach(it => {
        const li = document.createElement('li');
        li.textContent = `[${new Date(it.mtime * 1000).toISOString()}] ${it.file}`;
        jobsUl.appendChild(li);
      });
    }

    if (plansUl) refreshPlans().catch(console.error);
    if (jobsUl) refreshJobs().catch(console.error);
  }

  // expose API on window for quick hacking
  window.ai2 = {
    planStream,
    previewAndShowDiff,
    applyWithFallback,
    jobsList,
    jobLog,
    plansList,
    planRead,
    repoRead,
    setToken
  };

  // auto-init on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initWiring);
  } else {
    initWiring();
  }
})();
