// ci_client.js (Node 16 compatible)
// Usage:
//   ACTION_TOKEN=... ACTION_BASE_URL=https://datav.belocloud.com/ai2 \
//   node ci_client.js dryrun  --branch main --message "test" --diff-file ./patch.diff
//   node ci_client.js submit  --branch main --message "Add lam.html" --new-file public/lam.html --content "<!doctype html>..."

const fetch = require("node-fetch");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const BASE_URL = process.env.ACTION_BASE_URL || "https://datav.belocloud.com/ai2";
const ACTION_TOKEN = process.env.ACTION_TOKEN;
if (!ACTION_TOKEN) {
  console.error("Missing ACTION_TOKEN env var.");
  process.exit(1);
}

function idemKey(prefix = "ci") {
  return `${prefix}-${Date.now()}-${crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString("hex")}`;
}
function asBase64(s) { return Buffer.from(s, "utf8").toString("base64"); }
function readMaybeFileSync(input) {
  try {
    const st = fs.statSync(input);
    if (st.isFile()) return fs.readFileSync(input, "utf8");
  } catch {}
  return input;
}
function makeNewFilePatch(filePath, content) {
  const p = filePath.replace(/\\/g, "/");
  const body = content.endsWith("\n") ? content : content + "\n";
  const lines = body.split("\n").length - 1;
  return [
    `diff --git a/${p} b/${p}`,
    `new file mode 100644`,
    `index 0000000..1111111`,
    `--- /dev/null`,
    `+++ b/${p}`,
    `@@ 0,0 1,${lines} @@`,
    body.split("\n").map(line => (line.length ? `+${line}` : "+")).join("\n"),
  ].join("\n");
}

async function callApi(endpoint, payload, idemPrefix = "ci") {
  const url = `${BASE_URL}/${endpoint}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": ACTION_TOKEN,
      "x-idempotency-key": idemKey(idemPrefix),
      "accept": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) {
    const msg = data && (data.error || data.message) || res.statusText;
    throw new Error(`HTTP ${res.status}: ${msg}`);
  }
  return data;
}

async function dryRun({ base_branch, message, diff, diff_b64 }) {
  const payload = { base_branch, message, ...(diff ? { diff } : { diff_b64 }) };
  return callApi("diff_dryrun", payload, "dryrun");
}
async function submitDiff({ base_branch, message, diff, diff_b64 }) {
  const payload = { base_branch, message, ...(diff ? { diff } : { diff_b64 }) };
  return callApi("diff_submit", payload, "submit");
}

(async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error("Usage: node ci_client.js <dryrun|submit> [--branch main] [--message msg] (--diff-file file | --diff text | --new-file path --content str) [--b64 true]");
    process.exit(2);
  }
  const mode = args.shift();

  const get = (flag, fb) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : fb;
  };

  const base_branch = get("--branch", "main");
  const message     = get("--message", "Automated change");
  const diffFile    = get("--diff-file");
  const diffLiteral = get("--diff");
  const newFile     = get("--new-file");
  const content     = get("--content") || "";
  const useB64      = (get("--b64", "false") === "true");

  let diff = null;
  if (newFile) {
    diff = makeNewFilePatch(newFile, content);
  } else if (diffFile) {
    diff = readMaybeFileSync(diffFile);
  } else if (diffLiteral) {
    diff = diffLiteral;
  } else {
    console.error("Provide --diff-file, --diff, or --new-file with --content.");
    process.exit(2);
  }

  const payload = {
    base_branch,
    message,
    ...(useB64 ? { diff_b64: asBase64(diff) } : { diff }),
  };

  try {
    const fn = mode === "submit" ? submitDiff : dryRun;
    const res = await fn(payload);
    console.log(JSON.stringify(res, null, 2));
  } catch (err) {
    console.error(err && err.stack || String(err));
    process.exit(1);
  }
})();
