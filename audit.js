/*!
 * SEO Page Auditor (bookmarklet payload)
 * Runs entirely client-side in the developer's browser. No server, no Lighthouse.
 * See SPEC.md in this project for the full rule list and rationale.
 */
(function () {
  'use strict';

  if (window.__FNSeoAuditorRunning) {
    console.warn('[FNSeoAuditor] Already running.');
    return;
  }
  window.__FNSeoAuditorRunning = true;

  // ---------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------

  var findings = [];
  var findingId = 0;

  function addFinding(f) {
    f.id = 'f' + (++findingId);
    f.severity = f.severity || 'warning'; // 'error' | 'warning' | 'info'
    f.category = f.category || 'Ostalo';
    findings.push(f);
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

  // Webflow je tokom vremena menjao CDN domen za assete (uploads-ssl.webflow.com ->
  // assets.website-files.com -> assets-global.website-files.com -> cdn.prod.website-files.com...).
  // Umesto fiksne liste, hvatamo bilo koji poddomen *.website-files.com plus poznate legacy domene.
  var WEBFLOW_ASSET_HOST_SUFFIXES = ['website-files.com'];
  var WEBFLOW_ASSET_HOSTS_EXACT = ['uploads-ssl.webflow.com', 'daks2k3a4ib2z.cloudfront.net'];

  function isWebflowAssetHost(host) {
    if (!host) return false;
    if (WEBFLOW_ASSET_HOSTS_EXACT.indexOf(host) !== -1) return true;
    return WEBFLOW_ASSET_HOST_SUFFIXES.some(function (suffix) {
      return host === suffix || host.slice(-(suffix.length + 1)) === '.' + suffix;
    });
  }

  function fmtBytes(n) {
    if (n == null) return 'nepoznato';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / (1024 * 1024)).toFixed(2) + ' MB';
  }

  function closestLandmark(el) {
    return el && el.closest ? el.closest('nav, header, footer') : null;
  }

  // ---------------------------------------------------------------------
  // 5.0 Preliminarna provera URL-a
  // ---------------------------------------------------------------------

  function checkPreliminary() {
    try {
      var navEntries = performance.getEntriesByType('navigation');
      var nav = navEntries && navEntries[0];
      if (nav && nav.redirectCount > 0) {
        addFinding({
          category: 'Preliminarna provera',
          severity: 'info',
          title: 'Stranica je učitana preko redirekcije',
          description: 'Browser je pratio ' + nav.redirectCount + ' redirekciju/a pre nego što je stigao do: ' + location.href,
          why: 'Ako ovo nije očekivano, rezultati se odnose na krajnju stranicu, ne na URL koji si možda originalno otvorio.',
          fix: 'Proveri da li je redirekcija namerna.',
          element: null
        });
      }
    } catch (e) { /* Navigation Timing L2 not supported */ }

    // Staging detection
    if (/\.webflow\.io$/.test(location.hostname)) {
      addFinding({
        category: 'Preliminarna provera',
        severity: 'info',
        title: 'Ovo je Webflow staging link',
        description: 'Domen ' + location.hostname + ' je Webflow staging poddomen.',
        why: 'Nalazi ovde ne utiču na score, ali je preporučeno proveriti i live domen pre objave.',
        fix: 'Pokreni proveru i na live domenu kad bude spreman.',
        element: null,
        stagingNotice: true
      });
    }
  }

  // ---------------------------------------------------------------------
  // 5.1 Meta & head tagovi
  // ---------------------------------------------------------------------

  function getMeta(name, attr) {
    attr = attr || 'name';
    var el = document.querySelector('meta[' + attr + '="' + name + '"]');
    return el ? el.getAttribute('content') : null;
  }

  function checkMetaHead() {
    var title = document.title || '';
    if (!title.trim()) {
      addFinding({ category: 'Meta i head tagovi', severity: 'error', title: 'Title tag nedostaje ili je prazan',
        description: '<title> je prazan.', why: 'Title je jedan od najjačih on-page SEO signala i tekst koji korisnik vidi u rezultatima pretrage.',
        fix: 'Dodaj jedinstven, opisan title (idealno 50-60 karaktera) u Page Settings.', element: document.head });
    } else if (title.length > 60) {
      addFinding({ category: 'Meta i head tagovi', severity: 'warning', title: 'Title je predugačak (' + title.length + ' karaktera)',
        description: 'Title: "' + title + '"', why: 'Google obično seče title posle ~60 karaktera u rezultatima pretrage.',
        fix: 'Skrati title na 50-60 karaktera, stavi najbitnije reči na početak.', element: document.head });
    } else if (title.length < 15) {
      addFinding({ category: 'Meta i head tagovi', severity: 'warning', title: 'Title je vrlo kratak (' + title.length + ' karaktera)',
        description: 'Title: "' + title + '"', why: 'Prekratak title često znači da nije dovoljno opisan.',
        fix: 'Dopuni title da bolje opiše sadržaj stranice.', element: document.head });
    }
    if (/^(untitled|home|page \d+|lorem ipsum)$/i.test(title.trim())) {
      addFinding({ category: 'Meta i head tagovi', severity: 'error', title: 'Title izgleda kao placeholder',
        description: 'Title: "' + title + '"', why: 'Ovo liči na Webflow default vrednost koja nije zamenjena.',
        fix: 'Postavi pravi, opisan title.', element: document.head });
    }

    var desc = getMeta('description');
    if (!desc || !desc.trim()) {
      addFinding({ category: 'Meta i head tagovi', severity: 'error', title: 'Meta description nedostaje',
        description: 'Nema meta description taga ili je prazan.', why: 'Meta description utiče na CTR iz rezultata pretrage iako nije direktan ranking faktor.',
        fix: 'Dodaj meta description od 120-160 karaktera u Page Settings.', element: document.head });
    } else if (desc.length > 160) {
      addFinding({ category: 'Meta i head tagovi', severity: 'warning', title: 'Meta description je predugačak (' + desc.length + ' karaktera)',
        description: desc, why: 'Google seče opis posle ~155-160 karaktera.', fix: 'Skrati na 120-160 karaktera.', element: document.head });
    }

    var ogTitle = getMeta('og:title', 'property');
    var ogDesc = getMeta('og:description', 'property');
    var ogImage = getMeta('og:image', 'property');
    if (!ogTitle) addFinding({ category: 'Meta i head tagovi', severity: 'warning', title: 'og:title nedostaje',
      description: 'Nema Open Graph title taga.', why: 'Bez njega, deljenje linka na društvenim mrežama koristi fallback (često loš) naslov.',
      fix: 'Dodaj og:title u Page Settings > Open Graph.', element: document.head });
    if (!ogDesc) addFinding({ category: 'Meta i head tagovi', severity: 'warning', title: 'og:description nedostaje',
      description: 'Nema Open Graph description taga.', why: 'Bez njega, pregled linka na društvenim mrežama nema opis.',
      fix: 'Dodaj og:description u Page Settings.', element: document.head });

    if (!ogImage) {
      addFinding({ category: 'Meta i head tagovi', severity: 'warning', title: 'og:image nedostaje',
        description: 'Nema Open Graph slike.', why: 'Linkovi bez OG slike izgledaju golo kad se dele na društvenim mrežama.',
        fix: 'Dodaj og:image (1200x630px, JPG/PNG) u Page Settings.', element: document.head });
    } else {
      checkOgImage(ogImage);
    }

    var canonical = document.querySelector('link[rel="canonical"]');
    if (!canonical) {
      addFinding({ category: 'Meta i head tagovi', severity: 'warning', title: 'Canonical tag nedostaje',
        description: 'Nema <link rel="canonical">.', why: 'Bez canonical-a, Google sam bira koju verziju URL-a smatra glavnom.',
        fix: 'Dodaj canonical tag koji pokazuje na ovu stranicu.', element: document.head });
    } else {
      checkCanonicalDuplication(canonical);
    }

    var robots = getMeta('robots');
    if (robots && /noindex/i.test(robots)) {
      addFinding({ category: 'Meta i head tagovi', severity: 'error', title: 'Stranica je markirana kao noindex',
        description: 'meta robots = "' + robots + '"', why: 'Ova stranica neće biti indeksirana od strane Google-a dok god ovo stoji.',
        fix: 'Ako stranica treba da bude vidljiva u pretrazi, ukloni noindex u Page Settings > SEO > "Exclude from search results".', element: document.head });
    }

    var htmlLang = document.documentElement.getAttribute('lang');
    if (!htmlLang) {
      addFinding({ category: 'Meta i head tagovi', severity: 'warning', title: 'lang atribut nedostaje na <html>',
        description: '<html> nema lang atribut.', why: 'Pomaže i pretraživačima i screen readerima da znaju na kom je jeziku sadržaj.',
        fix: 'Podesi jezik sajta u Webflow Site Settings.', element: document.documentElement });
    }

    var viewport = document.querySelector('meta[name="viewport"]');
    if (!viewport) {
      addFinding({ category: 'Meta i head tagovi', severity: 'error', title: 'Viewport meta tag nedostaje',
        description: 'Nema <meta name="viewport">.', why: 'Bez ovoga stranica nije mobile-friendly, što direktno utiče na mobile-first indexing.',
        fix: 'Webflow ovo obično dodaje automatski — proveri da custom kod nije obrisao tag.', element: document.head });
    }
  }

  function checkOgImage(ogImageUrl) {
    var ext = (ogImageUrl.split('?')[0].split('.').pop() || '').toLowerCase();
    if (ext === 'webp' || ext === 'avif') {
      addFinding({ category: 'Meta i head tagovi', severity: 'warning', title: 'OG image je u formatu koji društvene mreže nepouzdano prikazuju (' + ext.toUpperCase() + ')',
        description: 'og:image: ' + ogImageUrl, why: 'Za razliku od običnih slika na stranici, OG sliku učitava bot svake društvene mreže — mnogi od njih ne renderuju WebP/AVIF pouzdano, pa preview može ispasti prazan ili slomljen.',
        fix: 'Koristi JPG ili PNG za OG image (1200x630px, ispod 300KB).', element: null });
    }
    var img = new Image();
    img.onload = function () {
      if (img.naturalWidth < 600 || img.naturalHeight < 315) {
        addFinding({ category: 'Meta i head tagovi', severity: 'warning', title: 'OG image je premalih dimenzija (' + img.naturalWidth + 'x' + img.naturalHeight + ')',
          description: 'og:image: ' + ogImageUrl, why: 'Minimum preporučen za dobar prikaz je 600x315px, idealno 1200x630px (1.91:1).',
          fix: 'Zameni sa slikom minimum 1200x630px.', element: null });
      }
      renderPanel();
    };
    img.onerror = function () {
      addFinding({ category: 'Meta i head tagovi', severity: 'error', title: 'OG image se ne učitava',
        description: 'og:image URL vraća grešku: ' + ogImageUrl, why: 'Slomljena OG slika = prazan preview na društvenim mrežama.',
        fix: 'Proveri da li je URL ispravan i da fajl postoji.', element: null });
      renderPanel();
    };
    img.src = ogImageUrl;

    try {
      fetch(ogImageUrl, { method: 'HEAD' }).then(function (r) {
        var len = r.headers.get('content-length');
        if (len && parseInt(len, 10) > 300 * 1024) {
          addFinding({ category: 'Meta i head tagovi', severity: 'info', title: 'OG image je veća od preporučenih 300KB (' + fmtBytes(parseInt(len, 10)) + ')',
            description: 'og:image: ' + ogImageUrl, why: 'Neke platforme (npr. WhatsApp) agresivno kompresuju velike slike, što može pogoršati kvalitet preview-a.',
            fix: 'Kompresuj sliku na ispod 300KB.', element: null });
          renderPanel();
        }
      }).catch(function () { /* CORS - ignore silently */ });
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
      addFinding({ category: 'URL i duplikacija stranice', severity: 'warning',
        title: 'Canonical pokazuje na drugu putanju na istom sajtu',
        description: 'Trenutna stranica: ' + curPath + ' | Canonical: ' + canPath,
        why: 'Čest uzrok: stranica je duplirana u Webflow-u i canonical je ostao da pokazuje na original — Google onda ignoriše ovu stranicu u korist te druge.',
        fix: 'Proveri da li je ovo namerno. Ako nije, ispravi canonical u Page Settings da pokazuje na ovu stranicu.', element: canonicalEl });
    }
  }

  // ---------------------------------------------------------------------
  // 5.10 URL slug (duplikacija)
  // ---------------------------------------------------------------------

  function checkSlug() {
    var segments = location.pathname.split('/').filter(Boolean);
    var last = segments[segments.length - 1] || '';
    if (/-\d+$/.test(last) && /-[2-9]$/.test(last)) {
      addFinding({ category: 'URL i duplikacija stranice', severity: 'warning',
        title: 'URL slug se završava sufiksom sličnim "-2" (' + last + ')',
        description: 'Putanja: ' + location.pathname,
        why: 'Webflow automatski dodaje "-2", "-3" itd. na slug kada se stranica duplira. Ako je ovo ostalo u produkciji, URL izgleda needeskriptivno i kao greška.',
        fix: 'Preimenuj slug u Page Settings u nešto opisno, i podesi 301 redirekciju sa starog ako je već indeksiran.', element: null });
    }
  }

  // ---------------------------------------------------------------------
  // 5.2 Heading struktura
  // ---------------------------------------------------------------------

  function checkHeadings() {
    var headings = Array.prototype.slice.call(document.querySelectorAll('h1,h2,h3,h4,h5,h6')).filter(isVisible);
    var h1s = headings.filter(function (h) { return h.tagName === 'H1'; });

    if (h1s.length === 0) {
      addFinding({ category: 'Heading struktura', severity: 'error', title: 'Nedostaje H1 na stranici',
        description: 'Nijedan vidljiv H1 element nije pronađen.', why: 'H1 pomaže i korisnicima i Google-u da odmah razumeju temu stranice.',
        fix: 'Dodaj tačno jedan H1 koji opisuje glavnu temu stranice.', element: document.body });
    } else if (h1s.length > 1) {
      h1s.slice(1).forEach(function (h) {
        addFinding({ category: 'Heading struktura', severity: 'warning', title: 'Postoji više od jednog H1 na stranici (' + h1s.length + ' ukupno)',
          description: 'Dodatni H1: "' + text(h).slice(0, 80) + '"', why: 'Više H1 tagova razvodnjava signal o glavnoj temi stranice.',
          fix: 'Ostavi samo jedan H1, ostale promeni u H2/H3 po potrebi.', element: h });
      });
    }

    var lastLevel = 0;
    headings.forEach(function (h) {
      var level = parseInt(h.tagName.substring(1), 10);
      if (lastLevel > 0 && level - lastLevel > 1) {
        addFinding({ category: 'Heading struktura', severity: 'info', title: 'Preskočena heading hijerarhija (H' + lastLevel + ' → H' + level + ')',
          description: '"' + text(h).slice(0, 80) + '"', why: 'Preskakanje nivoa (npr. H1 pa odmah H3) remeti logičku strukturu dokumenta za screen readere i crawlere.',
          fix: 'Koristi heading nivoe redom, bez preskakanja.', element: h });
      }
      lastLevel = level;
    });

    // Vizuelno-semantička neusklađenost (heuristika)
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
        addFinding({ category: 'Heading struktura', severity: 'info', title: 'Tekst izgleda kao heading ali nije obeležen kao takav',
          description: '"' + t.slice(0, 80) + '" (font-size: ' + fs.toFixed(0) + 'px)',
          why: 'Vizuelno velik/bold tekst van heading taga ne nosi semantičko značenje za crawlere i screen readere.',
          fix: 'Ako je ovo stvarno naslov sekcije, obeleži ga odgovarajućim heading tagom (H2/H3...).', element: el });
      }
    }
  }

  // ---------------------------------------------------------------------
  // 5.3 Slike
  // ---------------------------------------------------------------------

  var GENERIC_ALT_PATTERNS = /^(image|img|photo|picture|untitled|dsc\d*|screenshot.*|asset.*)$/i;

  function checkImages() {
    var imgs = Array.prototype.slice.call(document.querySelectorAll('img'));
    imgs.forEach(function (img) {
      if (!isVisible(img)) return;
      var alt = img.getAttribute('alt');
      var hasDims = img.hasAttribute('width') && img.hasAttribute('height');
      var altProblem = alt == null || alt.trim() === '' || GENERIC_ALT_PATTERNS.test(alt.trim()) || GENERIC_ALT_PATTERNS.test((img.currentSrc || img.src || '').split('/').pop());

      if (altProblem || !hasDims) {
        var parts = [];
        if (altProblem) parts.push('nedostaje/generički alt tekst');
        if (!hasDims) parts.push('nedostaju width/height atributi');
        addFinding({ category: 'Slike', severity: altProblem ? 'error' : 'warning',
          title: 'Slika: ' + parts.join(' + '),
          description: (img.currentSrc || img.src || '').slice(0, 120),
          why: altProblem
            ? 'Alt tekst opisuje sliku pretraživačima i screen readerima; bez njega slika je "nevidljiva" za SEO i pristupačnost.'
            : 'Bez width/height, browser ne može da rezerviše prostor za sliku pre učitavanja, što izaziva layout shift (CLS).',
          fix: altProblem ? 'Dodaj opisan alt tekst u Webflow Asset Manager-u.' : 'Podesi eksplicitne dimenzije slike u Webflow Style panelu.',
          element: img });
      }

      var src = img.currentSrc || img.src || '';
      var host = hostnameOf(src);
      var isExternal = host && host !== location.hostname && !isWebflowAssetHost(host);

      if (isExternal) {
        addFinding({ category: 'Slike', severity: 'error', title: 'Slika je hostovana na eksternom serveru',
          description: src, why: 'Ako se taj eksterni server/projekat ugasi (čest slučaj kod ostataka sa WordPress ili druge migracije), slika nestaje sa stranice. Veličina fajla se ne meri jer je server van naše kontrole.',
          fix: 'Preuzmi sliku i uploaduj je direktno u Webflow Assets.', element: img });
      } else {
        var ext = (src.split('?')[0].split('.').pop() || '').toLowerCase();
        if (['jpg', 'jpeg', 'png', 'gif'].indexOf(ext) !== -1) {
          addFinding({ category: 'Slike', severity: 'info', title: 'Slika nije u modernom formatu (trenutno: ' + ext.toUpperCase() + ')',
            description: src, why: 'AVIF/WebP daju znatno manju veličinu fajla pri istom kvalitetu, što ubrzava učitavanje stranice.',
            fix: 'Konvertuj u WebP ili AVIF (Webflow ima opciju automatske optimizacije slika u Asset Manager-u).', element: img });
        }

        try {
          fetch(src, { method: 'HEAD' }).then(function (r) {
            var len = r.headers.get('content-length');
            if (len && parseInt(len, 10) > 500 * 1024) {
              addFinding({ category: 'Slike', severity: 'warning', title: 'Slika je veća od 500KB (' + fmtBytes(parseInt(len, 10)) + ')',
                description: src, why: 'Velike slike usporavaju učitavanje stranice i pogoršavaju LCP (Largest Contentful Paint).',
                fix: 'Kompresuj sliku (npr. TinyPNG/Squoosh) ili je konvertuj u WebP/AVIF.', element: img });
              renderPanel();
            }
          }).catch(function () {});
        } catch (e) {}
      }
    });
  }

  // ---------------------------------------------------------------------
  // 5.4 Linkovi
  // ---------------------------------------------------------------------

  var GENERIC_ANCHOR = /^(klikni ovde|click here|read more|saznaj vi[sš]e|vi[sš]e|ovde|here|link)$/i;

  function checkLinks() {
    var links = Array.prototype.slice.call(document.querySelectorAll('a'));
    var internalToCheck = [];

    links.forEach(function (a) {
      if (!isVisible(a)) return;
      var href = a.getAttribute('href');
      var isEmpty = !href || href.trim() === '' || href.trim() === '#' || /^javascript:/i.test(href.trim());
      var hasCompensatingRole = a.getAttribute('role') === 'tab' || a.getAttribute('role') === 'button';

      if (isEmpty && !hasCompensatingRole) {
        addFinding({ category: 'Linkovi', severity: 'warning', title: 'Link ne vodi nigde (href="' + (href || '') + '")',
          description: '"' + text(a).slice(0, 60) + '"',
          why: 'Ako ovo predstavlja tab/akordeon koji samo menja prikaz na istoj stranici, ispravan pristup po WAI-ARIA Tabs obrascu je <button> sa role="tab", ne <a> link — link semantički implicira navigaciju.',
          fix: 'Ako element ne navigira nigde, promeni ga u <button> (ili dodaj role="tab"/role="button" + odgovarajuće ARIA atribute).', element: a });
      }

      // In-page anchor targets
      if (href && href.charAt(0) === '#' && href.length > 1) {
        var targetId = href.slice(1);
        if (!document.getElementById(targetId) && !document.getElementsByName(targetId).length) {
          addFinding({ category: 'Linkovi', severity: 'warning', title: 'Anchor link vodi ka ID-ju koji ne postoji (#' + targetId + ')',
            description: '"' + text(a).slice(0, 60) + '"', why: 'Klik na ovaj link neće uraditi ništa jer element sa tim ID-jem ne postoji na stranici.',
            fix: 'Proveri da li je ciljni element preimenovan ili obrisan, i ispravi href ili ID.', element: a });
        }
      }

      var linkText = text(a);
      if (!linkText && !a.querySelector('img')) {
        addFinding({ category: 'Linkovi', severity: 'info', title: 'Link bez teksta (i bez slike)',
          description: href || '(nema href)', why: 'Prazan link nosi nula konteksta za korisnika i za crawler.',
          fix: 'Dodaj vidljiv tekst ili aria-label.', element: a });
      } else if (GENERIC_ANCHOR.test(linkText.trim())) {
        addFinding({ category: 'Linkovi', severity: 'info', title: 'Negenerički anchor tekst: "' + linkText.trim() + '"',
          description: 'href: ' + href, why: 'Opisan anchor tekst pomaže korisnicima i Google-u da razumeju kuda link vodi.',
          fix: 'Zameni sa opisnim tekstom (npr. "Pogledaj cenovnik" umesto "klikni ovde").', element: a });
      }

      if (href && !isEmpty && sameHost(href, location.hostname)) {
        internalToCheck.push({ el: a, href: href });
      }
    });

    // 404 / redirect chain check for internal links (best-effort, limited count)
    var toCheck = internalToCheck.slice(0, 25);
    toCheck.forEach(function (item) {
      try {
        fetch(item.href, { method: 'GET', redirect: 'manual' }).then(function (r) {
          if (r.status === 404) {
            addFinding({ category: 'Linkovi', severity: 'error', title: 'Interni link vodi na 404 stranicu',
              description: item.href, why: 'Slomljen interni link šteti i korisničkom iskustvu i crawl efikasnosti.',
              fix: 'Ispravi link ili vrati/preimenuj ciljnu stranicu.', element: item.el });
            renderPanel();
          } else if (r.type === 'opaqueredirect' || (r.status >= 300 && r.status < 400)) {
            addFinding({ category: 'Linkovi', severity: 'info', title: 'Interni link prolazi kroz redirekciju',
              description: item.href, why: 'Nije slomljeno, ali redirekcija usporava i razvodnjava link signal.',
              fix: 'Ako je moguće, ažuriraj link da vodi direktno na finalni URL.', element: item.el });
            renderPanel();
          }
        }).catch(function () { /* CORS / network - ignore */ });
      } catch (e) {}
    });
  }

  // ---------------------------------------------------------------------
  // 5.5 Sadržaj
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
      addFinding({ category: 'Sadržaj', severity: 'warning', title: 'Vrlo malo vidljivog teksta na stranici (' + visibleTextLen + ' karaktera)',
        description: '', why: 'Stranice sa vrlo malo teksta teže se rangiraju za relevantne upite (thin content).',
        fix: 'Dodaj više relevantnog, korisnog sadržaja.', element: main });
    }

    // Hidden content (potential keyword stuffing)
    var all = Array.prototype.slice.call(document.querySelectorAll('body *'));
    var hiddenChecked = 0;
    for (var i = 0; i < all.length && hiddenChecked < 800; i++) {
      var el = all[i];
      var style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') {
        var t = text(el);
        if (t && t.length > 60) {
          hiddenChecked++;
          addFinding({ category: 'Sadržaj', severity: 'info', title: 'Sakriven sadržaj sa dosta teksta (display:none/visibility:hidden)',
            description: '"' + t.slice(0, 80) + '..."', why: 'Skriven tekst sa dosta reči može delovati kao pokušaj keyword stuffing-a, čak i ako je nenamerno (npr. zaboravljen tab panel).',
            fix: 'Proveri da li ovaj sadržaj treba da bude vidljiv, ili ga ukloni ako je ostatak razvoja.', element: el });
        }
      }
    }

    // Repeated consecutive word
    var bodyText = text(main);
    var repeatRegex = /\b(\w{2,})\s+\1\b/gi;
    var seenRepeats = {};
    var m;
    while ((m = repeatRegex.exec(bodyText)) !== null) {
      var word = m[1].toLowerCase();
      if (seenRepeats[word]) continue;
      seenRepeats[word] = true;
      addFinding({ category: 'Sadržaj', severity: 'info', title: 'Ponovljena reč zaredom: "' + m[1] + ' ' + m[1] + '"',
        description: '...' + bodyText.slice(Math.max(0, m.index - 30), m.index + 30) + '...',
        why: 'Najčešće copy-paste greška.', fix: 'Ukloni duplikat reči.', element: null });
    }

    // Placeholder text
    PLACEHOLDER_PATTERNS.forEach(function (re) {
      var mm = bodyText.match(re);
      if (mm) {
        addFinding({ category: 'Sadržaj', severity: 'error', title: 'Placeholder/Lorem ipsum tekst pronađen na stranici',
          description: '"...' + bodyText.slice(Math.max(0, bodyText.indexOf(mm[0]) - 20), bodyText.indexOf(mm[0]) + 60) + '..."',
          why: 'Čest slučaj kad CMS Rich Text element nije pravilno povezan sa pravim podatkom, pa ostane default vrednost.',
          fix: 'Zameni placeholder tekst pravim sadržajem pre objave.', element: null });
      }
    });

    // Manual <br> line breaks inside headings/paragraphs
    var brCandidates = Array.prototype.slice.call(document.querySelectorAll('h1,h2,h3,h4,h5,h6,p'));
    brCandidates.forEach(function (el) {
      if (!isVisible(el)) return;
      var brCount = el.querySelectorAll('br').length;
      if (brCount >= 1) {
        addFinding({ category: 'Sadržaj', severity: 'info', title: 'Ručni <br> prelom reda unutar ' + el.tagName.toLowerCase() + ' elementa',
          description: '"' + text(el).slice(0, 80) + '"',
          why: 'Ne utiče direktno na SEO rangiranje, ali prelom fiksiran za desktop izgled može da se "slomi" i čudno prelomi tekst na mobilnom (mobile-first indexing signal iskustva stranice).',
          fix: 'Razmotri CSS rešenje (max-width, responsive font-size) umesto ručnog <br>.', element: el });
      }
    });
  }

  // ---------------------------------------------------------------------
  // 5.6 Fontovi
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
      addFinding({ category: 'Fontovi', severity: 'warning', title: 'Stranica koristi ' + distinct.length + ' različitih fontova: ' + distinct.join(', '),
        description: '', why: 'Svaki dodatni font je dodatni fajl za preuzimanje i rizik za FOUT/FOIT, što pogoršava performanse.',
        fix: 'Svedi broj fontova na 1-2 (npr. jedan za naslove, jedan za tekst).', element: null });
    } else if (distinct.length >= 2) {
      addFinding({ category: 'Fontovi', severity: 'info', title: 'Stranica koristi ' + distinct.length + ' fonta: ' + distinct.join(', '),
        description: '', why: 'Informativno — ne utiče na SEO score, ali vredi biti svestan.',
        fix: '', element: null });
    }

    // Google Fonts vs self-hosted
    var links = Array.prototype.slice.call(document.querySelectorAll('link[href], style'));
    var usesGoogleFonts = false;
    links.forEach(function (el) {
      var src = el.tagName === 'LINK' ? el.getAttribute('href') : el.textContent;
      if (src && /fonts\.googleapis\.com|fonts\.gstatic\.com/i.test(src)) usesGoogleFonts = true;
    });
    if (usesGoogleFonts) {
      addFinding({ category: 'Fontovi', severity: 'warning', title: 'Stranica dinamički učitava Google Fonts sa Google servera',
        description: '', why: 'Nemački sud (LG München I, 01/2022) presudio je da dinamičko učitavanje Google Fonts-a bez pristanka šalje IP adresu posetioca Google-u bez pravnog osnova po GDPR-u, što je pokrenulo talas opomena (uglavnom u Nemačkoj, ali GDPR važi u celoj EU). Nismo pravni savetnici — proveri sa pravnikom ako je relevantno za klijenta.',
        fix: 'Preuzmi font fajlove i uploaduj ih direktno u Webflow Assets (self-hosting) umesto dinamičkog Google Fonts linka.', element: null });
    }

    // Font format check
    try {
      document.fonts.forEach(function (f) {
        // FontFace API ne izlaže uvek src URL direktno; best effort preko toString()
      });
    } catch (e) {}
    var oldFormatFound = false;
    var sheets = document.styleSheets;
    for (var i = 0; i < sheets.length; i++) {
      try {
        var rules = sheets[i].cssRules || [];
        for (var j = 0; j < rules.length; j++) {
          if (rules[j].constructor.name === 'CSSFontFaceRule' || (rules[j].cssText && /@font-face/.test(rules[j].cssText))) {
            if (/\.(ttf|otf|eot)(\?|"|'|\))/i.test(rules[j].cssText) && !/\.woff2/i.test(rules[j].cssText)) {
              oldFormatFound = true;
            }
          }
        }
      } catch (e) { /* cross-origin stylesheet, can't read rules */ }
    }
    if (oldFormatFound) {
      addFinding({ category: 'Fontovi', severity: 'info', title: 'Font fajl u starijem formatu (nije .woff2)',
        description: '', why: '.woff2 ima znatno bolju kompresiju od .ttf/.otf/.eot, manji fajl = brže učitavanje.',
        fix: 'Konvertuj font fajlove u .woff2 pre uploada u Webflow.', element: null });
    }
  }

  // ---------------------------------------------------------------------
  // 5.7 Tehnički / crawlability
  // ---------------------------------------------------------------------

  function checkTechnical() {
    // Duplicate IDs - informational only
    var idMap = {};
    Array.prototype.forEach.call(document.querySelectorAll('[id]'), function (el) {
      var id = el.id;
      if (!id) return;
      (idMap[id] = idMap[id] || []).push(el);
    });
    Object.keys(idMap).forEach(function (id) {
      if (idMap[id].length > 1) {
        addFinding({ category: 'Tehnički / crawlability', severity: 'info', title: 'Duplikatan ID atribut: "' + id + '" (' + idMap[id].length + ' puta)',
          description: '', why: 'Duplikatni ID-jevi lome in-page anchor linkove i ARIA reference (aria-controls, aria-labelledby) koje se oslanjaju na jedinstven ID. Čest rezultat kopiranja cele sekcije bez izmene ID-ja.',
          fix: 'Preimenuj duplikate u jedinstvene ID-jeve.', element: idMap[id][1] });
      }
    });

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
      addFinding({ category: 'Tehnički / crawlability', severity: 'info', title: 'Veliki/preduboko ugnježden DOM (čvorova: ' + totalNodes + ', max dubina: ' + maxDepth + ', max dece jednog elementa: ' + maxChildren + ')',
        description: '', why: 'Prevelik DOM usporava rendering i otežava crawlerima efikasno parsiranje. Ovo je preporuka, ne greška — ako je namerno i ne pravi vidljiv problem, može se ignorisati.',
        fix: 'Razmotri pojednostavljenje strukture sekcija (manje ugnježdenih wrapper div-ova).', element: null });
    }

    // Mixed content
    if (location.protocol === 'https:') {
      var httpResources = Array.prototype.slice.call(document.querySelectorAll('img[src^="http://"], script[src^="http://"], link[href^="http://"], iframe[src^="http://"]'));
      httpResources.forEach(function (el) {
        addFinding({ category: 'Tehnički / crawlability', severity: 'error', title: 'Mixed content: HTTP resurs na HTTPS stranici',
          description: (el.src || el.href || ''), why: 'Browser može da blokira ili upozori na ovaj resurs, i to je bezbednosni signal.',
          fix: 'Promeni URL resursa na https://.', element: el });
      });
    }

    // Third-party scripts without async/defer
    var scripts = Array.prototype.slice.call(document.querySelectorAll('head script[src], body script[src]'));
    scripts.forEach(function (s) {
      var src = s.getAttribute('src');
      var host = hostnameOf(src);
      if (host && host !== location.hostname && !s.async && !s.defer) {
        var current = '<script src="' + src + '"></script>';
        var suggested = '<script src="' + src + '" defer></script>';
        addFinding({ category: 'Tehnički / crawlability', severity: 'warning',
          title: 'Treće-strana skripta bez async/defer (' + host + ')',
          description: 'Trenutno:\n' + current + '\n\nPredloženo:\n' + suggested,
          why: 'Skripta bez async/defer u <head>-u blokira renderovanje stranice dok se ne preuzme i izvrši.',
          fix: 'Dodaj "defer" atribut (preporučeno za skripte kojima je bitan redosled izvršavanja/DOM spremnost — većina chat widgeta i tracking piksela) ili "async" (za potpuno nezavisne skripte). Još bolje: premesti skriptu u Page Settings > Custom Code > "Before </body> tag" umesto u <head>.',
          element: s });
      }
    });
  }

  // ---------------------------------------------------------------------
  // 5.9 Poseban tretman: nav/footer (post-processing)
  // ---------------------------------------------------------------------

  function tagGlobalFindings() {
    findings.forEach(function (f) {
      if (f.element) {
        var landmark = closestLandmark(f.element);
        if (landmark) {
          f.globalElement = true;
          f.globalNote = 'Globalni element (' + landmark.tagName.toLowerCase() + ') — verovatno Symbol/Component koji se ponavlja na svim stranicama sajta. Ispravka na jednom mestu rešava problem sajt-wide. Preporučuje se brza provera na još 1-2 druge stranice.';
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

    if (cwv.ttfb != null && cwv.ttfb > 800) {
      addFinding({ category: 'Performanse (CWV)', severity: 'warning', title: 'Spor TTFB (Time To First Byte): ' + cwv.ttfb + 'ms',
        description: '', why: 'Preko 800ms je sporo — server sporo odgovara na prvi zahtev.', fix: 'Proveri custom kod/integracije koje mogu usporavati server response.', element: null });
    }
    if (cwv.lcp != null && cwv.lcp > 2500) {
      addFinding({ category: 'Performanse (CWV)', severity: 'warning', title: 'Spor LCP (Largest Contentful Paint): ' + cwv.lcp + 'ms',
        description: '', why: 'Google smatra dobrim LCP ispod 2500ms. Sporiji LCP obično znači da je najveći element (najčešće hero slika) prevelik ili se sporo učitava.',
        fix: 'Optimizuj/kompresuj hero sliku, ukloni render-blocking resurse.', element: null });
    }
    if (cwv.cls > 0.1) {
      addFinding({ category: 'Performanse (CWV)', severity: 'warning', title: 'Visok CLS (Cumulative Layout Shift): ' + cwv.cls,
        description: '', why: 'Preko 0.1 znači primetno "skakanje" sadržaja tokom učitavanja — najčešće zbog slika/fontova bez rezervisanog prostora.',
        fix: 'Dodaj width/height na slike, proveri font-display podešavanja.', element: null });
    }

    if (done) setTimeout(done, 1200); // dati vremena PerformanceObserver bufferu
  }

  // ---------------------------------------------------------------------
  // UI Overlay (shadow DOM panel)
  // ---------------------------------------------------------------------

  var panelHost, shadow, highlightBox;

  function ensurePanel() {
    if (panelHost) return;
    panelHost = document.createElement('div');
    panelHost.id = 'fn-seo-audit-host';
    panelHost.style.cssText = 'all:initial;position:fixed;top:0;right:0;z-index:2147483647;';
    document.documentElement.appendChild(panelHost);
    shadow = panelHost.attachShadow({ mode: 'open' });

    var style = document.createElement('style');
    style.textContent = [
      ':host{all:initial;}',
      '.panel{position:fixed;top:12px;right:12px;width:380px;max-height:90vh;overflow:auto;background:#111827;color:#f3f4f6;font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:13px;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.4);z-index:2147483647;}',
      '.hdr{padding:12px 14px;background:#1f2937;border-radius:10px 10px 0 0;display:flex;justify-content:space-between;align-items:center;position:sticky;top:0;}',
      '.hdr b{font-size:14px;}',
      '.hdr button{background:transparent;color:#9ca3af;border:none;cursor:pointer;font-size:16px;}',
      '.summary{padding:8px 14px;display:flex;gap:10px;border-bottom:1px solid #374151;}',
      '.badge{border-radius:6px;padding:2px 8px;font-weight:600;font-size:12px;}',
      '.badge.error{background:#7f1d1d;color:#fecaca;}',
      '.badge.warning{background:#78350f;color:#fde68a;}',
      '.badge.info{background:#1e3a8a;color:#bfdbfe;}',
      '.item{padding:10px 14px;border-bottom:1px solid #1f2937;cursor:pointer;}',
      '.item:hover{background:#1f2937;}',
      '.item .cat{color:#9ca3af;font-size:11px;text-transform:uppercase;letter-spacing:.03em;}',
      '.item .title{font-weight:600;margin:2px 0;}',
      '.item .desc{color:#d1d5db;white-space:pre-wrap;font-size:12px;margin-top:4px;max-height:60px;overflow:hidden;}',
      '.item .global{margin-top:4px;color:#fbbf24;font-size:11px;}',
      '.tag{display:inline-block;margin-right:4px;}'
    ].join('');
    shadow.appendChild(style);

    highlightBox = document.createElement('div');
    highlightBox.style.cssText = 'position:fixed;pointer-events:none;border:3px solid #ef4444;border-radius:4px;z-index:2147483646;box-shadow:0 0 0 4000px rgba(0,0,0,.35);display:none;transition:all .15s ease;';
    document.documentElement.appendChild(highlightBox);
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
    }, 350);
  }

  function renderPanel() {
    ensurePanel();
    var old = shadow.querySelector('.panel');
    if (old) old.remove();

    var counts = { error: 0, warning: 0, info: 0 };
    findings.forEach(function (f) { counts[f.severity] = (counts[f.severity] || 0) + 1; });

    var panel = document.createElement('div');
    panel.className = 'panel';

    var hdr = document.createElement('div');
    hdr.className = 'hdr';
    hdr.innerHTML = '<b>SEO Page Auditor</b>';
    var closeBtn = document.createElement('button');
    closeBtn.textContent = '✕';
    closeBtn.onclick = function () { panelHost.remove(); highlightBox.remove(); window.__FNSeoAuditorRunning = false; };
    hdr.appendChild(closeBtn);
    panel.appendChild(hdr);

    var summary = document.createElement('div');
    summary.className = 'summary';
    summary.innerHTML =
      '<span class="badge error">' + counts.error + ' error</span>' +
      '<span class="badge warning">' + counts.warning + ' warning</span>' +
      '<span class="badge info">' + counts.info + ' info</span>';
    panel.appendChild(summary);

    var order = { error: 0, warning: 1, info: 2 };
    var sorted = findings.slice().sort(function (a, b) { return order[a.severity] - order[b.severity]; });

    sorted.forEach(function (f) {
      var item = document.createElement('div');
      item.className = 'item';
      item.innerHTML =
        '<div class="cat">' + f.category + '</div>' +
        '<div class="title"><span class="badge ' + f.severity + ' tag">' + f.severity + '</span>' + f.title + '</div>' +
        '<div class="desc">' + (f.description || '').replace(/</g, '&lt;') + '</div>' +
        (f.globalNote ? '<div class="global">🌐 ' + f.globalNote + '</div>' : '') +
        (f.why ? '<div class="desc" style="color:#93c5fd;margin-top:4px;"><b>Zašto:</b> ' + f.why + '</div>' : '') +
        (f.fix ? '<div class="desc" style="color:#86efac;margin-top:4px;"><b>Rešenje:</b> ' + f.fix + '</div>' : '');
      item.onclick = function () { highlightElement(f.element); };
      panel.appendChild(item);
    });

    shadow.appendChild(panel);
  }

  // ---------------------------------------------------------------------
  // Main
  // ---------------------------------------------------------------------

  function run() {
    checkPreliminary();
    checkSlug();
    checkMetaHead();
    checkHeadings();
    checkImages();
    checkLinks();
    checkContent();
    checkFonts();
    checkTechnical();
    tagGlobalFindings();
    renderPanel();

    measureCWV(function () {
      tagGlobalFindings();
      renderPanel();
    });
  }

  run();

  window.__FNSeoAuditorResults = findings;
})();
