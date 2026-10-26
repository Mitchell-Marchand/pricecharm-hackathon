(function () {
  'use strict';
  var script = document.currentScript;
  if (!script || !script.dataset.quotient) return;
  var slug = script.dataset.quotient;
  if (!/^[a-z0-9-]+$/.test(slug)) return;
  if (document.getElementById('quotient-widget-' + slug)) return;
  var origin = new URL(script.src).origin;
  var holder = document.createElement('div');
  holder.id = 'quotient-widget-' + slug;
  var root = holder.attachShadow({ mode: 'closed' });
  var style = document.createElement('style');
  style.textContent =
    '*{box-sizing:border-box}.q-button{position:fixed;right:24px;bottom:24px;z-index:2147483000;border:0;border-radius:50px;padding:17px 23px;background:#25362b;color:#f7f9f0;font:600 15px system-ui,sans-serif;cursor:pointer;box-shadow:0 5px 30px #0002;display:flex;align-items:center;gap:12px}.q-button span{color:#dcf48a;font-size:24px;line-height:1}.q-panel{position:fixed;right:24px;bottom:91px;width:min(450px,calc(100vw - 32px));height:min(740px,calc(100dvh - 120px));z-index:2147483000;border:1px solid #d8ddd4;border-radius:20px;overflow:hidden;box-shadow:0 12px 70px #1c2b2530;background:#fff}.q-panel[hidden]{display:none}iframe{width:100%;height:100%;border:0}@media(max-width:500px){.q-panel{right:16px;bottom:85px}.q-button{right:16px;bottom:16px}}';
  var button = document.createElement('button');
  button.className = 'q-button';
  button.type = 'button';
  button.setAttribute('aria-expanded', 'false');
  button.setAttribute('aria-label', 'Open quote request');
  button.innerHTML = '<span aria-hidden="true">✳</span> Request a quote';
  var panel = document.createElement('div');
  panel.className = 'q-panel';
  panel.hidden = true;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Request a quote');
  var frame;
  button.addEventListener('click', function () {
    panel.hidden = !panel.hidden;
    button.setAttribute('aria-expanded', String(!panel.hidden));
    button.setAttribute('aria-label', panel.hidden ? 'Open quote request' : 'Close quote request');
    button.innerHTML = panel.hidden
      ? '<span aria-hidden="true">✳</span> Request a quote'
      : '<span aria-hidden="true">×</span> Close';
    if (!frame && !panel.hidden) {
      frame = document.createElement('iframe');
      frame.title = 'Request a quote';
      frame.src = origin + '/embed/' + encodeURIComponent(slug);
      panel.appendChild(frame);
    }
  });
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && !panel.hidden) button.click();
  });
  root.append(style, panel, button);
  if (document.body) document.body.appendChild(holder);
  else
    document.addEventListener('DOMContentLoaded', function () {
      document.body.appendChild(holder);
    });
})();
