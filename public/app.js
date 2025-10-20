document.addEventListener('DOMContentLoaded', () => {
  const el = document.getElementById('header');
  if (el && !el.querySelector('h1')) {
    el.innerHTML = '<h1>streaming via patch job</h1>';
  }
});

// simple demo: log clicks so you can tell the JS is live
let __clicks = 0;
document.body.addEventListener('click', () => {
  console.log('clicks:', ++__clicks);
