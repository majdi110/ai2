// services/planner.js
'use strict';
const { OPENAI_MODEL, REPO_ROOT, CANONICAL_BRANCH } = require('../config/constants');
const { openaiWithRetry } = require('./openai');
const { nowISO } = require('../utils/time');

const PLAN_MAX_RETRIES       = parseInt(process.env.PLAN_MAX_RETRIES || '2', 10);
const PLAN_CB_WINDOW_MS      = 60_000;
const PLAN_CB_FAILS_TO_TRIP  = 5;
let planFailWindow = [];
function plannerHealthy() {
  const now = Date.now();
  planFailWindow = planFailWindow.filter(t => now - t < PLAN_CB_WINDOW_MS);
  return planFailWindow.length < PLAN_CB_FAILS_TO_TRIP;
}
function recordPlannerFail(){ planFailWindow.push(Date.now()); }

function buildPlannerSystemPrompt() {
  const ROOT = REPO_ROOT;
  const base = [
    'You are a repository automation planner. Emit STRICT JSON only (no prose), matching the schema below.',
    '',
    '{',
    '  "schema": 1,',
    '  "id": "<string unique id>",',
    '  "status": "planned",',
    '  "goal": "<short description>",',
    '  "constraints": {',
    `    "base_branch": "${CANONICAL_BRANCH}",`,
    '    "allowed_ops": ["create","modify","delete"],',
    `    "root_dir": "${ROOT}"`,
    '  },',
    '  "steps": [',
    '    { "type":"patch", "op":"create|modify|delete", "base_branch":"'+CANONICAL_BRANCH+'", "message":"<git commit message>", "diff":"<unified diff starting with diff --git ...>" },',
    '    { "type":"commands", "schema":1, "workdir":"'+ROOT+'", "steps":["..."] }',
    '  ],',
    '  "combined_diff": null,',
    '  "artifacts": null,',
    '  "telemetry": null',
    '}',
    '',
    'Rules:',
    `- All file paths MUST be under ${ROOT} and obey the server allowed prefixes.`,
    "- Unified diffs MUST start with 'diff --git ' and be valid git-format patches.",
    '- Prefer a SINGLE patch step when possible.',
    '- Keep total diff size < 200 KB.',
    '- NEVER write outside allowed prefixes.',
    '- No binaries or base64 (text-only patches).',
    '- Minimal edits when modifying existing files.',
    '- Use commands step only for small, safe tasks.',
    '- Output must be pure JSON.',
    '',
    'Templates:',
    'HTML_MINIMAL := "<!doctype html>\\n<html lang=\\"en\\">\\n<head>\\n  <meta charset=\\"utf-8\\">\\n  <title>${TITLE}</title>\\n</head>\\n<body>\\n  <h1>${H1}</h1>\\n</body>\\n</html>\\n"',
    '',
    'Examples:',
    'EXAMPLE_CREATE:',
    '{ "schema":1,"id":"ex-create-1","status":"planned","goal":"Create a welcome page","constraints":{"base_branch":"'+CANONICAL_BRANCH+'","allowed_ops":["create","modify","delete"],"root_dir":"'+ROOT+'"},"steps":[{ "type":"patch","op":"create","base_branch":"'+CANONICAL_BRANCH+'","message":"Add welcome page","diff":"diff --git a/public/welcome.html b/public/welcome.html\\nnew file mode 100644\\nindex 0000000..e69de29\\n--- /dev/null\\n+++ b/public/welcome.html\\n@@ -0,0 +1,5 @@\\n+<!doctype html>\\n+<title>Welcome</title>\\n+<h1>Welcome</h1>\\n+<p>Hello!</p>\\n+" }],"combined_diff":null,"artifacts":null,"telemetry":null }',
    '',
    'EXAMPLE_MODIFY:',
    '{ "schema":1,"id":"ex-mod-1","status":"planned","goal":"Update title in index.html","constraints":{"base_branch":"'+CANONICAL_BRANCH+'","allowed_ops":["create","modify","delete"],"root_dir":"'+ROOT+'"},"steps":[{ "type":"patch","op":"modify","base_branch":"'+CANONICAL_BRANCH+'","message":"Change title to AI2 Demo","diff":"diff --git a/public/index.html b/public/index.html\\nindex abc1234..def5678 100644\\n--- a/public/index.html\\n+++ b/public/index.html\\n@@ -1,5 +1,5 @@\\n <!doctype html>\\n <meta charset=\\"utf-8\\">\\n-<title>Old</title>\\n+<title>AI2 Demo</title>\\n <h1>Hello</h1>\\n" }],"combined_diff":null,"artifacts":null,"telemetry":null }',
    '',
    'EXAMPLE_DELETE:',
    '{ "schema":1,"id":"ex-del-1","status":"planned","goal":"Remove deprecated file","constraints":{"base_branch":"'+CANONICAL_BRANCH+'","allowed_ops":["create","modify","delete"],"root_dir":"'+ROOT+'"},"steps":[{ "type":"patch","op":"delete","base_branch":"'+CANONICAL_BRANCH+'","message":"Remove old file","diff":"diff --git a/public/old.txt b/public/old.txt\\ndeleted file mode 100644\\nindex 1a2b3c4..0000000\\n--- a/public/old.txt\\n+++ /dev/null\\n@@ -1,1 +0,0 @@\\n-legacy content\\n" }],"combined_diff":null,"artifacts":null,"telemetry":null }',
  ];

  const VERBOSE = (process.env.PROMPT_VERBOSE || '') && process.env.PROMPT_VERBOSE !== '0';
  if (VERBOSE) {
    base.push(
      '',
      'EXAMPLES (concise few-shots to guide planning):',
      String.raw`EXAMPLE: Modify public/index.html title
{
  "schema":1,"id":"ex-1","status":"planned","goal":"Update title",
  "constraints":{"base_branch":"${CANONICAL_BRANCH}","allowed_ops":["create","modify","delete"],"root_dir":"${ROOT}"},
  "steps":[{"type":"patch","op":"modify","base_branch":"${CANONICAL_BRANCH}","message":"Update title",
    "diff":"diff --git a/public/index.html b/public/index.html
index abc..def 100644
--- a/public/index.html
+++ b/public/index.html
@@ -1,5 +1,5 @@
 <!doctype html>
 <html lang=\"en\">
-<title>Old</title>
+<title>AI2 Demo</title>
 </html>
"
  }],
  "combined_diff":null,"artifacts":null,"telemetry":null
}`,
      String.raw`EXAMPLE: Create public/about.html
{
  "schema":1,"id":"ex-2","status":"planned","goal":"Add about page",
  "constraints":{"base_branch":"${CANONICAL_BRANCH}","allowed_ops":["create","modify","delete"],"root_dir":"${ROOT}"},
  "steps":[{"type":"patch","op":"create","base_branch":"${CANONICAL_BRANCH}","message":"Add about.html",
    "diff":"diff --git a/public/about.html b/public/about.html
new file mode 100644
index 0000000..e69de29
--- /dev/null
+++ b/public/about.html
@@ -0,0 +1,6 @@
+<!doctype html>
+<meta charset=\"utf-8\">
+<title>About - AI2 Demo</title>
+<h1>About</h1>
+<p>Static page from public/</p>
"
  }],
  "combined_diff":null,"artifacts":null,"telemetry":null
}`,
      String.raw`EXAMPLE: Delete a stale file
{
  "schema":1,"id":"ex-3","status":"planned","goal":"Remove old file",
  "constraints":{"base_branch":"${CANONICAL_BRANCH}","allowed_ops":["create","modify","delete"],"root_dir":"${ROOT}"},
  "steps":[{"type":"patch","op":"delete","base_branch":"${CANONICAL_BRANCH}","message":"Remove old file",
    "diff":"diff --git a/public/old.html b/public/old.html
deleted file mode 100644
index 0123456..0000000
--- a/public/old.html
+++ /dev/null
@@ -1,3 +0,0 @@
-<!doctype html>
-<title>Old</title>
-<p>unused</p>
"
  }],
  "combined_diff":null,"artifacts":null,"telemetry":null
}`,
      '',
      'NEGATIVE RULES:',
      '- Never write outside allowed prefixes (ALLOWED_PATH_PREFIXES).',
      '- Diffs must start with "diff --git " and stay under 200 KB.',
      '- No binary blobs or base64; text-only patches.',
      '- Prefer a single patch step whenever possible.',
      '- Use type:"commands" only when necessary and safe.'
    );
  }
  return base.join('\n');
}


function injectContextIntoPrompt(userText, contextBlock) {
  return contextBlock ? (`[CONTEXT FOLLOWS]\n${contextBlock}\n\n[REQUEST]\n${userText}`) : userText;
}
async function callOpenAIPlan(userPrompt) {
  const system = buildPlannerSystemPrompt();
  const body = {
    model: OPENAI_MODEL,
    input: [
      { role: 'system', content: system },
      { role: 'user',   content: String(userPrompt) }
    ],
    text: { format: { type: "json_object" } }
  };
  const j = await openaiWithRetry(body);
  const txt =
    j.output_text ||
    (j.output?.[0]?.content?.[0]?.text) ||
    (Array.isArray(j.output) && j.output.map(o => o?.content?.[0]?.text).filter(Boolean).join('\n')) ||
    (j.choices?.[0]?.message?.content) ||
    (typeof j === 'string' ? j : '');
  if (!txt) throw new Error('openai_no_output');
  let planObj;
  try { planObj = JSON.parse(txt); }
  catch { throw new Error('openai_bad_json'); }
  const usage = j.usage || j.output?.[0]?.usage || null;
  return { plan: planObj, usage };
}
async function planWithRetry(effPrompt, sseEmit) {
  if (!plannerHealthy()) {
    if (sseEmit) sseEmit('planner_cb_tripped', { window_ms: 60_000 });
    throw new Error('planner_unavailable');
  }
  let lastErr;
  for (let i = 0; i <= PLAN_MAX_RETRIES; i++) {
    try { return await callOpenAIPlan(effPrompt); }
    catch (e) {
      lastErr = e;
      recordPlannerFail();
      if (sseEmit) sseEmit('planner_retry', { attempt: i + 1, error: String(e.message || e).slice(0,200) });
      await new Promise(r => setTimeout(r, 250 + Math.random()*500));
    }
  }
  throw lastErr || new Error('planner_failed');
}

module.exports = { buildPlannerSystemPrompt, injectContextIntoPrompt, callOpenAIPlan, planWithRetry };
