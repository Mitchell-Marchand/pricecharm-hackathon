/*
  PriceCharm website widget.
  <script src="https://…/widget.js" data-pricecharm="your-slug" data-style="floating" async></script>
  data-style="inline" also needs <div data-pricecharm-inline="your-slug"></div> where the section goes.
*/
(function () {
  var script = document.currentScript;
  if (!script) return;
  var slug = script.getAttribute('data-pricecharm') || '';
  if (!/^[a-z0-9-]{1,120}$/.test(slug)) return;
  if (window['__pricecharm_' + slug]) return;
  window['__pricecharm_' + slug] = true;
  var style = script.getAttribute('data-style') === 'inline' ? 'inline' : 'floating';
  var origin = new URL(script.src, location.href).origin;

  var css =
    ':host{all:initial}' +
    '*{box-sizing:border-box;font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}' +
    '.launch{position:fixed;right:20px;bottom:20px;z-index:2147483000;display:inline-flex;align-items:center;gap:8px;height:48px;padding:0 20px;border:0;border-radius:999px;background:#101633;color:#fff;font-size:15px;font-weight:600;cursor:pointer;box-shadow:0 2px 6px rgb(16 22 51/.08),0 22px 44px -16px rgb(16 22 51/.36)}' +
    '.launch:hover{opacity:.92}.launch:focus-visible,.start:focus-visible{outline:3px solid #2d4bef;outline-offset:3px}' +
    '.launch svg,.start svg{width:18px;height:18px}' +
    '.panel{position:fixed;right:20px;bottom:84px;z-index:2147483001;width:400px;height:min(720px,calc(100vh - 108px));border-radius:16px;overflow:hidden;background:#fff;box-shadow:0 2px 6px rgb(16 22 51/.08),0 22px 44px -16px rgb(16 22 51/.36);display:none}' +
    '.panel.solo{bottom:20px;height:min(720px,calc(100vh - 40px))}' +
    '.panel.open{display:block}.panel iframe{width:100%;height:100%;border:0;display:block}' +
    '@media (max-width:520px){.panel{inset:0;width:auto;height:auto;border-radius:0}.panel.open~.launch{display:none}}' +
    '.card{display:block;max-width:560px;padding:20px;border:1px solid #dce1ea;border-radius:12px;background:#fff;color:#101633;box-shadow:0 1px 2px rgb(16 22 51/.06),0 2px 8px rgb(16 22 51/.05)}' +
    '.card h2{margin:0;font-size:18px;line-height:1.3;font-weight:700}' +
    '.card p{margin:6px 0 0;font-size:15px;line-height:1.5;color:#5e6684}' +
    '.start{margin-top:16px;display:inline-flex;align-items:center;gap:8px;height:44px;padding:0 18px;border:0;border-radius:8px;background:#101633;color:#fff;font-size:15px;font-weight:600;cursor:pointer}' +
    '.start{text-decoration:none}.start:hover{opacity:.92}' +
    '.fallback{position:absolute;inset:0;display:flex;flex-direction:column;align-items:flex-start;justify-content:center;padding:32px;background:#fff;color:#101633}' +
    '.fallback h2{margin:0;font-size:20px;font-weight:700}.fallback p{margin:8px 0 0;font-size:15px;line-height:1.5;color:#5e6684}' +
    '.x{position:absolute;top:12px;right:12px;width:40px;height:40px;border:0;border-radius:999px;background:none;color:#5e6684;font-size:24px;line-height:1;cursor:pointer}.x:hover{background:#f6f7fb;color:#101633}';
  var receipt =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z"/><path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8"/><path d="M12 17.5v-11"/></svg>';

  function mount(host) {
    var root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
    var sheet = document.createElement('style');
    sheet.textContent = css;
    root.appendChild(sheet);
    return root;
  }

  // The chat itself lives in a frame on the floating layer, loaded the first time it opens.
  var layer = document.createElement('div');
  layer.setAttribute('data-pricecharm-layer', slug);
  var layerRoot = mount(layer);
  var panel = document.createElement('div');
  // With no floating button below it, the panel can sit lower.
  var panelClass = style === 'inline' ? 'panel solo' : 'panel';
  panel.className = panelClass;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Get a quote');
  layerRoot.appendChild(panel);
  var frame = null;
  var opener = null;
  var loaded = false;
  var fallback = null;

  // If the chat doesn't load (the site isn't the one the business listed, or the network is
  // down), offer the quote page in a new tab instead of a blank panel.
  function showFallback() {
    if (loaded || fallback) return;
    fallback = document.createElement('div');
    fallback.className = 'fallback';
    fallback.innerHTML =
      '<button type="button" class="x" aria-label="Close">&times;</button><h2>Get your quote</h2><p>The quote form opens in a new tab.</p>';
    var link = document.createElement('a');
    link.className = 'start';
    link.href = origin + '/q/' + slug;
    link.target = '_blank';
    link.rel = 'noopener';
    link.innerHTML = receipt + '<span>Open the quote form</span>';
    fallback.appendChild(link);
    fallback.querySelector('.x').addEventListener('click', close);
    panel.appendChild(fallback);
  }

  function open(from) {
    opener = from || null;
    if (!frame) {
      frame = document.createElement('iframe');
      frame.src = origin + '/embed/' + slug;
      frame.title = 'Get a quote';
      frame.allow = 'clipboard-write';
      panel.appendChild(frame);
      setTimeout(showFallback, 6000);
    }
    panel.className = panelClass + ' open';
    if (launch) launch.setAttribute('aria-expanded', 'true');
    setTimeout(function () {
      frame.focus();
    }, 50);
  }
  function close() {
    panel.className = panelClass;
    if (launch) launch.setAttribute('aria-expanded', 'false');
    if (opener) opener.focus();
  }

  var launch = null;
  if (style === 'floating') {
    launch = document.createElement('button');
    launch.type = 'button';
    launch.className = 'launch';
    launch.setAttribute('aria-expanded', 'false');
    launch.innerHTML = receipt + '<span>Get a quote</span>';
    launch.addEventListener('click', function () {
      if (panel.className.indexOf('open') > -1) close();
      else open(launch);
    });
    layerRoot.appendChild(launch);
  }

  function addInline() {
    var spots = document.querySelectorAll('[data-pricecharm-inline]');
    for (var i = 0; i < spots.length; i++) {
      var spot = spots[i];
      if (spot.getAttribute('data-pricecharm-inline') !== slug || spot.shadowRoot) continue;
      var root = mount(spot);
      var card = document.createElement('div');
      card.className = 'card';
      card.innerHTML =
        '<h2>Get a quote in about 2 minutes</h2><p>Tell us about the job and add a photo.</p>';
      var start = document.createElement('button');
      start.type = 'button';
      start.className = 'start';
      start.innerHTML = receipt + '<span>Start my quote</span>';
      start.addEventListener('click', function (event) {
        open(event.currentTarget);
      });
      card.appendChild(start);
      root.appendChild(card);
    }
  }

  window.addEventListener('message', function (event) {
    if (event.origin !== origin || !frame || event.source !== frame.contentWindow) return;
    if (!event.data) return;
    if (event.data.type === 'pricecharm:close') close();
    if (event.data.type === 'pricecharm:ready') {
      loaded = true;
      if (fallback) fallback.remove();
      fallback = null;
    }
  });
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && panel.className.indexOf('open') > -1) close();
  });

  function ready() {
    document.body.appendChild(layer);
    if (style === 'inline') addInline();
  }
  if (document.body) ready();
  else document.addEventListener('DOMContentLoaded', ready);
})();
