import express from 'express';
import path from 'path';
import fs from 'fs';

const app = express();
const PORT = 3000;

// Root directory to display
const ROOT_DIR = path.resolve('/home/genweb/public_html/datav.belocloud.com/ai2');

// Serve static assets (CSS/icons)
app.use('/_static', express.static(path.join(ROOT_DIR, 'public', '_static')));

// Helper to safely resolve and verify path
function resolveSafe(targetPath) {
  const resolved = path.resolve(path.join(ROOT_DIR, targetPath));
  if (!resolved.startsWith(ROOT_DIR)) throw new Error('Invalid path');
  return resolved;
}

function generateListHTML(currentPath, entries) {
  const relPath = path.relative(ROOT_DIR, currentPath) || '';
  const breadcrumb = relPath.split(path.sep).filter(Boolean);

  const breadcrumbHTML = ['<a href="/">root</a>']
    .concat(
      breadcrumb.map((part, idx) => {
        const url = '/' + breadcrumb.slice(0, idx + 1).join('/');
        return `<a href="/${url}">${part}</a>`;
      })
    )
    .join(' / ');

  let html = `<!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Index of /${relPath}</title>
    <style>
      body{font-family:system-ui,Arial;margin:2em;background:#fafafa;color:#333}
      h1{font-size:1.5em;margin-bottom:0.5em}
      a{text-decoration:none;color:#0074D9}
      a:hover{text-decoration:underline}
      table{width:100%;border-collapse:collapse;margin-top:1em}
      th,td{text-align:left;padding:8px;border-bottom:1px solid #ddd}
      tr:hover{background:#f1f1f1}
    </style>
  </head>
  <body>
  <h1>Index of /${relPath}</h1>
  <div>${breadcrumbHTML}</div>
  <table>
  <tr><th>Name</th><th>Type</th><th>Size</th></tr>`;

  const folders = entries.filter(e => e.isDirectory());
  const files = entries.filter(e => e.isFile());

  if (relPath) {
    const parent = '/' + path.dirname(relPath);
    html += `<tr><td><a href="/${parent}">.. (parent)</a></td><td>dir</td><td>-</td></tr>`;
  }

  for (const folder of folders) {
    html += `<tr><td><a href="/${path.join(relPath, folder.name)}">${folder.name}/</a></td><td>dir</td><td>-</td></tr>`;
  }
  for (const file of files) {
    const fileUrl = '/' + path.join(relPath, file.name);
    const stats = fs.statSync(path.join(currentPath, file.name));
    html += `<tr><td><a href="${fileUrl}">${file.name}</a></td><td>file</td><td>${stats.size}</td></tr>`;
  }

  html += '</table></body></html>';
  return html;
}

// Dynamic directory listing route
app.get('*', (req, res) => {
  try {
    const requestPath = decodeURIComponent(req.path);
    const fullPath = resolveSafe(requestPath);

    if (!fs.existsSync(fullPath)) {
      return res.status(404).send('Not Found');
    }

    const stats = fs.statSync(fullPath);

    if (stats.isDirectory()) {
      const entries = fs.readdirSync(fullPath, { withFileTypes: true });
      res.send(generateListHTML(fullPath, entries));
    } else {
      res.sendFile(fullPath);
    }
  } catch (err) {
    res.status(500).send('Error: ' + err.message);
  }
});

app.listen(PORT, () => {
  console.log(`📁 File browser available at http://localhost:${PORT}`);
});

