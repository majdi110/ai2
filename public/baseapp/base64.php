<?php
$input = $_POST['input'] ?? '';
$encoded = '';
if ($input !== '') {
    $encoded = base64_encode($input);
}
?>
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Base64 Encoder</title>
</head>
<body>
<h1>Base64 Encoder</h1>
<form method="POST">
    <textarea name="input" rows="5" cols="50" placeholder="Enter text to encode"><?php echo htmlspecialchars($input); ?></textarea><br>
    <button type="submit">Encode</button>
</form>
<?php if ($encoded): ?>
    <h2>Encoded Result:</h2>
    <textarea rows="5" cols="50" readonly><?php echo $encoded; ?></textarea>
<?php endif; ?>
<p><a href="index.php">Back to Home</a></p>
</body>
</html>
