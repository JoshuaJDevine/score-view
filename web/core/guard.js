// Score View page core: the request guard. Loaded as the first script of the page (web/index.html).
// Every same-origin /api request carries "X-ScoreView: 1". The extension refuses anything but GET without it: other
// web pages cannot add the header without a CORS preflight, which the extension never grants (HttpGuard.java).
// Installed before any module runs, so feature modules keep calling plain fetch().
(function () {
  const orig = window.fetch;
  if (typeof orig !== 'function' || orig.scoreView) return;
  const wrapped = function (input, init) {
    try {
      const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input && input.url;
      const url = new URL(raw, location.href);
      if (url.origin === location.origin && url.pathname.startsWith('/api/')) {
        const headers = new Headers((init && init.headers) || (input instanceof Request ? input.headers : undefined));
        headers.set('X-ScoreView', '1');
        init = Object.assign({}, init, { headers });
      }
    } catch (e) { /* not a URL we know: pass through unchanged */ }
    return orig.call(window, input, init);
  };
  wrapped.scoreView = true;
  window.fetch = wrapped;
})();
