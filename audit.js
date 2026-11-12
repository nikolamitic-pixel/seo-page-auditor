/*!
 * SEO Page Auditor (bookmarklet payload)
 * Runs entirely client-side in the developer's browser. No server, no Lighthouse.
 * See SPEC.md in this project for the full rule list and rationale.
 */
(function seoAuditorMain() {
  'use strict';

  if (window.__SeoAuditorRunning) {
    console.warn('[SeoAuditor] Already running.');
    return;
  }
  window.__SeoAuditorRunning = true;

  // HEADLESS mode (30.10.2026): the per-device pass loads the same page in hidden same-origin frames
  // (mobile / tablet / desktop widths) and runs only the viewport-dependent checks there, without a panel.
  // The frame gets this very script (seoAuditorMain.toString()) and window.__SeoAuditorHeadless = true.
  var HEADLESS = !!window.__SeoAuditorHeadless;
  var SELF_SRC = null;
  try { SELF_SRC = seoAuditorMain.toString(); } catch (e) {}
  // The page's address. In a frame the document is about:srcdoc, so the parent passes the real location.
  var LOC = (HEADLESS && window.__SeoAuditorLoc) || window.location;
  // Every network request of the audit goes through this wrapper (it shadows the global fetch inside this
  // script only; the page's own fetches are untouched). It counts requests in flight, so the panel can say
  // "analysis in progress" until the images / links / robots checks have really finished.
  var auditPending = 0;
  var fetch = function () {
    auditPending++;
    var pr;
    try { pr = window.fetch.apply(window, arguments); } catch (e) { auditPending--; throw e; }
    var dn = function () { auditPending--; };
    pr.then(dn, dn);
    return pr;
  };
  if (HEADLESS) window.__SeoAuditorHeadlessPending = function () { return auditPending; };

  // ---------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------

  var findings = [];
  var findingId = 0;

  function addFinding(f) {
    f.id = 'f' + (++findingId);
    f.severity = f.severity || 'warning'; // 'error' | 'warning' | 'info'
    f.category = f.category || 'Other';
    f.group = f.group || 'seo'; // 'seo' | 'aeo' — which tab in the panel shows this finding
    if (f.element && f.element.nodeType === 1 && f.element !== document.body && !f.hiddenUi) {
      var hk = hiddenUiKind(f.element);          // 'tab' | 'accordion' | ... when the element is in a closed UI container
      if (hk && hk !== 'hidden') f.hiddenUi = hk;
    }
    findings.push(f);
    return f;
  }

  // Parallel list to addFinding() — records checks that PASSED (no issue found), so the
  // user can see in the "Success" tab what's actually correct on the page, not just what's
  // broken. Deliberately kept separate from `findings` (not mixed with error/warning/info
  // severity logic) because "success" has no severity level — a check either passes or it
  // doesn't.
  var successes = [];
  var successId = 0;

  function addSuccess(f) {
    f.id = 's' + (++successId);
    f.category = f.category || 'Other';
    f.group = f.group || 'seo'; // 'seo' | 'aeo' — informational only, currently not used for filtering in the Success tab
    successes.push(f);
    return f;
  }

  // ---------------------------------------------------------------------
  // i18n (EN / SR) — added 29.10.2026
  // ---------------------------------------------------------------------
  // English is the SOURCE language: every check writes its English text exactly as before (the
  // scoring registry matches on the English titles). Serbian is applied ONLY when rendering the
  // panel / report, by looking the English text up in a dictionary (srDictData(), at the bottom of
  // the file). Dictionary keys with {0},{1}... are templates for strings that contain runtime
  // values (numbers, URLs, tag names) — they are matched with a regex and the captured values
  // are put back into the Serbian text. A line that has no translation is shown in English and
  // listed in window.__SeoAuditorUntranslated (so gaps are visible, never silent).
  var LANG_KEY = 'seoAuditorLang';
  var LANG = 'en';
  try { LANG = localStorage.getItem(LANG_KEY) === 'sr' ? 'sr' : 'en'; } catch (e) { LANG = 'en'; }
  var SR_EXACT = null, SR_TPL = null;
  window.__SeoAuditorUntranslated = [];

  function buildSr() {
    if (SR_EXACT) return;
    var d = srDictData();
    SR_EXACT = {}; SR_TPL = [];
    Object.keys(d).forEach(function (k) {
      if (!/\{\d+\}/.test(k)) { SR_EXACT[k] = d[k]; return; }
      var order = [];
      var src = k.split(/(\{\d+\})/).map(function (part) {
        var m = /^\{(\d+)\}$/.exec(part);
        if (m) { order.push(parseInt(m[1], 10)); return '([\\s\\S]*?)'; }
        return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      }).join('');
      SR_TPL.push({ key: k, re: new RegExp('^' + src + '$'), order: order, sr: d[k], lit: k.replace(/\{\d+\}/g, '').length });
    });
    SR_TPL.sort(function (a, b) { return b.lit - a.lit; }); // most specific template first
  }
  function srLookup(s, quiet) {
    if (Object.prototype.hasOwnProperty.call(SR_EXACT, s)) return SR_EXACT[s];
    if (s.indexOf('\n') !== -1) return s.split('\n').map(function (l) { return srLookup(l, quiet); }).join('\n');
    for (var i = 0; i < SR_TPL.length; i++) {
      var t = SR_TPL[i], m = t.re.exec(s);
      if (!m) continue;
      return t.sr.replace(/\{(\d+)\}/g, function (x, n) {
        var idx = t.order.indexOf(parseInt(n, 10));
        return idx === -1 ? x : srLookup(m[idx + 1], !window.__SeoAuditorI18nStrict); // captured values may themselves be English phrases
      });
    }
    if (s.indexOf('; ') !== -1) { // several reasons joined with "; " (see reportCheckSkipped)
      var parts = s.split('; ').map(function (x) { return srLookup(x, quiet); });
      return parts.join('; ');
    }
    if (!quiet && /[A-Za-z]{3,}\s+[A-Za-z]{2,}\s+[A-Za-z]{2,}/.test(s) && !/^https?:\/\//.test(s) && window.__SeoAuditorUntranslated.indexOf(s) === -1) {
      window.__SeoAuditorUntranslated.push(s);
    }
    return s;
  }
  // Translate a (possibly multi-line) English string for display; returns it unchanged in EN mode.
  function tr(s) {
    if (LANG !== 'sr' || !s || typeof s !== 'string') return s;
    buildSr();
    return srLookup(s, false);
  }
  // Translate a UI template with {0},{1}... placeholders and fill in the values.
  function trf(key, vals) {
    var base = key;
    if (LANG === 'sr') { buildSr(); if (Object.prototype.hasOwnProperty.call(SR_EXACT, key)) base = SR_EXACT[key]; else { var hit = SR_TPL.filter(function (t) { return t.key === key; })[0]; if (hit) base = hit.sr; } }
    return base.replace(/\{(\d+)\}/g, function (x, n) { var v = vals[parseInt(n, 10)]; return v === undefined ? x : v; });
  }
  // Serbian noun forms for counts: 1 / 2-4 / 5+ (11-14 take the "many" form).
  function srPlural(n, one, few, many) {
    var a = n % 10, b = n % 100;
    if (a === 1 && b !== 11) return one;
    if (a >= 2 && a <= 4 && (b < 12 || b > 14)) return few;
    return many;
  }
  function setLang(l) {
    LANG = l === 'sr' ? 'sr' : 'en';
    try { localStorage.setItem(LANG_KEY, LANG); } catch (e) {}
    if (reportPreviewVisible) reportPreviewText = buildReportText();
    renderPanel();
  }

  function text(el) {
    return (el && (el.innerText || el.textContent) || '').trim();
  }

  // 12.11.2026: start state of a scroll-in animation. Animation scripts (Webflow Interactions, GSAP "autoAlpha") hide
  // an element with inline style="opacity: 0; visibility: hidden" until it scrolls into view. Verified on honeybook.com:
  // the "Grow on the go" section has that inline style at load and is visible (opacity 1) once scrolled to, so it is
  // content, not hidden text. Only the inline combination counts; visibility:hidden from a class is still hidden.
  function animStartHidden(el) {
    for (var p = el; p && p.nodeType === 1; p = p.parentElement) {
      var v = p.style && p.style.visibility;
      if (v === 'hidden') return parseFloat(p.style.opacity) === 0;
      if (v) return false;
    }
    return false;
  }
  function isVisible(el) {
    // 12.11.2026: nodeType, not "instanceof Element". In the per-device frames the page's nodes can come from another
    // JS realm than this script's Element (verified on honeybook.com: H1 visible at 337x108 px, but instanceof false),
    // which made every element look invisible -> e.g. "H1 is missing" only on mobile/tablet.
    if (!el || el.nodeType !== 1) return false;
    var style = window.getComputedStyle(el);
    if (style.display === 'none' || (style.visibility === 'hidden' && !animStartHidden(el))) return false;
    var rect = el.getBoundingClientRect();
    return rect.width > 0 || rect.height > 0;
  }

  // Tracking pixel (06.11.2026): an <img> that analytics / ad scripts add only to send a hit, sized to 0 or 1 px in
  // both directions (width/height attributes or inline style). Not page content: some endpoints answer
  // "204 No Content" on purpose (verified: bat.bing.com/action/0 on honeybook.com), which the browser reports as an
  // image error. Skipped by every image check.
  function isTrackingPixel(img) {
    function tiny(attr, css) {
      var a = img.getAttribute(attr);
      if (a !== null && a.trim() !== '' && parseFloat(a) <= 1) return true;
      var s = img.style && img.style[css];
      return !!s && /^\s*[01](\.0+)?px\s*$/i.test(s);
    }
    return tiny('width', 'width') && tiny('height', 'height');
  }

  // ---------------------------------------------------------------------
  // Hidden-but-reachable UI (30.10.2026): tabs, accordions, <details>, dropdowns, collapsed menus,
  // sliders and popups are not visible at page load, but their content is real (visitors reach it
  // with one click, crawlers read it). hiddenUiKind() says WHY an element is not visible:
  //   null        -> it is visible
  //   'tab' | 'accordion' | 'dropdown' | 'menu' | 'slider' | 'popup' -> hidden only because a UI container is closed
  //   'hidden'    -> hidden by design / by breakpoint / never shown (conditional CMS visibility, honeypots,
  //                  "hide on desktop" utility classes...) — NOT checked here (the per-device pass covers breakpoints)
  // ---------------------------------------------------------------------
  var UI_KINDS = [
    ['popup', '[role="dialog"], [aria-modal="true"], .w-lightbox-backdrop, [class*="popup" i], [class*="modal" i], [class*="lightbox" i], [class*="drawer" i]'],
    ['tab', '.w-tab-pane, [role="tabpanel"], [class*="tabs" i], [class*="tab_" i], [class*="tab-" i]'],
    ['accordion', '[class*="accordion" i], [class*="collapse" i], [class*="expand" i], [class*="faq" i], [class*="toggle" i]'],
    ['dropdown', '.w-dropdown-list, [class*="dropdown" i]'],
    // 12.11.2026: no longer [class*="navbar"] — that matched the whole navbar wrapper, so a block hidden by design inside it
    // (honeybook.com: a promo banner switched off with a "display-none" class) was reported as a "collapsed menu".
    ['menu', '.w-nav-menu, [role="menu"], [role="menubar"], nav, [role="navigation"], [class*="menu" i]'],
    ['slider', '.w-slide, .w-slider, [class*="slide" i], [class*="carousel" i]']
  ];
  var CONTENT_UI_KINDS = ['tab', 'accordion', 'dropdown', 'slider'];   // real page content (no popups / menus)
  // A visible-looking element can still be collapsed: clipped by an ancestor that has overflow:hidden and zero height
  // (the classic Webflow accordion: the answer is "height: 0px; overflow: hidden").
  function zeroHeightClipper(el) {
    var p = el.parentElement, n = 0;
    while (p && p !== document.body && n++ < 10) {
      var st = window.getComputedStyle(p);
      if ((st.overflow !== 'visible' || st.overflowY !== 'visible') && p.getBoundingClientRect().height === 0) return p;
      p = p.parentElement;
    }
    return null;
  }
  function hiddenUiKind(el) {
    try {
      if (!el || el.nodeType !== 1) return null;
      var det = el.closest('details');
      if (det && !det.open && !el.closest('summary')) return 'accordion';   // closed <details> (Chrome keeps a box for its content)
      var hider = null;
      if (isVisible(el)) {
        hider = zeroHeightClipper(el);
        if (!hider) return null;
      } else {
        var p = el;
        while (p && p !== document.documentElement) {
          var st = window.getComputedStyle(p);
          if (st.display === 'none' || st.visibility === 'hidden') { hider = p; break; }
          p = p.parentElement;
        }
        if (!hider) return 'hidden';
      }
      if (hider.closest('.w-condition-invisible, .w-dyn-hide')) return 'hidden';
      for (var i = 0; i < UI_KINDS.length; i++) {
        if (hider.closest(UI_KINDS[i][1])) return UI_KINDS[i][0];
      }
      if (hider.id) {
        var ctrl = document.querySelector('[aria-controls~="' + String(hider.id).replace(/"/g, '\\"') + '"]');
        if (ctrl && (ctrl.hasAttribute('aria-expanded') || ctrl.hasAttribute('aria-selected'))) return ctrl.getAttribute('role') === 'tab' ? 'tab' : 'accordion';
      }
      if (isVisible(el)) return 'accordion';   // collapsed by clipping, no recognisable container: still a closed block
    } catch (e) {}
    return 'hidden';
  }
  // Visible, or hidden only because a UI container (of one of the given kinds) is closed.
  function isReachable(el, kinds) {
    if (isVisible(el)) return true;
    var k = hiddenUiKind(el);
    return !!k && k !== 'hidden' && (!kinds || kinds.indexOf(k) !== -1);
  }

  function sameHost(url, host) {
    try {
      return new URL(url, LOC.href).hostname === host;
    } catch (e) {
      return false;
    }
  }

  function hostnameOf(url) {
    try {
      return new URL(url, LOC.href).hostname;
    } catch (e) {
      return null;
    }
  }

  // Webflow has changed its asset CDN domain over time (uploads-ssl.webflow.com ->
  // assets.website-files.com -> assets-global.website-files.com -> cdn.prod.website-files.com...).
  // Instead of a fixed list, we match any *.website-files.com subdomain plus known legacy domains.
  var WEBFLOW_ASSET_HOST_SUFFIXES = ['website-files.com'];
  var WEBFLOW_ASSET_HOSTS_EXACT = ['uploads-ssl.webflow.com', 'daks2k3a4ib2z.cloudfront.net'];

  // Same site = same registrable domain (cdn.example.com / images.example.com are NOT "external"
  // for example.com). Simple heuristic: last two labels, or last three for co.uk-style suffixes.
  function rootDomain(h) {
    var p = String(h || '').toLowerCase().split('.');
    if (p.length <= 2) return p.join('.');
    var sld = p[p.length - 2];
    if (p[p.length - 1].length === 2 && ['co', 'com', 'org', 'net', 'gov', 'ac', 'edu'].indexOf(sld) !== -1) return p.slice(-3).join('.');
    return p.slice(-2).join('.');
  }
  function isSameSite(host) {
    return !!host && rootDomain(host) === rootDomain(LOC.hostname);
  }

  function isWebflowAssetHost(host) {
    if (!host) return false;
    if (WEBFLOW_ASSET_HOSTS_EXACT.indexOf(host) !== -1) return true;
    return WEBFLOW_ASSET_HOST_SUFFIXES.some(function (suffix) {
      return host === suffix || host.slice(-(suffix.length + 1)) === '.' + suffix;
    });
  }

  function fmtBytes(n) {
    if (n == null) return 'unknown';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / (1024 * 1024)).toFixed(2) + ' MB';
  }

  function closestLandmark(el) {
    return el && el.closest ? el.closest('nav, header, footer') : null;
  }

  // ---------------------------------------------------------------------
  // 5.0 Preliminary URL check
  // ---------------------------------------------------------------------

  function checkPreliminary() {
    try {
      var navEntries = performance.getEntriesByType('navigation');
      var nav = navEntries && navEntries[0];
      if (nav && nav.redirectCount > 0) {
        addFinding({
          category: 'Preliminary check',
          severity: 'info',
          title: 'Page was loaded via a redirect',
          description: 'The browser followed ' + nav.redirectCount + ' redirect(s) before arriving at: ' + LOC.href,
          why: 'If this is unexpected, the results reflect the final page, not the URL you may have originally opened.',
          fix: 'Check whether the redirect is intentional.',
          element: null
        });
      }
    } catch (e) { /* Navigation Timing L2 not supported */ }

    // Staging detection
    if (/\.webflow\.io$/.test(LOC.hostname)) {
      addFinding({
        category: 'Preliminary check',
        severity: 'info',
        title: 'This is a Webflow staging link',
        description: 'The domain ' + LOC.hostname + ' is a Webflow staging subdomain.',
        why: 'Findings here do not affect the score, but it is recommended to also check the live domain before publishing.',
        fix: 'Run the audit on the live domain once it is ready.',
        element: null,
        stagingNotice: true
      });
    }
  }

  // ---------------------------------------------------------------------
  // 5.1 Meta & head tags
  // ---------------------------------------------------------------------

  function getMeta(name, attr) {
    attr = attr || 'name';
    var el = document.querySelector('meta[' + attr + '="' + name + '"]');
    return el ? el.getAttribute('content') : null;
  }

  function checkMetaHead() {
    var charsetMeta = document.querySelector('meta[charset]') || document.querySelector('meta[http-equiv="Content-Type" i]');
    if (!charsetMeta) {
      addFinding({ category: 'Meta & head tags', severity: 'warning', title: 'Meta charset declaration is missing',
        description: 'There is no <meta charset="..."> in the head.', why: 'The character encoding must be declared: a <meta charset> within the first 1024 bytes of the HTML, a charset in the Content-Type HTTP header, or a byte-order mark. Without it, the browser doesn\'t know which character each byte represents and may show characters incorrectly.',
        fix: 'Webflow adds this automatically — check that custom code in the <head> hasn\'t accidentally removed or moved the tag.', element: document.head });
    } else {
      var charsetVal = charsetMeta.hasAttribute('charset') ? charsetMeta.getAttribute('charset') : (charsetMeta.getAttribute('content') || '');
      if (!/utf-8/i.test(charsetVal)) {
        addFinding({ category: 'Meta & head tags', severity: 'warning', title: 'Meta charset is not UTF-8',
          description: 'Value found: "' + charsetVal + '".', why: 'HTML allows only UTF-8: the value of <meta charset> must be "utf-8".',
          fix: 'Set the charset to UTF-8.', element: document.head });
      } else {
        addSuccess({ category: 'Meta & head tags', title: 'Meta charset is present and set to UTF-8', description: '', element: document.head });
      }
    }

    // Only HTML <title> elements: inline SVGs (logos, icons) carry their own <title> for accessibility, which is not a page title.
    var titleTags = Array.prototype.filter.call(document.querySelectorAll('title'), function (t) { return t.namespaceURI !== 'http://www.w3.org/2000/svg'; });
    if (titleTags.length > 1) {
      addFinding({ category: 'Meta & head tags', severity: 'warning', title: 'More than one <title> tag in the head (' + titleTags.length + ')',
        description: Array.prototype.map.call(titleTags, function (t) { return '"' + t.textContent + '"'; }).join(', '),
        why: 'A page may have only one <title>. Usually a second <title> was added in custom code next to the one Webflow outputs.',
        fix: 'Remove all but one <title> tag — set the title in Pages panel > Page settings > SEO settings > Title tag, not manually in custom code.', element: document.head });
    }

    var descTags = document.querySelectorAll('meta[name="description" i]');
    if (descTags.length > 1) {
      addFinding({ category: 'Meta & head tags', severity: 'warning', title: 'More than one meta description tag (' + descTags.length + ')',
        description: Array.prototype.map.call(descTags, function (m) { return '"' + (m.getAttribute('content') || '') + '"'; }).join(' | '),
        why: 'A page may have only one meta description. Usually one comes from Page settings and another from custom code.',
        fix: 'Remove all but one meta description tag.', element: document.head });
    }

    var title = document.title || '';
    var titleLengthOk = false;
    if (!title.trim()) {
      addFinding({ category: 'Meta & head tags', severity: 'error', title: 'Title tag is missing or empty',
        description: 'The <title> is empty.', why: 'Google uses the <title> as the clickable headline of the result in search, and it is often the main thing people read before deciding to click.',
        fix: 'Add a unique, descriptive title in Pages panel > Page settings > SEO settings > Title tag (Webflow recommends under 60 characters).', element: document.head });
    } else if (title.length > 60) {
      addFinding({ category: 'Meta & head tags', severity: 'warning', title: 'Title is too long (' + title.length + ' characters)',
        description: 'Title: "' + title + '"', why: 'There is no hard limit on title length, but Google shortens the title in search results to fit the screen width. Keeping it under 60 characters keeps the whole title visible.',
        fix: 'Shorten the title to 60 characters or fewer, with the most important words first.', element: document.head });
    } else if (title.length < 30) {
      addFinding({ category: 'Meta & head tags', severity: 'warning', title: 'Title is very short (' + title.length + ' characters)',
        description: 'Title: "' + title + '"', why: 'A title under 30 characters usually doesn\'t describe the page well. (Google shortens titles by display width, not by character count.)',
        fix: 'Expand the title to better describe the page content.', element: document.head });
    } else {
      titleLengthOk = true;
    }
    var isPlaceholderTitle = /^(untitled|home|page \d+|lorem ipsum)$/i.test(title.trim());
    if (isPlaceholderTitle) {
      addFinding({ category: 'Meta & head tags', severity: 'error', title: 'Title looks like a placeholder',
        description: 'Title: "' + title + '"', why: 'This looks like a Webflow default value that hasn\'t been replaced.',
        fix: 'Set a real, descriptive title.', element: document.head });
    }
    if (titleLengthOk && !isPlaceholderTitle) {
      addSuccess({ category: 'Meta & head tags', title: 'Title tag is present and of optimal length (' + title.length + ' characters)',
        description: 'Title: "' + title + '"', element: document.head });
    }

    var desc = getMeta('description');
    if (!desc || !desc.trim()) {
      addFinding({ category: 'Meta & head tags', severity: 'error', title: 'Meta description is missing',
        description: 'There is no meta description tag, or it is empty.', why: 'Google sometimes shows the meta description as the text under the result in search; without one, that text is taken from the page content only.',
        fix: 'Add a meta description of 70–155 characters in Pages panel > Page settings > SEO settings > Meta description.', element: document.head });
    } else if (desc.length < 70) {
      addFinding({ category: 'Meta & head tags', severity: 'info', title: 'Meta description is short (' + desc.length + ' characters)',
        description: desc, why: 'A meta description under 70 characters usually doesn\'t describe the page well. Google often builds the snippet from the page content anyway, so this is a suggestion, not an error.',
        fix: 'Expand it to at least 70 characters so it describes the page.', element: document.head });
    } else if (desc.length > 155) {   // Screaming Frog: Meta Description Over 155 Characters (06.11.2026)
      addFinding({ category: 'Meta & head tags', severity: 'warning', title: 'Meta description is too long (' + desc.length + ' characters)',
        description: desc, why: 'There is no hard limit on meta description length, but Google shortens the snippet to fit the screen width; over 155 characters the end is usually cut off.', fix: 'Shorten it to 155 characters or fewer.', element: document.head });
    } else {
      addSuccess({ category: 'Meta & head tags', title: 'Meta description is present and of appropriate length (' + desc.length + ' characters)',
        description: desc, element: document.head });
    }

    var ogTitle = getMeta('og:title', 'property');
    var ogDesc = getMeta('og:description', 'property');
    var ogImage = getMeta('og:image', 'property');
    if (!ogTitle) {
      addFinding({ category: 'Meta & head tags', severity: 'warning', title: 'og:title is missing',
        description: 'There is no Open Graph title tag.', why: 'og:title is the title of the link preview on Facebook, LinkedIn and other platforms that read Open Graph tags; X also falls back to it when twitter:title is missing.',
        fix: 'Add it in Pages panel > Page settings > Open Graph settings > Open Graph title (or check the box under the field to copy the SEO title).', element: document.head });
    } else {
      addSuccess({ category: 'Meta & head tags', title: 'og:title is present', description: ogTitle, element: document.head });
    }
    if (!ogDesc) {
      addFinding({ category: 'Meta & head tags', severity: 'warning', title: 'og:description is missing',
        description: 'There is no Open Graph description tag.', why: 'Without it, the link preview on social media has no description.',
        fix: 'Add it in Pages panel > Page settings > Open Graph settings > Open Graph description (or check the box under the field to copy the meta description).', element: document.head });
    } else {
      addSuccess({ category: 'Meta & head tags', title: 'og:description is present', description: ogDesc, element: document.head });
    }

    if (!ogImage) {
      addFinding({ category: 'Meta & head tags', severity: 'warning', title: 'og:image is missing',
        description: 'There is no Open Graph image.', why: 'Links without an OG image look bare when shared on social media.',
        fix: 'Add it in Pages panel > Page settings > Open Graph settings > Open Graph image (an image link or an image from the Assets panel; use at least 1200×630 px, ratio 1.91:1). On a Collection page choose an Image field.', element: document.head });
    } else {
      addSuccess({ category: 'Meta & head tags', title: 'og:image is present', description: ogImage, element: document.head });
      checkOgImage(ogImage);
    }

    var twitterCard = getMeta('twitter:card');
    if (!twitterCard) {
      addFinding({ category: 'Meta & head tags', severity: 'warning', title: 'Twitter/X Card meta tag (twitter:card) is missing',
        description: 'There is no <meta name="twitter:card">.', why: 'Without twitter:card, X can still show a preview from the Open Graph tags, but only as the small card, not the large-image card. twitter:card chooses the card type.',
        fix: 'Add <meta name="twitter:card" content="summary_large_image"> (and ideally twitter:title/twitter:image) via Custom Code in the head section.', element: document.head });
    } else {
      addSuccess({ category: 'Meta & head tags', title: 'Twitter/X Card meta tag is present (' + twitterCard + ')', description: '', element: document.head });
    }

    // Only a canonical inside <head> counts: Google accepts the rel="canonical" link element only there (one written
    // after an element that isn't allowed in <head> lands in <body> — see checkCanonicalValid).
    var canonical = canonicalLinks(document).filter(inHeadOf(document))[0] || null;
    var canonicalOutside = canonical ? null : (canonicalLinks(document)[0] || null);
    if (!canonical || !(canonical.getAttribute('href') || '').trim()) {
      addFinding({ category: 'Meta & head tags', severity: 'warning', title: 'Canonical tag is missing',
        description: canonical ? 'The <link rel="canonical"> is there, but its href is empty.'
          : (canonicalOutside ? 'There is a <link rel="canonical"> (href: ' + (canonicalOutside.getAttribute('href') || '') + '), but it is outside <head>, where Google ignores it. ' + HEAD_PARSE_NOTE : 'There is no <link rel="canonical">.'), why: 'A canonical is not strictly required, but a canonical that points to the page itself is the recommended setup. Without it, Google decides on its own which URL is the main one.',
        fix: 'Add a canonical tag pointing to this page. ' + CANON_FIX, element: document.head });
    } else {
      checkCanonicalDuplication(canonical);
    }

    var robots = getMeta('robots');
    // "none" is the shorthand for noindex+nofollow; a bot-specific <meta name="googlebot"> with noindex blocks Google just the same.
    var googlebotMeta = getMeta('googlebot') || '';
    var robotsNoindex = function (v) { return /(^|[\s,;])(noindex|none)(\s|,|;|$)/i.test(v || ''); };
    if (robots && robotsNoindex(robots) || robotsNoindex(googlebotMeta)) {
      addFinding({ category: 'Meta & head tags', severity: 'error', title: 'Page is marked as noindex',
        description: robotsNoindex(robots) ? 'meta robots = "' + robots + '"' : 'meta googlebot = "' + googlebotMeta + '"', why: 'This page will not be indexed by Google as long as this remains in place.',
        fix: 'If the page should be visible in search: in Webflow, Page settings > SEO settings > turn "Sitemap indexing" back on (turned off, it adds <meta name="robots" content="noindex">); for a CMS item: the Collection item > Item details > Sitemap indexing. A noindex can also come from custom code (Page settings > Custom code > Inside <head> tag, or Site settings > Custom code > Head code). Publish after the change.', element: document.head,
        crossRelevant: true, crossNote: 'Relevant to both SEO and AEO — to be shown as a source in Google\'s AI Overviews or AI Mode, a page must be indexed and allowed to show a snippet.',
        crossNoteReverse: 'Relevant to both SEO and AEO — noindex tells Google not to show the page in search results.' });
    } else {
      addSuccess({ category: 'Meta & head tags', title: 'Page is not marked as noindex', description: '', element: document.head,
        crossRelevant: true, crossNote: 'Relevant to both SEO and AEO — to be shown as a source in Google\'s AI Overviews or AI Mode, a page must be indexed and allowed to show a snippet.',
        crossNoteReverse: 'Relevant to both SEO and AEO — the page is indexable and can appear in Google search.' });
    }

    var blocksSnippet = robots && (/nosnippet/i.test(robots) || /max-snippet:\s*0\b/i.test(robots));
    if (blocksSnippet) {
      addFinding({ category: 'Meta & head tags', severity: 'error', title: 'Robots directive blocks the content snippet (nosnippet/max-snippet:0)',
        description: 'meta robots = "' + robots + '"',
        why: 'nosnippet tells Google not to show a text snippet or video preview for this page, and the content is then not used as a direct source for AI Overviews and AI Mode (max-snippet:0 has the same effect on the text).',
        fix: 'Remove "nosnippet" and "max-snippet:0" from the meta robots tag, unless it\'s intentional (e.g. a page with sensitive content).', element: document.head,
        crossRelevant: true, crossNote: 'Relevant to both SEO and AEO — with nosnippet the content is not used as a direct source for AI Overviews and AI Mode.',
        crossNoteReverse: 'Relevant to both SEO and AEO — the Google result for this page is shown without a text snippet.' });
    } else {
      addSuccess({ category: 'Meta & head tags', title: 'Robots directive does not block the content snippet', description: '', element: document.head,
        crossRelevant: true, crossNote: 'Relevant to both SEO and AEO — Google may show a snippet of this page and use its content in AI Overviews / AI Mode.',
        crossNoteReverse: 'Relevant to both SEO and AEO — the page can have a normal description/snippet in Google search results.' });
    }

    var htmlLang = document.documentElement.getAttribute('lang');
    if (!htmlLang) {
      addFinding({ category: 'Meta & head tags', severity: 'info', noScore: true, title: 'lang attribute is missing on <html>',
        description: '<html> has no lang attribute.', why: 'Google doesn\'t use the lang attribute, but screen readers do: they read the text in the language set here, so it is an accessibility requirement. This is an accessibility issue, so it is listed as a note and does not affect the score.',
        fix: 'Set the site\'s language code in Webflow: Settings panel > Localization (or the globe icon in the top bar > Localization settings) — choose the primary locale\'s language (and optionally country), save and publish.', element: document.documentElement });
    } else {
      addSuccess({ category: 'Meta & head tags', title: 'lang attribute is present on <html> (' + htmlLang + ')', description: '', element: document.documentElement });
    }

    var viewport = document.querySelector('meta[name="viewport"]');
    if (!viewport) {
      addFinding({ category: 'Meta & head tags', severity: 'error', title: 'Viewport meta tag is missing',
        description: 'There is no <meta name="viewport">.', why: 'Without a viewport meta tag, phones render the page at desktop width and then shrink it, so the text is hard to read.',
        fix: 'Webflow usually adds this automatically — check that custom code hasn\'t removed the tag.', element: document.head });
    } else {
      addSuccess({ category: 'Meta & head tags', title: 'Viewport meta tag is present', description: '', element: document.head });
      var vpContent = viewport.getAttribute('content') || '';
      // user-scalable=no / 0, or maximum-scale below 2 (the threshold of axe / Lighthouse; WCAG 1.4.4 asks for zoom to 200%).
      var vpMaxScale = /maximum-scale\s*=\s*([0-9.]+)/i.exec(vpContent);
      if (/user-scalable\s*=\s*(no|0)\b/i.test(vpContent) || (vpMaxScale && parseFloat(vpMaxScale[1]) < 2)) {
        addFinding({ category: 'Meta & head tags', severity: 'info', noScore: true, title: 'Viewport prevents the user from zooming',
          description: 'viewport = "' + vpContent + '"', why: 'Blocking zoom (user-scalable=no or maximum-scale below 2) prevents people with low vision from enlarging the page on a phone; for accessibility, zooming to at least 200% must be possible. This is an accessibility issue, so it is listed as a note and does not affect the score.',
          fix: 'Remove user-scalable=no from the viewport tag and remove maximum-scale (or set it to at least 2).', element: document.head });
      } else {
        addSuccess({ category: 'Meta & head tags', title: 'Viewport allows the user to zoom the page', description: '', element: document.head });
      }
    }
  }

  function checkOgImage(ogImageUrl) {
    var ext = (ogImageUrl.split('?')[0].split('.').pop() || '').toLowerCase();
    // 06.11.2026: X's Cards docs list "JPG, PNG, WEBP and GIF" as supported and say "SVG is not supported";
    // Facebook's sharing docs list no formats. WebP is therefore no longer flagged (it was, without a source).
    if (ext === 'avif' || ext === 'svg') {
      addFinding({ category: 'Meta & head tags', severity: 'warning', title: 'OG image is in a format X does not list as supported (' + ext.toUpperCase() + ')',
        description: 'og:image: ' + ogImageUrl, why: 'X supports JPG, PNG, WEBP and GIF images in link previews; SVG is not supported and AVIF is not on its list, so the preview on X can end up without an image.',
        fix: 'Use a JPG or PNG (or WebP) image as the OG image: Pages panel > Page settings > Open Graph settings > Open Graph image.', element: null });
    }
    var img = new Image();
    img.onload = function () {
      // 06.11.2026: Facebook — "at least 1080 pixels in width for best display", "At the minimum ... 600 pixels in width";
      // X large-image card — "minimum dimensions of 300x157". (Old 600x315 / 1200x630 thresholds had no source.)
      if (img.naturalWidth < 600 || img.naturalHeight < 157) {
        addFinding({ category: 'Meta & head tags', severity: 'warning', title: 'OG image is too small (' + img.naturalWidth + 'x' + img.naturalHeight + ')',
          description: 'og:image: ' + ogImageUrl, why: 'For a sharp preview, Facebook needs an image at least 600 px wide and ideally 1080 px or more; X\'s large-image card needs at least 300x157 px.',
          fix: 'Replace it in Pages panel > Page settings > Open Graph settings > Open Graph image with an image of at least 1200×630 px (ratio 1.91:1).', element: null });
      }
      renderPanel();
    };
    img.onerror = function () {
      addFinding({ category: 'Meta & head tags', severity: 'error', title: 'OG image fails to load',
        description: 'og:image URL returns an error: ' + ogImageUrl, why: 'A broken OG image means an empty preview on social media.',
        fix: 'Check that the URL is correct and that the file exists.', element: null });
      renderPanel();
    };
    img.src = ogImageUrl;

    try {
      fetch(ogImageUrl, { method: 'HEAD' }).then(function (r) {
        var len = r.headers.get('content-length');
        // 06.11.2026: X — "Images must be less than 5MB in size". (Old 300KB / WhatsApp claim had no official source.)
        if (len && parseInt(len, 10) >= 5 * 1024 * 1024) {
          addFinding({ category: 'Meta & head tags', severity: 'warning', title: 'OG image is larger than X\'s 5 MB limit (' + fmtBytes(parseInt(len, 10)) + ')',
            description: 'og:image: ' + ogImageUrl, why: 'X doesn\'t show card images of 5 MB or more, so the preview on X can end up without an image.',
            fix: 'Use a smaller file (compress it, or export it smaller while keeping it at least 1080 px wide) and set it again in Page settings > Open Graph settings.', element: null });
          renderPanel();
        }
      }).catch(function () { /* CORS - ignore silently */ });
    } catch (e) {}
  }

  // ---------------------------------------------------------------------
  // 5.1b Favicon
  // ---------------------------------------------------------------------
  // Shared robots.txt reader (05.11.2026) — used for the favicon, for this page (Googlebot) and for AI search crawlers.
  // Parsing and matching follow Google's "How Google interprets the robots.txt specification" and RFC 9309:
  //  - a group = consecutive user-agent lines + the rules after them; other fields (sitemap, crawl-delay...) are
  //    ignored and do not end a group; rules before the first user-agent line and rules without a path are ignored;
  //  - the crawler uses the group(s) whose product token matches (case-insensitive, "googlebot/1.2" = "googlebot"),
  //    all such groups combined; only if none matches, the "*" group(s);
  //  - the matching rule with the longest path wins; on a tie the least restrictive (allow) wins;
  //    "*" = any characters, a trailing "$" = end of URL; paths are case-sensitive and compared percent-encoded;
  //  - 4xx (except 429) = no robots.txt = no restrictions; 5xx/429 = server error; only the first 500 KiB are read.
  var robotsTxtPromise = null;
  function getRobotsTxt() {
    if (!robotsTxtPromise) {
      robotsTxtPromise = fetch(LOC.origin + '/robots.txt', { cache: 'no-store', credentials: 'same-origin' }).then(function (r) {
        if (r.ok) return r.text().then(function (t) { return { status: r.status, text: t }; });
        return { status: r.status, text: null };
      }).catch(function () { return { error: CSP_OR_NETWORK }; });
    }
    return robotsTxtPromise;
  }
  function parseRobotsTxt(txt) {
    try {
      var bytes = new TextEncoder().encode(txt);
      if (bytes.length > 512000) txt = new TextDecoder().decode(bytes.slice(0, 512000));
    } catch (e) {}
    txt = txt.replace(/^﻿/, '');
    var groups = [], cur = null, inAgents = false;
    txt.split(/\r\n|\r|\n/).forEach(function (line) {
      line = line.replace(/#.*$/, '').trim();
      var m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
      if (!m) return;                                   // invalid line: ignored
      var field = m[1].toLowerCase(), value = m[2].trim();
      if (field === 'user-agent') {
        if (!cur || !inAgents) { cur = { agents: [], rules: [] }; groups.push(cur); }
        inAgents = true;
        cur.agents.push(value === '*' ? '*' : ((/^[A-Za-z_-]+/.exec(value) || [''])[0].toLowerCase()));
        return;
      }
      if (field === 'allow' || field === 'disallow') {
        inAgents = false;
        if (!cur || !value) return;                     // rule outside any group, or rule without a path: ignored
        cur.rules.push({ allow: field === 'allow', path: value });
      }
      // sitemap / crawl-delay / unknown fields: ignored, they don't end the group
    });
    return groups;
  }
  function robotsNormPath(p) {
    // RFC 9309 2.2.2: compare percent-encoded forms (non-ASCII is percent-encoded; %XX of an unreserved character is decoded)
    p = p.replace(/[^\x00-\x7F]+/g, function (x) { try { return encodeURIComponent(x); } catch (e) { return x; } });
    return p.replace(/%([0-9a-fA-F]{2})/g, function (m, h) {
      var c = String.fromCharCode(parseInt(h, 16));
      return /[A-Za-z0-9\-._~]/.test(c) ? c : '%' + h.toUpperCase();
    });
  }
  // -> { group: 'googlebot' | '*' | null, blocked: bool, rule: 'Disallow: /x' | null }
  function robotsVerdict(groups, token, target) {
    var rules = [], group = null;
    groups.forEach(function (g) { if (g.agents.indexOf(token) > -1) { rules = rules.concat(g.rules); group = token; } });
    if (!group) groups.forEach(function (g) { if (g.agents.indexOf('*') > -1) { rules = rules.concat(g.rules); group = '*'; } });
    var url = robotsNormPath(target), best = null;
    rules.forEach(function (r) {
      var rp = robotsNormPath(r.path);
      var anchored = rp.charAt(rp.length - 1) === '$';
      var body = anchored ? rp.slice(0, -1) : rp;
      var re;
      try { re = new RegExp('^' + body.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + (anchored ? '$' : '')); } catch (e) { return; }
      if (!re.test(url)) return;
      if (!best || rp.length > best.len || (rp.length === best.len && r.allow && !best.allow)) {
        best = { len: rp.length, allow: r.allow, line: (r.allow ? 'Allow: ' : 'Disallow: ') + r.path };
      }
    });
    return { group: group, blocked: !!(best && !best.allow), rule: best ? best.line : null };
  }

  // Google Search Central ("Define a favicon to show in search results", checked 05.11.2026): the favicon must be
  // a square (1:1) of at least 8x8px, Google recommends larger than 48x48px, supported formats are BMP, GIF, ICO,
  // PNG, JPEG, PPM and TIFF, supported rel values are icon / shortcut icon / apple-touch-icon(-precomposed), and
  // Googlebot-Image must be allowed to crawl the file. Not a ranking factor (search-result appearance), hence
  // "warning" at most.
  var FAVICON_FIX_WEBFLOW = 'In Webflow: Site settings > General tab > Icons — upload one square image (PNG is safest). Webflow then generates the 32x32 and 48x48 favicons, 180x180 and 192x192 touch icons and a 256x256 webclip by itself (Webflow update, May 2026), so upload at least 256x256px — then no generated size is enlarged from a smaller image. Publish the site afterwards.';
  function checkFavicon() {
    var head = document.head;
    var iconLinks = Array.prototype.filter.call(document.querySelectorAll('link[rel][href]'), function (l) {
      return /(^|\s)(icon|apple-touch-icon|apple-touch-icon-precomposed)(\s|$)/i.test(l.getAttribute('rel') || '');
    });
    var linkEl = iconLinks.filter(function (l) { return /(^|\s)icon(\s|$)/i.test(l.getAttribute('rel')); })[0] || iconLinks[0] || null;
    var faviconUrl;
    try {
      faviconUrl = (linkEl && linkEl.getAttribute('href')) ? new URL(linkEl.getAttribute('href'), LOC.href).href : (LOC.origin + '/favicon.ico');
    } catch (e) {
      faviconUrl = LOC.origin + '/favicon.ico';
    }
    var iconUrls = [];
    iconLinks.forEach(function (l) { try { var u = new URL(l.getAttribute('href'), LOC.href).href; if (iconUrls.indexOf(u) === -1) iconUrls.push(u); } catch (e) {} });
    if (!iconUrls.length) iconUrls.push(faviconUrl);

    function reportBroken() {
      addFinding({ category: 'Favicon', severity: 'warning', title: 'Favicon is missing or fails to load',
        description: linkEl ? ('A <link> tag was found, but the resource (' + faviconUrl + ') does not load.') : ('There is no <link rel="icon"> in the head, and no fallback /favicon.ico exists either.'),
        why: 'Google Search can show a site\'s favicon next to its search results; when it has no usable favicon, Google shows a generic icon instead.',
        fix: FAVICON_FIX_WEBFLOW, element: linkEl || head });
    }

    // Only declared icons with a recognizable file extension are judged ("https://cdn.example.com/favicon" has none);
    // the dimensions are measured only on icons Google Search can use (supported or unknown format).
    var GOOGLE_FORMATS = ['bmp', 'gif', 'ico', 'png', 'jpg', 'jpeg', 'ppm', 'tif', 'tiff'];
    var extOf = function (u) {
      if (/^data:/i.test(u)) return '';
      try { var fp = new URL(u).pathname.split('/').pop() || ''; return fp.indexOf('.') > -1 ? fp.split('.').pop().toLowerCase() : ''; } catch (e) { return ''; }
    };
    var usableUrls = iconUrls.filter(function (u) { var x = extOf(u); return !x || GOOGLE_FORMATS.indexOf(x) > -1; });
    function checkFormat() {
      if (usableUrls.length) return;
      var exts = iconUrls.map(extOf).filter(function (x, i, a) { return x && a.indexOf(x) === i; });
      addFinding({ category: 'Favicon', severity: 'info', title: 'Favicon is not in a format Google Search supports (' + exts.join(', ').toUpperCase() + ')',
        description: iconUrls.join('\n'), why: 'Google Search supports these favicon formats: BMP, GIF, ICO, PNG, JPEG, PPM and TIFF. An SVG (or WebP) favicon works in browsers, but Google Search can\'t use it, so the result may show a generic icon.',
        fix: 'Also provide a PNG or ICO favicon. ' + FAVICON_FIX_WEBFLOW + ' (Webflow converts an SVG upload to PNG.)', element: linkEl || head });
    }

    function checkDimensions() {
      if (!usableUrls.length) return;                   // reported by checkFormat()
      var sizes = [], left = Math.min(usableUrls.length, 8);
      var done = function () {
        if (--left > 0) return;
        if (!sizes.length) return;                       // nothing could be measured
        var squares = sizes.filter(function (z) { return Math.abs(z.w - z.h) <= 1 && z.w >= 8; });
        var largest = squares.sort(function (a, b) { return b.w - a.w; })[0];
        var list = sizes.map(function (z) { return z.w + 'x' + z.h; }).join(', ');
        if (!largest) {
          addFinding({ category: 'Favicon', severity: 'warning', title: 'Favicon dimensions do not meet Google\'s requirement (square, at least 8x8px): ' + list,
            description: usableUrls.join('\n'), why: 'Google Search shows a favicon only if it is a square (1:1 aspect ratio) of at least 8x8px. None of the icons declared on this page is.',
            fix: FAVICON_FIX_WEBFLOW, element: linkEl || head });
        } else if (largest.w <= 48) {
          addFinding({ category: 'Favicon', severity: 'info', title: 'Favicon dimensions: no icon is larger than 48x48px (largest: ' + largest.w + 'x' + largest.h + ')',
            description: usableUrls.join('\n'), why: 'Google Search requires at least 8x8px, but recommends a favicon larger than 48x48px so it looks good on various surfaces.',
            fix: FAVICON_FIX_WEBFLOW, element: linkEl || head });
        } else {
          addSuccess({ category: 'Favicon', title: 'Favicon is square and larger than 48x48px (' + largest.w + 'x' + largest.h + ')', description: largest.url, element: linkEl || head });
        }
        renderPanel();
      };
      usableUrls.slice(0, 8).forEach(function (u) {
        var img = new Image();
        img.onload = function () { if (img.naturalWidth && img.naturalHeight) sizes.push({ w: img.naturalWidth, h: img.naturalHeight, url: u }); done(); };
        img.onerror = function () { done(); };   // the HEAD fetch already reports a favicon that doesn't exist
        img.src = u;
      });
    }

    function checkRobotsBlock(url) {
      var u;
      try { u = new URL(url); } catch (e) { return; }
      if (u.origin !== LOC.origin) return;               // a favicon on a CDN is governed by the CDN's own robots.txt, which the browser can't read here
      getRobotsTxt().then(function (res) {
        if (res.error || res.text == null) return;       // no robots.txt (4xx) = no restrictions; errors are reported by the page robots check
        var v = robotsVerdict(parseRobotsTxt(res.text), 'googlebot-image', u.pathname + u.search);
        if (v.blocked) {
          addFinding({ category: 'Favicon', severity: 'warning', title: 'Favicon is blocked in robots.txt',
            description: 'The path "' + u.pathname + '" is blocked by "' + v.rule + '" (group: User-agent: ' + v.group + ').',
            why: 'Google must be able to crawl the favicon file (it must not be blocked in robots.txt for Googlebot-Image), otherwise it can\'t show it in search results.',
            fix: 'In Webflow: Site settings > SEO > Indexing — change the robots.txt rules so they don\'t cover the favicon path (add an Allow rule for it or narrow the Disallow rule), save and publish.', element: null });
          renderPanel();
        }
      });
    }

    checkFormat();
    try {
      fetch(faviconUrl, { method: 'HEAD' }).then(function (r) {
        if (!r.ok) { reportBroken(); renderPanel(); return; }
        var ct = r.headers.get('content-type') || '';
        if (ct && ct.indexOf('image') === -1 && ct.indexOf('icon') === -1) { reportBroken(); renderPanel(); return; }
        addSuccess({ category: 'Favicon', title: 'Favicon is present and loads successfully', description: faviconUrl, element: linkEl || head });
        checkDimensions();
        checkRobotsBlock(faviconUrl);
        renderPanel();
      }).catch(function () {
        // A favicon on another host (e.g. the Webflow CDN) usually refuses a cross-origin HEAD request: no error is
        // reported for that — the dimensions are still measured (if the image loads at all).
        checkDimensions();
      });
    } catch (e) {}
  }

  function checkCanonicalDuplication(canonicalEl) {
    var href = canonicalEl.getAttribute('href');
    if (!href) return;
    var canonicalUrl;
    try { canonicalUrl = new URL(href, LOC.href); } catch (e) { return; }

    var curPath = LOC.pathname.replace(/\/$/, '');
    var canPath = canonicalUrl.pathname.replace(/\/$/, '');
    var bare = function (h) { return String(h).replace(/^www\./i, '').toLowerCase(); };

    if (canonicalUrl.hostname !== LOC.hostname && bare(canonicalUrl.hostname) !== bare(LOC.hostname)) {
      // Another domain entirely: right for syndicated content, wrong for the page's own canonical.
      addFinding({ category: 'URL & page duplication', severity: 'warning',
        title: 'Canonical points to a different domain',
        description: 'Current page: ' + LOC.hostname + curPath + ' | Canonical: ' + canonicalUrl.hostname + canPath,
        why: 'The canonical tells Google that another website holds the main version of this page. rel="canonical" is a strong signal to Google, so this page may be left out of the results in favour of that one. That is right for deliberately syndicated content, but wrong when it is a leftover from a template, a staging copy or another site.',
        fix: 'If it is not intentional, make the canonical point to this page\'s own URL. ' + CANON_FIX, element: canonicalEl });
    } else if (canonicalUrl.hostname !== LOC.hostname || canonicalUrl.protocol !== LOC.protocol) {
      // Same site, but the www / non-www or http / https variant differs from the one that is open.
      addFinding({ category: 'URL & page duplication', severity: 'warning',
        title: 'Canonical points to a different host or protocol version',
        description: 'Current page: ' + LOC.protocol + '//' + LOC.hostname + curPath + ' | Canonical: ' + canonicalUrl.protocol + '//' + canonicalUrl.hostname + canPath,
        why: 'The canonical names the www / non-www or http / https variant that is not the one this page was opened on. rel="canonical" is a strong signal to Google to prefer that other variant, which is only right if the site redirects to it.',
        fix: 'Make the canonical, the site\'s default domain and the redirects agree on one variant. In Webflow the default domain is set in Site settings > Publishing tab > Production > Make default; visitors on the other domain are then redirected to it.', element: canonicalEl });
    } else if (canonicalUrl.hostname === LOC.hostname && canPath !== curPath) {
      addFinding({ category: 'URL & page duplication', severity: 'error',
        title: 'Canonical points to a different path on the same site',
        description: 'Current page: ' + curPath + ' | Canonical: ' + canPath,
        why: 'This happens for example when a page is duplicated in Webflow and the canonical is left pointing at the original. rel="canonical" is a strong signal to Google to prefer that other URL over this page.',
        fix: 'Check whether this is intentional. If not, make the canonical point to this page. ' + CANON_FIX, element: canonicalEl });
    } else {
      addSuccess({ category: 'URL & page duplication', title: 'Canonical tag is present and points to this page',
        description: 'Canonical: ' + canPath, element: canonicalEl });
    }
  }

  // ---------------------------------------------------------------------
  // 5.3c Group A (05.11.2026): robots.txt for this page, canonical validity, original vs rendered HTML,
  // meta refresh, hreflang. The source of every rule is quoted in SPEC.md (05.11.2026).
  // ---------------------------------------------------------------------
  // Code lists from the Debian iso-codes package 4.16 (ISO 639-1: 184 languages, ISO 3166-1 alpha-2: 249 regions,
  // ISO 15924: 182 scripts). hreflang: language ISO 639-1 + optional region ISO 3166-1 alpha-2 (Google / Lighthouse).
  var ISO_639_1 = 'aa ab ae af ak am an ar as av ay az ba be bg bh bi bm bn bo br bs ca ce ch co cr cs cu cv cy da de dv dz ee el en eo es et eu fa ff fi fj fo fr fy ga gd gl gn gu gv ha he hi ho hr ht hu hy hz ia id ie ig ii ik io is it iu ja jv ka kg ki kj kk kl km kn ko kr ks ku kv kw ky la lb lg li ln lo lt lu lv mg mh mi mk ml mn mr ms mt my na nb nd ne ng nl nn no nr nv ny oc oj om or os pa pi pl ps pt qu rm rn ro ru rw sa sc sd se sg si sk sl sm sn so sq sr ss st su sv sw ta te tg th ti tk tl tn to tr ts tt tw ty ug uk ur uz ve vi vo wa wo xh yi yo za zh zu'.split(' ');
  var ISO_3166_1 = 'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'.split(' ');
  var ISO_15924 = 'Adlm Afak Aghb Ahom Arab Aran Armi Armn Avst Bali Bamu Bass Batk Beng Bhks Blis Bopo Brah Brai Bugi Buhd Cakm Cans Cari Cham Cher Cirt Copt Cprt Cyrl Cyrs Deva Dsrt Dupl Egyd Egyh Egyp Elba Ethi Geok Geor Glag Goth Gran Grek Gujr Guru Hanb Hang Hani Hano Hans Hant Hatr Hebr Hira Hluw Hmng Hrkt Hung Inds Ital Jamo Java Jpan Jurc Kali Kana Khar Khmr Khoj Kitl Kits Knda Kore Kpel Kthi Lana Laoo Latf Latg Latn Leke Lepc Limb Lina Linb Lisu Loma Lyci Lydi Mahj Mand Mani Marc Maya Mend Merc Mero Mlym Modi Mong Moon Mroo Mtei Mult Mymr Narb Nbat Newa Nkgb Nkoo Nshu Ogam Olck Orkh Orya Osge Osma Palm Pauc Perm Phag Phli Phlp Phlv Phnx Piqd Plrd Prti Qaaa Qabx Rjng Roro Runr Samr Sara Sarb Saur Sgnw Shaw Shrd Sidd Sind Sinh Sora Sund Sylo Syrc Syre Syrj Syrn Tagb Takr Tale Talu Taml Tang Tavt Telu Teng Tfng Tglg Thaa Thai Tibt Tirh Ugar Vaii Visp Wara Wole Xpeo Xsux Yiii Zinh Zmth Zsye Zsym Zxxx Zyyy Zzzz'.split(' ');

  // The page's ORIGINAL HTML (what the server sends, before any JavaScript runs) — fetched once and shared.
  var rawDocPromise = null;
  function getRawDoc() {
    if (!rawDocPromise) {
      rawDocPromise = fetch(LOC.href, { cache: 'no-store', credentials: 'same-origin' }).then(function (r) {
        if (!r.ok) return { error: 'the server answered HTTP ' + r.status + ' to the request for the original HTML' };
        var refreshHeader = r.headers.get('refresh') || '';
        return r.text().then(function (t) {
          // DOMParser builds an inert document: nothing in it loads or runs (innerHTML on a detached <div> would still start
          // downloading every <img> and fire its onload handlers on the live site).
          return { html: t, doc: new DOMParser().parseFromString(t, 'text/html'), refreshHeader: refreshHeader };
        });
      }).catch(function () { return { error: CSP_OR_NETWORK }; });
    }
    return rawDocPromise;
  }
  function absUrl(h, base) { try { return new URL(h, base || LOC.href).href; } catch (e) { return null; } }
  // protocol + host + path without a trailing slash (query and fragment ignored) — "is this the same page?"
  function pageKey(u, base) { try { var x = new URL(u, base || LOC.href); return x.protocol + '//' + x.hostname.toLowerCase() + x.pathname.replace(/\/+$/, ''); } catch (e) { return null; } }
  function inHeadOf(doc) { return function (el) { return !!(doc.head && doc.head.contains(el)); }; }
  // rel="canonical" links Google uses: annotations with hreflang, lang, media or type attributes are not used for canonicalization.
  function canonicalLinks(doc) {
    return Array.prototype.filter.call(doc.querySelectorAll('link[rel]'), function (l) {
      if (!/(^|\s)canonical(\s|$)/i.test(l.getAttribute('rel') || '')) return false;
      return !(l.hasAttribute('hreflang') || l.hasAttribute('lang') || l.hasAttribute('media') || l.hasAttribute('type'));
    });
  }
  function docNoindexTag(doc) {
    var hit = null;
    Array.prototype.forEach.call(doc.querySelectorAll('meta[name]'), function (m) {
      var n = (m.getAttribute('name') || '').toLowerCase();
      if ((n === 'robots' || n === 'googlebot') && /(^|[\s,;])(noindex|none)(\s|,|;|$)/i.test(m.getAttribute('content') || '')) {
        hit = hit || ('<meta name="' + n + '" content="' + m.getAttribute('content') + '">');
      }
    });
    return hit;
  }
  var CUSTOM_CODE_PLACES = 'custom code (Page settings > Custom code > Inside <head> tag, or Site settings > Custom code > Head code)';
  var CANON_FIX = 'In Webflow the canonical comes from Site settings > SEO > Global canonical URL (the site\'s base URL, e.g. https://www.yourdomain.com, without a trailing slash — Webflow adds each page\'s slug) or, for one static page, from Page settings > SEO settings > Page canonical URL (a full URL starting with https://). Any other canonical comes from ' + CUSTOM_CODE_PLACES + ' or from a tool such as Google Tag Manager — Webflow advises not to set the global canonical tag when another tool injects it. Publish after the change.';
  var HEAD_PARSE_NOTE = 'A tag written in the head custom code can still end up in <body>: when an element that isn\'t allowed in <head> (for example a <div>, <img>, <p> or plain text) comes before it, the browser closes <head> early and everything after it lands in <body>.';

  // A1 — is THIS page blocked in robots.txt for Googlebot / for AI search crawlers?
  var AI_SEARCH_BOTS = [
    { token: 'oai-searchbot', name: 'OAI-SearchBot (ChatGPT search)' },
    { token: 'perplexitybot', name: 'PerplexityBot (Perplexity)' },
    { token: 'claude-searchbot', name: 'Claude-SearchBot (Claude search)' },
    { token: 'claude-user', name: 'Claude-User (Claude fetching pages for users)' }
  ];
  function checkRobotsForPage() {
    var CAT = 'Technical / crawlability';
    var target = LOC.pathname + LOC.search;
    var stagingNote = /\.webflow\.io$/.test(LOC.hostname)
      ? ' This is the webflow.io staging domain: with "Staging indexing" turned off, Webflow publishes a robots.txt on the staging subdomain that tells search engines to ignore it — expected here; check the live domain.' : '';
    var ROBOTS_FIX = 'In Webflow: Site settings > SEO > Indexing — edit the robots.txt rules (also check the Traffic control toggles there, which generate robots.txt rules for known bots), save and publish. A page blocked in robots.txt still stays in Webflow\'s auto-generated sitemap.';
    var NOTE = 'Relevant to both SEO and AEO — a page Google can\'t crawl can\'t be used as a source for AI Overviews / AI Mode either.';
    getRobotsTxt().then(function (res) {
      if (res.error) { reportCheckSkipped('robots.txt check for this page', [res.error]); renderPanel(); return; }
      if (res.text == null && (res.status >= 500 || res.status === 429)) {
        addFinding({ check: 'crawl.robots', category: CAT, severity: 'error', title: 'robots.txt answers HTTP ' + res.status,
          description: LOC.origin + '/robots.txt',
          why: 'When robots.txt can\'t be fetched because of a server error (5xx or 429), Google stops crawling the site for the first 12 hours and then uses the last good version of the file for up to 30 days; other crawlers may treat the whole site as blocked while robots.txt is unreachable.',
          fix: 'Make /robots.txt answer HTTP 200. On Webflow hosting the file is generated from Site settings > SEO > Indexing; if a proxy or CDN sits in front of the site, the error comes from there.',
          ownerNote: 'If a proxy / CDN (e.g. Cloudflare) sits in front of the site, whoever manages it has to fix the response.', element: null });
        renderPanel(); return;
      }
      var noFile = res.text == null;                    // 4xx (except 429) = no robots.txt = no restrictions
      var groups = noFile ? [] : parseRobotsTxt(res.text);
      var g = robotsVerdict(groups, 'googlebot', target);
      if (g.blocked) {
        addFinding({ check: 'crawl.robots', category: CAT, severity: 'error', title: 'Page is blocked in robots.txt for Googlebot',
          description: 'Path: ' + target + '\nRule: ' + g.rule + ' (group: User-agent: ' + g.group + ')',
          why: 'Google can\'t crawl this page, so it can\'t read its content. A page blocked in robots.txt can still appear in search results (for example when other sites link to it), but without a description; and AI Overviews / AI Mode can only use pages that may be crawled.' + stagingNote,
          fix: ROBOTS_FIX, element: null, crossRelevant: true, crossNote: NOTE, crossNoteReverse: NOTE });
      } else {
        addSuccess({ check: 'crawl.robots', category: CAT, title: 'Page is not blocked in robots.txt for Googlebot',
          description: noFile ? 'There is no robots.txt (HTTP ' + res.status + '), so there are no crawl restrictions.'
            : (g.rule ? 'Applicable rule: ' + g.rule + ' (group: User-agent: ' + g.group + ')'
              : (g.group ? 'No rule in the applicable group (User-agent: ' + g.group + ') covers this path.' : 'No group in robots.txt applies to Googlebot.')),
          element: null, crossRelevant: true, crossNote: NOTE, crossNoteReverse: NOTE });
      }
      var blockedAi = [];
      AI_SEARCH_BOTS.forEach(function (b) {
        var v = robotsVerdict(groups, b.token, target);
        if (v.blocked) blockedAi.push(b.name + ': ' + v.rule + ' (group: User-agent: ' + v.group + ')');
      });
      if (blockedAi.length) {
        addFinding({ check: 'aeo.robots', group: 'aeo', category: CAT, severity: 'warning',
          title: 'Page is blocked in robots.txt for AI search crawlers (' + blockedAi.length + ' of ' + AI_SEARCH_BOTS.length + ')',
          description: blockedAi.join('\n'),
          why: 'OpenAI uses OAI-SearchBot to show websites in ChatGPT search, Perplexity uses PerplexityBot to surface and link pages in its answers, and blocking Claude-SearchBot or Claude-User can reduce a site\'s visibility in Claude\'s search results. (The training crawlers GPTBot and ClaudeBot are not checked — blocking them only opts out of AI training.) If blocking these crawlers is a deliberate decision, this note can be ignored.' + stagingNote,
          fix: ROBOTS_FIX, element: null });
      } else {
        addSuccess({ check: 'aeo.robots', group: 'aeo', category: CAT, title: 'Page is not blocked in robots.txt for AI search crawlers',
          description: AI_SEARCH_BOTS.map(function (b) { return b.name; }).join(', '), element: null });
      }
      renderPanel();
    });
  }

  // A2 — is the canonical tag itself valid (one, absolute, in <head>, no fragment)?
  function checkCanonicalValid() {
    var all = canonicalLinks(document);
    var CK = 'meta.canonicalValid', CAT = 'URL & page duplication', problems = 0;
    var tagText = function (l) { return '<link rel="canonical" href="' + (l.getAttribute('href') || '') + '">'; };
    var inHead = all.filter(inHeadOf(document));
    var outside = all.filter(function (l) { return inHead.indexOf(l) === -1; });
    // No canonical in <head> = Google sees none: "Canonical tag is missing" reports it (and names a stray one in <body>).
    if (!inHead.length) return;
    if (outside.length) {
      problems++;
      addFinding({ check: CK, category: CAT, severity: 'warning', title: 'Canonical tag is outside <head> (' + outside.length + ')',
        description: outside.map(tagText).join('\n'),
        why: 'A rel="canonical" link counts only inside the <head> of the HTML — this extra one is ignored, but it shows that the head code has a problem. ' + HEAD_PARSE_NOTE,
        fix: 'Move the canonical into <head> and remove from the head code above it anything that isn\'t allowed in <head> (only <title>, <meta>, <link>, <style>, <script>, <noscript>, <base> and <template> belong there). ' + CANON_FIX,
        element: outside[0] });
    }
    if (inHead.length > 1) {
      problems++;
      var urls = [];
      inHead.forEach(function (l) { var u = absUrl(l.getAttribute('href') || ''); if (u && urls.indexOf(u) === -1) urls.push(u); });
      if (urls.length > 1) {
        addFinding({ check: CK, category: CAT, severity: 'error', title: 'More than one canonical tag, with different URLs (' + inHead.length + ')',
          description: inHead.map(tagText).join('\n'),
          why: 'Several different rel="canonical" tags can lead to unexpected results — there should be only one.',
          fix: 'Keep exactly one canonical. ' + CANON_FIX, element: inHead[1] });
      } else {
        addFinding({ check: CK, category: CAT, severity: 'warning', title: 'Canonical tag appears ' + inHead.length + ' times (same URL)',
          description: inHead.map(tagText).join('\n'),
          why: 'There should be only one rel="canonical" tag on the page, even if they agree. Usually one comes from the Webflow settings and another from custom code.',
          fix: 'Remove the extra canonical. ' + CANON_FIX, element: inHead[1] });
      }
    }
    var relative = inHead.filter(function (l) { var h = (l.getAttribute('href') || '').trim(); return h && !/^https?:\/\//i.test(h); });
    if (relative.length) {
      problems++;
      addFinding({ check: CK, category: CAT, severity: 'warning', title: 'Canonical uses a relative URL (' + (relative[0].getAttribute('href') || '').trim().slice(0, 80) + ')',
        description: relative.map(tagText).join('\n'),
        why: 'Use an absolute URL in rel="canonical", not a relative path. Relative paths work, but can cause problems later (for example, if a testing site gets crawled).',
        fix: 'Use a full URL starting with https://. ' + CANON_FIX, element: relative[0] });
    }
    var frag = inHead.filter(function (l) { return (l.getAttribute('href') || '').indexOf('#') > -1; });
    if (frag.length) {
      problems++;
      addFinding({ check: CK, category: CAT, severity: 'warning', title: 'Canonical URL contains a fragment (#)',
        description: frag.map(tagText).join('\n'),
        why: 'Don\'t use a URL with a #fragment as canonical — Google generally ignores URL fragments.',
        fix: 'Remove the #... part from the canonical URL. ' + CANON_FIX, element: frag[0] });
    }
    if (!problems) addSuccess({ check: CK, category: CAT, title: 'Canonical tag is valid (one absolute URL, in <head>)', description: tagText(inHead[0]), element: inHead[0] });
  }

  // A3 — does JavaScript change what the original HTML says about noindex / canonical?
  function checkOriginalVsRendered() {
    var CK = 'crawl.jsMismatch', CAT = 'Technical / crawlability';
    getRawDoc().then(function (raw) {
      if (raw.error) { reportCheckSkipped('Original vs rendered HTML check', [raw.error]); renderPanel(); return; }
      var issues = 0;
      var rawNoindex = docNoindexTag(raw.doc), liveNoindex = docNoindexTag(document);
      if (rawNoindex && !liveNoindex) {
        issues++;
        addFinding({ check: CK, category: CAT, severity: 'error', title: 'noindex is in the original HTML but removed by JavaScript',
          description: 'Original HTML: ' + rawNoindex + '\nAfter JavaScript: no noindex',
          why: 'When Google sees noindex in the original HTML, it may skip running JavaScript, so a script that removes noindex may never take effect. If the page should be indexed, don\'t put noindex in the original page code.',
          fix: 'Remove the noindex from the original HTML and remove the script that deletes it. In Webflow, Page settings > SEO settings > "Sitemap indexing" turned off is what adds <meta name="robots" content="noindex"> — turn it on (for a CMS item: the Collection item > Item details > Sitemap indexing); a noindex can also come from ' + CUSTOM_CODE_PLACES + '. Publish.',
          element: null });
      }
      var rawC = canonicalLinks(raw.doc).filter(inHeadOf(raw.doc)).map(function (l) { return absUrl(l.getAttribute('href') || ''); }).filter(Boolean);
      var liveC = canonicalLinks(document).filter(inHeadOf(document)).map(function (l) { return absUrl(l.getAttribute('href') || ''); }).filter(Boolean);
      if (rawC.length && liveC.length && rawC[0] !== liveC[0]) {
        issues++;
        addFinding({ check: CK, category: CAT, severity: 'error', title: 'Canonical in the original HTML differs from the canonical after JavaScript',
          description: 'Original HTML: ' + rawC[0] + '\nAfter JavaScript: ' + liveC[0],
          why: 'JavaScript shouldn\'t change the canonical to a different URL than the one in the original HTML — if a script sets it, it must set the same value.',
          fix: 'Find the script that changes the canonical (custom code, Google Tag Manager or another tool) and stop it, so only one source sets the canonical. ' + CANON_FIX,
          element: null });
      }
      if (!issues) {
        addSuccess({ check: CK, category: CAT, title: 'Original HTML and the page after JavaScript agree on noindex and canonical',
          description: 'noindex: ' + (rawNoindex ? 'yes' : 'no') + ' / ' + (liveNoindex ? 'yes' : 'no') + ' — canonical: ' + (rawC[0] || '(none)') + ' / ' + (liveC[0] || '(none)'), element: null });
      }
      renderPanel();
    });
  }

  // A4 — meta refresh redirect (in the live page, the original HTML, or the HTTP "Refresh" header)
  function parseRefresh(content) {
    var m = /^\s*(\d+(?:\.\d*)?)\s*(?:[;,]\s*(?:url\s*=\s*)?([\s\S]*))?$/i.exec(content || '');
    if (!m) return null;
    return { delay: parseFloat(m[1]), url: (m[2] || '').trim().replace(/^['"]|['"]$/g, '') };
  }
  function checkMetaRefresh() {
    var CK = 'crawl.metaRefresh', CAT = 'Technical / crawlability';
    var seen = {}, list = [];
    var collect = function (doc) {
      Array.prototype.forEach.call(doc.querySelectorAll('meta[http-equiv]'), function (m) {
        if (!/^\s*refresh\s*$/i.test(m.getAttribute('http-equiv') || '')) return;
        var c = m.getAttribute('content') || '';
        if (seen['m:' + c]) return;
        seen['m:' + c] = true;
        list.push({ content: c, header: false, el: doc === document ? m : null });
      });
    };
    collect(document);
    getRawDoc().then(function (raw) {
      if (!raw.error) {
        collect(raw.doc);
        if (raw.refreshHeader) list.push({ content: raw.refreshHeader, header: true, el: null });
      }
      var redirects = [];
      list.forEach(function (x) {
        var p = parseRefresh(x.content);
        if (!p || !p.url) return;                       // no URL = the page only reloads itself, not a redirect
        var to = absUrl(p.url);
        if (!to || to.split('#')[0] === LOC.href.split('#')[0]) return;
        redirects.push({ delay: p.delay, to: to, x: x });
      });
      redirects.forEach(function (r) {
        addFinding({ check: CK, category: CAT, severity: 'error',
          title: r.delay === 0 ? 'Page redirects instantly with a meta refresh' : 'Page redirects with a meta refresh after ' + r.delay + ' s',
          description: (r.x.header ? 'HTTP header "Refresh: ' + r.x.content + '"' : '<meta http-equiv="refresh" content="' + r.x.content + '">') + '\nTarget: ' + r.to,
          why: 'Google treats an instant meta refresh (0 seconds) as a permanent redirect and a delayed one as a temporary redirect; a permanent server-side redirect is the better choice whenever the platform can do it, and meta refresh only where it can\'t.',
          fix: 'Webflow can do server-side 301 redirects: Site settings > Publishing > 301 redirects — enter the old path and the new URL, then publish. Remove the meta refresh from ' + CUSTOM_CODE_PLACES + '.',
          element: r.x.el });
      });
      if (!redirects.length) addSuccess({ check: CK, category: CAT, title: 'No meta refresh redirect on the page', description: '', element: null });
      renderPanel();
    });
  }

  // A5 — hreflang (only when the page has hreflang tags)
  function hreflangLinks(doc) {
    return Array.prototype.filter.call(doc.querySelectorAll('link[hreflang]'), function (l) { return /(^|\s)alternate(\s|$)/i.test(l.getAttribute('rel') || ''); });
  }
  function validHreflang(v) {
    v = (v || '').trim();
    if (/^x-default$/i.test(v)) return true;
    var m = /^([A-Za-z]{2})(?:-([A-Za-z]{4}))?(?:-([A-Za-z]{2}))?$/.exec(v);
    if (!m) return false;
    if (ISO_639_1.indexOf(m[1].toLowerCase()) === -1) return false;
    if (m[2] && ISO_15924.indexOf(m[2].charAt(0).toUpperCase() + m[2].slice(1).toLowerCase()) === -1) return false;
    if (m[3] && ISO_3166_1.indexOf(m[3].toUpperCase()) === -1) return false;
    return true;
  }
  function checkHreflang() {
    var all = hreflangLinks(document);
    if (!all.length) return;                            // single-language page: the check doesn't apply
    var CK = 'intl.hreflang', CAT = 'International (hreflang)', problems = 0;
    var HREFLANG_FIX = 'In Webflow, Localization generates the hreflang tags by itself: Settings panel > Localization lets you turn automatic generation on or off and choose the base URL (the published/canonical URL or a custom one). Hreflang tags written in ' + CUSTOM_CODE_PLACES + ' have to be fixed there.';
    var tagText = function (l) { return '<link rel="alternate" hreflang="' + (l.getAttribute('hreflang') || '') + '" href="' + (l.getAttribute('href') || '') + '">'; };
    var inHead = all.filter(inHeadOf(document));
    var outside = all.filter(function (l) { return inHead.indexOf(l) === -1; });
    if (outside.length) {
      problems++;
      addFinding({ check: CK, category: CAT, severity: 'error', title: 'hreflang tags are outside <head> (' + outside.length + ')',
        description: outside.map(tagText).join('\n'),
        why: 'hreflang <link> tags count only inside a well-formed <head> of the HTML. ' + HEAD_PARSE_NOTE,
        fix: HREFLANG_FIX, element: outside[0] });
      if (!inHead.length) return;                       // nothing in <head> to validate further
    }
    var badVal = inHead.filter(function (l) { return !validHreflang(l.getAttribute('hreflang')); });
    if (badVal.length) {
      problems++;
      addFinding({ check: CK, category: CAT, severity: 'error',
        title: 'Invalid hreflang value: ' + badVal.map(function (l) { return '"' + (l.getAttribute('hreflang') || '') + '"'; }).join(', '),
        description: badVal.map(tagText).join('\n'),
        why: 'The hreflang value must always specify a language code in ISO 639-1 format (e.g. "en", "de"), optionally followed by a region code in ISO 3166-1 alpha-2 format (e.g. "en-GB", "es-mx"), or be "x-default". A region alone (e.g. "us") is not valid, and "en-UK" is not valid because the ISO 3166-1 code of the United Kingdom is "GB".',
        fix: 'Correct the language/region code. ' + HREFLANG_FIX, element: badVal[0] });
    }
    var notAbs = inHead.filter(function (l) { return !/^https?:\/\//i.test((l.getAttribute('href') || '').trim()); });
    if (notAbs.length) {
      problems++;
      addFinding({ check: CK, category: CAT, severity: 'error', title: 'hreflang URL is not fully qualified (' + notAbs.length + ')',
        description: notAbs.map(tagText).join('\n'),
        why: 'Alternate URLs must be full URLs including https:// — "https://example.com/foo", not "//example.com/foo" or "/foo".',
        fix: 'Use full URLs starting with https://. ' + HREFLANG_FIX, element: notAbs[0] });
    }
    var selfKeys = [pageKey(LOC.href)];
    var canon = canonicalLinks(document).filter(inHeadOf(document))[0];
    if (canon) { var ck = pageKey(canon.getAttribute('href') || ''); if (ck && selfKeys.indexOf(ck) === -1) selfKeys.push(ck); }
    var hasSelf = inHead.some(function (l) { return selfKeys.indexOf(pageKey(l.getAttribute('href') || '')) > -1; });
    if (!hasSelf) {
      problems++;
      addFinding({ check: CK, category: CAT, severity: 'error', title: 'This page is missing from its own hreflang set (no self-reference)',
        description: 'This page: ' + LOC.href.split('#')[0] + '\n' + inHead.map(tagText).join('\n'),
        why: 'Each language version must list itself and all other language versions — one <link> per version, including itself.',
        fix: HREFLANG_FIX, element: inHead[0] || all[0] });
    }
    if (!inHead.some(function (l) { return /^x-default$/i.test((l.getAttribute('hreflang') || '').trim()); })) {
      addFinding({ check: CK, category: CAT, severity: 'info', title: 'No x-default hreflang',
        description: '',
        why: 'x-default is used for any language not listed — useful on language/country selectors or auto-redirecting home pages. Recommended, not required.',
        fix: HREFLANG_FIX, element: inHead[0] || all[0] });
    }
    // Return links: every other version must point back to this page. Only same-origin versions can be read from the browser.
    var targets = [];
    inHead.forEach(function (l) {
      var h = (l.getAttribute('href') || '').trim();
      if (!/^https?:\/\//i.test(h)) return;
      var k = pageKey(h);
      if (!k || selfKeys.indexOf(k) > -1 || targets.some(function (t) { return t.key === k; })) return;
      targets.push({ key: k, url: h, lang: (l.getAttribute('hreflang') || '').trim() });
    });
    var same = targets.filter(function (t) { try { return new URL(t.url).origin === LOC.origin; } catch (e) { return false; } });
    var cross = targets.filter(function (t) { return same.indexOf(t) === -1; });
    var toCheck = same.slice(0, 12);
    var broken = [], noReturn = [], nonCanon = [], failed = [];
    var finish = function () {
      if (broken.length) {
        problems++;
        addFinding({ check: CK, category: CAT, severity: 'error', title: 'hreflang points to a page that does not load directly (' + broken.length + ')',
          description: broken.join('\n'),
          why: 'The alternate version answers with an error or a redirect instead of the page itself, so the hreflang pair can\'t work.',
          fix: 'Point the hreflang to the final URL of each version. ' + HREFLANG_FIX, element: null });
      }
      if (noReturn.length) {
        problems++;
        addFinding({ check: CK, category: CAT, severity: 'error', title: 'hreflang return link missing on ' + noReturn.length + ' version(s)',
          description: noReturn.join('\n'),
          why: 'If two pages don\'t point to each other, Google ignores their hreflang tags. Each version listed here has hreflang tags, or none, that don\'t point back to this page.',
          fix: 'Every version must list all versions, including this page. ' + HREFLANG_FIX, element: null });
      }
      if (nonCanon.length) {
        problems++;
        addFinding({ check: CK, category: CAT, severity: 'warning', title: 'hreflang points to a URL whose canonical is a different page (' + nonCanon.length + ')',
          description: nonCanon.join('\n'),
          why: 'The alternate version says another URL is its primary (canonical) version. hreflang should point to canonical URLs in the same language, otherwise the pair can\'t work.',
          fix: 'Point the hreflang to the canonical URL of each version, or fix that version\'s canonical. ' + HREFLANG_FIX, element: null });
      }
      var skippedReasons = [];
      if (cross.length) skippedReasons.push(cross.length + ' version(s) on another domain can\'t be read from the browser (' + cross.map(function (t) { return t.url; }).join(', ').slice(0, 200) + ')');
      if (same.length > toCheck.length) skippedReasons.push('only the first ' + toCheck.length + ' versions were checked');
      if (failed.length) skippedReasons.push(CSP_OR_NETWORK);
      if (skippedReasons.length) reportCheckSkipped('hreflang return-link check (some versions)', skippedReasons);
      if (!problems) {
        addSuccess({ check: CK, category: CAT, title: 'hreflang tags are valid (' + inHead.length + ' versions) and the checked versions link back',
          description: inHead.map(tagText).join('\n'), element: inHead[0] });
      }
      renderPanel();
    };
    if (!toCheck.length) { finish(); return; }
    var left = toCheck.length;
    toCheck.forEach(function (t) {
      fetch(t.url, { cache: 'no-store', credentials: 'same-origin' }).then(function (r) {
        if (!r.ok) { broken.push(t.lang + ' → ' + t.url + ' — HTTP ' + r.status); return null; }
        if (r.redirected && pageKey(r.url) !== t.key) { broken.push(t.lang + ' → ' + t.url + ' — redirects to ' + r.url); return null; }
        return r.text();
      }).then(function (html) {
        if (html == null) return;
        var d = new DOMParser().parseFromString(html, 'text/html');
        var back = hreflangLinks(d).filter(inHeadOf(d)).some(function (l) { return selfKeys.indexOf(pageKey(l.getAttribute('href') || '', t.url)) > -1; });
        if (!back) noReturn.push(t.lang + ' → ' + t.url);
        var c = canonicalLinks(d).filter(inHeadOf(d))[0];
        if (c) { var ckey = pageKey(c.getAttribute('href') || '', t.url); if (ckey && ckey !== t.key) nonCanon.push(t.lang + ' → ' + t.url + ' (canonical: ' + c.getAttribute('href') + ')'); }
      }).catch(function () { failed.push(t.url); }).then(function () { if (--left === 0) finish(); });
    });
  }

  // ---------------------------------------------------------------------
  // 5.3d Group B (05.11.2026): broken images, links Google can't crawl / qualify, schema required properties and
  // visible text, mobile vs desktop content, tap targets. Sources quoted in SPEC.md (05.11.2026).
  // ---------------------------------------------------------------------
  // Text normalised for comparing: case, quotes/dashes, punctuation and whitespace don't matter.
  function normText(s) {
    s = String(s || '');
    try { s = s.normalize('NFKC'); } catch (e) {}
    return s.toLowerCase().replace(/[‘’‚‛′]/g, "'").replace(/[“”„″]/g, '"')
      .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  }

  // B8 — images that don't load (404, wrong URL, deleted file). Loaded with an Image object, which also works for the CDN.
  function checkBrokenImages() {
    var CK = 'img.broken', byUrl = {}, order = [];
    Array.prototype.forEach.call(document.images, function (img) {
      if (img.closest('#seo-audit-host') || isTrackingPixel(img)) return;
      var raw = img.currentSrc || img.getAttribute('src') || '';
      if (!raw || /^(data|blob):/i.test(raw)) return;
      var u = absUrl(raw);
      if (!u) return;
      if (!byUrl[u]) { byUrl[u] = []; order.push(u); }
      byUrl[u].push(img);
    });
    var urls = order.slice(0, 150);
    setCheckTotal(CK, urls.length);
    if (!urls.length) return;
    var left = urls.length, broken = 0;
    urls.forEach(function (u) {
      auditPending++;
      var probe = new Image(), settled = false;
      var end = function (ok) {
        if (settled) return;
        settled = true; auditPending--;
        if (!ok) {
          broken++;
          var el = byUrl[u][0];
          addFinding({ check: CK, category: 'Images', severity: 'error', title: 'Image does not load (broken image)',
            description: u.slice(0, 200) + (byUrl[u].length > 1 ? '\n(used ' + byUrl[u].length + ' times on this page)' : '') + (el.getAttribute('alt') ? '\nalt: "' + el.getAttribute('alt').slice(0, 80) + '"' : ''),
            why: 'The browser could not load this image file (it no longer exists, the URL is misspelled or the path is wrong), so visitors and Google see an empty spot.',
            fix: 'Replace the image: select it > Element settings panel > Image settings > Replace image (or fix the URL in the CMS field / custom code it comes from). Publish.', element: el });
        }
        if (--left === 0) {
          if (!broken) addSuccess({ check: CK, category: 'Images', title: 'All images load (' + urls.length + ' checked)', description: '', element: null });
          renderPanel();
        }
      };
      probe.onload = function () { end(true); };
      probe.onerror = function () { end(false); };
      setTimeout(function () { end(true); }, 20000);   // no answer in 20 s: not reported (unknown, not broken)
      probe.src = u;
    });
  }

  // B9 / B10 / B12 — links: navigation Google can't crawl, internal nofollow, image links without alt text.
  // Checked in the HTML regardless of visibility (Google reads hidden links too). Not run in the device frames
  // (they strip inline handlers such as onclick).
  function checkLinkCrawl() {
    var NAV_JS = /\blocation\b|window\.open|\.href\s*=|\bnavigate\s*\(/i;
    // 9) "Not recommended": <span href>, <a onclick> without href, other tags that act as links through script events.
    var jsNav = [];
    Array.prototype.forEach.call(document.querySelectorAll('[onclick], [href], [role="link"]'), function (el) {
      if (el.closest('#seo-audit-host')) return;
      var tag = el.tagName;
      if (/^(A|LINK|AREA|BASE)$/.test(tag)) return;            // <a> without href is reported as "Link doesn't go anywhere"
      if (el.namespaceURI === 'http://www.w3.org/2000/svg') return;   // SVG <use href> / <image href> are not links
      var why = null;
      if (el.hasAttribute('href')) why = 'href on <' + tag.toLowerCase() + '>';
      else if (el.getAttribute('role') === 'link') why = 'role="link" without <a href>';
      else if (NAV_JS.test(el.getAttribute('onclick') || '')) why = 'onclick navigation';
      if (why) jsNav.push({ el: el, why: why });
    });
    var anchors = Array.prototype.filter.call(document.querySelectorAll('a[href]'), function (a) { return !a.closest('#seo-audit-host'); });
    setCheckTotal('links.js', anchors.length + jsNav.length);
    jsNav.slice(0, 30).forEach(function (x) {
      addFinding({ check: 'links.js', category: 'Links', severity: 'warning', title: 'Navigation without a crawlable link (' + x.why + ')',
        description: '"' + (text(x.el) || x.el.getAttribute('aria-label') || '').slice(0, 60) + '" <' + elLabel(x.el) + '>' + (x.el.getAttribute('href') ? ' href="' + x.el.getAttribute('href').slice(0, 100) + '"' : '') + (x.el.getAttribute('onclick') ? ' onclick="' + x.el.getAttribute('onclick').slice(0, 100) + '"' : ''),
        why: 'Google can generally only follow a link that is an <a> element with an href; it can\'t reliably find URLs in elements without an href or in tags that act as links through scripts (for example <span href> or <a onclick>). The page behind this element may not be discovered through this link.',
        fix: 'Make it a real link: in Webflow use a Link block, Text link or Button and set the destination in the Element settings panel (Link settings); to make an image or a block clickable, drop it inside a Link block. Remove the click script / custom attribute that did the navigation.', element: x.el });
    });
    if (!jsNav.length) addSuccess({ check: 'links.js', category: 'Links', title: 'All navigation uses crawlable <a href> links', description: '', element: null });

    // 10) rel="nofollow" on links to the same site
    var internal = anchors.filter(function (a) { var h = hostnameOf(a.getAttribute('href') || ''); return h && isSameSite(h) && !/^(mailto|tel|javascript):/i.test(a.getAttribute('href')); });
    var nof = internal.filter(function (a) { return /(^|[\s,])nofollow([\s,]|$)/i.test(a.getAttribute('rel') || ''); });
    setCheckTotal('links.nofollow', internal.length);
    nof.slice(0, 30).forEach(function (a) {
      addFinding({ check: 'links.nofollow', category: 'Links', severity: 'warning', title: 'Internal link has rel="nofollow"',
        description: '"' + (text(a) || a.getAttribute('aria-label') || '').slice(0, 60) + '" → ' + (a.getAttribute('href') || '').slice(0, 120) + ' (rel="' + a.getAttribute('rel') + '")',
        why: 'Google generally doesn\'t follow links with nofollow; nofollow is meant for links you don\'t want associated with your site. On an internal link it holds back crawling of your own page — to keep a page out of search, use noindex or robots.txt instead.',
        fix: 'Remove rel="nofollow" from the internal link — in Webflow it comes from a custom attribute (Element settings panel > Custom attributes) or from custom code. To keep a page out of Google, use noindex (Page settings > SEO settings > Sitemap indexing off); to stop crawling, robots.txt.', element: a });
    });
    if (internal.length && !nof.length) addSuccess({ check: 'links.nofollow', category: 'Links', title: 'No internal link has rel="nofollow" (' + internal.length + ' checked)', description: '', element: null });

    // 12) image links: Google uses the image's alt as the anchor text (title as a fallback for an empty link)
    var imgLinks = anchors.filter(function (a) { return !(a.textContent || '').trim() && a.querySelector('img'); });
    var noAlt = imgLinks.filter(function (a) {
      if ((a.getAttribute('title') || '').trim()) return false;
      return Array.prototype.every.call(a.querySelectorAll('img'), function (i) { return !(i.getAttribute('alt') || '').trim(); });
    });
    setCheckTotal('links.imgAlt', imgLinks.length);
    noAlt.slice(0, 30).forEach(function (a) {
      var img = a.querySelector('img');
      addFinding({ check: 'links.imgAlt', category: 'Links', severity: 'warning', title: 'Image link has no anchor text (image without alt)',
        description: '→ ' + (a.getAttribute('href') || '').slice(0, 120) + '\nimage: ' + ((img.currentSrc || img.getAttribute('src') || '').replace(/\?.*$/, '').split('/').pop() || '').slice(0, 80) + (a.getAttribute('aria-label') ? '\n(aria-label="' + a.getAttribute('aria-label').slice(0, 60) + '" helps screen readers, but Google uses the image alt as anchor text)' : ''),
        why: 'When an image is a link, Google uses its alt text as the link text. An image link with empty alt and no text tells Google nothing about the page it points to.',
        fix: 'Give the image descriptive alt text: select it > Element settings panel > Image settings > Alt text > Custom description (or in the Assets panel: the image\'s settings > descriptive text; for a CMS image bind the alt text to a field). Or add visible text inside the link.', element: a });
    });
    if (imgLinks.length && !noAlt.length) addSuccess({ check: 'links.imgAlt', category: 'Links', title: 'All image links have alt text (' + imgLinks.length + ' checked)', description: '', element: null });
  }

  // B11 — schema: Google's required properties for the rich-result types a Webflow page usually has, and whether
  // the marked-up names/headlines are on the page. JSON-LD only (Microdata/RDFa are not read).
  function schemaTypesOfNode(n) {
    var t = n && n['@type'];
    if (!t) return [];
    return (Array.isArray(t) ? t : [t]).map(function (x) { return String(x).replace(/^.*[\/:#]/, ''); });
  }
  function schemaHas(v) {
    if (v === undefined || v === null) return false;
    if (typeof v === 'string') return v.trim() !== '';
    if (Array.isArray(v)) return v.some(schemaHas);
    if (typeof v === 'number' || typeof v === 'boolean') return true;
    if (typeof v === 'object') return Object.keys(v).some(function (k) { return k.charAt(0) !== '@' ? schemaHas(v[k]) : (k === '@id' && schemaHas(v[k])); });
    return false;
  }
  function schemaGet(n, path) {
    var parts = path.split('.'), cur = [n];
    parts.forEach(function (p) {
      var next = [];
      cur.forEach(function (c) { if (c && typeof c === 'object') { var v = c[p]; if (Array.isArray(v)) next = next.concat(v); else if (v !== undefined) next.push(v); } });
      cur = next;
    });
    return cur;
  }
  function schemaHasPath(n, path) { return schemaGet(n, path).some(schemaHas); }
  // -> list of missing required properties (Google Search Central, structured data type pages, read 05.11.2026)
  function schemaMissing(type, n, nested) {
    var miss = [], need = function (p) { if (!schemaHasPath(n, p)) miss.push(p); };
    var oneOf = function (ps) { if (!ps.some(function (p) { return schemaHasPath(n, p); })) miss.push(ps.join(' / ')); };
    if (type === 'Product') {
      need('name'); oneOf(['review', 'aggregateRating', 'offers']);
      schemaGet(n, 'offers').forEach(function (o) {
        if (!o || typeof o !== 'object') return;
        var ot = schemaTypesOfNode(o);
        if (ot.indexOf('AggregateOffer') > -1) { if (!schemaHasPath(o, 'lowPrice')) miss.push('offers.lowPrice'); if (!schemaHasPath(o, 'priceCurrency')) miss.push('offers.priceCurrency'); }
        else if (!schemaHasPath(o, 'price') && !schemaHasPath(o, 'priceSpecification.price')) miss.push('offers.price / offers.priceSpecification.price');
      });
      schemaGet(n, 'review').forEach(function (r) { if (r && typeof r === 'object') schemaMissing('Review', r, true).forEach(function (m) { miss.push('review.' + m); }); });
      schemaGet(n, 'aggregateRating').forEach(function (r) { if (r && typeof r === 'object') schemaMissing('AggregateRating', r, true).forEach(function (m) { miss.push('aggregateRating.' + m); }); });
    } else if (type === 'SoftwareApplication' || type === 'MobileApplication' || type === 'WebApplication') {
      need('name'); need('offers.price'); oneOf(['aggregateRating', 'review']);
    } else if (type === 'Review') {
      need('author'); if (!nested) { need('itemReviewed'); need('itemReviewed.name'); } need('reviewRating'); need('reviewRating.ratingValue');
    } else if (type === 'AggregateRating') {
      if (!nested) { need('itemReviewed'); need('itemReviewed.name'); } need('ratingValue'); oneOf(['ratingCount', 'reviewCount']);
    } else if (type === 'Event') {
      need('name'); need('startDate'); need('location');
      var locs = schemaGet(n, 'location').filter(function (l) { return l && typeof l === 'object'; });
      if (locs.length && !locs.some(function (l) { return schemaTypesOfNode(l).indexOf('VirtualLocation') > -1; })) need('location.address');
    } else if (type === 'VideoObject') {
      need('name'); need('thumbnailUrl'); need('uploadDate');
    } else if (type === 'BreadcrumbList') {
      var items = schemaGet(n, 'itemListElement').filter(function (i) { return i && typeof i === 'object'; });
      if (!items.length) miss.push('itemListElement');
      items.forEach(function (it, idx) {
        var label = 'itemListElement[' + (idx + 1) + ']';
        if (!schemaHasPath(it, 'position')) miss.push(label + '.position');
        var itm = it.item, itemIsThingWithName = itm && typeof itm === 'object' && schemaHasPath(itm, 'name');
        if (!schemaHasPath(it, 'name') && !itemIsThingWithName) miss.push(label + '.name');
        if (idx < items.length - 1 && !schemaHasPath(it, 'item')) miss.push(label + '.item');
      });
    } else if (type === 'LocalBusiness') {
      need('name'); need('address');
    } else if (type === 'JobPosting') {
      need('title'); need('description'); need('datePosted'); need('hiringOrganization');
      if (!schemaHasPath(n, 'applicantLocationRequirements')) need('jobLocation');
    }
    return miss;
  }
  var SCHEMA_REQUIRED_TYPES = ['Product', 'SoftwareApplication', 'MobileApplication', 'WebApplication', 'Review', 'AggregateRating', 'Event', 'VideoObject', 'BreadcrumbList', 'LocalBusiness', 'JobPosting'];
  // Which property holds the name/headline that the page should show
  var SCHEMA_VISIBLE_PROPS = { Article: 'headline', BlogPosting: 'headline', NewsArticle: 'headline', Product: 'name', Event: 'name', SoftwareApplication: 'name', VideoObject: 'name', JobPosting: 'title', Course: 'name', Recipe: 'name', Question: 'name' };
  function pageTextNorm() {
    var parts = [];
    try {
      var w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, { acceptNode: function (t) {
        var p = t.parentElement;
        return p && !p.closest('script,style,noscript,template,#seo-audit-host') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      } });
      var t; while ((t = w.nextNode())) parts.push(t.nodeValue);
    } catch (e) {}
    return ' ' + normText(parts.join(' ')) + ' ';
  }
  function checkSchemaGoogle(blocks) {
    var CAT = 'AEO - Structured data (Schema.org)';
    var SCHEMA_FIX = 'In Webflow: Pages panel > the page\'s Settings > Schema markup field (or the custom code where the JSON-LD was added); on a Collection page bind the CMS fields so every item gets its own values. Publish.';
    // Walk every node (top level, @graph members and nested objects)
    // A nested item is a rich-result candidate of its own only when it hangs off a "container" property (WebPage.breadcrumb,
    // mainEntity, ItemList.itemListElement...). Items that only describe another one (itemReviewed, author, offers, location...)
    // are checked through their parent.
    var CONTAINER_PROPS = ['breadcrumb', 'mainEntity', 'mainEntityOfPage', 'hasPart', 'subjectOf', 'video', 'itemListElement', 'workExample', 'about'];
    var nodes = [];
    (function walk(v, depth, nested, viaProp) {
      if (!v || typeof v !== 'object' || depth > 8) return;
      if (Array.isArray(v)) { v.forEach(function (x) { walk(x, depth + 1, nested, viaProp); }); return; }
      if (v['@type']) nodes.push({ n: v, nested: nested && CONTAINER_PROPS.indexOf(viaProp) === -1 });
      Object.keys(v).forEach(function (k) { if (k.charAt(0) !== '@' || k === '@graph') walk(v[k], depth + 1, (k !== '@graph' && !!v['@type']) || (nested && k !== '@graph'), k === '@graph' ? viaProp : k); });
    })(blocks.map(function (b) { return b.raw; }), 0, false, null);
    // Required properties (a Review / AggregateRating nested in another item is checked through that item, without itemReviewed)
    var checkedTypes = [], incomplete = 0;
    nodes.forEach(function (x) {
      schemaTypesOfNode(x.n).forEach(function (t) {
        if (SCHEMA_REQUIRED_TYPES.indexOf(t) === -1) return;
        if (x.nested) return;                           // checked through the item it belongs to (a nested Review / AggregateRating without itemReviewed)
        if (checkedTypes.indexOf(t) === -1) checkedTypes.push(t);
        var miss = schemaMissing(t, x.n, false);
        if (!miss.length) return;
        incomplete++;
        var nm = schemaGet(x.n, 'name').concat(schemaGet(x.n, 'title')).filter(function (v) { return typeof v === 'string'; })[0] || '';
        addFinding({ check: 'aeo.schemaRequired', group: 'aeo', category: CAT, severity: 'warning',
          title: t + ' schema is missing properties Google requires: ' + miss.slice(0, 6).join(', ') + (miss.length > 6 ? ' (+' + (miss.length - 6) + ')' : ''),
          description: nm ? '"' + nm.slice(0, 80) + '"' : '',
          why: 'These properties are required for the ' + t + ' rich result in Google: without them the item is not eligible for it (structured data makes a rich result possible, but doesn\'t guarantee it, and doesn\'t affect ranking).',
          fix: 'Add the missing properties. ' + SCHEMA_FIX, element: null });
      });
    });
    if (checkedTypes.length && !incomplete) addSuccess({ check: 'aeo.schemaRequired', group: 'aeo', category: CAT, title: 'Schema has the properties Google requires (' + checkedTypes.join(', ') + ')', description: '', element: null });
    // Marked-up names / headlines that don't appear in the page text
    var pageNorm = null, notFound = [], checked = 0;
    nodes.forEach(function (x) {
      schemaTypesOfNode(x.n).forEach(function (t) {
        var prop = SCHEMA_VISIBLE_PROPS[t];
        if (!prop) return;
        var v = x.n[prop];
        if (typeof v !== 'string' || !v.trim()) return;
        var key = normText(v);
        if (key.length < 3) return;
        if (key.length > 100) key = key.slice(0, 100).replace(/\s\S*$/, '');
        if (pageNorm === null) pageNorm = pageTextNorm();
        checked++;
        if (pageNorm.indexOf(' ' + key + ' ') === -1 && pageNorm.indexOf(' ' + key) === -1) notFound.push(t + '.' + prop + ': "' + v.trim().slice(0, 90) + '"');
      });
    });
    if (notFound.length) {
      addFinding({ check: 'aeo.schemaVisible', group: 'aeo', category: CAT, severity: 'warning',
        title: 'Schema text not found on the page (' + notFound.length + ')',
        description: notFound.slice(0, 8).join('\n') + (notFound.length > 8 ? '\n… +' + (notFound.length - 8) : ''),
        why: 'Structured data must describe what readers actually see on the page — if the JSON-LD describes something, the page text must describe the same thing. These names/headlines from the schema don\'t appear in the page text (compared without case and punctuation).',
        fix: 'Make the schema match what the page shows (same headline / name), or show that text on the page. ' + SCHEMA_FIX, element: null });
    } else if (checked) {
      addSuccess({ check: 'aeo.schemaVisible', group: 'aeo', category: CAT, title: 'Schema names/headlines appear on the page (' + checked + ' checked)', description: '', element: null });
    }
  }

  // B7 — mobile vs desktop content. Every frame (and the main window) lists its headings, text blocks and images
  // with alt text, and whether each is visible or reachable (inside a tab, accordion, dropdown, slider or menu).
  // Compared by CONTENT, not by element, because Webflow layouts often duplicate a block for mobile.
  function collectParityUnits() {
    var out = [], seen = {}, KINDS = ['tab', 'accordion', 'dropdown', 'slider', 'menu'];
    var add = function (el, k, keyText, label) {
      if (out.length >= 800 || el.closest('#seo-audit-host')) return;
      var key = normText(keyText);
      if (!key) return;
      if (k === 'txt') key = key.slice(0, 120);
      var id = k + '|' + key, r = isReachable(el, KINDS);
      if (seen[id] !== undefined) { if (r && !out[seen[id]].r) out[seen[id]].r = true; return; }
      seen[id] = out.length;
      out.push({ k: k, key: key, d: String(label).replace(/\s+/g, ' ').trim().slice(0, 90), r: r, p: elPath(el), tag: el.tagName });
    };
    Array.prototype.forEach.call(document.querySelectorAll('h1,h2,h3,h4,h5,h6'), function (h) { add(h, 'h', h.textContent, h.tagName + ': ' + h.textContent); });
    Array.prototype.forEach.call(document.querySelectorAll('p,li,blockquote,figcaption,dd,td'), function (el) {
      if (el.closest('h1,h2,h3,h4,h5,h6')) return;
      var t = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (t.length >= 40) add(el, 'txt', t, t);
    });
    Array.prototype.forEach.call(document.images, function (img) { var a = (img.getAttribute('alt') || '').trim(); if (a) add(img, 'img', a, 'alt: ' + a); });
    return out;
  }
  // 12.11.2026: all rendered text of the page (innerText leaves out display:none), normalised like the unit keys.
  // A desktop text that the mobile layout shows in another kind of element (a <div> instead of a <p>, a mobile-only
  // variant of the section) is not missing (false positive on honeybook.com: "Put AI to work" cards).
  // 12.11.2026: "Hidden content" across layouts. A block hidden at one width but shown at another (a mobile-only or
  // desktop-only variant of a section) is responsive design, not hidden text: on honeybook.com the desktop window
  // listed the mobile "Put AI to work" cards and the mobile frame listed the desktop ones. After the device pass only
  // blocks whose text no layout shows are kept.
  var hiddenContentBlocks = [];
  function refineHiddenContent(cur, results) {
    var srcs = [{ device: cur, own: true, hidden: hiddenContentBlocks, vtext: parityVisibleText() }];
    FRAMES.forEach(function (def) {
      var r = results[def.key];
      if (r && r.ok && r.data && typeof r.data.vtext === 'string') srcs.push({ device: def.device, hidden: r.data.hidden || [], vtext: r.data.vtext });
    });
    if (srcs.length < 2) return;                                   // no other layout to compare with: leave the finding as it is
    var keep = [], byProbe = {};
    srcs.forEach(function (src) {
      src.hidden.forEach(function (h) {
        var probe = String(h.key || '').slice(0, 60);
        if (!probe) return;
        if (srcs.some(function (o) { return o.vtext.indexOf(probe) > -1; })) return;   // shown in some layout
        var k = byProbe[probe];
        if (!k) { k = byProbe[probe] = { txt: h.txt, el: src.own ? h.el : null, devices: [] }; keep.push(k); }
        if (!k.el && src.own) k.el = h.el;
        if (k.devices.indexOf(src.device) === -1) k.devices.push(src.device);
      });
    });
    var proto = null;
    for (var i = findings.length - 1; i >= 0; i--) {
      if (/^Hidden content with a substantial amount of text/.test(findings[i].title || '')) { proto = findings[i]; findings.splice(i, 1); }
    }
    if (!keep.length || !proto) return;
    var devs = [];
    keep.forEach(function (k) { k.devices.forEach(function (d) { if (devs.indexOf(d) === -1) devs.push(d); }); });
    var all = deviceScan.checked.every(function (d) { return devs.indexOf(d) > -1; });
    var nf = {};
    Object.keys(proto).forEach(function (k) { if (k !== 'id' && k !== 'hiddenUi' && k !== 'checkId') nf[k] = proto[k]; });
    nf.title = 'Hidden content with a substantial amount of text (' + keep.length + ' block' + (keep.length === 1 ? '' : 's') + ', display:none/visibility:hidden)';
    nf.description = 'First ' + Math.min(3, keep.length) + ':\n' + keep.slice(0, 3).map(function (k) { return '"' + k.txt.slice(0, 80) + '..."'; }).join('\n');
    nf.element = (keep[0] && keep[0].el) || null;
    nf.devices = devs; nf.devicesChecked = deviceScan.checked.slice();
    nf.deviceOnly = !all && devs.indexOf(cur) === -1;
    addFinding(nf);
  }
  function parityVisibleText() { return normText(document.body ? document.body.innerText : ''); }
  function checkMobileParity(curDevice, results) {
    var desk = deviceOfWidth(window.innerWidth) === 'desktop' ? collectParityUnits()
      : (results.desktop && results.desktop.ok && results.desktop.data.units) || null;
    var mob = window.innerWidth <= 478 ? collectParityUnits()
      : (results['mobile-p'] && results['mobile-p'].ok && results['mobile-p'].data.units) || null;
    if (!desk || !mob) return;                          // a frame failed: not evaluated
    var mobText = window.innerWidth <= 478 ? parityVisibleText()
      : (results['mobile-p'] && results['mobile-p'].data && results['mobile-p'].data.vtext) || '';
    var onMobile = {};
    mob.forEach(function (u) { if (u.r) onMobile[u.k + '|' + u.key] = true; });
    var shown = desk.filter(function (u) { return u.r; });
    var missing = shown.filter(function (u) {
      if (onMobile[u.k + '|' + u.key]) return false;
      if (u.k !== 'img' && mobText && mobText.indexOf(u.k === 'txt' ? u.key.slice(0, 60) : u.key) > -1) return false;
      if (u.k === 'txt') return !Object.keys(onMobile).some(function (k) { return k.indexOf('txt|' + u.key.slice(0, 60)) === 0; });
      return true;
    });
    var KIND = { h: 'Heading', txt: 'Text', img: 'Image' };
    if (missing.length) {
      // The same blocks also show up in the mobile-only "Hidden content" note — that is this problem seen from the other
      // side, so that note is dropped (one cause, one finding).
      var missingFlat = missing.map(function (u) { return u.key; }).join('').replace(/\s+/g, '');
      for (var fi = findings.length - 1; fi >= 0; fi--) {
        var hf = findings[fi];
        if (!hf.deviceOnly || !/^Hidden content with a substantial amount of text/.test(hf.title || '') || (hf.devices || []).join() !== 'mobile') continue;
        var snippets = (hf.description || '').split('\n').slice(1).map(function (l) { return normText(l.replace(/\.\.\."?$/, '')).replace(/\s+/g, '').slice(0, 40); }).filter(Boolean);
        if (snippets.length && snippets.every(function (sn) { return missingFlat.indexOf(sn) > -1; })) findings.splice(fi, 1);
      }
      var first = missing[0], el = null;
      try { el = elByPath(first.p); } catch (e) {}
      addFinding({ check: 'mobile.parity', category: 'Mobile', severity: 'warning',
        title: 'Content visible on desktop is missing on mobile (' + missing.length + ')',
        description: missing.slice(0, 10).map(function (u) { return KIND[u.k] + ' — ' + u.d; }).join('\n') + (missing.length > 10 ? '\n… +' + (missing.length - 10) : ''),
        why: 'Google indexes and ranks the mobile version of the page (mobile-first indexing), so the mobile page should have the same content, headings and image alt text as desktop. Content may sit in accordions or tabs on mobile, but content that is removed can\'t be used by Google. These items are visible on desktop but hidden (display: none) in the mobile frame (375 px), and not inside a tab, accordion, dropdown, slider or menu there.',
        fix: 'Show this content on the Mobile breakpoint, or move it into a tab/accordion instead of hiding it. In Webflow an element is hidden per breakpoint with Style panel > Layout > display: none — select the breakpoint in the canvas bar and change it; display is a class style, so it applies to every element with the same class and cascades to smaller breakpoints.',
        element: el });
    } else {
      addSuccess({ check: 'mobile.parity', category: 'Mobile', title: 'Mobile shows the same content as desktop (' + shown.length + ' items compared)', description: '', element: null });
    }
  }

  // B13 — tap targets on mobile (WCAG 2.2 SC 2.5.8 Target Size (Minimum), level AA): a target smaller than 24x24 CSS px
  // fails unless a 24 px circle centred on it doesn't intersect another target or another small target's circle.
  // Exceptions handled: inline links in a sentence; hidden elements. Runs only at mobile widths (the mobile frames,
  // or the main window when it is that narrow).
  function checkTapTargets() {
    if (window.innerWidth > 767) return;
    var sel = 'a[href], button, input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="link"], [role="tab"], [role="checkbox"], [role="menuitem"], [role="switch"]';
    var all = Array.prototype.filter.call(document.querySelectorAll(sel), function (el) {
      if (el.closest('#seo-audit-host') || !isVisible(el)) return false;
      var st = window.getComputedStyle(el);
      if (st.pointerEvents === 'none' || st.visibility === 'hidden') return false;
      if (zeroHeightClipper(el)) return false;
      return true;
    });
    // nested targets (a button inside a link): keep the outermost
    all = all.filter(function (el) { return !all.some(function (o) { return o !== el && o.contains(el); }); });
    var T = all.map(function (el) {
      var r = el.getBoundingClientRect();
      return { el: el, x: r.left, y: r.top, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2, small: r.width < 24 || r.height < 24 };
    }).filter(function (t) { return t.w > 0 && t.h > 0; });
    var isInline = function (el) {
      if (window.getComputedStyle(el).display !== 'inline') return false;
      var b = el.parentElement;
      while (b && window.getComputedStyle(b).display === 'inline') b = b.parentElement;
      return !!b && (b.textContent || '').replace(/\s+/g, ' ').trim().length > (el.textContent || '').replace(/\s+/g, ' ').trim().length + 2;
    };
    setCheckTotal('mobile.tapTargets', T.length);
    var fails = 0;
    T.forEach(function (a) {
      if (!a.small || isInline(a.el)) return;
      var clash = T.some(function (b) {
        if (b === a) return false;
        if (b.small) return Math.hypot(a.cx - b.cx, a.cy - b.cy) < 24;
        var dx = Math.max(b.x - a.cx, 0, a.cx - (b.x + b.w)), dy = Math.max(b.y - a.cy, 0, a.cy - (b.y + b.h));
        return Math.hypot(dx, dy) < 12;
      });
      if (!clash || fails >= 40) return;
      fails++;
      addFinding({ category: 'Mobile', severity: 'info', noScore: true, title: 'Tap target is too small and too close to another (' + Math.round(a.w) + 'x' + Math.round(a.h) + ' px)',
        description: '"' + (text(a.el) || a.el.getAttribute('aria-label') || a.el.getAttribute('title') || '').slice(0, 60) + '" <' + elLabel(a.el) + '>',
        why: 'A tap target should be at least 24 by 24 CSS pixels, unless there is enough space around it (a 24 px circle centred on it doesn\'t touch another target). This one is smaller and has a neighbour that close, so on a phone it is easy to tap the wrong thing. This is an accessibility issue, so it is listed as a note and does not affect the score.',
        fix: 'On the Mobile breakpoint make the target at least 24x24 px (padding counts) or give it more space from its neighbours — in Webflow, Style panel (size / padding / margin) with the Mobile breakpoint selected.', element: a.el });
    });
  }

  // ---------------------------------------------------------------------
  // 5.10 URL slug (duplication)
  // ---------------------------------------------------------------------

  function checkSlug() {
    var segments = LOC.pathname.split('/').filter(Boolean);
    var last = segments[segments.length - 1] || '';
    // 06.11.2026 (2): two Webflow duplication patterns.
    //  - Static page duplicated in the Designer: "<name> Copy", slug "<slug>-copy" (seen in HoneyBook Core Pages:
    //    privacy-copy, responsible-ai-copy).
    //  - CMS item: the user (Webflow developer) reports that a duplicated item gets "-2", "-3"...; seen in data:
    //    pros.honeybook.com/blog/what-is-an-invoice-2. Only checked on CMS item pages — Webflow marks them with
    //    <html data-wf-item-slug> (verified on a live CMS page; static pages don't have it) — and only for
    //    -2..-99, so years ("-2026") are not matched. Static pages keep only the "-copy" rule ("windows-7" stays fine).
    var cmsSlug = document.documentElement.getAttribute('data-wf-item-slug');
    var isCmsItem = !!cmsSlug;
    if (isCmsItem) last = cmsSlug;
    var copySuffix = /-copy(-\d+)?$/i.test(last);
    var cmsNumSuffix = isCmsItem && /-([2-9]|[1-9]\d)$/.test(last);
    if (copySuffix || cmsNumSuffix) {
      addFinding({ category: 'URL & page duplication', severity: 'warning',
        title: copySuffix ? 'URL slug ends with "-copy" (' + last + ')' : 'CMS item slug ends with a number like "-2" (' + last + ')',
        description: 'Path: ' + LOC.pathname,
        why: copySuffix
          ? 'When a page is duplicated in Webflow it is named "<name> Copy" and gets the slug "<slug>-copy", so a published "-copy" URL is usually a duplicate whose slug was never renamed. Readable words in a URL are better.'
          : 'A duplicated Webflow CMS item gets a number at the end of its slug ("-2", "-3"...), so this item may be a copy whose slug was never renamed. If the number is part of the real name (e.g. "episode-12"), ignore this. Readable words in a URL are better than a number.',
        fix: copySuffix
          ? 'Rename the slug to something descriptive in the Slug field of Page settings, and if the old URL is already indexed add a 301 redirect from it (Site settings > Publishing > 301 redirects).'
          : 'If it is a copy: rename the slug in the CMS item (Collection item > Slug field), or remove the duplicate item. If the old URL is already indexed, add a 301 redirect from it (Site settings > Publishing > 301 redirects).',
        element: null });
    } else {
      addSuccess({ category: 'URL & page duplication', title: isCmsItem ? 'CMS item slug does not end with a Webflow duplication suffix' : 'URL slug does not end with Webflow\'s duplication suffix "-copy"',
        description: 'Path: ' + LOC.pathname, element: null });
    }
  }

  // ---------------------------------------------------------------------
  // 5.2 Heading structure
  // ---------------------------------------------------------------------

  function checkHeadings() {
    var headings = Array.prototype.slice.call(document.querySelectorAll('h1,h2,h3,h4,h5,h6')).filter(function (h) { return isReachable(h, CONTENT_UI_KINDS); });
    var h1s = headings.filter(function (h) { return h.tagName === 'H1'; });

    if (h1s.length === 0) {
      addFinding({ category: 'Heading structure', severity: 'error', title: 'H1 is missing on the page',
        description: 'No visible H1 element was found.', why: 'The H1 is the main heading that says what the page is about; this page has none.',
        fix: 'Add exactly one H1 describing the page\'s main topic.', element: document.body });
    } else if (h1s.length > 1) {
      h1s.slice(1).forEach(function (h) {
        addFinding({ category: 'Heading structure', severity: 'warning', title: 'There is more than one H1 on the page (' + h1s.length + ' total)',
          description: 'Extra H1: "' + text(h).slice(0, 80) + '"', why: 'One H1 makes the main topic of the page unambiguous; here there are several.',
          fix: 'Keep only one H1, change the others to H2/H3 as needed.', element: h });
      });
    } else {
      addSuccess({ category: 'Heading structure', title: 'Exactly one H1 found on the page',
        description: '"' + text(h1s[0]).slice(0, 80) + '"', element: h1s[0] });
    }

    var lastLevel = 0;
    var hierarchySkipFound = false;
    headings.forEach(function (h) {
      var level = parseInt(h.tagName.substring(1), 10);
      if (lastLevel > 0 && level - lastLevel > 1) {
        hierarchySkipFound = true;
        addFinding({ category: 'Heading structure', severity: 'info', noScore: true, title: 'Heading hierarchy skips a level (H' + lastLevel + ' → H' + level + ')',
          description: '"' + text(h).slice(0, 80) + '"', why: 'Skipping heading levels (e.g. H2 straight to H4) breaks the page outline for readers and screen readers. It doesn\'t affect Google rankings. This is an accessibility issue, so it is listed as a note and does not affect the score.',
          fix: 'Use heading levels in order, without skipping.', element: h });
      }
      lastLevel = level;
    });
    if (!hierarchySkipFound && headings.length > 1) {
      addSuccess({ category: 'Heading structure', title: 'Heading hierarchy has no skipped levels',
        description: headings.length + ' heading elements on the page.', element: null });
    }

    // Visual-semantic mismatch (heuristic)
    var candidates = Array.prototype.slice.call(document.querySelectorAll('div, span, p')).filter(isVisible);
    var checked = 0;
    for (var i = 0; i < candidates.length && checked < 400; i++) {
      var el = candidates[i];
      var t = text(el);
      if (!t || t.length > 90 || el.children.length > 2) continue;
      // Already part of a real heading (<h2><span>Big</span></h2>): nothing to mark up.
      if (el.closest && el.closest('h1, h2, h3, h4, h5, h6, [role="heading"]')) continue;
      checked++;
      var fs = parseFloat(window.getComputedStyle(el).fontSize);
      var fw = window.getComputedStyle(el).fontWeight;
      if (fs >= 28 && (fw === 'bold' || parseInt(fw, 10) >= 600)) {
        addFinding({ category: 'Heading structure', severity: 'info', title: 'Text looks like a heading but isn\'t marked up as one',
          description: '"' + t.slice(0, 80) + '" (font-size: ' + fs.toFixed(0) + 'px)',
          why: 'Text that looks like a heading but isn\'t marked up as one is not announced as a heading by screen readers, so the page structure is lost for them.',
          fix: 'If this is actually a section title, mark it up with the appropriate heading tag (H2/H3...).', element: el });
      }
    }
  }

  // ---------------------------------------------------------------------
  // 5.3 Images
  // ---------------------------------------------------------------------

  var GENERIC_ALT_PATTERNS = /^(image|img|photo|picture|untitled|dsc\d*|screenshot.*|asset.*)$/i;

  // Best-effort: finds whether the width/height for an element is explicitly fixed via CSS
  // (classes, inline style) — not just via the HTML width/height attributes. Doesn't account
  // for specificity/!important, nor whether an @media block is currently active (best-effort
  // heuristic, same as the other CSS-parsing checks in this file).
  function getDeclaredCssSize(el) {
    var declared = { width: null, height: null, aspectRatio: null, minHeight: null, paddingBottom: null };

    function applyDecl(styleDecl) {
      if (!styleDecl || !styleDecl.getPropertyValue) return;
      var w = styleDecl.getPropertyValue('width');
      var h = styleDecl.getPropertyValue('height');
      var ar = styleDecl.getPropertyValue('aspect-ratio');
      var mh = styleDecl.getPropertyValue('min-height');
      var pb = styleDecl.getPropertyValue('padding-bottom');
      if (w) declared.width = w.trim();
      if (h) declared.height = h.trim();
      if (ar) declared.aspectRatio = ar.trim();
      if (mh) declared.minHeight = mh.trim();
      if (pb) declared.paddingBottom = pb.trim();
    }

    function scanRules(rules) {
      if (!rules) return;
      for (var i = 0; i < rules.length; i++) {
        var rule = rules[i];
        // Note: some browsers/implementations expose an empty (but "truthy") .cssRules even on
        // plain CSSStyleRule objects, so we do NOT stop processing based on .cssRules alone
        // existing — we first check the selector/style match, and ONLY THEN (additionally)
        // recurse into any nested rules (@media, @supports...).
        if (rule.selectorText && rule.style) {
          var matches = false;
          try { matches = el.matches(rule.selectorText); } catch (e) { matches = false; }
          if (matches) applyDecl(rule.style);
        }
        if (rule.cssRules && rule.cssRules.length) {
          scanRules(rule.cssRules);
        }
      }
    }

    var sheets = document.styleSheets;
    for (var i = 0; i < sheets.length; i++) {
      try { scanRules(sheets[i].cssRules || sheets[i].rules); } catch (e) { /* cross-origin stylesheet */ }
    }

    applyDecl(el.style); // inline style has the highest priority, applied last

    return declared;
  }

  // Whether a single CSS/HTML length value is "fixed" (has a real effect), regardless of unit
  // (px, rem, vw, %, ...) — the only things that are "not fixed" are auto/initial/inherit/unset
  // or the absence of a value. Deliberately doesn't check the unit: 10rem is just as valid a
  // fixed value as 160px, as long as it isn't "auto" (agreed with the user on 10.08.2026).
  function isLengthFixed(v) {
    return !!v && v !== 'auto' && v !== 'initial' && v !== 'inherit' && v !== 'unset';
  }

  // 29.10.2026 — an image with no height of its own is often fine because a WRAPPER reserves the
  // space (fixed height, aspect-ratio, min-height, or the old padding-bottom:% "ratio box" trick):
  // the wrapper keeps its size while the image loads, so nothing below it shifts. This looks up to
  // 5 ancestors for such a reservation. A percentage height (height:100%) only counts if some
  // ancestor above it really has a fixed size — on its own it reserves nothing.
  var heightReserveCache = null;
  function elLabel(el) {
    var c = (el.className && typeof el.className === 'string') ? el.className.trim().split(/\s+/)[0] : '';
    return el.tagName.toLowerCase() + (c ? '.' + c : '');
  }
  function reservesHeight(d, el, selfLabel) {
    var pct = function (v) { return /%\s*$/.test(v || ''); };
    var intrinsic = function (v) { return /^(fit-content|max-content|min-content|stretch)/.test(v || ''); };
    if (isLengthFixed(d.height) && !pct(d.height) && !intrinsic(d.height)) return 'a fixed height (' + d.height + ') on ' + selfLabel;
    if (d.aspectRatio && d.aspectRatio !== 'auto') return 'aspect-ratio (' + d.aspectRatio + ') on ' + selfLabel;
    if (d.minHeight && isLengthFixed(d.minHeight) && !pct(d.minHeight) && !intrinsic(d.minHeight) && !/^0(px|rem|em|vh)?$/.test(d.minHeight)) return 'a min-height (' + d.minHeight + ') on ' + selfLabel;
    if (pct(d.paddingBottom) && parseFloat(d.paddingBottom) > 0) return 'a padding-bottom ratio box (' + d.paddingBottom + ') on ' + selfLabel;
    try {
      var ar = getComputedStyle(el).aspectRatio;
      if (ar && ar !== 'auto') return 'aspect-ratio (' + ar + ') on ' + selfLabel;
    } catch (e) {}
    return null;
  }
  function findHeightReserver(img, ownDecl) {
    var own = reservesHeight({ height: null, aspectRatio: ownDecl.aspectRatio, minHeight: ownDecl.minHeight, paddingBottom: null }, img, 'the image');
    if (own) return own;
    if (!heightReserveCache) heightReserveCache = typeof Map === 'function' ? new Map() : null;
    var el = img.parentElement, depth = 0;
    while (el && el !== document.body && el !== document.documentElement && depth < 5) {
      var hit;
      if (heightReserveCache && heightReserveCache.has(el)) hit = heightReserveCache.get(el);
      else {
        hit = reservesHeight(getDeclaredCssSize(el), el, 'the wrapper <' + elLabel(el) + '>');
        if (heightReserveCache) heightReserveCache.set(el, hit);
      }
      if (hit) return hit;
      el = el.parentElement; depth++;
    }
    return null;
  }

  function checkImages() {
    heightReserveCache = null;
    var imgs = Array.prototype.slice.call(document.querySelectorAll('img'));
    var bothDimsFixedCount = 0;
    var heightOnlyFixedCount = 0;
    var wrapperHeightCount = 0;   // no own height, but a wrapper / aspect-ratio reserves the space (29.10.2026)
    var goodAltCount = 0;
    var emptyAltCount = 0;   // alt="" — not scored (06.11.2026): can be correct (decorative) or not, the HTML can't tell
    var internalHostCount = 0;
    var modernFormatCount = 0;
    var checkedImgCount = 0;
    var oversizeMeasured = 0, oversizeFound = 0;   // "image much larger than displayed" (28.10.2026)
    var oversizeCandidates = [];                   // images that are oversized by pixel dimensions; severity decided by estimated wasted KB
    var oversizePassed = {};                       // 12.11.2026: URLs used at an appropriate size somewhere on the page
    var oversizeHits = [];                         // candidates over the threshold, reported once per URL when all are resolved
    var lazyConsidered = 0, lazyFound = 0;         // "below-the-fold image not lazy" (28.10.2026)
    // Thresholds of the "heavy file" and "no responsive versions" checks (29.10.2026, from the flowninja.com audit):
    //   heavy file: replaced 06.11.2026 by the Lighthouse encode check (see ENCODE_* below); > 500 KB = warning (Webflow's own target).
    //   no srcset:  wasted on a 375px phone >= 50 KB -> info, >= 150 KB -> warning (needs a measured file size, else nothing is reported).
    // Lighthouse image re-encoding (06.11.2026), values from the Lighthouse 12.8.1 source code:
    //  - JPEG/BMP ("Efficiently encode images"): re-encode as JPEG at quality 0.92 (gatherer JPEG_QUALITY; the docs say 85),
    //    flag when the saving is >= 4096 bytes (IGNORE_THRESHOLD_IN_BYTES).
    //  - PNG ("Serve images in modern formats"): convert to WebP at quality 0.85 (gatherer WEBP_QUALITY), the docs:
    //    "Lighthouse omits the image from its report if the potential savings are less than 8KiB" (IGNORE_THRESHOLD 8192).
    //    Lighthouse reports the saving against an AVIF estimate; here only the real WebP result is used (more conservative).
    var ENCODE_RULES = { jpeg: { type: 'image/jpeg', quality: 0.92, min: 4096 }, png: { type: 'image/webp', quality: 0.85, min: 8192 } };
    var ENCODE_MAX_IMAGES = 80;
    var encodeQueue = [], encodeSeen = {}, encodeRunning = 0;
    function queueEncodeCheck(src, el, kind) {
      if (encodeSeen[src] || Object.keys(encodeSeen).length >= ENCODE_MAX_IMAGES) return;
      encodeSeen[src] = true;
      encodeQueue.push({ src: src, el: el, kind: kind });
      runEncodeQueue();
    }
    function runEncodeQueue() {
      while (encodeRunning < 2 && encodeQueue.length) {
        var job = encodeQueue.shift();
        encodeRunning++;
        auditPending++;   // decoding/encoding is not a fetch, so the "analysis in progress" counter is held manually
        encodeOne(job, function () { encodeRunning--; auditPending--; runEncodeQueue(); });
      }
    }
    function encodeOne(job, done) {
      var finished = false;
      function fin() { if (!finished) { finished = true; done(); } }
      try {
        fetch(job.src).then(function (r) { return r.ok ? r.blob() : null; }).then(function (blob) {
          if (!blob || typeof createImageBitmap !== 'function') { fin(); return; }
          return createImageBitmap(blob).then(function (bmp) {
            var c = (typeof OffscreenCanvas !== 'undefined') ? new OffscreenCanvas(bmp.width, bmp.height) : document.createElement('canvas');
            c.width = bmp.width; c.height = bmp.height;
            c.getContext('2d').drawImage(bmp, 0, 0);
            if (bmp.close) bmp.close();
            var rule = ENCODE_RULES[job.kind];
            var p = c.convertToBlob ? c.convertToBlob({ type: rule.type, quality: rule.quality })
              : new Promise(function (res) { c.toBlob(res, rule.type, rule.quality); });
            return p.then(function (out) {
              if (!out || out.type !== rule.type) { fin(); return; }   // e.g. a browser that can't encode WebP
              var saved = blob.size - out.size;
              if (saved >= rule.min && job.kind === 'png') {
                addFinding({ category: 'Images', severity: 'info',
                  title: 'PNG image would be ~' + fmtBytes(saved) + ' smaller as WebP',
                  description: job.src.replace(/\?.*$/, '').slice(0, 120) + '\nFile: ' + fmtBytes(blob.size) + ' → about ' + fmtBytes(out.size) + ' (' + Math.round(saved / blob.size * 100) + '% smaller)',
                  why: 'Converted to WebP (quality 85), this PNG would be that much smaller, with the same size on screen; WebP keeps transparency. Images are reported when the saving is 8 KB or more.',
                  fix: 'In Webflow: Assets panel > the image\'s more options > Compress > WebP or AVIF (works for PNG). Compression replaces the original file.',
                  element: job.el });
                renderPanel();
              } else if (saved >= rule.min) {
                addFinding({ category: 'Images', severity: 'info',
                  title: 'Image can be compressed further (~' + fmtBytes(saved) + ' smaller as JPEG at quality 92)',
                  description: job.src.replace(/\?.*$/, '').slice(0, 120) + '\nFile: ' + fmtBytes(blob.size) + ' → about ' + fmtBytes(out.size) + ' (' + Math.round(saved / blob.size * 100) + '% smaller)',
                  why: 'Re-saved as a JPEG at quality 92, this file would be that much smaller, with the same size on screen. Images are reported when the saving is 4 KB or more.',
                  fix: 'Compress the image: in Webflow, Assets panel > the image\'s more options > Compress > WebP or AVIF (JPG/PNG only), or re-export it as JPEG at quality 85–92 and swap it via Assets panel > more options > Replace (the asset URL changes).',
                  element: job.el });
                renderPanel();
              }
              fin();
            });
          });
        }).catch(fin);
      } catch (err) { fin(); }
    }
    var lazyAboveList = [], lazyAboveConsidered = 0; // ABOVE-the-fold images that carry loading="lazy" (29.10.2026)
    var lcpNowSrc = '';
    var lcpNowEl = null;                             // the LCP element is reported by its own check (cwv.lcpLazy) — skipped here
    try {
      var lcpNowLast = lastLcpEntry();
      lcpNowEl = lcpNowLast ? lcpNowLast.element : null;
      // A device frame is hidden, so it has no LCP of its own: the main page tells it which image is the LCP image.
      if (HEADLESS && window.__SeoAuditorLcpSrc) lcpNowSrc = String(window.__SeoAuditorLcpSrc);
    } catch (e) {}

    imgs.forEach(function (img) {
      // Visible images, plus images in a closed tab / accordion / dropdown / menu / slider / popup (30.10.2026).
      // Those have no layout box, so the checks that need a rendered size (oversize, lazy position,
      // bytes-per-pixel) are skipped for them; alt text, format, host, fixed height and file size still apply.
      if (isTrackingPixel(img)) return;
      var imgHidden = !isVisible(img);
      if (imgHidden && !isReachable(img)) return;
      checkedImgCount++;

      // Webflow outputs alt="" (empty but present) for "Alt text: Decorative" (official Webflow changelog).
      // 06.11.2026 verified on a published Webflow page (wf-core-pages.hbqa.dev/pricing): Image element with
      // altText "inherit" (use the asset's alt) + asset altText null → alt="" as well; all 373 <img> there had
      // an alt attribute (0 missing). So alt="" can be "Decorative" OR "nothing saved" — only the Designer tells.
      var hasAltAttr = img.hasAttribute('alt');
      var altText = hasAltAttr ? (img.getAttribute('alt') || '').trim() : '';
      var isDecorative = hasAltAttr && altText === '';
      var isMissing = !hasAltAttr;
      var isGeneric = hasAltAttr && altText !== '' && GENERIC_ALT_PATTERNS.test(altText);
      // 28.10.2026: an SVG (icon/illustration) with alt="" is the standard decorative pattern —
      // on honeybook.com ~90% of the "empty alt" notes were SVG icons, so they're treated as fine.
      var imgSrcStr = img.currentSrc || img.src || '';
      var isSvgImg = /\.svg(\?|#|$)/i.test(imgSrcStr) || /^data:image\/svg/i.test(imgSrcStr);

      // 06.11.2026 (user decision): an empty alt="" is NOT scored either way — Webflow outputs it both for
      // "Decorative" and when no alt text is saved, so the tool can't tell a correct one from a mistake.
      // It is still listed (non-SVG) so the developer can check it in the Designer / Assets panel.
      if (isDecorative) emptyAltCount++;
      if (isDecorative && isSvgImg) {
        // SVG icon with alt="" — the usual decorative pattern; not listed, not scored
      } else if (isDecorative) {
        addFinding({ category: 'Images', severity: 'info', noScore: true,
          title: 'Alt text is empty (alt="") — "Decorative" or no alt text saved in Webflow',
          description: (img.currentSrc || img.src || '').slice(0, 120),
          why: 'Webflow outputs an empty alt="" for an image set as "Decorative", so screen readers skip it — correct for purely decorative images. It outputs the same alt="" when no alt text is saved at all. In Asset settings such an asset shows "Descriptive" selected with an empty field, so "Descriptive" being checked does not mean a description exists. So alt="" does not prove anyone chose "Decorative" — only the Designer shows that. It is listed for checking only and does not affect the score.',
          fix: 'Check in the Designer: select the image > Element settings panel > Image settings > Alt text, and the asset itself: Assets panel > the image\'s more options > Edit settings > Alt text. If it is "Decorative" and the image is purely decorative, no action is needed. If "Descriptive" is selected but the text field is empty, or the image carries meaning, type a description (on the asset, or for this instance: Custom description).',
          element: img });
      } else if (isMissing || isGeneric) {
        addFinding({ category: 'Images', severity: 'error',
          title: isMissing ? 'Image: alt attribute is missing' : 'Image: generic alt text ("' + altText + '")',
          description: (img.currentSrc || img.src || '').slice(0, 120),
          why: 'Alt text describes the image to people who can\'t see it (screen readers) and helps Google understand what the image shows. An <img> without alt gives neither.',
          fix: 'Add descriptive alt text: Assets panel > the image\'s more options > Edit settings > Descriptive (applies wherever the image is placed from then on), or for this instance Element settings panel > Image settings > Alt text > Custom description. If the image is purely decorative, choose "Decorative" instead.',
          element: img });
      } else {
        goodAltCount++;
      }

      // In a typical block-flow layout (the most common case on Webflow sites), CLS (Cumulative
      // Layout Shift) is primarily caused by an UNKNOWN HEIGHT at load time — as soon as the
      // height is fixed (HTML attribute OR CSS, any unit: px, rem, vw...), the browser
      // immediately reserves that vertical space and the rest of the page doesn't shift when the
      // image loads, REGARDLESS of whether the width is "auto" or also fixed. A width that
      // self-computes (auto, based on the image's aspect ratio) doesn't disturb vertical space
      // that's already reserved. So (agreed with the user on 10.08.2026) this check looks
      // EXCLUSIVELY at whether the HEIGHT is fixed — width is no longer a condition for
      // "safe", and such images are not reported either as a warning/error or as an info note;
      // they go straight into the Success tab.
      var declared = getDeclaredCssSize(img);
      var ownHeightPct = /%\s*$/.test(declared.height || '');
      var heightFixed = img.hasAttribute('height') || (isLengthFixed(declared.height) && !ownHeightPct);
      var heightReserver = heightFixed ? null : findHeightReserver(img, declared);
      var widthFixed = img.hasAttribute('width') || isLengthFixed(declared.width);

      if (heightFixed) {
        if (widthFixed) {
          bothDimsFixedCount++;
        } else {
          heightOnlyFixedCount++;
        }
      } else if (heightReserver) {
        wrapperHeightCount++;
      } else {
        addFinding({ category: 'Images', severity: 'error',
          title: 'Image has no fixed height (neither HTML attribute nor CSS)',
          description: (img.currentSrc || img.src || '').slice(0, 120) +
            '\nCSS width: ' + (declared.width || 'not found/defined') +
            ' | CSS height: ' + (declared.height || 'not found/defined') +
            (ownHeightPct ? '\nThe height is a percentage, but no parent (up to 5 levels checked) has a fixed height, aspect-ratio or min-height, so nothing reserves the space.' : '\nChecked the image and up to 5 parent elements for a fixed height, aspect-ratio, min-height or padding-bottom ratio box — none found.'),
          why: 'Neither the HTML height attribute nor CSS fixes the height (the value is "auto" or not defined at all) — the browser can\'t reserve vertical space for the image in advance, which causes layout shift (CLS) while the image loads. CLS is a Core Web Vital (good is below 0.1). Width isn\'t a factor here — a fixed width alone doesn\'t reserve vertical space.',
          fix: 'Add an explicit height (an HTML height attribute, or CSS height in any unit — px, rem, vw...) directly on the <img> tag or in the Style panel. Width can stay auto.',
          element: img });
      }

      // Oversized image + below-the-fold lazy-loading (28.10.2026). Both use the image that was
      // ACTUALLY chosen by the browser (currentSrc / naturalWidth), so Webflow's responsive
      // srcset variants are taken into account. SVGs/data URIs are skipped (vector / tiny).
      var rectNow = img.getBoundingClientRect();
      var shownW = Math.round(rectNow.width), shownH = Math.round(rectNow.height);
      var natW = img.naturalWidth || 0, natH = img.naturalHeight || 0;
      var srcNow = img.currentSrc || img.src || '';
      var skipSizing = /\.svg(\?|#|$)/i.test(srcNow) || /^data:/i.test(srcNow);
      var isOversizeCand = false;
      if (!skipSizing && natW > 0 && natH > 0 && shownW > 0 && shownH > 0) {
        oversizeMeasured++;
        // 06.11.2026: Lighthouse "Properly size images" — the rendered size times the screen's pixel density
        // (window.devicePixelRatio, the same value the browser used to pick a srcset variant) against the actual
        // image; reported when the right-sized image would be >= 4 KiB smaller (see resolveOversize).
        var dprNow = window.devicePixelRatio || 1;
        var neededW = Math.round(shownW * dprNow), neededH = Math.round(shownH * dprNow);
        if (natW * natH > neededW * neededH) {
          oversizeCandidates.push({ img: img, natW: natW, natH: natH, shownW: shownW, shownH: shownH, dpr: dprNow, allowedW: neededW, allowedH: neededH, areaRatio: (neededW * neededH) / (natW * natH), src: srcNow,
            hasVariants: !!img.getAttribute('srcset') || !!(img.parentElement && img.parentElement.tagName === 'PICTURE') });
          isOversizeCand = true;
        } else {
          oversizePassed[stripQuery(srcNow)] = true;   // the same file is used at the right size here
        }
      }
      // Above-the-fold image with loading="lazy" (29.10.2026): collected here, reported as ONE finding
      // after the loop (a row of client logos would otherwise produce a dozen near-identical notes).
      if (!skipSizing && shownW >= 64 && rectNow.height >= 64) {
        var absTopAbove = rectNow.top + (window.pageYOffset || 0);
        if (absTopAbove < window.innerHeight && img !== lcpNowEl && !(lcpNowSrc && String(srcNow).replace(/[?#].*$/, '') === lcpNowSrc)) {
          lazyAboveConsidered++;
          if ((img.getAttribute('loading') || '').toLowerCase() === 'lazy') {
            lazyAboveList.push({ img: img, area: rectNow.width * rectNow.height, src: srcNow });
          }
        }
      }
      if (!skipSizing && shownW >= 64 && rectNow.height >= 64) {
        var absTop = rectNow.top + (window.pageYOffset || 0);
        if (absTop > window.innerHeight * 1.5) {
          lazyConsidered++;
          if ((img.getAttribute('loading') || '').toLowerCase() !== 'lazy') {
            lazyFound++;
            addFinding({ category: 'Images', severity: 'info', title: 'Image below the fold is not lazy-loaded',
              description: srcNow.replace(/\?.*$/, '').slice(0, 120),
              why: 'Images far below the first screen are downloaded immediately instead of when the visitor scrolls near them, competing with the content that matters for the first view (LCP).',
              fix: 'In the Designer: select the image > Element settings panel > Image settings > Set loading behavior > "Lazy" (keep "Eager" only for the hero / above-the-fold images).', element: img });
          }
        }
      }

      var src = img.currentSrc || img.src || '';
      var host = hostnameOf(src);
      var isExternal = host && host !== LOC.hostname && !isWebflowAssetHost(host) && !isSameSite(host);
      // No usable URL (a lazy-load placeholder without src, or a data:/blob: image): there is no file to request. Without this
      // guard an empty src resolves to the PAGE itself, and the page's own HTML size would be reported as an "image".
      var srcUsable = !!src && !/^(data|blob|about):/i.test(src) && src.replace(/#.*$/, '') !== LOC.href.replace(/#.*$/, '');

      if (!srcUsable) {
        internalHostCount++;
      } else if (isExternal) {
        addFinding({ category: 'Images', severity: 'error', title: 'Image is hosted on an external server',
          description: src, why: 'If that external server/project goes offline (a common case with WordPress or other migration leftovers), the image disappears from the page. File size isn\'t measured here since the server is outside our control.',
          fix: 'Download the image and upload it to the site in the Assets panel, then use that copy.', element: img });
      } else {
        internalHostCount++;
        var ext = (src.split('?')[0].split('.').pop() || '').toLowerCase();
        if (['jpg', 'jpeg', 'png', 'gif'].indexOf(ext) !== -1) {
          addFinding({ category: 'Images', severity: 'info', title: 'Image is not in a modern format (currently: ' + ext.toUpperCase() + ')',
            description: src, why: 'AVIF/WebP produce a significantly smaller file size at the same quality, which speeds up page loading.',
            fix: 'Convert it to WebP or AVIF: Assets panel > hover the image > more options > Compress > WebP or AVIF (only JPG and PNG can be compressed; Webflow advises against compressing Open Graph images).', element: img });
        } else if (['webp', 'avif'].indexOf(ext) !== -1) {
          modernFormatCount++;
        }

        var headShownW = Math.max(1, shownW), headNatW = natW, headOversize = isOversizeCand, headHidden = imgHidden;
        try {
          fetch(src, { method: 'HEAD' }).then(function (r) {
            var len = r.headers.get('content-length');
            var bytes = len ? parseInt(len, 10) : 0;
            if (bytes > 500 * 1024) {
              addFinding({ category: 'Images', severity: 'warning', title: 'Image is larger than 500KB (' + fmtBytes(bytes) + ')',
                description: src, why: 'Images should stay under 500 KB; this one is larger. A large file takes longer to download; when it is the main image of the first view it delays the Largest Contentful Paint (LCP, a Core Web Vital). The file size is measured (content-length header), not guessed.',
                fix: 'Compress the image (e.g. TinyPNG/Squoosh) or convert it to WebP/AVIF.', element: img });
              renderPanel();
            }
            // Image compression, Lighthouse method (06.11.2026; replaces the unsourced 150/300 KB "heavy file" rule):
            // Lighthouse "Efficiently encode images" (since Lighthouse 13 part of "Improve image delivery") re-compresses
            // JPEG/BMP images at quality 85 and flags the image when that saves 4 KiB or more. Main window only.
            var headType = (r.headers.get('content-type') || '').toLowerCase();
            if (!HEADLESS && r.ok && /image\/(jpeg|jpg|pjpeg|bmp)/.test(headType)) queueEncodeCheck(src, img, 'jpeg');
            else if (!HEADLESS && r.ok && /image\/png/.test(headType)) queueEncodeCheck(src, img, 'png');
            // (The separate "no responsive versions" check was removed 06.11.2026: its 50/150 KB limits had no source;
            //  the oversize check above runs in the phone/tablet frames too and catches images that are too big there.)
          }).catch(function () {});
        } catch (e) {}
      }
    });

    // ---- Oversized images (06.11.2026): Lighthouse "Properly size images" — wasted = file bytes x (1 - needed pixels /
    // actual pixels); reported (info, Lighthouse has no severity levels) when wasted >= 4 KiB. File size unknown -> not reported.
    // 12.11.2026, Lighthouse 12.8.1 uses-responsive-images.js: IGNORE_THRESHOLD_IN_BYTES = 4096, and 12288 when the image
    // has srcset or is in <picture> (IGNORE_THRESHOLD_IN_BYTES_BREAKPOINTS_PRESENT); an image is not reported if the same URL
    // is used appropriately elsewhere on the page, and per URL the smallest waste is kept.
    var OVERSIZE_MIN_BYTES = 4096, OVERSIZE_MIN_BYTES_VARIANTS = 12288;
    var oversizePending = oversizeCandidates.length;
    function oversizeKnownBytes(src) {
      try {
        var es = performance.getEntriesByName(src);
        for (var i = es.length - 1; i >= 0; i--) { var b = es[i].encodedBodySize || es[i].transferSize; if (b > 0) return b; }
      } catch (e) {}
      return null;
    }
    function oversizeDone(isAsync) {
      oversizePending--;
      if (oversizePending > 0) return;
      var byUrl = {}, urls = [];
      oversizeHits.forEach(function (h) {
        var u = stripQuery(h.c.src);
        if (oversizePassed[u]) return;
        if (!byUrl[u]) { byUrl[u] = h; urls.push(u); } else if (h.wasted < byUrl[u].wasted) byUrl[u] = h;
      });
      urls.forEach(function (u) { oversizeFound++; reportOversize(byUrl[u].c, byUrl[u].bytes, byUrl[u].wasted); });
      if (oversizeMeasured > 0 && oversizeFound === 0) {
        addSuccess({ category: 'Images', title: 'No image is larger than needed for its displayed size (' + oversizeMeasured + ' measured)', description: '', element: null });
      }
      if (isAsync) renderPanel();
    }
    function resolveOversize(c, bytes, isAsync) {
      var wasted = bytes != null ? bytes * (1 - c.areaRatio) : null;
      if (wasted != null) {
        if (wasted > (c.hasVariants ? OVERSIZE_MIN_BYTES_VARIANTS : OVERSIZE_MIN_BYTES)) oversizeHits.push({ c: c, bytes: bytes, wasted: wasted });
        else oversizePassed[stripQuery(c.src)] = true;
      }
      oversizeDone(isAsync);
    }
    function reportOversize(c, bytes, wasted) {
        var dprTxt = Math.round(c.dpr * 100) / 100;
        addFinding({ category: 'Images', severity: 'info',
          title: 'Image is larger than its displayed size (' + c.natW + 'px file shown at ' + c.shownW + 'px)',
          description: c.src.replace(/\?.*$/, '').slice(0, 120) + '\n' + 'File size: ' + fmtBytes(bytes) + ' · estimated wasted: ~' + fmtBytes(Math.round(wasted)),
          why: 'The image\'s pixels are compared with the pixels of the box it is shown in, including the screen\'s pixel density. It is reported when the right-sized image would be more than 4 KB smaller (12 KB if the image already has responsive variants). ' +
            'Here the file is ' + c.natW + '×' + c.natH + ' px, but it is shown in a ' + c.shownW + '×' + c.shownH + ' px box on a screen with pixel density ' + dprTxt + ', which uses about ' + c.allowedW + '×' + c.allowedH + ' px. The rest is downloaded but not shown (scaled down, or cropped when the box has a different shape). ' +
            'Measured at the current window width; the same rule also runs at phone and tablet widths.',
          fix: '1) Find out why the full-size file is served. Webflow creates responsive variants (srcset) for uploaded inline JPG, PNG and WebP images, except those added via rich text elements, and not for background images; the "Disable responsiveness" checkbox in Image settings turns them off (Webflow\'s variants have "-p-" plus a width in the file name, e.g. "-p-500"). ' +
            '2) If it is an Image element with responsiveness turned off: select it > Element settings panel > Image settings > uncheck "Disable responsiveness", then publish. ' +
            '3) Otherwise replace the file: resize it to about ' + c.allowedW + 'px wide (displayed width × pixel density) and compress it, then Assets panel > the image\'s more options > Replace (the asset URL changes, so update any direct links). ' +
            '4) If the file already is a Webflow variant ("-p-" in the name) and the difference is small, there is little to gain — Webflow only makes fixed variant widths.',
          element: c.img });
    }
    oversizeCandidates.forEach(function (c) {
      var known = oversizeKnownBytes(c.src);
      if (known != null) { resolveOversize(c, known, false); return; }
      try {
        fetch(c.src, { method: 'HEAD' }).then(function (r) {
          var len = parseInt(r.headers.get('content-length'), 10);
          resolveOversize(c, len > 0 ? len : null, true);
        }).catch(function () { resolveOversize(c, null, true); });
      } catch (e) { resolveOversize(c, null, true); }
    });

    setCheckTotal('img.alt', checkedImgCount - emptyAltCount);
    ['img.height', 'img.external', 'img.format', 'img.size', 'img.heavy'].forEach(function (id) { setCheckTotal(id, checkedImgCount); });
    setCheckTotal('img.oversize', oversizeMeasured);
    setCheckTotal('img.lazy', lazyConsidered);
    // ONE finding for all above-the-fold lazy images (warning when one of them is big, otherwise info).
    if (lazyAboveList.length) {
      lazyAboveList.sort(function (a, b) { return b.area - a.area; });
      var lazyAboveBig = lazyAboveList[0].area >= 0.25 * window.innerWidth * window.innerHeight;
      var lazyAboveLines = lazyAboveList.slice(0, 3).map(function (x) { return x.src.replace(/\?.*$/, '').slice(0, 120); });
      if (lazyAboveList.length > 3) lazyAboveLines.push('+' + (lazyAboveList.length - 3) + ' more');
      addFinding({ category: 'Images', severity: lazyAboveBig ? 'warning' : 'info',
        title: 'Above-the-fold images are lazy-loaded (' + lazyAboveList.length + ')',
        description: lazyAboveLines.join('\n'),
        why: 'These images are visible in the first screen, but loading="lazy" makes the browser fetch them later than it could: it first has to lay out the page and work out which images are on screen. That delays the first view (and the Largest Contentful Paint, a Core Web Vital, when one of them is the main image) and makes the images pop in. Lazy loading is meant for images far below the first screen. The first screen is measured at the current window width, so on a phone a different set of images can be above the fold.',
        fix: 'In the Designer: select each image in the first screen (hero, logo, the first row of logos) > Element settings panel > Image settings > Set loading behavior > "Eager". Keep "Lazy" for everything further down the page.',
        element: lazyAboveList[0].img });
    } else if (lazyAboveConsidered > 0) {
      addSuccess({ category: 'Images', title: 'None of the ' + lazyAboveConsidered + ' images in the first screen is lazy-loaded', description: '', element: null });
    }
    if (oversizeMeasured > 0 && oversizeCandidates.length === 0) {
      addSuccess({ category: 'Images', title: 'No image is larger than needed for its displayed size (' + oversizeMeasured + ' measured)', description: '', element: null });
    }
    if (lazyConsidered > 0 && lazyFound === 0) {
      addSuccess({ category: 'Images', title: 'All ' + lazyConsidered + ' below-the-fold images are lazy-loaded', description: '', element: null });
    }
    if (goodAltCount > 0) {
      addSuccess({ category: 'Images', title: goodAltCount + ' of ' + (checkedImgCount - emptyAltCount) + ' visible images have descriptive alt text',
        description: emptyAltCount ? emptyAltCount + ' images with an empty alt="" are not counted in the score' : '', element: null });
    }
    // Deliberately NO finding (neither warning nor info) for images where the height is fixed —
    // agreed with the user on 10.08.2026 that this is fully acceptable (the image will be
    // visible regardless, the width self-computes based on aspect ratio). It goes straight into
    // Success, split by type for transparency (both dimensions fixed vs. height only).
    if (bothDimsFixedCount > 0) {
      addSuccess({ category: 'Images', title: bothDimsFixedCount + ' image(s) have both dimensions fixed (HTML attribute or CSS, any unit)',
        description: '', element: null });
    }
    if (heightOnlyFixedCount > 0) {
      addSuccess({ category: 'Images', title: heightOnlyFixedCount + ' image(s) have a fixed height (width is auto — safe, does not cause CLS)',
        description: '', why: 'A fixed height alone reserves vertical space regardless of the width, which is enough to prevent layout shift.', element: null });
    }
    if (wrapperHeightCount > 0) {
      addSuccess({ category: 'Images', title: wrapperHeightCount + ' image(s) have no height of their own, but a wrapper reserves the space (safe, does not cause CLS)',
        description: '', why: 'A parent element with a fixed height, an aspect-ratio, a min-height or a padding-bottom ratio box keeps its size while the image loads, so the content below does not shift.', element: null });
    }
    if (checkedImgCount > 0 && internalHostCount === checkedImgCount) {
      addSuccess({ category: 'Images', title: 'All images are hosted on the same domain/Webflow Assets (no external hosts)',
        description: '', element: null });
    }
    if (modernFormatCount > 0) {
      addSuccess({ category: 'Images', title: modernFormatCount + ' image(s) are already in a modern format (WebP/AVIF)',
        description: '', element: null });
    }
  }

  // ---------------------------------------------------------------------
  // 5.3b Page-level indexing signals (28.10.2026): X-Robots-Tag HTTP header + sitemap.xml
  // ---------------------------------------------------------------------
  // Both are PAGE questions ("is THIS page blocked / listed?"), answered with same-origin fetches
  // (no CORS problem). If a request fails or the file doesn't exist, nothing is reported — a
  // missing sitemap is a site-level matter, outside this page-by-page tool.

  // When a check that needs a network request can't be completed, say so (and why) instead of
  // silently showing nothing — the result is UNKNOWN, which is neither a pass nor a failure, so
  // it's an info note that doesn't affect the score (noScore).
  function reportCheckSkipped(what, reasons) {
    var uniq = [];
    (reasons || []).forEach(function (r) { if (uniq.indexOf(r) === -1) uniq.push(r); });
    addFinding({ category: 'Technical / crawlability', severity: 'info', noScore: true,
      title: what + ' could not be completed',
      description: 'Reason: ' + (uniq.length ? uniq.join('; ') : 'unknown'),
      why: 'This check has to request a file from the same site, and that request could not be completed — so the result is unknown. This is NOT a pass and NOT a failure, and it does not affect the score.',
      fix: 'Nothing to fix on the page. If you need this result, check it manually: open the file in the browser (e.g. /sitemap.xml) or inspect the response headers in DevTools > Network.',
      element: null });
    renderPanel();
  }
  var CSP_OR_NETWORK = 'the browser blocked or failed the request (a network error, or the site\'s Content-Security-Policy "connect-src" rule)';

  function checkIndexingSignals() {
    var NOINDEX_NOTE = 'Relevant to both SEO and AEO — to be shown as a source in Google\'s AI Overviews or AI Mode, a page must be indexed and allowed to show a snippet.';

    // 1) X-Robots-Tag response header (can block indexing without anything visible in the HTML)
    try {
      var reqOpts = { cache: 'no-store', credentials: 'same-origin' };
      fetch(LOC.href, Object.assign({ method: 'HEAD' }, reqOpts)).then(function (r) {
        return (r.status === 405 || r.status === 501) ? fetch(LOC.href, Object.assign({ method: 'GET' }, reqOpts)) : r;
      }).then(function (r) {
        if (!r) return;
        if (r.status >= 400) { reportCheckSkipped('X-Robots-Tag header check', ['the server answered HTTP ' + r.status + ' to the header request']); return; }
        var raw = r.headers.get('x-robots-tag') || '';
        var h = raw.toLowerCase();
        if (/(^|[\s,:])(noindex|none)(\s|,|$)/.test(h)) {
          addFinding({ category: 'Meta & head tags', severity: 'error', title: 'X-Robots-Tag header blocks indexing',
            description: 'X-Robots-Tag: ' + raw,
            why: 'The server sends an HTTP header that tells search engines not to index this page. It is invisible in the page\'s HTML and in the Designer, and it overrides what the page itself says.',
            fix: 'Find where the header is set — it is not part of the Webflow project itself: a reverse proxy, Cloudflare rule, or hosting/CDN configuration.',
            ownerNote: 'Needs access to whoever manages the reverse proxy / CDN / hosting in front of the site (e.g. Cloudflare Transform Rules). It can\'t be changed in the Webflow Designer.',
            element: null, crossRelevant: true, crossNote: NOINDEX_NOTE, crossNoteReverse: NOINDEX_NOTE });
        } else if (/nosnippet|max-snippet:\s*0/.test(h)) {
          addFinding({ category: 'Meta & head tags', severity: 'warning', title: 'X-Robots-Tag header restricts snippets',
            description: 'X-Robots-Tag: ' + raw,
            why: 'The server tells search engines not to show a text snippet for this page; the content is then also not used as a direct source for AI Overviews and AI Mode.',
            fix: 'Find where the header is set (reverse proxy / Cloudflare rule / hosting) and remove the snippet restriction if it is unintended.',
            ownerNote: 'Needs access to whoever manages the reverse proxy / CDN / hosting in front of the site.',
            element: null, crossRelevant: true, crossNote: NOINDEX_NOTE, crossNoteReverse: NOINDEX_NOTE });
        } else {
          addSuccess({ category: 'Meta & head tags', title: 'No X-Robots-Tag header restricts indexing' + (raw ? ' (header: ' + raw.slice(0, 60) + ')' : ''), description: '', element: null });
        }
        renderPanel();
      }).catch(function () { reportCheckSkipped('X-Robots-Tag header check', [CSP_OR_NETWORK]); });
    } catch (e) {}

    // 2) Is this page listed in sitemap.xml?
    try {
      if (/\.webflow\.io$/.test(LOC.hostname)) return; // staging: sitemap is normally off, the staging note already covers it
      var norm = function (u) {
        try {
          var x = new URL(u, LOC.href);
          return x.hostname.replace(/^www\./i, '').toLowerCase() + x.pathname.replace(/\/+$/, '');
        } catch (e) { return null; }
      };
      var extractLocs = function (xml) {
        var out = [], re = /<loc>\s*([^<\s]+)\s*<\/loc>/gi, m;
        while ((m = re.exec(xml))) out.push(m[1]);
        return out;
      };
      var sitemapPartial = false; // true when not every (nested) sitemap could be read -> never claim "not listed"
      var sitemapReasons = [];    // WHY it's partial/failed, shown to the user instead of staying silent
      var sitemapRootError = null; // root sitemap.xml request failed for a reason other than "doesn't exist"
      var sitemapFetches = 0;
      // Reads a sitemap URL; a <sitemapindex> is followed recursively (nested indexes exist: e.g.
      // honeybook.com's index points to /blog/sitemap-index.xml which points to /blog/sitemap.xml).
      // Capped at 12 fetches / depth 3 — beyond that we stop and mark the result as partial.
      var readSitemap = function (u, depth, isRoot) {
        if (sitemapFetches >= 12 || depth > 3) {
          sitemapPartial = true;
          sitemapReasons.push('the sitemap has more nested files than this check reads (max 12 files, 3 levels deep), so it can\'t prove the page is missing');
          return Promise.resolve([]);
        }
        sitemapFetches++;
        return fetch(u, { cache: 'no-store', credentials: 'same-origin' }).then(function (r) {
          if (!r.ok) {
            if (!isRoot) { sitemapPartial = true; sitemapReasons.push('a sitemap file (' + u.replace(/^https?:\/\/[^\/]+/, '').slice(0, 60) + ') answered HTTP ' + r.status); }
            return null;
          }
          return r.text();
        }).then(function (xml) {
          if (!xml || !/<(urlset|sitemapindex)[\s>]/i.test(xml)) {
            if (!isRoot) { sitemapPartial = true; sitemapReasons.push('a sitemap file (' + u.replace(/^https?:\/\/[^\/]+/, '').slice(0, 60) + ') is not valid sitemap XML'); }
            return isRoot ? null : [];
          }
          var locs = extractLocs(xml);
          if (!/<sitemapindex[\s>]/i.test(xml)) return locs;
          return Promise.all(locs.map(function (child) { return readSitemap(child, depth + 1, false); })).then(function (lists) { return [].concat.apply([], lists); });
        }).catch(function () {
          if (isRoot) sitemapRootError = CSP_OR_NETWORK;
          else { sitemapPartial = true; sitemapReasons.push(CSP_OR_NETWORK); }
          return isRoot ? null : [];
        });
      };
      readSitemap(LOC.origin + '/sitemap.xml', 0, true).then(function (locs) {
        if (!locs) {
          if (sitemapRootError) reportCheckSkipped('Sitemap check', [sitemapRootError]); // a missing sitemap (404) stays silent: site-level matter
          return;
        }
        var set = {};
        locs.forEach(function (u) { var n = norm(u); if (n != null) set[n] = true; });
        var canon = document.querySelector('link[rel="canonical"]');
        var me = norm(LOC.href);
        var canonN = canon ? norm(canon.getAttribute('href')) : null;
        if (set[me] || (canonN && set[canonN])) {
          addSuccess({ category: 'Technical / crawlability', title: 'This page is listed in sitemap.xml', description: '', element: null });
        } else if (sitemapPartial) {
          // couldn't read the whole sitemap — don't claim the page is missing from it, but SAY why
          reportCheckSkipped('Sitemap check (is this page listed?)', sitemapReasons);
          return;
        } else {
          var robotsMeta = getMeta('robots') || '';
          var intentional = /noindex/i.test(robotsMeta) || (canonN && canonN !== me);
          addFinding({ category: 'Technical / crawlability', severity: intentional ? 'info' : 'warning',
            title: 'This page is not listed in sitemap.xml',
            description: 'Checked ' + LOC.origin + '/sitemap.xml (' + locs.length + ' URLs)',
            why: 'A sitemap tells search engines which pages you consider important and helps them crawl the site more efficiently. A page missing from it can still be found through links.' +
              (intentional ? ' This looks intentional here (the page is noindex or its canonical points elsewhere).' : ''),
            fix: 'In Webflow: Page settings > SEO settings > "Sitemap indexing" must be on (for a CMS item: the Collection item > Item details > Sitemap indexing); it works only when the site\'s auto-generated sitemap is enabled. Publish after the change.',
            element: null });
        }
        renderPanel();
      }).catch(function () { /* unexpected error in the check itself */ });
    } catch (e) {}
  }

  // ---------------------------------------------------------------------
  // 5.3b Above-the-fold video poster + form field labels (29.10.2026, flowninja.com audit)
  // ---------------------------------------------------------------------

  // A big video in the first screen without a poster image: an empty box until enough data arrives.
  // Geometry-based (not "is it the LCP element"), so it works on any page: a visible <video> that starts
  // in the first screen and covers at least a quarter of the viewport.
  function checkVideos() {
    var vw = window.innerWidth, vh = window.innerHeight;
    var considered = 0, bad = [];
    Array.prototype.slice.call(document.querySelectorAll('video')).forEach(function (v) {
      if (!isVisible(v)) return;
      var r = v.getBoundingClientRect();
      if (r.top + (window.pageYOffset || 0) >= vh) return;           // starts below the first screen
      if (r.width * r.height < 0.25 * vw * vh) return;               // small video — not a hero
      considered++;
      // A poster attribute, or a CSS background image on the <video> itself: the browser shows it until the first frame is
      // available (checked in Chromium). Webflow's Background Video element uses the latter — its server HTML has
      // style="background-image:url(...-poster-00001.jpg)" on the <video> and no poster attribute (seen on a published Webflow site).
      var bgImg = '';
      try { bgImg = window.getComputedStyle(v).backgroundImage || ''; } catch (e) {}
      var hasPoster = !!(v.getAttribute('poster') || '').trim() || /url\(/i.test(bgImg);
      if (!hasPoster) bad.push({ v: v, area: r.width * r.height });
    });
    if (bad.length) {
      bad.sort(function (a, b) { return b.area - a.area; });
      var video = bad[0].v;
      var srcEl = video.currentSrc || video.getAttribute('src') || (video.querySelector('source') || {}).src || '';
      // The LCP element being this video AND a slow LCP makes it a real problem; otherwise it is a recommendation.
      var slowLcp = false;
      try {
        var last = lastLcpEntry();
        slowLcp = !!(last && last.element === video && last.startTime > 2500);
      } catch (e) {}
      addFinding({ category: 'Images', severity: slowLcp ? 'warning' : 'info',
        title: 'Above-the-fold video has no poster image',
        description: String(srcEl).replace(/\?.*$/, '').slice(0, 120),
        why: 'A large video at the top of the page shows an empty box until enough of the file has downloaded. For a <video>, LCP counts whichever comes first — the poster image or the first video frame — so a poster can make the first view and the Largest Contentful Paint (LCP, a Core Web Vital) earlier. Without it, how the video area looks while loading is left to the browser.',
        fix: 'Add a poster attribute to the <video> tag (poster="https://…/poster.avif" — an AVIF/WebP of the first frame) in the embed / custom code the video comes from. A Webflow Background Video element is not affected: Webflow already gives it a poster frame as a CSS background image on the <video>, so it is not reported here. Also provide an MP4 source next to a WebM one so every browser can play it.',
        element: video });
    } else if (considered > 0) {
      addSuccess({ category: 'Images', title: 'The above-the-fold video has a poster image', description: '', element: null });
    }
  }

  // Form fields need a label: a placeholder alone is not a reliable accessible name.
  function checkForms() {
    var fields = Array.prototype.slice.call(document.querySelectorAll('input, select, textarea')).filter(function (el) {
      if (el.tagName === 'INPUT') {
        var t = (el.getAttribute('type') || 'text').toLowerCase();
        if (['hidden', 'submit', 'button', 'reset', 'image'].indexOf(t) !== -1) return false;
      }
      if (el.disabled || el.closest('[aria-hidden="true"]')) return false; // honeypots / decorative
      if (el.getAttribute('tabindex') === '-1' && !isVisible(el)) return false;
      return isReachable(el);   // visible, or only in a closed tab / accordion / popup / menu (30.10.2026)
    });
    if (!fields.length) return;
    var unlabeled = 0;
    fields.forEach(function (el) {
      var hasLabel = !!(el.labels && el.labels.length) || !!el.closest('label') ||
        !!(el.getAttribute('aria-label') || '').trim() || !!(el.getAttribute('title') || '').trim();
      if (!hasLabel) {
        var by = (el.getAttribute('aria-labelledby') || '').trim();
        if (by) hasLabel = by.split(/\s+/).some(function (id) { var t = document.getElementById(id); return t && text(t); });
      }
      if (hasLabel) return;
      unlabeled++;
      var ph = (el.getAttribute('placeholder') || '').trim();
      addFinding({ category: 'Forms', severity: 'info', noScore: true, title: 'Form field has no accessible label',
        description: '<' + el.tagName.toLowerCase() + (el.getAttribute('type') ? ' type="' + el.getAttribute('type') + '"' : '') + (el.getAttribute('name') ? ' name="' + el.getAttribute('name') + '"' : '') + '>' +
          (ph ? '\nplaceholder: "' + ph.slice(0, 60) + '"' : ''),
        why: 'A placeholder disappears as soon as the visitor starts typing and is not a reliable accessible name, so screen readers and voice control may announce the field with no name at all. A <label> (or aria-label) is the standard fix. This is mainly an accessibility and usability issue — it has no direct ranking effect. This is an accessibility issue, so it is listed as a note and does not affect the score.',
        fix: 'In Webflow: select the field > Element settings (D) > give it a unique ID; then select the Label element above it > Element settings > Custom attributes > add "for" with the field\'s ID as the value. Alternatively add the custom attribute aria-label = "what the field is for" on the field itself.',
        element: el });
    });
    setCheckTotal('form.label', fields.length);
    if (!unlabeled) {
      addSuccess({ category: 'Forms', title: 'All ' + fields.length + ' form field(s) have a label', description: '', element: null });
    }
  }

  // ---------------------------------------------------------------------
  // 5.4 Links
  // ---------------------------------------------------------------------

  var GENERIC_ANCHOR = /^(klikni ovde|click here|read more|saznaj vi[sš]e|vi[sš]e|ovde|here|link)$/i;

  function checkLinks() {
    var links =Array.prototype.slice.call(document.querySelectorAll('a'));
    var internalToCheck = [], internalSeen = {};
    var checkedLinkCount = 0;
    var emptyHrefFound = false;
    var brokenAnchorFound = false;
    var noTextLinkFound = false;

    links.forEach(function (a) {
      var inCollapsedMenu = false, inPopup = false;
      if (!isVisible(a)) {
        // Hidden-but-reachable links (30.10.2026). A link inside a COLLAPSED navigation menu / dropdown
        // (e.g. the mobile menu) still gets only the "goes nowhere" check (the same links are normally also
        // visible in the desktop menu). A link inside a closed TAB / ACCORDION / SLIDER is real page content,
        // so it gets every link check. Popup / modal links get every check except "goes nowhere"
        // (href="#" is the standard close button there). Everything else that is hidden stays skipped.
        var hk = hiddenUiKind(a);
        if (!hk || hk === 'hidden') return;
        if (hk === 'menu' || hk === 'dropdown') inCollapsedMenu = true;
        else if (hk === 'popup') inPopup = true;
        if (!inCollapsedMenu) checkedLinkCount++;
      } else {
        checkedLinkCount++;
      }
      var href = a.getAttribute('href');
      var isEmpty = !href || href.trim() === '' || href.trim() === '#' || /^javascript:/i.test(href.trim());
      var hasCompensatingRole = a.getAttribute('role') === 'tab' || a.getAttribute('role') === 'button';

      if (isEmpty && !hasCompensatingRole && !inPopup) {
        emptyHrefFound = true;
        var linkLabel = (text(a) || (a.getAttribute('aria-label') || '').trim()).slice(0, 60);
        addFinding({ category: 'Links', severity: 'warning', title: 'Link doesn\'t go anywhere (href="' + (href || '') + '")',
          description: '"' + linkLabel + '"',
          why: inCollapsedMenu
            ? 'This link sits inside a collapsed menu (e.g. the mobile menu or a dropdown), so it is hidden until the menu is opened — but visitors still reach it with one click. With an empty href the click leads nowhere (with target="_blank" it just opens a new tab of the same page). This is typical for social icons or menu items whose real URL was never filled in.'
            : 'If this represents a tab/accordion that only changes the display on the same page, the correct approach per the WAI-ARIA Tabs pattern is a <button> with role="tab", not an <a> link — a link semantically implies navigation.',
          fix: inCollapsedMenu
            ? 'Fill in the real URL (Webflow Designer: select the link > Settings panel > Link settings > URL) and publish. If the destination does not exist yet, remove the link until it does. The menu is collapsed at the current window width — open it (or widen the window) to find the element.'
            : 'If the element doesn\'t navigate anywhere, change it to a <button> (or add role="tab"/role="button" plus the corresponding ARIA attributes). In Webflow, a link used only as an interaction trigger (e.g. closing a popup) is a very common pattern — if that is what this is, it is a minor note rather than a real problem.', element: a });
      }
      if (inCollapsedMenu) return; // hidden-menu links: only the empty-href check applies

      // In-page anchor targets
      if (href && href.charAt(0) === '#' && href.length > 1) {
        var targetId = href.slice(1);
        var targetDecoded = targetId;
        try { targetDecoded = decodeURIComponent(targetId); } catch (e) {}
        // HTML Standard, "select the indicated part": an element with that ID, then an <a name="..."> (first with the raw
        // fragment, then with the percent-decoded one); only if neither exists, "top" (ASCII case-insensitive) means the
        // top of the document. Verified in the spec source and in Chromium (a #top / #TOP link scrolls to the top with no element).
        var anchorTargetFound = false;
        [targetId, targetDecoded].forEach(function (t) {
          if (document.getElementById(t)) anchorTargetFound = true;
          Array.prototype.forEach.call(document.getElementsByName(t), function (n) { if (n.tagName === 'A') anchorTargetFound = true; });
        });
        var anchorSpecial = /^top$/i.test(targetDecoded);
        if (!anchorSpecial && !anchorTargetFound) {
          brokenAnchorFound = true;
          addFinding({ category: 'Links', severity: 'error', title: 'Anchor link points to an ID that doesn\'t exist (#' + targetId + ')',
            description: '"' + text(a).slice(0, 60) + '"', why: 'Clicking this link won\'t do anything since no element with that ID exists on the page.',
            fix: 'Check whether the target element was renamed or removed, and fix the href or ID.', element: a });
        }
      }

      var linkText = text(a);
      // Note (added after a rigorous review on 10.08.2026): before this fix, the check looked
      // ONLY at visible text and an <img> child — it ignored aria-label/aria-labelledby and SVG
      // icons (a common pattern for "icon-only" links, e.g. a button with an SVG icon and no
      // visible text but a valid aria-label). Without this check, the tool would falsely flag
      // perfectly correct, accessible links as "no text".
      var hasAriaLabel = !!(a.getAttribute('aria-label') && a.getAttribute('aria-label').trim());
      var hasAriaLabelledby = !!(a.getAttribute('aria-labelledby') && a.getAttribute('aria-labelledby').trim());
      var hasIconChild = !!a.querySelector('img, svg');
      if (!linkText && !hasIconChild && !hasAriaLabel && !hasAriaLabelledby) {
        noTextLinkFound = true;
        addFinding({ category: 'Links', severity: 'warning', title: 'Link with no text (and no image/icon/aria-label)',
          description: href || '(no href)', why: 'An empty link carries zero context for the user and for the crawler.',
          fix: 'Add visible text or an aria-label.', element: a });
      } else if (GENERIC_ANCHOR.test(linkText.trim())) {
        // Note: the title used to incorrectly say "Non-generic" (the opposite of the actual
        // meaning) — this branch fires exactly when the text IS generic (matches the
        // GENERIC_ANCHOR pattern).
        addFinding({ category: 'Links', severity: 'info', title: 'Generic anchor text: "' + linkText.trim() + '"',
          description: 'href: ' + href, why: 'Generic link text such as "click here" or "learn more" says nothing about the target page; descriptive link text tells users and Google what the linked page is about.',
          fix: 'Replace it with descriptive text (e.g. "View pricing" instead of "click here").', element: a });
      }

      if (href && !isEmpty && href.charAt(0) !== '#' && sameHost(href, LOC.hostname)) {
        // One request per distinct URL: the same link repeated in the header, body and footer must not use up the 25-request limit.
        var internalKey = '';
        try { var iu = new URL(href, LOC.href); iu.hash = ''; internalKey = iu.href; } catch (e) {}
        if (internalKey && internalKey !== LOC.href.replace(/#.*$/, '') && !internalSeen[internalKey]) {
          internalSeen[internalKey] = true;
          internalToCheck.push({ el: a, href: href });
        }
      }
    });

    ['links.nowhere', 'links.noText', 'links.generic'].forEach(function (id) { setCheckTotal(id, checkedLinkCount); });
    if (checkedLinkCount > 0 && !emptyHrefFound) {
      addSuccess({ category: 'Links', title: 'There are no links that go nowhere (all href attributes are valid)', description: '', element: null });
    }
    if (checkedLinkCount > 0 && !brokenAnchorFound) {
      addSuccess({ category: 'Links', title: 'All in-page anchor links (#id) point to existing elements', description: '', element: null });
    }
    if (checkedLinkCount > 0 && !noTextLinkFound) {
      addSuccess({ category: 'Links', title: 'All links have visible text or an image', description: '', element: null });
    }

    // 404 / redirect chain check for internal links (best-effort, limited count)
    var toCheck = HEADLESS ? [] : internalToCheck.slice(0, 25);   // the per-device frames skip this (same on every device)
    setCheckTotal('links.internal', toCheck.length);
    var linkCheckSettled = 0, linkCheckFailed = 0;
    var linkCheckProblemFound = false;
    function maybeReportLinkCheckSuccess() {
      linkCheckSettled++;
      if (linkCheckSettled === toCheck.length) {
        // Requests the browser blocked (CSP / network) prove nothing: never report them as "successful".
        if (linkCheckFailed === toCheck.length) reportCheckSkipped('Internal link check (404 / redirects)', [CSP_OR_NETWORK]);
        else if (!linkCheckProblemFound) {
          var okCount = toCheck.length - linkCheckFailed;
          addSuccess({ category: 'Links', title: 'All checked internal links (' + okCount + ') return a successful response with no 404/redirect',
            description: '', element: null });
          renderPanel();
        }
      }
    }
    toCheck.forEach(function (item) {
      try {
        fetch(item.href, { method: 'GET', redirect: 'manual' }).then(function (r) {
          if (r.status === 404) {
            linkCheckProblemFound = true;
            addFinding({ category: 'Links', severity: 'error', title: 'Internal link leads to a 404 page',
              description: item.href, why: 'A broken internal link hurts both user experience and crawl efficiency.',
              fix: 'Fix the link, or restore/rename the target page.', element: item.el });
            renderPanel();
          } else if (r.type === 'opaqueredirect' || (r.status >= 300 && r.status < 400)) {
            linkCheckProblemFound = true;
            addFinding({ category: 'Links', severity: 'info', title: 'Internal link goes through a redirect',
              description: item.href, why: 'It isn\'t broken, but every visit through this link costs an extra request before the page loads.',
              fix: 'If possible, update the link to point directly to the final URL.', element: item.el,
              ownerNote: 'In Webflow you can only point the link straight at the final URL. If the redirect itself is configured at the reverse proxy / Cloudflare / app level (e.g. www → app subdomain), removing it needs access to that platform.' });
            renderPanel();
          }
          maybeReportLinkCheckSuccess();
        }).catch(function () { linkCheckFailed++; maybeReportLinkCheckSuccess(); });
      } catch (e) { linkCheckFailed++; maybeReportLinkCheckSuccess(); }
    });
  }

  // ---------------------------------------------------------------------
  // 5.5 Content
  // ---------------------------------------------------------------------

  var PLACEHOLDER_PATTERNS = [
    /lorem ipsum/i, /\[insert[^\]]*\]/i, /\{\{.*?\}\}/, /your text here/i,
    /client name here/i, /placeholder text/i, /dolor sit amet/i
  ];

  function checkContent() {
    var main = document.querySelector('main') || document.body;

    // Text that is hidden only because a tab / accordion / dropdown / slider is closed is real content
    // (visitors reach it with a click, Google indexes it) — it counts for the "thin content" and the
    // placeholder checks (30.10.2026). Keyed to the TOPMOST hidden container, scripts/styles removed.
    var uiHiddenText = '';
    (function () {
      var blocks = [];
      Array.prototype.slice.call(main.querySelectorAll('*')).forEach(function (el) {
        if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|SVG)$/i.test(el.tagName)) return;
        if (blocks.some(function (b) { return b.contains(el); })) return;
        var st = window.getComputedStyle(el);
        if (st.display !== 'none') return;
        if (CONTENT_UI_KINDS.indexOf(hiddenUiKind(el)) === -1) return;
        blocks.push(el);
        var c = el.cloneNode(true);
        Array.prototype.forEach.call(c.querySelectorAll('script,style,noscript,template'), function (n) { n.remove(); });
        Array.prototype.forEach.call(c.querySelectorAll('*'), function (n) { n.insertAdjacentText('afterend', '\n'); });   // keep words from different elements apart (a line break: the repeated-word check doesn't match across it)
        uiHiddenText += '\n' + (c.textContent || '');
      });
    })();
    // Thin content
    var visibleTextLen = (text(main) + ' ' + uiHiddenText).replace(/\s+/g, ' ').trim().length;
    if (visibleTextLen < 200) {
      addFinding({ category: 'Content', severity: 'warning', title: 'Very little visible text on the page (' + visibleTextLen + ' characters)',
        description: '', why: 'There is no minimum word count, but search engines need descriptive text to understand a page. This page has under 200 characters of visible text, so it is nearly empty.',
        fix: 'Add more relevant, useful content.', element: main,
        crossRelevant: true, crossNote: 'Relevant to both SEO and AEO — important content has to be available as text for AI Overviews and AI Mode too.',
        crossNoteReverse: 'Relevant to both SEO and AEO — search engines need descriptive text to understand what the page is about.' });
    } else {
      addSuccess({ category: 'Content', title: 'The page has enough visible text (' + visibleTextLen + ' characters)', description: '', element: main,
        crossRelevant: true, crossNote: 'Relevant to both SEO and AEO — important content has to be available as text for AI Overviews and AI Mode too.',
        crossNoteReverse: 'Relevant to both SEO and AEO — search engines need descriptive text to understand what the page is about.' });
    }

    // Hidden content (potential keyword stuffing) — reworked 28.10.2026 after testing on
    // honeybook.com: <script>/<style>/<noscript>/<template> are display:none by default (so they
    // always matched), and Webflow UI (nav dropdowns, popups, tabs, accordions, sliders) is hidden
    // BY DESIGN. Now: skip those tags, skip anything inside typical UI containers, look only at the
    // TOPMOST hidden element, and report everything as ONE merged finding instead of one per element.
    var HIDDEN_SKIP_TAGS = /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|HEAD|META|LINK|TITLE|SVG|DEFS|SYMBOL)$/i;
    var HIDDEN_UI_SELECTOR = [
      'nav', 'details', '[role="dialog"]', '[role="menu"]', '[role="tabpanel"]', '[aria-modal="true"]',
      '[class*="popup" i]', '[class*="modal" i]', '[class*="dropdown" i]', '[class*="accordion" i]',
      '[class*="w-tab" i]', '[class*="tabs" i]', '[class*="faq" i]', '[class*="menu" i]', '[class*="lightbox" i]',
      '[class*="w-slide" i]', '[class*="slider" i]', '[class*="navbar" i]', '[class*="w-nav" i]',
      '[class*="tooltip" i]', '[class*="toast" i]', '[class*="overlay" i]', '[class*="cookie" i]', '[class*="consent" i]',
      // 12.11.2026: consent-manager widgets whose class names don't say "cookie"/"consent" (honeybook.com: Osano)
      '[class*="osano" i]', '#onetrust-consent-sdk', '#CybotCookiebotDialog', '#usercentrics-root', '#didomi-host', '[class*="termly" i]', '[class*="iubenda" i]'
    ].join(',');
    var allBodyEls = Array.prototype.slice.call(document.querySelectorAll('body *'));
    var hiddenBlocks = [];
    var hiddenTexts = [];
    hiddenContentBlocks = [];
    for (var hi = 0; hi < allBodyEls.length; hi++) {
      var hel = allBodyEls[hi];
      if (HIDDEN_SKIP_TAGS.test(hel.tagName)) continue;
      var hstyle = window.getComputedStyle(hel);
      if (hstyle.display !== 'none' && hstyle.visibility !== 'hidden') continue;
      if (hstyle.display !== 'none' && animStartHidden(hel)) continue;   // scroll-in animation, shown when scrolled to
      if (hiddenBlocks.some(function (blk) { return blk.contains(hel); })) continue;
      var inUi = false;
      try { inUi = !!hel.closest(HIDDEN_UI_SELECTOR); } catch (e) {}
      if (inUi) continue;
      // Text WITHOUT <script>/<style>/<noscript>/<template> descendants: Webflow Embed elements
      // (".w-embed" with display:none) are wrappers around inline CSS/JS, which is code, not content.
      var hclone = hel.cloneNode(true);
      Array.prototype.forEach.call(hclone.querySelectorAll('script,style,noscript,template'), function (n) { n.remove(); });
      var htxt = (hclone.textContent || '').replace(/\s+/g, ' ').trim();
      if (htxt.length > 60) {
        hiddenBlocks.push(hel); hiddenTexts.push(htxt);
        Array.prototype.forEach.call(hclone.querySelectorAll('*'), function (n) { n.insertAdjacentText('afterend', ' '); });
        hiddenContentBlocks.push({ el: hel, txt: htxt, key: normText(hclone.textContent || '') });
      }
    }
    if (hiddenBlocks.length) {
      addFinding({ category: 'Content', severity: 'info',
        title: 'Hidden content with a substantial amount of text (' + hiddenBlocks.length + ' block' + (hiddenBlocks.length === 1 ? '' : 's') + ', display:none/visibility:hidden)',
        description: 'First ' + Math.min(3, hiddenBlocks.length) + ':\n' + hiddenTexts.slice(0, 3).map(function (t) { return '"' + t.slice(0, 80) + '..."'; }).join('\n'),
        why: 'Google\'s spam policies define hidden text as content placed "solely to manipulate search engines and not to be easily viewable by human visitors"; tabs, accordions and sliders are explicitly allowed. A forgotten hidden block is not spam, but it is content visitors can\'t see. Menus, popups, tabs, accordions and sliders are ignored here, since they are hidden by design.',
        fix: 'Check whether this content should be visible, or remove it if it\'s leftover from development.', element: hiddenBlocks[0] });
    }

    // Repeated consecutive word
    var bodyText = text(main) + '\n' + uiHiddenText;
    // 12.11.2026: only spaces between the two words, no line break. innerText puts a line break between separate
    // blocks, and a button "Explore resources" above a heading "Resources to help you" is not a typo
    // (false positive found on honeybook.com, mobile layout).
    var repeatRegex = /\b(\w{2,})[ \t\u00a0]+\1\b/gi;
    var seenRepeats = {};
    var m;
    var repeatedWordFound = false;
    while ((m = repeatRegex.exec(bodyText)) !== null) {
      var word = m[1].toLowerCase();
      if (seenRepeats[word]) continue;
      seenRepeats[word] = true;
      repeatedWordFound = true;
      addFinding({ category: 'Content', severity: 'warning', title: 'Repeated word in a row: "' + m[0].replace(/\s+/g, ' ') + '"',
        description: '...' + bodyText.slice(Math.max(0, m.index - 30), m.index + 30) + '...',
        why: 'Most often a copy-paste mistake.', fix: 'Remove the duplicate word.', element: null });
    }
    if (!repeatedWordFound) {
      addSuccess({ category: 'Content', title: 'No repeated words in a row (copy-paste mistake)', description: '', element: null });
    }

    // Placeholder text
    var placeholderFound = false;
    PLACEHOLDER_PATTERNS.forEach(function (re) {
      var mm = bodyText.match(re);
      if (mm) {
        placeholderFound = true;
        addFinding({ category: 'Content', severity: 'error', title: 'Placeholder/Lorem ipsum text found on the page',
          description: '"...' + bodyText.slice(Math.max(0, bodyText.indexOf(mm[0]) - 20), bodyText.indexOf(mm[0]) + 60) + '..."',
          why: 'A common case is when a CMS Rich Text element isn\'t properly bound to the real data, so the default value is left in place.',
          fix: 'Replace the placeholder text with real content before publishing.', element: null });
      }
    });
    if (!placeholderFound) {
      addSuccess({ category: 'Content', title: 'No placeholder/Lorem ipsum text on the page', description: '', element: null });
    }

  }

  // ---------------------------------------------------------------------
  // 5.6 Fonts
  // ---------------------------------------------------------------------

  function checkFonts() {
    var textEls = Array.prototype.slice.call(document.querySelectorAll('body *')).filter(function (el) {
      return el.childNodes && Array.prototype.some.call(el.childNodes, function (n) { return n.nodeType === 3 && n.textContent.trim(); });
    });
    var families = {};
    textEls.slice(0, 1500).forEach(function (el) {
      var ff = window.getComputedStyle(el).fontFamily;
      var primary = (ff || '').split(',')[0].replace(/["']/g, '').trim();
      if (primary) families[primary] = true;
    });
    var distinct = Object.keys(families);
    // 12.11.2026: only web fonts (loaded with @font-face) are counted. System fonts such as Helvetica or system-ui
    // are already on the device and download nothing (honeybook.com listed "Helvetica" and "system-ui").
    try {
      if (document.fonts && typeof document.fonts.forEach === 'function') {
        var webFams = {};
        document.fonts.forEach(function (ffc) { webFams[String(ffc.family || '').replace(/["']/g, '').trim().toLowerCase()] = true; });
        distinct = distinct.filter(function (f) { return webFams[f.toLowerCase()]; });
      }
    } catch (e) {}

    if (distinct.length >= 4) {
      // 06.11.2026: web.dev advises "Use fewer web fonts" but gives no number, so this is a note only (noScore).
      addFinding({ category: 'Fonts', severity: 'info', noScore: true, title: 'The page uses ' + distinct.length + ' different web fonts: ' + distinct.join(', '),
        description: '', why: 'Each extra font is more to download before the text shows in it, so fewer web fonts are better. There is no exact limit, so this is a note only and does not affect the score.',
        fix: 'If the design allows, use fewer font families, or a variable font (one file can replace several weights, e.g. light, regular and bold).', element: null });
    } else if (distinct.length >= 2) {
      addFinding({ category: 'Fonts', severity: 'info', noScore: true, title: 'The page uses ' + distinct.length + ' web fonts: ' + distinct.join(', '),
        description: '', why: 'Informational only — doesn\'t affect the SEO score, but worth being aware of.',
        fix: '', element: null });
    } else if (distinct.length === 1) {
      addSuccess({ category: 'Fonts', title: 'The page uses only 1 web font (' + distinct[0] + ') — minimal risk of FOUT/FOIT', description: '', element: null });
    }

    // Google Fonts vs self-hosted
    var links = Array.prototype.slice.call(document.querySelectorAll('link[href], style'));
    var usesGoogleFonts = false;
    links.forEach(function (el) {
      var src = el.tagName === 'LINK' ? el.getAttribute('href') : el.textContent;
      if (src && /fonts\.googleapis\.com|fonts\.gstatic\.com/i.test(src)) usesGoogleFonts = true;
    });
    // Webflow's own "Google Fonts" setting loads them with the WebFont loader from an inline script:
    //   the WebFont loader called with a "google" families option — there is no <link> to fonts.googleapis.com in the HTML.
    // Fonts that were really requested are also visible in the resource timing entries.
    try {
      Array.prototype.forEach.call(document.querySelectorAll('script:not([src])'), function (sc) {
        var scTxt = sc.textContent || '';
        if (scTxt.indexOf('seoAuditorMain') !== -1) return;   // never read this tool's own source (it can be injected as a <script>)
        if (/WebFont\.load\s*\(\s*\{[^]*?google\s*:/i.test(scTxt)) usesGoogleFonts = true;
      });
      performance.getEntriesByType('resource').forEach(function (e) {
        if (/^https?:\/\/fonts\.(googleapis|gstatic)\.com\//i.test(e.name)) usesGoogleFonts = true;
      });
    } catch (e) {}
    if (usesGoogleFonts) {
      addFinding({ category: 'Fonts', severity: 'warning', title: 'The page dynamically loads Google Fonts from Google\'s servers',
        description: '', why: 'A German court (LG München I, 01/2022) ruled that dynamically loading Google Fonts without consent sends the visitor\'s IP address to Google without a legal basis under the GDPR, which triggered a wave of warning letters (mostly in Germany, but the GDPR applies across the EU). We are not legal advisors — check with a lawyer if this is relevant for the client.',
        fix: 'Host the font yourself: download the font files and upload them in Site settings > Fonts tab > Custom fonts (WOFF2 is the best format), and stop using the Google font. Webflow\'s Google Fonts integration sends visitors\' IP addresses to Google and may not be GDPR-compliant. If the uploaded font has the same name as a Google font (e.g. Montserrat), rename it (e.g. "Montserrat-Regular-1"), otherwise Webflow may keep loading it from Google.', element: null });
    } else {
      addSuccess({ category: 'Fonts', title: 'No dynamic loading of Google Fonts from Google\'s servers (GDPR risk avoided)', description: '', element: null });
    }

    // Font format check
    try {
      document.fonts.forEach(function (f) {
        // The FontFace API doesn't always expose the src URL directly; best effort via toString()
      });
    } catch (e) {}
    var oldFormatFound = false;
    var fontFaceRuleFound = false;
    var oldFormatWhat = [];
    // 12.11.2026: only fonts this page actually uses count. A font uploaded to the project in an older format but not
    // used on the page is never downloaded (honeybook.com: "Proxima Nova" .otf declared, unused; all 5 downloaded fonts .woff2).
    var loadedFams = null;
    try {
      if (document.fonts && typeof document.fonts.forEach === 'function') {
        loadedFams = {};
        document.fonts.forEach(function (ffc) { if (ffc.status === 'loaded') loadedFams[String(ffc.family || '').replace(/["']/g, '').trim().toLowerCase()] = true; });
      }
    } catch (e) { loadedFams = null; }
    var sheets = document.styleSheets;
    for (var i = 0; i < sheets.length; i++) {
      try {
        var rules = sheets[i].cssRules || [];
        for (var j = 0; j < rules.length; j++) {
          if (rules[j].constructor.name === 'CSSFontFaceRule' || (rules[j].cssText && /@font-face/.test(rules[j].cssText))) {
            fontFaceRuleFound = true;
            if (/\.(ttf|otf|eot)(\?|"|'|\))/i.test(rules[j].cssText) && !/\.woff2/i.test(rules[j].cssText)) {
              var ffam = '';
              try { ffam = String(rules[j].style.getPropertyValue('font-family') || '').replace(/["']/g, '').trim(); } catch (x) {}
              if (!loadedFams || (ffam && loadedFams[ffam.toLowerCase()])) {
                oldFormatFound = true;
                if (ffam && oldFormatWhat.indexOf(ffam) === -1) oldFormatWhat.push(ffam);
              }
            }
          }
        }
      } catch (e) { /* cross-origin stylesheet, can't read rules */ }
    }
    // Webflow's stylesheet lives on another origin (its rules cannot be read above), so look at the font files the browser
    // actually downloaded: it takes the first format it supports, so a .woff/.ttf/.otf/.eot request means there was nothing better.
    try {
      performance.getEntriesByType('resource').forEach(function (e) {
        var pth = ''; try { pth = new URL(e.name).pathname; } catch (x) {}
        var fx = /\.(woff2|woff|ttf|otf|eot)$/i.exec(pth);
        if (!fx) return;
        fontFaceRuleFound = true;
        if (/^(woff|ttf|otf|eot)$/i.test(fx[1])) {
          oldFormatFound = true;
          var fname = ''; try { fname = decodeURIComponent(pth.split('/').pop()); } catch (x) { fname = pth.split('/').pop(); }
          if (fname && oldFormatWhat.indexOf(fname) === -1) oldFormatWhat.push(fname);
        }
      });
    } catch (e) {}
    if (oldFormatFound) {
      addFinding({ category: 'Fonts', severity: 'info', title: 'Font file in an older format (not .woff2)',
        description: oldFormatWhat.slice(0, 6).join('\n'), why: 'WOFF2 has the widest browser support and the best compression (about 30% smaller than WOFF), so it is the only font format needed today.',
        fix: 'Convert the font files to .woff2 and upload them in Site settings > Fonts tab > Custom fonts.', element: null });
    } else if (fontFaceRuleFound) {
      addSuccess({ category: 'Fonts', title: 'All font files used on this page are in the modern .woff2 format', description: '', element: null });
    }
  }

  // ---------------------------------------------------------------------
  // 5.7 Technical / crawlability
  // ---------------------------------------------------------------------

  function checkTechnical() {
    // Duplicate IDs - informational only
    var idMap = {};
    var dupIdFound = false;
    Array.prototype.forEach.call(document.querySelectorAll('[id]'), function (el) {
      var id = el.id;
      if (!id) return;
      (idMap[id] = idMap[id] || []).push(el);
    });
    Object.keys(idMap).forEach(function (id) {
      if (idMap[id].length > 1) {
        dupIdFound = true;
        addFinding({ category: 'Technical / crawlability', severity: 'info', title: 'Duplicate ID attribute: "' + id + '" (' + idMap[id].length + ' times)',
          description: '', why: 'Duplicate IDs break in-page anchor links and ARIA references (aria-controls, aria-labelledby) that rely on a unique ID. Usually the result of copying an entire section without changing the ID.',
          fix: 'Rename the duplicates to unique IDs.', element: idMap[id][1] });
      }
    });
    if (!dupIdFound && Object.keys(idMap).length > 0) {
      addSuccess({ category: 'Technical / crawlability', title: 'No duplicate ID attributes on the page', description: '', element: null });
    }

    // DOM size / depth (Lighthouse-style thresholds, recommendation only)
    var totalNodes = document.body ? document.body.querySelectorAll('*').length : 0;   // Lighthouse counts the nodes in <body>
    var maxDepth = 0, maxChildren = 0;
    (function walk(el, depth) {
      if (depth > maxDepth) maxDepth = depth;
      var childCount = el.children ? el.children.length : 0;
      if (childCount > maxChildren) maxChildren = childCount;
      for (var i = 0; i < childCount; i++) walk(el.children[i], depth + 1);
    })(document.body, 0);

    if (totalNodes > 1400) {   // Lighthouse "Avoid an excessive DOM size": errors above ~1,400 <body> nodes; depth/children limits have no current source (06.11.2026)
      addFinding({ category: 'Technical / crawlability', severity: 'info', title: 'Large/deeply nested DOM (nodes: ' + totalNodes + ', max depth: ' + maxDepth + ', max children of one element: ' + maxChildren + ')',
        description: '', why: 'A page with more than about 1,400 elements in <body> is considered to have an excessive DOM size. This is a recommendation, not an error — if it\'s intentional and doesn\'t cause a visible problem, it can be ignored.',
        fix: 'Consider simplifying the section structure (fewer nested wrapper divs).', element: null });
    } else {
      addSuccess({ category: 'Technical / crawlability', title: 'DOM size/depth is within reasonable limits (nodes: ' + totalNodes + ', max depth: ' + maxDepth + ')', description: '', element: null });
    }

    // Mixed content
    if (LOC.protocol === 'https:') {
      var httpResources = Array.prototype.slice.call(document.querySelectorAll(
        'img[src^="http://" i], script[src^="http://" i], iframe[src^="http://" i], video[src^="http://" i], audio[src^="http://" i], source[src^="http://" i], video[poster^="http://" i], ' +
        // <link>: only the ones that load a resource. canonical / alternate / dns-prefetch / author are plain references, not mixed content.
        'link[rel~="stylesheet"][href^="http://" i], link[rel~="icon"][href^="http://" i], link[rel~="preload"][href^="http://" i], link[rel~="modulepreload"][href^="http://" i], link[rel~="manifest"][href^="http://" i], link[rel~="apple-touch-icon"][href^="http://" i]'));
      httpResources.forEach(function (el) {
        addFinding({ category: 'Technical / crawlability', severity: 'error', title: 'Mixed content: HTTP resource on an HTTPS page',
          description: (el.currentSrc || el.src || el.href || el.getAttribute('poster') || ''), why: 'The browser may block or warn about this resource, and it is a security signal.',
          fix: 'Change the resource URL to https://.', element: el });
      });
      if (!httpResources.length) {
        addSuccess({ category: 'Technical / crawlability', title: 'No mixed content — all resources load over HTTPS', description: '', element: null });
      }
    }

    // Third-party scripts without async/defer — reworked 28.10.2026 (honeybook.com audit):
    //  - POSITION matters: in <head> a sync script blocks parsing (error); at the end of <body> it
    //    blocks almost nothing (info);
    //  - Webflow's OWN scripts (jQuery from Webflow's CDN, the generated site JS on website-files.com)
    //    can't be changed in the Designer or in Custom Code -> info, excluded from the score;
    //  - consent managers are usually loaded synchronously on purpose -> info;
    //  - ownerNote says who can actually fix it (Cloudflare / tag manager / reverse proxy).
    function isWebflowPlatformScript(host, src) {
      return host === 'd3e54v103j8qbb.cloudfront.net' ||
        (/(^|\.)website-files\.com$/.test(host) && /\/(js|gsap)\//.test(src)) ||
        /(^|\.)webflow\.(com|io)$/.test(host);
    }
    var CONSENT_HOST_RE = /(osano|consentpro|cookiebot|onetrust|cookielaw|usercentrics|cookieyes|iubenda|termly|trustarc|didomi|quantcast)/i;
    var scripts = Array.prototype.slice.call(document.querySelectorAll('head script[src], body script[src]'));
    var thirdPartyScriptCount = 0;
    var blockingScriptFound = false;
    var platformScriptFlagged = false;
    scripts.forEach(function (s) {
      var src = s.getAttribute('src');
      var host = hostnameOf(src);
      if (!host || host === LOC.hostname) return;
      var isPlatform = isWebflowPlatformScript(host, src);
      if (!isPlatform) thirdPartyScriptCount++;
      if (s.async || s.defer || (s.getAttribute('type') || '').toLowerCase() === 'module') return;   // module scripts are deferred by default

      var inHead = !!s.closest('head');
      var isConsent = CONSENT_HOST_RE.test(host);
      var isCloudflare = /(^|\.)cloudflareinsights\.com$/.test(host);
      var current = '<script src="' + src + '"></script>';
      var suggested = '<script src="' + src + '" defer></script>';
      var finding = {
        category: 'Technical / crawlability',
        severity: (inHead && !isPlatform && !isConsent) ? 'error' : 'info',
        title: 'Third-party script without async/defer (' + host + ')',
        description: 'Current:\n' + current + '\n\nSuggested:\n' + suggested,
        // Dedicated field (11.08.2026) for the "Copy suggested code" button — separate from
        // `fix` (a prose recommendation) and from `description` (the human-readable
        // Current/Suggested comparison shown in the panel), so the copy action grabs just
        // the ready-to-paste <script> tag, not the "Current:"/"Suggested:" labels around it.
        suggestedCode: suggested,
        why: 'A <script> in the <head> without defer or async blocks the first paint of the page until it has been downloaded and run.' +
          (inHead ? '' : ' This one sits at the end of <body>, where it blocks very little (it mostly delays DOMContentLoaded), so it is only a minor note.'),
        fix: 'Add the "defer" attribute (recommended for scripts where execution order/DOM readiness matters — most chat widgets and tracking pixels) or "async" (for fully independent scripts). Even better: move the script out of the <head> to Page settings > Custom code > Before </body> tag (site-wide: Site settings > Custom code tab > Footer code) — scripts before the closing </body> tag don\'t block the first paint.',
        element: s };
      if (isPlatform) {
        platformScriptFlagged = true;
        finding.title = 'Webflow platform script without async/defer (' + host + ')';
        finding.description = src.replace(/\?.*$/, '').slice(0, 140);
        delete finding.suggestedCode;
        finding.why = 'This script is added automatically by Webflow to every published page (jQuery / the generated site JavaScript) and sits at the end of <body>.';
        finding.fix = 'No action needed — Webflow does not let you change its attributes.';
        finding.ownerNote = 'Added by the Webflow platform itself — there is no option in the Designer or in Custom Code to change it. Not counted in the optimization score.';
        finding.noScore = true;
      } else if (isCloudflare) {
        blockingScriptFound = true;
        finding.ownerNote = 'Needs access to Cloudflare (or whoever manages the CDN / reverse proxy in front of the site) — it is not part of the Webflow project, so it can\'t be changed from there.';
      } else if (isConsent) {
        blockingScriptFound = true;
        finding.why = 'Cookie-consent managers are usually loaded synchronously on purpose, so they can run before any tracking script. Check the provider\'s documentation before adding async/defer.';
        finding.fix = 'Usually leave as is. Only change it if the provider\'s docs say deferring is supported.';
      } else {
        blockingScriptFound = true;
        if (!inHead) finding.ownerNote = 'If this script is not in the project\'s Custom Code, it is most likely loaded by a tag manager (e.g. Google Tag Manager) or injected by a reverse proxy — then it has to be changed there, by whoever manages that platform.';
      }
      addFinding(finding);
    });
    if (thirdPartyScriptCount > 0 && !blockingScriptFound) {
      addSuccess({ category: 'Technical / crawlability', title: 'All third-party scripts (' + thirdPartyScriptCount + ') have async/defer' + (platformScriptFlagged ? ' (not counting Webflow\'s own scripts)' : ''), description: '', element: null });
    }
  }

  // ---------------------------------------------------------------------
  // 5.9 Special handling: nav/footer (post-processing)
  // ---------------------------------------------------------------------

  function tagGlobalFindings() {
    findings.forEach(function (f) {
      if (f.element) {
        var landmark = closestLandmark(f.element);
        if (landmark) {
          f.globalElement = true;
          f.globalNote = 'Global element (' + landmark.tagName.toLowerCase() + ') — likely a Symbol/Component that repeats across all pages of the site. Fixing it in one place resolves the issue site-wide. A quick check on 1-2 other pages is recommended.';
        }
      }
    });
  }

  // ---------------------------------------------------------------------
  // 5.8 Core Web Vitals (native browser APIs, no Lighthouse)
  // ---------------------------------------------------------------------

  var cwv = { lcp: null, cls: 0, ttfb: null };

  // LCP and layout-shift entries are NOT returned by performance.getEntriesByType() — they can only be read through a
  // PerformanceObserver with buffered:true (verified in Chromium 02.11.2026; before that fix LCP was never measured and CLS was
  // always 0). Observers deliver their buffered entries asynchronously, so run() starts the audit from the callback of
  // startPerfObservers() (about 120 ms later) and the checks that need the LCP element read it from perfLcp.
  var perfLcp = [], perfShifts = [];
  // INP (05.11.2026): Event Timing entries. With buffered:true the browser hands over the PAST interactions that lasted
  // 104 ms or more (W3C Event Timing: the default buffering threshold) plus the "first-input" entry (always buffered);
  // new interactions while the panel is open arrive live (see updateInp()).
  var perfEvents = [], perfFirstInput = [], perfAuditStart = 0;
  function lastLcpEntry() { return perfLcp.length ? perfLcp[perfLcp.length - 1] : null; }
  function startPerfObservers(cb) {
    try {
      if (window.PerformanceObserver) {
        var o1 = new PerformanceObserver(function (l) { l.getEntries().forEach(function (e) { perfLcp.push(e); }); });
        o1.observe({ type: 'largest-contentful-paint', buffered: true });
        var o2 = new PerformanceObserver(function (l) { l.getEntries().forEach(function (e) { perfShifts.push(e); }); });
        o2.observe({ type: 'layout-shift', buffered: true });
      }
    } catch (e) {}
    perfAuditStart = performance.now();
    try {
      // durationThreshold 16 (the minimum): while the panel is open even short interactions are recorded; the
      // buffered (earlier) ones are only those of 104 ms or longer, plus the first one.
      new PerformanceObserver(function (l) {
        var added = false;
        // 06.11.2026: a click inside the audit panel doesn't count for INP, so it must not re-render the panel either
        // (the re-render replaced the category dropdown right after it opened, so it closed by itself).
        var auditHost = document.getElementById('seo-audit-host');
        l.getEntries().forEach(function (e) {
          perfEvents.push(e);
          if (e.interactionId && !(auditHost && e.target && (e.target === auditHost || auditHost.contains(e.target)))) added = true;
        });
        if (added) scheduleInpUpdate();
      }).observe({ type: 'event', buffered: true, durationThreshold: 16 });
      new PerformanceObserver(function (l) { l.getEntries().forEach(function (e) { perfFirstInput.push(e); }); scheduleInpUpdate(); }).observe({ type: 'first-input', buffered: true });
    } catch (e) {}
    setTimeout(cb, 120);
  }
  // CLS as Google defines it: the largest "session window" of shifts (a window ends after a 1 s gap between shifts or at 5 s),
  // not the sum of every shift on a long-lived page. Shifts right after a user input are excluded.
  function computeCls() {
    var best = 0, cur = 0, first = 0, prev = 0;
    perfShifts.forEach(function (e) {
      if (e.hadRecentInput) return;
      if (cur && e.startTime - prev < 1000 && e.startTime - first < 5000) cur += e.value;
      else { cur = e.value; first = e.startTime; }
      prev = e.startTime;
      if (cur > best) best = cur;
    });
    return Math.round(best * 1000) / 1000;
  }

  // INP — Interaction to Next Paint (05.11.2026). Only a real click / tap / key press creates it: events fired by a
  // script (like this bookmarklet) are "untrusted" and get no interactionId (W3C Event Timing; checked in Chromium).
  // So the visitor has to interact: interactions made before the audit count, and so do the ones made on the page
  // while the panel is open — the result and the score update live. Clicks inside the panel are not counted
  // (the browser reports them on the panel's host element). An interaction's latency = the longest event duration
  // with the same interactionId; the page's INP = the worst interaction (web.dev: Google ignores one highest
  // interaction per 50 — only relevant with 50+ interactions). Thresholds (web.dev): <= 200 ms good, > 500 ms poor.
  var inpReady = false, inpTimer = null;
  function scheduleInpUpdate() {
    if (!inpReady) return;
    clearTimeout(inpTimer);
    inpTimer = setTimeout(function () {
      updateInp();
      try { tagGlobalFindings(); } catch (e) {}
      renderPanel();
      try { if (!analysis.busy) saveCurrentRun(); } catch (e) {}
    }, 250);
  }
  function updateInp() {
    var CWV_NOTE = 'Relevant to both SEO and AEO — a good page experience also matters for AI Overviews and AI Mode.';
    var CWV_NOTE_REV = 'Relevant to both SEO and AEO — good Core Web Vitals are part of what Google\'s ranking systems reward.';
    try {
      // drop the previous INP result (it is replaced, never duplicated)
      for (var i = findings.length - 1; i >= 0; i--) if (findings[i].inpItem) findings.splice(i, 1);
      for (var j = successes.length - 1; j >= 0; j--) if (successes[j].inpItem) successes.splice(j, 1);
      var host = document.getElementById('seo-audit-host');
      var byId = {}, nInter = 0, worst = null;
      perfEvents.concat(perfFirstInput).forEach(function (e) {
        if (!e.interactionId) return;
        if (host && e.target && (e.target === host || host.contains(e.target))) return;   // a click in the audit panel
        var prevE = byId[e.interactionId];
        if (!prevE) { nInter++; byId[e.interactionId] = e; } else if (e.duration > prevE.duration) byId[e.interactionId] = e;
      });
      Object.keys(byId).forEach(function (k) { if (!worst || byId[k].duration > worst.duration) worst = byId[k]; });
      var HOW = 'With this panel open, click or tap things on the page that open or change something on the same page — the menu, tabs, accordions, sliders, dropdowns, form fields. The INP result appears here right away and updates the score. Avoid ordinary links: they open another page and close the panel. Clicks inside this panel are not counted.';
      if (!worst) {
        addFinding({ inpItem: true, category: 'Performance (CWV)', severity: 'info', noScore: true, title: 'INP not measured yet — click something on the page',
          description: '',
          why: 'INP (Interaction to Next Paint) is the Core Web Vital for responsiveness. Only a real click, tap or key press creates it — scrolling and hovering don\'t count, and the bookmarklet can\'t click for you (clicks made by a script are not counted by the browser). Until you interact, INP has no value and does not affect the score.',
          fix: HOW, element: null });
        return;
      }
      var inp = Math.round(worst.duration), tgt = worst.target && worst.target.nodeType === 1 ? worst.target : null;
      var tgtTxt = tgt ? ('<' + elLabel(tgt) + '>') : '';
      var inpDesc = 'Slowest of ' + nInter + ' interaction(s) measured: ' + worst.name + (tgtTxt ? ' on ' + tgtTxt : '') + '. Keep clicking the menu, tabs, accordions... to measure more — the result updates here.';
      if (inp > 200) {
        var inpPoor = inp > 500;
        addFinding({ inpItem: true, check: 'cwv.inp', category: 'Performance (CWV)', severity: inpPoor ? 'error' : 'warning', title: 'Slow INP (Interaction to Next Paint): ' + inp + 'ms',
          description: inpDesc,
          why: 'An INP at or below 200 ms is good, above 200 ms needs improvement and above 500 ms is poor' + (inpPoor ? ' — this one is poor' : '') + '. INP is a Core Web Vital, part of what Google\'s ranking systems reward. Measured here, in this browser on this computer; Google uses data from real visitors (75th percentile of page loads).',
          fix: 'Record the slow interaction in Chrome DevTools > Performance and see what runs on that click (custom code, third-party scripts, heavy animations), then make it lighter or defer it.', element: tgt,
          crossRelevant: true, crossNote: CWV_NOTE, crossNoteReverse: CWV_NOTE_REV });
      } else {
        addSuccess({ inpItem: true, check: 'cwv.inp', category: 'Performance (CWV)', title: 'INP is good (' + inp + 'ms, at or under Google\'s 200ms threshold)', description: inpDesc, element: null,
          crossRelevant: true, crossNote: CWV_NOTE, crossNoteReverse: CWV_NOTE_REV });
      }
    } catch (e) {}
  }

  function measureCWV(done) {
    try {
      var nav = performance.getEntriesByType('navigation')[0];
      // TTFB as defined on web.dev: from the start of the navigation (redirects, DNS, connection included) to the first byte.
      if (nav) cwv.ttfb = Math.round(nav.responseStart - (nav.activationStart || 0));
    } catch (e) {}

    try {
      var lcpLast = lastLcpEntry();
      if (lcpLast) cwv.lcp = Math.round(lcpLast.startTime);
    } catch (e) {}

    try { cwv.cls = computeCls(); } catch (e) {}

    var CWV_CROSS_NOTE = 'Relevant to both SEO and AEO — a good page experience also matters for AI Overviews and AI Mode.';
    var CWV_CROSS_NOTE_REVERSE = 'Relevant to both SEO and AEO — good Core Web Vitals are part of what Google\'s ranking systems reward.';

    // Two thresholds per metric (aligned with Google's official "Needs Improvement" / "Poor"
    // thresholds for LCP and CLS; TTFB isn't an official Core Web Vital, but 1800ms is a common
    // "poor" threshold in web.dev recommendations) — a mild "warning", deep into "Poor"
    // territory an "error".
    if (cwv.ttfb != null && cwv.ttfb > 800) {
      var ttfbPoor = cwv.ttfb > 1800;
      addFinding({ category: 'Performance (CWV)', severity: ttfbPoor ? 'error' : 'warning', title: 'Slow TTFB (Time To First Byte): ' + cwv.ttfb + 'ms',
        description: '', why: (ttfbPoor ? 'A TTFB over 1800ms is poor. ' : 'A good TTFB is 800ms or less. ') + 'The server responds slowly to the initial request. TTFB is not a Core Web Vital, but everything else on the page has to wait for that first byte.', fix: 'Check custom code/integrations that could be slowing down the server response.', element: null,
        crossRelevant: true, crossNote: CWV_CROSS_NOTE, crossNoteReverse: CWV_CROSS_NOTE_REVERSE });
    } else if (cwv.ttfb != null) {
      addSuccess({ category: 'Performance (CWV)', title: 'TTFB is good (' + cwv.ttfb + 'ms, under the 800ms threshold)', description: '', element: null,
        crossRelevant: true, crossNote: CWV_CROSS_NOTE, crossNoteReverse: CWV_CROSS_NOTE_REVERSE });
    }
    if (cwv.lcp != null && cwv.lcp > 2500) {
      var lcpPoor = cwv.lcp > 4000;
      addFinding({ category: 'Performance (CWV)', severity: lcpPoor ? 'error' : 'warning', title: 'Slow LCP (Largest Contentful Paint): ' + cwv.lcp + 'ms',
        description: '', why: 'A good LCP is under 2500ms' + (lcpPoor ? ', and over 4000ms falls into the "Poor" category' : '') + '. A slower LCP usually means the largest element (most often the hero image) is too big or loads slowly.',
        fix: 'Optimize/compress the hero image, remove render-blocking resources.', element: null,
        crossRelevant: true, crossNote: CWV_CROSS_NOTE, crossNoteReverse: CWV_CROSS_NOTE_REVERSE });
    } else if (cwv.lcp != null) {
      addSuccess({ category: 'Performance (CWV)', title: 'LCP is good (' + cwv.lcp + 'ms, under Google\'s 2500ms threshold)', description: '', element: null,
        crossRelevant: true, crossNote: CWV_CROSS_NOTE, crossNoteReverse: CWV_CROSS_NOTE_REVERSE });
    }
    // LCP image lazy-loaded (28.10.2026): a hero/above-the-fold image with loading="lazy" is
    // fetched late on purpose, which directly delays LCP. Only evaluated when the LCP element is an
    // <img> (text/background LCP elements have nothing to check, so no result is shown for them).
    try {
      var lcpLastEl = lastLcpEntry();
      var lcpEl = lcpLastEl ? lcpLastEl.element : null;
      if (lcpEl && lcpEl.tagName === 'IMG') {
        if ((lcpEl.getAttribute('loading') || '').toLowerCase() === 'lazy') {
          addFinding({ category: 'Performance (CWV)', severity: 'warning', title: 'The LCP image is lazy-loaded (loading="lazy")',
            description: (lcpEl.currentSrc || lcpEl.src || '').replace(/\?.*$/, '').slice(0, 120),
            why: 'The largest above-the-fold image is the LCP element. With loading="lazy" the browser postpones fetching it until layout is known, which delays LCP (a Core Web Vital).',
            fix: 'In the Designer: select the image > Element settings panel > Image settings > Set loading behavior > "Eager". Optionally also add the custom attribute fetchpriority="high" (Element settings panel > Custom attributes).', element: lcpEl,
            crossRelevant: true, crossNote: CWV_CROSS_NOTE, crossNoteReverse: CWV_CROSS_NOTE_REVERSE });
        } else {
          addSuccess({ category: 'Performance (CWV)', title: 'The LCP image is not lazy-loaded', description: '', element: lcpEl,
            crossRelevant: true, crossNote: CWV_CROSS_NOTE, crossNoteReverse: CWV_CROSS_NOTE_REVERSE });
        }
      }
    } catch (e) {}
    if (cwv.cls > 0.1) {
      var clsPoor = cwv.cls > 0.25;
      addFinding({ category: 'Performance (CWV)', severity: clsPoor ? 'error' : 'warning', title: 'High CLS (Cumulative Layout Shift): ' + cwv.cls,
        description: '', why: 'Over 0.1 means noticeable content "jumping" during load' + (clsPoor ? ' (over 0.25 is poor)' : '') + ' — most often due to images/fonts without reserved space.',
        fix: 'Add width/height to images, check font-display settings.', element: null,
        crossRelevant: true, crossNote: CWV_CROSS_NOTE, crossNoteReverse: CWV_CROSS_NOTE_REVERSE });
    } else {
      addSuccess({ category: 'Performance (CWV)', title: 'CLS is good (' + cwv.cls + ', under Google\'s 0.1 threshold)', description: '', element: null,
        crossRelevant: true, crossNote: CWV_CROSS_NOTE, crossNoteReverse: CWV_CROSS_NOTE_REVERSE });
    }

    // INP — see updateInp(): measured from the interactions made before the audit and, live, while the panel is open.
    inpReady = true;
    updateInp();

    if (done) setTimeout(done, 300);
  }

  // ---------------------------------------------------------------------
  // 5.11 AEO (Answer Engine Optimization) checks
  // ---------------------------------------------------------------------

  function getJsonLdBlocks() {
    var scripts = Array.prototype.slice.call(document.querySelectorAll('script[type="application/ld+json"]'));
    var blocks = [];
    var invalidFound = false;
    scripts.forEach(function (s) {
      try {
        var parsed = JSON.parse(s.textContent);
        // Top level may be an object, an array, or a {"@graph": [...]} wrapper (also nested inside an array).
        (function collect(node) {
          if (!node || typeof node !== 'object') return;
          if (Array.isArray(node)) { node.forEach(collect); return; }
          if (node['@graph']) { collect(node['@graph']); if (!node['@type']) return; }
          blocks.push({ raw: node, el: s });
        })(parsed);
      } catch (e) {
        invalidFound = true;
        addFinding({ category: 'AEO - Structured data (Schema.org)', group: 'aeo', severity: 'error',
          title: 'JSON-LD schema block contains invalid JSON',
          description: (s.textContent || '').slice(0, 150),
          why: 'JSON that can\'t be parsed can\'t be read at all, so none of the markup in this <script type="application/ld+json"> block reaches Google or any other reader.',
          fix: 'Check the JSON syntax (missing/extra commas, quotes), e.g. at validator.schema.org.', element: s });
      }
    });
    if (scripts.length > 0 && !invalidFound) {
      addSuccess({ category: 'AEO - Structured data (Schema.org)', group: 'aeo',
        title: 'All JSON-LD schema blocks (' + scripts.length + ') contain valid JSON', description: '', element: null });
    }
    return blocks;
  }

  function schemaTypesOf(block) {
    var t = block.raw['@type'];
    if (!t) return [];
    // "https://schema.org/Article" and "schema:Article" are the same type as "Article".
    return (Array.isArray(t) ? t : [t]).map(function (x) { return String(x).replace(/^.*[\/:#]/, ''); });
  }

  function findSchemaByType(blocks, type) {
    return blocks.filter(function (b) { return schemaTypesOf(b).indexOf(type) !== -1; });
  }

  function looksLikeFAQ() {
    var candidates = document.querySelectorAll('[class*="faq" i], [id*="faq" i]');
    if (candidates.length > 0) return true;
    var headings = Array.prototype.slice.call(document.querySelectorAll('h2,h3,h4')).filter(function (h) { return isReachable(h, CONTENT_UI_KINDS); });
    var questionCount = 0;
    headings.forEach(function (h) { if (/\?\s*$/.test(text(h))) questionCount++; });
    return questionCount >= 3;
  }

  function looksLikeArticle() {
    // Narrowed 28.10.2026 (honeybook.com audit): the old rule "600+ words and 2+ subheadings"
    // fired on every long marketing/product/pricing page. Now it needs a real signal: an
    // <article> with substantial text (CMS cards have very little), og:type=article, or a
    // blog-style URL with a decent amount of text.
    var articles = Array.prototype.slice.call(document.querySelectorAll('article'));
    if (articles.some(function (a) { return text(a).split(/\s+/).filter(Boolean).length >= 300; })) return true;
    if (/^article$/i.test((getMeta('og:type', 'property') || '').trim())) return true;
    var main = document.querySelector('main') || document.body;
    var wordCount = text(main).split(/\s+/).filter(Boolean).length;
    return /^\/(blog|posts?|articles?|news|insights|learn|resources|stories)\/[^\/]+/i.test(LOC.pathname) && wordCount > 300;
  }

  function looksLikeBreadcrumbUI() {
    return !!document.querySelector('[class*="breadcrumb" i], [aria-label*="breadcrumb" i], nav[aria-label*="breadcrumb" i]');
  }

  // Country calling codes (from the libphonenumber metadata, PhoneNumberMetadata.xml; prefix-free, so a phone number's code is unambiguous).
  var CALLING_CODES = ',1,7,20,27,30,31,32,33,34,36,39,40,41,43,44,45,46,47,48,49,51,52,53,54,55,56,57,58,60,61,62,63,64,65,66,81,82,84,86,90,91,92,93,94,95,98,211,212,213,216,218,220,221,222,223,224,225,226,227,228,229,230,231,232,233,234,235,236,237,238,239,240,241,242,243,244,245,246,247,248,249,250,251,252,253,254,255,256,257,258,260,261,262,263,264,265,266,267,268,269,290,291,297,298,299,350,351,352,353,354,355,356,357,358,359,370,371,372,373,374,375,376,377,378,380,381,382,383,385,386,387,389,420,421,423,500,501,502,503,504,505,506,507,508,509,590,591,592,593,594,595,596,597,598,599,670,672,673,674,675,676,677,678,679,680,681,682,683,685,686,687,688,689,690,691,692,800,808,850,852,853,855,856,870,878,880,881,882,883,886,888,960,961,962,963,964,965,966,967,968,970,971,972,973,974,975,976,977,979,992,993,994,995,996,998,';

  function checkAEO() {
    var blocks = getJsonLdBlocks();
    try { checkSchemaGoogle(blocks); } catch (e) { (window.__SeoAuditorErrors = window.__SeoAuditorErrors || []).push('checkSchemaGoogle: ' + (e && e.message)); }

    // FAQPage
    var faqSchemas = findSchemaByType(blocks, 'FAQPage');
    // 06.11.2026: not scored. Google stopped showing FAQ rich results on 7 May 2026 and says AI features need no
    // special schema; studies of AI citations found no clear effect of FAQPage markup. Kept as notes only.
    if (looksLikeFAQ() && faqSchemas.length === 0) {
      addFinding({ category: 'AEO - Structured data (Schema.org)', group: 'aeo', severity: 'info', noScore: true,
        title: 'Page looks like a FAQ section but has no FAQPage schema markup',
        description: 'FAQ-like elements were found (classes/IDs containing "faq", or 3+ question-style headings) without a corresponding JSON-LD FAQPage schema.',
        why: 'Note only — not scored. Google stopped showing FAQ rich results on 7 May 2026, no special schema is needed for AI Overviews / AI Mode, and adding FAQPage markup has shown no clear effect on AI citations. The markup is optional; if you add it, it must match the visible questions and answers.',
        fix: 'Optional: add a JSON-LD FAQPage block (a mainEntity array of Question/acceptedAnswer objects) matching the visible questions and answers — in Webflow: Page settings > Schema markup.', element: null });
    } else if (faqSchemas.length) {
      faqSchemas.forEach(function (b) {
        var entities = b.raw.mainEntity;
        var arr = Array.isArray(entities) ? entities : (entities ? [entities] : []);
        if (!arr.length) {
          addFinding({ category: 'AEO - Structured data (Schema.org)', group: 'aeo', severity: 'info', noScore: true,
            title: 'FAQPage schema has no mainEntity (questions)',
            description: '', why: 'Note only — not scored. Without mainEntity the FAQPage block contains no questions, so the markup describes nothing.',
            fix: 'Add a mainEntity array with Question/acceptedAnswer objects for every question on the page.', element: b.el });
        } else {
          var badItems = arr.filter(function (q) {
            var ans = q && q.acceptedAnswer;
            if (Array.isArray(ans)) ans = ans[0];
            return !ans || !ans.text;
          });
          if (badItems.length) {
            addFinding({ category: 'AEO - Structured data (Schema.org)', group: 'aeo', severity: 'info', noScore: true,
              title: badItems.length + ' question(s) in the FAQPage schema have no acceptedAnswer.text filled in',
              description: '', why: 'Note only — not scored. These questions have no answer text in the markup, so the markup doesn\'t match the answers shown on the page.',
              fix: 'Fill in acceptedAnswer.text for every Question in the schema.', element: b.el });
          } else {
            addSuccess({ category: 'AEO - Structured data (Schema.org)', group: 'aeo',
              title: 'FAQPage schema is present and complete (' + arr.length + ' questions with answers)', description: '', element: b.el });
          }
        }
      });
    }

    // Article / BlogPosting / NewsArticle
    var articleSchemas = [];
    ['Article', 'BlogPosting', 'NewsArticle', 'TechArticle', 'ScholarlyArticle', 'OpinionNewsArticle', 'ReportageNewsArticle', 'AnalysisNewsArticle', 'LiveBlogPosting'].forEach(function (t) {
      findSchemaByType(blocks, t).forEach(function (b) { if (articleSchemas.indexOf(b) === -1) articleSchemas.push(b); });
    });
    if (looksLikeArticle() && articleSchemas.length === 0) {
      addFinding({ category: 'AEO - Structured data (Schema.org)', group: 'aeo', severity: 'warning',
        title: 'Page looks like an article/blog post but has no Article schema markup',
        description: 'An <article> element with substantial text, og:type="article", or a blog-style URL was found, without a JSON-LD Article/BlogPosting schema.',
        why: 'Article markup tells Google explicitly what the content is: that it is an article, who the author is and what its title is. No property is required; author, datePublished, dateModified, headline and image are recommended. (No special schema is needed to appear in AI Overviews or AI Mode.)',
        fix: 'Add a JSON-LD Article schema with headline, author, datePublished, dateModified.', element: null });
    } else {
      articleSchemas.forEach(function (b) {
        if (!b.raw.dateModified && !b.raw.datePublished) {
          addFinding({ category: 'AEO - Structured data (Schema.org)', group: 'aeo', severity: 'error',
            title: 'Article schema has neither dateModified nor datePublished',
            description: '', why: 'datePublished and dateModified are recommended Article properties; dateModified gives Google more accurate date information about the content.',
            fix: 'Add dateModified (and datePublished) in ISO 8601 format. Best practice: bind the field automatically to the CMS "last modified" value instead of it being manual/hardcoded, so it doesn\'t get forgotten.', element: b.el });
        } else {
          addSuccess({ category: 'AEO - Structured data (Schema.org)', group: 'aeo',
            title: 'Article schema has datePublished/dateModified', description: '', element: b.el });
        }
        var author = b.raw.author;
        var authorObj = Array.isArray(author) ? author[0] : author;
        var authorUrl = authorObj && authorObj.url;
        if (authorUrl) {
          try {
            fetch(authorUrl, { method: 'HEAD' }).then(function (r) {
              if (r.status === 404) {
                addFinding({ category: 'AEO - Structured data (Schema.org)', group: 'aeo', severity: 'error',
                  title: 'Author link in the Article schema leads to a 404',
                  description: 'author.url: ' + authorUrl,
                  why: 'author.url (or sameAs) lets Google identify the author. A link that doesn\'t work gives it nothing to identify the author with.',
                  fix: 'Fix author.url to point to a valid author page/profile.', element: b.el });
              } else {
                addSuccess({ category: 'AEO - Structured data (Schema.org)', group: 'aeo',
                  title: 'Author link in the Article schema is valid (doesn\'t return 404)', description: 'author.url: ' + authorUrl, element: b.el });
              }
              renderPanel();
            }).catch(function () {});
          } catch (e) {}
        } else if (!authorObj) {
          addFinding({ category: 'AEO - Structured data (Schema.org)', group: 'aeo', severity: 'info',
            title: 'Article schema has no author field',
            description: '', why: 'author (a Person or Organization, with author.name and author.url) is a recommended Article property, so Google can understand who wrote the content.',
            fix: 'Add an author (Person or Organization) with name and url.', element: b.el });
        } else {
          addSuccess({ category: 'AEO - Structured data (Schema.org)', group: 'aeo',
            title: 'Article schema has an author field', description: '', element: b.el });
        }
      });
    }

    // Organization / LocalBusiness — NAP (Name-Address-Phone) consistency
    var orgSchemas = findSchemaByType(blocks, 'Organization').concat(findSchemaByType(blocks, 'LocalBusiness'));
    orgSchemas.forEach(function (b) {
      var footer = document.querySelector('footer');
      var footerText = footer ? text(footer) : '';
      if (!footerText) return;

      var napIssueFound = false;
      var schemaTelRaw = String(Array.isArray(b.raw.telephone) ? b.raw.telephone[0] : (b.raw.telephone || '')).trim();
      var schemaPhone = schemaTelRaw.replace(/[^\d]/g, '');
      // Same number, different notation: schema.org usually carries the international form ("+44 20 7946 0958"), the page the
      // national one ("020 7946 0958"). Per ITU E.164 a number is <country code><national number>, and country codes are
      // prefix-free (checked against the libphonenumber metadata: 215 codes, no code is the start of another), so the country
      // code can be read off unambiguously and the NATIONAL number compared. Every written form of the number contains it.
      var phoneNeedles = [];
      if (schemaPhone) {
        var intl = /^\+/.test(schemaTelRaw) || /^00/.test(schemaPhone);
        var digitsNoIntlPrefix = /^00/.test(schemaPhone) && !/^\+/.test(schemaTelRaw) ? schemaPhone.slice(2) : schemaPhone;
        var cc = '';
        if (intl) { for (var cl = 1; cl <= 3 && !cc; cl++) { if (CALLING_CODES.indexOf(',' + digitsNoIntlPrefix.slice(0, cl) + ',') !== -1) cc = digitsNoIntlPrefix.slice(0, cl); } }
        if (cc) phoneNeedles.push(digitsNoIntlPrefix.slice(cc.length).replace(/^0+/, ''));   // national number (a "(0)" trunk digit written in the schema is dropped)
        else { phoneNeedles.push(schemaPhone); if (/^0/.test(schemaPhone)) phoneNeedles.push(schemaPhone.replace(/^0+/, '')); }   // no country code: the number as written, or without its trunk 0
        phoneNeedles = phoneNeedles.filter(function (n) { return n.length >= 5; });
        if (!phoneNeedles.length) phoneNeedles = [schemaPhone];
      }
      if (schemaPhone) {
        var phoneSources = footerText;
        Array.prototype.forEach.call(footer ? footer.querySelectorAll('a[href^="tel:" i]') : [], function (a) { var tel = (a.getAttribute('href') || '').replace(/^tel:/i, ''); try { tel = decodeURIComponent(tel); } catch (e) {} phoneSources += ' ' + tel; });
        // Digit groups as written on the page (spaces, dots, dashes, slashes and brackets inside one number), compared one group at a time.
        var footerGroups = (phoneSources.match(/\d[\d\s().\/\-\u2013\u00a0]*\d|\d/g) || []).map(function (g) { return g.replace(/[^\d]/g, ''); });
        var phoneFound = footerGroups.some(function (g) { return phoneNeedles.some(function (n) { return g.indexOf(n) !== -1; }); });
        if (!phoneFound) {
          napIssueFound = true;
          addFinding({ category: 'AEO - NAP consistency', group: 'aeo', severity: 'warning',
            title: 'Phone number in the Organization/LocalBusiness schema doesn\'t match the number in the footer',
            description: 'Schema telephone: ' + b.raw.telephone,
            why: 'Structured data must be a true representation of the page content. A phone number in the schema that differs from the one shown on the page breaks that rule.',
            fix: 'Align the phone number in the schema markup with the one visibly shown in the footer.', element: b.el });
        }
      }

      var schemaAddr = b.raw.address;
      var addrStr = !schemaAddr ? '' : (typeof schemaAddr === 'string' ? schemaAddr :
        [schemaAddr.streetAddress, schemaAddr.addressLocality, schemaAddr.postalCode].filter(Boolean).join(' '));
      if (addrStr) {
        var addrParts = addrStr.split(/\s+/).filter(function (p) { return p.length > 3; });
        var missingParts = addrParts.filter(function (p) { return footerText.toLowerCase().indexOf(p.toLowerCase()) === -1; });
        if (addrParts.length && missingParts.length === addrParts.length) {
          napIssueFound = true;
          addFinding({ category: 'AEO - NAP consistency', group: 'aeo', severity: 'warning',
            title: 'Address from the Organization/LocalBusiness schema doesn\'t appear anywhere in the visible footer',
            description: 'Schema address: ' + addrStr,
            why: 'Structured data shouldn\'t describe content that readers can\'t see. An address in the schema that isn\'t shown in the footer may not be visible anywhere on the page.',
            fix: 'Display the same address visibly (e.g. in the footer) or remove it from the schema if it\'s no longer accurate.', element: b.el });
        }
      }

      if (!napIssueFound && (schemaPhone || addrStr)) {
        addSuccess({ category: 'AEO - NAP consistency', group: 'aeo',
          title: 'NAP data (phone/address) from the schema markup is consistent with the footer', description: '', element: b.el });
      }
    });

    // Organization schema: official profiles (sameAs) + presence on the home page (29.10.2026, flowninja.com audit).
    // sameAs ties the site to its official profiles, which is how search and answer engines recognise the
    // business as ONE entity; the page's own social links are the evidence of which profiles exist.
    var ORG_TYPES = ['Organization', 'Corporation', 'LocalBusiness', 'ProfessionalService', 'OnlineBusiness'];
    var orgBlocks = [];
    ORG_TYPES.forEach(function (t) { orgBlocks = orgBlocks.concat(findSchemaByType(blocks, t)); });
    var SOCIAL_HOSTS = ['linkedin.com', 'facebook.com', 'x.com', 'twitter.com', 'instagram.com', 'youtube.com', 'tiktok.com', 'pinterest.com', 'github.com', 'threads.net'];
    // Canonical host of a profile URL: www./m./country subdomains folded into the main domain, twitter.com -> x.com.
    function canonProfileHost(url) {
      var h = hostnameOf(url);
      if (!h) return null;
      h = h.replace(/^www\./, '');
      for (var i = 0; i < SOCIAL_HOSTS.length; i++) {
        var d = SOCIAL_HOSTS[i];
        if (h === d || h.slice(-(d.length + 1)) === '.' + d) return d === 'twitter.com' ? 'x.com' : d;
      }
      return h;
    }
    function socialHostOf(url) {
      var h = canonProfileHost(url);
      return h && (SOCIAL_HOSTS.indexOf(h) !== -1) ? h : null;
    }
    if (orgBlocks.length) {
      var orgB = orgBlocks[0];
      var sameAsRaw = orgB.raw.sameAs;
      var sameAsList = Array.isArray(sameAsRaw) ? sameAsRaw : (sameAsRaw ? [sameAsRaw] : []);
      var sameAsHosts = {};
      sameAsList.forEach(function (u) { var s = typeof u === 'string' ? u : (u && (u.url || u['@id'])) || ''; var h = canonProfileHost(s); if (h) sameAsHosts[h] = true; });
      var pageSocial = [];
      Array.prototype.slice.call(document.querySelectorAll('a[href]')).forEach(function (a) {
        var href = a.getAttribute('href') || '';
        if (!/^https?:\/\//i.test(href)) return;
        var path = '';
        try { path = new URL(href, LOC.href).pathname; } catch (e) {}
        if (path.length <= 1 || /share|sharer|intent|dialog|plugins/i.test(href)) return; // not a profile link
        var sh = socialHostOf(href);
        if (sh && pageSocial.indexOf(sh) === -1) pageSocial.push(sh);
      });
      if (!sameAsList.length) {
        addFinding({ category: 'AEO - Structured data (Schema.org)', group: 'aeo', severity: 'info',
          title: 'Organization schema has no sameAs (links to the official profiles)',
          description: pageSocial.length ? 'Profiles linked on this page: ' + pageSocial.join(', ') : '',
          why: 'sameAs lists the official profiles of the business (LinkedIn, X, YouTube, Crunchbase, Clutch...), which helps Google understand the organization and tell it apart from others in search results.',
          fix: 'Add a sameAs array with the full URLs of the official profiles to the Organization JSON-LD block — in Webflow: Pages panel > Home > Page settings > Schema markup field (or wherever the block was added: Page settings > Custom code > Inside <head> tag, or Site settings > Custom code tab > Head code).', element: orgB.el });
      } else {
        var missingSocial = pageSocial.filter(function (h) { return !sameAsHosts[h]; });
        if (missingSocial.length) {
          addFinding({ category: 'AEO - Structured data (Schema.org)', group: 'aeo', severity: 'info',
            title: 'Organization schema sameAs does not include the social profiles linked on this page',
            description: 'Missing: ' + missingSocial.join(', '),
            why: 'The page links to these profiles, but the Organization schema does not list them in sameAs, so the markup doesn\'t connect the business to them.',
            fix: 'Add the full profile URLs (the same ones the page links to) to the sameAs array of the Organization JSON-LD block.', element: orgB.el });
        } else {
          addSuccess({ category: 'AEO - Structured data (Schema.org)', group: 'aeo',
            title: 'Organization schema lists its official profiles (sameAs: ' + sameAsList.length + ')', description: '', element: orgB.el });
        }
      }
    } else if (/^\/([a-z]{2}(-[a-z]{2})?\/?)?$/i.test(LOC.pathname)) {
      addFinding({ category: 'AEO - Structured data (Schema.org)', group: 'aeo', severity: 'info',
        title: 'Home page has no Organization schema',
        description: '', why: 'Organization markup on the home page helps Google understand the organization\'s details and tell it apart from others in search results, and can influence which logo is shown in search results and the knowledge panel. No property is required.',
        fix: 'Add a JSON-LD Organization block (name, url, logo, sameAs with the official profiles) — in Webflow: Pages panel > Home > Page settings > Schema markup field (Webflow advises not to add the same schema there and in custom code as well).', element: null });
    }

    // BreadcrumbList
    var breadcrumbSchemas = findSchemaByType(blocks, 'BreadcrumbList');
    if (looksLikeBreadcrumbUI() && breadcrumbSchemas.length === 0) {
      addFinding({ category: 'AEO - Structured data (Schema.org)', group: 'aeo', severity: 'info',
        title: 'A visible breadcrumb UI exists, but there is no BreadcrumbList schema markup',
        description: '', why: 'Google uses breadcrumb markup to categorize the page\'s information in search results.',
        fix: 'Add a JSON-LD BreadcrumbList schema matching the visible breadcrumb navigation.', element: null });
    } else if (breadcrumbSchemas.length) {
      addSuccess({ category: 'AEO - Structured data (Schema.org)', group: 'aeo',
        title: 'BreadcrumbList schema is present', description: '', element: breadcrumbSchemas[0].el });
    }

    // JS-render dependency (best-effort heuristic)
    try {
      getRawDoc().then(function (raw) {
        if (raw.error) return;                          // reported by the original-vs-rendered check
        var tmp = raw.doc.cloneNode(true);              // a copy: the shared original document stays intact for the other checks
        Array.prototype.forEach.call(tmp.querySelectorAll('script,style,noscript'), function (n) { n.remove(); });
        var rawText = ((tmp.body || tmp.documentElement).textContent || '').replace(/\s+/g, ' ').trim();
        var renderedText = text(document.body).replace(/\s+/g, ' ').trim();
        if (renderedText.length > 300 && rawText.length < renderedText.length * 0.3) {
          addFinding({ category: 'AEO - JS rendering dependency', group: 'aeo', severity: 'warning',
            title: 'Most of the content only appears after JavaScript executes (raw HTML: ~' + rawText.length + ' chars, rendered: ~' + renderedText.length + ' chars)',
            description: '',
            why: 'Note: this is a heuristic and can produce false results (e.g. a cookie banner blocking the fetch). Most AI crawlers (OpenAI, Anthropic, Perplexity and others) don\'t run JavaScript; Google\'s crawler does. If key content only appears after JavaScript runs, those crawlers may see an empty or nearly empty page. Webflow pages are server-rendered, so this is rare, but custom code/embeds can inject content afterward.',
            fix: 'Check "View Page Source" (Ctrl/Cmd+U) and compare it with what\'s visible on screen — if key text is missing from the raw HTML, consider making that content part of the server\'s initial HTML response.', element: null });
          renderPanel();
        }
      });
    } catch (e) {}
  }

  // ---------------------------------------------------------------------
  // UI Overlay (shadow DOM panel)
  // ---------------------------------------------------------------------

  var panelHost, shadow, highlightBox;

  // Tool icon (10.08.2026, part of the visual redesign): reticle/highlight-box corners (a direct
  // reference to the tool's own highlight box drawn around issues on the page) + a checkmark
  // ("check passed") + a signal/broadcast accent (the page emits a signal read by both search
  // engines AND AI answer engines — SEO+AEO in one image, without a clichéd "AI sparkle").
  // Deliberately an original combination, not the generic magnifying-glass/shield/bug icons used
  // by most SEO/audit tools.
  var HEADER_ICON_SVG = '<svg width="18" height="18" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
    '<path d="M20 34 V20 H34" fill="none" stroke="#818cf8" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/>' +
    '<path d="M66 20 H80 V34" fill="none" stroke="#818cf8" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/>' +
    '<path d="M80 66 V80 H66" fill="none" stroke="#818cf8" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/>' +
    '<path d="M34 80 H20 V66" fill="none" stroke="#818cf8" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/>' +
    '<path d="M31 52 L45 65 L71 35" fill="none" stroke="#4ade80" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/>' +
    '<circle cx="80" cy="20" r="4" fill="#fbbf24"/>' +
    '<path d="M87 12 A11 11 0 0 1 87 28" fill="none" stroke="#fbbf24" stroke-width="4" stroke-linecap="round"/>' +
    '</svg>';
  var activeTab = 'seo'; // 'seo' | 'aeo' | 'success'
  var activeSeverity = 'all'; // 'all' | 'error' | 'warning' | 'info'
  var checksViewOpen = false; // the "N checks need attention" list (29.10.2026)
  var activeCheckFilter = null; // check id: show only that check's findings
  var activeSuccessGroup = 'all'; // 'all' | 'seo' | 'aeo' | 'shared' — filter WITHIN the Success tab
                               // ('seo'/'aeo' = exclusively that domain, without crossRelevant; 'shared' =
                               // "SEO + AEO", crossRelevant items only — see the 10.08.2026 SPEC entry)
  var activeCategory = 'all'; // category name (e.g. 'Images', 'Links'...) or 'all' — an additional
                               // filter WITHIN the current severity filter (error/warning/info/All)
  var activeCategoryOrigin = 'all'; // 'all' | 'shared' | 'solo' — sub-filter WITHIN the selected category,
                               // only relevant when that category contains both crossRelevant:true items
                               // ("AEO + SEO items", shared with a "↔" note in both tabs) and items without
                               // that flag ("SEO/AEO only items", relevant exclusively to the tab currently
                               // being viewed) — e.g. "Meta & head tags" in the SEO tab mixes title/OG/
                               // Twitter (solo) with canonical/noindex/nosnippet (shared). See the
                               // 10.08.2026 SPEC entry.

  // Drag (moving) and resize (height) state for the panel — kept at the module level because
  // renderPanel() fully recreates the .panel div on every call (e.g. on every new async finding,
  // tab change, or filter change) — without this state the panel would "snap" back to its
  // default position/height on every re-render.
  var panelPosition = null; // { top, left } in px, populated as soon as the user drags the panel
  var panelHeight = null; // px, populated as soon as the user changes the height via the resize handle
  var isDragging = false, dragStartX = 0, dragStartY = 0, dragStartTop = 0, dragStartLeft = 0;
  var isResizing = false, resizeStartY = 0, resizeStartHeight = 0;
  var MIN_PANEL_HEIGHT = 160;

  // Keyboard navigation (11.08.2026) — Up/Down cycles through the currently visible list of
  // items (whatever tab/filter is active), Esc closes the panel. `lastRenderedRows` is rebuilt
  // on every renderPanel() call to mirror exactly what's on screen (respecting the active tab/
  // severity/category filter), so arrow keys always match what the user actually sees.
  var lastRenderedRows = []; // [{ item: <finding or success object>, el: <.item DOM element> }, ...]
  var selectedIndex = -1;

  // "Page optimized" progress bar (28.10.2026) — replaces the earlier A–F score badge (which
  // first-time users found unintuitive). It's a WEIGHTED share of checks that pass:
  //   * Every distinct check below has a weight by the worst severity it can report
  //     (error = 4, warning = 2, info = 1), so one error costs more than several info items,
  //     but info items still count a little — they do make a page "more optimized".
  //   * Partial credit for checks that look at many elements (e.g. 200 images): the check loses
  //     weight in proportion to how many elements are affected, so fixing images one by one makes
  //     the number move instead of staying frozen until the very last one is fixed.
  //   * "Preliminary check" items (redirect, staging link) are context, not optimizations, so
  //     they're excluded from the calculation entirely.
  //   * Only checks that actually ran on this page are counted (e.g. the FAQPage check only
  //     applies if the page looks like a FAQ).
  // Checks are identified by matching the finding/success TITLE against the registry below, so
  // none of the ~120 addFinding()/addSuccess() call sites had to change. If you add a new check
  // or reword a title, add/adjust its entry here — unmatched titles are listed in
  // window.__SeoAuditorUnmatched for exactly that reason.
  var SEVERITY_WEIGHT = { error: 4, warning: 2, info: 1 };
  var checkTotals = {}; // check id -> number of elements that check looked at (for partial credit)
  function setCheckTotal(id, n) { checkTotals[id] = n; }
  function hasOutput(id, wantSuccessOnly) {
    var i;
    for (i = 0; i < successes.length; i++) if (successes[i].check === id) return true;
    if (!wantSuccessOnly) for (i = 0; i < findings.length; i++) if (findings[i].check === id) return true;
    return false;
  }
  // w = weight at the worst severity the check can report. always = the check has no "success"
  // message, so it counts as evaluated whenever the audit ran. total = per-element check (needs
  // checkTotals[id] > 0 to count). evalIfSuccessOf / evalIfAnyOf = conditional checks that only
  // apply when a related check produced output.
  var CHECK_REGISTRY = [
    { id: 'meta.charset', w: 2, re: /^Meta charset/ },
    { id: 'meta.dupTitle', w: 2, re: /^More than one <title>/, always: true },
    { id: 'meta.dupDesc', w: 2, re: /^More than one meta description/, always: true },
    { id: 'meta.title', w: 4, re: /^Title (tag|is|looks)/ },
    { id: 'meta.desc', w: 4, re: /^Meta description is/ },
    { id: 'og.title', w: 2, re: /^og:title is/ },
    { id: 'og.desc', w: 2, re: /^og:description is/ },
    { id: 'og.image', w: 2, re: /^og:image is/ },
    { id: 'og.imageQuality', w: 4, re: /^OG image/, evalIfSuccessOf: ['og.image'] },
    { id: 'twitter.card', w: 2, re: /^Twitter\/X Card/ },
    { id: 'meta.canonical', w: 4, re: /^Canonical tag is missing/, always: true },
    { id: 'meta.noindex', w: 4, re: /^Page is (not )?marked as noindex/ },
    { id: 'meta.nosnippet', w: 4, re: /^Robots directive/ },
    { id: 'meta.xrobots', w: 4, re: /^(X-Robots-Tag|No X-Robots-Tag)/ },
    { id: 'meta.sitemap', w: 2, re: /^This page is (not )?listed in sitemap/ },
    { id: 'meta.lang', w: 0, re: /^lang attribute/ },   // 12.11.2026: accessibility only -> note (info, noScore), weight 0
    { id: 'meta.viewport', w: 4, re: /^Viewport meta tag/ },
    { id: 'meta.zoom', w: 0, re: /^Viewport (prevents|allows)/ },
    { id: 'fav.present', w: 2, re: /^Favicon is (missing or fails|present and loads)/ },
    { id: 'fav.quality', w: 1, re: /^Favicon (is not in a format|dimensions|is square)/, evalIfSuccessOf: ['fav.present'] },
    { id: 'fav.robots', w: 2, re: /^Favicon is blocked/, evalIfSuccessOf: ['fav.present'] },
    { id: 'url.canonical', w: 4, re: /^Canonical (points|tag is present)/ },
    { id: 'meta.canonicalValid', w: 4, re: /^(Canonical tag is (outside|valid)|More than one canonical tag|Canonical tag appears|Canonical uses a relative|Canonical URL contains a fragment)/ },
    { id: 'crawl.robots', w: 4, re: /^(Page is (not )?blocked in robots\.txt for Googlebot|robots\.txt answers HTTP)/ },
    { id: 'aeo.robots', w: 4, re: /^Page is (not )?blocked in robots\.txt for AI search crawlers/ },
    { id: 'crawl.jsMismatch', w: 4, re: /^(noindex is in the original HTML|Canonical in the original HTML|Original HTML and the page after JavaScript)/ },
    { id: 'crawl.metaRefresh', w: 4, re: /^(Page redirects (instantly )?with a meta refresh|No meta refresh redirect)/ },
    { id: 'intl.hreflang', w: 4, re: /^(hreflang |Invalid hreflang|This page is missing from its own hreflang|No x-default hreflang)/ },
    { id: 'cwv.inp', w: 4, re: /^(Slow INP|INP is good)/ },
    { id: 'img.broken', w: 2, re: /^(Image does not load|All images load)/, total: true },
    { id: 'links.js', w: 2, re: /^(Navigation without a crawlable link|All navigation uses crawlable)/, total: true },
    { id: 'links.nofollow', w: 2, re: /^(Internal link has rel="nofollow"|No internal link has rel="nofollow")/, total: true },
    { id: 'links.imgAlt', w: 2, re: /^(Image link has no anchor text|All image links have alt text)/, total: true },
    { id: 'aeo.schemaRequired', w: 2, re: /^(\w+ schema is missing properties Google requires|Schema has the properties Google requires)/ },
    { id: 'aeo.schemaVisible', w: 2, re: /^(Schema text not found on the page|Schema names\/headlines appear on the page)/ },
    { id: 'mobile.parity', w: 2, re: /^(Content visible on desktop is missing on mobile|Mobile shows the same content as desktop)/ },
    { id: 'mobile.tapTargets', w: 0, re: /^Tap target is too small/, total: true, always: true },
    { id: 'url.slug', w: 4, re: /^(URL slug|CMS item slug)/ },
    { id: 'h.h1', w: 4, re: /^(H1 is missing|There is more than one H1|Exactly one H1)/ },
    { id: 'h.skip', w: 0, re: /^Heading hierarchy/ },
    { id: 'h.fake', w: 1, re: /^Text looks like a heading/, always: true },
    { id: 'img.alt', w: 4, re: /^(Alt text is empty|Image: (alt|generic)|\d+ of \d+ visible images have descriptive)/, total: true },
    { id: 'img.height', w: 4, re: /^(Image has no fixed height|\d+ image\(s\) have (both dimensions|a fixed height|no height of their own))/, total: true },
    { id: 'img.external', w: 4, re: /^(Image is hosted|All images are hosted)/, total: true },
    { id: 'img.oversize', w: 2, re: /^(Image is larger than its displayed size|No image is larger than needed)/, total: true },   // Lighthouse "Properly size images" (06.11.2026)
    { id: 'img.lazy', w: 2, re: /^(Image below the fold|All \d+ below-the-fold)/, total: true },
    { id: 'img.format', w: 1, re: /^(Image is not in a modern|\d+ image\(s\) are already in a modern)/, total: true },
    { id: 'img.size', w: 4, re: /^Image is larger than 500KB/, always: true, total: true },
    { id: 'img.heavy', w: 2, re: /^(Image can be compressed further|PNG image would be)/, always: true, total: true },   // Lighthouse encode method (06.11.2026)
    { id: 'img.lazyAbove', w: 2, re: /^(Above-the-fold images are lazy-loaded|None of the \d+ images in the first screen)/ },
    { id: 'video.poster', w: 2, re: /^(Above-the-fold video has no poster|The above-the-fold video has a poster)/ },
    { id: 'form.label', w: 0, re: /^(Form field has no accessible label|All \d+ form field)/, total: true },   // 12.11.2026: accessibility only -> note, weight 0 (same for meta.zoom, mobile.tapTargets, h.skip)
    { id: 'aeo.orgSameAs', w: 2, re: /^(Organization schema (has no sameAs|sameAs does not|lists its official)|Home page has no Organization schema)/ },
    { id: 'links.nowhere', w: 2, re: /^(Link doesn't go anywhere|There are no links that go nowhere)/, total: true },
    { id: 'links.anchor', w: 4, re: /^(Anchor link points|All in-page anchor)/ },
    { id: 'links.noText', w: 2, re: /^(Link with no text|All links have visible text)/, total: true },
    { id: 'links.generic', w: 1, re: /^Generic anchor text/, always: true, total: true },
    { id: 'links.internal', w: 4, re: /^(Internal link|All checked internal links)/, total: true },
    { id: 'content.thin', w: 2, re: /^(Very little visible text|The page has enough visible text)/ },
    { id: 'content.hidden', w: 1, re: /^Hidden content/, always: true },
    { id: 'content.repeated', w: 2, re: /^(Repeated word|No repeated words)/ },
    { id: 'content.placeholder', w: 4, re: /^(Placeholder\/Lorem|No placeholder)/ },
    { id: 'fonts.count', w: 0, re: /^The page uses/, always: true },   // note only (06.11.2026): no source for a font-count limit
    { id: 'fonts.google', w: 2, re: /^(The page dynamically loads Google Fonts|No dynamic loading of Google Fonts)/ },
    { id: 'fonts.format', w: 1, re: /^(Font file in an older|All font files used on this page)/ },
    { id: 'tech.dupId', w: 1, re: /^(Duplicate ID|No duplicate ID)/ },
    { id: 'tech.dom', w: 1, re: /^(Large\/deeply nested DOM|DOM size\/depth)/ },
    { id: 'tech.mixed', w: 4, re: /^(Mixed content|No mixed content)/ },
    { id: 'tech.thirdParty', w: 4, re: /^(Third-party script|All third-party scripts)/ },
    { id: 'cwv.ttfb', w: 4, re: /^(Slow TTFB|TTFB is good)/ },
    { id: 'cwv.lcp', w: 4, re: /^(Slow LCP|LCP is good)/ },
    { id: 'cwv.cls', w: 4, re: /^(High CLS|CLS is good)/ },
    { id: 'cwv.lcpLazy', w: 2, re: /^The LCP image/ },
    { id: 'aeo.jsonld', w: 4, re: /^(JSON-LD schema block|All JSON-LD schema blocks)/ },
    { id: 'aeo.faq', w: 0, re: /^(Page looks like a FAQ|FAQPage schema|\d+ question\(s\) in the FAQPage)/ },
    { id: 'aeo.article', w: 2, re: /^Page looks like an article/, evalIfAnyOf: ['aeo.articleDates', 'aeo.articleAuthor', 'aeo.authorLink'] },
    { id: 'aeo.articleDates', w: 4, re: /^Article schema (has neither|has datePublished)/ },
    { id: 'aeo.articleAuthor', w: 1, re: /^Article schema has (no |an )?author field/ },
    { id: 'aeo.authorLink', w: 4, re: /^Author link in the Article schema/ },
    { id: 'aeo.nap', w: 2, re: /^(Phone number in the Organization|Address from the Organization|NAP data)/ },
    { id: 'aeo.breadcrumb', w: 1, re: /^(A visible breadcrumb UI|BreadcrumbList schema)/ },
    { id: 'aeo.jsRender', w: 2, re: /^Most of the content only appears after JavaScript/, always: true }
  ];
  // Human-readable names of the scored checks (shown in the "checks that need attention" list).
  var CHECK_LABELS = {
    'meta.charset': 'Meta charset', 'meta.dupTitle': 'Duplicate <title> tags', 'meta.dupDesc': 'Duplicate meta descriptions',
    'meta.title': 'Title tag', 'meta.desc': 'Meta description', 'og.title': 'og:title', 'og.desc': 'og:description', 'og.image': 'og:image',
    'og.imageQuality': 'OG image quality', 'twitter.card': 'Twitter/X Card', 'meta.canonical': 'Canonical tag present',
    'meta.noindex': 'noindex directive', 'meta.nosnippet': 'Robots directives (nosnippet etc.)', 'meta.xrobots': 'X-Robots-Tag header',
    'meta.sitemap': 'Page listed in sitemap.xml', 'meta.lang': 'lang attribute', 'meta.viewport': 'Viewport meta tag', 'meta.zoom': 'Viewport allows zoom',
    'fav.present': 'Favicon present', 'fav.quality': 'Favicon quality', 'fav.robots': 'Favicon not blocked by robots',
    'url.canonical': 'Canonical points to this page', 'meta.canonicalValid': 'Canonical tag is valid', 'crawl.robots': 'Not blocked in robots.txt (Googlebot)', 'aeo.robots': 'Not blocked for AI search crawlers', 'crawl.jsMismatch': 'Original HTML matches the rendered page', 'crawl.metaRefresh': 'No meta refresh redirect', 'intl.hreflang': 'hreflang tags', 'cwv.inp': 'INP (interaction to next paint)', 'img.broken': 'Images load (no broken images)', 'links.js': 'Navigation uses crawlable links', 'links.nofollow': 'No nofollow on internal links', 'links.imgAlt': 'Image links have alt text', 'aeo.schemaRequired': 'Schema has Google-required properties', 'aeo.schemaVisible': 'Schema text is on the page', 'mobile.parity': 'Same content on mobile as on desktop', 'mobile.tapTargets': 'Tap targets on mobile (24x24 px)', 'url.slug': 'URL slug', 'h.h1': 'Exactly one H1', 'h.skip': 'Heading hierarchy',
    'h.fake': 'Text styled as a heading', 'img.alt': 'Image alt text', 'img.height': 'Image height (layout shift)',
    'img.external': 'Images hosted on the same domain', 'img.oversize': 'Image size vs displayed size',
    'img.lazy': 'Below-the-fold images lazy-loaded', 'img.format': 'Modern image format', 'img.size': 'Image file size (up to 500KB)',
    'links.nowhere': 'Links that go nowhere', 'links.anchor': 'In-page anchor links', 'links.noText': 'Links with visible text',
    'links.generic': 'Generic anchor text', 'links.internal': 'Internal links working', 'content.thin': 'Enough visible text',
    'content.hidden': 'Hidden content', 'content.repeated': 'Repeated words', 'content.placeholder': 'Placeholder / Lorem ipsum text',
    'fonts.count': 'Number of fonts', 'fonts.google': 'Google Fonts loading', 'fonts.format': 'Font file format',
    'tech.dupId': 'Duplicate IDs', 'tech.dom': 'DOM size / depth', 'tech.mixed': 'Mixed content (HTTP on HTTPS)', 'tech.thirdParty': 'Third-party scripts',
    'cwv.ttfb': 'TTFB (server response)', 'cwv.lcp': 'LCP (largest contentful paint)', 'cwv.cls': 'CLS (layout shift)', 'cwv.lcpLazy': 'LCP image not lazy-loaded',
    'aeo.jsonld': 'JSON-LD schema validity', 'aeo.faq': 'FAQPage schema', 'aeo.article': 'Article schema', 'aeo.articleDates': 'Article dates',
    'aeo.articleAuthor': 'Article author', 'aeo.authorLink': 'Author link', 'aeo.nap': 'NAP data (phone/address)', 'aeo.breadcrumb': 'Breadcrumbs',
    'aeo.jsRender': 'Content visible without JavaScript',
    'img.heavy': 'Image compression (JPEG re-encode, PNG to WebP)', 'img.lazyAbove': 'Above-the-fold images not lazy-loaded',
    'video.poster': 'Above-the-fold video poster', 'form.label': 'Form field labels', 'aeo.orgSameAs': 'Organization schema profiles (sameAs)'
  };
  var CHECK_BY_ID = {};
  CHECK_REGISTRY.forEach(function (c) { CHECK_BY_ID[c.id] = c; });
  function matchCheckId(title) {
    for (var i = 0; i < CHECK_REGISTRY.length; i++) {
      if (CHECK_REGISTRY[i].re.test(title)) return CHECK_REGISTRY[i].id;
    }
    return null;
  }

  // Returns { pct, failedChecks, issues, notes } — pct is 0–100 with one decimal.
  function computeOptimization() {
    window.__SeoAuditorUnmatched = [];
    var perCheck = {}; // id -> { findings: [] }
    function bucket(id) { return perCheck[id] || (perCheck[id] = { findings: [] }); }
    var issues = 0, notes = 0; // issues = errors + warnings; notes = info items (still listed, still in the %)
    findings.forEach(function (f) {
      if (f.category === 'Preliminary check') return; // context, not an optimization
      if (f.severity === 'info') notes++; else issues++;
      if (f.noScore) return; // e.g. Webflow's own scripts — shown, but not the developer's to fix
      f.check = f.check || matchCheckId(f.title || '');
      if (!f.check) { window.__SeoAuditorUnmatched.push(f.title); return; }
      bucket(f.check).findings.push(f);
    });
    successes.forEach(function (s) {
      if (s.category === 'Preliminary check') return;
      s.check = s.check || matchCheckId(s.title || '');
      if (!s.check) window.__SeoAuditorUnmatched.push(s.title);
    });

    var totalW = 0, earned = 0, failedChecks = 0;
    var failedRows = []; // for the clickable "checks that need attention" list
    CHECK_REGISTRY.forEach(function (c) {
      var fs = (perCheck[c.id] && perCheck[c.id].findings) || [];
      var evaluated = fs.length > 0 || hasOutput(c.id);
      if (!evaluated && c.always) evaluated = true;
      if (!evaluated && c.evalIfSuccessOf) evaluated = c.evalIfSuccessOf.some(function (id) { return hasOutput(id, true); });
      if (!evaluated && c.evalIfAnyOf) evaluated = c.evalIfAnyOf.some(function (id) { return hasOutput(id); });
      var total = checkTotals[c.id];
      if (c.total && !fs.length && !(total > 0)) evaluated = evaluated && total > 0; // per-element check with nothing to look at
      if (!evaluated) return;
      totalW += c.w;
      if (!fs.length) { earned += c.w; return; }
      failedChecks++;
      var lost;
      if (total > 0) {
        // Partial credit: each affected element costs its severity weight, spread over all
        // the elements the check looked at (3 bad images out of 40 ≈ 7.5% of the check lost).
        var sum = 0;
        fs.forEach(function (f) { sum += SEVERITY_WEIGHT[f.severity] || 1; });
        lost = Math.min(c.w, sum / total);
      } else {
        var worst = 0;
        fs.forEach(function (f) { worst = Math.max(worst, SEVERITY_WEIGHT[f.severity] || 1); });
        lost = Math.min(c.w, worst); // binary: the check fails as a whole
      }
      earned += c.w - lost;
      var worstSev = 'info';
      fs.forEach(function (f) { if (f.severity === 'error') worstSev = 'error'; else if (f.severity === 'warning' && worstSev !== 'error') worstSev = 'warning'; });
      failedRows.push({ id: c.id, label: CHECK_LABELS[c.id] || c.id, severity: worstSev, count: fs.length, lost: lost, findings: fs });
    });
    var pct = totalW > 0 ? Math.round((earned / totalW) * 1000) / 10 : 100;
    var sevRank = { error: 0, warning: 1, info: 2 };
    failedRows.forEach(function (r) { r.lostPct = totalW > 0 ? Math.round((r.lost / totalW) * 1000) / 10 : 0; });
    failedRows.sort(function (a, b) { return (b.lostPct - a.lostPct) || (sevRank[a.severity] - sevRank[b.severity]); });
    return { pct: pct, failedChecks: failedChecks, issues: issues, notes: notes, failedList: failedRows };
  }
  function optimizedColor(pct) {
    if (pct >= 80) return '#4ade80';
    if (pct >= 60) return '#fbbf24';
    return '#f87171';
  }
  function optimizedGradient(pct) {
    if (pct >= 80) return 'linear-gradient(90deg,#22c55e,#4ade80)';
    if (pct >= 60) return 'linear-gradient(90deg,#f59e0b,#fbbf24)';
    return 'linear-gradient(90deg,#ef4444,#f87171)';
  }
  function fmtPct(pct) { return (pct >= 100 ? '100' : pct.toFixed(1)) + '%'; }
  var lastShownPct = 0; // so the bar animates from where it last was, not from 0 on every re-render

  // Toast notification (11.08.2026) — a small, temporary, auto-dismissing message appended
  // directly to <html> (like highlightBox), NOT inside the shadow DOM panel, so it stays
  // visible even when it needs to warn about the panel itself (e.g. "the panel is covering
  // this element"). Reused for clipboard-copy confirmations too.
  var toastEl;
  function showToast(message) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.style.cssText = 'all:initial;position:fixed;bottom:24px;left:50%;transform:translateX(-50%);' +
        'background:#1f2333;color:#f3f4f6;font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;' +
        'font-size:12.5px;padding:10px 16px;border-radius:10px;box-shadow:0 10px 30px -6px rgba(0,0,0,.5),0 0 0 1px rgba(255,255,255,.08);' +
        'z-index:2147483647;max-width:360px;text-align:center;line-height:1.4;opacity:0;transition:opacity .2s ease;pointer-events:none;';
      document.documentElement.appendChild(toastEl);
    }
    toastEl.textContent = message;
    toastEl.style.opacity = '1';
    clearTimeout(showToast._timer);
    showToast._timer = setTimeout(function () {
      toastEl.style.opacity = '0';
    }, 3200);
  }

  // Clipboard helper (11.08.2026) — used by the "Copy report" header button and the per-item
  // "Copy" button next to a Fix suggestion. Tries the modern async Clipboard API first, falls
  // back to the older execCommand('copy') approach (via a temporary offscreen textarea) for
  // contexts where the Clipboard API is unavailable or blocked (e.g. insecure context, some
  // permission policies) — either way, the user gets a toast confirming success or failure.
  function copyToClipboard(str, successMessage) {
    function done(ok) {
      showToast(ok ? (successMessage || tr('Copied to clipboard.')) : tr('Could not copy to clipboard — your browser may be blocking it.'));
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(str).then(function () { done(true); }).catch(function () { done(false); });
    } else {
      try {
        var ta = document.createElement('textarea');
        ta.value = str;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        var ok = document.execCommand('copy');
        document.body.removeChild(ta);
        done(ok);
      } catch (e) {
        done(false);
      }
    }
  }

  // Indents every line of a (possibly multi-line) string with `prefix` — used so a finding's
  // detail lines (description, "Why it matters"...) stay visually subordinate to its numbered
  // title line, INCLUDING multi-line embedded content like the "Current/Suggested" code example
  // (11.08.2026 — a plain .replace() on the first line only would leave the continuation lines
  // of a multi-line description flush-left, undoing the indentation).
  function indentLines(text, prefix) {
    return String(text).split('\n').map(function (line) { return prefix + line; }).join('\n');
  }

  // Plain-text report builder (11.08.2026, reformatted for readability same day after feedback
  // that the wall-of-text version was hard to scan) — deliberately plain text (not HTML/
  // Markdown), so it pastes cleanly anywhere (Slack, email, a ClickUp comment, a plain
  // document), using only ASCII "=" divider lines and indentation for structure rather than
  // Markdown syntax that wouldn't render as intended in a plain-text destination. Per agreed
  // scope: includes title/category/severity/description/"why it matters" for every finding
  // (both tabs), but DELIBERATELY OMITS the `fix` suggestion text (the user asked for the report
  // to stay focused on WHAT's wrong and WHY it matters, not the fix — the "Copy fix" button on
  // each item covers the fix separately, on demand). Successes are summarized as counts only
  // (not a full per-item list) to keep the report a reasonable length.
  function buildReportText() {
    var seoFindings = findings.filter(function (f) { return f.group !== 'aeo'; });
    var aeoFindings = findings.filter(function (f) { return f.group === 'aeo' || f.crossRelevant; });
    var seoCounts = { error: 0, warning: 0, info: 0 };
    seoFindings.forEach(function (f) { seoCounts[f.severity] = (seoCounts[f.severity] || 0) + 1; });
    var aeoCounts = { error: 0, warning: 0, info: 0 };
    aeoFindings.forEach(function (f) { aeoCounts[f.severity] = (aeoCounts[f.severity] || 0) + 1; });
    var soloSeoSuccesses = successes.filter(function (s) { return s.group !== 'aeo' && !s.crossRelevant; }).length;
    var soloAeoSuccesses = successes.filter(function (s) { return s.group === 'aeo' && !s.crossRelevant; }).length;
    var sharedSuccesses = successes.filter(function (s) { return !!s.crossRelevant; }).length;
    var DIVIDER = '============================================================';

    var lines = [];
    lines.push(tr('SEO PAGE AUDITOR — Report'));
    lines.push(LOC.href);
    lines.push(new Date().toLocaleString());
    lines.push('');
    lines.push(DIVIDER);
    lines.push(tr('SUMMARY'));
    lines.push(DIVIDER);
    lines.push(tr('Page optimized :') + ' ' + fmtPct(computeOptimization().pct));
    lines.push(tr('SEO tab') + ': ' + seoCounts.error + ' ' + tr('errors') + ', ' + seoCounts.warning + ' ' + tr('warnings') + ', ' + seoCounts.info + ' ' + tr('info'));
    lines.push(tr('AEO tab') + ': ' + aeoCounts.error + ' ' + tr('errors') + ', ' + aeoCounts.warning + ' ' + tr('warnings') + ', ' + aeoCounts.info + ' ' + tr('info'));
    lines.push(tr('Successes :') + ' ' + successes.length + ' ' + tr('total') + ' (' + soloSeoSuccesses + ' ' + tr('SEO-only') + ', ' + soloAeoSuccesses + ' ' + tr('AEO-only') + ', ' + sharedSuccesses + ' SEO+AEO)');
    lines.push('');

    var order = { error: 0, warning: 1, info: 2 };
    function pushSection(title, list, contextGroup) {
      lines.push(DIVIDER);
      lines.push(tr(title) + ' (' + list.length + ')');
      lines.push(DIVIDER);
      lines.push('');
      if (!list.length) {
        lines.push(tr('(no findings)'));
        lines.push('');
        return;
      }
      var sorted = list.slice().sort(function (a, b) { return order[a.severity] - order[b.severity]; });
      sorted.forEach(function (f, idx) {
        lines.push((idx + 1) + '. [' + tr(f.severity).toUpperCase() + '] ' + tr(f.category) + ' — ' + tr(f.title) + deviceTagsText(f));
        if (f.description) lines.push(indentLines(tr(f.description), '   '));
        if (whereInfo(f)) lines.push(indentLines(whereText(f), '   '));
        if (f.crossRelevant) lines.push('   (' + tr(getCrossText(f, contextGroup)) + ')');
        if (f.globalNote) lines.push('   ' + tr('Global element:') + ' ' + tr(f.globalNote));
        if (f.ownerNote) lines.push(indentLines(tr('Who can fix:') + ' ' + tr(f.ownerNote), '   '));
        if (f.why) lines.push(indentLines(tr('Why it matters:') + ' ' + tr(f.why), '   '));
        lines.push('');
      });
    }
    pushSection('SEO FINDINGS', seoFindings, 'seo');
    pushSection('AEO FINDINGS', aeoFindings, 'aeo');

    return lines.join('\n');
  }

  // Per-URL history (11.08.2026, localStorage) — lets the panel show "last run vs. now" so a
  // developer re-running the audit after fixing issues gets an immediate sense of progress.
  // Legitimate use of localStorage here: this is a real bookmarklet running in a real browser
  // tab, not a Claude.ai artifact (where localStorage is unsupported/forbidden) — see SPEC.md.
  // Wrapped in try/catch throughout: localStorage can throw (private browsing modes, quota,
  // disabled storage) and none of this is essential to the tool's core function, so any failure
  // here must never break the audit itself.
  var HISTORY_KEY_PREFIX = 'seoAuditorHistory::';
  function loadPreviousRun() {
    try {
      var raw = localStorage.getItem(HISTORY_KEY_PREFIX + LOC.href);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }
  function saveCurrentRun() {
    try {
      var data = { totalFindings: findings.length, successes: successes.length, optimizedPct: computeOptimization().pct, timestamp: Date.now() };
      localStorage.setItem(HISTORY_KEY_PREFIX + LOC.href, JSON.stringify(data));
    } catch (e) {
      // Ignore — see comment above.
    }
  }
  var previousRun = null; // populated once at the very start of run(), before any checks execute

  // Panel setup persistence across a page refresh (11.08.2026, localStorage) — a bookmarklet has
  // no way to survive a full page reload on its own (the entire JS context is destroyed and
  // recreated from scratch — that requires a browser EXTENSION's content-script mechanism, which
  // this project deliberately isn't, per the install/distribution tradeoffs already documented in
  // SPEC.md). This is the closest practical equivalent: remember the panel's position, height,
  // and active tab/filters so that re-clicking the bookmarklet after a refresh (which the
  // Webflow publish → refresh workflow already requires) picks up right where the user left it,
  // instead of resetting to defaults every time. Cleared explicitly when the user clicks the ✕
  // close button (see clearPanelState() in closePanel()) — that's the deliberate "off" signal;
  // a mere page refresh is NOT treated as one.
  var PANEL_STATE_KEY_PREFIX = 'seoAuditorPanelState::';
  function loadPanelState() {
    try {
      var raw = localStorage.getItem(PANEL_STATE_KEY_PREFIX + LOC.href);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }
  function savePanelState() {
    try {
      var state = {
        panelPosition: panelPosition,
        panelHeight: panelHeight,
        activeTab: activeTab,
        activeSeverity: activeSeverity,
        activeCategory: activeCategory,
        activeCategoryOrigin: activeCategoryOrigin,
        activeSuccessGroup: activeSuccessGroup
      };
      localStorage.setItem(PANEL_STATE_KEY_PREFIX + LOC.href, JSON.stringify(state));
    } catch (e) {
      // Ignore — see comment above savePanelState()'s sibling functions.
    }
  }
  function clearPanelState() {
    try {
      localStorage.removeItem(PANEL_STATE_KEY_PREFIX + LOC.href);
    } catch (e) {
      // Ignore.
    }
  }

  // Report preview panel (11.08.2026, added after feedback that silently copying the report
  // straight to the clipboard gave no visibility into what was actually copied) — a second
  // floating panel, anchored to the LEFT of the main panel (which stays wherever it is/was
  // dragged to), showing the exact report text in a read-only textarea with a "Copy to
  // clipboard" button above it. `reportPreviewText` is a snapshot taken once when the preview
  // is opened (via the header's 📋 button) — it does not "live update" as new async findings
  // (e.g. CWV) arrive after that point; re-opening it (close + reopen) refreshes it.
  var reportPreviewVisible = false;
  var reportPreviewText = '';

  function renderReportPreview() {
    if (!shadow) return;
    var existing = shadow.querySelector('.report-preview');
    if (existing) existing.remove();
    if (!reportPreviewVisible) return;

    var box = document.createElement('div');
    box.className = 'report-preview';

    var pHdr = document.createElement('div');
    pHdr.className = 'report-preview-hdr';
    pHdr.innerHTML = '<b>' + tr('Report preview') + '</b>';
    var pClose = document.createElement('button');
    pClose.textContent = '✕';
    pClose.title = tr('Close preview');
    // Full renderPanel() (not just renderReportPreview()) so the header toggle button also loses
    // its "active" state when the preview is closed from here — keeps both entry points (the
    // header toggle and this ✕) in sync (12.08.2026).
    pClose.onclick = function () { reportPreviewVisible = false; renderPanel(); };
    pHdr.appendChild(pClose);
    box.appendChild(pHdr);

    var pActions = document.createElement('div');
    pActions.className = 'report-preview-actions';
    var pCopyBtn = document.createElement('button');
    pCopyBtn.className = 'copybtn report-preview-copybtn';
    pCopyBtn.textContent = tr('📋 Copy to clipboard');
    pCopyBtn.onclick = function () { copyToClipboard(reportPreviewText, tr('Report copied to clipboard.')); };
    pActions.appendChild(pCopyBtn);
    box.appendChild(pActions);

    // A <textarea> (read-only) rather than a plain <div> — this also gives the user a manual
    // fallback way to select-all/copy the text themselves if the Clipboard API is ever blocked.
    var ta = document.createElement('textarea');
    ta.className = 'report-preview-textarea';
    ta.readOnly = true;
    ta.value = reportPreviewText;
    box.appendChild(ta);

    shadow.appendChild(box);

    // Dock the preview flush against the LEFT edge of the main panel (touching, no gap) and
    // VERTICALLY CENTERED on it — height capped to 90% of the panel's height (so it never
    // visually overshoots the panel even while it's being resized) with the leftover 10% split
    // evenly above/below, instead of pinned to the panel's top (11.08.2026 initial dock; gap
    // removed + height cap 12.08.2026; centered 12.08.2026 per follow-up request). Recomputed
    // here (in addition to the live drag/resize sync in setupDragHandlers()) so it's correctly
    // placed the moment it's first opened, before any drag/resize happens.
    var panelEl = shadow.querySelector('.panel');
    if (panelEl) {
      var pRect = panelEl.getBoundingClientRect();
      var panelH = pRect.height || 600;
      var previewWidth = box.getBoundingClientRect().width || 440;
      var previewHeight = panelH * 0.9;
      box.style.top = (pRect.top + (panelH - previewHeight) / 2) + 'px';
      box.style.left = Math.max(0, pRect.left - previewWidth) + 'px';
      box.style.height = previewHeight + 'px';
    }
  }

  function setupDragHandlers() {
    if (setupDragHandlers._attached) return;
    setupDragHandlers._attached = true;
    document.addEventListener('mousemove', function (e) {
      var panelEl = shadow && shadow.querySelector('.panel');
      if (!panelEl) return;
      // The report-preview panel (11.08.2026) is docked to the main panel's left edge — while
      // dragging/resizing, reposition it in lockstep so it visually stays "attached" instead of
      // lagging until the next renderPanel() call.
      var previewEl = shadow.querySelector('.report-preview');
      if (isDragging) {
        var dx = e.clientX - dragStartX;
        var dy = e.clientY - dragStartY;
        var newTop = Math.max(0, Math.min(window.innerHeight - 30, dragStartTop + dy));
        var newLeft = Math.max(0, Math.min(window.innerWidth - 30, dragStartLeft + dx));
        panelEl.style.top = newTop + 'px';
        panelEl.style.left = newLeft + 'px';
        panelEl.style.right = 'auto';
        panelPosition = { top: newTop, left: newLeft };
        if (previewEl) {
          // Flush against the panel's left edge — no gap (12.08.2026). Vertically centered on
          // the panel (12.08.2026) — dragging only moves top/left, height is unaffected, so the
          // existing rect height (still valid right after the top/left assignment above) gives
          // the offset needed to keep the preview centered as it follows the panel.
          var previewWidth = previewEl.getBoundingClientRect().width || 440;
          var curPanelHeight = panelEl.getBoundingClientRect().height;
          var previewHeightNow = curPanelHeight * 0.9;
          previewEl.style.top = (newTop + (curPanelHeight - previewHeightNow) / 2) + 'px';
          previewEl.style.left = Math.max(0, newLeft - previewWidth) + 'px';
        }
      }
      if (isResizing) {
        var dyResize = e.clientY - resizeStartY;
        var newHeight = Math.max(MIN_PANEL_HEIGHT, resizeStartHeight + dyResize);
        panelEl.style.height = newHeight + 'px';
        panelHeight = newHeight;
        if (previewEl) {
          // Capped to 90% of the panel's height so the preview never grows taller than (or even
          // as tall as) the panel while it's being resized (12.08.2026), and re-centered on the
          // panel's (unchanged, since resize only grows downward) top for every new height
          // (12.08.2026, per follow-up request).
          var previewHeightResized = newHeight * 0.9;
          var panelTopNow = panelEl.getBoundingClientRect().top;
          previewEl.style.height = previewHeightResized + 'px';
          previewEl.style.top = (panelTopNow + (newHeight - previewHeightResized) / 2) + 'px';
        }
      }
    });
    document.addEventListener('mouseup', function () {
      if (isDragging) { isDragging = false; document.body.style.userSelect = ''; savePanelState(); }
      if (isResizing) { isResizing = false; document.body.style.userSelect = ''; savePanelState(); }
    });
  }

  // Closes the panel/highlight box and resets the running flag — shared by the header's ✕
  // button and the Esc keyboard shortcut (11.08.2026) so both go through the exact same
  // teardown path.
  function closePanel() {
    if (panelHost) panelHost.remove();
    if (highlightBox) highlightBox.remove();
    clearAllHighlights();
    reportPreviewVisible = false;
    checksViewOpen = false;
    activeCheckFilter = null;
    clearPanelState(); // explicit ✕/Esc close = "forget where I was", unlike a mere page refresh
    window.__SeoAuditorRunning = false;
  }

  // Keyboard navigation (11.08.2026): Up/Down cycles through whatever list is currently visible
  // in the panel (respecting the active tab/severity/category filter — see `lastRenderedRows`,
  // populated fresh on every renderPanel() call), Esc closes the panel. Ignored while the user
  // is typing into a normal page input/textarea/contenteditable, since this is a document-level
  // listener and the audited page may have its own forms.
  function setupKeyboardHandlers() {
    if (setupKeyboardHandlers._attached) return;
    setupKeyboardHandlers._attached = true;
    document.addEventListener('keydown', function (e) {
      if (!panelHost) return;
      var tag = (e.target && e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || (e.target && e.target.isContentEditable)) return;

      if (e.key === 'Escape') {
        closePanel();
        return;
      }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      if (!lastRenderedRows.length) return;
      e.preventDefault();
      if (selectedIndex === -1) {
        selectedIndex = 0;
      } else if (e.key === 'ArrowDown') {
        selectedIndex = Math.min(selectedIndex + 1, lastRenderedRows.length - 1);
      } else {
        selectedIndex = Math.max(selectedIndex - 1, 0);
      }
      var row = lastRenderedRows[selectedIndex];
      if (!row) return;
      lastRenderedRows.forEach(function (r) { r.el.classList.remove('kbd-selected'); });
      row.el.classList.add('kbd-selected');
      row.el.scrollIntoView({ block: 'nearest' });
      if (row.item.element) highlightElement(row.item.element);
    });
  }

  function ensurePanel() {
    if (panelHost) return;
    panelHost = document.createElement('div');
    panelHost.id = 'seo-audit-host';
    panelHost.style.cssText = 'all:initial;position:fixed;top:0;right:0;z-index:2147483647;';
    document.documentElement.appendChild(panelHost);
    shadow = panelHost.attachShadow({ mode: 'open' });

    var style = document.createElement('style');
    style.textContent = [
      ':host{all:initial;}',
      // box-sizing:border-box on ALL elements inside the panel — without this, padding/border on
      // .item or .desc can push content wider than the panel's declared width and cause a
      // horizontal scroll even when word-break is set up correctly.
      '.panel *{box-sizing:border-box;}',
      // --- Visual redesign (10.08.2026) — the user asked for a "more modern" look, the previous
      // one felt "old school"/unpolished. The main culprits were: flat single-color backgrounds,
      // fully saturated colors on severity badges (a classic "Windows alert box" look), a sharp
      // 2px line for the active tab, a generic system font, and default (unstyled)
      // scrollbar/select. Fixes below, in order.
      //
      // 1) Font: Inter (if available on the system, or via the fallback chain) instead of the
      // generic system-ui stack, plus font-smoothing for cleaner text rendering across all OSes.
      // 2) Panel background: a subtle vertical gradient (instead of the flat #111827) + a subtle
      // 1px "inset" border + a softer, deeper shadow — gives a "floating card" feel.
      // 3) Top accent bar (indigo→amber gradient, the same accent as the new SVG icon) —
      // a small detail that immediately signals this is a designed product, not a quick prototype.
      '.panel{position:fixed;top:12px;right:12px;width:380px;max-width:calc(100vw - 24px);max-height:90vh;min-height:' + MIN_PANEL_HEIGHT + 'px;display:flex;flex-direction:column;background:linear-gradient(180deg,#171a2e 0%,#0d0f1a 100%);color:#f3f4f6;font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased;font-size:13px;border-radius:16px;box-shadow:0 24px 60px -12px rgba(0,0,0,.6),0 0 0 1px rgba(255,255,255,.06);z-index:2147483647;overflow-x:hidden;overflow-y:hidden;}',
      '.panel::before{content:"";position:absolute;top:0;left:0;right:0;height:3px;background:linear-gradient(90deg,#6366f1,#a855f7 60%,#f59e0b);border-radius:16px 16px 0 0;}',
      '.hdr{position:relative;flex:0 0 auto;padding:13px 10px 13px 14px;background:rgba(255,255,255,.02);border-bottom:1px solid rgba(255,255,255,.06);display:flex;justify-content:space-between;align-items:center;cursor:move;user-select:none;}',
      '.hdr-title{display:flex;align-items:center;gap:8px;}',
      '.hdr-title svg{flex:0 0 auto;display:block;}',
      '.hdr b{font-size:13.5px;font-weight:700;letter-spacing:.01em;}',
      '.hdr button{background:transparent;color:#9ca3af;border:none;cursor:pointer;font-size:15px;width:26px;height:26px;border-radius:8px;display:flex;align-items:center;justify-content:center;transition:background-color .15s ease,color .15s ease;}',
      '.hdr button:hover{background:rgba(255,255,255,.08);color:#f3f4f6;}',
      // "Pressed" look for a toggle button in the header (e.g. the Report-preview button, 12.08.2026)
      // — same amber accent as the "Highlight all" toggle badge, so both read as the same kind of
      // on/off control.
      '.hdr button.active{background:rgba(245,158,11,.16);color:#fbbf24;box-shadow:inset 0 0 0 1px rgba(245,158,11,.4);}',
      '.hdr button.active:hover{background:rgba(245,158,11,.24);color:#fbbf24;}',
      // EN / SR language switch (29.10.2026)
      '.langsw{display:flex;align-items:center;gap:1px;margin-right:4px;background:rgba(255,255,255,.06);border-radius:8px;padding:2px;}',
      '.hdr .langsw button{width:auto;height:22px;padding:0 7px;font-size:10.5px;font-weight:700;letter-spacing:.04em;border-radius:6px;}',
      '.hdr .langsw button.on{background:rgba(99,102,241,.4);color:#e0e7ff;}',
      '.tabs{flex:0 0 auto;display:flex;gap:2px;padding:6px 8px 0;background:transparent;}',
      '.tabbtn{flex:1;padding:8px 6px;background:transparent;border:none;color:#8b93a7;font-size:12px;font-weight:600;cursor:pointer;border-radius:8px 8px 0 0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;transition:background-color .15s ease,color .15s ease;position:relative;}',
      '.tabbtn:hover{color:#e5e7eb;background:rgba(255,255,255,.04);}',
      '.tabbtn.active{color:#f3f4f6;background:rgba(255,255,255,.07);}',
      '.tabbtn.active::after{content:"";position:absolute;left:10px;right:10px;bottom:0;height:2px;border-radius:2px;background:#6366f1;}',
      '.tabbtn.success-tab.active::after{background:#22c55e;}',
      '.summary{flex:0 0 auto;padding:10px 14px;display:flex;flex-wrap:wrap;gap:6px;border-bottom:1px solid rgba(255,255,255,.06);}',
      // Dropdown row for filtering by category (Images, Links...) — sits BELOW the severity
      // summary row, above the list. A native <select> styled to match the panel's dark theme,
      // with a custom arrow (SVG data-uri) instead of the default one (which looks dated).
      '.catrow{flex:0 0 auto;padding:0 14px 10px;border-bottom:1px solid rgba(255,255,255,.06);}',
      '.cat-select{appearance:none;-webkit-appearance:none;width:100%;background:rgba(255,255,255,.05) url(\'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="10" height="6" viewBox="0 0 10 6"><path d="M1 1L5 5L9 1" stroke="%239ca3af" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>\') no-repeat right 10px center;color:#e5e7eb;border:1px solid rgba(255,255,255,.1);border-radius:8px;padding:7px 28px 7px 10px;font-size:12px;font-family:inherit;cursor:pointer;transition:border-color .15s ease,background-color .15s ease;}',
      '.cat-select:hover{border-color:rgba(255,255,255,.22);background-color:rgba(255,255,255,.08);}',
      // 4) Badges: moving from fully saturated backgrounds (a classic "alert box" look) to
      // subtle, translucent "tinted pill" colors with a thin border and a small dot of the same
      // color before the text (added via ::before, without changing the JS/DOM structure) — this
      // is the single biggest change that "reduces" the old-school feel, since the fully
      // saturated backgrounds were the main culprit.
      '.badge{border-radius:20px;padding:3px 10px;font-weight:600;font-size:11.5px;cursor:pointer;user-select:none;border:1px solid transparent;white-space:nowrap;display:inline-flex;align-items:center;gap:5px;transition:border-color .15s ease,background-color .15s ease,transform .1s ease;}',
      '.badge:hover{transform:translateY(-1px);}',
      '.badge::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor;flex:0 0 auto;}',
      '.badge.tag{cursor:default;}',
      '.badge.tag:hover{transform:none;}',
      '.badge.tag::before{display:none;}',
      '.badge.all{background:rgba(148,163,184,.12);color:#cbd5e1;border-color:rgba(148,163,184,.25);}',
      '.badge.error{background:rgba(239,68,68,.12);color:#fca5a5;border-color:rgba(239,68,68,.3);}',
      '.badge.warning{background:rgba(245,158,11,.12);color:#fcd34d;border-color:rgba(245,158,11,.3);}',
      '.badge.info{background:rgba(59,130,246,.12);color:#93c5fd;border-color:rgba(59,130,246,.3);}',
      '.badge.success{background:rgba(34,197,94,.12);color:#86efac;border-color:rgba(34,197,94,.3);}',
      // Group filter/tags WITHIN the Success tab (SEO/AEO classification of successful checks) —
      // deliberately different colors from .badge.info (blue) and the AEO tab, so they're
      // visually distinguishable as a "group" rather than a "severity". "All" uses the same
      // green as the generic success badge.
      '.badge.group-all{background:rgba(34,197,94,.12);color:#86efac;border-color:rgba(34,197,94,.3);}',
      '.badge.group-seo{background:rgba(99,102,241,.12);color:#a5b4fc;border-color:rgba(99,102,241,.3);}',
      '.badge.group-aeo{background:rgba(168,85,247,.12);color:#d8b4fe;border-color:rgba(168,85,247,.3);}',
      // "shared" (SEO + AEO) uses amber — the same color as the "signal" accent in the tool's
      // logo, which represents the page "broadcasting" a signal to both types of engines (10.08.2026).
      '.badge.group-shared{background:rgba(245,158,11,.12);color:#fbbf24;border-color:rgba(245,158,11,.3);}',
      '.badge.active{border-color:#6366f1;box-shadow:0 0 0 1px rgba(99,102,241,.35);}',
      '.badge.group-all.active{border-color:#22c55e;box-shadow:0 0 0 1px rgba(34,197,94,.35);}',
      '.badge.group-seo.active{border-color:#6366f1;box-shadow:0 0 0 1px rgba(99,102,241,.35);}',
      '.badge.group-aeo.active{border-color:#a855f7;box-shadow:0 0 0 1px rgba(168,85,247,.35);}',
      '.badge.group-shared.active{border-color:#f59e0b;box-shadow:0 0 0 1px rgba(245,158,11,.35);}',
      '.badge.success.active{border-color:#22c55e;box-shadow:0 0 0 1px rgba(34,197,94,.35);}',
      // "Highlight all" toggle badge (11.08.2026) — amber, matching the amber boxes it draws on
      // the page (see showAllHighlights()), so the color itself hints at what the toggle does.
      '.badge.highlightall{background:rgba(245,158,11,.1);color:#fbbf24;border-color:rgba(245,158,11,.28);}',
      '.badge.highlightall.active{border-color:#f59e0b;box-shadow:0 0 0 1px rgba(245,158,11,.35);}',
      // .list is the only scrolling part of the panel — flex:1 fills all remaining space between
      // the fixed parts (header/tabs/summary) and the resize handle at the bottom.
      // overflow-x:hidden + overflow-y:auto — allows vertical scroll, but NEVER horizontal.
      '.list{flex:1 1 auto;min-height:0;overflow-y:auto;overflow-x:hidden;}',
      // 5) A custom (thin, rounded) scrollbar instead of the default one — the default thick gray
      // scrollbar is one of the most obvious "someone threw this together quickly" signals in
      // dark panels.
      '.list::-webkit-scrollbar{width:8px;}',
      '.list::-webkit-scrollbar-track{background:transparent;}',
      '.list::-webkit-scrollbar-thumb{background:rgba(255,255,255,.12);border-radius:8px;}',
      '.list::-webkit-scrollbar-thumb:hover{background:rgba(255,255,255,.2);}',
      '.item{padding:11px 14px;border-bottom:1px solid rgba(255,255,255,.05);cursor:pointer;max-width:100%;transition:background-color .15s ease;}',
      '.item:hover{background:rgba(255,255,255,.035);}',
      '.item.success-item{cursor:default;}',
      '.item.success-item:hover{background:transparent;}',
      // word-break/overflow-wrap on ALL text parts of an item — this is what actually prevents
      // horizontal scroll when the text contains long URLs, code with no spaces
      // (e.g. <script src="...">) or long words with no natural break point. white-space
      // stays pre-wrap on .desc (preserves intentional newlines from the code), but
      // overflow-wrap:anywhere can still break an overly long single "word" (e.g. a URL) mid-way
      // if it has to.
      '.item .cat, .item .title, .item .desc{overflow-wrap:anywhere;word-break:break-word;}',
      '.item .cat{color:#8b93a7;font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;font-weight:600;}',
      '.item .title{font-weight:600;margin:4px 0;line-height:1.4;}',
      // DELIBERATELY no max-height/overflow:hidden here — an earlier version truncated longer
      // text (e.g. the "Current/Suggested" script example, or a longer "why" explanation) at
      // 60px with no way to read the rest. Text is now always shown at full height; the outer
      // .list container handles scrolling for the whole list.
      '.item .desc{color:#c3c9d6;white-space:pre-wrap;font-size:12px;line-height:1.5;margin-top:4px;}',
      '.item .desc.where{color:#a5b4fc;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;}',
      '.item .global{margin-top:6px;color:#fbbf24;font-size:11px;overflow-wrap:anywhere;word-break:break-word;}',
      '.item .owner{margin-top:6px;color:#fcd34d;font-size:11px;overflow-wrap:anywhere;word-break:break-word;}',
      '.item .cross{margin-top:6px;color:#c4b5fd;font-size:11px;overflow-wrap:anywhere;word-break:break-word;}',
      '.empty{padding:32px 20px;color:#8b93a7;font-size:13px;text-align:center;line-height:1.5;}',
      '.tag{display:inline-block;margin-right:4px;}',
      // 6) Resize handle: a fine, rounded "grip" pill (::after) instead of the text "•••", the
      // same interaction behavior (dragging changes the height), just a more subtle visual language.
      '.resize-handle{flex:0 0 auto;height:16px;display:flex;align-items:center;justify-content:center;cursor:ns-resize;background:transparent;border-top:1px solid rgba(255,255,255,.05);user-select:none;}',
      '.resize-handle::after{content:"";width:32px;height:4px;border-radius:4px;background:rgba(255,255,255,.14);transition:background-color .15s ease;}',
      '.resize-handle:hover::after{background:rgba(255,255,255,.28);}',
      // Score badge in the header (11.08.2026) — color is set inline per-render (green/amber/
      // red depending on the score), only the shape/spacing lives here.
      // "Page optimized" progress bar (28.10.2026) — sits right under the header, above the tabs.
      '.prog{flex:0 0 auto;padding:11px 14px 12px;border-bottom:1px solid rgba(255,255,255,.06);}',
      '.prog-top{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px;}',
      '.prog-lbl{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:#9ca3af;font-weight:600;cursor:help;}',
      '.prog-pct{font-size:17px;font-weight:800;font-variant-numeric:tabular-nums;}',
      '.prog-track{height:9px;border-radius:999px;background:rgba(255,255,255,.08);overflow:hidden;}',
      '.prog-fill{height:100%;border-radius:999px;transition:width .6s cubic-bezier(.22,1,.36,1);}',
      '.prog-sub{margin-top:8px;font-size:11.5px;color:#9ca3af;}',
      // Each stat stays on one line (wraps BETWEEN stats, never inside one); the "vs last run" delta sits on its own line below.
      '.prog-stats{display:flex;flex-wrap:wrap;gap:2px 0;position:relative;}',
      // Instant, readable hover tooltip for the checks / issues / notes counters (replaces the slow native title tooltip)
      '.prog-stats .st[data-tip]{cursor:help;}',
      '.prog-stats .st[data-tip]:hover::after{content:attr(data-tip);position:absolute;left:0;right:0;top:calc(100% + 6px);z-index:30;white-space:normal;background:#1f2333;color:#e5e7eb;font-size:11.5px;line-height:1.5;font-weight:400;padding:9px 11px;border-radius:10px;box-shadow:0 10px 30px -6px rgba(0,0,0,.6),0 0 0 1px rgba(255,255,255,.1);pointer-events:none;}',
      '.prog-stats .st{white-space:nowrap;}',
      '.prog-stats .st+.st::before{content:"·";margin:0 7px;color:#4b5563;}',
      '.prog-delta{margin-top:4px;font-size:11px;color:#6b7280;}',
      '.prog-stats .st-link{cursor:pointer;text-decoration:underline dotted #6b7280;text-underline-offset:3px;}',
      '.prog-stats .st-link:hover{color:#e5e7eb;text-decoration-color:#e5e7eb;}',
      // "Checks that need attention" view + "showing only this check" chip (29.10.2026)
      '.cv-hdr{flex:0 0 auto;display:flex;align-items:center;gap:10px;padding:9px 14px;border-bottom:1px solid rgba(255,255,255,.06);}',
      '.cv-back{background:rgba(255,255,255,.06);border:none;color:#d1d5db;font-size:11.5px;font-weight:600;padding:4px 10px;border-radius:8px;cursor:pointer;white-space:nowrap;}',
      '.cv-back:hover{background:rgba(255,255,255,.12);color:#fff;}',
      '.cv-title{font-size:12.5px;font-weight:700;color:#f3f4f6;}',
      '.cv-note{padding:9px 14px;font-size:11.5px;line-height:1.5;color:#9ca3af;border-bottom:1px solid rgba(255,255,255,.06);}',
      '.chk-row{display:flex;align-items:center;gap:9px;padding:9px 14px;border-bottom:1px solid rgba(255,255,255,.06);cursor:pointer;}',
      '.chk-row:hover{background:rgba(255,255,255,.05);}',
      '.chk-row .badge{flex:0 0 auto;min-width:74px;justify-content:center;}',
      '.chk-name{flex:1;min-width:0;font-size:12.5px;color:#e5e7eb;}',
      '.chk-meta{flex:0 0 auto;font-size:11px;color:#9ca3af;white-space:nowrap;}',
      '.chk-meta b{color:#f87171;font-weight:700;}',
      '.filterchip{flex:0 0 auto;display:flex;align-items:center;justify-content:space-between;gap:8px;padding:7px 14px;font-size:11.5px;color:#c7d2fe;background:rgba(99,102,241,.1);border-bottom:1px solid rgba(99,102,241,.25);}',
      '.filterchip b{color:#e0e7ff;}',
      '.filterchip button{background:transparent;border:1px solid rgba(165,180,252,.4);color:#c7d2fe;font-size:11px;padding:2px 8px;border-radius:999px;cursor:pointer;white-space:nowrap;}',
      '.filterchip button:hover{background:rgba(99,102,241,.25);}',
      '.prog-sub b{color:#e5e7eb;font-weight:600;}',
      // Generic small "Copy" button (11.08.2026) — used for the header's "Copy report" action
      // and the per-item "Copy fix" action. Deliberately subtle (not a full .badge) so it reads
      // as a secondary/utility action, not a primary control.
      '.copybtn{margin-left:6px;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.16);color:#e5e7eb;border-radius:6px;padding:1px 7px;font-size:10.5px;font-family:inherit;cursor:pointer;transition:background-color .15s ease;}',
      '.copybtn:hover{background:rgba(255,255,255,.18);}',
      // "Previous run vs. now" banner (11.08.2026, localStorage-backed) — sits below the tab bar,
      // above the severity/group summary, and applies regardless of which tab is active (it's a
      // whole-page comparison, not per-tab).
      // Device tags (phone / tablet / monitor icons) + the "closed tab / accordion" eye icon, with an instant CSS tooltip (30.10.2026).
      '.devtags{position:relative;display:inline-flex;align-items:center;gap:3px;margin-right:6px;padding:2px 7px;border-radius:20px;vertical-align:middle;cursor:help;color:#c4b5fd;background:rgba(139,92,246,.14);border:1px solid rgba(139,92,246,.35);line-height:1;}',
      '.devtags.uitag{color:#9ca3af;background:rgba(255,255,255,.06);border-color:rgba(255,255,255,.16);}',
      '.devtags svg{display:block;}',
      '.devtags:hover::after{content:attr(data-tip);position:absolute;left:0;top:calc(100% + 6px);z-index:40;width:max-content;max-width:230px;white-space:normal;background:#1f2333;color:#e5e7eb;font-size:11.5px;line-height:1.5;font-weight:400;padding:8px 10px;border-radius:10px;box-shadow:0 10px 30px -6px rgba(0,0,0,.6),0 0 0 1px rgba(255,255,255,.1);pointer-events:none;}',
      '.devscan{flex:0 0 auto;padding:7px 14px;font-size:11px;color:#9ca3af;line-height:1.7;background:rgba(255,255,255,.02);border-bottom:1px solid rgba(255,255,255,.06);}',
      '.devscan svg{display:inline-block;vertical-align:-2px;margin-right:1px;}',
      '.devscan .devwarn{color:#fbbf24;margin-top:2px;}',
      // "Analysis in progress" banner: an indeterminate bar + the current step.
      '.loading{flex:0 0 auto;padding:10px 14px 11px;background:linear-gradient(90deg,rgba(99,102,241,.14),rgba(168,85,247,.10));border-bottom:1px solid rgba(139,92,246,.3);}',
      '.loading .ld-bar{height:3px;border-radius:3px;background:rgba(255,255,255,.1);overflow:hidden;margin-bottom:8px;}',
      '.loading .ld-bar i{display:block;height:100%;width:38%;border-radius:3px;background:linear-gradient(90deg,#6366f1,#a855f7);animation:ldslide 1.2s ease-in-out infinite;}',
      '@keyframes ldslide{0%{transform:translateX(-110%);}100%{transform:translateX(280%);}}',
      '.loading .ld-txt{display:flex;flex-direction:column;gap:2px;font-size:11.5px;line-height:1.45;color:#c4b5fd;}',
      '.loading .ld-txt b{color:#e9e5ff;font-size:12.5px;}',
      '.loading .ld-note{color:#9ca3af;font-size:10.5px;}',
      '.prog.busy .prog-pct{opacity:.5;}',
      '.prevrun{flex:0 0 auto;padding:8px 14px;font-size:11px;color:#9ca3af;line-height:1.4;background:rgba(255,255,255,.02);border-bottom:1px solid rgba(255,255,255,.06);}',
      // Keyboard-selected item (11.08.2026, Up/Down navigation) — a left accent bar + tint,
      // distinct from :hover so it stays visible while the mouse is elsewhere.
      '.item.kbd-selected{background:rgba(99,102,241,.1);box-shadow:inset 3px 0 0 #6366f1;}',
      // Report preview panel (11.08.2026, redocked same day after feedback) — DOCKED next to the
      // main panel's left edge (touching, no gap): rounded on its own LEFT side, FLAT on the
      // RIGHT side where it touches the main panel, so it still reads as a drawer glued to the
      // panel rather than a fully independent floating card. Originally the main panel's own
      // left corners were ALSO squared off (via a `.panel.has-preview` override) to make the
      // pair look like one fully fused shape — but that made the main panel visibly lose its
      // rounding while the preview was open (flagged via screenshot, 12.08.2026), so that part
      // was removed: the main panel now ALWAYS keeps its normal full border-radius (its own
      // `.panel{...border-radius:16px...}` rule is never overridden). Only the PREVIEW's own
      // right edge stays square — clarified by the user (13.08.2026) after an interim attempt
      // rounded all 4 corners of the preview too, which wasn't what was wanted; it should stay
      // glued/flat on the side touching the panel.
      '.report-preview{position:fixed;top:12px;left:12px;width:440px;max-width:calc(100vw - 24px);height:min(600px,80vh);display:flex;flex-direction:column;background:linear-gradient(180deg,#171a2e 0%,#0d0f1a 100%);color:#f3f4f6;font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;font-size:13px;border-radius:16px 0 0 16px;box-shadow:0 24px 60px -12px rgba(0,0,0,.6),0 0 0 1px rgba(255,255,255,.06);z-index:2147483647;overflow:hidden;}',
      '.report-preview::before{content:"";position:absolute;top:0;left:0;right:0;height:3px;background:linear-gradient(90deg,#6366f1,#a855f7 60%,#f59e0b);border-radius:16px 0 0 0;}',
      '.report-preview-hdr{flex:0 0 auto;padding:13px 10px 13px 14px;background:rgba(255,255,255,.02);border-bottom:1px solid rgba(255,255,255,.06);display:flex;justify-content:space-between;align-items:center;}',
      '.report-preview-hdr b{font-size:13.5px;font-weight:700;letter-spacing:.01em;}',
      '.report-preview-hdr button{background:transparent;color:#9ca3af;border:none;cursor:pointer;font-size:15px;width:26px;height:26px;border-radius:8px;display:flex;align-items:center;justify-content:center;transition:background-color .15s ease,color .15s ease;}',
      '.report-preview-hdr button:hover{background:rgba(255,255,255,.08);color:#f3f4f6;}',
      // The "Copy to clipboard" action sits ABOVE the text content (per explicit request), in
      // its own row, so it's the first thing the eye lands on before scanning the report itself.
      '.report-preview-actions{flex:0 0 auto;padding:10px 14px;border-bottom:1px solid rgba(255,255,255,.06);}',
      '.report-preview-copybtn{margin-left:0;padding:6px 14px;font-size:12.5px;font-weight:600;border-radius:8px;}',
      // scrollbar-width/-color cover Firefox (no ::-webkit-scrollbar support there); the report
      // can be tens of thousands of px tall (200+ findings) against a ~1500px viewport, which
      // makes a subtle thumb nearly invisible, so this is intentionally higher-contrast/wider
      // than the main panel's .list scrollbar (12.08.2026, per explicit "I don't see a scrollbar"
      // report).
      '.report-preview-textarea{flex:1 1 auto;min-height:0;width:100%;border:none;outline:none;resize:none;background:transparent;color:#c3c9d6;font-family:"SF Mono",Monaco,Consolas,"Courier New",monospace;font-size:11.5px;line-height:1.6;padding:14px;white-space:pre-wrap;overflow-y:auto;overflow-x:hidden;scrollbar-width:auto;scrollbar-color:rgba(255,255,255,.35) rgba(255,255,255,.06);}',
      '.report-preview-textarea::-webkit-scrollbar{width:10px;}',
      '.report-preview-textarea::-webkit-scrollbar-track{background:rgba(255,255,255,.06);border-radius:8px;}',
      '.report-preview-textarea::-webkit-scrollbar-thumb{background:rgba(255,255,255,.35);border-radius:8px;border:2px solid transparent;background-clip:padding-box;}',
      '.report-preview-textarea::-webkit-scrollbar-thumb:hover{background:rgba(255,255,255,.5);background-clip:padding-box;}'
    ].join('');
    shadow.appendChild(style);

    highlightBox = document.createElement('div');
    highlightBox.style.cssText = 'position:fixed;pointer-events:none;border:3px solid #ef4444;border-radius:4px;z-index:2147483646;box-shadow:0 0 0 4000px rgba(0,0,0,.35);display:none;transition:all .15s ease;';
    document.documentElement.appendChild(highlightBox);

    setupDragHandlers();
    setupKeyboardHandlers();
  }

  // True if two DOMRect-like boxes overlap at all (11.08.2026, used by the "panel is covering
  // the element" warning below).
  function rectsOverlap(a, b) {
    return !(b.left > a.right || b.right < a.left || b.top > a.bottom || b.bottom < a.top);
  }

  // "Highlight all at once" (11.08.2026) — draws a box around every currently-listed
  // finding/success that has a bound element, all at the same time, instead of the normal
  // one-at-a-time click-to-highlight. Deliberately a SEPARATE box style from the single-item
  // highlightBox (amber border, no darkening backdrop) — with many boxes on screen at once the
  // full-viewport "spotlight" dimming trick used by highlightElement() would just make most of
  // the page uniformly dark, defeating the point. Deliberately DOES NOT run the panel-overlap
  // toast check (see highlightElement()) — with potentially dozens of boxes on screen, the panel
  // covering at least one of them is the expected, unremarkable case, not something worth
  // interrupting the user about every time this view refreshes (per user request, 11.08.2026).
  var highlightAllActive = false;
  var highlightAllBoxes = [];
  function clearAllHighlights() {
    highlightAllBoxes.forEach(function (box) { box.remove(); });
    highlightAllBoxes = [];
  }
  function showAllHighlights(items) {
    clearAllHighlights();
    items.forEach(function (item) {
      if (!item.element) return;
      var r = item.element.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return; // not laid out / not on screen right now
      var box = document.createElement('div');
      box.style.cssText = 'position:fixed;pointer-events:none;border:2px solid #fbbf24;border-radius:4px;z-index:2147483645;' +
        'box-shadow:0 0 0 2px rgba(251,191,36,.2);transition:opacity .15s ease;' +
        'top:' + (r.top - 3) + 'px;left:' + (r.left - 3) + 'px;width:' + (r.width + 6) + 'px;height:' + (r.height + 6) + 'px;';
      document.documentElement.appendChild(box);
      highlightAllBoxes.push(box);
    });
  }

  function highlightElement(el) {
    if (!el) { highlightBox.style.display = 'none'; return; }
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setTimeout(function () {
      var r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) { // e.g. a link inside a collapsed menu
        highlightBox.style.display = 'none';
        showToast(tr('This element is hidden right now (e.g. inside a closed tab, accordion or menu, or hidden at this screen width) — open it or resize the window to see it.'));
        return;
      }
      highlightBox.style.display = 'block';
      highlightBox.style.top = (r.top - 4) + 'px';
      highlightBox.style.left = (r.left - 4) + 'px';
      highlightBox.style.width = (r.width + 8) + 'px';
      highlightBox.style.height = (r.height + 8) + 'px';

      // 11.08.2026: the panel is a fixed-position overlay, so it can end up sitting directly on
      // top of the very element it just highlighted (most likely when the element is near the
      // top-right of the viewport, the panel's default corner). Warn the user via a toast rather
      // than silently leaving them staring at a highlight box they can't actually see.
      var panelEl = shadow && shadow.querySelector('.panel');
      if (panelEl) {
        var panelRect = panelEl.getBoundingClientRect();
        if (rectsOverlap(panelRect, r)) {
          showToast(tr('The panel is covering this element — drag the panel (by its header) to another part of the screen to see it.'));
        }
      }
    }, 350);
  }

  // Picks the "↔" note text for a crossRelevant finding/success depending on the context
  // (tab/group) it's currently being shown in. contextGroup is 'seo' | 'aeo' | 'all' | 'shared'
  // ('all'/'shared' for the Success tab — 'all' when "All" is selected and 'shared' when the
  // dedicated "SEO + AEO" filter is selected; in both cases there's no "guest" context, the
  // native note is always shown, same as before). Both texts (crossNote and crossNoteReverse)
  // ALWAYS start with "Relevant to both SEO and AEO" (agreed 10.08.2026 — explicitly state both,
  // rather than implicitly assuming the tab being viewed is already "the other side") — the
  // difference is only in the SPECIFIC explanation after the dash: crossNote explains from the
  // SEO angle (shown when the item is in its native SEO group, or in the dedicated "SEO + AEO"
  // view), crossNoteReverse from the AEO angle (shown as a "guest" in the AEO tab/filter).
  function getCrossText(item, contextGroup) {
    if (!item.crossRelevant) return '';
    if (contextGroup === 'shared') return item.crossNote || item.crossNoteReverse || 'Relevant to both SEO and AEO.';
    var native = item.group === 'aeo' ? 'aeo' : 'seo';
    if (contextGroup && contextGroup !== 'all' && contextGroup !== native) {
      return item.crossNoteReverse || item.crossNote || 'Relevant to both SEO and AEO.';
    }
    return item.crossNote || 'Relevant to both SEO and AEO.';
  }

  // Debounced "save this run" (28.10.2026): async results (link checks, header/sitemap fetches,
  // image HEADs) can arrive AFTER the old single save at +1200ms, which made the next run's
  // "since last run" delta show a small phantom change (e.g. ▼ 0.1%) on an unchanged page.
  // Saving again a little after the LAST render keeps the stored % equal to the final one.
  var runSaveTimer = null;
  function scheduleRunSave() {
    clearTimeout(runSaveTimer);
    runSaveTimer = setTimeout(function () { try { saveCurrentRun(); } catch (e) {} }, 2500);
  }

  // ---- Device tags + "closed UI" tag (30.10.2026) ----
  var SVG_ATTR = ' viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
  var DEVICE_ICONS = {
    mobile: '<svg' + SVG_ATTR + '><rect x="7" y="2" width="10" height="20" rx="2"/><line x1="11" y1="18" x2="13" y2="18"/></svg>',
    tablet: '<svg' + SVG_ATTR + '><rect x="4" y="2" width="16" height="20" rx="2"/><line x1="11" y1="18" x2="13" y2="18"/></svg>',
    desktop: '<svg' + SVG_ATTR + '><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>'
  };
  var EYE_OFF_ICON = '<svg' + SVG_ATTR + '><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
  var DEVICE_LABEL = { mobile: 'Mobile (narrower than 768px)', tablet: 'Tablet (768-991px)', desktop: 'Desktop (992px and wider)' };
  var UI_KIND_LABEL = { tab: 'tab', accordion: 'accordion / collapsible block', dropdown: 'dropdown', menu: 'collapsed menu', slider: 'slider', popup: 'popup / modal' };
  function attrEsc(x) { return String(x).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }
  // Devices where this finding appears, when that is NOT every device that was checked (else '').
  function findingDevices(f) {
    if (!f.devices || !f.devicesChecked || f.devices.length >= f.devicesChecked.length) return [];
    if (f.check === 'img.noSrcset' || /^Image has no responsive versions/.test(f.title || '')) return [];   // about phones by definition: a device tag would only confuse
    return DEVICES.map(function (d) { return d.id; }).filter(function (id) { return f.devices.indexOf(id) !== -1; });
  }
  function deviceTagsHtml(f) {
    var devs = findingDevices(f);
    if (!devs.length) return '';
    var names = devs.map(function (id) { return tr(DEVICE_LABEL[id]); }).join(', ');
    return '<span class="devtags" data-tip="' + attrEsc(trf('Found only on: {0}. It does not appear on the other devices that were checked.', [names])) + '">' +
      devs.map(function (id) { return DEVICE_ICONS[id]; }).join('') + '</span>';
  }
  // "Where is it": for an element that is not visible right now (closed tab / accordion / menu, hidden at this width), the row
  // cannot highlight anything on screen, so it shows the element's own opening tag, the chain of parents it sits in and
  // which ancestor hides it. Computed once per finding.
  function whereInfo(f) {
    if (f._where !== undefined) return f._where;
    var out = null;
    try {
      var el = f.element;
      if (el && el.nodeType === 1 && el !== document.body && el !== document.documentElement && !el.closest('head') && (f.hiddenUi || !isVisible(el))) {
        var open = (/^<[^>]*>/.exec(el.cloneNode(false).outerHTML) || [''])[0];
        if (open.length > 220) open = open.slice(0, 217) + '…>';
        var lab = function (n) { return elLabel(n) + (n.id ? '#' + n.id : ''); };
        var chain = [], par = el.parentElement, depth = 0;
        while (par && par !== document.body && par !== document.documentElement && depth < 4) { chain.unshift(lab(par)); par = par.parentElement; depth++; }
        if (par && par !== document.body && par !== document.documentElement) chain.unshift('…');
        var hid = null, q = el;
        while (q && q !== document.documentElement) { if (window.getComputedStyle(q).display === 'none') { hid = q; break; } q = q.parentElement; }
        var hiddenLabel = hid ? (hid === el ? '' : lab(hid) + ' (display:none)') : null;
        if (!hid) {
          var det = el.closest('details');
          var clip = (det && !det.open) ? null : zeroHeightClipper(el);
          if (det && !det.open) hiddenLabel = lab(det) + ' (closed)';
          else if (clip) hiddenLabel = lab(clip) + ' (height:0)';
        }
        // 12.11.2026: <script>/<style>/<link>... are never displayed, so "hidden by: the element itself" says nothing useful.
        if (/^(SCRIPT|STYLE|LINK|META|NOSCRIPT|TEMPLATE)$/.test(el.tagName)) { hiddenLabel = null; hid = null; }
        out = { open: open, chain: chain.join(' › '), hidden: hiddenLabel, self: !!hid && hid === el };
      }
    } catch (e) {}
    f._where = out;
    return out;
  }
  function whereText(f) {
    var w = whereInfo(f);
    if (!w) return '';
    var t = tr('Where:') + ' ' + w.open;
    if (w.chain) t += ' · ' + trf('inside: {0}', [w.chain]);
    if (w.self) t += ' · ' + trf('hidden by: {0}', [tr('the element itself (display:none)')]);
    else if (w.hidden) t += ' · ' + trf('hidden by: {0}', [w.hidden]);
    return t;
  }
  function uiTagHtml(f) {
    if (!f.hiddenUi) return '';
    return '<span class="devtags uitag" data-tip="' + attrEsc(trf('This element is inside a {0} that is closed when the page loads. The audit still checks it — click the row to locate it.', [tr(UI_KIND_LABEL[f.hiddenUi] || f.hiddenUi)])) + '">' + EYE_OFF_ICON + '</span>';
  }
  function deviceTagsText(f) {
    var devs = findingDevices(f), out = '';
    if (devs.length) out += ' [' + trf('only on: {0}', [devs.map(function (id) { return tr(DEVICES.filter(function (d) { return d.id === id; })[0].name).toLowerCase(); }).join(', ')]) + ']';
    if (f.hiddenUi) out += ' [' + trf('in closed UI: {0}', [tr(UI_KIND_LABEL[f.hiddenUi] || f.hiddenUi)]) + ']';
    return out;
  }
  // The small status line under the score bar (shown when the device pass is finished).
  function deviceScanHtml() {
    if (deviceScan.state !== 'done') return '';
    var parts = DEVICES.filter(function (d) { return deviceScan.checked.indexOf(d.id) !== -1; }).map(function (d) {
      var widths = [];
      if (d.id === deviceScan.current) widths.push(trf('this window, {0}px', [deviceScan.curWidth]));
      FRAMES.forEach(function (f) { if (f.device === d.id && deviceScan.frameOk.indexOf(f.key) !== -1) widths.push(f.w + 'px'); });
      return DEVICE_ICONS[d.id] + ' ' + tr(d.name) + (widths.length ? ' (' + widths.join(', ') + ')' : '');
    });
    var html = tr('Checked on:') + ' ' + parts.join(' · ');
    if (deviceScan.failed.length) {
      var why = { timeout: 'it took too long', blocked: 'the frame could not be read', empty: 'the frame stayed empty', frame: 'the page copy could not be created' };
      html += '<div class="devwarn">' + deviceScan.failed.map(function (x) {
        return trf('Could not check {0}: {1}.', [tr(x.name), tr(why[x.reason] || 'an error occurred')]);
      }).join(' ') + ' ' + tr('Results for the devices that could not be checked are missing.') + '</div>';
    }
    return html;
  }
  // "Analysis in progress" banner — shown from the first render until everything has really finished, so a
  // slow site shows a clear message instead of a panel that silently keeps changing.
  function loadingHtml() {
    if (!analysis.busy) return '';
    var step;
    if (analysis.step === 'perf') step = tr('Measuring performance (server response, LCP, layout shift)…');
    else if (analysis.step === 'devices') step = deviceScan.total ? trf('Checking the mobile, tablet and desktop layouts ({0} of {1} done)…', [deviceScan.done, deviceScan.total]) : tr('Checking the mobile, tablet and desktop layouts…');
    else if (analysis.step === 'network') step = tr('Finishing the network checks (images, links)…');
    else step = tr('Running the page checks…');
    return '<div class="ld-bar"><i></i></div><div class="ld-txt"><b>' + tr('Analysis in progress — please wait…') + '</b><span>' + step + '</span><span class="ld-note">' + tr('The score and the list below may still change until this is done.') + '</span></div>';
  }

  // While the analysis is still running, async results call renderPanel() many times (every image check, every
  // link). Re-building the panel that often makes it flicker, so during that phase renders are limited to one
  // per ~350 ms (the first one is immediate, the last one is never lost). Once the analysis is done, every
  // call renders at once, so clicks stay instant.
  var lastRenderAt = 0, renderTimer = null, pendingListScroll = 0, renderHeldBySelect = false;
  function renderPanel() {
    if (HEADLESS) return;   // frames used by the per-device pass have no panel
    if (!analysis.busy) { if (renderTimer) { clearTimeout(renderTimer); renderTimer = null; } return renderPanelNow(); }
    var wait = 350 - (Date.now() - lastRenderAt);
    if (wait <= 0) return renderPanelNow();
    if (!renderTimer) renderTimer = setTimeout(function () { renderTimer = null; renderPanelNow(); }, wait);
  }
  function renderPanelNow() {
    // 06.11.2026: while a dropdown in the panel has focus (it may be open), a re-render would replace it and close it.
    // The render waits until the dropdown loses focus; choosing an option blurs it first (see select.onchange).
    var ae = shadow && shadow.activeElement;
    if (ae && ae.tagName === 'SELECT') {
      renderHeldBySelect = true;
      if (!ae.__seoHoldHook) {
        ae.__seoHoldHook = true;
        ae.addEventListener('blur', function () { if (renderHeldBySelect) { renderHeldBySelect = false; renderPanelNow(); } });
      }
      return;
    }
    renderHeldBySelect = false;
    lastRenderAt = Date.now();
    scheduleRunSave();
    ensurePanel();
    var old = shadow.querySelector('.panel');
    var oldScroll = 0;
    try { var ol = old && old.querySelector('.list'); if (ol) oldScroll = ol.scrollTop; } catch (e) {}   // keep the reading position across re-renders
    if (old) old.remove();
    var opt = computeOptimization(); // computed first: it also tags every finding with its check id (used by the check filter)

    // crossRelevant findings/successes (native SEO, but with documented AEO impact) are now
    // shown in BOTH tabs — once with the note "↔ Also relevant to AEO" (in the SEO tab, their
    // native home) and once with the reverse note "↔ Also relevant to SEO" (in the AEO tab,
    // where they appear as a "guest"). See getCrossText() below for the logic that picks the
    // text per context.
    var seoFindings = findings.filter(function (f) { return f.group !== 'aeo'; });
    var aeoFindings = findings.filter(function (f) { return f.group === 'aeo' || f.crossRelevant; });
    if (activeCheckFilter) {
      // "Show only this check" (clicked in the checks list). Drop the filter if the check no longer has findings.
      seoFindings = seoFindings.filter(function (f) { return f.check === activeCheckFilter; });
      aeoFindings = aeoFindings.filter(function (f) { return f.check === activeCheckFilter; });
      if (!seoFindings.length && !aeoFindings.length) { activeCheckFilter = null; seoFindings = findings.filter(function (f) { return f.group !== 'aeo'; }); aeoFindings = findings.filter(function (f) { return f.group === 'aeo' || f.crossRelevant; }); }
    }
    if (activeTab !== 'seo' && activeTab !== 'aeo' && activeTab !== 'success') activeTab = 'seo';
    var current = activeTab === 'aeo' ? aeoFindings : (activeTab === 'success' ? successes : seoFindings);

    var counts = { error: 0, warning: 0, info: 0 };
    if (activeTab !== 'success') {
      current.forEach(function (f) { counts[f.severity] = (counts[f.severity] || 0) + 1; });
    }

    // Reset per-render keyboard-navigation state — rebuilt fresh below to mirror exactly what's
    // about to be shown (11.08.2026, see setupKeyboardHandlers()).
    selectedIndex = -1;
    var renderedRows = [];

    var panel = document.createElement('div');
    panel.className = 'panel';
    if (panelPosition) {
      panel.style.top = panelPosition.top + 'px';
      panel.style.left = panelPosition.left + 'px';
      panel.style.right = 'auto';
    }
    if (panelHeight) {
      panel.style.height = panelHeight + 'px';
    }

    function appendResizeHandle() {
    var resizeHandle = document.createElement('div');
    resizeHandle.className = 'resize-handle';
    // The visual "grip" pill is now drawn via CSS (.resize-handle::after), not text — part of
    // the redesign (10.08.2026), textContent deliberately left empty.
    resizeHandle.title = tr('Drag to resize panel height');
    resizeHandle.addEventListener('mousedown', function (e) {
      isResizing = true;
      var rect = panel.getBoundingClientRect();
      resizeStartY = e.clientY;
      resizeStartHeight = rect.height;
      document.body.style.userSelect = 'none';
      e.preventDefault();
      e.stopPropagation();
    });
    panel.appendChild(resizeHandle);
    }

    var hdr = document.createElement('div');
    hdr.className = 'hdr';
    hdr.innerHTML = '<div class="hdr-title">' + HEADER_ICON_SVG + '<b>SEO Page Auditor</b></div>';
    var hdrActions = document.createElement('div');
    hdrActions.style.cssText = 'display:flex;align-items:center;gap:2px;';
    // Toggle button (12.08.2026, per explicit request) — same on/off pattern as the "Highlight
    // all" badge (`.active` class + state flag flipped on click), instead of a one-way "open"
    // action. Clicking again while the preview is open closes it; the pressed/active look uses
    // the same amber accent as "Highlight all" so both toggles read consistently.
    var copyReportBtn = document.createElement('button');
    copyReportBtn.textContent = '📋';
    copyReportBtn.className = reportPreviewVisible ? 'active' : '';
    copyReportBtn.title = tr(reportPreviewVisible ? 'Hide the report preview' : 'Preview the full report (SEO + AEO findings) before copying it');
    copyReportBtn.onclick = function () {
      reportPreviewVisible = !reportPreviewVisible;
      if (reportPreviewVisible) reportPreviewText = buildReportText();
      renderPanel(); // full re-render so the button's active state AND the preview panel both update
    };
    var closeBtn = document.createElement('button');
    closeBtn.textContent = '✕';
    closeBtn.title = tr('Close');
    closeBtn.onclick = closePanel;
    // Language switch (EN / SR) — English is the original, Serbian is a display translation.
    var langSw = document.createElement('div');
    langSw.className = 'langsw';
    langSw.title = tr('Switch the panel and report language (EN / SR)');
    ['en', 'sr'].forEach(function (code) {
      var b = document.createElement('button');
      b.textContent = code.toUpperCase();
      b.className = LANG === code ? 'on' : '';
      b.onclick = function () { if (LANG !== code) setLang(code); };
      langSw.appendChild(b);
    });
    hdrActions.appendChild(langSw);
    hdrActions.appendChild(copyReportBtn);
    hdrActions.appendChild(closeBtn);
    hdr.appendChild(hdrActions);
    hdr.addEventListener('mousedown', function (e) {
      if (e.target === closeBtn || e.target === copyReportBtn || (e.target.closest && e.target.closest('.langsw'))) return; // don't start dragging when a header button is clicked
      isDragging = true;
      var rect = panel.getBoundingClientRect();
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      dragStartTop = rect.top;
      dragStartLeft = rect.left;
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });
    panel.appendChild(hdr);

    // "Page optimized" progress bar (28.10.2026) — see computeOptimization() for the logic. Always
    // visible (whole-page figure, independent of the active tab). The fill starts at the width it
    // had on the previous render and then animates to the new one, so it glides when async
    // results arrive but doesn't replay from zero on every tab switch.
    var prog = document.createElement('div');
    prog.className = 'prog';
    var optColor = optimizedColor(opt.pct);
    var deltaHtml = '';
    if (previousRun && typeof previousRun.optimizedPct === 'number') {
      var dPct = Math.round((opt.pct - previousRun.optimizedPct) * 10) / 10;
      deltaHtml = dPct === 0
        ? '<span>' + tr('no change since last run') + '</span>'
        : '<span style="color:' + (dPct > 0 ? '#4ade80' : '#f87171') + ';font-weight:700;">' + (dPct > 0 ? '▲ ' : '▼ ') + Math.abs(dPct).toFixed(1) + '%</span> ' + tr('since last run');
    }
    // "issues" = errors + warnings, "notes" = info items (split 28.10.2026: lumping hundreds of
    // info notes into one "issues" number made a decent page look far worse than it is).
    var leftHtml = LANG === 'sr'
      ? ((opt.failedChecks === 0
        ? '<b>Sve provere su prošle</b>'
        : '<b>' + opt.failedChecks + '</b> ' + srPlural(opt.failedChecks, 'provera zahteva', 'provere zahtevaju', 'provera zahteva') + ' pažnju') +
        (opt.issues > 0 ? ' · <b>' + opt.issues + '</b> ' + srPlural(opt.issues, 'problem', 'problema', 'problema') : '') +
        (opt.notes > 0 ? ' · <b>' + opt.notes + '</b> ' + srPlural(opt.notes, 'napomena', 'napomene', 'napomena') : ''))
      : ((opt.failedChecks === 0
        ? '<b>All checks passed</b>'
        : '<b>' + opt.failedChecks + '</b> check' + (opt.failedChecks === 1 ? '' : 's') + ' need attention') +
        (opt.issues > 0 ? ' · <b>' + opt.issues + '</b> issue' + (opt.issues === 1 ? '' : 's') : '') +
        (opt.notes > 0 ? ' · <b>' + opt.notes + '</b> note' + (opt.notes === 1 ? '' : 's') : ''));
    prog.innerHTML =
      '<div class="prog-top"><span class="prog-lbl" title="' + tr('Weighted share of checks that pass on this page. Errors weigh more than warnings, and warnings more than info items; when a check only affects some elements (e.g. a few images), you get partial credit. Not an official metric.') + '">' + tr('Page optimized') + '</span>' +
      '<span class="prog-pct" style="color:' + optColor + ';">' + fmtPct(opt.pct) + '</span></div>' +
      '<div class="prog-track" role="progressbar" aria-label="' + tr('Page optimized') + '" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + Math.round(opt.pct) + '"><div class="prog-fill" style="width:' + lastShownPct + '%;background:' + optimizedGradient(opt.pct) + ';"></div></div>' +
      '<div class="prog-sub"><div class="prog-stats">' + leftHtml.split(' · ').map(function (x, i) {
        // 1st = checks (clickable -> opens the list of those checks), 2nd = issues, 3rd = notes (tooltips explain the difference)
        var isChecks = i === 0 && opt.failedChecks > 0;
        var tip = i === 0 ? (opt.failedChecks > 0 ? tr('Checks that did not fully pass (a check can fail because of an info note too). Click to see which ones and how much each costs.') : '')
          : (x.indexOf('<b>' + opt.issues + '</b>') === 0 && opt.issues > 0 && i === 1
            ? tr('Issues = errors + warnings. Every individual error-level and warning-level finding on this page is counted (info notes are not). These are the ones to fix first.')
            : tr('Notes = info-level findings. Suggestions and things worth double-checking — they do not mean something is broken, but they still affect the score a little.'));
        return '<span class="st' + (isChecks ? ' st-link' : '') + '"' + (tip ? ' data-tip="' + tip.replace(/"/g, '&quot;') + '"' : '') + '>' + x + '</span>';
      }).join('') + '</div>' +
      (deltaHtml ? '<div class="prog-delta">' + deltaHtml + '</div>' : '') + '</div>';
    var checksLink = prog.querySelector('.st-link');
    if (checksLink) checksLink.onclick = function () { checksViewOpen = !checksViewOpen; renderPanel(); };
    var progFill = prog.querySelector('.prog-fill');
    var targetPct = opt.pct;
    lastShownPct = targetPct;
    (window.requestAnimationFrame || function (fn) { setTimeout(fn, 16); })(function () { progFill.style.width = targetPct + '%'; });
    if (analysis.busy) prog.classList.add('busy');
    var loadHtml = loadingHtml();
    if (loadHtml) {
      var loadBox = document.createElement('div');
      loadBox.className = 'loading';
      loadBox.setAttribute('role', 'status');
      loadBox.innerHTML = loadHtml;
      panel.appendChild(loadBox);
    }
    panel.appendChild(prog);

    var scanHtml = deviceScanHtml();
    if (scanHtml) {
      var scanBox = document.createElement('div');
      scanBox.className = 'devscan';
      scanBox.innerHTML = scanHtml;
      panel.appendChild(scanBox);
    }

    // "Previous run vs. now" banner (11.08.2026, localStorage-backed) — shown right below the
    // header regardless of the active tab, since it's a whole-page comparison. Only appears once
    // a previous run for this exact URL exists (see loadPreviousRun(), called once in run()).
    if (previousRun) {
      var totalNow = findings.length;
      var diff = totalNow - previousRun.totalFindings;
      var diffLabel = diff === 0 ? tr('no change') : (diff < 0 ? ('−' + Math.abs(diff)) : ('+' + diff));
      var diffColor = diff < 0 ? '#4ade80' : (diff > 0 ? '#f87171' : '#9ca3af');
      var when = new Date(previousRun.timestamp).toLocaleString();
      var prevBanner = document.createElement('div');
      prevBanner.className = 'prevrun';
      prevBanner.innerHTML = trf('Last run ({0}): {1} findings → now: {2}', [when, previousRun.totalFindings, totalNow]) +
        ' <span style="color:' + diffColor + ';font-weight:700;">(' + diffLabel + ')</span>';
      panel.appendChild(prevBanner);
    }

    // "Checks that need attention" view (29.10.2026): opened by clicking "N checks need attention".
    // Lists exactly the failed scored checks, biggest cost to the % first; clicking one returns to
    // the findings list filtered to that check.
    if (checksViewOpen) {
      clearAllHighlights();
      lastRenderedRows = [];
      var cvHdr = document.createElement('div');
      cvHdr.className = 'cv-hdr';
      var cvBack = document.createElement('button');
      cvBack.className = 'cv-back';
      cvBack.textContent = tr('← Back to findings');
      cvBack.onclick = function () { checksViewOpen = false; renderPanel(); };
      var cvTitle = document.createElement('div');
      cvTitle.className = 'cv-title';
      cvTitle.textContent = trf('Checks that need attention ({0})', [opt.failedList.length]);
      cvHdr.appendChild(cvBack);
      cvHdr.appendChild(cvTitle);
      panel.appendChild(cvHdr);
      var cvList = document.createElement('div');
      cvList.className = 'list';
      var cvNote = document.createElement('div');
      cvNote.className = 'cv-note';
      cvNote.textContent = tr('Click a check to see its findings. "Issues" and "notes" count individual findings (errors + warnings / info), so they differ from the number of checks. The % is how much of the "Page optimized" score each check costs.');
      cvList.appendChild(cvNote);
      opt.failedList.forEach(function (r) {
        var row = document.createElement('div');
        row.className = 'chk-row';
        row.title = trf('Show the {0} finding(s) of this check', [r.count]);
        row.innerHTML = '<span class="badge ' + r.severity + ' tag">' + tr(r.severity) + '</span>' +
          '<span class="chk-name">' + tr(r.label).replace(/</g, '&lt;') + '</span>' +
          '<span class="chk-meta">' + (r.count > 1 ? '×' + r.count + ' · ' : '') + '<b>' + (r.lostPct > 0 ? '−' + r.lostPct.toFixed(1) + '%' : '0%') + '</b></span>';
        row.onclick = function () {
          var inSeo = r.findings.some(function (f) { return f.group !== 'aeo'; });
          activeCheckFilter = r.id;
          activeTab = inSeo ? 'seo' : 'aeo';
          activeSeverity = 'all'; activeCategory = 'all'; activeCategoryOrigin = 'all';
          checksViewOpen = false;
          renderPanel();
        };
        cvList.appendChild(row);
      });
      panel.appendChild(cvList);
      appendResizeHandle();
      shadow.appendChild(panel);
      renderReportPreview();
      savePanelState();
      return;
    }

    var tabs = document.createElement('div');
    tabs.className = 'tabs';
    var seoTab = document.createElement('button');
    seoTab.className = 'tabbtn' + (activeTab === 'seo' ? ' active' : '');
    seoTab.textContent = 'SEO (' + seoFindings.length + ')';
    seoTab.onclick = function () { activeTab = 'seo'; renderPanel(); };
    var aeoTab = document.createElement('button');
    aeoTab.className = 'tabbtn' + (activeTab === 'aeo' ? ' active' : '');
    aeoTab.textContent = 'AEO (' + aeoFindings.length + ')';
    aeoTab.onclick = function () { activeTab = 'aeo'; renderPanel(); };
    var successTab = document.createElement('button');
    successTab.className = 'tabbtn success-tab' + (activeTab === 'success' ? ' active' : '');
    successTab.style.color = activeTab === 'success' ? '#4ade80' : '#166534';
    successTab.textContent = '✓ ' + tr('Success') + ' (' + successes.length + ')';
    successTab.onclick = function () { activeTab = 'success'; renderPanel(); };
    tabs.appendChild(seoTab);
    tabs.appendChild(aeoTab);
    tabs.appendChild(successTab);
    panel.appendChild(tabs);

    if (activeSeverity !== 'all' && activeSeverity !== 'error' && activeSeverity !== 'warning' && activeSeverity !== 'info') activeSeverity = 'all';

    var order = { error: 0, warning: 1, info: 2 };
    var sorted;

    if (activeTab === 'success') {
      // "Highlight all" only applies to findings (problems), not successes — nothing to
      // highlight as "wrong" here, and there's no toggle button in this tab. Clear any leftover
      // boxes from a previous SEO/AEO view so they don't linger while looking at successes.
      clearAllHighlights();
      // The Success tab has no severity filter (success has no severity level), BUT it has its
      // own filter by SEO/AEO group. The split is based on the `crossRelevant` flag (the same
      // criterion as the category dropdown in the SEO/AEO tabs — see the 10.08.2026 SPEC entry)
      // — NOT by "native group", since that would mix shared items (canonical, noindex, CWV,
      // mixed content...) with purely domain-specific ones: "SEO" = exclusively SEO items
      // (without crossRelevant), "AEO" = exclusively AEO items (without crossRelevant),
      // "SEO + AEO" = shared items (crossRelevant:true, regardless of native group — currently
      // all of them are native SEO, but the criterion is generic).
      var soloSeoSuccesses = successes.filter(function (s) { return s.group !== 'aeo' && !s.crossRelevant; });
      var soloAeoSuccesses = successes.filter(function (s) { return s.group === 'aeo' && !s.crossRelevant; });
      var sharedSuccesses = successes.filter(function (s) { return !!s.crossRelevant; });
      if (['all', 'seo', 'aeo', 'shared'].indexOf(activeSuccessGroup) === -1) activeSuccessGroup = 'all';

      var summary = document.createElement('div');
      summary.className = 'summary';
      function makeSuccessGroupBadge(grp, label, count) {
        var span = document.createElement('span');
        span.className = 'badge group-' + grp + (activeSuccessGroup === grp ? ' active' : '');
        span.textContent = label + ' (' + count + ')';
        span.onclick = function () { activeSuccessGroup = grp; renderPanel(); };
        return span;
      }
      summary.appendChild(makeSuccessGroupBadge('all', tr('All'), successes.length));
      summary.appendChild(makeSuccessGroupBadge('seo', 'SEO', soloSeoSuccesses.length));
      summary.appendChild(makeSuccessGroupBadge('aeo', 'AEO', soloAeoSuccesses.length));
      summary.appendChild(makeSuccessGroupBadge('shared', 'SEO + AEO', sharedSuccesses.length));
      panel.appendChild(summary);

      sorted = activeSuccessGroup === 'all' ? successes
        : activeSuccessGroup === 'seo' ? soloSeoSuccesses
        : activeSuccessGroup === 'aeo' ? soloAeoSuccesses
        : sharedSuccesses;
    } else {
      var summary = document.createElement('div');
      summary.className = 'summary';
      function makeSeverityBadge(sev, label, count) {
        var span = document.createElement('span');
        span.className = 'badge ' + sev + (activeSeverity === sev ? ' active' : '');
        span.textContent = label + ' (' + count + ')';
        span.onclick = function () { activeSeverity = sev; renderPanel(); };
        return span;
      }
      summary.appendChild(makeSeverityBadge('all', tr('All'), current.length));
      summary.appendChild(makeSeverityBadge('error', tr('error'), counts.error));
      summary.appendChild(makeSeverityBadge('warning', tr('warning'), counts.warning));
      summary.appendChild(makeSeverityBadge('info', tr('info'), counts.info));
      panel.appendChild(summary);

      var filtered = current.filter(function (f) { return activeSeverity === 'all' || f.severity === activeSeverity; });

      // Dropdown for additional filtering BY CATEGORY (Images, Links, Meta & head tags...)
      // WITHIN the already-selected severity filter — e.g. "warning" + "Images" shows only
      // warning findings about images. The list of categories in the dropdown is computed from
      // `filtered` (after the severity filter), so it changes depending on which severity is
      // currently selected.
      //
      // Some categories contain a MIX: items that are relevant ONLY to the current tab
      // (`crossRelevant` not set) and items that are relevant to both SEO and AEO
      // (`crossRelevant: true` — the same ones that carry the "↔" note). E.g. "Meta & head
      // tags" in the SEO tab has both pure-SEO items (title length, OG tags, Twitter Card...)
      // and shared items (canonical, noindex, nosnippet). For such mixed categories, the
      // dropdown gets an <optgroup> with 3 sub-options: "All", "AEO + SEO items" (shared) and
      // "SEO/AEO only items" (this tab only) — the split criterion is the `crossRelevant` flag,
      // NOT "native tab vs guest tab" (that split would rarely be mixed, since guest categories
      // almost never share a name with native AEO categories by name anyway, which are always
      // prefixed with "AEO - "). For categories that are NOT mixed (all items are either all
      // shared or all exclusive to this tab), a single flat option remains, as before.
      var categoryCounts = {};
      var categorySharedCounts = {};
      filtered.forEach(function (f) {
        categoryCounts[f.category] = (categoryCounts[f.category] || 0) + 1;
        if (f.crossRelevant) categorySharedCounts[f.category] = (categorySharedCounts[f.category] || 0) + 1;
      });
      var categoryNames = Object.keys(categoryCounts).sort();
      if (activeCategory !== 'all' && categoryNames.indexOf(activeCategory) === -1) { activeCategory = 'all'; activeCategoryOrigin = 'all'; }
      if (activeCategory === 'all') {
        activeCategoryOrigin = 'all';
      } else if (activeCategoryOrigin !== 'all') {
        // The "shared"/"solo" sub-filter only makes sense if the category has at least one
        // shared (crossRelevant) item at all — if the severity filter changed such that there
        // are none left, revert to "All" (consistent with the condition for the <optgroup> below).
        var sharedC = categorySharedCounts[activeCategory] || 0;
        if (!(sharedC > 0)) activeCategoryOrigin = 'all';
      }

      if (categoryNames.length > 0) {
        var catRow = document.createElement('div');
        catRow.className = 'catrow';
        var select = document.createElement('select');
        select.className = 'cat-select';
        var allOpt = document.createElement('option');
        allOpt.value = 'all::all';
        allOpt.textContent = trf('All categories ({0})', [filtered.length]);
        select.appendChild(allOpt);
        var soloLabel = activeTab === 'aeo' ? 'AEO' : 'SEO';
        categoryNames.forEach(function (cat) {
          var total = categoryCounts[cat];
          var sharedCount = categorySharedCounts[cat] || 0;
          var soloCount = total - sharedCount;
          if (sharedCount > 0) {
            // The category contains at least one shared (crossRelevant) item — an <optgroup>
            // with 3 sub-options, CONSISTENTLY even when the category is 100% shared
            // (soloCount === 0, e.g. "Technical / crawlability" in the AEO tab) — in that case
            // the "SEO/AEO only items" sub-option simply shows (0), rather than treating the
            // category differently depending on the tab (agreed 10.08.2026, see SPEC).
            var group = document.createElement('optgroup');
            group.label = tr(cat);
            var optAll = document.createElement('option');
            optAll.value = cat + '::all';
            optAll.textContent = trf('All ({0})', [total]);
            group.appendChild(optAll);
            var optShared = document.createElement('option');
            optShared.value = cat + '::shared';
            optShared.textContent = trf('AEO + SEO items ({0})', [sharedCount]);
            group.appendChild(optShared);
            var optSolo = document.createElement('option');
            optSolo.value = cat + '::solo';
            optSolo.textContent = trf('{0} only items ({1})', [soloLabel, soloCount]);
            group.appendChild(optSolo);
            select.appendChild(group);
          } else {
            var opt = document.createElement('option');
            opt.value = cat + '::all';
            opt.textContent = tr(cat) + ' (' + total + ')';
            select.appendChild(opt);
          }
        });
        select.value = activeCategory + '::' + activeCategoryOrigin;
        select.onchange = function () {
          var parts = select.value.split('::');
          activeCategory = parts[0];
          activeCategoryOrigin = parts[1] || 'all';
          renderHeldBySelect = false;
          try { select.blur(); } catch (e) {}
          renderPanel();
        };
        catRow.appendChild(select);
        panel.appendChild(catRow);
      }

      filtered = filtered.filter(function (f) {
        if (activeCategory === 'all') return true;
        if (f.category !== activeCategory) return false;
        if (activeCategoryOrigin === 'all') return true;
        return activeCategoryOrigin === 'shared' ? !!f.crossRelevant : !f.crossRelevant;
      });
      sorted = filtered.slice().sort(function (a, b) { return order[a.severity] - order[b.severity]; });

      // "Highlight all at once" toggle (11.08.2026) — draws boxes for every currently-listed
      // finding with a bound element, all at once. Added to the summary row AFTER `sorted` is
      // final so its count matches exactly what's about to be shown (respects severity + category
      // filters, same as the list below). Only rendered when there's at least one highlightable
      // (has `.element`) finding, since an empty/uselessly-disabled toggle is worse than no toggle.
      var highlightableCount = sorted.filter(function (f) { return !!f.element; }).length;
      if (highlightableCount > 0) {
        var haBtn = document.createElement('span');
        haBtn.className = 'badge highlightall' + (highlightAllActive ? ' active' : '');
        haBtn.textContent = (highlightAllActive ? '◼' : '◻') + ' ' + trf('Highlight all ({0})', [highlightableCount]);
        haBtn.title = tr('Draw a box around every listed finding at once, instead of one at a time.');
        haBtn.onclick = function () { highlightAllActive = !highlightAllActive; renderPanel(); };
        summary.appendChild(haBtn);
      }
      if (highlightAllActive) {
        showAllHighlights(sorted);
      } else {
        clearAllHighlights();
      }
    }

    // .list is the only scrolling part — prevents the hdr/tabs/summary from "jumping" and
    // replaces the earlier approach with position:sticky offsets that had to be guessed manually.
    if (activeCheckFilter && activeTab !== 'success') {
      var fChip = document.createElement('div');
      fChip.className = 'filterchip';
      var fLabel = document.createElement('span');
      fLabel.innerHTML = tr('Showing only the check:') + ' <b>' + tr(CHECK_LABELS[activeCheckFilter] || activeCheckFilter).replace(/</g, '&lt;') + '</b>';
      var fClear = document.createElement('button');
      fClear.textContent = tr('Clear filter') + ' ✕';
      fClear.onclick = function () { activeCheckFilter = null; renderPanel(); };
      fChip.appendChild(fLabel);
      fChip.appendChild(fClear);
      panel.appendChild(fChip);
    }

    var list = document.createElement('div');
    list.className = 'list';

    if (!sorted.length) {
      var empty = document.createElement('div');
      empty.className = 'empty';
      if (activeTab === 'success') {
        empty.textContent = successes.length
          ? trf('No successful checks for the selected group ("{0}") in this tab.', [activeSuccessGroup])
          : tr('No successful checks recorded yet (or the page is still being analyzed).');
      } else if (!current.length) {
        empty.textContent = tr(activeTab === 'aeo' ? 'No AEO findings on this page. 🎉' : 'No SEO findings on this page. 🎉');
      } else if (activeCategory !== 'all') {
        empty.textContent = trf('No findings for filter severity="{0}" + category="{1}".', [activeSeverity, tr(activeCategory)]);
      } else {
        empty.textContent = trf('No findings for the selected filter ("{0}") in this tab.', [activeSeverity]);
      }
      list.appendChild(empty);
    }

    if (activeTab === 'success') {
      sorted.forEach(function (s) {
        // The badge follows the CURRENTLY selected filter (SEO/AEO/SEO+AEO), while in the "All"
        // view it follows the item's NATIVE group — see getCrossText() for the "↔" note logic.
        var native = s.group === 'aeo' ? 'aeo' : 'seo';
        var grp = activeSuccessGroup !== 'all' ? activeSuccessGroup : native;
        var grpLabel = grp === 'shared' ? 'SEO+AEO' : grp.toUpperCase();
        var item = document.createElement('div');
        item.className = 'item success-item';
        item.innerHTML =
          '<div class="cat">' + tr(s.category) + '</div>' +
          '<div class="title"><span class="badge success tag">✓</span><span class="badge group-' + grp + ' tag">' + grpLabel + '</span>' + tr(s.title) + '</div>' +
          (s.description ? '<div class="desc">' + tr(s.description || '').replace(/</g, '&lt;') + '</div>' : '') +
          (s.crossRelevant ? '<div class="cross">↔ ' + tr(getCrossText(s, activeSuccessGroup)) + '</div>' : '');
        if (s.element) {
          item.style.cursor = 'pointer';
          item.onclick = function () { highlightElement(s.element); };
        }
        list.appendChild(item);
        renderedRows.push({ item: s, el: item });
      });
    } else {
      sorted.forEach(function (f) {
        var item = document.createElement('div');
        item.className = 'item';
        item.innerHTML =
          '<div class="cat">' + tr(f.category) + '</div>' +
          '<div class="title"><span class="badge ' + f.severity + ' tag">' + tr(f.severity) + '</span>' + deviceTagsHtml(f) + uiTagHtml(f) + (f.crossRelevant ? '<span class="badge group-shared tag" title="' + tr('Shown in both the SEO and AEO tabs (counted once in the totals)') + '">SEO+AEO</span>' : '') + tr(f.title) + '</div>' +
          '<div class="desc">' + tr(f.description || '').replace(/</g, '&lt;') + '</div>' +
          (whereInfo(f) ? '<div class="desc where">' + whereText(f).replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</div>' : '') +
          (f.suggestedCode ? '<button class="copybtn copy-code-btn" title="' + tr('Copy the suggested code to clipboard') + '" style="margin:6px 0 0;">' + tr('📋 Copy suggested code') + '</button>' : '') +
          (f.globalNote ? '<div class="global">🌐 ' + tr(f.globalNote) + '</div>' : '') +
          (f.ownerNote ? '<div class="owner">🔑 <b>' + tr('Who can fix:') + '</b> ' + tr(f.ownerNote) + '</div>' : '') +
          (f.crossRelevant ? '<div class="cross">↔ ' + tr(getCrossText(f, activeTab)) + '</div>' : '') +
          (f.why ? '<div class="desc" style="color:#93c5fd;margin-top:4px;"><b>' + tr('Why:') + '</b> ' + tr(f.why) + '</div>' : '') +
          (f.fix ? '<div class="desc fixrow" style="color:#86efac;margin-top:4px;"><b>' + tr('Fix:') + '</b> ' + tr(f.fix) + ' <button class="copybtn copy-fix-btn" title="' + tr('Copy this fix suggestion to clipboard') + '">' + tr('Copy') + '</button></div>' : '');
        item.onclick = function () { highlightElement(f.element); };
        if (f.fix) {
          var fixBtn = item.querySelector('.copy-fix-btn');
          if (fixBtn) {
            fixBtn.onclick = function (e) {
              e.stopPropagation(); // don't also trigger the item's own highlight click
              copyToClipboard(tr(f.fix), tr('Fix copied to clipboard.'));
            };
          }
        }
        if (f.suggestedCode) {
          var codeBtn = item.querySelector('.copy-code-btn');
          if (codeBtn) {
            codeBtn.onclick = function (e) {
              e.stopPropagation();
              copyToClipboard(f.suggestedCode, tr('Suggested code copied to clipboard.'));
            };
          }
        }
        list.appendChild(item);
        renderedRows.push({ item: f, el: item });
      });
    }

    lastRenderedRows = renderedRows;

    panel.appendChild(list);
    pendingListScroll = oldScroll;

    appendResizeHandle();

    shadow.appendChild(panel);
    if (pendingListScroll > 0) { try { list.scrollTop = pendingListScroll; } catch (e) {} }   // after it is attached (layout needed)
    renderReportPreview(); // re-append if it was open — persists across tab/filter re-renders
    savePanelState(); // persist tab/severity/category/successGroup — see loadPanelState() comment
  }

  // ---------------------------------------------------------------------
  // Per-device pass (30.10.2026): mobile / tablet / desktop
  // ---------------------------------------------------------------------
  // A bookmarklet only sees the page at the CURRENT window width, but Webflow sites change a lot per
  // breakpoint (elements hidden on desktop, other images served to phones, a different menu...). So,
  // besides this window, the same page is opened in hidden same-origin frames at a typical width of
  // each device class and the viewport-dependent checks (headings, images, video, forms, links,
  // content) are run there headlessly. The results are merged: a finding that appears on every
  // checked device is shown as before; one that appears only on some devices gets a device tag
  // (phone / tablet / monitor icon, explained on hover). Findings that exist ONLY on another device
  // (e.g. a mobile-only menu link) are added to the list and the score — the score reflects reality.
  // Widths follow Webflow's breakpoints: desktop >= 992, tablet 768-991, mobile < 768.
  var DEVICES = [
    { id: 'mobile', name: 'Mobile', range: 'narrower than 768px' },
    { id: 'tablet', name: 'Tablet', range: '768-991px' },
    { id: 'desktop', name: 'Desktop', range: '992px and wider' }
  ];
  // One frame per Webflow breakpoint (mobile has two: portrait <= 478px and landscape 479-767px).
  var FRAMES = [
    { key: 'mobile-p', device: 'mobile', name: 'Mobile', w: 375, h: 812, min: 0, max: 478 },
    { key: 'mobile-l', device: 'mobile', name: 'Mobile landscape', w: 600, h: 400, min: 479, max: 767 },
    { key: 'tablet', device: 'tablet', name: 'Tablet', w: 768, h: 1024, min: 768, max: 991 },
    { key: 'desktop', device: 'desktop', name: 'Desktop', w: 1440, h: 900, min: 992, max: 99999 }
  ];
  function deviceOfWidth(w) { return w >= 992 ? 'desktop' : (w >= 768 ? 'tablet' : 'mobile'); }
  // state: idle | running | done. done = frames finished, total = frames to run.
  var deviceScan = { state: 'idle', current: null, curWidth: 0, checked: [], failed: [], frameOk: [], done: 0, total: 0 };
  // The "analysis in progress" banner: busy from the first render until the page checks, the performance
  // measurement, the device frames and the audit's own network requests are all finished.
  var analysis = { busy: !HEADLESS, step: 'page' };

  // --- Element identity that survives across frames (content first, DOM path as the fallback) ---
  var PATH_SKIP_TAGS = /^(SCRIPT|STYLE|NOSCRIPT|LINK|TEMPLATE|IFRAME)$/i;   // injected by trackers/widgets, differ between loads
  function pathChildren(par) { return Array.prototype.filter.call(par.children, function (c) { return !PATH_SKIP_TAGS.test(c.tagName); }); }
  function elPath(el) {
    try {
      if (!el || el.nodeType !== 1) return '';
      if (el === document.body) return 'body';
      var parts = [], n = el;
      while (n && n !== document.documentElement) {
        if (n.id && document.getElementById(n.id) === n) { parts.unshift('#' + encodeURIComponent(n.id)); break; }
        var par = n.parentElement;
        if (!par) break;
        parts.unshift(String(pathChildren(par).indexOf(n)));
        n = par;
      }
      return parts.join('/');
    } catch (e) { return ''; }
  }
  function elByPath(path) {
    try {
      if (!path) return null;
      if (path === 'body') return document.body;
      var cur = document.documentElement, parts = path.split('/');
      for (var i = 0; i < parts.length; i++) {
        if (parts[i].charAt(0) === '#') { cur = document.getElementById(decodeURIComponent(parts[i].slice(1))); }
        else { cur = pathChildren(cur)[parseInt(parts[i], 10)]; }
        if (!cur) return null;
      }
      return cur;
    } catch (e) { return null; }
  }
  function stripQuery(u) { return String(u || '').replace(/[?#].*$/, ''); }
  function elKeyPart(el) {
    var tag = el.tagName;
    if (tag === 'IMG') return 'img:' + stripQuery(el.getAttribute('src') || el.currentSrc);
    if (tag === 'A') return 'a:' + (el.getAttribute('href') || '') + '|' + text(el).slice(0, 40) + '|' + (el.getAttribute('aria-label') || '');
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return 'f:' + tag + (el.getAttribute('type') || '') + '|' + (el.getAttribute('name') || '') + '|' + (el.id || '') + '|' + (el.getAttribute('placeholder') || '');
    if (/^H[1-6]$/.test(tag)) return 'h:' + tag + '|' + text(el).slice(0, 50);
    if (tag === 'VIDEO') return 'v:' + stripQuery(el.getAttribute('src') || el.currentSrc || (el.querySelector('source') || {}).src);
    return 'p:' + elPath(el);
  }
  // Key of a finding = group + check + what it is about; identical keys in one run get an occurrence number.
  function findingKeys(list) {
    var seen = {};
    return list.map(function (f) {
      var id = matchCheckId(f.title || '') || ((f.category || '') + '|' + String(f.title || '').replace(/[\d.,]+/g, '#'));
      var part = (f.element && f.element.nodeType === 1) ? elKeyPart(f.element) : 't:' + String(f.title || '').replace(/[\d.,]+/g, '#');
      var base = (f.group || 'seo') + '|' + id + '|' + part;
      seen[base] = (seen[base] || 0) + 1;
      return base + '#' + seen[base];
    });
  }
  // Locate (in THIS document) the element a frame's finding was about.
  function locateByInfo(info) {
    try {
      if (!info) return null;
      // Same DOM path and the same thing there (tag + src / href) -> that is the element.
      var byPath = elByPath(info.path);
      if (byPath && byPath.tagName === info.tag) {
        if (info.tag === 'IMG' && stripQuery(byPath.getAttribute('src') || byPath.currentSrc) === info.src) return byPath;
        if (info.tag === 'A' && (byPath.getAttribute('href') || '') === info.href) return byPath;
        if (info.tag !== 'IMG' && info.tag !== 'A') return byPath;
      }
      // Otherwise by content, taking the n-th identical one.
      var list = [];
      if (info.tag === 'IMG' && info.src) list = Array.prototype.filter.call(document.images, function (i) { return stripQuery(i.getAttribute('src') || i.currentSrc) === info.src; });
      else if (info.tag === 'A' && info.href !== undefined) list = Array.prototype.filter.call(document.querySelectorAll('a'), function (a) { return (a.getAttribute('href') || '') === info.href && text(a).slice(0, 40) === info.txt; });
      if (list.length) return list[Math.min(Math.max(info.nth || 0, 0), list.length - 1)];
    } catch (e) {}
    return null;
  }
  var EXPORT_FIELDS = ['category', 'group', 'severity', 'title', 'description', 'why', 'fix', 'crossRelevant', 'crossNote', 'crossNoteReverse', 'noScore', 'hiddenUi', 'ownerNote', 'globalNote', 'suggestedCode'];

  // Runs inside a frame: what the parent needs, as plain JSON (no DOM objects).
  function exportHeadless() {
    var keys = findingKeys(findings);
    var items = findings.map(function (f, i) {
      var o = {};
      EXPORT_FIELDS.forEach(function (k) { if (f[k] !== undefined) o[k] = f[k]; });
      var el = f.element, info = null;
      if (el && el.nodeType === 1) {
        info = { tag: el.tagName, path: elPath(el) };
        if (el.tagName === 'IMG') {
          info.src = stripQuery(el.getAttribute('src') || el.currentSrc);
          info.nth = Array.prototype.filter.call(document.images, function (i) { return stripQuery(i.getAttribute('src') || i.currentSrc) === info.src; }).indexOf(el);
        }
        if (el.tagName === 'A') {
          info.href = el.getAttribute('href') || ''; info.txt = text(el).slice(0, 40);
          info.nth = Array.prototype.filter.call(document.querySelectorAll('a'), function (a) { return (a.getAttribute('href') || '') === info.href && text(a).slice(0, 40) === info.txt; }).indexOf(el);
        }
      }
      return { key: keys[i], f: o, info: info };
    });
    var units = null, vtext = '';
    try { units = collectParityUnits(); } catch (e) {}
    try { vtext = parityVisibleText(); } catch (e) {}
    var hidden = hiddenContentBlocks.map(function (h) { return { txt: h.txt, key: h.key }; });
    return JSON.stringify({ items: items, totals: checkTotals, width: window.innerWidth, units: units, vtext: vtext, hidden: hidden });
  }

  // Runs one check; an exception is logged (window.__SeoAuditorErrors) instead of stopping the whole audit.
  function runCheckSafely(fn) {
    try { fn(); } catch (e) {
      (window.__SeoAuditorErrors = window.__SeoAuditorErrors || []).push((fn.name || 'check') + ': ' + (e && e.message));
      try { console.warn('[SEO Page Auditor] ' + (fn.name || 'check') + ' failed:', e); } catch (x) {}
    }
  }

  function runHeadless() {
    // Only the checks whose outcome depends on the viewport. Site-level checks (meta, sitemap, robots,
    // fonts, CWV, schema) are identical on every device and already covered by the main run.
    [checkHeadings, checkImages, checkVideos, checkForms, checkLinks, checkContent, checkTapTargets].forEach(runCheckSafely);
    window.__SeoAuditorHeadlessExport = exportHeadless;
    window.__SeoAuditorHeadlessDone = true;
  }

  // --- Parent side: a hidden frame per breakpoint, built from a COPY of the page's live DOM ---
  // The frame is NOT a reload of the page: the page's own scripts are switched off in the copy, so nothing
  // runs twice (no analytics hits, no popups, no tracking pixels, no timers), it is fast, and the only
  // difference between the frames is the viewport width the CSS media queries react to.
  function buildFrameHtml() {
    // Copy into an INERT document (no browsing context): cloning inside the live document would start loading the
    // copied <img> elements and run their inline onload handlers in the real page.
    var inert = document.implementation.createHTMLDocument('');
    var root = inert.importNode(document.documentElement, true);
    var host = root.querySelector('#seo-audit-host');
    if (host && host.parentNode) host.parentNode.removeChild(host);
    Array.prototype.forEach.call(root.querySelectorAll('script'), function (sc) {
      var t = (sc.getAttribute('type') || '').toLowerCase();
      if (t === 'application/ld+json') return;
      sc.setAttribute('type', 'text/plain'); sc.removeAttribute('src');      // inert: a non-JS type is never executed or fetched
      sc.textContent = '';                                                   // and its code is dropped (a literal </script> inside it would end the element early and leak the rest into the page)
    });
    Array.prototype.forEach.call(root.querySelectorAll('*'), function (el) {
      Array.prototype.slice.call(el.attributes).forEach(function (at) { if (/^on/i.test(at.name)) el.removeAttribute(at.name); });   // inline handlers (onload=...) would run
    });
    Array.prototype.forEach.call(root.querySelectorAll('meta[http-equiv]'), function (m) { if (/refresh/i.test(m.getAttribute('http-equiv'))) m.parentNode.removeChild(m); });
    Array.prototype.forEach.call(root.querySelectorAll('link[rel~="preload"],link[rel~="prefetch"],link[rel~="modulepreload"],link[rel~="preconnect"],link[rel~="dns-prefetch"],base'), function (l) { l.parentNode.removeChild(l); });
    Array.prototype.forEach.call(root.querySelectorAll('iframe,embed,object'), function (f) { f.removeAttribute('src'); f.removeAttribute('srcdoc'); f.removeAttribute('data'); });   // embeds (YouTube, maps...) are not loaded again
    Array.prototype.forEach.call(root.querySelectorAll('video,audio'), function (m) { m.setAttribute('preload', 'none'); m.removeAttribute('autoplay'); });
    var head = root.querySelector('head');
    if (head) { var base = inert.createElement('base'); base.setAttribute('href', document.baseURI); head.insertBefore(base, head.firstChild); }
    var dt = '<!DOCTYPE html>';
    try { if (document.doctype) dt = new XMLSerializer().serializeToString(document.doctype); } catch (e) {}
    return dt + root.outerHTML;
  }

  function scanFrame(def, html, cb) {
    var fr = document.createElement('iframe'), finished = false, timer;
    function finish(res) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try { fr.parentNode && fr.parentNode.removeChild(fr); } catch (e) {}
      cb(res);
    }
    function fail(reason) { finish({ ok: false, reason: reason }); }
    timer = setTimeout(function () { fail('timeout'); }, 45000);
    // allow-scripts only so that THIS script can run in the frame; the page's own scripts were made inert above.
    // No allow-top-navigation / allow-popups / allow-modals / allow-forms.
    fr.setAttribute('sandbox', 'allow-same-origin allow-scripts');
    fr.setAttribute('aria-hidden', 'true');
    fr.setAttribute('tabindex', '-1');
    fr.setAttribute('title', 'SEO Page Auditor — ' + def.name + ' check');
    fr.style.cssText = 'position:fixed;left:-99999px;top:0;width:' + def.w + 'px;height:' + def.h + 'px;border:0;pointer-events:none;opacity:0;';
    fr.onload = function () {
      setTimeout(function () {
        try {
          var fw = fr.contentWindow, fd = fw.document;
          if (!fd || !fd.body || !fd.documentElement) return fail('empty');
          fw.__SeoAuditorHeadless = true;
          try {
            var lcpE = lastLcpEntry(), lcpI = lcpE && lcpE.element;
            if (lcpI && lcpI.tagName === 'IMG') fw.__SeoAuditorLcpSrc = stripQuery(lcpI.currentSrc || lcpI.src);
          } catch (e) {}
          fw.__SeoAuditorLoc = { href: LOC.href, hostname: LOC.hostname, origin: LOC.origin, pathname: LOC.pathname, protocol: LOC.protocol };
          // Lazy images below the fold are not fetched in a hidden frame; load them so their real size is known.
          var lazy = Array.prototype.filter.call(fd.querySelectorAll('img[loading="lazy"]'), function (im) { return !im.complete; });
          lazy.forEach(function (im) { im.setAttribute('loading', 'eager'); });
          var t0 = Date.now();
          (function waitLazy() {
            var open = lazy.filter(function (im) { return !im.complete; }).length;
            if (open && Date.now() - t0 < 5000) return setTimeout(waitLazy, 150);
            lazy.forEach(function (im) { im.setAttribute('loading', 'lazy'); });   // restore, so the lazy-loading checks see the real attribute
            try { fw.eval('(' + SELF_SRC + ')()'); } catch (e) { return fail('eval'); }
            var t1 = Date.now(), calm = 0;
            (function waitDone() {
              try {
                var pend = fw.__SeoAuditorHeadlessPending ? fw.__SeoAuditorHeadlessPending() : 0;
                if (fw.__SeoAuditorHeadlessDone && pend === 0) calm++; else calm = 0;
                if (calm >= 3 || Date.now() - t1 > 12000) {
                  return finish({ ok: true, data: JSON.parse(fw.__SeoAuditorHeadlessExport()) });
                }
              } catch (e) { return fail('read'); }
              setTimeout(waitDone, 150);
            })();
          })();
        } catch (e) { fail('blocked'); }
      }, 400);
    };
    try { fr.srcdoc = html; document.documentElement.appendChild(fr); } catch (e) { fail('frame'); }
  }

  function scanDevices(done) {
    if (HEADLESS || !SELF_SRC) { deviceScan.state = 'done'; return done(); }
    var curW = window.innerWidth, cur = deviceOfWidth(curW);
    // The frame whose breakpoint contains the current window width is skipped: this window already is that check.
    var todo = FRAMES.filter(function (f) { return !(curW >= f.min && curW <= f.max); });
    deviceScan = { state: 'running', current: cur, curWidth: curW, checked: [cur], failed: [], frameOk: [], done: 0, total: todo.length };
    renderPanel();
    var html = '';
    try { html = buildFrameHtml(); } catch (e) { html = ''; }
    if (!html) {
      todo.forEach(function (f) { deviceScan.failed.push({ key: f.key, device: f.device, name: f.name, reason: 'frame' }); });
      deviceScan.state = 'done';
      return done();
    }
    var results = {};
    // One frame at a time keeps the memory / CPU spike small on heavy pages; each one is fast (no scripts run).
    (function next(i) {
      if (i >= todo.length) {
        try { mergeDeviceResults(cur, results, todo); } catch (e) { try { console.warn('[SeoAuditor] device merge failed', e); } catch (e2) {} }
        try { refineHiddenContent(cur, results); } catch (e) { (window.__SeoAuditorErrors = window.__SeoAuditorErrors || []).push('refineHiddenContent: ' + (e && e.message)); }
        try { checkMobileParity(cur, results); } catch (e) { (window.__SeoAuditorErrors = window.__SeoAuditorErrors || []).push('checkMobileParity: ' + (e && e.message)); }
        deviceScan.state = 'done';
        return done();
      }
      scanFrame(todo[i], html, function (res) {
        results[todo[i].key] = res;
        deviceScan.done = i + 1;
        renderPanel();
        next(i + 1);
      });
    })(0);
  }

  // Only the checks that the frames actually run can be compared across devices. Findings of the other
  // checks (meta tags, sitemap, schema, fonts, CWV, internal-link 404s...) are the same on every device,
  // so they get no device tag.
  var DEVICE_SCOPED_RE = /^(img\.(?!broken|heavy)|video\.|form\.|h\.|links\.(nowhere|anchor|noText|generic)$|content\.|mobile\.tapTargets$)/;
  function isDeviceScoped(f) { return DEVICE_SCOPED_RE.test(matchCheckId(f.title || '') || ''); }
  function baseKeyOf(k) { return k.replace(/#\d+$/, ''); }

  function mergeDeviceResults(cur, results, frames) {
    var keys = findingKeys(findings), groups = {};
    findings.forEach(function (f, i) {
      if (!isDeviceScoped(f)) return;
      f.devices = [cur];
      var b = baseKeyOf(keys[i]);
      (groups[b] = groups[b] || []).push({ f: f, path: (f.element && f.element.nodeType === 1) ? elPath(f.element) : '', t: {} });
    });
    frames.forEach(function (def) {
      var res = results[def.key];
      if (!res) return;
      if (!res.ok) { deviceScan.failed.push({ key: def.key, device: def.device, name: def.name, reason: res.reason }); return; }
      deviceScan.frameOk.push(def.key);
      if (deviceScan.checked.indexOf(def.device) === -1) deviceScan.checked.push(def.device);
      var d = res.data, itemsByBase = {};
      Object.keys(d.totals || {}).forEach(function (id) {
        if (id === 'links.internal') return;                       // not run in frames
        if (!(checkTotals[id] >= d.totals[id])) checkTotals[id] = d.totals[id];
      });
      d.items.forEach(function (it) {
        if (!isDeviceScoped(it.f)) return;
        var b = baseKeyOf(it.key);
        (itemsByBase[b] = itemsByBase[b] || []).push(it);
      });
      function mark(c) { c.t[def.key] = true; if (c.f.devices.indexOf(def.device) === -1) c.f.devices.push(def.device); }
      // 1) same element = same content key AND same DOM path
      var pending = {}, totalItems = 0, pathMatched = 0;
      Object.keys(itemsByBase).forEach(function (b) {
        var items = itemsByBase[b], cands = groups[b] || (groups[b] = []), rest = [];
        items.forEach(function (it) {
          totalItems++;
          var c = null;
          // 12.11.2026: a finding without an element (e.g. "Repeated word") has no DOM path on either side; the same key is
          // then the same finding (before, it was added again for every further frame as "only on: tablet" etc.).
          var itPath = it.info && it.info.path;
          for (var i = 0; i < cands.length; i++) { if (!cands[i].t[def.key] && ((cands[i].path && itPath && cands[i].path === itPath) || (!cands[i].path && !itPath))) { c = cands[i]; break; } }
          if (c) { pathMatched++; mark(c); } else rest.push(it);
        });
        pending[b] = rest;
      });
      // 2) if the DOM paths hardly ever agree, pair the leftovers of groups that have the same number of items on both sides, in order
      var pathsUnreliable = totalItems > 0 && pathMatched / totalItems < 0.5;
      Object.keys(pending).forEach(function (b) {
        var rest = pending[b], cands = groups[b], free = cands.filter(function (c) { return !c.t[def.key]; });
        if (pathsUnreliable && rest.length && itemsByBase[b].length === cands.length && free.length === rest.length) {
          rest.forEach(function (it, i) { mark(free[i]); });
          pending[b] = [];
        }
      });
      // 3) what is left exists only on this device -> add it to the list (and the score)
      Object.keys(pending).forEach(function (b) {
        var cands = groups[b];
        pending[b].forEach(function (it) {
          var nf = {};
          Object.keys(it.f).forEach(function (k) { nf[k] = it.f[k]; });
          nf.element = locateByInfo(it.info);
          nf.devices = [def.device];
          nf.deviceOnly = true;
          addFinding(nf);                                           // assigns the id; hiddenUi comes from the frame
          var t = {}; t[def.key] = true;
          cands.push({ f: nf, path: it.info ? it.info.path : '', t: t });
        });
      });
    });
    // Findings were only ever compared among the devices that could actually be scanned.
    findings.forEach(function (f) { if (f.devices) f.devicesChecked = deviceScan.checked.slice(); });
  }

  // ---------------------------------------------------------------------
  // Main
  // ---------------------------------------------------------------------

  function run() {
    if (HEADLESS) { runHeadless(); return; }
    startPerfObservers(runMain);
  }

  function runMain() {
    // Capture the PREVIOUS run's results (if any, from an earlier visit to this exact URL)
    // before this run adds anything new — see the "Previous run vs. now" banner in renderPanel()
    // and saveCurrentRun() below (11.08.2026).
    previousRun = loadPreviousRun();

    // Restore panel position/height/active tab/filters from before a page refresh, if any was
    // saved (11.08.2026 — see the comment above loadPanelState()). Applied BEFORE the first
    // renderPanel() call so the very first render already reflects it, with no visible "snap"
    // from default to restored state. Each field is only applied if present, so a partially-old
    // or partially-missing saved object still safely restores whatever it does have.
    var savedPanelState = loadPanelState();
    if (savedPanelState) {
      if (savedPanelState.panelPosition) panelPosition = savedPanelState.panelPosition;
      if (savedPanelState.panelHeight) panelHeight = savedPanelState.panelHeight;
      if (savedPanelState.activeTab) activeTab = savedPanelState.activeTab;
      if (savedPanelState.activeSeverity) activeSeverity = savedPanelState.activeSeverity;
      if (savedPanelState.activeCategory) activeCategory = savedPanelState.activeCategory;
      if (savedPanelState.activeCategoryOrigin) activeCategoryOrigin = savedPanelState.activeCategoryOrigin;
      if (savedPanelState.activeSuccessGroup) activeSuccessGroup = savedPanelState.activeSuccessGroup;
    }

    // Each check runs on its own: an unexpected error inside one (a page with unusual markup) must not take the others down.
    [checkPreliminary, checkSlug, checkMetaHead, checkFavicon, checkIndexingSignals, checkRobotsForPage, checkCanonicalValid,
     checkOriginalVsRendered, checkMetaRefresh, checkHreflang, checkHeadings, checkImages, checkBrokenImages, checkVideos,
     checkForms, checkLinks, checkLinkCrawl, checkContent, checkTapTargets, checkFonts, checkTechnical, checkAEO].forEach(runCheckSafely);
    tagGlobalFindings();
    renderPanel();

    // The "analysis in progress" banner stays up until everything has really finished (steps: page checks ->
    // performance -> device frames -> the audit's own network requests). A watchdog guarantees it never sticks.
    function finishAnalysis() {
      if (!analysis.busy) return;
      analysis.busy = false;
      tagGlobalFindings();
      renderPanel();
      saveCurrentRun();
    }
    setTimeout(finishAnalysis, 90000);
    analysis.step = 'perf';
    renderPanel();
    measureCWV(function () {
      tagGlobalFindings();
      renderPanel();
      // Save AFTER the async CWV pass completes, so the stored count reflects the fully
      // finished audit (including CWV-related findings), not the mid-run synchronous snapshot.
      saveCurrentRun();
      // Then the per-device pass (mobile / tablet / desktop) — started only now so the extra work
      // cannot disturb the LCP / TTFB measurement above.
      analysis.step = 'devices';
      scanDevices(function () {
        tagGlobalFindings();
        analysis.step = 'network';
        renderPanel();
        // wait for the audit's own requests (image sizes, internal links, robots...) to settle
        var calm = 0, waited = 0;
        (function poll() {
          if (auditPending === 0) calm++; else calm = 0;
          waited += 250;
          if (calm >= 2 || waited >= 15000) return finishAnalysis();
          setTimeout(poll, 250);
        })();
      });
    });
  }

  // ---------------------------------------------------------------------
  // Serbian dictionary (29.10.2026) — English source text -> Serbian. {0},{1}... = runtime values.
  // Used only by tr()/trf() above; English remains the original. Keep keys EXACTLY equal to the
  // English strings written in the checks (a missing key just shows English + is logged in
  // window.__SeoAuditorUntranslated).
  // ---------------------------------------------------------------------
  function srDictData() {
    return {
    "Add a poster attribute to the <video> tag (poster=\"https://…/poster.avif\" — an AVIF/WebP of the first frame) in the embed / custom code the video comes from. A Webflow Background Video element is not affected: Webflow already gives it a poster frame as a CSS background image on the <video>, so it is not reported here. Also provide an MP4 source next to a WebM one so every browser can play it.": "Dodaj poster atribut na <video> tag (poster=\"https://…/poster.avif\" — AVIF/WebP prvog kadra) u embed / custom code iz kog video dolazi. Webflow Background Video element nije obuhvaćen: Webflow mu već daje poster kadar kao CSS pozadinsku sliku na <video>, pa se ovde ne prijavljuje. Dodaj i MP4 izvor pored WebM-a da bi svaki browser mogao da ga pusti.",
    "In Webflow: select the field > Element settings (D) > give it a unique ID; then select the Label element above it > Element settings > Custom attributes > add \"for\" with the field's ID as the value. Alternatively add the custom attribute aria-label = \"what the field is for\" on the field itself.": "U Webflow-u: izaberi polje > Element settings (D) > daj mu jedinstveni ID; zatim izaberi Label element iznad njega > Element settings > Custom attributes > dodaj \"for\" sa ID-jem polja kao vrednošću. Alternativno dodaj custom attribute aria-label = \"čemu polje služi\" na samo polje.",
    "Host the font yourself: download the font files and upload them in Site settings > Fonts tab > Custom fonts (WOFF2 is the best format), and stop using the Google font. Webflow's Google Fonts integration sends visitors' IP addresses to Google and may not be GDPR-compliant. If the uploaded font has the same name as a Google font (e.g. Montserrat), rename it (e.g. \"Montserrat-Regular-1\"), otherwise Webflow may keep loading it from Google.": "Hostuj font sam: preuzmi fajlove fonta i otpremi ih u Site settings > Fonts tab > Custom fonts (WOFF2 je najbolji format), i prestani da koristiš Google font. Webflow-ova Google Fonts integracija šalje IP adrese posetilaca Google-u i možda nije u skladu sa GDPR-om. Ako otpremljeni font ima isto ime kao Google font (npr. Montserrat), preimenuj ga (npr. \"Montserrat-Regular-1\"), inače Webflow može nastaviti da ga učitava sa Google-a.",
    "Convert the font files to .woff2 and upload them in Site settings > Fonts tab > Custom fonts.": "Konvertuj fajlove fonta u .woff2 i otpremi ih u Site settings > Fonts tab > Custom fonts.",
    "Add the \"defer\" attribute (recommended for scripts where execution order/DOM readiness matters — most chat widgets and tracking pixels) or \"async\" (for fully independent scripts). Even better: move the script out of the <head> to Page settings > Custom code > Before </body> tag (site-wide: Site settings > Custom code tab > Footer code) — scripts before the closing </body> tag don't block the first paint.": "Dodaj atribut \"defer\" (preporučeno za skripte kojima je bitan redosled izvršavanja/spremnost DOM-a — većina chat widgeta i tracking piksela) ili \"async\" (za potpuno nezavisne skripte). Još bolje: premesti skriptu iz <head> u Page settings > Custom code > Before </body> tag (za ceo sajt: Site settings > Custom code tab > Footer code) — skripte pre zatvarajućeg </body> taga ne blokiraju prvi prikaz.",
    "Add a sameAs array with the full URLs of the official profiles to the Organization JSON-LD block — in Webflow: Pages panel > Home > Page settings > Schema markup field (or wherever the block was added: Page settings > Custom code > Inside <head> tag, or Site settings > Custom code tab > Head code).": "Dodaj sameAs niz sa punim URL-ovima zvaničnih profila u Organization JSON-LD blok — u Webflow-u: Pages panel > Home > Page settings > polje Schema markup (ili gde je blok dodat: Page settings > Custom code > Inside <head> tag, ili Site settings > Custom code tab > Head code).",
    "Add a JSON-LD Organization block (name, url, logo, sameAs with the official profiles) — in Webflow: Pages panel > Home > Page settings > Schema markup field (Webflow advises not to add the same schema there and in custom code as well).": "Dodaj JSON-LD Organization blok (name, url, logo, sameAs sa zvaničnim profilima) — u Webflow-u: Pages panel > Home > Page settings > polje Schema markup (Webflow savetuje da se ista schema ne dodaje i tamo i u custom code).",
    "Remove all but one <title> tag — set the title in Pages panel > Page settings > SEO settings > Title tag, not manually in custom code.": "Ukloni sve <title> tagove osim jednog — naslov podesi u Pages panel > Page settings > SEO settings > Title tag, ne ručno u custom code-u.",
    "Add a unique, descriptive title in Pages panel > Page settings > SEO settings > Title tag (Webflow recommends under 60 characters).": "Dodaj jedinstven, opisan naslov u Pages panel > Page settings > SEO settings > Title tag (Webflow preporučuje manje od 60 karaktera).",
    "Add a meta description of 70–155 characters in Pages panel > Page settings > SEO settings > Meta description.": "Dodaj meta description od 70–155 karaktera u Pages panel > Page settings > SEO settings > Meta description.",
    "Add it in Pages panel > Page settings > Open Graph settings > Open Graph title (or check the box under the field to copy the SEO title).": "Dodaj ga u Pages panel > Page settings > Open Graph settings > Open Graph title (ili čekiraj polje ispod da se kopira SEO naslov).",
    "Add it in Pages panel > Page settings > Open Graph settings > Open Graph description (or check the box under the field to copy the meta description).": "Dodaj ga u Pages panel > Page settings > Open Graph settings > Open Graph description (ili čekiraj polje ispod da se kopira meta description).",
    "Add it in Pages panel > Page settings > Open Graph settings > Open Graph image (an image link or an image from the Assets panel; use at least 1200×630 px, ratio 1.91:1). On a Collection page choose an Image field.": "Dodaj je u Pages panel > Page settings > Open Graph settings > Open Graph image (link slike ili slika iz Assets panel-a; koristi najmanje 1200×630 px, odnos 1.91:1). Na Collection stranici izaberi Image polje.",
    "Set the site's language code in Webflow: Settings panel > Localization (or the globe icon in the top bar > Localization settings) — choose the primary locale's language (and optionally country), save and publish.": "Podesi kod jezika sajta u Webflow-u: Settings panel > Localization (ili ikonica globusa u gornjoj traci > Localization settings) — izaberi jezik primarnog locale-a (i opciono zemlju), sačuvaj i objavi.",
    "Make the canonical, the site's default domain and the redirects agree on one variant. In Webflow the default domain is set in Site settings > Publishing tab > Production > Make default; visitors on the other domain are then redirected to it.": "Uskladi canonical, podrazumevani domen sajta i preusmerenja na jednu varijantu. U Webflow-u se podrazumevani domen podešava u Site settings > Publishing tab > Production > Make default; posetioci na drugom domenu se tada preusmeravaju na njega.",
    "Rename the slug to something descriptive in the Slug field of Page settings, and if the old URL is already indexed add a 301 redirect from it (Site settings > Publishing > 301 redirects).": "Preimenuj slug u nešto opisno u polju Slug u Page settings, a ako je stari URL već indeksiran dodaj 301 preusmerenje sa njega (Site settings > Publishing > 301 redirects).",
    "Alt text is empty (alt=\"\") — \"Decorative\" or no alt text saved in Webflow": "Alt tekst je prazan (alt=\"\") — „Decorative“ ili u Webflow-u nije sačuvan alt tekst",
    "Webflow outputs an empty alt=\"\" for an image set as \"Decorative\", so screen readers skip it — correct for purely decorative images. It outputs the same alt=\"\" when no alt text is saved at all. In Asset settings such an asset shows \"Descriptive\" selected with an empty field, so \"Descriptive\" being checked does not mean a description exists. So alt=\"\" does not prove anyone chose \"Decorative\" — only the Designer shows that. It is listed for checking only and does not affect the score.": "Webflow ispisuje prazan alt=\"\" za sliku podešenu kao „Decorative“, pa je čitači ekrana preskaču — ispravno za čisto dekorativne slike. Isti alt=\"\" ispisuje i kada alt tekst uopšte nije sačuvan. U Asset settings takav asset ima izabrano „Descriptive“ sa praznim poljem, pa čekirano „Descriptive“ ne znači da opis postoji. Zato alt=\"\" ne dokazuje da je neko izabrao „Decorative“ — to se vidi samo u Designer-u. Navedeno je samo radi provere i ne utiče na skor.",
    "Check in the Designer: select the image > Element settings panel > Image settings > Alt text, and the asset itself: Assets panel > the image's more options > Edit settings > Alt text. If it is \"Decorative\" and the image is purely decorative, no action is needed. If \"Descriptive\" is selected but the text field is empty, or the image carries meaning, type a description (on the asset, or for this instance: Custom description).": "Proveri u Designer-u: izaberi sliku > Element settings panel > Image settings > Alt text, i sam asset: Assets panel > more options slike > Edit settings > Alt text. Ako je „Decorative“ i slika je čisto dekorativna, ništa ne treba menjati. Ako je izabrano „Descriptive“, a polje za tekst je prazno, ili slika nosi značenje, upiši opis (na asset-u, ili za ovu instancu: Custom description).",
    "Add descriptive alt text: Assets panel > the image's more options > Edit settings > Descriptive (applies wherever the image is placed from then on), or for this instance Element settings panel > Image settings > Alt text > Custom description. If the image is purely decorative, choose \"Decorative\" instead.": "Dodaj opisni alt tekst: Assets panel > more options slike > Edit settings > Descriptive (važi gde god se slika od tada postavi), ili samo za ovu instancu Element settings panel > Image settings > Alt text > Custom description. Ako je slika čisto dekorativna, izaberi \"Decorative\".",
    "In the Designer: select the image > Element settings panel > Image settings > Set loading behavior > \"Lazy\" (keep \"Eager\" only for the hero / above-the-fold images).": "U Designer-u: izaberi sliku > Element settings panel > Image settings > Set loading behavior > \"Lazy\" (\"Eager\" ostavi samo za hero / slike iznad preloma).",
    "In the Designer: select each image in the first screen (hero, logo, the first row of logos) > Element settings panel > Image settings > Set loading behavior > \"Eager\". Keep \"Lazy\" for everything further down the page.": "U Designer-u: izaberi svaku sliku u prvom ekranu (hero, logo, prvi red logotipa) > Element settings panel > Image settings > Set loading behavior > \"Eager\". \"Lazy\" zadrži za sve niže na stranici.",
    "In the Designer: select the image > Element settings panel > Image settings > Set loading behavior > \"Eager\". Optionally also add the custom attribute fetchpriority=\"high\" (Element settings panel > Custom attributes).": "U Designer-u: izaberi sliku > Element settings panel > Image settings > Set loading behavior > \"Eager\". Opciono dodaj i custom attribute fetchpriority=\"high\" (Element settings panel > Custom attributes).",
    "Download the image and upload it to the site in the Assets panel, then use that copy.": "Preuzmi sliku i otpremi je na sajt u Assets panel-u, pa koristi tu kopiju.",
    "Convert it to WebP or AVIF: Assets panel > hover the image > more options > Compress > WebP or AVIF (only JPG and PNG can be compressed; Webflow advises against compressing Open Graph images).": "Konvertuj je u WebP ili AVIF: Assets panel > pređi mišem preko slike > more options > Compress > WebP ili AVIF (kompresovati se mogu samo JPG i PNG; Webflow savetuje da se Open Graph slike ne kompresuju).",
    "INP not measured yet — click something on the page": "INP još nije izmeren — klikni nešto na stranici",
    "INP (Interaction to Next Paint) is the Core Web Vital for responsiveness. Only a real click, tap or key press creates it — scrolling and hovering don't count, and the bookmarklet can't click for you (clicks made by a script are not counted by the browser). Until you interact, INP has no value and does not affect the score.": "INP (Interaction to Next Paint) je Core Web Vital za brzinu odziva. Stvara ga samo pravi klik, dodir ili pritisak tastera — skrolovanje i prelazak mišem se ne računaju, a bookmarklet ne može da klikne umesto tebe (browser ne računa klikove koje napravi skripta). Dok ne klikneš, INP nema vrednost i ne utiče na skor.",
    "With this panel open, click or tap things on the page that open or change something on the same page — the menu, tabs, accordions, sliders, dropdowns, form fields. The INP result appears here right away and updates the score. Avoid ordinary links: they open another page and close the panel. Clicks inside this panel are not counted.": "Dok je ovaj panel otvoren, klikni ili dodirni na stranici ono što otvara ili menja nešto na istoj stranici — meni, tabove, accordion-e, slajdere, dropdown-e, polja forme. Rezultat INP-a se odmah pojavljuje ovde i ažurira skor. Izbegavaj obične linkove: otvaraju drugu stranicu i zatvaraju panel. Klikovi unutar ovog panela se ne računaju.",
    "Slowest of {0} interaction(s) measured: {1} on {2}. Keep clicking the menu, tabs, accordions... to measure more — the result updates here.": "Najsporija od izmerenih interakcija ({0}): {1} na {2}. Nastavi da klikćeš meni, tabove, accordion-e... da izmeriš više — rezultat se ažurira ovde.",
    "Slowest of {0} interaction(s) measured: {1}. Keep clicking the menu, tabs, accordions... to measure more — the result updates here.": "Najsporija od izmerenih interakcija ({0}): {1}. Nastavi da klikćeš meni, tabove, accordion-e... da izmeriš više — rezultat se ažurira ovde.",
    "Slow INP (Interaction to Next Paint): {0}ms": "Spor INP (Interaction to Next Paint): {0}ms",
    "An INP at or below 200 ms is good, above 200 ms needs improvement and above 500 ms is poor{0}. INP is a Core Web Vital, part of what Google's ranking systems reward. Measured here, in this browser on this computer; Google uses data from real visitors (75th percentile of page loads).": "INP do 200 ms je dobar, iznad 200 ms treba poboljšanje, a iznad 500 ms je loš{0}. INP je Core Web Vital, deo onoga što Google-ovi sistemi rangiranja nagrađuju. Izmereno ovde, u ovom browseru na ovom računaru; Google koristi podatke stvarnih posetilaca (75. percentil učitavanja).",
    " — this one is poor": " — ovaj je loš",
    "Record the slow interaction in Chrome DevTools > Performance and see what runs on that click (custom code, third-party scripts, heavy animations), then make it lighter or defer it.": "Snimi sporu interakciju u Chrome DevTools > Performance i vidi šta se izvršava na taj klik (custom code, skripte trećih strana, teške animacije), pa to olakšaj ili odloži.",
    "INP is good ({0}ms, at or under Google's 200ms threshold)": "INP je dobar ({0}ms, do Google-ovog praga od 200ms)",
    "INP (interaction to next paint)": "INP (interaction to next paint)",
    "Image does not load (broken image)": "Slika se ne učitava (polomljena slika)",
    "(used {0} times on this page)": "(korišćena {0} puta na ovoj stranici)",
    "The browser could not load this image file (it no longer exists, the URL is misspelled or the path is wrong), so visitors and Google see an empty spot.": "Browser nije mogao da učita ovaj fajl slike (više ne postoji, URL je pogrešno napisan ili je putanja pogrešna), pa posetioci i Google vide prazno mesto.",
    "Replace the image: select it > Element settings panel > Image settings > Replace image (or fix the URL in the CMS field / custom code it comes from). Publish.": "Zameni sliku: izaberi je > Element settings panel > Image settings > Replace image (ili ispravi URL u CMS polju / custom code-u odakle dolazi). Objavi.",
    "All images load ({0} checked)": "Sve slike se učitavaju (provereno: {0})",
    "Images load (no broken images)": "Slike se učitavaju (nema polomljenih)",
    "Navigation without a crawlable link ({0})": "Navigacija bez linka koji Google može da prati ({0})",
    "href on <{0}>": "href na <{0}>",
    "role=\"link\" without <a href>": "role=\"link\" bez <a href>",
    "onclick navigation": "navigacija preko onclick",
    "Google can generally only follow a link that is an <a> element with an href; it can't reliably find URLs in elements without an href or in tags that act as links through scripts (for example <span href> or <a onclick>). The page behind this element may not be discovered through this link.": "Google uglavnom može da prati samo link koji je <a> element sa href-om; ne može pouzdano da pronađe URL u elementima bez href-a niti u tagovima koji rade kao link preko skripte (npr. <span href> ili <a onclick>). Stranica iza ovog elementa možda neće biti otkrivena preko ovog linka.",
    "Make it a real link: in Webflow use a Link block, Text link or Button and set the destination in the Element settings panel (Link settings); to make an image or a block clickable, drop it inside a Link block. Remove the click script / custom attribute that did the navigation.": "Napravi pravi link: u Webflow-u koristi Link block, Text link ili Button i podesi odredište u Element settings panel-u (Link settings); da bi slika ili blok bili klikabilni, stavi ih unutar Link block-a. Ukloni skriptu / custom attribute koji je radio navigaciju.",
    "All navigation uses crawlable <a href> links": "Sva navigacija koristi <a href> linkove koje Google može da prati",
    "Navigation uses crawlable links": "Navigacija koristi linkove koje Google prati",
    "Internal link has rel=\"nofollow\"": "Interni link ima rel=\"nofollow\"",
    "Google generally doesn't follow links with nofollow; nofollow is meant for links you don't want associated with your site. On an internal link it holds back crawling of your own page — to keep a page out of search, use noindex or robots.txt instead.": "Google uglavnom ne prati linkove sa nofollow; nofollow je namenjen linkovima koje ne želiš da poveže sa tvojim sajtom. Na internom linku koči pretraživanje tvoje sopstvene stranice — da bi stranica ostala van pretrage, koristi noindex ili robots.txt.",
    "Remove rel=\"nofollow\" from the internal link — in Webflow it comes from a custom attribute (Element settings panel > Custom attributes) or from custom code. To keep a page out of Google, use noindex (Page settings > SEO settings > Sitemap indexing off); to stop crawling, robots.txt.": "Ukloni rel=\"nofollow\" sa internog linka — u Webflow-u dolazi iz custom attribute-a (Element settings panel > Custom attributes) ili iz custom code-a. Da stranica ne bi bila u Google-u koristi noindex (Page settings > SEO settings > Sitemap indexing isključen); da se ne bi crawl-ovala, robots.txt.",
    "No internal link has rel=\"nofollow\" ({0} checked)": "Nijedan interni link nema rel=\"nofollow\" (provereno: {0})",
    "No nofollow on internal links": "Nema nofollow na internim linkovima",
    "Image link has no anchor text (image without alt)": "Link sa slikom nema anchor tekst (slika bez alt-a)",
    "image: {0}": "slika: {0}",
    "(aria-label=\"{0}\" helps screen readers, but Google uses the image alt as anchor text)": "(aria-label=\"{0}\" pomaže čitačima ekrana, ali Google kao anchor tekst koristi alt slike)",
    "When an image is a link, Google uses its alt text as the link text. An image link with empty alt and no text tells Google nothing about the page it points to.": "Kada je slika link, Google koristi njen alt tekst kao tekst linka. Link-slika sa praznim alt-om i bez teksta ne govori Google-u ništa o stranici na koju vodi.",
    "Give the image descriptive alt text: select it > Element settings panel > Image settings > Alt text > Custom description (or in the Assets panel: the image's settings > descriptive text; for a CMS image bind the alt text to a field). Or add visible text inside the link.": "Daj slici opisni alt tekst: izaberi je > Element settings panel > Image settings > Alt text > Custom description (ili u Assets panel-u: podešavanja slike > opisni tekst; za CMS sliku poveži alt tekst sa poljem). Ili dodaj vidljiv tekst unutar linka.",
    "All image links have alt text ({0} checked)": "Svi linkovi sa slikom imaju alt tekst (provereno: {0})",
    "Image links have alt text": "Linkovi sa slikom imaju alt tekst",
    "{0} schema is missing properties Google requires: {1}": "{0} schema nema svojstva koja Google zahteva: {1}",
    "These properties are required for the {0} rich result in Google: without them the item is not eligible for it (structured data makes a rich result possible, but doesn't guarantee it, and doesn't affect ranking).": "Ova svojstva su obavezna za {0} rich result u Google-u: bez njih stavka ne može da dobije taj prikaz (strukturirani podaci omogućavaju rich result, ali ga ne garantuju i ne utiču na rangiranje).",
    "In Webflow: Pages panel > the page's Settings > Schema markup field (or the custom code where the JSON-LD was added); on a Collection page bind the CMS fields so every item gets its own values. Publish.": "U Webflow-u: Pages panel > Settings stranice > polje Schema markup (ili custom code u koji je JSON-LD dodat); na Collection stranici poveži CMS polja da svaka stavka dobije svoje vrednosti. Objavi.",
    "Add the missing properties. {0}": "Dodaj svojstva koja nedostaju. {0}",
    "Schema has the properties Google requires ({0})": "Schema ima svojstva koja Google zahteva ({0})",
    "Schema has Google-required properties": "Schema ima svojstva koja Google zahteva",
    "Schema text not found on the page ({0})": "Tekst iz schema nije pronađen na stranici ({0})",
    "Structured data must describe what readers actually see on the page — if the JSON-LD describes something, the page text must describe the same thing. These names/headlines from the schema don't appear in the page text (compared without case and punctuation).": "Strukturirani podaci moraju da opisuju ono što čitaoci zaista vide na stranici — ako JSON-LD nešto opisuje, tekst stranice mora da opisuje isto. Ovi nazivi/naslovi iz scheme se ne pojavljuju u tekstu stranice (poređeno bez velikih slova i interpunkcije).",
    "Make the schema match what the page shows (same headline / name), or show that text on the page. {0}": "Uskladi schema sa onim što stranica prikazuje (isti naslov / naziv) ili prikaži taj tekst na stranici. {0}",
    "Schema names/headlines appear on the page ({0} checked)": "Nazivi/naslovi iz schema se pojavljuju na stranici (provereno: {0})",
    "Schema text is on the page": "Tekst iz schema je na stranici",
    "Content visible on desktop is missing on mobile ({0})": "Sadržaj vidljiv na desktopu nedostaje na mobilnom ({0})",
    "Heading — {0}": "Naslov — {0}",
    "Text — {0}": "Tekst — {0}",
    "Image — {0}": "Slika — {0}",
    "Google indexes and ranks the mobile version of the page (mobile-first indexing), so the mobile page should have the same content, headings and image alt text as desktop. Content may sit in accordions or tabs on mobile, but content that is removed can't be used by Google. These items are visible on desktop but hidden (display: none) in the mobile frame (375 px), and not inside a tab, accordion, dropdown, slider or menu there.": "Google indeksira i rangira mobilnu verziju stranice (mobile-first indexing), pa mobilna stranica treba da ima isti sadržaj, naslove i alt tekst slika kao desktop. Sadržaj na mobilnom sme da bude u accordion-ima ili tabovima, ali uklonjen sadržaj Google ne može da koristi. Ove stavke su vidljive na desktopu, a skrivene (display: none) u mobilnom okviru (375 px), i tamo nisu u tabu, accordion-u, dropdown-u, slajderu ni meniju.",
    "Show this content on the Mobile breakpoint, or move it into a tab/accordion instead of hiding it. In Webflow an element is hidden per breakpoint with Style panel > Layout > display: none — select the breakpoint in the canvas bar and change it; display is a class style, so it applies to every element with the same class and cascades to smaller breakpoints.": "Prikaži ovaj sadržaj na Mobile breakpoint-u ili ga premesti u tab/accordion umesto da ga skrivaš. U Webflow-u se element skriva po breakpoint-u preko Style panel > Layout > display: none — izaberi breakpoint u traci iznad canvas-a i promeni ga; display je stil klase, pa važi za svaki element sa istom klasom i prenosi se na manje breakpoint-e.",
    "Mobile shows the same content as desktop ({0} items compared)": "Mobilni prikazuje isti sadržaj kao desktop (upoređeno stavki: {0})",
    "Same content on mobile as on desktop": "Isti sadržaj na mobilnom kao na desktopu",
    "Tap target is too small and too close to another ({0} px)": "Element za dodir je premali i preblizu drugom ({0} px)",
    "A tap target should be at least 24 by 24 CSS pixels, unless there is enough space around it (a 24 px circle centred on it doesn't touch another target). This one is smaller and has a neighbour that close, so on a phone it is easy to tap the wrong thing. This is an accessibility issue, so it is listed as a note and does not affect the score.": "Element za dodir treba da bude najmanje 24 x 24 CSS piksela, osim ako oko njega ima dovoljno prostora (krug od 24 px oko njegovog centra ne dodiruje drugi element). Ovaj je manji i ima suseda toliko blizu, pa je na telefonu lako dodirnuti pogrešan. Ovo je pitanje pristupačnosti, pa je navedeno kao napomena i ne utiče na skor.",
    "On the Mobile breakpoint make the target at least 24x24 px (padding counts) or give it more space from its neighbours — in Webflow, Style panel (size / padding / margin) with the Mobile breakpoint selected.": "Na Mobile breakpoint-u napravi element od najmanje 24x24 px (padding se računa) ili mu daj više prostora od suseda — u Webflow-u, Style panel (veličina / padding / margin) sa izabranim Mobile breakpoint-om.",
    "Tap targets on mobile (24x24 px)": "Elementi za dodir na mobilnom (24x24 px)",
    "custom code (Page settings > Custom code > Inside <head> tag, or Site settings > Custom code > Head code)": "custom code-a (Page settings > Custom code > Inside <head> tag, ili Site settings > Custom code > Head code)",
    "In Webflow the canonical comes from Site settings > SEO > Global canonical URL (the site's base URL, e.g. https://www.yourdomain.com, without a trailing slash — Webflow adds each page's slug) or, for one static page, from Page settings > SEO settings > Page canonical URL (a full URL starting with https://). Any other canonical comes from custom code (Page settings > Custom code > Inside <head> tag, or Site settings > Custom code > Head code) or from a tool such as Google Tag Manager — Webflow advises not to set the global canonical tag when another tool injects it. Publish after the change.": "U Webflow-u canonical dolazi iz Site settings > SEO > Global canonical URL (osnovni URL sajta, npr. https://www.yourdomain.com, bez kose crte na kraju — Webflow dodaje slug svake stranice) ili, za jednu statičnu stranicu, iz Page settings > SEO settings > Page canonical URL (pun URL koji počinje sa https://). Svaki drugi canonical dolazi iz custom code-a (Page settings > Custom code > Inside <head> tag, ili Site settings > Custom code > Head code) ili iz alata kao što je Google Tag Manager — Webflow savetuje da se globalni canonical tag ne podešava kada ga drugi alat ubacuje. Objavi sajt posle izmene.",
    "A tag written in the head custom code can still end up in <body>: when an element that isn't allowed in <head> (for example a <div>, <img>, <p> or plain text) comes before it, the browser closes <head> early and everything after it lands in <body>.": "Tag napisan u head custom code-u ipak može da završi u <body>: kada pre njega stoji element koji nije dozvoljen u <head> (na primer <div>, <img>, <p> ili običan tekst), browser ranije zatvara <head> i sve posle toga završava u <body>.",
    "In Webflow: Site settings > General tab > Icons — upload one square image (PNG is safest). Webflow then generates the 32x32 and 48x48 favicons, 180x180 and 192x192 touch icons and a 256x256 webclip by itself (Webflow update, May 2026), so upload at least 256x256px — then no generated size is enlarged from a smaller image. Publish the site afterwards.": "U Webflow-u: Site settings > General tab > Icons — otpremi jednu kvadratnu sliku (PNG je najsigurniji). Webflow zatim sam generiše favicon-e 32x32 i 48x48, touch ikonice 180x180 i 192x192 i webclip 256x256 (Webflow ažuriranje, maj 2026), zato otpremi bar 256x256px — tada se nijedna generisana veličina ne uvećava iz manje slike. Zatim objavi sajt.",
    "In Webflow, Localization generates the hreflang tags by itself: Settings panel > Localization lets you turn automatic generation on or off and choose the base URL (the published/canonical URL or a custom one). Hreflang tags written in custom code (Page settings > Custom code > Inside <head> tag, or Site settings > Custom code > Head code) have to be fixed there.": "U Webflow-u Localization sama generiše hreflang tagove: Settings panel > Localization omogućava da uključiš ili isključiš automatsko generisanje i izabereš osnovni URL (objavljeni/canonical URL ili prilagođeni). Hreflang tagovi napisani u custom code-a (Page settings > Custom code > Inside <head> tag, ili Site settings > Custom code > Head code) moraju da se isprave tamo.",
    "In Webflow: Site settings > SEO > Indexing — edit the robots.txt rules (also check the Traffic control toggles there, which generate robots.txt rules for known bots), save and publish. A page blocked in robots.txt still stays in Webflow's auto-generated sitemap.": "U Webflow-u: Site settings > SEO > Indexing — izmeni robots.txt pravila (proveri i Traffic control prekidače tamo, koji generišu robots.txt pravila za poznate botove), sačuvaj i objavi. Stranica blokirana u robots.txt i dalje ostaje u Webflow automatski generisanom sitemap-u.",
    " This is the webflow.io staging domain: with \"Staging indexing\" turned off, Webflow publishes a robots.txt on the staging subdomain that tells search engines to ignore it — expected here; check the live domain.": " Ovo je webflow.io staging domen: kada je \"Staging indexing\" isključen, Webflow na staging poddomenu objavljuje robots.txt koji pretraživačima kaže da ga ignorišu — ovde je to očekivano; proveri live domen.",
    "Favicon is not in a format Google Search supports ({0})": "Favicon nije u formatu koji Google Search podržava ({0})",
    "Google Search supports these favicon formats: BMP, GIF, ICO, PNG, JPEG, PPM and TIFF. An SVG (or WebP) favicon works in browsers, but Google Search can't use it, so the result may show a generic icon.": "Google Search podržava ove formate favicon-a: BMP, GIF, ICO, PNG, JPEG, PPM i TIFF. SVG (ili WebP) favicon radi u browserima, ali Google Search ne može da ga koristi, pa rezultat može da prikaže generičku ikonicu.",
    "Also provide a PNG or ICO favicon. {0} (Webflow converts an SVG upload to PNG.)": "Obezbedi i PNG ili ICO favicon. {0} (Webflow otpremljeni SVG pretvara u PNG.)",
    "Favicon dimensions do not meet Google's requirement (square, at least 8x8px): {0}": "Dimenzije favicon-a ne ispunjavaju Google-ov uslov (kvadrat, najmanje 8x8px): {0}",
    "Google Search shows a favicon only if it is a square (1:1 aspect ratio) of at least 8x8px. None of the icons declared on this page is.": "Google Search prikazuje favicon samo ako je kvadrat (odnos 1:1) od najmanje 8x8px. Nijedna ikonica navedena na ovoj stranici to nije.",
    "Favicon dimensions: no icon is larger than 48x48px (largest: {0})": "Dimenzije favicon-a: nijedna ikonica nije veća od 48x48px (najveća: {0})",
    "Google Search requires at least 8x8px, but recommends a favicon larger than 48x48px so it looks good on various surfaces.": "Google Search zahteva najmanje 8x8px, ali preporučuje favicon veći od 48x48px kako bi lepo izgledao na različitim površinama.",
    "Favicon is square and larger than 48x48px ({0})": "Favicon je kvadratni i veći od 48x48px ({0})",
    "The path \"{0}\" is blocked by \"{1}\" (group: User-agent: {2}).": "Putanju \"{0}\" blokira \"{1}\" (grupa: User-agent: {2}).",
    "Google must be able to crawl the favicon file (it must not be blocked in robots.txt for Googlebot-Image), otherwise it can't show it in search results.": "Google mora moći da preuzme favicon fajl (ne sme biti blokiran u robots.txt za Googlebot-Image), inače ga ne može prikazati u rezultatima pretrage.",
    "In Webflow: Site settings > SEO > Indexing — change the robots.txt rules so they don't cover the favicon path (add an Allow rule for it or narrow the Disallow rule), save and publish.": "U Webflow-u: Site settings > SEO > Indexing — izmeni robots.txt pravila tako da ne pokrivaju putanju favicon-a (dodaj Allow pravilo za nju ili suzi Disallow pravilo), sačuvaj i objavi.",
    "Page is blocked in robots.txt for Googlebot": "Stranica je blokirana u robots.txt za Googlebot",
    "Rule: {0} (group: User-agent: {1})": "Pravilo: {0} (grupa: User-agent: {1})",
    "Google can't crawl this page, so it can't read its content. A page blocked in robots.txt can still appear in search results (for example when other sites link to it), but without a description; and AI Overviews / AI Mode can only use pages that may be crawled.{0}": "Google ne može da pretraži ovu stranicu, pa ne može ni da pročita njen sadržaj. Stranica blokirana u robots.txt i dalje može da se pojavi u rezultatima (npr. kada je drugi sajtovi linkuju), ali bez opisa; a AI Overviews / AI Mode mogu da koriste samo stranice koje smeju da se pretražuju.{0}",
    "Relevant to both SEO and AEO — a page Google can't crawl can't be used as a source for AI Overviews / AI Mode either.": "Relevantno i za SEO i za AEO — stranica koju Google ne može da crawl-uje ne može da bude ni izvor za AI Overviews / AI Mode.",
    "Page is not blocked in robots.txt for Googlebot": "Stranica nije blokirana u robots.txt za Googlebot",
    "There is no robots.txt (HTTP {0}), so there are no crawl restrictions.": "Nema robots.txt fajla (HTTP {0}), pa nema ograničenja za crawl.",
    "Applicable rule: {0} (group: User-agent: {1})": "Pravilo koje važi: {0} (grupa: User-agent: {1})",
    "No rule in the applicable group (User-agent: {0}) covers this path.": "Nijedno pravilo u grupi koja važi (User-agent: {0}) ne pokriva ovu putanju.",
    "No group in robots.txt applies to Googlebot.": "Nijedna grupa u robots.txt se ne odnosi na Googlebot.",
    "robots.txt answers HTTP {0}": "robots.txt odgovara sa HTTP {0}",
    "When robots.txt can't be fetched because of a server error (5xx or 429), Google stops crawling the site for the first 12 hours and then uses the last good version of the file for up to 30 days; other crawlers may treat the whole site as blocked while robots.txt is unreachable.": "Kada robots.txt ne može da se preuzme zbog greške servera (5xx ili 429), Google prvih 12 sati prestaje da pretražuje sajt, a zatim do 30 dana koristi poslednju ispravnu verziju fajla; drugi crawleri mogu ceo sajt smatrati blokiranim dok je robots.txt nedostupan.",
    "Make /robots.txt answer HTTP 200. On Webflow hosting the file is generated from Site settings > SEO > Indexing; if a proxy or CDN sits in front of the site, the error comes from there.": "Podesi da /robots.txt odgovara sa HTTP 200. Na Webflow hostingu fajl se generiše iz Site settings > SEO > Indexing; ako ispred sajta stoji proxy ili CDN, greška dolazi odatle.",
    "If a proxy / CDN (e.g. Cloudflare) sits in front of the site, whoever manages it has to fix the response.": "Ako ispred sajta stoji proxy / CDN (npr. Cloudflare), odgovor mora da ispravi onaj ko njime upravlja.",
    "Page is blocked in robots.txt for AI search crawlers ({0} of {1})": "Stranica je blokirana u robots.txt za AI crawlere pretrage ({0} od {1})",
    "{0}: {1} (group: User-agent: {2})": "{0}: {1} (grupa: User-agent: {2})",
    "OpenAI uses OAI-SearchBot to show websites in ChatGPT search, Perplexity uses PerplexityBot to surface and link pages in its answers, and blocking Claude-SearchBot or Claude-User can reduce a site's visibility in Claude's search results. (The training crawlers GPTBot and ClaudeBot are not checked — blocking them only opts out of AI training.) If blocking these crawlers is a deliberate decision, this note can be ignored.{0}": "OpenAI koristi OAI-SearchBot da prikaže sajtove u ChatGPT pretrazi, Perplexity koristi PerplexityBot da pronađe i linkuje stranice u odgovorima, a blokiranje Claude-SearchBot ili Claude-User može smanjiti vidljivost sajta u Claude pretrazi. (Crawleri za treniranje GPTBot i ClaudeBot se ne proveravaju — njihovo blokiranje samo isključuje AI treniranje.) Ako je blokiranje ovih crawlera namerna odluka, ova napomena se može zanemariti.{0}",
    "Page is not blocked in robots.txt for AI search crawlers": "Stranica nije blokirana u robots.txt za AI crawlere pretrage",
    "OAI-SearchBot (ChatGPT search), PerplexityBot (Perplexity), Claude-SearchBot (Claude search), Claude-User (Claude fetching pages for users)": "OAI-SearchBot (ChatGPT pretraga), PerplexityBot (Perplexity), Claude-SearchBot (Claude pretraga), Claude-User (Claude učitava stranice za korisnike)",
    "OAI-SearchBot (ChatGPT search)": "OAI-SearchBot (ChatGPT pretraga)",
    "Claude-SearchBot (Claude search)": "Claude-SearchBot (Claude pretraga)",
    "Claude-User (Claude fetching pages for users)": "Claude-User (Claude učitava stranice za korisnike)",
    "robots.txt check for this page": "Provera robots.txt za ovu stranicu",
    "Canonical tag is outside <head> ({0})": "Canonical tag je van <head> ({0})",
    "A rel=\"canonical\" link counts only inside the <head> of the HTML — this extra one is ignored, but it shows that the head code has a problem. {0}": "rel=\"canonical\" link važi samo unutar <head> dela HTML-a — ovaj dodatni se zanemaruje, ali pokazuje da kod u head-u ima problem. {0}",
    "Move the canonical into <head> and remove from the head code above it anything that isn't allowed in <head> (only <title>, <meta>, <link>, <style>, <script>, <noscript>, <base> and <template> belong there). {0}": "Premesti canonical u <head> i iz head koda iznad njega ukloni sve što nije dozvoljeno u <head> (tamo pripadaju samo <title>, <meta>, <link>, <style>, <script>, <noscript>, <base> i <template>). {0}",
    "More than one canonical tag, with different URLs ({0})": "Više od jednog canonical taga, sa različitim URL-ovima ({0})",
    "Several different rel=\"canonical\" tags can lead to unexpected results — there should be only one.": "Više različitih rel=\"canonical\" tagova može dovesti do neočekivanih rezultata — treba da postoji samo jedan.",
    "Keep exactly one canonical. {0}": "Zadrži tačno jedan canonical. {0}",
    "Canonical tag appears {0} times (same URL)": "Canonical tag se pojavljuje {0} puta (isti URL)",
    "There should be only one rel=\"canonical\" tag on the page, even if they agree. Usually one comes from the Webflow settings and another from custom code.": "Na stranici treba da postoji samo jedan rel=\"canonical\" tag, čak i kada se slažu. Obično jedan dolazi iz Webflow podešavanja, a drugi iz custom code-a.",
    "Remove the extra canonical. {0}": "Ukloni višak canonical-a. {0}",
    "Canonical uses a relative URL ({0})": "Canonical koristi relativni URL ({0})",
    "Use an absolute URL in rel=\"canonical\", not a relative path. Relative paths work, but can cause problems later (for example, if a testing site gets crawled).": "Koristi apsolutni URL u rel=\"canonical\", ne relativnu putanju. Relativne putanje rade, ali kasnije mogu napraviti problem (npr. ako se pretraži test sajt).",
    "Use a full URL starting with https://. {0}": "Koristi pun URL koji počinje sa https://. {0}",
    "Canonical URL contains a fragment (#)": "Canonical URL sadrži fragment (#)",
    "Don't use a URL with a #fragment as canonical — Google generally ignores URL fragments.": "Ne koristi URL sa #fragmentom kao canonical — Google uglavnom zanemaruje fragmente URL-a.",
    "Remove the #... part from the canonical URL. {0}": "Ukloni #... deo iz canonical URL-a. {0}",
    "Canonical tag is valid (one absolute URL, in <head>)": "Canonical tag je ispravan (jedan apsolutni URL, u <head>)",
    "There is a <link rel=\"canonical\"> (href: {0}), but it is outside <head>, where Google ignores it. {1}": "Postoji <link rel=\"canonical\"> (href: {0}), ali je van <head>, gde ga Google ignoriše. {1}",
    "Add a canonical tag pointing to this page. {0}": "Dodaj canonical tag koji pokazuje na ovu stranicu. {0}",
    "If it is not intentional, make the canonical point to this page's own URL. {0}": "Ako nije namerno, podesi da canonical pokazuje na URL ove stranice. {0}",
    "Check whether this is intentional. If not, make the canonical point to this page. {0}": "Proveri da li je ovo namerno. Ako nije, podesi da canonical pokazuje na ovu stranicu. {0}",
    "If the page should be visible in search: in Webflow, Page settings > SEO settings > turn \"Sitemap indexing\" back on (turned off, it adds <meta name=\"robots\" content=\"noindex\">); for a CMS item: the Collection item > Item details > Sitemap indexing. A noindex can also come from custom code (Page settings > Custom code > Inside <head> tag, or Site settings > Custom code > Head code). Publish after the change.": "Ako stranica treba da bude vidljiva u pretrazi: u Webflow-u, Page settings > SEO settings > ponovo uključi \"Sitemap indexing\" (kada je isključen, dodaje <meta name=\"robots\" content=\"noindex\">); za CMS stavku: stavka kolekcije > Item details > Sitemap indexing. Noindex može da dolazi i iz custom code-a (Page settings > Custom code > Inside <head> tag, ili Site settings > Custom code > Head code). Objavi sajt posle izmene.",
    "In Webflow: Page settings > SEO settings > \"Sitemap indexing\" must be on (for a CMS item: the Collection item > Item details > Sitemap indexing); it works only when the site's auto-generated sitemap is enabled. Publish after the change.": "U Webflow-u: Page settings > SEO settings > \"Sitemap indexing\" mora biti uključen (za CMS stavku: stavka kolekcije > Item details > Sitemap indexing); radi samo kada je uključen automatski generisan sitemap sajta. Objavi sajt posle izmene.",
    "noindex is in the original HTML but removed by JavaScript": "noindex je u originalnom HTML-u, ali ga JavaScript uklanja",
    "Original HTML: {0}": "Originalni HTML: {0}",
    "After JavaScript: no noindex": "Posle JavaScript-a: nema noindex-a",
    "After JavaScript: {0}": "Posle JavaScript-a: {0}",
    "When Google sees noindex in the original HTML, it may skip running JavaScript, so a script that removes noindex may never take effect. If the page should be indexed, don't put noindex in the original page code.": "Kada Google vidi noindex u originalnom HTML-u, može da preskoči izvršavanje JavaScript-a, pa skripta koja uklanja noindex možda nikad neće imati efekat. Ako stranica treba da bude indeksirana, ne stavljaj noindex u originalni kod stranice.",
    "Remove the noindex from the original HTML and remove the script that deletes it. In Webflow, Page settings > SEO settings > \"Sitemap indexing\" turned off is what adds <meta name=\"robots\" content=\"noindex\"> — turn it on (for a CMS item: the Collection item > Item details > Sitemap indexing); a noindex can also come from {0}. Publish.": "Ukloni noindex iz originalnog HTML-a i ukloni skriptu koja ga briše. U Webflow-u <meta name=\"robots\" content=\"noindex\"> dodaje isključen Page settings > SEO settings > \"Sitemap indexing\" — uključi ga (za CMS stavku: stavka kolekcije > Item details > Sitemap indexing); noindex može da dolazi i iz {0}. Objavi.",
    "Canonical in the original HTML differs from the canonical after JavaScript": "Canonical u originalnom HTML-u se razlikuje od canonical-a posle JavaScript-a",
    "JavaScript shouldn't change the canonical to a different URL than the one in the original HTML — if a script sets it, it must set the same value.": "JavaScript ne bi trebalo da menja canonical u drugačiji URL od onog u originalnom HTML-u — ako ga skripta postavlja, mora postaviti istu vrednost.",
    "Find the script that changes the canonical (custom code, Google Tag Manager or another tool) and stop it, so only one source sets the canonical. {0}": "Pronađi skriptu koja menja canonical (custom code, Google Tag Manager ili drugi alat) i zaustavi je, tako da canonical postavlja samo jedan izvor. {0}",
    "Original HTML and the page after JavaScript agree on noindex and canonical": "Originalni HTML i stranica posle JavaScript-a se slažu oko noindex-a i canonical-a",
    "noindex: {0} / {1} — canonical: {2} / {3}": "noindex: {0} / {1} — canonical: {2} / {3}",
    "yes": "da",
    "no": "ne",
    "(none)": "(nema)",
    "Original vs rendered HTML check": "Provera originalnog i renderovanog HTML-a",
    "the server answered HTTP {0} to the request for the original HTML": "server je na zahtev za originalni HTML odgovorio sa HTTP {0}",
    "Page redirects instantly with a meta refresh": "Stranica odmah preusmerava pomoću meta refresh-a",
    "Page redirects with a meta refresh after {0} s": "Stranica preusmerava pomoću meta refresh-a posle {0} s",
    "HTTP header \"Refresh: {0}\"": "HTTP header \"Refresh: {0}\"",
    "Target: {0}": "Odredište: {0}",
    "Google treats an instant meta refresh (0 seconds) as a permanent redirect and a delayed one as a temporary redirect; a permanent server-side redirect is the better choice whenever the platform can do it, and meta refresh only where it can't.": "Google tretira trenutni meta refresh (0 sekundi) kao trajno preusmerenje, a odloženi kao privremeno; trajno preusmerenje na serveru je bolji izbor kad god platforma to podržava, a meta refresh samo kada ne podržava.",
    "Webflow can do server-side 301 redirects: Site settings > Publishing > 301 redirects — enter the old path and the new URL, then publish. Remove the meta refresh from {0}.": "Webflow podržava 301 preusmerenja na serveru: Site settings > Publishing > 301 redirects — unesi staru putanju i novi URL, zatim objavi. Ukloni meta refresh iz {0}.",
    "No meta refresh redirect on the page": "Na stranici nema meta refresh preusmerenja",
    "International (hreflang)": "Međunarodno (hreflang)",
    "hreflang tags are outside <head> ({0})": "hreflang tagovi su van <head> ({0})",
    "hreflang <link> tags count only inside a well-formed <head> of the HTML. {0}": "hreflang <link> tagovi važe samo unutar ispravnog <head> dela HTML-a. {0}",
    "Invalid hreflang value: {0}": "Neispravna hreflang vrednost: {0}",
    "The hreflang value must always specify a language code in ISO 639-1 format (e.g. \"en\", \"de\"), optionally followed by a region code in ISO 3166-1 alpha-2 format (e.g. \"en-GB\", \"es-mx\"), or be \"x-default\". A region alone (e.g. \"us\") is not valid, and \"en-UK\" is not valid because the ISO 3166-1 code of the United Kingdom is \"GB\".": "hreflang vrednost uvek mora da navede kod jezika u ISO 639-1 formatu (npr. \"en\", \"de\"), uz opcioni kod regiona u ISO 3166-1 alpha-2 formatu (npr. \"en-GB\", \"es-mx\"), ili da bude \"x-default\". Sam region (npr. \"us\") nije ispravan, a \"en-UK\" nije ispravan jer je ISO 3166-1 kod Ujedinjenog Kraljevstva \"GB\".",
    "Correct the language/region code. {0}": "Ispravi kod jezika/regiona. {0}",
    "hreflang URL is not fully qualified ({0})": "hreflang URL nije pun (apsolutni) URL ({0})",
    "Alternate URLs must be full URLs including https:// — \"https://example.com/foo\", not \"//example.com/foo\" or \"/foo\".": "Alternativni URL-ovi moraju biti puni URL-ovi sa https:// — \"https://example.com/foo\", a ne \"//example.com/foo\" ili \"/foo\".",
    "Use full URLs starting with https://. {0}": "Koristi pune URL-ove koji počinju sa https://. {0}",
    "This page is missing from its own hreflang set (no self-reference)": "Ova stranica nedostaje u sopstvenom hreflang skupu (nema samoreference)",
    "This page: {0}": "Ova stranica: {0}",
    "Each language version must list itself and all other language versions — one <link> per version, including itself.": "Svaka jezička verzija mora da navede sebe i sve ostale jezičke verzije — po jedan <link> za svaku verziju, uključujući sebe.",
    "No x-default hreflang": "Nema x-default hreflang-a",
    "x-default is used for any language not listed — useful on language/country selectors or auto-redirecting home pages. Recommended, not required.": "x-default se koristi za svaki jezik koji nije naveden — korisno na stranicama za izbor jezika/zemlje ili početnim stranicama sa automatskim preusmeravanjem. Preporučeno, nije obavezno.",
    "hreflang points to a page that does not load directly ({0})": "hreflang pokazuje na stranicu koja se ne učitava direktno ({0})",
    "{0} → {1} — HTTP {2}": "{0} → {1} — HTTP {2}",
    "{0} → {1} — redirects to {2}": "{0} → {1} — preusmerava na {2}",
    "The alternate version answers with an error or a redirect instead of the page itself, so the hreflang pair can't work.": "Alternativna verzija odgovara greškom ili preusmerenjem umesto same stranice, pa hreflang par ne može da radi.",
    "Point the hreflang to the final URL of each version. {0}": "Usmeri hreflang na krajnji URL svake verzije. {0}",
    "hreflang return link missing on {0} version(s)": "Nedostaje povratni hreflang link na verzijama: {0}",
    "If two pages don't point to each other, Google ignores their hreflang tags. Each version listed here has hreflang tags, or none, that don't point back to this page.": "Ako dve stranice ne pokazuju jedna na drugu, Google zanemaruje njihove hreflang tagove. Svaka ovde navedena verzija ima hreflang tagove (ili nema nijedan) koji ne pokazuju nazad na ovu stranicu.",
    "Every version must list all versions, including this page. {0}": "Svaka verzija mora da navede sve verzije, uključujući ovu stranicu. {0}",
    "hreflang points to a URL whose canonical is a different page ({0})": "hreflang pokazuje na URL čiji je canonical druga stranica ({0})",
    "The alternate version says another URL is its primary (canonical) version. hreflang should point to canonical URLs in the same language, otherwise the pair can't work.": "Alternativna verzija kaže da je neki drugi URL njena glavna (canonical) verzija. hreflang treba da pokazuje na canonical URL-ove na istom jeziku, inače par ne može da radi.",
    "Point the hreflang to the canonical URL of each version, or fix that version's canonical. {0}": "Usmeri hreflang na canonical URL svake verzije ili ispravi canonical te verzije. {0}",
    "{0} version(s) on another domain can't be read from the browser ({1})": "verzije na drugom domenu ({0}) ne mogu da se pročitaju iz browsera ({1})",
    "only the first {0} versions were checked": "provereno je samo prvih {0} verzija",
    "hreflang tags are valid ({0} versions) and the checked versions link back": "hreflang tagovi su ispravni ({0} verzija) i proverene verzije linkuju nazad",
    "hreflang return-link check (some versions)": "Provera povratnih hreflang linkova (neke verzije)",
    "Canonical tag is valid": "Canonical tag je ispravan",
    "Not blocked in robots.txt (Googlebot)": "Nije blokirana u robots.txt (Googlebot)",
    "Not blocked for AI search crawlers": "Nije blokirana za AI crawlere pretrage",
    "Original HTML matches the rendered page": "Originalni HTML odgovara renderovanoj stranici",
    "No meta refresh redirect": "Nema meta refresh preusmerenja",
    "hreflang tags": "hreflang tagovi",
    "Preliminary check": "Preliminarna provera",
    "Page was loaded via a redirect": "Stranica je učitana preko preusmeravanja",
    "The browser followed {0} redirect(s) before arriving at: {1}": "Browser je pratio preusmeravanja ({0}) pre dolaska na: {1}",
    "If this is unexpected, the results reflect the final page, not the URL you may have originally opened.": "Ako ovo nije očekivano, rezultati se odnose na krajnju stranicu, a ne na URL koji je možda prvobitno otvoren.",
    "Check whether the redirect is intentional.": "Proveri da li je preusmeravanje namerno.",
    "This is a Webflow staging link": "Ovo je Webflow staging link",
    "The domain {0} is a Webflow staging subdomain.": "Domen {0} je Webflow staging poddomen.",
    "Findings here do not affect the score, but it is recommended to also check the live domain before publishing.": "Nalazi ovde ne utiču na ocenu, ali se preporučuje da proveriš i live domen pre objavljivanja.",
    "Run the audit on the live domain once it is ready.": "Pokreni audit na live domenu kada bude spreman.",
    "Meta & head tags": "Meta & head tagovi",
    "Meta charset declaration is missing": "Meta charset deklaracija nedostaje",
    "There is no <meta charset=\"...\"> in the head.": "U head-u nema <meta charset=\"...\">.",
    "The character encoding must be declared: a <meta charset> within the first 1024 bytes of the HTML, a charset in the Content-Type HTTP header, or a byte-order mark. Without it, the browser doesn't know which character each byte represents and may show characters incorrectly.": "Kodiranje karaktera mora biti deklarisano: <meta charset> u prvih 1024 bajta HTML-a, charset u Content-Type HTTP zaglavlju ili byte-order mark. Bez toga browser ne zna koji karakter predstavlja koji bajt i može pogrešno prikazati karaktere.",
    "Webflow adds this automatically — check that custom code in the <head> hasn't accidentally removed or moved the tag.": "Webflow ovo dodaje automatski — proveri da custom kod u <head> nije slučajno uklonio ili premestio tag.",
    "Meta charset is not UTF-8": "Meta charset nije UTF-8",
    "Value found: \"{0}\".": "Pronađena vrednost: \"{0}\".",
    "HTML allows only UTF-8: the value of <meta charset> must be \"utf-8\".": "HTML dozvoljava samo UTF-8: vrednost <meta charset> mora biti \"utf-8\".",
    "Set the charset to UTF-8.": "Postavi charset na UTF-8.",
    "Meta charset is present and set to UTF-8": "Meta charset postoji i postavljen je na UTF-8",
    "More than one <title> tag in the head ({0})": "Više od jednog <title> taga u head-u ({0})",
    "A page may have only one <title>. Usually a second <title> was added in custom code next to the one Webflow outputs.": "Stranica sme da ima samo jedan <title>. Obično je drugi <title> dodat u custom code pored onog koji ispisuje Webflow.",
    "More than one meta description tag ({0})": "Više od jednog meta description taga ({0})",
    "A page may have only one meta description. Usually one comes from Page settings and another from custom code.": "Stranica sme da ima samo jedan meta description. Obično jedan dolazi iz Page settings, a drugi iz custom code-a.",
    "Remove all but one meta description tag.": "Ukloni sve meta description tagove osim jednog.",
    "Title tag is missing or empty": "Title tag nedostaje ili je prazan",
    "The <title> is empty.": "<title> je prazan.",
    "Google uses the <title> as the clickable headline of the result in search, and it is often the main thing people read before deciding to click.": "Google koristi <title> kao naslov rezultata u pretrazi na koji se klikće, i to je često glavno što ljudi pročitaju pre nego što kliknu.",
    "Title is too long ({0} characters)": "Title je predugačak (karaktera: {0})",
    "Title: \"{0}\"": "Title: \"{0}\"",
    "There is no hard limit on title length, but Google shortens the title in search results to fit the screen width. Keeping it under 60 characters keeps the whole title visible.": "Dužina naslova nije strogo ograničena, ali ga Google u rezultatima skraćuje da stane u širinu ekrana. Do 60 karaktera ceo naslov ostaje vidljiv.",
    "Shorten the title to 60 characters or fewer, with the most important words first.": "Skrati naslov na 60 karaktera ili manje, sa najvažnijim rečima na početku.",
    "Title is very short ({0} characters)": "Title je veoma kratak (karaktera: {0})",
    "A title under 30 characters usually doesn't describe the page well. (Google shortens titles by display width, not by character count.)": "Naslov kraći od 30 karaktera obično ne opisuje stranicu dovoljno. (Google skraćuje naslove po širini prikaza, ne po broju karaktera.)",
    "Expand the title to better describe the page content.": "Proširi title da bolje opisuje sadržaj stranice.",
    "Title looks like a placeholder": "Title izgleda kao placeholder",
    "This looks like a Webflow default value that hasn't been replaced.": "Ovo izgleda kao Webflow podrazumevana vrednost koja nije zamenjena.",
    "Set a real, descriptive title.": "Postavi pravi, opisni title.",
    "Title tag is present and of optimal length ({0} characters)": "Title tag postoji i optimalne je dužine (karaktera: {0})",
    "Meta description is missing": "Meta description nedostaje",
    "There is no meta description tag, or it is empty.": "Nema meta description taga, ili je prazan.",
    "Google sometimes shows the meta description as the text under the result in search; without one, that text is taken from the page content only.": "Google ponekad prikazuje meta description kao tekst ispod rezultata u pretrazi; bez njega se taj tekst uzima samo iz sadržaja stranice.",
    "Meta description is short ({0} characters)": "Meta description je kratak (karaktera: {0})",
    "A meta description under 70 characters usually doesn't describe the page well. Google often builds the snippet from the page content anyway, so this is a suggestion, not an error.": "Meta description kraći od 70 karaktera obično ne opisuje stranicu dovoljno. Google ionako često pravi opis iz sadržaja stranice, pa je ovo predlog, ne greška.",
    "Expand it to at least 70 characters so it describes the page.": "Proširi ga na najmanje 70 karaktera tako da opisuje stranicu.",
    "Meta description is too long ({0} characters)": "Meta description je predugačak (karaktera: {0})",
    "There is no hard limit on meta description length, but Google shortens the snippet to fit the screen width; over 155 characters the end is usually cut off.": "Dužina meta description-a nije strogo ograničena, ali Google skraćuje opis da stane u širinu ekrana; preko 155 karaktera kraj se obično odseče.",
    "Shorten it to 155 characters or fewer.": "Skrati ga na 155 karaktera ili manje.",
    "Meta description is present and of appropriate length ({0} characters)": "Meta description postoji i odgovarajuće je dužine (karaktera: {0})",
    "og:title is missing": "og:title nedostaje",
    "There is no Open Graph title tag.": "Nema Open Graph title taga.",
    "og:title is the title of the link preview on Facebook, LinkedIn and other platforms that read Open Graph tags; X also falls back to it when twitter:title is missing.": "og:title je naslov pregleda linka na Facebook-u, LinkedIn-u i drugim platformama koje čitaju Open Graph tagove; i X ga koristi kada nema twitter:title.",
    "og:title is present": "og:title postoji",
    "og:description is missing": "og:description nedostaje",
    "There is no Open Graph description tag.": "Nema Open Graph description taga.",
    "Without it, the link preview on social media has no description.": "Bez njega, pregled linka na društvenim mrežama nema opis.",
    "og:description is present": "og:description postoji",
    "og:image is missing": "og:image nedostaje",
    "There is no Open Graph image.": "Nema Open Graph slike.",
    "Links without an OG image look bare when shared on social media.": "Linkovi bez OG slike izgledaju prazno kada se dele na društvenim mrežama.",
    "og:image is present": "og:image postoji",
    "Twitter/X Card meta tag (twitter:card) is missing": "Twitter/X Card meta tag (twitter:card) nedostaje",
    "There is no <meta name=\"twitter:card\">.": "Nema <meta name=\"twitter:card\">.",
    "Without twitter:card, X can still show a preview from the Open Graph tags, but only as the small card, not the large-image card. twitter:card chooses the card type.": "Bez twitter:card X i dalje može da prikaže pregled iz Open Graph tagova, ali samo kao malu karticu, ne karticu sa velikom slikom. twitter:card bira tip kartice.",
    "Add <meta name=\"twitter:card\" content=\"summary_large_image\"> (and ideally twitter:title/twitter:image) via Custom Code in the head section.": "Dodaj <meta name=\"twitter:card\" content=\"summary_large_image\"> (i idealno twitter:title/twitter:image) preko Custom Code u head sekciji.",
    "Twitter/X Card meta tag is present ({0})": "Twitter/X Card meta tag postoji ({0})",
    "Canonical tag is missing": "Canonical tag nedostaje",
    "There is no <link rel=\"canonical\">.": "Nema <link rel=\"canonical\">.",
    "A canonical is not strictly required, but a canonical that points to the page itself is the recommended setup. Without it, Google decides on its own which URL is the main one.": "Canonical nije strogo obavezan, ali je preporučeno da postoji canonical koji pokazuje na samu stranicu. Bez njega Google sam odlučuje koji URL je glavni.",
    "Page is marked as noindex": "Stranica je označena kao noindex",
    "meta robots = \"{0}\"": "meta robots = \"{0}\"",
    "This page will not be indexed by Google as long as this remains in place.": "Google neće indeksirati ovu stranicu dok god ovo ostaje na snazi.",
    "Relevant to both SEO and AEO — to be shown as a source in Google's AI Overviews or AI Mode, a page must be indexed and allowed to show a snippet.": "Relevantno i za SEO i za AEO — da bi bila prikazana kao izvor u Google AI Overviews ili AI Mode, stranica mora biti indeksirana i smeti da prikaže opis (snippet).",
    "Relevant to both SEO and AEO — noindex tells Google not to show the page in search results.": "Relevantno i za SEO i za AEO — noindex govori Google-u da ne prikazuje stranicu u rezultatima pretrage.",
    "Page is not marked as noindex": "Stranica nije označena kao noindex",
    "Relevant to both SEO and AEO — the page is indexable and can appear in Google search.": "Relevantno i za SEO i za AEO — stranica može da se indeksira i da se pojavi u Google pretrazi.",
    "Robots directive blocks the content snippet (nosnippet/max-snippet:0)": "Robots direktiva blokira snippet sadržaja (nosnippet/max-snippet:0)",
    "nosnippet tells Google not to show a text snippet or video preview for this page, and the content is then not used as a direct source for AI Overviews and AI Mode (max-snippet:0 has the same effect on the text).": "nosnippet govori Google-u da ne prikazuje tekstualni opis ni video pregled ove stranice, a sadržaj se tada ne koristi kao direktan izvor za AI Overviews i AI Mode (max-snippet:0 ima isti efekat na tekst).",
    "Remove \"nosnippet\" and \"max-snippet:0\" from the meta robots tag, unless it's intentional (e.g. a page with sensitive content).": "Ukloni \"nosnippet\" i \"max-snippet:0\" iz meta robots taga, osim ako je namerno (npr. stranica sa osetljivim sadržajem).",
    "Relevant to both SEO and AEO — with nosnippet the content is not used as a direct source for AI Overviews and AI Mode.": "Relevantno i za SEO i za AEO — uz nosnippet sadržaj se ne koristi kao direktan izvor za AI Overviews i AI Mode.",
    "Relevant to both SEO and AEO — the Google result for this page is shown without a text snippet.": "Relevantno i za SEO i za AEO — Google rezultat za ovu stranicu se prikazuje bez tekstualnog opisa.",
    "Robots directive does not block the content snippet": "Robots direktiva ne blokira snippet sadržaja",
    "Relevant to both SEO and AEO — Google may show a snippet of this page and use its content in AI Overviews / AI Mode.": "Relevantno i za SEO i za AEO — Google može da prikaže opis ove stranice i koristi njen sadržaj u AI Overviews / AI Mode.",
    "Relevant to both SEO and AEO — the page can have a normal description/snippet in Google search results.": "Relevantno i za SEO i za AEO — stranica može imati normalan opis/snippet u Google rezultatima pretrage.",
    "lang attribute is missing on <html>": "lang atribut nedostaje na <html>",
    "<html> has no lang attribute.": "<html> nema lang atribut.",
    "Google doesn't use the lang attribute, but screen readers do: they read the text in the language set here, so it is an accessibility requirement. This is an accessibility issue, so it is listed as a note and does not affect the score.": "Google ne koristi lang atribut, ali ga koriste čitači ekrana: tekst čitaju na jeziku koji je ovde podešen, pa je to zahtev pristupačnosti. Ovo je pitanje pristupačnosti, pa je navedeno kao napomena i ne utiče na skor.",
    "lang attribute is present on <html> ({0})": "lang atribut postoji na <html> ({0})",
    "Viewport meta tag is missing": "Viewport meta tag nedostaje",
    "There is no <meta name=\"viewport\">.": "Nema <meta name=\"viewport\">.",
    "Without a viewport meta tag, phones render the page at desktop width and then shrink it, so the text is hard to read.": "Bez viewport meta taga telefoni prikazuju stranicu u desktop širini i onda je smanjuju, pa je tekst teško čitljiv.",
    "Webflow usually adds this automatically — check that custom code hasn't removed the tag.": "Webflow ovo obično dodaje automatski — proveri da custom kod nije uklonio tag.",
    "Viewport meta tag is present": "Viewport meta tag postoji",
    "Viewport prevents the user from zooming": "Viewport sprečava korisnika da zumira",
    "viewport = \"{0}\"": "viewport = \"{0}\"",
    "Blocking zoom (user-scalable=no or maximum-scale below 2) prevents people with low vision from enlarging the page on a phone; for accessibility, zooming to at least 200% must be possible. This is an accessibility issue, so it is listed as a note and does not affect the score.": "Blokiran zoom (user-scalable=no ili maximum-scale manji od 2) sprečava slabovide osobe da uvećaju stranicu na telefonu; zbog pristupačnosti mora biti moguće uvećanje bar na 200%. Ovo je pitanje pristupačnosti, pa je navedeno kao napomena i ne utiče na skor.",
    "Remove user-scalable=no from the viewport tag and remove maximum-scale (or set it to at least 2).": "Ukloni user-scalable=no iz viewport taga i ukloni maximum-scale (ili ga postavi na najmanje 2).",
    "Viewport allows the user to zoom the page": "Viewport dozvoljava korisniku da zumira stranicu",
    "og:image: {0}": "og:image: {0}",
    "OG image is in a format X does not list as supported ({0})": "OG slika je u formatu koji X ne navodi kao podržan ({0})",
    "X supports JPG, PNG, WEBP and GIF images in link previews; SVG is not supported and AVIF is not on its list, so the preview on X can end up without an image.": "X podržava JPG, PNG, WEBP i GIF slike u pregledu linka; SVG nije podržan, a AVIF nije na listi, pa pregled na X-u može ostati bez slike.",
    "Use a JPG or PNG (or WebP) image as the OG image: Pages panel > Page settings > Open Graph settings > Open Graph image.": "Koristi JPG ili PNG (ili WebP) sliku kao OG sliku: Pages panel > Page settings > Open Graph settings > Open Graph image.",
    "For a sharp preview, Facebook needs an image at least 600 px wide and ideally 1080 px or more; X's large-image card needs at least 300x157 px.": "Za oštar pregled Facebook-u treba slika široka najmanje 600 px, a idealno 1080 px ili više; X-ovoj kartici sa velikom slikom treba najmanje 300x157 px.",
    "Replace it in Pages panel > Page settings > Open Graph settings > Open Graph image with an image of at least 1200×630 px (ratio 1.91:1).": "Zameni je u Pages panel > Page settings > Open Graph settings > Open Graph image slikom od najmanje 1200×630 px (odnos 1.91:1).",
    "OG image is larger than X's 5 MB limit ({0})": "OG slika je veća od X-ovog ograničenja od 5 MB ({0})",
    "X doesn't show card images of 5 MB or more, so the preview on X can end up without an image.": "X ne prikazuje slike kartica od 5 MB ili više, pa pregled na X-u može ostati bez slike.",
    "Use a smaller file (compress it, or export it smaller while keeping it at least 1080 px wide) and set it again in Page settings > Open Graph settings.": "Koristi manji fajl (kompresuj ga ili ga izvezi manjim, ali da ostane širok najmanje 1080 px) i ponovo ga postavi u Page settings > Open Graph settings.",
    "Relevant to both SEO and AEO — important content has to be available as text for AI Overviews and AI Mode too.": "Relevantno i za SEO i za AEO — važan sadržaj mora biti dostupan kao tekst i za AI Overviews i AI Mode.",
    "Relevant to both SEO and AEO — search engines need descriptive text to understand what the page is about.": "Relevantno i za SEO i za AEO — pretraživačima treba opisni tekst da bi razumeli o čemu je stranica.",
    "CMS item slug ends with a number like \"-2\" ({0})": "Slug CMS stavke se završava brojem kao \"-2\" ({0})",
    "A duplicated Webflow CMS item gets a number at the end of its slug (\"-2\", \"-3\"...), so this item may be a copy whose slug was never renamed. If the number is part of the real name (e.g. \"episode-12\"), ignore this. Readable words in a URL are better than a number.": "Duplirana Webflow CMS stavka dobija broj na kraju slug-a (\"-2\", \"-3\"...), pa ova stavka može biti kopija kojoj slug nije preimenovan. Ako je broj deo pravog naziva (npr. \"episode-12\"), zanemari ovo. Čitljive reči u URL-u su bolje od broja.",
    "If it is a copy: rename the slug in the CMS item (Collection item > Slug field), or remove the duplicate item. If the old URL is already indexed, add a 301 redirect from it (Site settings > Publishing > 301 redirects).": "Ako je kopija: preimenuj slug u CMS stavci (Collection item > polje Slug) ili ukloni duplikat. Ako je stari URL već indeksiran, dodaj 301 preusmerenje sa njega (Site settings > Publishing > 301 redirects).",
    "CMS item slug does not end with a Webflow duplication suffix": "Slug CMS stavke se ne završava Webflow sufiksom dupliranja",
    "File: {0} → about {1} ({2}% smaller)": "Fajl: {0} → oko {1} ({2}% manje)",
    "Image can be compressed further (~{0} smaller as JPEG at quality 92)": "Slika može dodatno da se kompresuje (~{0} manje kao JPEG na kvalitetu 92)",
    "Re-saved as a JPEG at quality 92, this file would be that much smaller, with the same size on screen. Images are reported when the saving is 4 KB or more.": "Ponovo sačuvan kao JPEG na kvalitetu 92, ovaj fajl bi bio toliko manji, iste veličine na ekranu. Slike se prijavljuju kada je ušteda 4 KB ili više.",
    "Compress the image: in Webflow, Assets panel > the image's more options > Compress > WebP or AVIF (JPG/PNG only), or re-export it as JPEG at quality 85–92 and swap it via Assets panel > more options > Replace (the asset URL changes).": "Kompresuj sliku: u Webflow-u Assets panel > more options slike > Compress > WebP ili AVIF (samo JPG/PNG), ili je ponovo izvezi kao JPEG na kvalitetu 85–92 i zameni preko Assets panel > more options > Replace (URL asset-a se menja).",
    "PNG image would be ~{0} smaller as WebP": "PNG slika bi kao WebP bila ~{0} manja",
    "Converted to WebP (quality 85), this PNG would be that much smaller, with the same size on screen; WebP keeps transparency. Images are reported when the saving is 8 KB or more.": "Pretvoren u WebP (kvalitet 85), ovaj PNG bi bio toliko manji, iste veličine na ekranu; WebP čuva providnost. Slike se prijavljuju kada je ušteda 8 KB ili više.",
    "In Webflow: Assets panel > the image's more options > Compress > WebP or AVIF (works for PNG). Compression replaces the original file.": "U Webflow-u: Assets panel > more options slike > Compress > WebP ili AVIF (radi i za PNG). Kompresija zamenjuje originalni fajl.",
    "No image is larger than needed for its displayed size ({0} measured)": "Nijedna slika nije veća nego što treba za prikazanu veličinu (izmereno: {0})",
    "Image is larger than its displayed size ({0}px file shown at {1}px)": "Slika je veća od prikazane veličine (fajl {0}px prikazan na {1}px)",
    "The image's pixels are compared with the pixels of the box it is shown in, including the screen's pixel density. It is reported when the right-sized image would be more than 4 KB smaller (12 KB if the image already has responsive variants). Here the file is {0}×{1} px, but it is shown in a {2}×{3} px box on a screen with pixel density {4}, which uses about {5}×{6} px. The rest is downloaded but not shown (scaled down, or cropped when the box has a different shape). Measured at the current window width; the same rule also runs at phone and tablet widths.": "Pikseli slike se porede sa pikselima okvira u kom je prikazana, uz gustinu piksela ekrana. Prijavljuje se kada bi slika u pravoj veličini bila više od 4 KB manja (12 KB ako slika već ima responsive varijante). Ovde je fajl {0}×{1} px, a prikazan je u okviru od {2}×{3} px na ekranu gustine piksela {4}, što koristi oko {5}×{6} px. Ostatak se preuzima, a ne prikazuje (umanjen je, ili isečen kada okvir ima drugačiji oblik). Izmereno na trenutnoj širini prozora; isto pravilo se pokreće i na širini telefona i tableta.",
    "1) Find out why the full-size file is served. Webflow creates responsive variants (srcset) for uploaded inline JPG, PNG and WebP images, except those added via rich text elements, and not for background images; the \"Disable responsiveness\" checkbox in Image settings turns them off (Webflow's variants have \"-p-\" plus a width in the file name, e.g. \"-p-500\"). 2) If it is an Image element with responsiveness turned off: select it > Element settings panel > Image settings > uncheck \"Disable responsiveness\", then publish. 3) Otherwise replace the file: resize it to about {0}px wide (displayed width × pixel density) and compress it, then Assets panel > the image's more options > Replace (the asset URL changes, so update any direct links). 4) If the file already is a Webflow variant (\"-p-\" in the name) and the difference is small, there is little to gain — Webflow only makes fixed variant widths.": "1) Utvrdi zašto se servira fajl pune veličine. Webflow pravi responsive varijante (srcset) za otpremljene inline JPG, PNG i WebP slike, osim onih dodatih kroz rich text elemente, i ne prave se za pozadinske slike; polje \"Disable responsiveness\" u Image settings ih isključuje (Webflow varijante imaju \"-p-\" i širinu u imenu fajla, npr. \"-p-500\"). 2) Ako je u pitanju Image element sa isključenom responsivnošću: izaberi ga > Element settings panel > Image settings > odčekiraj \"Disable responsiveness\", pa objavi. 3) U suprotnom zameni fajl: smanji ga na širinu oko {0}px (prikazana širina × gustina piksela) i kompresuj, pa Assets panel > more options slike > Replace (URL asset-a se menja, pa ažuriraj direktne linkove). 4) Ako je fajl već Webflow varijanta (\"-p-\" u imenu) i razlika je mala, nema mnogo dobiti — Webflow pravi samo fiksne širine varijanti.",
    "OG image is too small ({0}x{1})": "OG slika je premala ({0}x{1})",
    "OG image fails to load": "OG slika se ne učitava",
    "og:image URL returns an error: {0}": "og:image URL vraća grešku: {0}",
    "A broken OG image means an empty preview on social media.": "Pokvarena OG slika znači prazan pregled na društvenim mrežama.",
    "Check that the URL is correct and that the file exists.": "Proveri da li je URL ispravan i da li fajl postoji.",
    "Favicon": "Favicon",
    "Favicon is missing or fails to load": "Favicon nedostaje ili se ne učitava",
    "A <link> tag was found, but the resource ({0}) does not load.": "Pronađen je <link> tag, ali se resurs ({0}) ne učitava.",
    "There is no <link rel=\"icon\"> in the head, and no fallback /favicon.ico exists either.": "U head-u nema <link rel=\"icon\">, a ne postoji ni fallback /favicon.ico.",
    "Google Search can show a site's favicon next to its search results; when it has no usable favicon, Google shows a generic icon instead.": "Google pretraga može da prikaže favicon sajta pored rezultata; kada nema upotrebljiv favicon, Google umesto njega prikazuje generičku ikonicu.",
    "Favicon is blocked in robots.txt": "Favicon je blokiran u robots.txt",
    "Favicon is present and loads successfully": "Favicon postoji i uspešno se učitava",
    "URL & page duplication": "URL & dupliranje stranica",
    "Canonical points to a different path on the same site": "Canonical pokazuje na drugu putanju na istom sajtu",
    "Current page: {0} | Canonical: {1}": "Trenutna stranica: {0} | Canonical: {1}",
    "The <link rel=\"canonical\"> is there, but its href is empty.": "<link rel=\"canonical\"> postoji, ali je njegov href prazan.",
    "Where:": "Gde:",
    "inside: {0}": "unutar: {0}",
    "hidden by: {0}": "sakriveno zbog: {0}",
    "the element itself (display:none)": "sam element (display:none)",
    "Canonical points to a different domain": "Canonical pokazuje na drugi domen",
    "The canonical tells Google that another website holds the main version of this page. rel=\"canonical\" is a strong signal to Google, so this page may be left out of the results in favour of that one. That is right for deliberately syndicated content, but wrong when it is a leftover from a template, a staging copy or another site.": "Canonical govori Google-u da druga veb-lokacija ima glavnu verziju ove stranice. rel=\"canonical\" je za Google jak signal, pa ova stranica može biti izostavljena iz rezultata u korist te druge. To je ispravno za namerno preuzet (syndicated) sadržaj, ali pogrešno kada je ostatak iz šablona, staging kopije ili drugog sajta.",
    "Canonical points to a different host or protocol version": "Canonical pokazuje na drugu verziju hosta ili protokola",
    "The canonical names the www / non-www or http / https variant that is not the one this page was opened on. rel=\"canonical\" is a strong signal to Google to prefer that other variant, which is only right if the site redirects to it.": "Canonical navodi www / non-www ili http / https varijantu koja nije ona na kojoj je stranica otvorena. rel=\"canonical\" je za Google jak signal da izabere tu drugu varijantu, što je ispravno samo ako sajt preusmerava na nju.",
    "This happens for example when a page is duplicated in Webflow and the canonical is left pointing at the original. rel=\"canonical\" is a strong signal to Google to prefer that other URL over this page.": "Ovo se dešava npr. kada se stranica duplira u Webflow-u, a canonical ostane da pokazuje na original. rel=\"canonical\" je za Google jak signal da izabere taj drugi URL umesto ove stranice.",
    "Canonical tag is present and points to this page": "Canonical tag postoji i pokazuje na ovu stranicu",
    "Canonical: {0}": "Canonical: {0}",
    "URL slug ends with \"-copy\" ({0})": "URL slug se završava sa \"-copy\" ({0})",
    "Path: {0}": "Putanja: {0}",
    "When a page is duplicated in Webflow it is named \"<name> Copy\" and gets the slug \"<slug>-copy\", so a published \"-copy\" URL is usually a duplicate whose slug was never renamed. Readable words in a URL are better.": "Kada se stranica duplira u Webflow-u, dobija ime \"<ime> Copy\" i slug \"<slug>-copy\", pa je objavljen \"-copy\" URL obično duplikat kome slug nije preimenovan. Čitljive reči u URL-u su bolje.",
    "URL slug does not end with Webflow's duplication suffix \"-copy\"": "URL slug se ne završava Webflow sufiksom dupliranja \"-copy\"",
    "Heading structure": "Struktura naslova",
    "H1 is missing on the page": "H1 nedostaje na stranici",
    "No visible H1 element was found.": "Nije pronađen nijedan vidljiv H1 element.",
    "The H1 is the main heading that says what the page is about; this page has none.": "H1 je glavni naslov koji kaže o čemu je stranica; ova stranica ga nema.",
    "Add exactly one H1 describing the page's main topic.": "Dodaj tačno jedan H1 koji opisuje glavnu temu stranice.",
    "There is more than one H1 on the page ({0} total)": "Na stranici ima više od jednog H1 (ukupno: {0})",
    "Extra H1: \"{0}\"": "Dodatni H1: \"{0}\"",
    "One H1 makes the main topic of the page unambiguous; here there are several.": "Jedan H1 jasno određuje glavnu temu stranice; ovde ih ima više.",
    "Keep only one H1, change the others to H2/H3 as needed.": "Zadrži samo jedan H1, ostale po potrebi promeni u H2/H3.",
    "Exactly one H1 found on the page": "Na stranici je pronađen tačno jedan H1",
    "Heading hierarchy skips a level (H{0} → H{1})": "Hijerarhija naslova preskače nivo (H{0} → H{1})",
    "Skipping heading levels (e.g. H2 straight to H4) breaks the page outline for readers and screen readers. It doesn't affect Google rankings. This is an accessibility issue, so it is listed as a note and does not affect the score.": "Preskakanje nivoa naslova (npr. H2 pa odmah H4) kvari strukturu stranice za čitaoce i čitače ekrana. Ne utiče na rangiranje u Google-u. Ovo je pitanje pristupačnosti, pa je navedeno kao napomena i ne utiče na skor.",
    "Use heading levels in order, without skipping.": "Koristi nivoe naslova redom, bez preskakanja.",
    "Heading hierarchy has no skipped levels": "Hijerarhija naslova nema preskočenih nivoa",
    "{0} heading elements on the page.": "Elemenata naslova na stranici: {0}.",
    "Text looks like a heading but isn't marked up as one": "Tekst izgleda kao naslov, ali nije označen kao naslov",
    "\"{0}\" (font-size: {1}px)": "\"{0}\" (font-size: {1}px)",
    "Text that looks like a heading but isn't marked up as one is not announced as a heading by screen readers, so the page structure is lost for them.": "Tekst koji izgleda kao naslov, a nije označen kao naslov, čitači ekrana ne najavljuju kao naslov, pa za njih struktura stranice nestaje.",
    "If this is actually a section title, mark it up with the appropriate heading tag (H2/H3...).": "Ako je ovo zapravo naslov sekcije, označi ga odgovarajućim tagom za naslov (H2/H3...).",
    "Images": "Slike",
    "Image: alt attribute is missing": "Slika: nedostaje alt atribut",
    "Image: generic alt text (\"{0}\")": "Slika: generički alt tekst (\"{0}\")",
    "Alt text describes the image to people who can't see it (screen readers) and helps Google understand what the image shows. An <img> without alt gives neither.": "Alt tekst opisuje sliku ljudima koji je ne vide (čitači ekrana) i pomaže Google-u da razume šta slika prikazuje. <img> bez alt-a ne daje ni jedno ni drugo.",
    "Image has no fixed height (neither HTML attribute nor CSS)": "Slika nema fiksnu visinu (ni HTML atribut ni CSS)",
    "CSS width: {0} | CSS height: {1}": "CSS width: {0} | CSS height: {1}",
    "The height is a percentage, but no parent (up to 5 levels checked) has a fixed height, aspect-ratio or min-height, so nothing reserves the space.": "Visina je u procentima, ali nijedan roditeljski element (provereno do 5 nivoa) nema fiksnu visinu, aspect-ratio ili min-height, pa ništa ne rezerviše prostor.",
    "Checked the image and up to 5 parent elements for a fixed height, aspect-ratio, min-height or padding-bottom ratio box — none found.": "Provereni su slika i do 5 roditeljskih elemenata za fiksnu visinu, aspect-ratio, min-height ili padding-bottom ratio box — ništa nije pronađeno.",
    "CSS width: {0} | CSS height: not found/defined": "CSS width: {0} | CSS height: nije pronađena/definisana",
    "CSS width: not found/defined | CSS height: {0}": "CSS width: nije pronađena/definisana | CSS height: {0}",
    "CSS width: not found/defined | CSS height: not found/defined": "CSS width: nije pronađena/definisana | CSS height: nije pronađena/definisana",
    "Neither the HTML height attribute nor CSS fixes the height (the value is \"auto\" or not defined at all) — the browser can't reserve vertical space for the image in advance, which causes layout shift (CLS) while the image loads. CLS is a Core Web Vital (good is below 0.1). Width isn't a factor here — a fixed width alone doesn't reserve vertical space.": "Ni HTML atribut height ni CSS ne fiksiraju visinu (vrednost je \"auto\" ili nije definisana) — browser ne može unapred da rezerviše vertikalni prostor za sliku, pa se sadržaj pomera (CLS) dok se slika učitava. CLS je Core Web Vital (dobro je ispod 0.1). Širina ovde nije bitna — fiksna širina sama ne rezerviše vertikalni prostor.",
    "Add an explicit height (an HTML height attribute, or CSS height in any unit — px, rem, vw...) directly on the <img> tag or in the Style panel. Width can stay auto.": "Dodaj eksplicitnu visinu (HTML height atribut ili CSS height u bilo kojoj jedinici — px, rem, vw...) direktno na <img> tag ili u Style panel. Širina može ostati auto.",
    "Image below the fold is not lazy-loaded": "Slika ispod preloma stranice nije lazy-loaded",
    "Images far below the first screen are downloaded immediately instead of when the visitor scrolls near them, competing with the content that matters for the first view (LCP).": "Slike daleko ispod prvog ekrana se preuzimaju odmah, umesto kada posetilac skroluje blizu njih, i takmiče se sa sadržajem koji je važan za prvi prikaz (LCP).",
    "Image is hosted on an external server": "Slika je hostovana na spoljnom serveru",
    "If that external server/project goes offline (a common case with WordPress or other migration leftovers), the image disappears from the page. File size isn't measured here since the server is outside our control.": "Ako taj spoljni server/projekat prestane da radi (čest slučaj kod ostataka migracije sa WordPress-a ili drugih platformi), slika nestaje sa stranice. Veličina fajla se ovde ne meri jer je server van naše kontrole.",
    "Image is not in a modern format (currently: {0})": "Slika nije u modernom formatu (trenutno: {0})",
    "AVIF/WebP produce a significantly smaller file size at the same quality, which speeds up page loading.": "AVIF/WebP daju znatno manju veličinu fajla pri istom kvalitetu, što ubrzava učitavanje stranice.",
    "Image is larger than 500KB ({0})": "Slika je veća od 500KB ({0})",
    "Images should stay under 500 KB; this one is larger. A large file takes longer to download; when it is the main image of the first view it delays the Largest Contentful Paint (LCP, a Core Web Vital). The file size is measured (content-length header), not guessed.": "Slike treba da budu ispod 500 KB; ova je veća. Veliki fajl se duže preuzima; kada je to glavna slika prvog ekrana, odlaže Largest Contentful Paint (LCP, Core Web Vital). Veličina fajla je izmerena (content-length zaglavlje), ne procenjena.",
    "Compress the image (e.g. TinyPNG/Squoosh) or convert it to WebP/AVIF.": "Kompresuj sliku (npr. TinyPNG/Squoosh) ili je konvertuj u WebP/AVIF.",
    "File size: {0} · estimated wasted: ~{1}": "Veličina fajla: {0} · procenjeno uzaludno: ~{1}",
    "All {0} below-the-fold images are lazy-loaded": "Svih {0} slika ispod preloma je lazy-loaded",
    "Above-the-fold images are lazy-loaded ({0})": "Slike iznad preloma se učitavaju lazy ({0})",
    "+{0} more": "+{0} još",
    "These images are visible in the first screen, but loading=\"lazy\" makes the browser fetch them later than it could: it first has to lay out the page and work out which images are on screen. That delays the first view (and the Largest Contentful Paint, a Core Web Vital, when one of them is the main image) and makes the images pop in. Lazy loading is meant for images far below the first screen. The first screen is measured at the current window width, so on a phone a different set of images can be above the fold.": "Ove slike su vidljive na prvom ekranu, ali ih loading=\"lazy\" tera pregledač da preuzme kasnije nego što bi mogao: prvo mora da izračuna raspored stranice i utvrdi koje slike su na ekranu. To odlaže prvi prikaz (i Largest Contentful Paint, Core Web Vital, kada je jedna od njih glavna slika) i slike se pojavljuju naknadno. Lazy učitavanje je namenjeno slikama daleko ispod prvog ekrana. Prvi ekran se meri na trenutnoj širini prozora, pa na telefonu drugi skup slika može biti iznad preloma.",
    "None of the {0} images in the first screen is lazy-loaded": "Nijedna od {0} slika na prvom ekranu nije lazy-loaded",
    "Above-the-fold video has no poster image": "Video iznad preloma nema poster sliku",
    "A large video at the top of the page shows an empty box until enough of the file has downloaded. For a <video>, LCP counts whichever comes first — the poster image or the first video frame — so a poster can make the first view and the Largest Contentful Paint (LCP, a Core Web Vital) earlier. Without it, how the video area looks while loading is left to the browser.": "Veliki video na vrhu stranice prikazuje prazan okvir dok se ne preuzme dovoljno fajla. Za <video> LCP računa ono što se pojavi prvo — poster sliku ili prvi kadar videa — pa poster može da ubrza prvi prikaz i Largest Contentful Paint (LCP, Core Web Vital). Bez njega je izgled video oblasti tokom učitavanja prepušten browser-u.",
    "The above-the-fold video has a poster image": "Video iznad preloma ima poster sliku",
    "Forms": "Forme",
    "Form field has no accessible label": "Polje forme nema pristupačnu labelu",
    "placeholder: \"{0}\"": "placeholder: \"{0}\"",
    "A placeholder disappears as soon as the visitor starts typing and is not a reliable accessible name, so screen readers and voice control may announce the field with no name at all. A <label> (or aria-label) is the standard fix. This is mainly an accessibility and usability issue — it has no direct ranking effect. This is an accessibility issue, so it is listed as a note and does not affect the score.": "Placeholder nestaje čim posetilac počne da kuca i nije pouzdano pristupačno ime, pa čitači ekrana i glasovna kontrola mogu da najave polje bez ikakvog imena. <label> (ili aria-label) je standardno rešenje. Ovo je pre svega pitanje pristupačnosti i upotrebljivosti — nema direktan uticaj na rangiranje. Ovo je pitanje pristupačnosti, pa je navedeno kao napomena i ne utiče na skor.",
    "All {0} form field(s) have a label": "Sva polja forme ({0}) imaju labelu",
    "Organization schema has no sameAs (links to the official profiles)": "Organization schema nema sameAs (linkove ka zvaničnim profilima)",
    "Profiles linked on this page: {0}": "Profili povezani na ovoj stranici: {0}",
    "sameAs lists the official profiles of the business (LinkedIn, X, YouTube, Crunchbase, Clutch...), which helps Google understand the organization and tell it apart from others in search results.": "sameAs navodi zvanične profile firme (LinkedIn, X, YouTube, Crunchbase, Clutch...), što pomaže Google-u da razume organizaciju i razlikuje je od drugih u rezultatima pretrage.",
    "Organization schema sameAs does not include the social profiles linked on this page": "Organization schema sameAs ne uključuje društvene profile povezane na ovoj stranici",
    "Missing: {0}": "Nedostaje: {0}",
    "The page links to these profiles, but the Organization schema does not list them in sameAs, so the markup doesn't connect the business to them.": "Stranica linkuje ove profile, ali ih Organization schema ne navodi u sameAs, pa markup ne povezuje firmu sa njima.",
    "Add the full profile URLs (the same ones the page links to) to the sameAs array of the Organization JSON-LD block.": "Dodaj pune URL-ove profila (iste na koje stranica linkuje) u sameAs niz Organization JSON-LD bloka.",
    "Organization schema lists its official profiles (sameAs: {0})": "Organization schema navodi zvanične profile (sameAs: {0})",
    "Home page has no Organization schema": "Početna stranica nema Organization schema",
    "Organization markup on the home page helps Google understand the organization's details and tell it apart from others in search results, and can influence which logo is shown in search results and the knowledge panel. No property is required.": "Organization markup na početnoj stranici pomaže Google-u da razume podatke o organizaciji i razlikuje je od drugih u rezultatima pretrage, a može da utiče i na to koji logo se prikazuje u rezultatima i knowledge panelu. Nijedno svojstvo nije obavezno.",
    "Image compression (JPEG re-encode, PNG to WebP)": "Kompresija slike (ponovno JPEG kodiranje, PNG u WebP)",
    "Above-the-fold images not lazy-loaded": "Slike iznad preloma nisu lazy",
    "Above-the-fold video poster": "Poster videa iznad preloma",
    "Form field labels": "Labele polja forme",
    "Organization schema profiles (sameAs)": "Profili u Organization schema (sameAs)",
    "Found only on: {0}. It does not appear on the other devices that were checked.": "Pronađeno samo na: {0}. Ne pojavljuje se na ostalim proverenim uređajima.",
    "This element is inside a {0} that is closed when the page loads. The audit still checks it — click the row to locate it.": "Ovaj element je unutar zatvorenog elementa ({0}) koji nije otvoren pri učitavanju stranice. Audit ga ipak proverava — klikni na red da ga pronađeš.",
    "Mobile (narrower than 768px)": "Mobilni (uži od 768px)",
    "Tablet (768-991px)": "Tablet (768-991px)",
    "Desktop (992px and wider)": "Desktop (992px i šire)",
    "tab": "tab",
    "accordion / collapsible block": "accordion / sklopivi blok",
    "dropdown": "dropdown",
    "collapsed menu": "sklopljeni meni",
    "slider": "slider",
    "popup / modal": "popup / modal",
    "only on: {0}": "samo na: {0}",
    "in closed UI: {0}": "u zatvorenom UI elementu: {0}",
    "Checking the mobile, tablet and desktop layouts in the background…": "Proveravam mobilni, tablet i desktop prikaz u pozadini…",
    "Checked on:": "Provereno na:",
    "this window, {0}px": "ovaj prozor, {0}px",
    "Mobile": "Mobilni",
    "Tablet": "Tablet",
    "Desktop": "Desktop",
    "Could not check {0}: {1}.": "Nije moguće proveriti {0}: {1}.",
    "it took too long": "trajalo je predugo",
    "the page cannot be opened in a hidden frame (X-Frame-Options / CSP)": "stranica ne dozvoljava otvaranje u skrivenom okviru (X-Frame-Options / CSP)",
    "the frame stayed empty": "okvir je ostao prazan",
    "an error occurred": "došlo je do greške",
    "Results for the devices that could not be checked are missing.": "Rezultati za uređaje koji nisu mogli da se provere nedostaju.",
    "Measuring performance (server response, LCP, layout shift)…": "Merim performanse (odziv servera, LCP, pomeranje rasporeda)…",
    "Checking the mobile, tablet and desktop layouts ({0} of {1} done)…": "Proveravam mobilni, tablet i desktop prikaz ({0} od {1} gotovo)…",
    "Finishing the network checks (images, links)…": "Završavam mrežne provere (slike, linkovi)…",
    "Running the page checks…": "Pokrećem provere stranice…",
    "Analysis in progress — please wait…": "Analiza je u toku — sačekaj…",
    "The score and the list below may still change until this is done.": "Skor i lista ispod se još mogu promeniti dok ovo traje.",
    "the frame could not be read": "okvir nije mogao da se pročita",
    "the page copy could not be created": "kopija stranice nije mogla da se napravi",
    "Mobile landscape": "Mobilni (landscape)",
    "{0} of {1} visible images have descriptive alt text": "{0} od {1} vidljivih slika ima opisni alt tekst",
    "{0} images with an empty alt=\"\" are not counted in the score": "{0} slika sa praznim alt=\"\" ne ulazi u skor",
    "{0} image(s) have both dimensions fixed (HTML attribute or CSS, any unit)": "Slika sa obe fiksne dimenzije (HTML atribut ili CSS, bilo koja jedinica): {0}",
    "{0} image(s) have a fixed height (width is auto — safe, does not cause CLS)": "Slika sa fiksnom visinom (širina je auto — bezbedno, ne izaziva CLS): {0}",
    "A fixed height alone reserves vertical space regardless of the width, which is enough to prevent layout shift.": "Sama fiksna visina rezerviše vertikalni prostor bez obzira na širinu, što je dovoljno da se spreči pomeranje rasporeda.",
    "{0} image(s) have no height of their own, but a wrapper reserves the space (safe, does not cause CLS)": "Slika bez sopstvene visine, ali wrapper rezerviše prostor (bezbedno, ne izaziva CLS): {0}",
    "A parent element with a fixed height, an aspect-ratio, a min-height or a padding-bottom ratio box keeps its size while the image loads, so the content below does not shift.": "Roditeljski element sa fiksnom visinom, aspect-ratio, min-height ili padding-bottom ratio box zadržava veličinu dok se slika učitava, pa se sadržaj ispod ne pomera.",
    "All images are hosted on the same domain/Webflow Assets (no external hosts)": "Sve slike su hostovane na istom domenu/Webflow Assets (nema spoljnih hostova)",
    "{0} image(s) are already in a modern format (WebP/AVIF)": "Slika već u modernom formatu (WebP/AVIF): {0}",
    "Technical / crawlability": "Tehničko / indeksiranje",
    "{0} could not be completed": "{0} nije mogla da se završi",
    "Reason: {0}": "Razlog: {0}",
    "Reason: unknown": "Razlog: nepoznat",
    "This check has to request a file from the same site, and that request could not be completed — so the result is unknown. This is NOT a pass and NOT a failure, and it does not affect the score.": "Ova provera mora da zatraži fajl sa istog sajta, a taj zahtev nije mogao da se završi — pa je rezultat nepoznat. Ovo NIJE prolaz niti greška i ne utiče na ocenu.",
    "Nothing to fix on the page. If you need this result, check it manually: open the file in the browser (e.g. /sitemap.xml) or inspect the response headers in DevTools > Network.": "Na stranici nema šta da se ispravi. Ako ti je ovaj rezultat potreban, proveri ručno: otvori fajl u pregledaču (npr. /sitemap.xml) ili pregledaj response headers u DevTools > Network.",
    "X-Robots-Tag header blocks indexing": "X-Robots-Tag header blokira indeksiranje",
    "X-Robots-Tag: {0}": "X-Robots-Tag: {0}",
    "The server sends an HTTP header that tells search engines not to index this page. It is invisible in the page's HTML and in the Designer, and it overrides what the page itself says.": "Server šalje HTTP header koji govori pretraživačima da ne indeksiraju ovu stranicu. Nevidljiv je u HTML-u stranice i u Designer-u, i nadjačava ono što sama stranica kaže.",
    "Find where the header is set — it is not part of the Webflow project itself: a reverse proxy, Cloudflare rule, or hosting/CDN configuration.": "Pronađi gde je header postavljen — nije deo samog Webflow projekta: reverse proxy, Cloudflare pravilo ili konfiguracija hostinga/CDN-a.",
    "Needs access to whoever manages the reverse proxy / CDN / hosting in front of the site (e.g. Cloudflare Transform Rules). It can't be changed in the Webflow Designer.": "Potreban je pristup onome ko upravlja reverse proxy-jem / CDN-om / hostingom ispred sajta (npr. Cloudflare Transform Rules). Ne može se promeniti u Webflow Designer-u.",
    "X-Robots-Tag header restricts snippets": "X-Robots-Tag header ograničava snippete",
    "The server tells search engines not to show a text snippet for this page; the content is then also not used as a direct source for AI Overviews and AI Mode.": "Server govori pretraživačima da ne prikazuju tekstualni opis ove stranice; sadržaj se tada ne koristi ni kao direktan izvor za AI Overviews i AI Mode.",
    "Find where the header is set (reverse proxy / Cloudflare rule / hosting) and remove the snippet restriction if it is unintended.": "Pronađi gde je header postavljen (reverse proxy / Cloudflare pravilo / hosting) i ukloni ograničenje snippeta ako nije namerno.",
    "Needs access to whoever manages the reverse proxy / CDN / hosting in front of the site.": "Potreban je pristup onome ko upravlja reverse proxy-jem / CDN-om / hostingom ispred sajta.",
    "No X-Robots-Tag header restricts indexing (header: {0})": "Nijedan X-Robots-Tag header ne ograničava indeksiranje (header: {0})",
    "No X-Robots-Tag header restricts indexing": "Nijedan X-Robots-Tag header ne ograničava indeksiranje",
    "This page is listed in sitemap.xml": "Ova stranica je navedena u sitemap.xml",
    "This page is not listed in sitemap.xml": "Ova stranica nije navedena u sitemap.xml",
    "Checked {0}/sitemap.xml ({1} URLs)": "Provereno: {0}/sitemap.xml ({1} URL-ova)",
    "A sitemap tells search engines which pages you consider important and helps them crawl the site more efficiently. A page missing from it can still be found through links. This looks intentional here (the page is noindex or its canonical points elsewhere).": "Sitemap govori pretraživačima koje stranice smatraš važnim i pomaže im da efikasnije pretražuju sajt. Stranica koje nema u njemu i dalje može biti pronađena preko linkova.",
    "A sitemap tells search engines which pages you consider important and helps them crawl the site more efficiently. A page missing from it can still be found through links.": "Sitemap govori pretraživačima koje stranice smatraš važnim i pomaže im da efikasnije pretražuju sajt. Stranica koje nema u njemu i dalje može biti pronađena preko linkova.",
    "Links": "Linkovi",
    "Link doesn't go anywhere (href=\"{0}\")": "Link ne vodi nigde (href=\"{0}\")",
    "Link doesn't go anywhere (href=\"\")": "Link ne vodi nigde (href=\"\")",
    "This element is hidden right now (e.g. inside a closed tab, accordion or menu, or hidden at this screen width) — open it or resize the window to see it.": "Ovaj element je trenutno skriven (npr. u zatvorenom tabu, accordionu ili meniju, ili je skriven na ovoj širini ekrana) — otvori ga ili promeni veličinu prozora da ga vidiš.",
    "This link sits inside a collapsed menu (e.g. the mobile menu or a dropdown), so it is hidden until the menu is opened — but visitors still reach it with one click. With an empty href the click leads nowhere (with target=\"_blank\" it just opens a new tab of the same page). This is typical for social icons or menu items whose real URL was never filled in.": "Ovaj link se nalazi u sklopljenom meniju (npr. mobilni meni ili dropdown), pa je skriven dok se meni ne otvori — ali posetioci do njega stižu jednim klikom. Sa praznim href-om klik ne vodi nigde (uz target=\"_blank\" samo otvori novi tab iste stranice). Tipično za social ikonice ili stavke menija kojima pravi URL nikad nije upisan.",
    "Fill in the real URL (Webflow Designer: select the link > Settings panel > Link settings > URL) and publish. If the destination does not exist yet, remove the link until it does. The menu is collapsed at the current window width — open it (or widen the window) to find the element.": "Upiši pravi URL (Webflow Designer: selektuj link > Settings panel > Link settings > URL) i objavi sajt. Ako odredište još ne postoji, ukloni link dok ne bude gotovo. Meni je sklopljen pri trenutnoj širini prozora — otvori ga (ili proširi prozor) da pronađeš element.",
    "If this represents a tab/accordion that only changes the display on the same page, the correct approach per the WAI-ARIA Tabs pattern is a <button> with role=\"tab\", not an <a> link — a link semantically implies navigation.": "Ako ovo predstavlja tab/accordion koji samo menja prikaz na istoj stranici, ispravan pristup prema WAI-ARIA Tabs obrascu je <button> sa role=\"tab\", a ne <a> link — link semantički podrazumeva navigaciju.",
    "If the element doesn't navigate anywhere, change it to a <button> (or add role=\"tab\"/role=\"button\" plus the corresponding ARIA attributes). In Webflow, a link used only as an interaction trigger (e.g. closing a popup) is a very common pattern — if that is what this is, it is a minor note rather than a real problem.": "Ako element ne vodi nigde, promeni ga u <button> (ili dodaj role=\"tab\"/role=\"button\" plus odgovarajuće ARIA atribute). U Webflow-u je link korišćen samo kao okidač interakcije (npr. zatvaranje popup-a) veoma čest obrazac — ako je ovo to, reč je o maloj napomeni, a ne pravom problemu.",
    "Anchor link points to an ID that doesn't exist (#{0})": "Anchor link pokazuje na ID koji ne postoji (#{0})",
    "Clicking this link won't do anything since no element with that ID exists on the page.": "Klik na ovaj link neće ništa uraditi jer na stranici ne postoji element sa tim ID-jem.",
    "Check whether the target element was renamed or removed, and fix the href or ID.": "Proveri da li je ciljni element preimenovan ili uklonjen i ispravi href ili ID.",
    "Link with no text (and no image/icon/aria-label)": "Link bez teksta (i bez slike/ikone/aria-label)",
    "(no href)": "(nema href)",
    "An empty link carries zero context for the user and for the crawler.": "Prazan link ne nosi nikakav kontekst ni za korisnika ni za pretraživač.",
    "Add visible text or an aria-label.": "Dodaj vidljiv tekst ili aria-label.",
    "Generic anchor text: \"{0}\"": "Generički anchor tekst: \"{0}\"",
    "href: {0}": "href: {0}",
    "Generic link text such as \"click here\" or \"learn more\" says nothing about the target page; descriptive link text tells users and Google what the linked page is about.": "Generički tekst linka kao \"click here\" ili \"learn more\" ne govori ništa o odredišnoj stranici; opisni tekst linka govori korisnicima i Google-u o čemu je ta stranica.",
    "Replace it with descriptive text (e.g. \"View pricing\" instead of \"click here\").": "Zameni ga opisnim tekstom (npr. \"View pricing\" umesto \"click here\").",
    "There are no links that go nowhere (all href attributes are valid)": "Nema linkova koji ne vode nigde (svi href atributi su ispravni)",
    "All in-page anchor links (#id) point to existing elements": "Svi anchor linkovi na stranici (#id) pokazuju na postojeće elemente",
    "All links have visible text or an image": "Svi linkovi imaju vidljiv tekst ili sliku",
    "All checked internal links ({0}) return a successful response with no 404/redirect": "Svi provereni interni linkovi ({0}) vraćaju uspešan odgovor bez 404/redirect-a",
    "Internal link leads to a 404 page": "Interni link vodi na 404 stranicu",
    "A broken internal link hurts both user experience and crawl efficiency.": "Pokvaren interni link šteti i korisničkom iskustvu i efikasnosti indeksiranja.",
    "Fix the link, or restore/rename the target page.": "Ispravi link ili vrati/preimenuj ciljnu stranicu.",
    "Internal link goes through a redirect": "Interni link prolazi kroz redirect",
    "It isn't broken, but every visit through this link costs an extra request before the page loads.": "Nije pokvaren, ali svaki prelazak preko ovog linka košta dodatni zahtev pre nego što se stranica učita.",
    "If possible, update the link to point directly to the final URL.": "Ako je moguće, ažuriraj link da pokazuje direktno na krajnji URL.",
    "In Webflow you can only point the link straight at the final URL. If the redirect itself is configured at the reverse proxy / Cloudflare / app level (e.g. www → app subdomain), removing it needs access to that platform.": "U Webflow-u link možeš usmeriti samo direktno na krajnji URL. Ako je sam redirect podešen na nivou reverse proxy-ja / Cloudflare-a / aplikacije (npr. www → app subdomen), za njegovo uklanjanje je potreban pristup toj platformi.",
    "Content": "Sadržaj",
    "Very little visible text on the page ({0} characters)": "Veoma malo vidljivog teksta na stranici ({0} karaktera)",
    "There is no minimum word count, but search engines need descriptive text to understand a page. This page has under 200 characters of visible text, so it is nearly empty.": "Ne postoji minimalan broj reči, ali pretraživačima treba opisni tekst da bi razumeli stranicu. Ova stranica ima manje od 200 karaktera vidljivog teksta, pa je skoro prazna.",
    "Add more relevant, useful content.": "Dodaj više relevantnog, korisnog sadržaja.",
    "The page has enough visible text ({0} characters)": "Stranica ima dovoljno vidljivog teksta ({0} karaktera)",
    "Hidden content with a substantial amount of text ({0} block, display:none/visibility:hidden)": "Skriveni sadržaj sa velikom količinom teksta (blokova: {0}, display:none/visibility:hidden)",
    "Hidden content with a substantial amount of text ({0} blocks, display:none/visibility:hidden)": "Skriveni sadržaj sa velikom količinom teksta (blokova: {0}, display:none/visibility:hidden)",
    "First {0}:": "Prvih {0}:",
    "Google's spam policies define hidden text as content placed \"solely to manipulate search engines and not to be easily viewable by human visitors\"; tabs, accordions and sliders are explicitly allowed. A forgotten hidden block is not spam, but it is content visitors can't see. Menus, popups, tabs, accordions and sliders are ignored here, since they are hidden by design.": "Google-ova pravila protiv spama definišu skriveni tekst kao sadržaj postavljen \"solely to manipulate search engines and not to be easily viewable by human visitors\"; tabovi, accordion-i i slajderi su izričito dozvoljeni. Zaboravljen skriveni blok nije spam, ali je sadržaj koji posetioci ne vide. Meniji, popup-i, tabovi, accordion-i i slajderi se ovde ne računaju, jer su skriveni po dizajnu.",
    "Check whether this content should be visible, or remove it if it's leftover from development.": "Proveri da li ovaj sadržaj treba da bude vidljiv, ili ga ukloni ako je ostatak razvoja.",
    "Repeated word in a row: \"{0} {1}\"": "Ponovljena reč zaredom: \"{0} {1}\"",
    "Most often a copy-paste mistake.": "Najčešće greška pri copy-paste-u.",
    "Remove the duplicate word.": "Ukloni duplu reč.",
    "No repeated words in a row (copy-paste mistake)": "Nema ponovljenih reči zaredom (greška pri copy-paste-u)",
    "Placeholder/Lorem ipsum text found on the page": "Pronađen placeholder/Lorem ipsum tekst na stranici",
    "A common case is when a CMS Rich Text element isn't properly bound to the real data, so the default value is left in place.": "Čest slučaj je kada CMS Rich Text element nije pravilno povezan sa stvarnim podacima, pa ostaje podrazumevana vrednost.",
    "Replace the placeholder text with real content before publishing.": "Zameni placeholder tekst pravim sadržajem pre objavljivanja.",
    "No placeholder/Lorem ipsum text on the page": "Nema placeholder/Lorem ipsum teksta na stranici",
    "Fonts": "Fontovi",
    "The page uses {0} different web fonts: {1}": "Stranica koristi različite web fontove ({0}): {1}",
    "Each extra font is more to download before the text shows in it, so fewer web fonts are better. There is no exact limit, so this is a note only and does not affect the score.": "Svaki dodatni font je još preuzimanja pre nego što se tekst prikaže u njemu, pa je bolje imati manje web fontova. Tačna granica ne postoji, pa je ovo samo napomena i ne utiče na skor.",
    "If the design allows, use fewer font families, or a variable font (one file can replace several weights, e.g. light, regular and bold).": "Ako dizajn dozvoljava, koristi manje porodica fontova ili variable font (jedan fajl može da zameni više debljina, npr. light, regular i bold).",
    "The page uses {0} web fonts: {1}": "Web fontova na stranici: {0} ({1})",
    "Informational only — doesn't affect the SEO score, but worth being aware of.": "Samo informativno — ne utiče na SEO skor, ali vredi znati.",
    "The page uses only 1 web font ({0}) — minimal risk of FOUT/FOIT": "Stranica koristi samo 1 web font ({0}) — minimalan rizik od FOUT/FOIT",
    "The page dynamically loads Google Fonts from Google's servers": "Stranica dinamički učitava Google Fonts sa Google servera",
    "A German court (LG München I, 01/2022) ruled that dynamically loading Google Fonts without consent sends the visitor's IP address to Google without a legal basis under the GDPR, which triggered a wave of warning letters (mostly in Germany, but the GDPR applies across the EU). We are not legal advisors — check with a lawyer if this is relevant for the client.": "Nemački sud (LG München I, 01/2022) presudio je da dinamičko učitavanje Google Fonts bez saglasnosti šalje IP adresu posetioca Google-u bez pravnog osnova prema GDPR-u, što je pokrenulo talas opomena (uglavnom u Nemačkoj, ali GDPR važi u celoj EU). Nismo pravni savetnici — proveri sa pravnikom ako je ovo relevantno za klijenta.",
    "No dynamic loading of Google Fonts from Google's servers (GDPR risk avoided)": "Nema dinamičkog učitavanja Google Fonts sa Google servera (izbegnut GDPR rizik)",
    "Font file in an older format (not .woff2)": "Fajl fonta u starijem formatu (nije .woff2)",
    "WOFF2 has the widest browser support and the best compression (about 30% smaller than WOFF), so it is the only font format needed today.": "WOFF2 ima najširu podršku u browserima i najbolju kompresiju (oko 30% manji od WOFF), pa je danas jedini potreban format fonta.",
    "All font files used on this page are in the modern .woff2 format": "Svi fontovi koje stranica koristi su u modernom .woff2 formatu",
    "Duplicate ID attribute: \"{0}\" ({1} times)": "Duplirani ID atribut: \"{0}\" (broj pojavljivanja: {1})",
    "Duplicate IDs break in-page anchor links and ARIA references (aria-controls, aria-labelledby) that rely on a unique ID. Usually the result of copying an entire section without changing the ID.": "Duplirani ID-jevi kvare in-page anchor linkove i ARIA reference (aria-controls, aria-labelledby) koje zavise od jedinstvenog ID-a. Obično je posledica kopiranja cele sekcije bez promene ID-a.",
    "Rename the duplicates to unique IDs.": "Preimenuj duplikate u jedinstvene ID-jeve.",
    "No duplicate ID attributes on the page": "Na stranici nema dupliranih ID atributa",
    "Large/deeply nested DOM (nodes: {0}, max depth: {1}, max children of one element: {2})": "Veliki/duboko ugnežđen DOM (čvorova: {0}, maks. dubina: {1}, maks. broj potomaka jednog elementa: {2})",
    "A page with more than about 1,400 elements in <body> is considered to have an excessive DOM size. This is a recommendation, not an error — if it's intentional and doesn't cause a visible problem, it can be ignored.": "Stranica sa više od oko 1.400 elemenata u <body> smatra se prevelikom (DOM). Ovo je preporuka, ne greška — ako je namerno i ne pravi vidljiv problem, može se zanemariti.",
    "Consider simplifying the section structure (fewer nested wrapper divs).": "Razmisli o pojednostavljenju strukture sekcija (manje ugnežđenih wrapper div-ova).",
    "DOM size/depth is within reasonable limits (nodes: {0}, max depth: {1})": "Veličina/dubina DOM-a je u razumnim granicama (čvorova: {0}, maks. dubina: {1})",
    "Mixed content: HTTP resource on an HTTPS page": "Mixed content: HTTP resurs na HTTPS stranici",
    "The browser may block or warn about this resource, and it is a security signal.": "Browser može blokirati ovaj resurs ili prikazati upozorenje, a to je i bezbednosni signal.",
    "Change the resource URL to https://.": "Promeni URL resursa na https://.",
    "No mixed content — all resources load over HTTPS": "Nema mixed content — svi resursi se učitavaju preko HTTPS-a",
    "Third-party script without async/defer ({0})": "Skripta treće strane bez async/defer ({0})",
    "Current:": "Trenutno:",
    "Suggested:": "Predlog:",
    "A <script> in the <head> without defer or async blocks the first paint of the page until it has been downloaded and run.": "<script> u <head>-u bez defer ili async blokira prvi prikaz stranice dok se ne preuzme i izvrši.",
    "A <script> in the <head> without defer or async blocks the first paint of the page until it has been downloaded and run. This one sits at the end of <body>, where it blocks very little (it mostly delays DOMContentLoaded), so it is only a minor note.": "<script> u <head>-u bez defer ili async blokira prvi prikaz stranice dok se ne preuzme i izvrši. Ova skripta se nalazi na kraju <body>, gde skoro ništa ne blokira (uglavnom odlaže DOMContentLoaded), pa je samo manja napomena.",
    "All third-party scripts ({0}) have async/defer (not counting Webflow's own scripts)": "Svi skriptovi trećih strana ({0}) imaju async/defer (bez Webflow-ovih sopstvenih skripti)",
    "All third-party scripts ({0}) have async/defer": "Svi skriptovi trećih strana ({0}) imaju async/defer",
    "Performance (CWV)": "Performanse (CWV)",
    "Slow TTFB (Time To First Byte): {0}ms": "Spor TTFB (Time To First Byte): {0}ms",
    "A TTFB over 1800ms is poor. The server responds slowly to the initial request. TTFB is not a Core Web Vital, but everything else on the page has to wait for that first byte.": "TTFB preko 1800ms je loš. Server sporo odgovara na početni zahtev. TTFB nije Core Web Vital, ali sve ostalo na stranici mora da čeka taj prvi bajt.",
    "A good TTFB is 800ms or less. The server responds slowly to the initial request. TTFB is not a Core Web Vital, but everything else on the page has to wait for that first byte.": "Dobar TTFB je 800ms ili manje. Server sporo odgovara na početni zahtev. TTFB nije Core Web Vital, ali sve ostalo na stranici mora da čeka taj prvi bajt.",
    "Check custom code/integrations that could be slowing down the server response.": "Proveri custom code/integracije koje bi mogle usporavati odgovor servera.",
    "TTFB is good ({0}ms, under the 800ms threshold)": "TTFB je dobar ({0}ms, ispod praga od 800ms)",
    "Slow LCP (Largest Contentful Paint): {0}ms": "Spor LCP (Largest Contentful Paint): {0}ms",
    "A good LCP is under 2500ms, and over 4000ms falls into the \"Poor\" category. A slower LCP usually means the largest element (most often the hero image) is too big or loads slowly.": "Dobar LCP je ispod 2500ms, a preko 4000ms spada u kategoriju \"Poor\". Sporiji LCP obično znači da je najveći element (najčešće hero slika) prevelik ili se sporo učitava.",
    "A good LCP is under 2500ms. A slower LCP usually means the largest element (most often the hero image) is too big or loads slowly.": "Dobar LCP je ispod 2500ms. Sporiji LCP obično znači da je najveći element (najčešće hero slika) prevelik ili se sporo učitava.",
    "Optimize/compress the hero image, remove render-blocking resources.": "Optimizuj/kompresuj hero sliku, ukloni resurse koji blokiraju renderovanje.",
    "LCP is good ({0}ms, under Google's 2500ms threshold)": "LCP je dobar ({0}ms, ispod Google-ovog praga od 2500ms)",
    "The LCP image is lazy-loaded (loading=\"lazy\")": "LCP slika se učitava lazy (loading=\"lazy\")",
    "The largest above-the-fold image is the LCP element. With loading=\"lazy\" the browser postpones fetching it until layout is known, which delays LCP (a Core Web Vital).": "Najveća slika iznad preloma je LCP element. Sa loading=\"lazy\" browser odlaže njeno preuzimanje dok ne zna raspored, što odlaže LCP (Core Web Vital).",
    "The LCP image is not lazy-loaded": "LCP slika se ne učitava lazy",
    "High CLS (Cumulative Layout Shift): {0}": "Visok CLS (Cumulative Layout Shift): {0}",
    "Over 0.1 means noticeable content \"jumping\" during load (over 0.25 is poor) — most often due to images/fonts without reserved space.": "Preko 0.1 znači primetno \"skakanje\" sadržaja tokom učitavanja (preko 0.25 je loše) — najčešće zbog slika/fontova bez rezervisanog prostora.",
    "Over 0.1 means noticeable content \"jumping\" during load — most often due to images/fonts without reserved space.": "Preko 0.1 znači primetno \"skakanje\" sadržaja tokom učitavanja — najčešće zbog slika/fontova bez rezervisanog prostora.",
    "Add width/height to images, check font-display settings.": "Dodaj width/height slikama, proveri font-display podešavanja.",
    "CLS is good ({0}, under Google's 0.1 threshold)": "CLS je dobar ({0}, ispod Google-ovog praga od 0.1)",
    "AEO - Structured data (Schema.org)": "AEO - Strukturirani podaci (Schema.org)",
    "JSON-LD schema block contains invalid JSON": "JSON-LD schema blok sadrži nevalidan JSON",
    "JSON that can't be parsed can't be read at all, so none of the markup in this <script type=\"application/ld+json\"> block reaches Google or any other reader.": "JSON koji ne može da se parsira ne može ni da se pročita, pa nijedan deo markupa u ovom <script type=\"application/ld+json\"> bloku ne stiže do Google-a ni do bilo kog drugog čitača.",
    "Check the JSON syntax (missing/extra commas, quotes), e.g. at validator.schema.org.": "Proveri JSON sintaksu (nedostajući/višak zareza, navodnici), npr. na validator.schema.org.",
    "All JSON-LD schema blocks ({0}) contain valid JSON": "Svi JSON-LD schema blokovi ({0}) sadrže validan JSON",
    "Page looks like a FAQ section but has no FAQPage schema markup": "Stranica izgleda kao FAQ sekcija, ali nema FAQPage schema markup",
    "FAQ-like elements were found (classes/IDs containing \"faq\", or 3+ question-style headings) without a corresponding JSON-LD FAQPage schema.": "Pronađeni su elementi nalik FAQ-u (klase/ID-jevi koji sadrže \"faq\" ili 3+ naslova u obliku pitanja) bez odgovarajuće JSON-LD FAQPage schema.",
    "Note only — not scored. Google stopped showing FAQ rich results on 7 May 2026, no special schema is needed for AI Overviews / AI Mode, and adding FAQPage markup has shown no clear effect on AI citations. The markup is optional; if you add it, it must match the visible questions and answers.": "Samo napomena — ne utiče na skor. Google od 7. maja 2026. ne prikazuje FAQ rich results, za AI Overviews / AI Mode nije potrebna posebna schema, a dodavanje FAQPage markupa nije pokazalo jasan efekat na AI citiranje. Markup je opcion; ako ga dodaješ, mora da odgovara vidljivim pitanjima i odgovorima.",
    "Optional: add a JSON-LD FAQPage block (a mainEntity array of Question/acceptedAnswer objects) matching the visible questions and answers — in Webflow: Page settings > Schema markup.": "Opciono: dodaj JSON-LD FAQPage blok (mainEntity niz Question/acceptedAnswer objekata) koji odgovara vidljivim pitanjima i odgovorima — u Webflow-u: Page settings > Schema markup.",
    "FAQPage schema has no mainEntity (questions)": "FAQPage schema nema mainEntity (pitanja)",
    "Note only — not scored. Without mainEntity the FAQPage block contains no questions, so the markup describes nothing.": "Samo napomena — ne utiče na skor. Bez mainEntity FAQPage blok ne sadrži nijedno pitanje, pa markup ništa ne opisuje.",
    "Add a mainEntity array with Question/acceptedAnswer objects for every question on the page.": "Dodaj mainEntity niz sa Question/acceptedAnswer objektima za svako pitanje na stranici.",
    "{0} question(s) in the FAQPage schema have no acceptedAnswer.text filled in": "Pitanja u FAQPage schema bez popunjenog acceptedAnswer.text: {0}",
    "Note only — not scored. These questions have no answer text in the markup, so the markup doesn't match the answers shown on the page.": "Samo napomena — ne utiče na skor. Ova pitanja nemaju tekst odgovora u markupu, pa markup ne odgovara odgovorima prikazanim na stranici.",
    "Fill in acceptedAnswer.text for every Question in the schema.": "Popuni acceptedAnswer.text za svako Question u schema.",
    "FAQPage schema is present and complete ({0} questions with answers)": "FAQPage schema je prisutna i kompletna (pitanja sa odgovorima: {0})",
    "Page looks like an article/blog post but has no Article schema markup": "Stranica izgleda kao članak/blog post, ali nema Article schema markup",
    "An <article> element with substantial text, og:type=\"article\", or a blog-style URL was found, without a JSON-LD Article/BlogPosting schema.": "Pronađen je <article> element sa značajnim tekstom, og:type=\"article\" ili URL u blog stilu, bez JSON-LD Article/BlogPosting schema.",
    "Article markup tells Google explicitly what the content is: that it is an article, who the author is and what its title is. No property is required; author, datePublished, dateModified, headline and image are recommended. (No special schema is needed to appear in AI Overviews or AI Mode.)": "Article markup Google-u eksplicitno kaže šta je sadržaj: da je članak, ko je autor i koji je naslov. Nijedno svojstvo nije obavezno; preporučeni su author, datePublished, dateModified, headline i image. (Za AI Overviews i AI Mode nije potrebna posebna schema.)",
    "Add a JSON-LD Article schema with headline, author, datePublished, dateModified.": "Dodaj JSON-LD Article schema sa headline, author, datePublished, dateModified.",
    "Article schema has neither dateModified nor datePublished": "Article schema nema ni dateModified ni datePublished",
    "datePublished and dateModified are recommended Article properties; dateModified gives Google more accurate date information about the content.": "datePublished i dateModified su preporučena Article svojstva; dateModified daje Google-u tačniji podatak o datumu sadržaja.",
    "Add dateModified (and datePublished) in ISO 8601 format. Best practice: bind the field automatically to the CMS \"last modified\" value instead of it being manual/hardcoded, so it doesn't get forgotten.": "Dodaj dateModified (i datePublished) u ISO 8601 formatu. Najbolja praksa: poveži polje automatski sa CMS vrednošću \"last modified\" umesto ručnog/hardkodovanog unosa, da se ne zaboravi.",
    "Article schema has datePublished/dateModified": "Article schema ima datePublished/dateModified",
    "Author link in the Article schema leads to a 404": "Link autora u Article schema vodi na 404",
    "author.url: {0}": "author.url: {0}",
    "author.url (or sameAs) lets Google identify the author. A link that doesn't work gives it nothing to identify the author with.": "author.url (ili sameAs) omogućava Google-u da identifikuje autora. Link koji ne radi ne daje mu ništa čime bi identifikovao autora.",
    "Fix author.url to point to a valid author page/profile.": "Ispravi author.url da vodi na validnu stranicu/profil autora.",
    "Author link in the Article schema is valid (doesn't return 404)": "Link autora u Article schema je validan (ne vraća 404)",
    "Article schema has no author field": "Article schema nema author polje",
    "author (a Person or Organization, with author.name and author.url) is a recommended Article property, so Google can understand who wrote the content.": "author (Person ili Organization, sa author.name i author.url) je preporučeno Article svojstvo, da bi Google razumeo ko je napisao sadržaj.",
    "Add an author (Person or Organization) with name and url.": "Dodaj author (Person ili Organization) sa name i url.",
    "Article schema has an author field": "Article schema ima author polje",
    "AEO - NAP consistency": "AEO - Konzistentnost NAP podataka",
    "Phone number in the Organization/LocalBusiness schema doesn't match the number in the footer": "Telefon u Organization/LocalBusiness schema ne poklapa se sa brojem u footer-u",
    "Schema telephone: {0}": "Schema telephone: {0}",
    "Structured data must be a true representation of the page content. A phone number in the schema that differs from the one shown on the page breaks that rule.": "Strukturirani podaci moraju verno predstavljati sadržaj stranice. Broj telefona u schemi koji se razlikuje od onog prikazanog na stranici krši to pravilo.",
    "Align the phone number in the schema markup with the one visibly shown in the footer.": "Uskladi broj telefona u schema markup-u sa onim vidljivo prikazanim u footer-u.",
    "Address from the Organization/LocalBusiness schema doesn't appear anywhere in the visible footer": "Adresa iz Organization/LocalBusiness schema se ne pojavljuje nigde u vidljivom footer-u",
    "Schema address: {0}": "Schema address: {0}",
    "Structured data shouldn't describe content that readers can't see. An address in the schema that isn't shown in the footer may not be visible anywhere on the page.": "Strukturirani podaci ne bi trebalo da opisuju sadržaj koji čitaoci ne vide. Adresa u schemi koja nije prikazana u footer-u možda nije vidljiva nigde na stranici.",
    "Display the same address visibly (e.g. in the footer) or remove it from the schema if it's no longer accurate.": "Prikaži istu adresu vidljivo (npr. u footer-u) ili je ukloni iz schema ako više nije tačna.",
    "NAP data (phone/address) from the schema markup is consistent with the footer": "NAP podaci (telefon/adresa) iz schema markup-a usklađeni su sa footer-om",
    "A visible breadcrumb UI exists, but there is no BreadcrumbList schema markup": "Postoji vidljiv breadcrumb UI, ali nema BreadcrumbList schema markup",
    "Google uses breadcrumb markup to categorize the page's information in search results.": "Google koristi breadcrumb markup da kategorizuje informacije sa stranice u rezultatima pretrage.",
    "Add a JSON-LD BreadcrumbList schema matching the visible breadcrumb navigation.": "Dodaj JSON-LD BreadcrumbList schema koja odgovara vidljivoj breadcrumb navigaciji.",
    "BreadcrumbList schema is present": "BreadcrumbList schema je prisutna",
    "AEO - JS rendering dependency": "AEO - Zavisnost od JS renderovanja",
    "Most of the content only appears after JavaScript executes (raw HTML: ~{0} chars, rendered: ~{1} chars)": "Većina sadržaja se pojavljuje tek nakon izvršavanja JavaScript-a (raw HTML: ~{0} karaktera, renderovano: ~{1} karaktera)",
    "Note: this is a heuristic and can produce false results (e.g. a cookie banner blocking the fetch). Most AI crawlers (OpenAI, Anthropic, Perplexity and others) don't run JavaScript; Google's crawler does. If key content only appears after JavaScript runs, those crawlers may see an empty or nearly empty page. Webflow pages are server-rendered, so this is rare, but custom code/embeds can inject content afterward.": "Napomena: ovo je heuristika i može dati pogrešne rezultate (npr. cookie baner blokira preuzimanje). Većina AI crawlera (OpenAI, Anthropic, Perplexity i drugi) ne izvršava JavaScript; Google-ov crawler ga izvršava. Ako se ključni sadržaj pojavljuje tek posle izvršavanja JavaScript-a, ti crawleri mogu videti praznu ili skoro praznu stranicu. Webflow stranice se renderuju na serveru, pa je ovo retko, ali custom code/embed-ovi mogu naknadno ubaciti sadržaj.",
    "Check \"View Page Source\" (Ctrl/Cmd+U) and compare it with what's visible on screen — if key text is missing from the raw HTML, consider making that content part of the server's initial HTML response.": "Proveri \"View Page Source\" (Ctrl/Cmd+U) i uporedi sa onim što je vidljivo na ekranu — ako ključni tekst nedostaje u raw HTML-u, razmisli da taj sadržaj postane deo početnog HTML odgovora servera.",
    "Hide the report preview": "Sakrij pregled izveštaja",
    "Preview the full report (SEO + AEO findings) before copying it": "Pregledaj ceo izveštaj (SEO + AEO nalazi) pre kopiranja",
    "Close": "Zatvori",
    "no change since last run": "nema promene od poslednjeg pokretanja",
    "since last run": "od poslednjeg pokretanja",
    "All checks passed": "Sve provere su prošle",
    "Page optimized": "Stranica je optimizovana",
    "Weighted share of checks that pass on this page. Errors weigh more than warnings, and warnings more than info items; when a check only affects some elements (e.g. a few images), you get partial credit. Not an official metric.": "Ponderisan udeo provera koje prolaze na ovoj stranici. Greške imaju veću težinu od upozorenja, a upozorenja veću od info stavki; kada provera utiče samo na neke elemente (npr. nekoliko slika), dobija se delimičan kredit. Nije zvanična metrika.",
    "Last run ({0}): {1} findings → now: {2}": "Poslednje pokretanje ({0}): nalaza: {1} → sada: {2}",
    "no change": "nema promene",
    "All": "Sve",
    "error": "greška",
    "warning": "upozorenje",
    "info": "info",
    "All categories ({0})": "Sve kategorije ({0})",
    "All ({0})": "Sve ({0})",
    "AEO + SEO items ({0})": "AEO + SEO stavke ({0})",
    "{0} only items ({1})": "Samo {0} stavke ({1})",
    "Highlight all ({0})": "Istakni sve ({0})",
    "Draw a box around every listed finding at once, instead of one at a time.": "Nacrtaj okvir oko svakog navedenog nalaza odjednom, umesto jednog po jednog.",
    "No successful checks for the selected group (\"{0}\") in this tab.": "Nema uspešnih provera za izabranu grupu (\"{0}\") na ovom tabu.",
    "No successful checks recorded yet (or the page is still being analyzed).": "Još nema zabeleženih uspešnih provera (ili se stranica još analizira).",
    "No AEO findings on this page. 🎉": "Nema AEO nalaza na ovoj stranici. 🎉",
    "No SEO findings on this page. 🎉": "Nema SEO nalaza na ovoj stranici. 🎉",
    "No findings for filter severity=\"{0}\" + category=\"{1}\".": "Nema nalaza za filter severity=\"{0}\" + category=\"{1}\".",
    "No findings for the selected filter (\"{0}\") in this tab.": "Nema nalaza za izabrani filter (\"{0}\") na ovom tabu.",
    "Shown in both the SEO and AEO tabs (counted once in the totals)": "Prikazano i na SEO i na AEO tabu (u ukupnom zbiru se računa jednom)",
    "Copy the suggested code to clipboard": "Kopiraj predloženi kod u clipboard",
    "📋 Copy suggested code": "📋 Kopiraj predloženi kod",
    "Who can fix:": "Ko može da reši:",
    "Why:": "Zašto:",
    "Fix:": "Rešenje:",
    "Copy": "Kopiraj",
    "Copy this fix suggestion to clipboard": "Kopiraj ovaj predlog rešenja u clipboard",
    "Fix copied to clipboard.": "Rešenje je kopirano u clipboard.",
    "Suggested code copied to clipboard.": "Predloženi kod je kopiran u clipboard.",
    "Drag to resize panel height": "Prevuci da promeniš visinu panela",
    "Report preview": "Pregled izveštaja",
    "Close preview": "Zatvori pregled",
    "📋 Copy to clipboard": "📋 Kopiraj u clipboard",
    "Report copied to clipboard.": "Izveštaj je kopiran u clipboard.",
    "Copied to clipboard.": "Kopirano u clipboard.",
    "Could not copy to clipboard — your browser may be blocking it.": "Kopiranje u clipboard nije uspelo — browser ga možda blokira.",
    "The panel is covering this element — drag the panel (by its header) to another part of the screen to see it.": "Panel prekriva ovaj element — prevuci panel (za zaglavlje) na drugi deo ekrana da bi ga video.",
    "Relevant to both SEO and AEO.": "Relevantno i za SEO i za AEO.",
    "SEO PAGE AUDITOR — Report": "SEO PAGE AUDITOR — Izveštaj",
    "SUMMARY": "REZIME",
    "SEO FINDINGS": "SEO NALAZI",
    "AEO FINDINGS": "AEO NALAZI",
    "(no findings)": "(nema nalaza)",
    "Global element:": "Globalni element:",
    "Why it matters:": "Zašto je bitno:",
    "Page optimized :": "Stranica je optimizovana :",
    "Successes :": "Uspešne provere :",
    "errors": "grešaka",
    "warnings": "upozorenja",
    "SEO-only": "Samo SEO",
    "AEO-only": "Samo AEO",
    "Success": "Uspešno",
    "Language": "Jezik",
    "Switch the panel and report language (EN / SR)": "Promeni jezik panela i izveštaja (EN / SR)",
    "SEO tab": "SEO tab",
    "AEO tab": "AEO tab",
    "total": "ukupno",
    "Other": "Ostalo",
    "Webflow platform script without async/defer ({0})": "Webflow platform skripta bez async/defer ({0})",
    "This script is added automatically by Webflow to every published page (jQuery / the generated site JavaScript) and sits at the end of <body>.": "Ovu skriptu Webflow automatski dodaje na svaku objavljenu stranicu (jQuery / generisani JavaScript sajta) i nalazi se na kraju <body>.",
    "No action needed — Webflow does not let you change its attributes.": "Nije potrebna nikakva akcija — Webflow ne dozvoljava izmenu njenih atributa.",
    "Added by the Webflow platform itself — there is no option in the Designer or in Custom Code to change it. Not counted in the optimization score.": "Dodaje je sama Webflow platforma — ne postoji opcija u Designer-u ni u Custom Code-u da se promeni. Ne ulazi u skor optimizacije.",
    "Needs access to Cloudflare (or whoever manages the CDN / reverse proxy in front of the site) — it is not part of the Webflow project, so it can't be changed from there.": "Potreban je pristup Cloudflare-u (ili onome ko upravlja CDN-om / reverse proxy-jem ispred sajta) — nije deo Webflow projekta, pa se odatle ne može promeniti.",
    "Cookie-consent managers are usually loaded synchronously on purpose, so they can run before any tracking script. Check the provider's documentation before adding async/defer.": "Consent menadžeri za kolačiće se obično namerno učitavaju sinhrono, da bi se izvršili pre bilo koje tracking skripte. Pogledaj dokumentaciju provajdera pre nego što dodaš async/defer.",
    "Usually leave as is. Only change it if the provider's docs say deferring is supported.": "Obično ostavi kako jeste. Menjaj samo ako dokumentacija provajdera kaže da je odlaganje podržano.",
    "If this script is not in the project's Custom Code, it is most likely loaded by a tag manager (e.g. Google Tag Manager) or injected by a reverse proxy — then it has to be changed there, by whoever manages that platform.": "Ako ova skripta nije u Custom Code-u projekta, najverovatnije je učitava tag manager (npr. Google Tag Manager) ili je ubacuje reverse proxy — onda mora da se promeni tamo, od strane onoga ko upravlja tom platformom.",
    "Global element ({0}) — likely a Symbol/Component that repeats across all pages of the site. Fixing it in one place resolves the issue site-wide. A quick check on 1-2 other pages is recommended.": "Globalni element ({0}) — verovatno Symbol/Component koji se ponavlja na svim stranicama sajta. Ispravka na jednom mestu rešava problem na celom sajtu. Preporučuje se brza provera na 1-2 druge stranice.",
    "Sitemap check": "Provera sitemap-a",
    "Sitemap check (is this page listed?)": "Provera sitemap-a (da li je stranica navedena?)",
    "X-Robots-Tag header check": "Provera X-Robots-Tag header-a",
    "the server answered HTTP {0} to the header request": "server je odgovorio sa HTTP {0} na zahtev za header",
    "the browser blocked or failed the request (a network error, or the site's Content-Security-Policy \"connect-src\" rule)": "browser je blokirao ili prekinuo zahtev (mrežna greška, ili Content-Security-Policy \"connect-src\" pravilo sajta)",
    "the sitemap has more nested files than this check reads (max 12 files, 3 levels deep), so it can't prove the page is missing": "sitemap ima više ugnježdenih fajlova nego što ova provera čita (najviše 12 fajlova, 3 nivoa dubine), pa ne može da dokaže da stranica nedostaje",
    "a sitemap file ({0}) answered HTTP {1}": "sitemap fajl ({0}) je odgovorio sa HTTP {1}",
    "a sitemap file ({0}) is not valid sitemap XML": "sitemap fajl ({0}) nije validan sitemap XML",
    "Relevant to both SEO and AEO — a good page experience also matters for AI Overviews and AI Mode.": "Relevantno i za SEO i za AEO — dobro iskustvo na stranici je bitno i za AI Overviews i AI Mode.",
    "Relevant to both SEO and AEO — good Core Web Vitals are part of what Google's ranking systems reward.": "Relevantno i za SEO i za AEO — dobri Core Web Vitals su deo onoga što Google-ovi sistemi rangiranja nagrađuju.",
    "Meta charset": "Meta charset",
    "Duplicate <title> tags": "Duplirani <title> tagovi",
    "Duplicate meta descriptions": "Duplirani meta description",
    "Title tag": "Title tag",
    "Meta description": "Meta description",
    "og:title": "og:title",
    "og:description": "og:description",
    "og:image": "og:image",
    "OG image quality": "Kvalitet OG slike",
    "Twitter/X Card": "Twitter/X Card",
    "Canonical tag present": "Canonical tag postoji",
    "noindex directive": "noindex direktiva",
    "Robots directives (nosnippet etc.)": "Robots direktive (nosnippet itd.)",
    "X-Robots-Tag header": "X-Robots-Tag header",
    "Page listed in sitemap.xml": "Stranica u sitemap.xml",
    "lang attribute": "lang atribut",
    "Viewport meta tag": "Viewport meta tag",
    "Viewport allows zoom": "Viewport dozvoljava zumiranje",
    "Favicon present": "Favicon postoji",
    "Favicon quality": "Kvalitet favicon-a",
    "Favicon not blocked by robots": "Favicon nije blokiran u robots",
    "Canonical points to this page": "Canonical pokazuje na ovu stranicu",
    "URL slug": "URL slug",
    "Exactly one H1": "Tačno jedan H1",
    "Heading hierarchy": "Hijerarhija naslova",
    "Text styled as a heading": "Tekst stilizovan kao naslov",
    "Image alt text": "Alt tekst slika",
    "Image height (layout shift)": "Visina slike (layout shift)",
    "Images hosted on the same domain": "Slike na istom domenu",
    "Image size vs displayed size": "Veličina slike prema prikazanoj",
    "Below-the-fold images lazy-loaded": "Slike ispod preloma sa lazy učitavanjem",
    "Modern image format": "Moderan format slike",
    "Image file size (up to 500KB)": "Težina slike (do 500KB)",
    "Links that go nowhere": "Linkovi koji ne vode nigde",
    "In-page anchor links": "Anchor linkovi na stranici",
    "Links with visible text": "Linkovi sa vidljivim tekstom",
    "Generic anchor text": "Generički anchor tekst",
    "Internal links working": "Interni linkovi rade",
    "Enough visible text": "Dovoljno vidljivog teksta",
    "Hidden content": "Skriveni sadržaj",
    "Repeated words": "Ponovljene reči",
    "Placeholder / Lorem ipsum text": "Placeholder / Lorem ipsum tekst",
    "Number of fonts": "Broj fontova",
    "Google Fonts loading": "Učitavanje Google Fonts",
    "Font file format": "Format font fajla",
    "Duplicate IDs": "Duplirani ID-jevi",
    "DOM size / depth": "Veličina / dubina DOM-a",
    "Mixed content (HTTP on HTTPS)": "Mešoviti sadržaj (HTTP na HTTPS)",
    "Third-party scripts": "Skripte trećih strana",
    "TTFB (server response)": "TTFB (odgovor servera)",
    "LCP (largest contentful paint)": "LCP (najveći element)",
    "CLS (layout shift)": "CLS (pomeranje rasporeda)",
    "LCP image not lazy-loaded": "LCP slika nije lazy",
    "JSON-LD schema validity": "Validnost JSON-LD schema",
    "FAQPage schema": "FAQPage schema",
    "Article schema": "Article schema",
    "Article dates": "Datumi članka",
    "Article author": "Autor članka",
    "Author link": "Link autora",
    "NAP data (phone/address)": "NAP podaci (telefon/adresa)",
    "Breadcrumbs": "Breadcrumbs",
    "Content visible without JavaScript": "Sadržaj vidljiv bez JavaScript-a",
    "Checks that did not fully pass (a check can fail because of an info note too). Click to see which ones and how much each costs.": "Provere koje nisu u potpunosti prošle (provera može da padne i zbog info napomene). Klikni da vidiš koje su i koliko svaka košta.",
    "Individual error + warning findings": "Pojedinačni nalazi tipa greška + upozorenje",
    "Individual info findings (notes)": "Pojedinačni info nalazi (napomene)",
    "← Back to findings": "← Nazad na nalaze",
    "Checks that need attention ({0})": "Provere koje zahtevaju pažnju ({0})",
    "Click a check to see its findings. \"Issues\" and \"notes\" count individual findings (errors + warnings / info), so they differ from the number of checks. The % is how much of the \"Page optimized\" score each check costs.": "Klikni na proveru da vidiš njene nalaze. „Problemi“ i „napomene“ broje pojedinačne nalaze (greške + upozorenja / info), pa se razlikuju od broja provera. Procenat pokazuje koliko svaka provera košta u skoru „Stranica je optimizovana“.",
    "Show the {0} finding(s) of this check": "Prikaži nalaze ove provere ({0})",
    "Showing only the check:": "Prikazana samo provera:",
    "Clear filter": "Ukloni filter",
    "Issues = errors + warnings. Every individual error-level and warning-level finding on this page is counted (info notes are not). These are the ones to fix first.": "Problemi = greške + upozorenja. Broji se svaki pojedinačni nalaz tipa greška i upozorenje na ovoj stranici (info napomene se ne računaju). Ovo je ono što prvo treba ispraviti.",
    "Notes = info-level findings. Suggestions and things worth double-checking — they do not mean something is broken, but they still affect the score a little.": "Napomene = info nalazi. Predlozi i stvari koje vredi dvaput proveriti — ne znače da je nešto pokvareno, ali ipak malo utiču na skor."
    };
  }

  run();

  window.__SeoAuditorResults = findings;
  window.__SeoAuditorSuccesses = successes;
})();
