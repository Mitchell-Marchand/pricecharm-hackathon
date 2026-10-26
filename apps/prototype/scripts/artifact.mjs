// Turns the single-file Vite build into a page fragment for publishing as an Artifact.
// The Artifact host adds its own doctype, html, head and body, so this keeps only the
// title, meta, font links, inline style, root element and inline script.
import { readFileSync, writeFileSync } from 'node:fs';

const html = readFileSync('dist/index.html', 'utf8');
const pick = (pattern, label) => {
  const found = html.match(pattern);
  if (!found) throw new Error(`Build output is missing ${label}.`);
  return found;
};

const title = pick(/<title>[\s\S]*?<\/title>/, 'a title')[0];
const links = html.match(/<link[^>]+fonts\.(?:googleapis|gstatic)\.com[^>]*>/g) ?? [];
const styles = html.match(/<style[^>]*>[\s\S]*?<\/style>/g) ?? [];
const scripts = html.match(/<script type="module"[^>]*>[\s\S]*?<\/script>/g) ?? [];
if (!styles.length || !scripts.length) throw new Error('Build output is missing inline CSS or JS.');

const fragment = [
  title,
  '<meta name="claude:viewport-fit-sides" content="cover">',
  ...links,
  ...styles,
  '<div id="root"></div>',
  ...scripts.map((script) => script.replace(/\s+crossorigin(?:="[^"]*")?/, '')),
].join('\n');

writeFileSync('dist/quotefolk-onboarding.html', fragment);
console.log(`dist/quotefolk-onboarding.html: ${(fragment.length / 1024).toFixed(0)} KB`);
