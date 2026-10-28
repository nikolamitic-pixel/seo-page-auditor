/*!
 * SEO Page Auditor (bookmarklet payload)
 * Runs entirely client-side in the developer's browser. No server, no Lighthouse.
 * See SPEC.md in this project for the full rule list and rationale.
 */
(function () {
  'use strict';

  if (window.__SeoAuditorRunning) {
    console.warn('[SeoAuditor] Already running.');
    return;
  }
  window.__SeoAuditorRunning = true;

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

  function text(el) {
    return (el && (el.innerText || el.textContent) || '').trim();
  }

  function isVisible(el) {
    if (!el || !(el instanceof Element)) return false;
    var style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    var rect = el.getBoundingClientRect();
    return rect.width > 0 || rect.height > 0;
  }

  function sameHost(url, host) {
    try {
      return new URL(url, location.href).hostname === host;
    } catch (e) {
      return false;
    }
  }

  function hostnameOf(url) {
    try {
      return new URL(url, location.href).hostname;
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
    return !!host && rootDomain(host) === rootDomain(location.hostname);
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
          description: 'The browser followed ' + nav.redirectCount + ' redirect(s) before arriving at: ' + location.href,
          why: 'If this is unexpected, the results reflect the final page, not the URL you may have originally opened.',
          fix: 'Check whether the redirect is intentional.',
          element: null
        });
      }
    } catch (e) { /* Navigation Timing L2 not supported */ }

    // Staging detection
    if (/\.webflow\.io$/.test(location.hostname)) {
      addFinding({
        category: 'Preliminary check',
        severity: 'info',
        title: 'This is a Webflow staging link',
        description: 'The domain ' + location.hostname + ' is a Webflow staging subdomain.',
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
        description: 'There is no <meta charset="..."> in the head.', why: 'Without an explicit charset, the browser may misdetect the encoding before it receives the HTTP header, which rarely — but genuinely — causes characters to render incorrectly on first paint.',
        fix: 'Webflow adds this automatically — check that custom code in the <head> hasn\'t accidentally removed or moved the tag.', element: document.head });
    } else {
      var charsetVal = charsetMeta.hasAttribute('charset') ? charsetMeta.getAttribute('charset') : (charsetMeta.getAttribute('content') || '');
      if (!/utf-8/i.test(charsetVal)) {
        addFinding({ category: 'Meta & head tags', severity: 'warning', title: 'Meta charset is not UTF-8',
          description: 'Value found: "' + charsetVal + '".', why: 'UTF-8 is the universal standard that covers all languages and characters — anything else carries a real risk of characters rendering incorrectly.',
          fix: 'Set the charset to UTF-8.', element: document.head });
      } else {
        addSuccess({ category: 'Meta & head tags', title: 'Meta charset is present and set to UTF-8', description: '', element: document.head });
      }
    }

    var titleTags = document.querySelectorAll('title');
    if (titleTags.length > 1) {
      addFinding({ category: 'Meta & head tags', severity: 'warning', title: 'More than one <title> tag in the head (' + titleTags.length + ')',
        description: Array.prototype.map.call(titleTags, function (t) { return '"' + t.textContent + '"'; }).join(', '),
        why: 'Browsers and Google usually only take the first <title> tag, but this behavior isn\'t universally guaranteed across all parsers/bots — a duplicate most often signals a mistake in the Custom Code section (e.g. a manually added <title> alongside Webflow\'s own).',
        fix: 'Remove all but one <title> tag — set the title via Page Settings, not manually in Custom Code.', element: document.head });
    }

    var descTags = document.querySelectorAll('meta[name="description" i]');
    if (descTags.length > 1) {
      addFinding({ category: 'Meta & head tags', severity: 'warning', title: 'More than one meta description tag (' + descTags.length + ')',
        description: Array.prototype.map.call(descTags, function (m) { return '"' + (m.getAttribute('content') || '') + '"'; }).join(' | '),
        why: 'When multiple meta description tags exist, which one Google picks isn\'t guaranteed — this usually means a duplicate was entered both via Page Settings and manually via Custom Code.',
        fix: 'Remove all but one meta description tag.', element: document.head });
    }

    var title = document.title || '';
    var titleLengthOk = false;
    if (!title.trim()) {
      addFinding({ category: 'Meta & head tags', severity: 'error', title: 'Title tag is missing or empty',
        description: 'The <title> is empty.', why: 'Title is one of the strongest on-page SEO signals and the text users see in search results.',
        fix: 'Add a unique, descriptive title (ideally 50-60 characters) in Page Settings.', element: document.head });
    } else if (title.length > 60) {
      addFinding({ category: 'Meta & head tags', severity: 'warning', title: 'Title is too long (' + title.length + ' characters)',
        description: 'Title: "' + title + '"', why: 'Google typically truncates the title after ~60 characters in search results.',
        fix: 'Shorten the title to 50-60 characters, put the most important words first.', element: document.head });
    } else if (title.length < 30) {
      addFinding({ category: 'Meta & head tags', severity: 'warning', title: 'Title is very short (' + title.length + ' characters)',
        description: 'Title: "' + title + '"', why: 'A title under ~30 characters usually isn\'t descriptive enough and wastes room in the search result (the ideal range is roughly 50-60 characters; Google actually measures pixel width, so this is an approximation).',
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
        description: 'There is no meta description tag, or it is empty.', why: 'Meta description influences CTR from search results even though it isn\'t a direct ranking factor.',
        fix: 'Add a meta description of 120-160 characters in Page Settings.', element: document.head });
    } else if (desc.length < 70) {
      addFinding({ category: 'Meta & head tags', severity: 'info', title: 'Meta description is short (' + desc.length + ' characters)',
        description: desc, why: 'A very short description leaves room in the search result unused. Google often rewrites descriptions anyway, so this is a suggestion, not an error; the usual guideline is ~120-160 characters (an approximation — Google measures pixels).',
        fix: 'Expand it to roughly 120-160 characters that describe the page and invite the click.', element: document.head });
    } else if (desc.length > 160) {
      addFinding({ category: 'Meta & head tags', severity: 'warning', title: 'Meta description is too long (' + desc.length + ' characters)',
        description: desc, why: 'Google truncates the description after ~155-160 characters.', fix: 'Shorten it to 120-160 characters.', element: document.head });
    } else {
      addSuccess({ category: 'Meta & head tags', title: 'Meta description is present and of appropriate length (' + desc.length + ' characters)',
        description: desc, element: document.head });
    }

    var ogTitle = getMeta('og:title', 'property');
    var ogDesc = getMeta('og:description', 'property');
    var ogImage = getMeta('og:image', 'property');
    if (!ogTitle) {
      addFinding({ category: 'Meta & head tags', severity: 'warning', title: 'og:title is missing',
        description: 'There is no Open Graph title tag.', why: 'Without it, sharing the link on social media falls back to a (often poor) default title.',
        fix: 'Add og:title in Page Settings > Open Graph.', element: document.head });
    } else {
      addSuccess({ category: 'Meta & head tags', title: 'og:title is present', description: ogTitle, element: document.head });
    }
    if (!ogDesc) {
      addFinding({ category: 'Meta & head tags', severity: 'warning', title: 'og:description is missing',
        description: 'There is no Open Graph description tag.', why: 'Without it, the link preview on social media has no description.',
        fix: 'Add og:description in Page Settings.', element: document.head });
    } else {
      addSuccess({ category: 'Meta & head tags', title: 'og:description is present', description: ogDesc, element: document.head });
    }

    if (!ogImage) {
      addFinding({ category: 'Meta & head tags', severity: 'warning', title: 'og:image is missing',
        description: 'There is no Open Graph image.', why: 'Links without an OG image look bare when shared on social media.',
        fix: 'Add og:image (1200x630px, JPG/PNG) in Page Settings.', element: document.head });
    } else {
      addSuccess({ category: 'Meta & head tags', title: 'og:image is present', description: ogImage, element: document.head });
      checkOgImage(ogImage);
    }

    var twitterCard = getMeta('twitter:card');
    if (!twitterCard) {
      addFinding({ category: 'Meta & head tags', severity: 'warning', title: 'Twitter/X Card meta tag (twitter:card) is missing',
        description: 'There is no <meta name="twitter:card">.', why: 'Twitter/X Card tags are technically separate from Open Graph tags — without an explicit twitter:card, X sometimes fails to reliably pull the OG fallback, so a shared link can end up with no preview at all specifically on that platform.',
        fix: 'Add <meta name="twitter:card" content="summary_large_image"> (and ideally twitter:title/twitter:image) via Custom Code in the head section.', element: document.head });
    } else {
      addSuccess({ category: 'Meta & head tags', title: 'Twitter/X Card meta tag is present (' + twitterCard + ')', description: '', element: document.head });
    }

    var canonical = document.querySelector('link[rel="canonical"]');
    if (!canonical) {
      addFinding({ category: 'Meta & head tags', severity: 'error', title: 'Canonical tag is missing',
        description: 'There is no <link rel="canonical">.', why: 'Without a canonical, Google chooses on its own which version of the URL it considers primary — and Google officially recommends that EVERY page have an explicit canonical, regardless of whether a duplicate currently exists. This is something a developer should add before publishing, not a "nice to have".',
        fix: 'Add a canonical tag pointing to this page.', element: document.head,
        crossRelevant: true, crossNote: 'Relevant to both SEO and AEO — an unclear "primary" URL makes it harder for AI answer engines to know which version of the page to cite.',
        crossNoteReverse: 'Relevant to both SEO and AEO — a canonical prevents duplicate content issues and consolidates ranking signals onto a single URL in the Google index.' });
    } else {
      checkCanonicalDuplication(canonical);
    }

    var robots = getMeta('robots');
    if (robots && /noindex/i.test(robots)) {
      addFinding({ category: 'Meta & head tags', severity: 'error', title: 'Page is marked as noindex',
        description: 'meta robots = "' + robots + '"', why: 'This page will not be indexed by Google as long as this remains in place.',
        fix: 'If the page should be visible in search, remove noindex in Page Settings > SEO > "Exclude from search results".', element: document.head,
        crossRelevant: true, crossNote: 'Relevant to both SEO and AEO — a noindex page won\'t appear in the sources AI answer engines (partly) rely on via the Google index either.',
        crossNoteReverse: 'Relevant to both SEO and AEO — a noindex directive completely removes the page from Google search, which is the most direct possible SEO problem.' });
    } else {
      addSuccess({ category: 'Meta & head tags', title: 'Page is not marked as noindex', description: '', element: document.head,
        crossRelevant: true, crossNote: 'Relevant to both SEO and AEO — a noindex page wouldn\'t appear in the sources AI answer engines (partly) rely on via the Google index either.',
        crossNoteReverse: 'Relevant to both SEO and AEO — the page is indexable and can appear in Google search.' });
    }

    var blocksSnippet = robots && (/nosnippet/i.test(robots) || /max-snippet:\s*0\b/i.test(robots));
    if (blocksSnippet) {
      addFinding({ category: 'Meta & head tags', severity: 'error', title: 'Robots directive blocks the content snippet (nosnippet/max-snippet:0)',
        description: 'meta robots = "' + robots + '"',
        why: 'This directive explicitly forbids Google (and any AI answer engine that partly relies on Google\'s index) from showing ANY text snippet from the page — the page can\'t appear in AI Overviews or featured snippets, nor get a description in classic search results. This is a direct, documented, binary visibility blocker, not a heuristic.',
        fix: 'Remove "nosnippet" and "max-snippet:0" from the meta robots tag, unless it\'s intentional (e.g. a page with sensitive content).', element: document.head,
        crossRelevant: true, crossNote: 'Relevant to both SEO and AEO — this directly prevents AI answer engines from citing any part of the page\'s content.',
        crossNoteReverse: 'Relevant to both SEO and AEO — without a snippet, the Google result for this page has no description, which drastically reduces CTR even if the page ranks well.' });
    } else {
      addSuccess({ category: 'Meta & head tags', title: 'Robots directive does not block the content snippet', description: '', element: document.head,
        crossRelevant: true, crossNote: 'Relevant to both SEO and AEO — Google and AI answer engines are free to display a snippet of this page\'s content.',
        crossNoteReverse: 'Relevant to both SEO and AEO — the page can have a normal description/snippet in Google search results.' });
    }

    var htmlLang = document.documentElement.getAttribute('lang');
    if (!htmlLang) {
      addFinding({ category: 'Meta & head tags', severity: 'warning', title: 'lang attribute is missing on <html>',
        description: '<html> has no lang attribute.', why: 'It helps both search engines and screen readers know what language the content is in.',
        fix: 'Set the site language in Webflow Site Settings.', element: document.documentElement });
    } else {
      addSuccess({ category: 'Meta & head tags', title: 'lang attribute is present on <html> (' + htmlLang + ')', description: '', element: document.documentElement });
    }

    var viewport = document.querySelector('meta[name="viewport"]');
    if (!viewport) {
      addFinding({ category: 'Meta & head tags', severity: 'error', title: 'Viewport meta tag is missing',
        description: 'There is no <meta name="viewport">.', why: 'Without this the page isn\'t mobile-friendly, which directly affects mobile-first indexing.',
        fix: 'Webflow usually adds this automatically — check that custom code hasn\'t removed the tag.', element: document.head });
    } else {
      addSuccess({ category: 'Meta & head tags', title: 'Viewport meta tag is present', description: '', element: document.head });
      var vpContent = viewport.getAttribute('content') || '';
      if (/user-scalable\s*=\s*no/i.test(vpContent) || /maximum-scale\s*=\s*1(\.0)?\b/.test(vpContent)) {
        addFinding({ category: 'Meta & head tags', severity: 'warning', title: 'Viewport prevents the user from zooming',
          description: 'viewport = "' + vpContent + '"', why: 'Google Search Console explicitly flags "user-scalable=no"/"maximum-scale=1" as a mobile usability problem — it prevents users with reduced vision from zooming in on content on mobile.',
          fix: 'Remove user-scalable=no and maximum-scale=1 from the viewport tag (allow zooming up to at least maximum-scale=5).', element: document.head });
      } else {
        addSuccess({ category: 'Meta & head tags', title: 'Viewport allows the user to zoom the page', description: '', element: document.head });
      }
    }
  }

  function checkOgImage(ogImageUrl) {
    var ext = (ogImageUrl.split('?')[0].split('.').pop() || '').toLowerCase();
    if (ext === 'webp' || ext === 'avif') {
      addFinding({ category: 'Meta & head tags', severity: 'warning', title: 'OG image is in a format social platforms render unreliably (' + ext.toUpperCase() + ')',
        description: 'og:image: ' + ogImageUrl, why: 'Unlike regular images on the page, the OG image is fetched by each social platform\'s bot — many of them don\'t render WebP/AVIF reliably, so the preview can end up blank or broken.',
        fix: 'Use JPG or PNG for the OG image (1200x630px, under 300KB).', element: null });
    }
    var img = new Image();
    img.onload = function () {
      if (img.naturalWidth < 600 || img.naturalHeight < 315) {
        addFinding({ category: 'Meta & head tags', severity: 'warning', title: 'OG image is too small (' + img.naturalWidth + 'x' + img.naturalHeight + ')',
          description: 'og:image: ' + ogImageUrl, why: 'The recommended minimum for a good preview is 600x315px, ideally 1200x630px (1.91:1).',
          fix: 'Replace it with an image at least 1200x630px.', element: null });
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
        if (len && parseInt(len, 10) > 300 * 1024) {
          addFinding({ category: 'Meta & head tags', severity: 'warning', title: 'OG image is larger than the recommended 300KB (' + fmtBytes(parseInt(len, 10)) + ')',
            description: 'og:image: ' + ogImageUrl, why: 'Some platforms (e.g. WhatsApp) aggressively compress large images, which can degrade preview quality.',
            fix: 'Compress the image to under 300KB.', element: null });
          renderPanel();
        }
      }).catch(function () { /* CORS - ignore silently */ });
    } catch (e) {}
  }

  // ---------------------------------------------------------------------
  // 5.1b Favicon
  // ---------------------------------------------------------------------
  // Google Search Central explicitly documents favicon requirements so a site shows up
  // with its own icon in mobile search results (square, min. 48x48px, must be crawlable).
  // It's not a core ranking factor (same as OG tags), hence "warning" rather than "error"
  // for its absence — but a "nosnippet"-level direct block (robots.txt Disallow) also stays
  // a warning since it only affects the icon display, not the entire page's content.
  function checkFavicon() {
    var head = document.head;
    var linkEl = document.querySelector('link[rel~="icon"]') || document.querySelector('link[rel="shortcut icon"]') || document.querySelector('link[rel="apple-touch-icon"]');
    var faviconUrl;
    try {
      faviconUrl = (linkEl && linkEl.getAttribute('href')) ? new URL(linkEl.getAttribute('href'), location.href).href : (location.origin + '/favicon.ico');
    } catch (e) {
      faviconUrl = location.origin + '/favicon.ico';
    }

    function reportBroken() {
      addFinding({ category: 'Favicon', severity: 'warning', title: 'Favicon is missing or fails to load',
        description: linkEl ? ('A <link> tag was found, but the resource (' + faviconUrl + ') does not load.') : ('There is no <link rel="icon"> in the head, and no fallback /favicon.ico exists either.'),
        why: 'Google Search Central explicitly documents favicon requirements so a site shows up with its own icon in mobile search results and in Chrome tabs/bookmarks — without it a generic icon is shown, which reduces brand recognition and CTR in the SERP.',
        fix: 'Add a favicon in Webflow Site Settings > Icons (square, minimum 48x48px, .ico/.png/.svg).', element: linkEl || head });
    }

    function checkDimensionsAndFormat(url) {
      var ext = (url.split('?')[0].split('.').pop() || '').toLowerCase();
      if (ext && ['ico', 'png', 'svg', 'gif'].indexOf(ext) === -1) {
        addFinding({ category: 'Favicon', severity: 'info', title: 'Favicon is in an unusual format (' + ext.toUpperCase() + ')',
          description: url, why: 'The widest support (browsers, Google Search) is for .ico, .png and .svg formats — other formats can behave unpredictably in browser UI.',
          fix: 'Use the .ico, .png or .svg format for the favicon.', element: linkEl || head });
      }
      var img = new Image();
      img.onload = function () {
        var w = img.naturalWidth, h = img.naturalHeight;
        var issues = [];
        if (w && h && Math.abs(w - h) > 1) issues.push('is not square (' + w + 'x' + h + ')');
        if (w && h && (w < 48 || h < 48)) issues.push('is smaller than the recommended 48x48px (' + w + 'x' + h + ')');
        if (issues.length) {
          addFinding({ category: 'Favicon', severity: 'info', title: 'Favicon dimensions are not ideal (' + issues.join(', ') + ')',
            description: url, why: 'Google recommends a square favicon, minimum 48x48px (in a multiple of that size), so it renders cleanly in search results and browser UI at all resolutions.',
            fix: 'Replace the favicon with a square image at least 48x48px (ideally 128x128px for retina screens).', element: linkEl || head });
        } else if (w && h) {
          addSuccess({ category: 'Favicon', title: 'Favicon is square and an appropriate size (' + w + 'x' + h + ')', description: url, element: linkEl || head });
        }
        renderPanel();
      };
      img.onerror = function () { /* The HEAD fetch above already catches the real "doesn't exist" error — silently ignore here. */ };
      img.src = url;
    }

    function checkRobotsBlock(url) {
      try {
        fetch(location.origin + '/robots.txt').then(function (r) { return r.ok ? r.text() : null; }).then(function (txt) {
          if (!txt) return;
          var path;
          try { path = new URL(url).pathname; } catch (e) { return; }
          var applicable = false, blocked = false;
          txt.split('\n').forEach(function (line) {
            line = line.trim();
            var uaMatch = /^user-agent:\s*(.+)$/i.exec(line);
            if (uaMatch) { applicable = (uaMatch[1].trim() === '*'); return; }
            if (!applicable) return;
            var disallowMatch = /^disallow:\s*(.+)$/i.exec(line);
            if (disallowMatch) {
              var rule = disallowMatch[1].trim();
              if (rule && path.indexOf(rule) === 0) blocked = true;
            }
          });
          if (blocked) {
            addFinding({ category: 'Favicon', severity: 'warning', title: 'Favicon is blocked in robots.txt',
              description: 'The path "' + path + '" is covered by a Disallow rule in /robots.txt (User-agent: *).',
              why: 'If Googlebot can\'t access the favicon file, it can\'t display it in mobile search results either — Google Search Central explicitly requires the favicon URL to be crawlable.',
              fix: 'Add an Allow rule for the favicon path in robots.txt, or narrow the Disallow rule so it doesn\'t cover it.', element: null });
            renderPanel();
          }
        }).catch(function () { /* robots.txt doesn't exist or CORS — ignore silently */ });
      } catch (e) {}
    }

    try {
      fetch(faviconUrl, { method: 'HEAD' }).then(function (r) {
        if (!r.ok) { reportBroken(); renderPanel(); return; }
        var ct = r.headers.get('content-type') || '';
        if (ct && ct.indexOf('image') === -1 && ct.indexOf('icon') === -1) { reportBroken(); renderPanel(); return; }
        addSuccess({ category: 'Favicon', title: 'Favicon is present and loads successfully', description: faviconUrl, element: linkEl || head });
        checkDimensionsAndFormat(faviconUrl);
        checkRobotsBlock(faviconUrl);
        renderPanel();
      }).catch(function () {
        // CORS on a HEAD request rarely happens on the same origin, but just in case we don't
        // report a false error — we just try the dimensions/format (if the image loads at all).
        checkDimensionsAndFormat(faviconUrl);
      });
    } catch (e) {}
  }

  function checkCanonicalDuplication(canonicalEl) {
    var href = canonicalEl.getAttribute('href');
    if (!href) return;
    var canonicalUrl;
    try { canonicalUrl = new URL(href, location.href); } catch (e) { return; }

    var curPath = location.pathname.replace(/\/$/, '');
    var canPath = canonicalUrl.pathname.replace(/\/$/, '');

    if (canonicalUrl.hostname === location.hostname && canPath !== curPath) {
      addFinding({ category: 'URL & page duplication', severity: 'error',
        title: 'Canonical points to a different path on the same site',
        description: 'Current page: ' + curPath + ' | Canonical: ' + canPath,
        why: 'A common cause: the page was duplicated in Webflow and the canonical was left pointing at the original — Google then ignores this page in favor of that other one.',
        fix: 'Check whether this is intentional. If not, fix the canonical in Page Settings to point to this page.', element: canonicalEl,
        crossRelevant: true, crossNote: 'Relevant to both SEO and AEO — an incorrect canonical also confuses AI answer engines about which is the "real" version of the page to cite.',
        crossNoteReverse: 'Relevant to both SEO and AEO — an incorrect canonical splits ranking signals (links, authority) across multiple URLs instead of consolidating them on one page.' });
    } else {
      addSuccess({ category: 'URL & page duplication', title: 'Canonical tag is present and points to this page',
        description: 'Canonical: ' + canPath, element: canonicalEl,
        crossRelevant: true, crossNote: 'Relevant to both SEO and AEO — a clear "primary" URL helps AI answer engines know which version of the page to cite.',
        crossNoteReverse: 'Relevant to both SEO and AEO — a correct canonical consolidates ranking signals onto one, precisely defined URL.' });
    }
  }

  // ---------------------------------------------------------------------
  // 5.10 URL slug (duplication)
  // ---------------------------------------------------------------------

  function checkSlug() {
    var segments = location.pathname.split('/').filter(Boolean);
    var last = segments[segments.length - 1] || '';
    if (/-\d+$/.test(last) && /-[2-9]$/.test(last)) {
      addFinding({ category: 'URL & page duplication', severity: 'error',
        title: 'URL slug ends with a suffix resembling "-2" (' + last + ')',
        description: 'Path: ' + location.pathname,
        why: 'Webflow automatically appends "-2", "-3", etc. to the slug when a page is duplicated. This is concrete, verified evidence that the page was created via duplication and the slug was left untouched before publishing — a direct risk of duplicate content and a non-descriptive URL in search.',
        fix: 'Rename the slug in Page Settings to something descriptive, and set up a 301 redirect from the old one if it\'s already indexed.', element: null });
    } else {
      addSuccess({ category: 'URL & page duplication', title: 'URL slug does not contain a Webflow duplication suffix (e.g. "-2")',
        description: 'Path: ' + location.pathname, element: null });
    }
  }

  // ---------------------------------------------------------------------
  // 5.2 Heading structure
  // ---------------------------------------------------------------------

  function checkHeadings() {
    var headings = Array.prototype.slice.call(document.querySelectorAll('h1,h2,h3,h4,h5,h6')).filter(isVisible);
    var h1s = headings.filter(function (h) { return h.tagName === 'H1'; });

    if (h1s.length === 0) {
      addFinding({ category: 'Heading structure', severity: 'error', title: 'H1 is missing on the page',
        description: 'No visible H1 element was found.', why: 'H1 helps both users and Google immediately understand the topic of the page.',
        fix: 'Add exactly one H1 describing the page\'s main topic.', element: document.body });
    } else if (h1s.length > 1) {
      h1s.slice(1).forEach(function (h) {
        addFinding({ category: 'Heading structure', severity: 'warning', title: 'There is more than one H1 on the page (' + h1s.length + ' total)',
          description: 'Extra H1: "' + text(h).slice(0, 80) + '"', why: 'Multiple H1 tags dilute the signal of the page\'s main topic.',
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
        addFinding({ category: 'Heading structure', severity: 'warning', title: 'Heading hierarchy skips a level (H' + lastLevel + ' → H' + level + ')',
          description: '"' + text(h).slice(0, 80) + '"', why: 'Skipping levels (e.g. H1 then straight to H3) breaks the document\'s logical structure for screen readers and crawlers.',
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
      checked++;
      var fs = parseFloat(window.getComputedStyle(el).fontSize);
      var fw = window.getComputedStyle(el).fontWeight;
      if (fs >= 28 && (fw === 'bold' || parseInt(fw, 10) >= 600)) {
        addFinding({ category: 'Heading structure', severity: 'info', title: 'Text looks like a heading but isn\'t marked up as one',
          description: '"' + t.slice(0, 80) + '" (font-size: ' + fs.toFixed(0) + 'px)',
          why: 'Visually large/bold text outside a heading tag carries no semantic meaning for crawlers and screen readers.',
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
    var declared = { width: null, height: null };

    function applyDecl(styleDecl) {
      if (!styleDecl || !styleDecl.getPropertyValue) return;
      var w = styleDecl.getPropertyValue('width');
      var h = styleDecl.getPropertyValue('height');
      if (w) declared.width = w.trim();
      if (h) declared.height = h.trim();
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

  function checkImages() {
    var imgs = Array.prototype.slice.call(document.querySelectorAll('img'));
    var bothDimsFixedCount = 0;
    var heightOnlyFixedCount = 0;
    var goodAltCount = 0;
    var internalHostCount = 0;
    var modernFormatCount = 0;
    var checkedImgCount = 0;
    var oversizeMeasured = 0, oversizeFound = 0;   // "image much larger than displayed" (28.10.2026)
    var lazyConsidered = 0, lazyFound = 0;         // "below-the-fold image not lazy" (28.10.2026)

    imgs.forEach(function (img) {
      if (!isVisible(img)) return;
      checkedImgCount++;

      // Webflow technically implements "Alt Text: Decorative" by leaving alt="" (EMPTY, but
      // PRESENT attribute). NOTE (10.08.2026, after verification): it's confirmed that the
      // "Decorative" option does generate alt="" (official Webflow changelog), BUT it's not
      // confirmed whether Webflow does the SAME when a developer simply NEVER touches the Alt
      // Text field (doesn't consciously pick "Decorative"). So we can't say with certainty from
      // the HTML alone that "Decorative" was consciously chosen — it could just as easily have
      // been left blank by accident. The message is therefore deliberately phrased as "possibly",
      // not as a confirmed fact.
      var hasAltAttr = img.hasAttribute('alt');
      var altText = hasAltAttr ? (img.getAttribute('alt') || '').trim() : '';
      var isDecorative = hasAltAttr && altText === '';
      var isMissing = !hasAltAttr;
      var isGeneric = hasAltAttr && altText !== '' && GENERIC_ALT_PATTERNS.test(altText);
      // 28.10.2026: an SVG (icon/illustration) with alt="" is the standard decorative pattern —
      // on honeybook.com ~90% of the "empty alt" notes were SVG icons, so they're treated as fine.
      var imgSrcStr = img.currentSrc || img.src || '';
      var isSvgImg = /\.svg(\?|#|$)/i.test(imgSrcStr) || /^data:image\/svg/i.test(imgSrcStr);

      if (isDecorative && isSvgImg) {
        goodAltCount++;
      } else if (isDecorative) {
        addFinding({ category: 'Images', severity: 'info',
          title: 'Alt text is empty (alt="") — likely set to "Decorative" in Webflow',
          description: (img.currentSrc || img.src || '').slice(0, 120),
          why: 'An empty but PRESENT alt="" is the correct ARIA pattern when an image has been CONSCIOUSLY marked as decorative in Webflow (the screen reader then skips it). We CANNOT determine with certainty from the HTML alone whether this was done deliberately or the Alt Text field was simply left untouched/forgotten — both cases can look identical in the rendered code.',
          fix: 'Check directly in the Webflow Designer (Image Settings) whether the Alt Text field really shows "Decorative". If so — no action needed. If the image should actually have descriptive alt text, add it.',
          element: img });
      } else if (isMissing || isGeneric) {
        addFinding({ category: 'Images', severity: 'error',
          title: isMissing ? 'Image: alt attribute is missing' : 'Image: generic alt text ("' + altText + '")',
          description: (img.currentSrc || img.src || '').slice(0, 120),
          why: 'Alt text describes the image to search engines and screen readers; without descriptive alt text, the image is "invisible" for SEO and accessibility.',
          fix: 'Add descriptive alt text in the Webflow Asset Manager (or deliberately set it to "Decorative" if the image is truly purely decorative).',
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
      var heightFixed = img.hasAttribute('height') || isLengthFixed(declared.height);
      var widthFixed = img.hasAttribute('width') || isLengthFixed(declared.width);

      if (heightFixed) {
        if (widthFixed) {
          bothDimsFixedCount++;
        } else {
          heightOnlyFixedCount++;
        }
      } else {
        addFinding({ category: 'Images', severity: 'error',
          title: 'Image has no fixed height (neither HTML attribute nor CSS)',
          description: (img.currentSrc || img.src || '').slice(0, 120) +
            '\nCSS width: ' + (declared.width || 'not found/defined') +
            ' | CSS height: ' + (declared.height || 'not found/defined'),
          why: 'Neither the HTML height attribute nor CSS fixes the height (the value is "auto" or not defined at all) — the browser can\'t reserve vertical space for the image in advance, which genuinely causes layout shift (CLS) while the image loads. CLS is an official Google Core Web Vital/ranking signal, so this is a verified cause of a concrete problem with a measurable SEO impact, not just a theoretical risk. Width isn\'t a factor here — a fixed width alone doesn\'t reserve vertical space.',
          fix: 'Add an explicit height (an HTML height attribute, or CSS height in any unit — px, rem, vw...) directly on the <img> tag or in the Style panel. Width can stay auto.',
          element: img });
      }

      // Oversized image + below-the-fold lazy-loading (28.10.2026). Both use the image that was
      // ACTUALLY chosen by the browser (currentSrc / naturalWidth), so Webflow's responsive
      // srcset variants are taken into account. SVGs/data URIs are skipped (vector / tiny).
      var rectNow = img.getBoundingClientRect();
      var shownW = Math.round(rectNow.width);
      var natW = img.naturalWidth || 0;
      var srcNow = img.currentSrc || img.src || '';
      var skipSizing = /\.svg(\?|#|$)/i.test(srcNow) || /^data:/i.test(srcNow);
      if (!skipSizing && natW > 0 && shownW >= 48) {
        oversizeMeasured++;
        var allowedW = shownW * 2; // up to 2x the displayed width is normal (retina screens)
        if (natW > allowedW * 1.25 && natW - allowedW > 300) {
          oversizeFound++;
          addFinding({ category: 'Images', severity: natW > allowedW * 2 ? 'warning' : 'info',
            title: 'Image is much larger than it is displayed (' + natW + 'px file shown at ' + shownW + 'px)',
            description: srcNow.replace(/\?.*$/, '').slice(0, 120),
            why: 'The browser downloads a ' + natW + 'px-wide file to draw it ' + shownW + 'px wide (even on a 2x retina screen only ~' + allowedW + 'px is useful). The extra bytes slow loading and hurt LCP, a Core Web Vital / ranking signal.',
            fix: 'Upload a version closer to the displayed size (about 2x the width it is shown at), or let Webflow\'s responsive image variants do it by setting the image\'s size in the Designer.', element: img });
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
              fix: 'In the Webflow Designer: select the image > Settings > Loading > "Lazy" (keep "Eager" only for the hero / above-the-fold images).', element: img });
          }
        }
      }

      var src = img.currentSrc || img.src || '';
      var host = hostnameOf(src);
      var isExternal = host && host !== location.hostname && !isWebflowAssetHost(host) && !isSameSite(host);

      if (isExternal) {
        addFinding({ category: 'Images', severity: 'error', title: 'Image is hosted on an external server',
          description: src, why: 'If that external server/project goes offline (a common case with WordPress or other migration leftovers), the image disappears from the page. File size isn\'t measured here since the server is outside our control.',
          fix: 'Download the image and upload it directly to Webflow Assets.', element: img });
      } else {
        internalHostCount++;
        var ext = (src.split('?')[0].split('.').pop() || '').toLowerCase();
        if (['jpg', 'jpeg', 'png', 'gif'].indexOf(ext) !== -1) {
          addFinding({ category: 'Images', severity: 'info', title: 'Image is not in a modern format (currently: ' + ext.toUpperCase() + ')',
            description: src, why: 'AVIF/WebP produce a significantly smaller file size at the same quality, which speeds up page loading.',
            fix: 'Convert it to WebP or AVIF (Webflow has an automatic image optimization option in the Asset Manager).', element: img });
        } else if (['webp', 'avif'].indexOf(ext) !== -1) {
          modernFormatCount++;
        }

        try {
          fetch(src, { method: 'HEAD' }).then(function (r) {
            var len = r.headers.get('content-length');
            if (len && parseInt(len, 10) > 500 * 1024) {
              addFinding({ category: 'Images', severity: 'error', title: 'Image is larger than 500KB (' + fmtBytes(parseInt(len, 10)) + ')',
                description: src, why: 'Large images slow down page loading and hurt LCP (Largest Contentful Paint) — an official Google Core Web Vital/ranking signal. The file size is directly measured (content-length header), not an assumption.',
                fix: 'Compress the image (e.g. TinyPNG/Squoosh) or convert it to WebP/AVIF.', element: img });
              renderPanel();
            }
          }).catch(function () {});
        } catch (e) {}
      }
    });

    ['img.alt', 'img.height', 'img.external', 'img.format', 'img.size'].forEach(function (id) { setCheckTotal(id, checkedImgCount); });
    setCheckTotal('img.oversize', oversizeMeasured);
    setCheckTotal('img.lazy', lazyConsidered);
    if (oversizeMeasured > 0 && oversizeFound === 0) {
      addSuccess({ category: 'Images', title: 'No image is much larger than its displayed size (' + oversizeMeasured + ' measured)', description: '', element: null });
    }
    if (lazyConsidered > 0 && lazyFound === 0) {
      addSuccess({ category: 'Images', title: 'All ' + lazyConsidered + ' below-the-fold images are lazy-loaded', description: '', element: null });
    }
    if (checkedImgCount > 0 && goodAltCount > 0) {
      addSuccess({ category: 'Images', title: goodAltCount + ' of ' + checkedImgCount + ' visible images have descriptive (or deliberately decorative) alt text',
        description: '', element: null });
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
    var NOINDEX_NOTE = 'Relevant to both SEO and AEO — a page blocked from indexing won\'t appear in the sources AI answer engines (partly) rely on via the Google index either.';

    // 1) X-Robots-Tag response header (can block indexing without anything visible in the HTML)
    try {
      var reqOpts = { cache: 'no-store', credentials: 'same-origin' };
      fetch(location.href, Object.assign({ method: 'HEAD' }, reqOpts)).then(function (r) {
        return (r.status === 405 || r.status === 501) ? fetch(location.href, Object.assign({ method: 'GET' }, reqOpts)) : r;
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
            why: 'The server tells search engines not to show a text snippet for this page, which hurts click-through and AI-answer citations.',
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
      if (/\.webflow\.io$/.test(location.hostname)) return; // staging: sitemap is normally off, the staging note already covers it
      var norm = function (u) {
        try {
          var x = new URL(u, location.href);
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
      readSitemap(location.origin + '/sitemap.xml', 0, true).then(function (locs) {
        if (!locs) {
          if (sitemapRootError) reportCheckSkipped('Sitemap check', [sitemapRootError]); // a missing sitemap (404) stays silent: site-level matter
          return;
        }
        var set = {};
        locs.forEach(function (u) { var n = norm(u); if (n != null) set[n] = true; });
        var canon = document.querySelector('link[rel="canonical"]');
        var me = norm(location.href);
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
            description: 'Checked ' + location.origin + '/sitemap.xml (' + locs.length + ' URLs)',
            why: 'The sitemap tells search engines which URLs to crawl. A page missing from it can still be indexed through links, but it is discovered slower and signals that it may be unimportant.' +
              (intentional ? ' This looks intentional here (the page is noindex or its canonical points elsewhere).' : ''),
            fix: 'In the Webflow Designer: Pages > this page > Settings > SEO — make sure "Exclude this page from the sitemap" is off, then publish. Also check Project Settings > SEO > Sitemap is enabled (auto-generate).',
            element: null });
        }
        renderPanel();
      }).catch(function () { /* unexpected error in the check itself */ });
    } catch (e) {}
  }

  // ---------------------------------------------------------------------
  // 5.4 Links
  // ---------------------------------------------------------------------

  var GENERIC_ANCHOR = /^(klikni ovde|click here|read more|saznaj vi[sš]e|vi[sš]e|ovde|here|link)$/i;

  function checkLinks() {
    var links = Array.prototype.slice.call(document.querySelectorAll('a'));
    var internalToCheck = [];
    var checkedLinkCount = 0;
    var emptyHrefFound = false;
    var brokenAnchorFound = false;
    var noTextLinkFound = false;

    links.forEach(function (a) {
      if (!isVisible(a)) return;
      checkedLinkCount++;
      var href = a.getAttribute('href');
      var isEmpty = !href || href.trim() === '' || href.trim() === '#' || /^javascript:/i.test(href.trim());
      var hasCompensatingRole = a.getAttribute('role') === 'tab' || a.getAttribute('role') === 'button';

      if (isEmpty && !hasCompensatingRole) {
        emptyHrefFound = true;
        addFinding({ category: 'Links', severity: 'warning', title: 'Link doesn\'t go anywhere (href="' + (href || '') + '")',
          description: '"' + text(a).slice(0, 60) + '"',
          why: 'If this represents a tab/accordion that only changes the display on the same page, the correct approach per the WAI-ARIA Tabs pattern is a <button> with role="tab", not an <a> link — a link semantically implies navigation.',
          fix: 'If the element doesn\'t navigate anywhere, change it to a <button> (or add role="tab"/role="button" plus the corresponding ARIA attributes). In Webflow, a link used only as an interaction trigger (e.g. closing a popup) is a very common pattern — if that is what this is, it is a minor note rather than a real problem.', element: a });
      }

      // In-page anchor targets
      if (href && href.charAt(0) === '#' && href.length > 1) {
        var targetId = href.slice(1);
        if (!document.getElementById(targetId) && !document.getElementsByName(targetId).length) {
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
          description: 'href: ' + href, why: 'Descriptive anchor text helps users and Google understand where the link leads.',
          fix: 'Replace it with descriptive text (e.g. "View pricing" instead of "click here").', element: a });
      }

      if (href && !isEmpty && sameHost(href, location.hostname)) {
        internalToCheck.push({ el: a, href: href });
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
    var toCheck = internalToCheck.slice(0, 25);
    setCheckTotal('links.internal', toCheck.length);
    var linkCheckSettled = 0;
    var linkCheckProblemFound = false;
    function maybeReportLinkCheckSuccess() {
      linkCheckSettled++;
      if (linkCheckSettled === toCheck.length && !linkCheckProblemFound) {
        addSuccess({ category: 'Links', title: 'All checked internal links (' + toCheck.length + ') return a successful response with no 404/redirect',
          description: '', element: null });
        renderPanel();
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
              description: item.href, why: 'It isn\'t broken, but a redirect slows things down and dilutes the link signal.',
              fix: 'If possible, update the link to point directly to the final URL.', element: item.el,
              ownerNote: 'In Webflow you can only point the link straight at the final URL. If the redirect itself is configured at the reverse proxy / Cloudflare / app level (e.g. www → app subdomain), removing it needs access to that platform.' });
            renderPanel();
          }
          maybeReportLinkCheckSuccess();
        }).catch(function () { /* CORS / network - ignore */ maybeReportLinkCheckSuccess(); });
      } catch (e) { maybeReportLinkCheckSuccess(); }
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

    // Thin content
    var visibleTextLen = text(main).replace(/\s+/g, ' ').length;
    if (visibleTextLen < 200) {
      addFinding({ category: 'Content', severity: 'warning', title: 'Very little visible text on the page (' + visibleTextLen + ' characters)',
        description: '', why: 'Pages with very little text tend to rank worse for relevant queries (thin content).',
        fix: 'Add more relevant, useful content.', element: main,
        crossRelevant: true, crossNote: 'Relevant to both SEO and AEO — AI answer engines cite pages that have enough substance to directly answer the question; "thin content" is rarely cited.',
        crossNoteReverse: 'Relevant to both SEO and AEO — Google traditionally ranks "thin content" pages lower because they don\'t provide enough value to the user compared to the competition.' });
    } else {
      addSuccess({ category: 'Content', title: 'The page has enough visible text (' + visibleTextLen + ' characters)', description: '', element: main,
        crossRelevant: true, crossNote: 'Relevant to both SEO and AEO — AI answer engines cite pages that have enough substance to directly answer the question.',
        crossNoteReverse: 'Relevant to both SEO and AEO — a sufficient amount of quality content is a basic prerequisite for Google to consider the page worth ranking.' });
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
      '[class*="tooltip" i]', '[class*="toast" i]', '[class*="overlay" i]', '[class*="cookie" i]', '[class*="consent" i]'
    ].join(',');
    var allBodyEls = Array.prototype.slice.call(document.querySelectorAll('body *'));
    var hiddenBlocks = [];
    var hiddenTexts = [];
    for (var hi = 0; hi < allBodyEls.length; hi++) {
      var hel = allBodyEls[hi];
      if (HIDDEN_SKIP_TAGS.test(hel.tagName)) continue;
      var hstyle = window.getComputedStyle(hel);
      if (hstyle.display !== 'none' && hstyle.visibility !== 'hidden') continue;
      if (hiddenBlocks.some(function (blk) { return blk.contains(hel); })) continue;
      var inUi = false;
      try { inUi = !!hel.closest(HIDDEN_UI_SELECTOR); } catch (e) {}
      if (inUi) continue;
      // Text WITHOUT <script>/<style>/<noscript>/<template> descendants: Webflow Embed elements
      // (".w-embed" with display:none) are wrappers around inline CSS/JS, which is code, not content.
      var hclone = hel.cloneNode(true);
      Array.prototype.forEach.call(hclone.querySelectorAll('script,style,noscript,template'), function (n) { n.remove(); });
      var htxt = (hclone.textContent || '').replace(/\s+/g, ' ').trim();
      if (htxt.length > 60) { hiddenBlocks.push(hel); hiddenTexts.push(htxt); }
    }
    if (hiddenBlocks.length) {
      addFinding({ category: 'Content', severity: 'info',
        title: 'Hidden content with a substantial amount of text (' + hiddenBlocks.length + ' block' + (hiddenBlocks.length === 1 ? '' : 's') + ', display:none/visibility:hidden)',
        description: 'First ' + Math.min(3, hiddenBlocks.length) + ':\n' + hiddenTexts.slice(0, 3).map(function (t) { return '"' + t.slice(0, 80) + '..."'; }).join('\n'),
        why: 'Hidden text with a lot of words can look like an attempt at keyword stuffing, even if unintentional (e.g. a forgotten tab panel). Menus, popups, tabs, accordions and sliders are ignored, since they are hidden by design.',
        fix: 'Check whether this content should be visible, or remove it if it\'s leftover from development.', element: hiddenBlocks[0] });
    }

    // Repeated consecutive word
    var bodyText = text(main);
    var repeatRegex = /\b(\w{2,})\s+\1\b/gi;
    var seenRepeats = {};
    var m;
    var repeatedWordFound = false;
    while ((m = repeatRegex.exec(bodyText)) !== null) {
      var word = m[1].toLowerCase();
      if (seenRepeats[word]) continue;
      seenRepeats[word] = true;
      repeatedWordFound = true;
      addFinding({ category: 'Content', severity: 'warning', title: 'Repeated word in a row: "' + m[1] + ' ' + m[1] + '"',
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

    // Manual <br> line breaks inside headings/paragraphs
    var brCandidates = Array.prototype.slice.call(document.querySelectorAll('h1,h2,h3,h4,h5,h6,p'));
    brCandidates.forEach(function (el) {
      if (!isVisible(el)) return;
      var brCount = el.querySelectorAll('br').length;
      if (brCount >= 1) {
        addFinding({ category: 'Content', severity: 'info', title: 'Manual <br> line break inside a ' + el.tagName.toLowerCase() + ' element',
          description: '"' + text(el).slice(0, 80) + '"',
          why: 'This doesn\'t directly affect SEO ranking, but a line break fixed for desktop layout can "break" and wrap the text oddly on mobile (a mobile-first indexing experience signal).',
          fix: 'Consider a CSS solution (max-width, responsive font-size) instead of a manual <br>.', element: el });
      }
    });
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

    if (distinct.length >= 4) {
      addFinding({ category: 'Fonts', severity: 'warning', title: 'The page uses ' + distinct.length + ' different fonts: ' + distinct.join(', '),
        description: '', why: 'Every additional font is another file to download and a risk of FOUT/FOIT, which hurts performance.',
        fix: 'Reduce the number of fonts to 1-2 (e.g. one for headings, one for body text).', element: null });
    } else if (distinct.length >= 2) {
      addFinding({ category: 'Fonts', severity: 'info', title: 'The page uses ' + distinct.length + ' fonts: ' + distinct.join(', '),
        description: '', why: 'Informational only — doesn\'t affect the SEO score, but worth being aware of.',
        fix: '', element: null });
    } else if (distinct.length === 1) {
      addSuccess({ category: 'Fonts', title: 'The page uses only 1 font (' + distinct[0] + ') — minimal risk of FOUT/FOIT', description: '', element: null });
    }

    // Google Fonts vs self-hosted
    var links = Array.prototype.slice.call(document.querySelectorAll('link[href], style'));
    var usesGoogleFonts = false;
    links.forEach(function (el) {
      var src = el.tagName === 'LINK' ? el.getAttribute('href') : el.textContent;
      if (src && /fonts\.googleapis\.com|fonts\.gstatic\.com/i.test(src)) usesGoogleFonts = true;
    });
    if (usesGoogleFonts) {
      addFinding({ category: 'Fonts', severity: 'warning', title: 'The page dynamically loads Google Fonts from Google\'s servers',
        description: '', why: 'A German court (LG München I, 01/2022) ruled that dynamically loading Google Fonts without consent sends the visitor\'s IP address to Google without a legal basis under the GDPR, which triggered a wave of warning letters (mostly in Germany, but the GDPR applies across the EU). We are not legal advisors — check with a lawyer if this is relevant for the client.',
        fix: 'Download the font files and upload them directly to Webflow Assets (self-hosting) instead of a dynamic Google Fonts link.', element: null });
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
    var sheets = document.styleSheets;
    for (var i = 0; i < sheets.length; i++) {
      try {
        var rules = sheets[i].cssRules || [];
        for (var j = 0; j < rules.length; j++) {
          if (rules[j].constructor.name === 'CSSFontFaceRule' || (rules[j].cssText && /@font-face/.test(rules[j].cssText))) {
            fontFaceRuleFound = true;
            if (/\.(ttf|otf|eot)(\?|"|'|\))/i.test(rules[j].cssText) && !/\.woff2/i.test(rules[j].cssText)) {
              oldFormatFound = true;
            }
          }
        }
      } catch (e) { /* cross-origin stylesheet, can't read rules */ }
    }
    if (oldFormatFound) {
      addFinding({ category: 'Fonts', severity: 'info', title: 'Font file in an older format (not .woff2)',
        description: '', why: '.woff2 has significantly better compression than .ttf/.otf/.eot — a smaller file means faster loading.',
        fix: 'Convert the font files to .woff2 before uploading to Webflow.', element: null });
    } else if (fontFaceRuleFound) {
      addSuccess({ category: 'Fonts', title: 'All @font-face files are in the modern .woff2 format', description: '', element: null });
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
    var totalNodes = document.querySelectorAll('*').length;
    var maxDepth = 0, maxChildren = 0;
    (function walk(el, depth) {
      if (depth > maxDepth) maxDepth = depth;
      var childCount = el.children ? el.children.length : 0;
      if (childCount > maxChildren) maxChildren = childCount;
      for (var i = 0; i < childCount; i++) walk(el.children[i], depth + 1);
    })(document.body, 0);

    if (totalNodes > 1500 || maxDepth > 32 || maxChildren > 60) {
      addFinding({ category: 'Technical / crawlability', severity: 'info', title: 'Large/deeply nested DOM (nodes: ' + totalNodes + ', max depth: ' + maxDepth + ', max children of one element: ' + maxChildren + ')',
        description: '', why: 'An overly large DOM slows down rendering and makes it harder for crawlers to parse efficiently. This is a recommendation, not an error — if it\'s intentional and doesn\'t cause a visible problem, it can be ignored.',
        fix: 'Consider simplifying the section structure (fewer nested wrapper divs).', element: null,
        crossRelevant: true, crossNote: 'Relevant to both SEO and AEO — a simpler DOM is easier for faster/simpler AI crawlers to parse.',
        crossNoteReverse: 'Relevant to both SEO and AEO — an overly large/deeply nested DOM slows down rendering, which indirectly hurts the Core Web Vitals metrics Google uses for ranking.' });
    } else {
      addSuccess({ category: 'Technical / crawlability', title: 'DOM size/depth is within reasonable limits (nodes: ' + totalNodes + ', max depth: ' + maxDepth + ')', description: '', element: null,
        crossRelevant: true, crossNote: 'Relevant to both SEO and AEO — a simpler DOM is easier for faster/simpler AI crawlers to parse.',
        crossNoteReverse: 'Relevant to both SEO and AEO — a reasonable DOM size contributes to faster rendering and better Core Web Vitals results.' });
    }

    // Mixed content
    if (location.protocol === 'https:') {
      var httpResources = Array.prototype.slice.call(document.querySelectorAll('img[src^="http://"], script[src^="http://"], link[href^="http://"], iframe[src^="http://"]'));
      httpResources.forEach(function (el) {
        addFinding({ category: 'Technical / crawlability', severity: 'error', title: 'Mixed content: HTTP resource on an HTTPS page',
          description: (el.src || el.href || ''), why: 'The browser may block or warn about this resource, and it is a security signal.',
          fix: 'Change the resource URL to https://.', element: el,
          crossRelevant: true, crossNote: 'Relevant to both SEO and AEO — HTTPS/security is one of the Tier-1 technical signals AI answer engines factor into assessing source trustworthiness.',
          crossNoteReverse: 'Relevant to both SEO and AEO — HTTPS has been a confirmed Google ranking signal since 2014, and mixed content warnings in the browser undermine user trust.' });
      });
      if (!httpResources.length) {
        addSuccess({ category: 'Technical / crawlability', title: 'No mixed content — all resources load over HTTPS', description: '', element: null,
          crossRelevant: true, crossNote: 'Relevant to both SEO and AEO — HTTPS is a Tier-1 technical trust signal for sources.',
          crossNoteReverse: 'Relevant to both SEO and AEO — full HTTPS with no mixed content warnings is a confirmed Google ranking signal.' });
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
      if (!host || host === location.hostname) return;
      var isPlatform = isWebflowPlatformScript(host, src);
      if (!isPlatform) thirdPartyScriptCount++;
      if (s.async || s.defer) return;

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
        why: 'A script without async/defer blocks parsing/rendering of the page at that point until it\'s downloaded and executed from the external server — one of the most common, well-documented causes of poor LCP (a Core Web Vital/ranking signal). The presence/absence of the attribute is directly verified on the <script> tag, not an assumption.' +
          (inHead ? '' : ' This one sits at the end of <body>, where it blocks very little (it mostly delays DOMContentLoaded), so it is only a minor note.'),
        fix: 'Add the "defer" attribute (recommended for scripts where execution order/DOM readiness matters — most chat widgets and tracking pixels) or "async" (for fully independent scripts). Even better: move the script into Page Settings > Custom Code > "Before </body> tag" instead of the <head>.',
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

  function measureCWV(done) {
    try {
      var nav = performance.getEntriesByType('navigation')[0];
      if (nav) cwv.ttfb = Math.round(nav.responseStart - nav.requestStart);
    } catch (e) {}

    try {
      var lcpEntries = performance.getEntriesByType('largest-contentful-paint');
      if (lcpEntries.length) cwv.lcp = Math.round(lcpEntries[lcpEntries.length - 1].startTime);
    } catch (e) {}

    try {
      var clsEntries = performance.getEntriesByType('layout-shift');
      var sum = 0;
      clsEntries.forEach(function (entry) { if (!entry.hadRecentInput) sum += entry.value; });
      cwv.cls = Math.round(sum * 1000) / 1000;
    } catch (e) {}

    var CWV_CROSS_NOTE = 'Relevant to both SEO and AEO — Core Web Vitals are part of the Tier-1 technical signals that AEO research links to the likelihood of AI citation.';
    var CWV_CROSS_NOTE_REVERSE = 'Relevant to both SEO and AEO — Core Web Vitals (TTFB, LCP, CLS) have been an official Google ranking signal since 2021 (the Page Experience update).';

    // Two thresholds per metric (aligned with Google's official "Needs Improvement" / "Poor"
    // thresholds for LCP and CLS; TTFB isn't an official Core Web Vital, but 1800ms is a common
    // "poor" threshold in web.dev recommendations) — a mild "warning", deep into "Poor"
    // territory an "error".
    if (cwv.ttfb != null && cwv.ttfb > 800) {
      var ttfbPoor = cwv.ttfb > 1800;
      addFinding({ category: 'Performance (CWV)', severity: ttfbPoor ? 'error' : 'warning', title: 'Slow TTFB (Time To First Byte): ' + cwv.ttfb + 'ms',
        description: '', why: (ttfbPoor ? 'Over 1800ms is deep into "poor" territory. ' : 'Over 800ms is slow. ') + 'The server responds slowly to the initial request.', fix: 'Check custom code/integrations that could be slowing down the server response.', element: null,
        crossRelevant: true, crossNote: CWV_CROSS_NOTE, crossNoteReverse: CWV_CROSS_NOTE_REVERSE });
    } else if (cwv.ttfb != null) {
      addSuccess({ category: 'Performance (CWV)', title: 'TTFB is good (' + cwv.ttfb + 'ms, under the 800ms threshold)', description: '', element: null,
        crossRelevant: true, crossNote: CWV_CROSS_NOTE, crossNoteReverse: CWV_CROSS_NOTE_REVERSE });
    }
    if (cwv.lcp != null && cwv.lcp > 2500) {
      var lcpPoor = cwv.lcp > 4000;
      addFinding({ category: 'Performance (CWV)', severity: lcpPoor ? 'error' : 'warning', title: 'Slow LCP (Largest Contentful Paint): ' + cwv.lcp + 'ms',
        description: '', why: 'Google considers a good LCP to be under 2500ms' + (lcpPoor ? ', and over 4000ms falls into the "Poor" category' : '') + '. A slower LCP usually means the largest element (most often the hero image) is too big or loads slowly.',
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
      var lcpList = performance.getEntriesByType('largest-contentful-paint');
      var lcpEl = lcpList.length ? lcpList[lcpList.length - 1].element : null;
      if (lcpEl && lcpEl.tagName === 'IMG') {
        if ((lcpEl.getAttribute('loading') || '').toLowerCase() === 'lazy') {
          addFinding({ category: 'Performance (CWV)', severity: 'warning', title: 'The LCP image is lazy-loaded (loading="lazy")',
            description: (lcpEl.currentSrc || lcpEl.src || '').replace(/\?.*$/, '').slice(0, 120),
            why: 'The largest above-the-fold image is the LCP element. With loading="lazy" the browser postpones fetching it until layout is known, which delays LCP (a Core Web Vital / ranking signal).',
            fix: 'In the Webflow Designer: select the image > Settings > Loading > "Eager". Optionally also add the custom attribute fetchpriority="high".', element: lcpEl,
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
        description: '', why: 'Over 0.1 means noticeable content "jumping" during load' + (clsPoor ? ' (over 0.25 is Google\'s "Poor" threshold)' : '') + ' — most often due to images/fonts without reserved space.',
        fix: 'Add width/height to images, check font-display settings.', element: null,
        crossRelevant: true, crossNote: CWV_CROSS_NOTE, crossNoteReverse: CWV_CROSS_NOTE_REVERSE });
    } else {
      addSuccess({ category: 'Performance (CWV)', title: 'CLS is good (' + cwv.cls + ', under Google\'s 0.1 threshold)', description: '', element: null,
        crossRelevant: true, crossNote: CWV_CROSS_NOTE, crossNoteReverse: CWV_CROSS_NOTE_REVERSE });
    }

    if (done) setTimeout(done, 1200); // give the PerformanceObserver buffer some time
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
        var items = Array.isArray(parsed) ? parsed : (parsed && parsed['@graph'] ? parsed['@graph'] : [parsed]);
        items.forEach(function (item) { if (item) blocks.push({ raw: item, el: s }); });
      } catch (e) {
        invalidFound = true;
        addFinding({ category: 'AEO - Structured data (Schema.org)', group: 'aeo', severity: 'error',
          title: 'JSON-LD schema block contains invalid JSON',
          description: (s.textContent || '').slice(0, 150),
          why: 'Invalid JSON in a <script type="application/ld+json"> is completely ignored by Google and AI crawlers — the entire schema markup is useless until the syntax is fixed.',
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
    return Array.isArray(t) ? t : [t];
  }

  function findSchemaByType(blocks, type) {
    return blocks.filter(function (b) { return schemaTypesOf(b).indexOf(type) !== -1; });
  }

  function looksLikeFAQ() {
    var candidates = document.querySelectorAll('[class*="faq" i], [id*="faq" i]');
    if (candidates.length > 0) return true;
    var headings = Array.prototype.slice.call(document.querySelectorAll('h2,h3,h4')).filter(isVisible);
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
    return /^\/(blog|posts?|articles?|news|insights|learn|resources|stories)\/[^\/]+/i.test(location.pathname) && wordCount > 300;
  }

  function looksLikeBreadcrumbUI() {
    return !!document.querySelector('[class*="breadcrumb" i], [aria-label*="breadcrumb" i], nav[aria-label*="breadcrumb" i]');
  }

  function checkAEO() {
    var blocks = getJsonLdBlocks();

    // FAQPage
    var faqSchemas = findSchemaByType(blocks, 'FAQPage');
    if (looksLikeFAQ() && faqSchemas.length === 0) {
      addFinding({ category: 'AEO - Structured data (Schema.org)', group: 'aeo', severity: 'warning',
        title: 'Page looks like a FAQ section but has no FAQPage schema markup',
        description: 'FAQ-like elements were found (classes/IDs containing "faq", or 3+ question-style headings) without a corresponding JSON-LD FAQPage schema.',
        why: 'Based on AEO research so far, FAQPage schema is the single strongest predictor that an AI answer engine (ChatGPT, Perplexity, Google AI Overviews) will cite the page as a source of an answer.',
        fix: 'Add a JSON-LD FAQPage schema block (a mainEntity array of Question/acceptedAnswer objects) matching the visible questions and answers on the page.', element: null });
    } else if (faqSchemas.length) {
      faqSchemas.forEach(function (b) {
        var entities = b.raw.mainEntity;
        var arr = Array.isArray(entities) ? entities : (entities ? [entities] : []);
        if (!arr.length) {
          addFinding({ category: 'AEO - Structured data (Schema.org)', group: 'aeo', severity: 'error',
            title: 'FAQPage schema has no mainEntity (questions)',
            description: '', why: 'A FAQPage without a mainEntity array of Question objects is incomplete and won\'t be used for FAQ rich results or AI citation.',
            fix: 'Add a mainEntity array with Question/acceptedAnswer objects for every question on the page.', element: b.el });
        } else {
          var badItems = arr.filter(function (q) { return !q.acceptedAnswer || !q.acceptedAnswer.text; });
          if (badItems.length) {
            addFinding({ category: 'AEO - Structured data (Schema.org)', group: 'aeo', severity: 'error',
              title: badItems.length + ' question(s) in the FAQPage schema have no acceptedAnswer.text filled in',
              description: '', why: 'Incomplete questions won\'t be used for FAQ rich results/AI citation. This is a verified fact about the schema JSON structure itself (not a heuristic or assumption) — every such question is effectively useless until filled in.',
              fix: 'Fill in acceptedAnswer.text for every Question in the schema.', element: b.el });
          } else {
            addSuccess({ category: 'AEO - Structured data (Schema.org)', group: 'aeo',
              title: 'FAQPage schema is present and complete (' + arr.length + ' questions with answers)', description: '', element: b.el });
          }
        }
      });
    }

    // Article / BlogPosting / NewsArticle
    var articleSchemas = findSchemaByType(blocks, 'Article').concat(findSchemaByType(blocks, 'BlogPosting'), findSchemaByType(blocks, 'NewsArticle'));
    if (looksLikeArticle() && articleSchemas.length === 0) {
      addFinding({ category: 'AEO - Structured data (Schema.org)', group: 'aeo', severity: 'warning',
        title: 'Page looks like an article/blog post but has no Article schema markup',
        description: 'An <article> element with substantial text, og:type="article", or a blog-style URL was found, without a JSON-LD Article/BlogPosting schema.',
        why: 'Article schema helps AI answer engines and Google understand the author, publish/modified date, and topic of the page — all Tier-1 technical AEO signals.',
        fix: 'Add a JSON-LD Article schema with headline, author, datePublished, dateModified.', element: null });
    } else {
      articleSchemas.forEach(function (b) {
        if (!b.raw.dateModified && !b.raw.datePublished) {
          addFinding({ category: 'AEO - Structured data (Schema.org)', group: 'aeo', severity: 'error',
            title: 'Article schema has neither dateModified nor datePublished',
            description: '', why: 'AI answer engines prefer fresh/recently updated sources — without a date there is no freshness signal for the content, and this is a Tier-1 AEO signal. A verified fact about the schema JSON (the field is missing or absent), not a heuristic.',
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
                  why: 'An invalid author link weakens the E-E-A-T (Experience-Expertise-Authoritativeness-Trust) signal that AI answer engines and Google use to assess source credibility.',
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
            description: '', why: 'Author is one of the E-E-A-T signals AI answer engines factor into assessing content trustworthiness.',
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
      var schemaPhone = (b.raw.telephone || '').replace(/[^\d]/g, '');
      if (schemaPhone) {
        var footerDigits = footerText.replace(/[^\d]/g, '');
        if (footerDigits.indexOf(schemaPhone) === -1) {
          napIssueFound = true;
          addFinding({ category: 'AEO - NAP consistency', group: 'aeo', severity: 'warning',
            title: 'Phone number in the Organization/LocalBusiness schema doesn\'t match the number in the footer',
            description: 'Schema telephone: ' + b.raw.telephone,
            why: 'A NAP (Name-Address-Phone) mismatch between schema markup and visible content is a signal that AI answer engines and Google may interpret as an unreliable/outdated data source.',
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
            why: 'A NAP mismatch (an address listed in the schema that doesn\'t appear anywhere visibly on the page) weakens trust in the structured data.',
            fix: 'Display the same address visibly (e.g. in the footer) or remove it from the schema if it\'s no longer accurate.', element: b.el });
        }
      }

      if (!napIssueFound && (schemaPhone || addrStr)) {
        addSuccess({ category: 'AEO - NAP consistency', group: 'aeo',
          title: 'NAP data (phone/address) from the schema markup is consistent with the footer', description: '', element: b.el });
      }
    });

    // BreadcrumbList
    var breadcrumbSchemas = findSchemaByType(blocks, 'BreadcrumbList');
    if (looksLikeBreadcrumbUI() && breadcrumbSchemas.length === 0) {
      addFinding({ category: 'AEO - Structured data (Schema.org)', group: 'aeo', severity: 'info',
        title: 'A visible breadcrumb UI exists, but there is no BreadcrumbList schema markup',
        description: '', why: 'BreadcrumbList schema helps AI answer engines and Google understand the page\'s hierarchy/context within the site.',
        fix: 'Add a JSON-LD BreadcrumbList schema matching the visible breadcrumb navigation.', element: null });
    } else if (breadcrumbSchemas.length) {
      addSuccess({ category: 'AEO - Structured data (Schema.org)', group: 'aeo',
        title: 'BreadcrumbList schema is present', description: '', element: breadcrumbSchemas[0].el });
    }

    // JS-render dependency (best-effort heuristic)
    try {
      fetch(location.href, { method: 'GET' }).then(function (r) { return r.text(); }).then(function (rawHtml) {
        var tmp = document.createElement('div');
        tmp.innerHTML = rawHtml; // doesn't execute <script> tags when sliced this way
        Array.prototype.forEach.call(tmp.querySelectorAll('script,style,noscript'), function (n) { n.remove(); });
        var rawText = (tmp.textContent || '').replace(/\s+/g, ' ').trim();
        var renderedText = text(document.body).replace(/\s+/g, ' ').trim();
        if (renderedText.length > 300 && rawText.length < renderedText.length * 0.3) {
          addFinding({ category: 'AEO - JS rendering dependency', group: 'aeo', severity: 'warning',
            title: 'Most of the content only appears after JavaScript executes (raw HTML: ~' + rawText.length + ' chars, rendered: ~' + renderedText.length + ' chars)',
            description: '',
            why: 'Note: this is a heuristic and can produce false results (e.g. a cookie banner blocking the fetch). Some AI crawlers and simpler bots don\'t execute JavaScript reliably — if key content is only visible after JS rendering, there\'s a risk those bots "see" an empty or nearly empty page. Webflow pages are usually server-rendered so this is rare, but custom code/embeds can inject content afterward.',
            fix: 'Check "View Page Source" (Ctrl/Cmd+U) and compare it with what\'s visible on screen — if key text is missing from the raw HTML, consider making that content part of the server\'s initial HTML response.', element: null });
          renderPanel();
        }
      }).catch(function () { /* CORS or network error — skip */ });
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
    { id: 'meta.noindex', w: 4, re: /noindex/ },
    { id: 'meta.nosnippet', w: 4, re: /^Robots directive/ },
    { id: 'meta.xrobots', w: 4, re: /^(X-Robots-Tag|No X-Robots-Tag)/ },
    { id: 'meta.sitemap', w: 2, re: /^This page is (not )?listed in sitemap/ },
    { id: 'meta.lang', w: 2, re: /^lang attribute/ },
    { id: 'meta.viewport', w: 4, re: /^Viewport meta tag/ },
    { id: 'meta.zoom', w: 2, re: /^Viewport (prevents|allows)/ },
    { id: 'fav.present', w: 2, re: /^Favicon is (missing or fails|present and loads)/ },
    { id: 'fav.quality', w: 1, re: /^Favicon (is in an unusual|dimensions|is square)/, evalIfSuccessOf: ['fav.present'] },
    { id: 'fav.robots', w: 2, re: /^Favicon is blocked/, evalIfSuccessOf: ['fav.present'] },
    { id: 'url.canonical', w: 4, re: /^Canonical (points|tag is present)/ },
    { id: 'url.slug', w: 4, re: /^URL slug/ },
    { id: 'h.h1', w: 4, re: /^(H1 is missing|There is more than one H1|Exactly one H1)/ },
    { id: 'h.skip', w: 2, re: /^Heading hierarchy/ },
    { id: 'h.fake', w: 1, re: /^Text looks like a heading/, always: true },
    { id: 'img.alt', w: 4, re: /^(Alt text is empty|Image: (alt|generic)|\d+ of \d+ visible images have descriptive)/, total: true },
    { id: 'img.height', w: 4, re: /^(Image has no fixed height|\d+ image\(s\) have (both dimensions|a fixed height))/, total: true },
    { id: 'img.external', w: 4, re: /^(Image is hosted|All images are hosted)/, total: true },
    { id: 'img.oversize', w: 2, re: /^(Image is much larger than it is displayed|No image is much larger)/, total: true },
    { id: 'img.lazy', w: 2, re: /^(Image below the fold|All \d+ below-the-fold)/, total: true },
    { id: 'img.format', w: 1, re: /^(Image is not in a modern|\d+ image\(s\) are already in a modern)/, total: true },
    { id: 'img.size', w: 4, re: /^Image is larger than 500KB/, always: true, total: true },
    { id: 'links.nowhere', w: 2, re: /^(Link doesn't go anywhere|There are no links that go nowhere)/, total: true },
    { id: 'links.anchor', w: 4, re: /^(Anchor link points|All in-page anchor)/ },
    { id: 'links.noText', w: 2, re: /^(Link with no text|All links have visible text)/, total: true },
    { id: 'links.generic', w: 1, re: /^Generic anchor text/, always: true, total: true },
    { id: 'links.internal', w: 4, re: /^(Internal link|All checked internal links)/, total: true },
    { id: 'content.thin', w: 2, re: /^(Very little visible text|The page has enough visible text)/ },
    { id: 'content.hidden', w: 1, re: /^Hidden content/, always: true },
    { id: 'content.repeated', w: 2, re: /^(Repeated word|No repeated words)/ },
    { id: 'content.placeholder', w: 4, re: /^(Placeholder\/Lorem|No placeholder)/ },
    { id: 'content.br', w: 1, re: /^Manual <br>/, always: true },
    { id: 'fonts.count', w: 2, re: /^The page uses/, always: true },
    { id: 'fonts.google', w: 2, re: /^(The page dynamically loads Google Fonts|No dynamic loading of Google Fonts)/ },
    { id: 'fonts.format', w: 1, re: /^(Font file in an older|All @font-face)/ },
    { id: 'tech.dupId', w: 1, re: /^(Duplicate ID|No duplicate ID)/ },
    { id: 'tech.dom', w: 1, re: /^(Large\/deeply nested DOM|DOM size\/depth)/ },
    { id: 'tech.mixed', w: 4, re: /^(Mixed content|No mixed content)/ },
    { id: 'tech.thirdParty', w: 4, re: /^(Third-party script|All third-party scripts)/ },
    { id: 'cwv.ttfb', w: 4, re: /^(Slow TTFB|TTFB is good)/ },
    { id: 'cwv.lcp', w: 4, re: /^(Slow LCP|LCP is good)/ },
    { id: 'cwv.cls', w: 4, re: /^(High CLS|CLS is good)/ },
    { id: 'cwv.lcpLazy', w: 2, re: /^The LCP image/ },
    { id: 'aeo.jsonld', w: 4, re: /^(JSON-LD schema block|All JSON-LD schema blocks)/ },
    { id: 'aeo.faq', w: 4, re: /^(Page looks like a FAQ|FAQPage schema|\d+ question\(s\) in the FAQPage)/ },
    { id: 'aeo.article', w: 2, re: /^Page looks like an article/, evalIfAnyOf: ['aeo.articleDates', 'aeo.articleAuthor', 'aeo.authorLink'] },
    { id: 'aeo.articleDates', w: 4, re: /^Article schema (has neither|has datePublished)/ },
    { id: 'aeo.articleAuthor', w: 1, re: /^Article schema has (no |an )?author field/ },
    { id: 'aeo.authorLink', w: 4, re: /^Author link in the Article schema/ },
    { id: 'aeo.nap', w: 2, re: /^(Phone number in the Organization|Address from the Organization|NAP data)/ },
    { id: 'aeo.breadcrumb', w: 1, re: /^(A visible breadcrumb UI|BreadcrumbList schema)/ },
    { id: 'aeo.jsRender', w: 2, re: /^Most of the content only appears after JavaScript/, always: true }
  ];
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
    });
    var pct = totalW > 0 ? Math.round((earned / totalW) * 1000) / 10 : 100;
    return { pct: pct, failedChecks: failedChecks, issues: issues, notes: notes };
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
      showToast(ok ? (successMessage || 'Copied to clipboard.') : 'Could not copy to clipboard — your browser may be blocking it.');
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
    lines.push('SEO PAGE AUDITOR — Report');
    lines.push(location.href);
    lines.push(new Date().toLocaleString());
    lines.push('');
    lines.push(DIVIDER);
    lines.push('SUMMARY');
    lines.push(DIVIDER);
    lines.push('Page optimized : ' + fmtPct(computeOptimization().pct));
    lines.push('SEO tab   : ' + seoCounts.error + ' errors, ' + seoCounts.warning + ' warnings, ' + seoCounts.info + ' info');
    lines.push('AEO tab   : ' + aeoCounts.error + ' errors, ' + aeoCounts.warning + ' warnings, ' + aeoCounts.info + ' info');
    lines.push('Successes : ' + successes.length + ' total (' + soloSeoSuccesses + ' SEO-only, ' + soloAeoSuccesses + ' AEO-only, ' + sharedSuccesses + ' SEO+AEO)');
    lines.push('');

    var order = { error: 0, warning: 1, info: 2 };
    function pushSection(title, list, contextGroup) {
      lines.push(DIVIDER);
      lines.push(title + ' (' + list.length + ')');
      lines.push(DIVIDER);
      lines.push('');
      if (!list.length) {
        lines.push('(no findings)');
        lines.push('');
        return;
      }
      var sorted = list.slice().sort(function (a, b) { return order[a.severity] - order[b.severity]; });
      sorted.forEach(function (f, idx) {
        lines.push((idx + 1) + '. [' + f.severity.toUpperCase() + '] ' + f.category + ' — ' + f.title);
        if (f.description) lines.push(indentLines(f.description, '   '));
        if (f.crossRelevant) lines.push('   (' + getCrossText(f, contextGroup) + ')');
        if (f.globalNote) lines.push('   Global element: ' + f.globalNote);
        if (f.ownerNote) lines.push(indentLines('Who can fix: ' + f.ownerNote, '   '));
        if (f.why) lines.push(indentLines('Why it matters: ' + f.why, '   '));
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
      var raw = localStorage.getItem(HISTORY_KEY_PREFIX + location.href);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }
  function saveCurrentRun() {
    try {
      var data = { totalFindings: findings.length, successes: successes.length, optimizedPct: computeOptimization().pct, timestamp: Date.now() };
      localStorage.setItem(HISTORY_KEY_PREFIX + location.href, JSON.stringify(data));
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
      var raw = localStorage.getItem(PANEL_STATE_KEY_PREFIX + location.href);
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
      localStorage.setItem(PANEL_STATE_KEY_PREFIX + location.href, JSON.stringify(state));
    } catch (e) {
      // Ignore — see comment above savePanelState()'s sibling functions.
    }
  }
  function clearPanelState() {
    try {
      localStorage.removeItem(PANEL_STATE_KEY_PREFIX + location.href);
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
    pHdr.innerHTML = '<b>Report preview</b>';
    var pClose = document.createElement('button');
    pClose.textContent = '✕';
    pClose.title = 'Close preview';
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
    pCopyBtn.textContent = '📋 Copy to clipboard';
    pCopyBtn.onclick = function () { copyToClipboard(reportPreviewText, 'Report copied to clipboard.'); };
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
      '.prog-sub{margin-top:8px;font-size:11.5px;color:#9ca3af;display:flex;justify-content:space-between;gap:10px;}',
      '.prog-sub b{color:#e5e7eb;font-weight:600;}',
      // Generic small "Copy" button (11.08.2026) — used for the header's "Copy report" action
      // and the per-item "Copy fix" action. Deliberately subtle (not a full .badge) so it reads
      // as a secondary/utility action, not a primary control.
      '.copybtn{margin-left:6px;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.16);color:#e5e7eb;border-radius:6px;padding:1px 7px;font-size:10.5px;font-family:inherit;cursor:pointer;transition:background-color .15s ease;}',
      '.copybtn:hover{background:rgba(255,255,255,.18);}',
      // "Previous run vs. now" banner (11.08.2026, localStorage-backed) — sits below the tab bar,
      // above the severity/group summary, and applies regardless of which tab is active (it's a
      // whole-page comparison, not per-tab).
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
          showToast('The panel is covering this element — drag the panel (by its header) to another part of the screen to see it.');
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

  function renderPanel() {
    scheduleRunSave();
    ensurePanel();
    var old = shadow.querySelector('.panel');
    if (old) old.remove();

    // crossRelevant findings/successes (native SEO, but with documented AEO impact) are now
    // shown in BOTH tabs — once with the note "↔ Also relevant to AEO" (in the SEO tab, their
    // native home) and once with the reverse note "↔ Also relevant to SEO" (in the AEO tab,
    // where they appear as a "guest"). See getCrossText() below for the logic that picks the
    // text per context.
    var seoFindings = findings.filter(function (f) { return f.group !== 'aeo'; });
    var aeoFindings = findings.filter(function (f) { return f.group === 'aeo' || f.crossRelevant; });
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
    copyReportBtn.title = reportPreviewVisible ? 'Hide the report preview' : 'Preview the full report (SEO + AEO findings) before copying it';
    copyReportBtn.onclick = function () {
      reportPreviewVisible = !reportPreviewVisible;
      if (reportPreviewVisible) reportPreviewText = buildReportText();
      renderPanel(); // full re-render so the button's active state AND the preview panel both update
    };
    var closeBtn = document.createElement('button');
    closeBtn.textContent = '✕';
    closeBtn.title = 'Close';
    closeBtn.onclick = closePanel;
    hdrActions.appendChild(copyReportBtn);
    hdrActions.appendChild(closeBtn);
    hdr.appendChild(hdrActions);
    hdr.addEventListener('mousedown', function (e) {
      if (e.target === closeBtn || e.target === copyReportBtn) return; // don't start dragging when a header button is clicked
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
    var opt = computeOptimization();
    var prog = document.createElement('div');
    prog.className = 'prog';
    var optColor = optimizedColor(opt.pct);
    var deltaHtml = '';
    if (previousRun && typeof previousRun.optimizedPct === 'number') {
      var dPct = Math.round((opt.pct - previousRun.optimizedPct) * 10) / 10;
      deltaHtml = dPct === 0
        ? '<span>no change since last run</span>'
        : '<span style="color:' + (dPct > 0 ? '#4ade80' : '#f87171') + ';font-weight:700;">' + (dPct > 0 ? '▲ ' : '▼ ') + Math.abs(dPct).toFixed(1) + '%</span> since last run';
    }
    // "issues" = errors + warnings, "notes" = info items (split 28.10.2026: lumping hundreds of
    // info notes into one "issues" number made a decent page look far worse than it is).
    var leftHtml = (opt.failedChecks === 0
      ? '<b>All checks passed</b>'
      : '<b>' + opt.failedChecks + '</b> check' + (opt.failedChecks === 1 ? '' : 's') + ' need attention') +
      (opt.issues > 0 ? ' · <b>' + opt.issues + '</b> issue' + (opt.issues === 1 ? '' : 's') : '') +
      (opt.notes > 0 ? ' · <b>' + opt.notes + '</b> note' + (opt.notes === 1 ? '' : 's') : '');
    prog.innerHTML =
      '<div class="prog-top"><span class="prog-lbl" title="Weighted share of checks that pass on this page. Errors weigh more than warnings, and warnings more than info items; when a check only affects some elements (e.g. a few images), you get partial credit. Not an official metric.">Page optimized</span>' +
      '<span class="prog-pct" style="color:' + optColor + ';">' + fmtPct(opt.pct) + '</span></div>' +
      '<div class="prog-track" role="progressbar" aria-label="Page optimized" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + Math.round(opt.pct) + '"><div class="prog-fill" style="width:' + lastShownPct + '%;background:' + optimizedGradient(opt.pct) + ';"></div></div>' +
      '<div class="prog-sub"><span>' + leftHtml + '</span><span>' + deltaHtml + '</span></div>';
    var progFill = prog.querySelector('.prog-fill');
    var targetPct = opt.pct;
    lastShownPct = targetPct;
    (window.requestAnimationFrame || function (fn) { setTimeout(fn, 16); })(function () { progFill.style.width = targetPct + '%'; });
    panel.appendChild(prog);

    // "Previous run vs. now" banner (11.08.2026, localStorage-backed) — shown right below the
    // header regardless of the active tab, since it's a whole-page comparison. Only appears once
    // a previous run for this exact URL exists (see loadPreviousRun(), called once in run()).
    if (previousRun) {
      var totalNow = findings.length;
      var diff = totalNow - previousRun.totalFindings;
      var diffLabel = diff === 0 ? 'no change' : (diff < 0 ? ('−' + Math.abs(diff)) : ('+' + diff));
      var diffColor = diff < 0 ? '#4ade80' : (diff > 0 ? '#f87171' : '#9ca3af');
      var when = new Date(previousRun.timestamp).toLocaleString();
      var prevBanner = document.createElement('div');
      prevBanner.className = 'prevrun';
      prevBanner.innerHTML = 'Last run (' + when + '): ' + previousRun.totalFindings + ' findings → now: ' + totalNow +
        ' <span style="color:' + diffColor + ';font-weight:700;">(' + diffLabel + ')</span>';
      panel.appendChild(prevBanner);
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
    successTab.textContent = '✓ Success (' + successes.length + ')';
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
      summary.appendChild(makeSuccessGroupBadge('all', 'All', successes.length));
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
      summary.appendChild(makeSeverityBadge('all', 'All', current.length));
      summary.appendChild(makeSeverityBadge('error', 'error', counts.error));
      summary.appendChild(makeSeverityBadge('warning', 'warning', counts.warning));
      summary.appendChild(makeSeverityBadge('info', 'info', counts.info));
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
        allOpt.textContent = 'All categories (' + filtered.length + ')';
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
            group.label = cat;
            var optAll = document.createElement('option');
            optAll.value = cat + '::all';
            optAll.textContent = 'All (' + total + ')';
            group.appendChild(optAll);
            var optShared = document.createElement('option');
            optShared.value = cat + '::shared';
            optShared.textContent = 'AEO + SEO items (' + sharedCount + ')';
            group.appendChild(optShared);
            var optSolo = document.createElement('option');
            optSolo.value = cat + '::solo';
            optSolo.textContent = soloLabel + ' only items (' + soloCount + ')';
            group.appendChild(optSolo);
            select.appendChild(group);
          } else {
            var opt = document.createElement('option');
            opt.value = cat + '::all';
            opt.textContent = cat + ' (' + total + ')';
            select.appendChild(opt);
          }
        });
        select.value = activeCategory + '::' + activeCategoryOrigin;
        select.onchange = function () {
          var parts = select.value.split('::');
          activeCategory = parts[0];
          activeCategoryOrigin = parts[1] || 'all';
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
        haBtn.textContent = (highlightAllActive ? '◼' : '◻') + ' Highlight all (' + highlightableCount + ')';
        haBtn.title = 'Draw a box around every listed finding at once, instead of one at a time.';
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
    var list = document.createElement('div');
    list.className = 'list';

    if (!sorted.length) {
      var empty = document.createElement('div');
      empty.className = 'empty';
      if (activeTab === 'success') {
        empty.textContent = successes.length
          ? 'No successful checks for the selected group ("' + activeSuccessGroup + '") in this tab.'
          : 'No successful checks recorded yet (or the page is still being analyzed).';
      } else if (!current.length) {
        empty.textContent = activeTab === 'aeo' ? 'No AEO findings on this page. 🎉' : 'No SEO findings on this page. 🎉';
      } else if (activeCategory !== 'all') {
        empty.textContent = 'No findings for filter severity="' + activeSeverity + '" + category="' + activeCategory + '".';
      } else {
        empty.textContent = 'No findings for the selected filter ("' + activeSeverity + '") in this tab.';
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
          '<div class="cat">' + s.category + '</div>' +
          '<div class="title"><span class="badge success tag">✓</span><span class="badge group-' + grp + ' tag">' + grpLabel + '</span>' + s.title + '</div>' +
          (s.description ? '<div class="desc">' + (s.description || '').replace(/</g, '&lt;') + '</div>' : '') +
          (s.crossRelevant ? '<div class="cross">↔ ' + getCrossText(s, activeSuccessGroup) + '</div>' : '');
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
          '<div class="cat">' + f.category + '</div>' +
          '<div class="title"><span class="badge ' + f.severity + ' tag">' + f.severity + '</span>' + (f.crossRelevant ? '<span class="badge group-shared tag" title="Shown in both the SEO and AEO tabs (counted once in the totals)">SEO+AEO</span>' : '') + f.title + '</div>' +
          '<div class="desc">' + (f.description || '').replace(/</g, '&lt;') + '</div>' +
          (f.suggestedCode ? '<button class="copybtn copy-code-btn" title="Copy the suggested code to clipboard" style="margin:6px 0 0;">📋 Copy suggested code</button>' : '') +
          (f.globalNote ? '<div class="global">🌐 ' + f.globalNote + '</div>' : '') +
          (f.ownerNote ? '<div class="owner">🔑 <b>Who can fix:</b> ' + f.ownerNote + '</div>' : '') +
          (f.crossRelevant ? '<div class="cross">↔ ' + getCrossText(f, activeTab) + '</div>' : '') +
          (f.why ? '<div class="desc" style="color:#93c5fd;margin-top:4px;"><b>Why:</b> ' + f.why + '</div>' : '') +
          (f.fix ? '<div class="desc fixrow" style="color:#86efac;margin-top:4px;"><b>Fix:</b> ' + f.fix + ' <button class="copybtn copy-fix-btn" title="Copy this fix suggestion to clipboard">Copy</button></div>' : '');
        item.onclick = function () { highlightElement(f.element); };
        if (f.fix) {
          var fixBtn = item.querySelector('.copy-fix-btn');
          if (fixBtn) {
            fixBtn.onclick = function (e) {
              e.stopPropagation(); // don't also trigger the item's own highlight click
              copyToClipboard(f.fix, 'Fix copied to clipboard.');
            };
          }
        }
        if (f.suggestedCode) {
          var codeBtn = item.querySelector('.copy-code-btn');
          if (codeBtn) {
            codeBtn.onclick = function (e) {
              e.stopPropagation();
              copyToClipboard(f.suggestedCode, 'Suggested code copied to clipboard.');
            };
          }
        }
        list.appendChild(item);
        renderedRows.push({ item: f, el: item });
      });
    }

    lastRenderedRows = renderedRows;

    panel.appendChild(list);

    var resizeHandle = document.createElement('div');
    resizeHandle.className = 'resize-handle';
    // The visual "grip" pill is now drawn via CSS (.resize-handle::after), not text — part of
    // the redesign (10.08.2026), textContent deliberately left empty.
    resizeHandle.title = 'Drag to resize panel height';
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

    shadow.appendChild(panel);
    renderReportPreview(); // re-append if it was open — persists across tab/filter re-renders
    savePanelState(); // persist tab/severity/category/successGroup — see loadPanelState() comment
  }

  // ---------------------------------------------------------------------
  // Main
  // ---------------------------------------------------------------------

  function run() {
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

    checkPreliminary();
    checkSlug();
    checkMetaHead();
    checkFavicon();
    checkIndexingSignals();
    checkHeadings();
    checkImages();
    checkLinks();
    checkContent();
    checkFonts();
    checkTechnical();
    checkAEO();
    tagGlobalFindings();
    renderPanel();

    measureCWV(function () {
      tagGlobalFindings();
      renderPanel();
      // Save AFTER the async CWV pass completes, so the stored count reflects the fully
      // finished audit (including CWV-related findings), not the mid-run synchronous snapshot.
      saveCurrentRun();
    });
  }

  run();

  window.__SeoAuditorResults = findings;
})();
