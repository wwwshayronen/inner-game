const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const src = path.join(root, 'android', 'app', 'src', 'main', 'assets', 'www');
const out = path.join(root, 'desktop', 'www');
const desktopCss = path.join(root, 'desktop', 'desktop.css');

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
fs.cpSync(src, out, { recursive: true });
fs.copyFileSync(desktopCss, path.join(out, 'desktop.css'));

const indexPath = path.join(out, 'index.html');
let html = fs.readFileSync(indexPath, 'utf8');
if (!html.includes('desktop.css')) {
  html = html.replace('</head>', '  <link rel="stylesheet" href="desktop.css" />\n</head>');
}
fs.writeFileSync(indexPath, html);
console.log('Prepared desktop web assets.');
