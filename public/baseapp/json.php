<?php
$input = $_POST['json'] ?? '';
$decoded = null;
$error = '';
if ($input !== '') {
    $decoded = json_decode($input, true);
    if (json_last_error() !== JSON_ERROR_NONE) {
        $error = json_last_error_msg();
        $decoded = null;
    }
}
?>
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>JSON Parser</title>
</head>
<body>
<h1>JSON Parser</h1>
<form method="POST">
    <textarea name="json" rows="5" cols="50" placeholder="Enter JSON here"><?php echo htmlspecialchars($input); ?></textarea><br>
    <button type="submit">Parse</button>
</form>
<?php if ($error): ?>
    <p style="color:red;">Error: <?php echo $error; ?></p>
<?php elseif ($decoded !== null): ?>
    <h2>Parsed Output:</h2>
    <pre><?php print_r($decoded); ?></pre>
<?php endif; ?>
<p><a href="index.php">Back to Home</a></p>
</body>
</html>
