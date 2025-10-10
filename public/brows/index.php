<?php
// ============================================================
// PHP Directory Browser (Read-only, Apache-compatible)
// ============================================================

$root = realpath(__DIR__);
$requestUri = urldecode(parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH));
$path = realpath($root . '/' . ltrim(str_replace('/brows', '', $requestUri), '/'));

if ($path === false || strpos($path, $root) !== 0) {
    http_response_code(404);
    echo '<h1>404 Not Found</h1>';
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
    $full = $path . DIRECTORY_SEPARATOR . $entry;
    if (is_dir($full)) {
        $dirs[] = $entry;
    } else {
        $files[] = $entry;
    }
}

natcasesort($dirs);
natcasesort($files);

$breadcrumbs = [];
$parts = explode('/', trim(str_replace($root, '', $path), '/'));
$accum = '/brows';
foreach ($parts as $part) {
    if ($part === '') continue;
    $accum .= '/' . $part;
    $breadcrumbs[] = '<a href="' . htmlspecialchars($accum) . '/">' . htmlspecialchars($part) . '</a>';
}

?><!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Directory Browser</title>
    <style>
        body { font-family: system-ui, sans-serif; margin: 2em; background: #fafafa; color: #333; }
        h1 { font-size: 1.5em; margin-bottom: .5em; }
        a { color: #0073aa; text-decoration: none; }
        a:hover { text-decoration: underline; }
        table { width: 100%; border-collapse: collapse; margin-top: 1em; }
        th, td { padding: .5em; text-align: left; border-bottom: 1px solid #ddd; }
        th { background: #f0f0f0; }
        .breadcrumb { margin-bottom: 1em; font-size: .95em; }
    </style>
</head>
<body>
    <h1>📂 Directory Browser</h1>
    <div class="breadcrumb">
        <a href="/brows/">Home</a>
        <?php if (!empty($breadcrumbs)) echo ' / ' . implode(' / ', $breadcrumbs); ?>
    </div>

    <table>
        <tr><th>Name</th><th>Type</th><th>Size</th></tr>
        <?php foreach ($dirs as $dir): ?>
            <tr>
                <td><a href="<?= htmlspecialchars(basename($dir)) ?>/">📁 <?= htmlspecialchars($dir) ?></a></td>
                <td>Directory</td>
                <td>-</td>
            </tr>
        <?php endforeach; ?>
        <?php foreach ($files as $file): ?>
            <?php $filePath = $path . DIRECTORY_SEPARATOR . $file; ?>
            <tr>
                <td><a href="<?= htmlspecialchars(basename($file)) ?>">📄 <?= htmlspecialchars($file) ?></a></td>
                <td><?= pathinfo($file, PATHINFO_EXTENSION) ?: 'File' ?></td>
                <td><?= number_format(filesize($filePath)) ?> bytes</td>
            </tr>
        <?php endforeach; ?>
    </table>
</body>
</html>
