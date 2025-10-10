<?php
// =========================================================
// PHP Directory Indexer - Read-only, Apache-compatible
// =========================================================

$root = realpath(__DIR__);
$requestUri = urldecode(parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH));
$path = realpath($root . '/' . ltrim(str_replace('/ai2/public', '', $requestUri), '/'));

if ($path === false || strpos($path, $root) !== 0) {
    http_response_code(404);
    echo "<h1>Not Found</h1>";
    exit;
}

if (is_file($path)) {
    header('Content-Type: ' . mime_content_type($path));
    readfile($path);
    exit;
}

$entries = scandir($path);
$dirs = [];
$files = [];

foreach ($entries as $entry) {
    if ($entry === '.' || $entry === '..') continue;
    $fullPath = $path . DIRECTORY_SEPARATOR . $entry;
    if (is_dir($fullPath)) {
        $dirs[] = $entry;
    } else {
        $files[] = $entry;
    }
}

natcasesort($dirs);
natcasesort($files);

$relativePath = str_replace($root, '', $path);
$parts = array_filter(explode('/', trim($relativePath, '/')));

$breadcrumbs = '<a href="/ai2/public/">root</a>';
$accum = '';
foreach ($parts as $part) {
    $accum .= $part . '/';
    $breadcrumbs .= ' / <a href="/ai2/public/' . htmlspecialchars($accum) . '">' . htmlspecialchars($part) . '</a>';
}

?><!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Index of <?= htmlspecialchars($relativePath ?: '/') ?></title>
  <style>
    body { font-family: system-ui, sans-serif; background: #fafafa; color: #333; margin: 2em; }
    h1 { font-size: 1.4em; margin-bottom: .5em; }
    a { color: #0074D9; text-decoration: none; }
    a:hover { text-decoration: underline; }
    table { width: 100%; border-collapse: collapse; margin-top: 1em; }
    th, td { padding: 8px; border-bottom: 1px solid #ddd; text-align: left; }
    tr:hover { background: #f1f1f1; }
  </style>
</head>
<body>
  <h1>Index of <?= htmlspecialchars($relativePath ?: '/') ?></h1>
  <div><?= $breadcrumbs ?></div>
  <table>
    <tr><th>Name</th><th>Type</th><th>Size</th></tr>
    <?php if ($relativePath): ?>
      <tr><td><a href="../">.. (parent)</a></td><td>dir</td><td>-</td></tr>
    <?php endif; ?>
    <?php foreach ($dirs as $d): ?>
      <tr><td><a href="<?= htmlspecialchars($d) ?>/">📁 <?= htmlspecialchars($d) ?>/</a></td><td>dir</td><td>-</td></tr>
    <?php endforeach; ?>
    <?php foreach ($files as $f): ?>
      <tr><td><a href="<?= htmlspecialchars($f) ?>">📄 <?= htmlspecialchars($f) ?></a></td><td>file</td><td><?= filesize($path . '/' . $f) ?></td></tr>
    <?php endforeach; ?>
  </table>
</body>
</html>
