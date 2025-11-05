/* public/app.ui.js - Enhanced version with better UX */
(() => {
  const API = (window.AI2_API_BASE || '/ai2').replace(/\/+$/, '');
  const TOKEN_KEY = 'ai2_token';
  const IDEM = () => `ui-${Date.now()}-${Math.random().toString(36).slice(2,6)}`;

  // Token management
  function setToken(tok) {
    if (tok) sessionStorage.setItem(TOKEN_KEY, tok);
    else sessionStorage.removeItem(TOKEN_KEY);
  }
  function getToken() {
    // Check session first, then ENV from localStorage
    const session = sessionStorage.getItem(TOKEN_KEY);
    if (session) return session;
    const env = JSON.parse(localStorage.getItem('ai2_env') || '{}');
    return env.API_TOKEN || '';
  }
  window.ai2SetToken = setToken;

  // Auth headers with CSRF protection
  function authHeaders(extra = {}) {
    const h = {
      'X-Requested-With': 'ai2-ui',
      ...extra
    };
    const t = getToken();
    if (t) h['Authorization'] = `Bearer ${t}`;
    return h;
  }

  // Enhanced event logging
  function appendLine(el, line, type = 'info') {
    if (!el) return;
    const timestamp = new Date().toLocaleTimeString();
    const prefix = {
      'info': '📝',
      'success': '✅',
      'error': '❌',
      'warn': '⚠️',
      'progress': '⏳'
    }[type] || '•';
    
    const formattedLine = `[${timestamp}] ${prefix} ${line}`;
    
    if (el.tagName === 'TEXTAREA') {
      el.value += formattedLine + '\n';
      el.scrollTop = el.scrollHeight;
    } else {
      el.textContent += formattedLine + '\n';
      el.scrollTop = el.scrollHeight;
    }
  }

  // SSE over fetch with enhanced error handling
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
          console.warn('SSE parse error', e, frame.slice(0, 100));
        }
      }
    }
  }

  // Plan with streaming and better event handling
  async function planStream({
    prompt,
    include_files = [],
    preview_only = true,
    return_combined_diff = false,
    fallback_steps = null,
    idempotencyKey = IDEM(),
    eventsTargetId = null,
    onEvent = null,
    onProgress = null
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
      
      // Enhanced event display
      if (target) {
        const type = evt.event === 'error' ? 'error' : 
                     evt.event === 'final' ? 'success' :
                     evt.event === 'thinking' ? 'progress' : 'info';
        
        let msg = '';
        if (evt.event === 'thinking') msg = 'AI is thinking...';
        else if (evt.event === 'planning') msg = 'Generating plan...';
        else if (evt.event === 'validating') msg = 'Validating changes...';
        else if (evt.event === 'queued') msg = `Queued: ${evt.job || 'job'}`;
        else if (evt.event === 'final') msg = 'Plan completed!';
        else if (evt.event === 'error') msg = `Error: ${evt.message || 'Unknown error'}`;
        else msg = JSON.stringify(evt);
        
        appendLine(target, msg, type);
      }
      
      // Progress callback
      if (onProgress && evt.event) {
        onProgress(evt);
      }
      
      // User callback
      if (onEvent) onEvent(evt);
    }

    await fetchSSE(`${API}/plan?stream=1`, {
      headers: authHeaders({ 'X-Idempotency-Key': idempotencyKey }),
      bodyObj: body,
      onEvent: handle
    });

    return seen;
  }

  // Jobs management
  async function jobsList(state = 'queue', limit = 50) {
    const res = await fetch(
      `${API}/jobs/list?state=${encodeURIComponent(state)}&limit=${limit}`,
      { headers: authHeaders() }
    );
    if (!res.ok) throw new Error(`jobs_list ${res.status}`);
    return res.json();
  }

  async function jobLog(file, lines = 200) {
    const q = `file=${encodeURIComponent(file)}&lines=${lines}`;
    const res = await fetch(`${API}/jobs/log?${q}`, { headers: authHeaders() });
    if (!res.ok) throw new Error(`jobs_log ${res.status}`);
    const ctype = res.headers.get('content-type') || '';
    if (ctype.startsWith('application/json')) return res.json();
    return res.text();
  }

  // Plans management
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

  // Repo operations
  async function repoRead(pathRel) {
    const res = await fetch(`${API}/repo/read?path=${encodeURIComponent(pathRel)}`, { headers: authHeaders() });
    if (!res.ok) throw new Error(`repo_read ${res.status}`);
    return res.text();
  }

  async function repoLs(pathRel = '', depth = 1) {
    const res = await fetch(
      `${API}/repo/ls?path=${encodeURIComponent(pathRel)}&depth=${depth}`,
      { headers: authHeaders() }
    );
    if (!res.ok) throw new Error(`repo_ls ${res.status}`);
    return res.json();
  }

  // Preview with combined diff
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
      const p = j && (j.plan || j);
      const txt = p && p.combined_diff ? p.combined_diff : '(no diff)';
      if (diffEl) diffEl.textContent = txt;
    } catch (e) {
      if (diffEl) diffEl.textContent = `Failed to load plan ${finalPlanId}: ${e.message}`;
    }
  }

  // Apply with fallback
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
        steps: fb
      }];
    }

    await planStream({
      ...payload,
      idempotencyKey: IDEM(),
      eventsTargetId: 'ai2-events'
    });
  }

  // Enhanced UI helpers for loading lists
  async function loadJobsList(state, targetId) {
    const target = document.getElementById(targetId);
    if (!target) return;
    
    try {
      const data = await jobsList(state, 20);
      target.innerHTML = '';
      
      if (!data.items || data.items.length === 0) {
        target.innerHTML = '<li style="color:#666;padding:10px">No items</li>';
        return;
      }
      
      data.items.forEach(it => {
        const li = document.createElement('li');
        const date = new Date(it.mtime * 1000).toLocaleString();
        li.innerHTML = `
          <div style="display:flex;justify-content:space-between;align-items:center;padding:8px">
            <span style="font-family:monospace;font-size:12px">${it.file}</span>
            <span style="font-size:11px;color:#888">${date}</span>
          </div>
        `;
        li.style.cursor = 'pointer';
        li.onclick = async () => {
          try {
            const log = await jobLog(it.file);
            alert(typeof log === 'string' ? log : JSON.stringify(log, null, 2));
          } catch (e) {
            alert('Failed to load log: ' + e.message);
          }
        };
        target.appendChild(li);
      });
    } catch (e) {
      target.innerHTML = `<li style="color:#ef4444;padding:10px">Error: ${e.message}</li>`;
    }
  }

  async function loadPlansList(targetId = 'ai2-plans') {
    const target = document.getElementById(targetId);
    if (!target) return;
    
    try {
      const data = await plansList(10);
      target.innerHTML = '';
      
      if (!data.items || data.items.length === 0) {
        target.innerHTML = '<li style="color:#666;padding:10px">No plans yet</li>';
        return;
      }
      
      data.items.forEach(it => {
        const li = document.createElement('li');
        const id = it.file.replace(/\.json$/, '');
        li.textContent = id;
        li.style.cursor = 'pointer';
        li.style.padding = '8px';
        li.onclick = async () => {
          try {
            const plan = await planRead(id);
            const el = document.getElementById('plan-json');
            if (el) el.textContent = JSON.stringify(plan, null, 2);
          } catch (e) {
            alert('Failed to load plan: ' + e.message);
          }
        };
        target.appendChild(li);
      });
    } catch (e) {
      target.innerHTML = `<li style="color:#ef4444;padding:10px">Error: ${e.message}</li>`;
    }
  }

  // Auto-refresh helpers
  window.loadJobs = loadJobsList;
  window.refreshJobs = () => {
    loadJobsList('queue', 'jobs-queue');
    loadJobsList('done', 'jobs-done');
    loadJobsList('fail', 'jobs-fail');
  };
  window.refreshHistory = () => loadPlansList('plans');
  window.appendLog = (x) => {
    const t = document.getElementById('events');
    if (t) appendLine(t, x);
  };

  // SSE runner for project page
  window.runPlanSSE = async (payload) => {
    return planStream({
      ...payload,
      idempotencyKey: IDEM(),
      eventsTargetId: 'events'
    });
  };

  // Export API
  window.ai2 = {
    planStream,
    previewAndShowDiff,
    applyWithFallback,
    jobsList,
    jobLog,
    plansList,
    planRead,
    repoRead,
    repoLs,
    setToken,
    getToken,
    loadJobsList,
    loadPlansList
  };

  // Auto-init minimal wiring
  async function initWiring() {
    const btnPlan = document.getElementById('ai2-plan-btn');
    const btnApply = document.getElementById('ai2-apply-btn');
    const inpPrompt = document.getElementById('ai2-prompt');
    const inpToken = document.getElementById('ai2-token');
    const taFallback = document.getElementById('ai2-fallback');
    const taEvents = document.getElementById('ai2-events');

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
          if (taEvents) appendLine(taEvents, e.message, 'error');
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
            include_files: ['public/index.html'],
            fallbackSteps: fb
          });
        } catch (e) {
          if (taEvents) appendLine(taEvents, e.message, 'error');
        }
      });
    }

    // Auto-load lists if elements exist
    if (document.getElementById('ai2-plans')) {
      loadPlansList('ai2-plans').catch(console.error);
    }
    if (document.getElementById('ai2-jobs')) {
      loadJobsList('queue', 'ai2-jobs').catch(console.error);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initWiring);
  } else {
    initWiring();
  }
})();