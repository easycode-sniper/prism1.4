import fs from 'node:fs';
const html = fs.readFileSync('legacy/index.html', 'utf8');

const cssMatches = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map(m => m[1]);
fs.writeFileSync('src/styles/main.css', cssMatches.join('\n\n'), 'utf8');

const start = html.indexOf('<div id="app-shell">');
const endMark = '<div id="print-summary-area"></div>';
const endIdx = html.indexOf('</div>', html.indexOf(endMark));
fs.writeFileSync('src/shell.html', html.substring(start, endIdx + 6), 'utf8');

console.log('CSS blocks:', cssMatches.length, '| shell bytes:', (html.substring(start, endIdx + 6)).length);
