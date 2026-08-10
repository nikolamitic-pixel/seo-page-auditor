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
    f.category = f.category || 'Ostalo';
    f.group = f.group || 'seo'; // 'seo' | 'aeo' — koji tab u panelu prikazuje ovaj nalaz
    findings.push(f);
    return f;
  }

  // Paralelna lista sa addFinding() — beleži provere koje su PROŠLE (nema problema), da bi
  // korisnik u "Uspešno" tabu video i šta je ispravno urađeno na stranici, ne samo šta je
  // pokvareno. Namerno odvojena od `findings` (ne meša se sa error/warning/info severity
  // logikom) jer "uspeh" nema stepen ozbiljnosti — ili je provera prošla, ili nije.
  var successes = [];
  var successId = 0;

  function addSuccess(f) {
    f.id = 's' + (++successId);
    f.category = f.category || 'Ostalo';
    f.group = f.group || 'seo'; // 'seo' | 'aeo' — informativno, trenutno se ne koristi za filtriranje u Success tabu
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
    var charsetMeta = document.querySelector('meta[charset]') || document.querySelector('meta[http-equiv="Content-Type" i]');
    if (!charsetMeta) {
      addFinding({ category: 'Meta i head tagovi', severity: 'warning', title: 'Meta charset deklaracija nedostaje',
        description: 'Nema <meta charset="..."> u head-u.', why: 'Bez eksplicitnog charset-a, browser može pogrešno detektovati enkoding pre nego što stigne do HTTP header-a, što retko ali realno izaziva pogrešno prikazane karaktere (npr. č/ć/š/ž) pri prvom renderovanju stranice.',
        fix: 'Webflow ovo automatski dodaje — proveri da custom kod u <head> nije slučajno obrisao ili premestio tag.', element: document.head });
    } else {
      var charsetVal = charsetMeta.hasAttribute('charset') ? charsetMeta.getAttribute('charset') : (charsetMeta.getAttribute('content') || '');
      if (!/utf-8/i.test(charsetVal)) {
        addFinding({ category: 'Meta i head tagovi', severity: 'warning', title: 'Meta charset nije UTF-8',
          description: 'Pronađena vrednost: "' + charsetVal + '".', why: 'UTF-8 je univerzalni standard koji pokriva sve jezike i karaktere — bilo šta drugo nosi realan rizik pogrešnog prikaza karaktera.',
          fix: 'Postavi charset na UTF-8.', element: document.head });
      } else {
        addSuccess({ category: 'Meta i head tagovi', title: 'Meta charset je prisutan i postavljen na UTF-8', description: '', element: document.head });
      }
    }

    var titleTags = document.querySelectorAll('title');
    if (titleTags.length > 1) {
      addFinding({ category: 'Meta i head tagovi', severity: 'warning', title: 'Više od jednog <title> taga u head-u (' + titleTags.length + ')',
        description: Array.prototype.map.call(titleTags, function (t) { return '"' + t.textContent + '"'; }).join(', '),
        why: 'Browseri i Google obično uzimaju samo prvi <title> tag, ali ponašanje nije univerzalno garantovano preko svih parsera/bot-ova — duplikat najčešće znači grešku u Custom Code sekciji (npr. ručno dodat <title> pored Webflow-ovog).',
        fix: 'Ukloni sve <title> tagove osim jednog — title podesi kroz Page Settings, ne ručno u Custom Code.', element: document.head });
    }

    var descTags = document.querySelectorAll('meta[name="description" i]');
    if (descTags.length > 1) {
      addFinding({ category: 'Meta i head tagovi', severity: 'warning', title: 'Više od jednog meta description taga (' + descTags.length + ')',
        description: Array.prototype.map.call(descTags, function (m) { return '"' + (m.getAttribute('content') || '') + '"'; }).join(' | '),
        why: 'Kad postoji više meta description tagova, ponašanje koji će Google uzeti nije garantovano — najčešće znači duplikat unet i kroz Page Settings i ručno kroz Custom Code.',
        fix: 'Ukloni sve meta description tagove osim jednog.', element: document.head });
    }

    var title = document.title || '';
    var titleLengthOk = false;
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
    } else {
      titleLengthOk = true;
    }
    var isPlaceholderTitle = /^(untitled|home|page \d+|lorem ipsum)$/i.test(title.trim());
    if (isPlaceholderTitle) {
      addFinding({ category: 'Meta i head tagovi', severity: 'error', title: 'Title izgleda kao placeholder',
        description: 'Title: "' + title + '"', why: 'Ovo liči na Webflow default vrednost koja nije zamenjena.',
        fix: 'Postavi pravi, opisan title.', element: document.head });
    }
    if (titleLengthOk && !isPlaceholderTitle) {
      addSuccess({ category: 'Meta i head tagovi', title: 'Title tag je prisutan i optimalne dužine (' + title.length + ' karaktera)',
        description: 'Title: "' + title + '"', element: document.head });
    }

    var desc = getMeta('description');
    if (!desc || !desc.trim()) {
      addFinding({ category: 'Meta i head tagovi', severity: 'error', title: 'Meta description nedostaje',
        description: 'Nema meta description taga ili je prazan.', why: 'Meta description utiče na CTR iz rezultata pretrage iako nije direktan ranking faktor.',
        fix: 'Dodaj meta description od 120-160 karaktera u Page Settings.', element: document.head });
    } else if (desc.length > 160) {
      addFinding({ category: 'Meta i head tagovi', severity: 'warning', title: 'Meta description je predugačak (' + desc.length + ' karaktera)',
        description: desc, why: 'Google seče opis posle ~155-160 karaktera.', fix: 'Skrati na 120-160 karaktera.', element: document.head });
    } else {
      addSuccess({ category: 'Meta i head tagovi', title: 'Meta description je prisutan i odgovarajuće dužine (' + desc.length + ' karaktera)',
        description: desc, element: document.head });
    }

    var ogTitle = getMeta('og:title', 'property');
    var ogDesc = getMeta('og:description', 'property');
    var ogImage = getMeta('og:image', 'property');
    if (!ogTitle) {
      addFinding({ category: 'Meta i head tagovi', severity: 'warning', title: 'og:title nedostaje',
        description: 'Nema Open Graph title taga.', why: 'Bez njega, deljenje linka na društvenim mrežama koristi fallback (često loš) naslov.',
        fix: 'Dodaj og:title u Page Settings > Open Graph.', element: document.head });
    } else {
      addSuccess({ category: 'Meta i head tagovi', title: 'og:title je prisutan', description: ogTitle, element: document.head });
    }
    if (!ogDesc) {
      addFinding({ category: 'Meta i head tagovi', severity: 'warning', title: 'og:description nedostaje',
        description: 'Nema Open Graph description taga.', why: 'Bez njega, pregled linka na društvenim mrežama nema opis.',
        fix: 'Dodaj og:description u Page Settings.', element: document.head });
    } else {
      addSuccess({ category: 'Meta i head tagovi', title: 'og:description je prisutan', description: ogDesc, element: document.head });
    }

    if (!ogImage) {
      addFinding({ category: 'Meta i head tagovi', severity: 'warning', title: 'og:image nedostaje',
        description: 'Nema Open Graph slike.', why: 'Linkovi bez OG slike izgledaju golo kad se dele na društvenim mrežama.',
        fix: 'Dodaj og:image (1200x630px, JPG/PNG) u Page Settings.', element: document.head });
    } else {
      addSuccess({ category: 'Meta i head tagovi', title: 'og:image je prisutan', description: ogImage, element: document.head });
      checkOgImage(ogImage);
    }

    var twitterCard = getMeta('twitter:card');
    if (!twitterCard) {
      addFinding({ category: 'Meta i head tagovi', severity: 'warning', title: 'Twitter/X Card meta tag (twitter:card) nedostaje',
        description: 'Nema <meta name="twitter:card">.', why: 'Twitter/X Card tagovi su tehnički odvojeni od Open Graph tagova — bez eksplicitnog twitter:card, X ponekad ne uspe pouzdano da povuče OG fallback, pa deljeni link može ostati bez ikakvog preview-a specifično na toj platformi.',
        fix: 'Dodaj <meta name="twitter:card" content="summary_large_image"> (i idealno twitter:title/twitter:image) kroz Custom Code u head sekciji.', element: document.head });
    } else {
      addSuccess({ category: 'Meta i head tagovi', title: 'Twitter/X Card meta tag je prisutan (' + twitterCard + ')', description: '', element: document.head });
    }

    var canonical = document.querySelector('link[rel="canonical"]');
    if (!canonical) {
      addFinding({ category: 'Meta i head tagovi', severity: 'error', title: 'Canonical tag nedostaje',
        description: 'Nema <link rel="canonical">.', why: 'Bez canonical-a, Google sam bira koju verziju URL-a smatra glavnom — a Google zvanično preporučuje da SVAKA stranica ima eksplicitan canonical, bez obzira da li trenutno postoji duplikat. Ovo je nešto što developer treba da doda pre objave, ne "nice to have".',
        fix: 'Dodaj canonical tag koji pokazuje na ovu stranicu.', element: document.head,
        crossRelevant: true, crossNote: 'Relevantno i za SEO i za AEO — nejasan "glavni" URL otežava AI answer engine-ima da znaju koju verziju stranice da citiraju.',
        crossNoteReverse: 'Relevantno i za SEO i za AEO — canonical sprečava duplicate content probleme i konsoliduje ranking signale na jednu URL adresu u Google indeksu.' });
    } else {
      checkCanonicalDuplication(canonical);
    }

    var robots = getMeta('robots');
    if (robots && /noindex/i.test(robots)) {
      addFinding({ category: 'Meta i head tagovi', severity: 'error', title: 'Stranica je markirana kao noindex',
        description: 'meta robots = "' + robots + '"', why: 'Ova stranica neće biti indeksirana od strane Google-a dok god ovo stoji.',
        fix: 'Ako stranica treba da bude vidljiva u pretrazi, ukloni noindex u Page Settings > SEO > "Exclude from search results".', element: document.head,
        crossRelevant: true, crossNote: 'Relevantno i za SEO i za AEO — noindex stranica se neće pojaviti ni u izvorima na koje se AI answer engine-i (delimično) oslanjaju preko Google indeksa.',
        crossNoteReverse: 'Relevantno i za SEO i za AEO — noindex direktiva potpuno uklanja stranicu iz Google pretrage, što je najdirektniji mogući SEO problem.' });
    } else {
      addSuccess({ category: 'Meta i head tagovi', title: 'Stranica nije markirana kao noindex', description: '', element: document.head,
        crossRelevant: true, crossNote: 'Relevantno i za SEO i za AEO — noindex stranica se ne bi pojavila ni u izvorima na koje se AI answer engine-i (delimično) oslanjaju preko Google indeksa.',
        crossNoteReverse: 'Relevantno i za SEO i za AEO — stranica je indeksibilna i može se pojaviti u Google pretrazi.' });
    }

    var blocksSnippet = robots && (/nosnippet/i.test(robots) || /max-snippet:\s*0\b/i.test(robots));
    if (blocksSnippet) {
      addFinding({ category: 'Meta i head tagovi', severity: 'error', title: 'Robots direktiva blokira prikaz isečka sadržaja (nosnippet/max-snippet:0)',
        description: 'meta robots = "' + robots + '"',
        why: 'Ova direktiva eksplicitno zabranjuje Google-u (i bilo kom AI answer engine-u koji se delimično oslanja na Google-ov indeks) da prikaže BILO KAKAV isečak teksta sa stranice — stranica se ne može pojaviti u AI Overviews ili featured snippet-ima, niti dobiti opis u klasičnim rezultatima pretrage. Ovo je direktan, dokumentovan i binaran blokator vidljivosti, ne heuristika.',
        fix: 'Ukloni "nosnippet" i "max-snippet:0" iz meta robots taga, osim ako je namerno (npr. stranica sa osetljivim sadržajem).', element: document.head,
        crossRelevant: true, crossNote: 'Relevantno i za SEO i za AEO — ovo direktno sprečava AI answer engine-e da citiraju bilo koji deo sadržaja stranice.',
        crossNoteReverse: 'Relevantno i za SEO i za AEO — bez isečka, Google rezultat za ovu stranicu nema opis, što drastično smanjuje CTR čak i ako stranica dobro rangira.' });
    } else {
      addSuccess({ category: 'Meta i head tagovi', title: 'Robots direktiva ne blokira prikaz isečka sadržaja', description: '', element: document.head,
        crossRelevant: true, crossNote: 'Relevantno i za SEO i za AEO — Google i AI answer engine-i mogu slobodno da prikažu isečak sadržaja ove stranice.',
        crossNoteReverse: 'Relevantno i za SEO i za AEO — stranica može imati normalan opis/isečak u Google rezultatima pretrage.' });
    }

    var htmlLang = document.documentElement.getAttribute('lang');
    if (!htmlLang) {
      addFinding({ category: 'Meta i head tagovi', severity: 'warning', title: 'lang atribut nedostaje na <html>',
        description: '<html> nema lang atribut.', why: 'Pomaže i pretraživačima i screen readerima da znaju na kom je jeziku sadržaj.',
        fix: 'Podesi jezik sajta u Webflow Site Settings.', element: document.documentElement });
    } else {
      addSuccess({ category: 'Meta i head tagovi', title: 'lang atribut je prisutan na <html> (' + htmlLang + ')', description: '', element: document.documentElement });
    }

    var viewport = document.querySelector('meta[name="viewport"]');
    if (!viewport) {
      addFinding({ category: 'Meta i head tagovi', severity: 'error', title: 'Viewport meta tag nedostaje',
        description: 'Nema <meta name="viewport">.', why: 'Bez ovoga stranica nije mobile-friendly, što direktno utiče na mobile-first indexing.',
        fix: 'Webflow ovo obično dodaje automatski — proveri da custom kod nije obrisao tag.', element: document.head });
    } else {
      addSuccess({ category: 'Meta i head tagovi', title: 'Viewport meta tag je prisutan', description: '', element: document.head });
      var vpContent = viewport.getAttribute('content') || '';
      if (/user-scalable\s*=\s*no/i.test(vpContent) || /maximum-scale\s*=\s*1(\.0)?\b/.test(vpContent)) {
        addFinding({ category: 'Meta i head tagovi', severity: 'warning', title: 'Viewport onemogućava zumiranje korisniku',
          description: 'viewport = "' + vpContent + '"', why: 'Google Search Console eksplicitno flaguje "user-scalable=no"/"maximum-scale=1" kao mobile usability problem — sprečava korisnike sa slabijim vidom da uvećaju sadržaj na mobilnom.',
          fix: 'Ukloni user-scalable=no i maximum-scale=1 iz viewport taga (dozvoli zumiranje bar do maximum-scale=5).', element: document.head });
      } else {
        addSuccess({ category: 'Meta i head tagovi', title: 'Viewport dozvoljava korisniku da zumira stranicu', description: '', element: document.head });
      }
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
          addFinding({ category: 'Meta i head tagovi', severity: 'warning', title: 'OG image je veća od preporučenih 300KB (' + fmtBytes(parseInt(len, 10)) + ')',
            description: 'og:image: ' + ogImageUrl, why: 'Neke platforme (npr. WhatsApp) agresivno kompresuju velike slike, što može pogoršati kvalitet preview-a.',
            fix: 'Kompresuj sliku na ispod 300KB.', element: null });
          renderPanel();
        }
      }).catch(function () { /* CORS - ignore silently */ });
    } catch (e) {}
  }

  // ---------------------------------------------------------------------
  // 5.1b Favicon
  // ---------------------------------------------------------------------
  // Google Search Central eksplicitno dokumentuje favicon zahteve da bi se sajt prikazao sa
  // svojom ikonicom u mobilnim rezultatima pretrage (kvadratan, min. 48x48px, mora biti
  // crawlable). Nije core ranking faktor (isto kao OG tagovi) — otud "warning", ne "error" za
  // odsustvo, ali "nosnippet"-nivoa direktan blok (robots.txt Disallow) ostaje takođe warning
  // jer pogađa samo prikaz ikonice, ne ceo sadržaj stranice.
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
      addFinding({ category: 'Favicon', severity: 'warning', title: 'Favicon nedostaje ili se ne učitava',
        description: linkEl ? ('Pronađen <link> tag, ali resurs (' + faviconUrl + ') se ne učitava.') : ('Nema <link rel="icon"> u head-u, a ni fallback /favicon.ico ne postoji.'),
        why: 'Google Search Central eksplicitno dokumentuje favicon zahteve da bi se sajt prikazao sa svojom ikonicom u mobilnim rezultatima pretrage i u Chrome tabovima/bookmark-ovima — bez njega se prikazuje generička ikonica, što smanjuje prepoznatljivost brenda i CTR u SERP-u.',
        fix: 'Dodaj favicon u Webflow Site Settings > Icons (kvadratan, minimum 48x48px, .ico/.png/.svg).', element: linkEl || head });
    }

    function checkDimensionsAndFormat(url) {
      var ext = (url.split('?')[0].split('.').pop() || '').toLowerCase();
      if (ext && ['ico', 'png', 'svg', 'gif'].indexOf(ext) === -1) {
        addFinding({ category: 'Favicon', severity: 'info', title: 'Favicon je u neuobičajenom formatu (' + ext.toUpperCase() + ')',
          description: url, why: 'Najšira podrška (browseri, Google Search) je za .ico, .png i .svg formate — ostali formati se mogu nepredvidivo ponašati u browser UI-u.',
          fix: 'Koristi .ico, .png ili .svg format za favicon.', element: linkEl || head });
      }
      var img = new Image();
      img.onload = function () {
        var w = img.naturalWidth, h = img.naturalHeight;
        var issues = [];
        if (w && h && Math.abs(w - h) > 1) issues.push('nije kvadratan (' + w + 'x' + h + ')');
        if (w && h && (w < 48 || h < 48)) issues.push('manji je od preporučenih 48x48px (' + w + 'x' + h + ')');
        if (issues.length) {
          addFinding({ category: 'Favicon', severity: 'info', title: 'Favicon dimenzije nisu idealne (' + issues.join(', ') + ')',
            description: url, why: 'Google preporučuje kvadratan favicon, minimum 48x48px (u multiplu te veličine), da bi se čisto prikazao u rezultatima pretrage i browser UI-u na svim rezolucijama.',
            fix: 'Zameni favicon kvadratnom slikom minimum 48x48px (idealno 128x128px za retina ekrane).', element: linkEl || head });
        } else if (w && h) {
          addSuccess({ category: 'Favicon', title: 'Favicon je kvadratan i odgovarajuće veličine (' + w + 'x' + h + ')', description: url, element: linkEl || head });
        }
        renderPanel();
      };
      img.onerror = function () { /* HEAD fetch iznad već hvata realnu "ne postoji" grešku — ovde tiho ignorišemo. */ };
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
            addFinding({ category: 'Favicon', severity: 'warning', title: 'Favicon je blokiran u robots.txt',
              description: 'Putanja "' + path + '" je obuhvaćena Disallow pravilom u /robots.txt (User-agent: *).',
              why: 'Ako Googlebot ne sme da pristupi favicon fajlu, ne može ni da ga prikaže u mobilnim rezultatima pretrage — Google Search Central eksplicitno traži da favicon URL bude crawlable.',
              fix: 'Dodaj Allow pravilo za favicon putanju u robots.txt, ili suzi Disallow pravilo da je ne obuhvata.', element: null });
            renderPanel();
          }
        }).catch(function () { /* robots.txt ne postoji ili CORS — ignoriši tiho */ });
      } catch (e) {}
    }

    try {
      fetch(faviconUrl, { method: 'HEAD' }).then(function (r) {
        if (!r.ok) { reportBroken(); renderPanel(); return; }
        var ct = r.headers.get('content-type') || '';
        if (ct && ct.indexOf('image') === -1 && ct.indexOf('icon') === -1) { reportBroken(); renderPanel(); return; }
        addSuccess({ category: 'Favicon', title: 'Favicon je prisutan i uspešno se učitava', description: faviconUrl, element: linkEl || head });
        checkDimensionsAndFormat(faviconUrl);
        checkRobotsBlock(faviconUrl);
        renderPanel();
      }).catch(function () {
        // CORS na HEAD retko nastaje na istom domenu, ali za svaki slučaj ne prijavljujemo
        // lažnu grešku — samo probamo dimenzije/format (ako se slika uopšte učita).
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
      addFinding({ category: 'URL i duplikacija stranice', severity: 'error',
        title: 'Canonical pokazuje na drugu putanju na istom sajtu',
        description: 'Trenutna stranica: ' + curPath + ' | Canonical: ' + canPath,
        why: 'Čest uzrok: stranica je duplirana u Webflow-u i canonical je ostao da pokazuje na original — Google onda ignoriše ovu stranicu u korist te druge.',
        fix: 'Proveri da li je ovo namerno. Ako nije, ispravi canonical u Page Settings da pokazuje na ovu stranicu.', element: canonicalEl,
        crossRelevant: true, crossNote: 'Relevantno i za SEO i za AEO — pogrešan canonical zbunjuje i AI answer engine-e oko toga koja je "prava" verzija stranice za citiranje.',
        crossNoteReverse: 'Relevantno i za SEO i za AEO — pogrešan canonical deli ranking signale (linkove, autoritet) između više URL-ova umesto da ih konsoliduje na jednu stranicu.' });
    } else {
      addSuccess({ category: 'URL i duplikacija stranice', title: 'Canonical tag je prisutan i pokazuje na ovu stranicu',
        description: 'Canonical: ' + canPath, element: canonicalEl,
        crossRelevant: true, crossNote: 'Relevantno i za SEO i za AEO — jasan "glavni" URL pomaže AI answer engine-ima da znaju koju verziju stranice da citiraju.',
        crossNoteReverse: 'Relevantno i za SEO i za AEO — ispravan canonical konsoliduje ranking signale na jednu, tačno određenu URL adresu.' });
    }
  }

  // ---------------------------------------------------------------------
  // 5.10 URL slug (duplikacija)
  // ---------------------------------------------------------------------

  function checkSlug() {
    var segments = location.pathname.split('/').filter(Boolean);
    var last = segments[segments.length - 1] || '';
    if (/-\d+$/.test(last) && /-[2-9]$/.test(last)) {
      addFinding({ category: 'URL i duplikacija stranice', severity: 'error',
        title: 'URL slug se završava sufiksom sličnim "-2" (' + last + ')',
        description: 'Putanja: ' + location.pathname,
        why: 'Webflow automatski dodaje "-2", "-3" itd. na slug kada se stranica duplira. Ovo je konkretan, verifikovan dokaz da je stranica nastala dupliranjem i da je slug ostao netaknut pre objave — direktan rizik od duplicate content-a i needeskriptivnog URL-a u pretrazi.',
        fix: 'Preimenuj slug u Page Settings u nešto opisno, i podesi 301 redirekciju sa starog ako je već indeksiran.', element: null });
    } else {
      addSuccess({ category: 'URL i duplikacija stranice', title: 'URL slug ne sadrži Webflow duplication sufiks (npr. "-2")',
        description: 'Putanja: ' + location.pathname, element: null });
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
    } else {
      addSuccess({ category: 'Heading struktura', title: 'Tačno jedan H1 pronađen na stranici',
        description: '"' + text(h1s[0]).slice(0, 80) + '"', element: h1s[0] });
    }

    var lastLevel = 0;
    var hierarchySkipFound = false;
    headings.forEach(function (h) {
      var level = parseInt(h.tagName.substring(1), 10);
      if (lastLevel > 0 && level - lastLevel > 1) {
        hierarchySkipFound = true;
        addFinding({ category: 'Heading struktura', severity: 'warning', title: 'Preskočena heading hijerarhija (H' + lastLevel + ' → H' + level + ')',
          description: '"' + text(h).slice(0, 80) + '"', why: 'Preskakanje nivoa (npr. H1 pa odmah H3) remeti logičku strukturu dokumenta za screen readere i crawlere.',
          fix: 'Koristi heading nivoe redom, bez preskakanja.', element: h });
      }
      lastLevel = level;
    });
    if (!hierarchySkipFound && headings.length > 1) {
      addSuccess({ category: 'Heading struktura', title: 'Heading hijerarhija je bez preskočenih nivoa',
        description: headings.length + ' heading elemenata na stranici.', element: null });
    }

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

  // Best-effort: pronalazi da li je width/height za element eksplicitno fiksiran preko CSS-a
  // (klase, inline style) — ne samo preko HTML width/height atributa. Ne uzima u obzir
  // specifičnost/!important niti da li je @media blok trenutno aktivan (best-effort heuristika,
  // isto kao i ostale CSS-parsing provere u ovom fajlu).
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
        // Napomena: neki browseri/implementacije izlažu prazan (ali "truthy") .cssRules i na
        // običnim CSSStyleRule objektima, pa NE prekidamo obradu na osnovu samog postojanja
        // .cssRules — prvo proveravamo selector/style match, pa TEK ONDA (dodatno) rekurzija
        // u eventualne ugnježdene pravila (@media, @supports...).
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

    applyDecl(el.style); // inline style ima najveći prioritet, primenjuje se poslednji

    return declared;
  }

  // Da li je jedna CSS/HTML vrednost dužine "fiksirana" (ima stvaran efekat), bez obzira na
  // jedinicu (px, rem, vw, %, ...) — jedino što je "nefiksirano" su auto/initial/inherit/unset
  // ili odsustvo vrednosti. Namerno ne proverava jedinicu: 10rem je isto toliko validno fiksiranje
  // kao 160px, dokle god nije "auto" (dogovoreno sa korisnikom 10.08.2026).
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

    imgs.forEach(function (img) {
      if (!isVisible(img)) return;
      checkedImgCount++;

      // Webflow tehnički implementira "Alt Text: Decorative" tako što ostavi alt="" (PRAZAN, ali
      // PRISUTAN atribut). NAPOMENA (10.08.2026, posle provere): potvrđeno je da "Decorative"
      // opcija zaista generiše alt="" (zvaničan Webflow changelog), ALI nije potvrđeno da li
      // Webflow radi ISTO i kad developer prosto NIKAD ne dotakne Alt Text polje (ne bira svesno
      // "Decorative"). Znači ne možemo sa sigurnošću iz samog HTML-a da tvrdimo da je "Decorative"
      // svesno izabrano — moglo je i slučajno ostati prazno. Poruka je zato namerno formulisana
      // kao "možda", ne kao potvrđena činjenica.
      var hasAltAttr = img.hasAttribute('alt');
      var altText = hasAltAttr ? (img.getAttribute('alt') || '').trim() : '';
      var isDecorative = hasAltAttr && altText === '';
      var isMissing = !hasAltAttr;
      var isGeneric = hasAltAttr && altText !== '' && GENERIC_ALT_PATTERNS.test(altText);

      if (isDecorative) {
        addFinding({ category: 'Slike', severity: 'info',
          title: 'Alt tekst je prazan (alt="") — verovatno postavljeno na "Decorative" u Webflow-u',
          description: (img.currentSrc || img.src || '').slice(0, 120),
          why: 'Prazan ali PRISUTAN alt="" je ispravan ARIA obrazac kad je slika SVESNO označena kao dekorativna u Webflow-u (screen reader je onda preskače). NE možemo sa sigurnošću utvrditi iz samog HTML-a da li je ovo svesno urađeno ili je Alt Text polje prosto ostalo netaknuto/zaboravljeno — oba slučaja mogu izgledati identično u renderovanom kodu.',
          fix: 'Proveri direktno u Webflow Designer-u (Image Settings) da li Alt Text polje zaista pokazuje "Decorative". Ako da — nema potrebne akcije. Ako je slika zapravo trebalo da ima opisan alt tekst, dodaj ga.',
          element: img });
      } else if (isMissing || isGeneric) {
        addFinding({ category: 'Slike', severity: 'error',
          title: isMissing ? 'Slika: nedostaje alt atribut' : 'Slika: generički alt tekst ("' + altText + '")',
          description: (img.currentSrc || img.src || '').slice(0, 120),
          why: 'Alt tekst opisuje sliku pretraživačima i screen readerima; bez opisnog alt teksta slika je "nevidljiva" za SEO i pristupačnost.',
          fix: 'Dodaj opisan alt tekst u Webflow Asset Manager-u (ili svesno postavi na "Decorative" ako je slika zaista čisto dekorativna).',
          element: img });
      } else {
        goodAltCount++;
      }

      // CLS (Cumulative Layout Shift) u tipičnom block-flow layoutu (najčešći slučaj na
      // Webflow stranicama) je pre svega posledica NEPOZNATE VISINE u trenutku učitavanja —
      // čim je visina fiksirana (HTML atribut ILI CSS, bilo koja jedinica: px, rem, vw...),
      // browser odmah rezerviše taj vertikalni prostor i ostatak stranice se ne pomera kad se
      // slika učita, BEZ OBZIRA na to da li je širina "auto" ili takođe fiksirana. Širina koja
      // se sama računa (auto, na osnovu aspect-ratio-a slike) ne remeti već rezervisan vertikalni
      // prostor. Zato (dogovoreno sa korisnikom 10.08.2026) se ovde gleda ISKLJUČIVO da li je
      // VISINA fiksirana — širina više nije uslov za "bezbedno", i ovakve slike se ne prijavljuju
      // ni kao warning/error NI kao info napomena, već idu direktno u Success tab.
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
        addFinding({ category: 'Slike', severity: 'error',
          title: 'Slika nema fiksiranu visinu (ni HTML atribut ni CSS)',
          description: (img.currentSrc || img.src || '').slice(0, 120) +
            '\nCSS width: ' + (declared.width || 'nije pronađeno/definisano') +
            ' | CSS height: ' + (declared.height || 'nije pronađeno/definisano'),
          why: 'Ni HTML height atribut ni CSS ne fiksiraju visinu (vrednost je "auto" ili nije uopšte definisana) — browser ne može unapred da rezerviše vertikalni prostor za sliku, što realno izaziva layout shift (CLS) dok se slika ne učita. CLS je zvaničan Google Core Web Vital/ranking signal, pa je ovo verifikovan uzrok konkretnog problema sa merljivim uticajem na SEO, ne samo teorijski rizik. Širina nije uslov ovde — fiksirana širina sama po sebi ne rezerviše vertikalni prostor.',
          fix: 'Dodaj eksplicitnu visinu (HTML height atribut, ili CSS height u bilo kojoj jedinici — px, rem, vw...) direktno na <img> tag ili u Style panelu. Širina može ostati auto.',
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
        internalHostCount++;
        var ext = (src.split('?')[0].split('.').pop() || '').toLowerCase();
        if (['jpg', 'jpeg', 'png', 'gif'].indexOf(ext) !== -1) {
          addFinding({ category: 'Slike', severity: 'info', title: 'Slika nije u modernom formatu (trenutno: ' + ext.toUpperCase() + ')',
            description: src, why: 'AVIF/WebP daju znatno manju veličinu fajla pri istom kvalitetu, što ubrzava učitavanje stranice.',
            fix: 'Konvertuj u WebP ili AVIF (Webflow ima opciju automatske optimizacije slika u Asset Manager-u).', element: img });
        } else if (['webp', 'avif'].indexOf(ext) !== -1) {
          modernFormatCount++;
        }

        try {
          fetch(src, { method: 'HEAD' }).then(function (r) {
            var len = r.headers.get('content-length');
            if (len && parseInt(len, 10) > 500 * 1024) {
              addFinding({ category: 'Slike', severity: 'error', title: 'Slika je veća od 500KB (' + fmtBytes(parseInt(len, 10)) + ')',
                description: src, why: 'Velike slike usporavaju učitavanje stranice i pogoršavaju LCP (Largest Contentful Paint) — zvaničan Google Core Web Vital/ranking signal. Veličina fajla je direktno izmerena (content-length header), ne pretpostavka.',
                fix: 'Kompresuj sliku (npr. TinyPNG/Squoosh) ili je konvertuj u WebP/AVIF.', element: img });
              renderPanel();
            }
          }).catch(function () {});
        } catch (e) {}
      }
    });

    if (checkedImgCount > 0 && goodAltCount > 0) {
      addSuccess({ category: 'Slike', title: goodAltCount + ' od ' + checkedImgCount + ' vidljivih slika ima opisan (ili svesno dekorativan) alt tekst',
        description: '', element: null });
    }
    // Namerno NEMA nikakvog finding-a (ni warning ni info) za slike gde je visina fiksirana —
    // dogovoreno sa korisnikom 10.08.2026 da je ovo u potpunosti prihvatljivo (slika će svakako
    // biti vidljiva, širina se sama izračuna na osnovu aspect-ratio-a). Ide direktno u Success,
    // razdvojeno po tipu radi transparentnosti (obe dimenzije fiksirane vs. samo visina).
    if (bothDimsFixedCount > 0) {
      addSuccess({ category: 'Slike', title: bothDimsFixedCount + ' slika ima fiksirane obe dimenzije (HTML atribut ili CSS, bilo koja jedinica)',
        description: '', element: null });
    }
    if (heightOnlyFixedCount > 0) {
      addSuccess({ category: 'Slike', title: heightOnlyFixedCount + ' slika ima fiksiranu visinu (širina je auto — bezbedno, ne izaziva CLS)',
        description: '', why: 'Fiksirana visina sama rezerviše vertikalni prostor bez obzira na širinu, pa je ovo dovoljno da spreči layout shift.', element: null });
    }
    if (checkedImgCount > 0 && internalHostCount === checkedImgCount) {
      addSuccess({ category: 'Slike', title: 'Sve slike su hostovane na istom domenu/Webflow Assets (nema eksternih hostova)',
        description: '', element: null });
    }
    if (modernFormatCount > 0) {
      addSuccess({ category: 'Slike', title: modernFormatCount + ' slika je već u modernom formatu (WebP/AVIF)',
        description: '', element: null });
    }
  }

  // ---------------------------------------------------------------------
  // 5.4 Linkovi
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
        addFinding({ category: 'Linkovi', severity: 'warning', title: 'Link ne vodi nigde (href="' + (href || '') + '")',
          description: '"' + text(a).slice(0, 60) + '"',
          why: 'Ako ovo predstavlja tab/akordeon koji samo menja prikaz na istoj stranici, ispravan pristup po WAI-ARIA Tabs obrascu je <button> sa role="tab", ne <a> link — link semantički implicira navigaciju.',
          fix: 'Ako element ne navigira nigde, promeni ga u <button> (ili dodaj role="tab"/role="button" + odgovarajuće ARIA atribute).', element: a });
      }

      // In-page anchor targets
      if (href && href.charAt(0) === '#' && href.length > 1) {
        var targetId = href.slice(1);
        if (!document.getElementById(targetId) && !document.getElementsByName(targetId).length) {
          brokenAnchorFound = true;
          addFinding({ category: 'Linkovi', severity: 'error', title: 'Anchor link vodi ka ID-ju koji ne postoji (#' + targetId + ')',
            description: '"' + text(a).slice(0, 60) + '"', why: 'Klik na ovaj link neće uraditi ništa jer element sa tim ID-jem ne postoji na stranici.',
            fix: 'Proveri da li je ciljni element preimenovan ili obrisan, i ispravi href ili ID.', element: a });
        }
      }

      var linkText = text(a);
      // Napomena (dodato posle rigoroznog pregleda 10.08.2026): pre ove ispravke, provera je
      // gledala SAMO vidljiv tekst i <img> dete — ignorisala je aria-label/aria-labelledby i
      // SVG ikonice (čest obrazac za "icon-only" linkove, npr. dugme sa SVG ikonicom bez
      // vidljivog teksta ali sa validnim aria-label-om). Bez ove provere, alat bi lažno
      // prijavljivao potpuno ispravne, pristupačne linkove kao "bez teksta".
      var hasAriaLabel = !!(a.getAttribute('aria-label') && a.getAttribute('aria-label').trim());
      var hasAriaLabelledby = !!(a.getAttribute('aria-labelledby') && a.getAttribute('aria-labelledby').trim());
      var hasIconChild = !!a.querySelector('img, svg');
      if (!linkText && !hasIconChild && !hasAriaLabel && !hasAriaLabelledby) {
        noTextLinkFound = true;
        addFinding({ category: 'Linkovi', severity: 'warning', title: 'Link bez teksta (i bez slike/ikonice/aria-label-a)',
          description: href || '(nema href)', why: 'Prazan link nosi nula konteksta za korisnika i za crawler.',
          fix: 'Dodaj vidljiv tekst ili aria-label.', element: a });
      } else if (GENERIC_ANCHOR.test(linkText.trim())) {
        // Napomena: naslov je ranije pogrešno pisao "Negenerički" (obrnuto od stvarnog značenja) —
        // ova grana se aktivira baš kad JE tekst generički (poklapa GENERIC_ANCHOR obrazac).
        addFinding({ category: 'Linkovi', severity: 'info', title: 'Generički anchor tekst: "' + linkText.trim() + '"',
          description: 'href: ' + href, why: 'Opisan anchor tekst pomaže korisnicima i Google-u da razumeju kuda link vodi.',
          fix: 'Zameni sa opisnim tekstom (npr. "Pogledaj cenovnik" umesto "klikni ovde").', element: a });
      }

      if (href && !isEmpty && sameHost(href, location.hostname)) {
        internalToCheck.push({ el: a, href: href });
      }
    });

    if (checkedLinkCount > 0 && !emptyHrefFound) {
      addSuccess({ category: 'Linkovi', title: 'Nema linkova koji ne vode nigde (svi href atributi su validni)', description: '', element: null });
    }
    if (checkedLinkCount > 0 && !brokenAnchorFound) {
      addSuccess({ category: 'Linkovi', title: 'Svi in-page anchor linkovi (#id) vode ka postojećim elementima', description: '', element: null });
    }
    if (checkedLinkCount > 0 && !noTextLinkFound) {
      addSuccess({ category: 'Linkovi', title: 'Svi linkovi imaju vidljiv tekst ili sliku', description: '', element: null });
    }

    // 404 / redirect chain check for internal links (best-effort, limited count)
    var toCheck = internalToCheck.slice(0, 25);
    var linkCheckSettled = 0;
    var linkCheckProblemFound = false;
    function maybeReportLinkCheckSuccess() {
      linkCheckSettled++;
      if (linkCheckSettled === toCheck.length && !linkCheckProblemFound) {
        addSuccess({ category: 'Linkovi', title: 'Svi provereni interni linkovi (' + toCheck.length + ') vraćaju uspešan odgovor bez 404/redirekcije',
          description: '', element: null });
        renderPanel();
      }
    }
    toCheck.forEach(function (item) {
      try {
        fetch(item.href, { method: 'GET', redirect: 'manual' }).then(function (r) {
          if (r.status === 404) {
            linkCheckProblemFound = true;
            addFinding({ category: 'Linkovi', severity: 'error', title: 'Interni link vodi na 404 stranicu',
              description: item.href, why: 'Slomljen interni link šteti i korisničkom iskustvu i crawl efikasnosti.',
              fix: 'Ispravi link ili vrati/preimenuj ciljnu stranicu.', element: item.el });
            renderPanel();
          } else if (r.type === 'opaqueredirect' || (r.status >= 300 && r.status < 400)) {
            linkCheckProblemFound = true;
            addFinding({ category: 'Linkovi', severity: 'info', title: 'Interni link prolazi kroz redirekciju',
              description: item.href, why: 'Nije slomljeno, ali redirekcija usporava i razvodnjava link signal.',
              fix: 'Ako je moguće, ažuriraj link da vodi direktno na finalni URL.', element: item.el });
            renderPanel();
          }
          maybeReportLinkCheckSuccess();
        }).catch(function () { /* CORS / network - ignore */ maybeReportLinkCheckSuccess(); });
      } catch (e) { maybeReportLinkCheckSuccess(); }
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
        fix: 'Dodaj više relevantnog, korisnog sadržaja.', element: main,
        crossRelevant: true, crossNote: 'Relevantno i za SEO i za AEO — AI answer engine-i citiraju stranice sa dovoljno supstance da direktno odgovore na pitanje; "thin content" retko biva citiran.',
        crossNoteReverse: 'Relevantno i za SEO i za AEO — Google tradicionalno slabije rangira "thin content" stranice jer ne pružaju dovoljno vrednosti korisniku u odnosu na konkurenciju.' });
    } else {
      addSuccess({ category: 'Sadržaj', title: 'Stranica ima dovoljno vidljivog teksta (' + visibleTextLen + ' karaktera)', description: '', element: main,
        crossRelevant: true, crossNote: 'Relevantno i za SEO i za AEO — AI answer engine-i citiraju stranice sa dovoljno supstance da direktno odgovore na pitanje.',
        crossNoteReverse: 'Relevantno i za SEO i za AEO — dovoljna količina kvalitetnog sadržaja je osnovni preduslov da Google proceni stranicu kao vrednu rangiranja.' });
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
    var repeatedWordFound = false;
    while ((m = repeatRegex.exec(bodyText)) !== null) {
      var word = m[1].toLowerCase();
      if (seenRepeats[word]) continue;
      seenRepeats[word] = true;
      repeatedWordFound = true;
      addFinding({ category: 'Sadržaj', severity: 'warning', title: 'Ponovljena reč zaredom: "' + m[1] + ' ' + m[1] + '"',
        description: '...' + bodyText.slice(Math.max(0, m.index - 30), m.index + 30) + '...',
        why: 'Najčešće copy-paste greška.', fix: 'Ukloni duplikat reči.', element: null });
    }
    if (!repeatedWordFound) {
      addSuccess({ category: 'Sadržaj', title: 'Nema ponovljenih reči zaredom (copy-paste greška)', description: '', element: null });
    }

    // Placeholder text
    var placeholderFound = false;
    PLACEHOLDER_PATTERNS.forEach(function (re) {
      var mm = bodyText.match(re);
      if (mm) {
        placeholderFound = true;
        addFinding({ category: 'Sadržaj', severity: 'error', title: 'Placeholder/Lorem ipsum tekst pronađen na stranici',
          description: '"...' + bodyText.slice(Math.max(0, bodyText.indexOf(mm[0]) - 20), bodyText.indexOf(mm[0]) + 60) + '..."',
          why: 'Čest slučaj kad CMS Rich Text element nije pravilno povezan sa pravim podatkom, pa ostane default vrednost.',
          fix: 'Zameni placeholder tekst pravim sadržajem pre objave.', element: null });
      }
    });
    if (!placeholderFound) {
      addSuccess({ category: 'Sadržaj', title: 'Nema placeholder/Lorem ipsum teksta na stranici', description: '', element: null });
    }

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
    } else if (distinct.length === 1) {
      addSuccess({ category: 'Fontovi', title: 'Stranica koristi samo 1 font (' + distinct[0] + ') — minimalan rizik za FOUT/FOIT', description: '', element: null });
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
    } else {
      addSuccess({ category: 'Fontovi', title: 'Nema dinamičkog učitavanja Google Fonts sa Google servera (GDPR rizik izbegnut)', description: '', element: null });
    }

    // Font format check
    try {
      document.fonts.forEach(function (f) {
        // FontFace API ne izlaže uvek src URL direktno; best effort preko toString()
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
      addFinding({ category: 'Fontovi', severity: 'info', title: 'Font fajl u starijem formatu (nije .woff2)',
        description: '', why: '.woff2 ima znatno bolju kompresiju od .ttf/.otf/.eot, manji fajl = brže učitavanje.',
        fix: 'Konvertuj font fajlove u .woff2 pre uploada u Webflow.', element: null });
    } else if (fontFaceRuleFound) {
      addSuccess({ category: 'Fontovi', title: 'Svi @font-face fajlovi su u modernom .woff2 formatu', description: '', element: null });
    }
  }

  // ---------------------------------------------------------------------
  // 5.7 Tehnički / crawlability
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
        addFinding({ category: 'Tehnički / crawlability', severity: 'info', title: 'Duplikatan ID atribut: "' + id + '" (' + idMap[id].length + ' puta)',
          description: '', why: 'Duplikatni ID-jevi lome in-page anchor linkove i ARIA reference (aria-controls, aria-labelledby) koje se oslanjaju na jedinstven ID. Čest rezultat kopiranja cele sekcije bez izmene ID-ja.',
          fix: 'Preimenuj duplikate u jedinstvene ID-jeve.', element: idMap[id][1] });
      }
    });
    if (!dupIdFound && Object.keys(idMap).length > 0) {
      addSuccess({ category: 'Tehnički / crawlability', title: 'Nema duplikatnih ID atributa na stranici', description: '', element: null });
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
      addFinding({ category: 'Tehnički / crawlability', severity: 'info', title: 'Veliki/preduboko ugnježden DOM (čvorova: ' + totalNodes + ', max dubina: ' + maxDepth + ', max dece jednog elementa: ' + maxChildren + ')',
        description: '', why: 'Prevelik DOM usporava rendering i otežava crawlerima efikasno parsiranje. Ovo je preporuka, ne greška — ako je namerno i ne pravi vidljiv problem, može se ignorisati.',
        fix: 'Razmotri pojednostavljenje strukture sekcija (manje ugnježdenih wrapper div-ova).', element: null,
        crossRelevant: true, crossNote: 'Relevantno i za SEO i za AEO — jednostavniji DOM je lakši i bržim/jednostavnijim AI crawlerima za parsiranje.',
        crossNoteReverse: 'Relevantno i za SEO i za AEO — preveliki/preduboko ugnježden DOM usporava renderovanje, što posredno pogoršava Core Web Vitals metrike koje Google koristi za rangiranje.' });
    } else {
      addSuccess({ category: 'Tehnički / crawlability', title: 'DOM veličina/dubina je u razumnim granicama (čvorova: ' + totalNodes + ', max dubina: ' + maxDepth + ')', description: '', element: null,
        crossRelevant: true, crossNote: 'Relevantno i za SEO i za AEO — jednostavniji DOM je lakši i bržim/jednostavnijim AI crawlerima za parsiranje.',
        crossNoteReverse: 'Relevantno i za SEO i za AEO — razumna veličina DOM-a doprinosi bržem renderovanju i boljim Core Web Vitals rezultatima.' });
    }

    // Mixed content
    if (location.protocol === 'https:') {
      var httpResources = Array.prototype.slice.call(document.querySelectorAll('img[src^="http://"], script[src^="http://"], link[href^="http://"], iframe[src^="http://"]'));
      httpResources.forEach(function (el) {
        addFinding({ category: 'Tehnički / crawlability', severity: 'error', title: 'Mixed content: HTTP resurs na HTTPS stranici',
          description: (el.src || el.href || ''), why: 'Browser može da blokira ili upozori na ovaj resurs, i to je bezbednosni signal.',
          fix: 'Promeni URL resursa na https://.', element: el,
          crossRelevant: true, crossNote: 'Relevantno i za SEO i za AEO — HTTPS/bezbednost je jedan od Tier-1 tehničkih signala koje AI answer engine-i uzimaju u obzir pri proceni pouzdanosti izvora.',
          crossNoteReverse: 'Relevantno i za SEO i za AEO — HTTPS je potvrđen Google ranking signal još od 2014, a mixed content upozorenja u browseru narušavaju poverenje korisnika.' });
      });
      if (!httpResources.length) {
        addSuccess({ category: 'Tehnički / crawlability', title: 'Nema mixed content-a — svi resursi se učitavaju preko HTTPS-a', description: '', element: null,
          crossRelevant: true, crossNote: 'Relevantno i za SEO i za AEO — HTTPS je Tier-1 tehnički signal pouzdanosti izvora.',
          crossNoteReverse: 'Relevantno i za SEO i za AEO — potpun HTTPS bez mixed content upozorenja je potvrđen Google ranking signal.' });
      }
    }

    // Third-party scripts without async/defer
    var scripts = Array.prototype.slice.call(document.querySelectorAll('head script[src], body script[src]'));
    var thirdPartyScriptCount = 0;
    var blockingScriptFound = false;
    scripts.forEach(function (s) {
      var src = s.getAttribute('src');
      var host = hostnameOf(src);
      if (host && host !== location.hostname) {
        thirdPartyScriptCount++;
        if (!s.async && !s.defer) {
          blockingScriptFound = true;
          var current = '<script src="' + src + '"></script>';
          var suggested = '<script src="' + src + '" defer></script>';
          addFinding({ category: 'Tehnički / crawlability', severity: 'error',
            title: 'Treće-strana skripta bez async/defer (' + host + ')',
            description: 'Trenutno:\n' + current + '\n\nPredloženo:\n' + suggested,
            why: 'Skripta bez async/defer blokira parsiranje/renderovanje stranice na tom mestu dok se ne preuzme i izvrši sa eksternog servera — jedan od najčešćih, dobro dokumentovanih uzroka lošeg LCP-a (Core Web Vital/ranking signal). Prisustvo/odsustvo atributa je direktno verifikovano na <script> tagu, ne pretpostavka.',
            fix: 'Dodaj "defer" atribut (preporučeno za skripte kojima je bitan redosled izvršavanja/DOM spremnost — većina chat widgeta i tracking piksela) ili "async" (za potpuno nezavisne skripte). Još bolje: premesti skriptu u Page Settings > Custom Code > "Before </body> tag" umesto u <head>.',
            element: s });
        }
      }
    });
    if (thirdPartyScriptCount > 0 && !blockingScriptFound) {
      addSuccess({ category: 'Tehnički / crawlability', title: 'Sve treće-strana skripte (' + thirdPartyScriptCount + ') imaju async/defer', description: '', element: null });
    }
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

    var CWV_CROSS_NOTE = 'Relevantno i za SEO i za AEO — Core Web Vitals su deo Tier-1 tehničkih signala koje AEO istraživanja povezuju sa verovatnoćom AI citiranja.';
    var CWV_CROSS_NOTE_REVERSE = 'Relevantno i za SEO i za AEO — Core Web Vitals (TTFB, LCP, CLS) su zvaničan Google ranking signal još od 2021. (Page Experience update).';

    // Dve granice po metrici (usklađeno sa Google-ovim zvaničnim "Needs Improvement" / "Poor"
    // pragovima za LCP i CLS; TTFB nije zvaničan Core Web Vital, ali 1800ms je uobičajen "loše"
    // prag u web.dev preporukama) — plitko "warning", duboko u "Poor" teritoriji "error".
    if (cwv.ttfb != null && cwv.ttfb > 800) {
      var ttfbPoor = cwv.ttfb > 1800;
      addFinding({ category: 'Performanse (CWV)', severity: ttfbPoor ? 'error' : 'warning', title: 'Spor TTFB (Time To First Byte): ' + cwv.ttfb + 'ms',
        description: '', why: (ttfbPoor ? 'Preko 1800ms je duboko u "loše" teritoriji. ' : 'Preko 800ms je sporo. ') + 'Server sporo odgovara na prvi zahtev.', fix: 'Proveri custom kod/integracije koje mogu usporavati server response.', element: null,
        crossRelevant: true, crossNote: CWV_CROSS_NOTE, crossNoteReverse: CWV_CROSS_NOTE_REVERSE });
    } else if (cwv.ttfb != null) {
      addSuccess({ category: 'Performanse (CWV)', title: 'TTFB je dobar (' + cwv.ttfb + 'ms, ispod 800ms praga)', description: '', element: null,
        crossRelevant: true, crossNote: CWV_CROSS_NOTE, crossNoteReverse: CWV_CROSS_NOTE_REVERSE });
    }
    if (cwv.lcp != null && cwv.lcp > 2500) {
      var lcpPoor = cwv.lcp > 4000;
      addFinding({ category: 'Performanse (CWV)', severity: lcpPoor ? 'error' : 'warning', title: 'Spor LCP (Largest Contentful Paint): ' + cwv.lcp + 'ms',
        description: '', why: 'Google smatra dobrim LCP ispod 2500ms' + (lcpPoor ? ', a preko 4000ms svrstava u "Poor" kategoriju' : '') + '. Sporiji LCP obično znači da je najveći element (najčešće hero slika) prevelik ili se sporo učitava.',
        fix: 'Optimizuj/kompresuj hero sliku, ukloni render-blocking resurse.', element: null,
        crossRelevant: true, crossNote: CWV_CROSS_NOTE, crossNoteReverse: CWV_CROSS_NOTE_REVERSE });
    } else if (cwv.lcp != null) {
      addSuccess({ category: 'Performanse (CWV)', title: 'LCP je dobar (' + cwv.lcp + 'ms, ispod 2500ms Google praga)', description: '', element: null,
        crossRelevant: true, crossNote: CWV_CROSS_NOTE, crossNoteReverse: CWV_CROSS_NOTE_REVERSE });
    }
    if (cwv.cls > 0.1) {
      var clsPoor = cwv.cls > 0.25;
      addFinding({ category: 'Performanse (CWV)', severity: clsPoor ? 'error' : 'warning', title: 'Visok CLS (Cumulative Layout Shift): ' + cwv.cls,
        description: '', why: 'Preko 0.1 znači primetno "skakanje" sadržaja tokom učitavanja' + (clsPoor ? ' (preko 0.25 je Google-ova "Poor" granica)' : '') + ' — najčešće zbog slika/fontova bez rezervisanog prostora.',
        fix: 'Dodaj width/height na slike, proveri font-display podešavanja.', element: null,
        crossRelevant: true, crossNote: CWV_CROSS_NOTE, crossNoteReverse: CWV_CROSS_NOTE_REVERSE });
    } else {
      addSuccess({ category: 'Performanse (CWV)', title: 'CLS je dobar (' + cwv.cls + ', ispod 0.1 Google praga)', description: '', element: null,
        crossRelevant: true, crossNote: CWV_CROSS_NOTE, crossNoteReverse: CWV_CROSS_NOTE_REVERSE });
    }

    if (done) setTimeout(done, 1200); // dati vremena PerformanceObserver bufferu
  }

  // ---------------------------------------------------------------------
  // 5.11 AEO (Answer Engine Optimization) provere
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
          title: 'JSON-LD schema blok sadrži nevalidan JSON',
          description: (s.textContent || '').slice(0, 150),
          why: 'Nevalidan JSON u <script type="application/ld+json"> se u potpunosti ignoriše od strane Google-a i AI crawlera — cela schema oznaka je beskorisna dok se ne ispravi sintaksa.',
          fix: 'Proveri JSON sintaksu (nedostajući/suvišni zarezi, navodnici) npr. na validator.schema.org.', element: s });
      }
    });
    if (scripts.length > 0 && !invalidFound) {
      addSuccess({ category: 'AEO - Structured data (Schema.org)', group: 'aeo',
        title: 'Svi JSON-LD schema blokovi (' + scripts.length + ') sadrže validan JSON', description: '', element: null });
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
    if (document.querySelector('article')) return true;
    var main = document.querySelector('main') || document.body;
    var wordCount = text(main).split(/\s+/).filter(Boolean).length;
    return wordCount > 600 && document.querySelectorAll('h2,h3').length >= 2;
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
        title: 'Stranica izgleda kao FAQ sekcija ali nema FAQPage schema markup',
        description: 'Pronađeni FAQ-oslični elementi (klase/ID sa "faq" ili 3+ heading-a u obliku pitanja) bez odgovarajuće JSON-LD FAQPage sheme.',
        why: 'Prema dosadašnjim AEO istraživanjima, FAQPage schema je najjači pojedinačni prediktor da će AI answer engine (ChatGPT, Perplexity, Google AI Overviews) citirati stranicu kao izvor odgovora.',
        fix: 'Dodaj JSON-LD FAQPage schema blok (mainEntity niz Question/acceptedAnswer objekata) koji odgovara vidljivim pitanjima i odgovorima na stranici.', element: null });
    } else if (faqSchemas.length) {
      faqSchemas.forEach(function (b) {
        var entities = b.raw.mainEntity;
        var arr = Array.isArray(entities) ? entities : (entities ? [entities] : []);
        if (!arr.length) {
          addFinding({ category: 'AEO - Structured data (Schema.org)', group: 'aeo', severity: 'error',
            title: 'FAQPage schema nema mainEntity (pitanja)',
            description: '', why: 'FAQPage bez mainEntity niza Question objekata je nepotpuna i neće se koristiti za FAQ rich rezultate ili AI citiranje.',
            fix: 'Dodaj mainEntity niz sa Question/acceptedAnswer objektima za svako pitanje sa stranice.', element: b.el });
        } else {
          var badItems = arr.filter(function (q) { return !q.acceptedAnswer || !q.acceptedAnswer.text; });
          if (badItems.length) {
            addFinding({ category: 'AEO - Structured data (Schema.org)', group: 'aeo', severity: 'error',
              title: badItems.length + ' pitanje/a u FAQPage schemi nema popunjen acceptedAnswer.text',
              description: '', why: 'Nepotpuna pitanja se neće koristiti za FAQ rich rezultate/AI citiranje. Ovo je verifikovana činjenica o samoj schema JSON strukturi (ne heuristika ni pretpostavka) — svako takvo pitanje je efektivno beskorisno dok se ne popuni.',
              fix: 'Popuni acceptedAnswer.text za svako Question u schemi.', element: b.el });
          } else {
            addSuccess({ category: 'AEO - Structured data (Schema.org)', group: 'aeo',
              title: 'FAQPage schema je prisutna i kompletna (' + arr.length + ' pitanja sa odgovorima)', description: '', element: b.el });
          }
        }
      });
    }

    // Article / BlogPosting / NewsArticle
    var articleSchemas = findSchemaByType(blocks, 'Article').concat(findSchemaByType(blocks, 'BlogPosting'), findSchemaByType(blocks, 'NewsArticle'));
    if (looksLikeArticle() && articleSchemas.length === 0) {
      addFinding({ category: 'AEO - Structured data (Schema.org)', group: 'aeo', severity: 'warning',
        title: 'Stranica izgleda kao članak/blog post ali nema Article schema markup',
        description: 'Pronađen <article> element ili dugačak tekst (600+ reči) sa više podnaslova, bez JSON-LD Article/BlogPosting sheme.',
        why: 'Article schema pomaže AI answer engine-ima i Google-u da razumeju autora, datum objave/izmene i temu stranice — svi Tier-1 tehnički AEO signali.',
        fix: 'Dodaj JSON-LD Article schema sa headline, author, datePublished, dateModified.', element: null });
    } else {
      articleSchemas.forEach(function (b) {
        if (!b.raw.dateModified && !b.raw.datePublished) {
          addFinding({ category: 'AEO - Structured data (Schema.org)', group: 'aeo', severity: 'error',
            title: 'Article schema nema ni dateModified ni datePublished',
            description: '', why: 'AI answer engine-i preferiraju sveže/nedavno ažurirane izvore — bez datuma nema signala svežine sadržaja, a ovo je Tier-1 AEO signal. Verifikovana činjenica o schema JSON-u (polje nedostaje ili ne postoji), ne heuristika.',
            fix: 'Dodaj dateModified (i datePublished) u ISO 8601 formatu. Najbolje: poveži polje automatski sa CMS "poslednja izmena" vrednošću umesto da bude ručno/hardkodovano, da se ne zaboravi ažurirati.', element: b.el });
        } else {
          addSuccess({ category: 'AEO - Structured data (Schema.org)', group: 'aeo',
            title: 'Article schema ima datePublished/dateModified', description: '', element: b.el });
        }
        var author = b.raw.author;
        var authorObj = Array.isArray(author) ? author[0] : author;
        var authorUrl = authorObj && authorObj.url;
        if (authorUrl) {
          try {
            fetch(authorUrl, { method: 'HEAD' }).then(function (r) {
              if (r.status === 404) {
                addFinding({ category: 'AEO - Structured data (Schema.org)', group: 'aeo', severity: 'error',
                  title: 'Author link u Article schemi vodi na 404',
                  description: 'author.url: ' + authorUrl,
                  why: 'Neispravan author link slabi E-E-A-T (Experience-Expertise-Authoritativeness-Trust) signal koji AI answer engine-i i Google koriste za procenu verodostojnosti izvora.',
                  fix: 'Ispravi author.url da vodi na validnu autorsku stranicu/profil.', element: b.el });
              } else {
                addSuccess({ category: 'AEO - Structured data (Schema.org)', group: 'aeo',
                  title: 'Author link u Article schemi je validan (ne vraća 404)', description: 'author.url: ' + authorUrl, element: b.el });
              }
              renderPanel();
            }).catch(function () {});
          } catch (e) {}
        } else if (!authorObj) {
          addFinding({ category: 'AEO - Structured data (Schema.org)', group: 'aeo', severity: 'info',
            title: 'Article schema nema author polje',
            description: '', why: 'Autor je jedan od E-E-A-T signala koje AI answer engine-i uzimaju u obzir pri proceni pouzdanosti sadržaja.',
            fix: 'Dodaj author (Person ili Organization) sa name i url.', element: b.el });
        } else {
          addSuccess({ category: 'AEO - Structured data (Schema.org)', group: 'aeo',
            title: 'Article schema ima author polje', description: '', element: b.el });
        }
      });
    }

    // Organization / LocalBusiness — NAP (Name-Address-Phone) konzistentnost
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
          addFinding({ category: 'AEO - NAP konzistentnost', group: 'aeo', severity: 'warning',
            title: 'Telefon u Organization/LocalBusiness schemi se ne poklapa sa brojem u footeru',
            description: 'Schema telephone: ' + b.raw.telephone,
            why: 'NAP (Name-Address-Phone) neusklađenost između schema markup-a i vidljivog sadržaja je signal koji AI answer engine-i i Google mogu tumačiti kao nepouzdan/neažuran izvor podataka.',
            fix: 'Uskladi telefon u schema markup-u sa onim koji je vidljivo prikazan u footeru.', element: b.el });
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
          addFinding({ category: 'AEO - NAP konzistentnost', group: 'aeo', severity: 'warning',
            title: 'Adresa iz Organization/LocalBusiness sheme se ne pojavljuje nigde u vidljivom footeru',
            description: 'Schema adresa: ' + addrStr,
            why: 'NAP neusklađenost (adresa navedena u schemi koje nema nigde vidljivo na stranici) slabi poverenje u strukturirane podatke.',
            fix: 'Prikaži istu adresu vidljivo (npr. u footeru) ili ukloni je iz scheme ako više nije tačna.', element: b.el });
        }
      }

      if (!napIssueFound && (schemaPhone || addrStr)) {
        addSuccess({ category: 'AEO - NAP konzistentnost', group: 'aeo',
          title: 'NAP podaci (telefon/adresa) iz schema markup-a su konzistentni sa footerom', description: '', element: b.el });
      }
    });

    // BreadcrumbList
    var breadcrumbSchemas = findSchemaByType(blocks, 'BreadcrumbList');
    if (looksLikeBreadcrumbUI() && breadcrumbSchemas.length === 0) {
      addFinding({ category: 'AEO - Structured data (Schema.org)', group: 'aeo', severity: 'info',
        title: 'Vidljiv breadcrumb UI postoji, ali nema BreadcrumbList schema markup',
        description: '', why: 'BreadcrumbList schema pomaže AI answer engine-ima i Google-u da razumeju hijerarhiju/kontekst stranice unutar sajta.',
        fix: 'Dodaj JSON-LD BreadcrumbList schema koja odgovara vidljivoj breadcrumb navigaciji.', element: null });
    } else if (breadcrumbSchemas.length) {
      addSuccess({ category: 'AEO - Structured data (Schema.org)', group: 'aeo',
        title: 'BreadcrumbList schema je prisutna', description: '', element: breadcrumbSchemas[0].el });
    }

    // JS-render zavisnost (best-effort heuristika)
    try {
      fetch(location.href, { method: 'GET' }).then(function (r) { return r.text(); }).then(function (rawHtml) {
        var tmp = document.createElement('div');
        tmp.innerHTML = rawHtml; // ne izvršava <script> tagove kad se seče ovako
        Array.prototype.forEach.call(tmp.querySelectorAll('script,style,noscript'), function (n) { n.remove(); });
        var rawText = (tmp.textContent || '').replace(/\s+/g, ' ').trim();
        var renderedText = text(document.body).replace(/\s+/g, ' ').trim();
        if (renderedText.length > 300 && rawText.length < renderedText.length * 0.3) {
          addFinding({ category: 'AEO - JS rendering zavisnost', group: 'aeo', severity: 'warning',
            title: 'Veći deo sadržaja se pojavljuje tek posle izvršavanja JavaScript-a (sirov HTML: ~' + rawText.length + ' kar., renderovano: ~' + renderedText.length + ' kar.)',
            description: '',
            why: 'Napomena: ovo je heuristika i može davati lažne rezultate (npr. cookie banner blokira fetch). Neki AI crawleri i jednostavniji botovi ne izvršavaju JavaScript pouzdano — ako je ključni sadržaj vidljiv tek posle JS renderovanja, rizikuje se da ti botovi "vide" praznu ili skoro praznu stranicu. Webflow stranice su obično server-renderovane pa je ovo retko, ali custom kod/embed-ovi mogu naknadno ubacivati sadržaj.',
            fix: 'Proveri "View Page Source" (Ctrl/Cmd+U) i uporedi sa onim što se vidi na ekranu — ako ključni tekst nedostaje u sirovom HTML-u, razmotri da taj sadržaj bude deo početnog HTML odgovora servera.', element: null });
          renderPanel();
        }
      }).catch(function () { /* CORS ili mrežna greška — preskoči */ });
    } catch (e) {}
  }

  // ---------------------------------------------------------------------
  // UI Overlay (shadow DOM panel)
  // ---------------------------------------------------------------------

  var panelHost, shadow, highlightBox;

  // Ikonica alata (10.08.2026, deo vizuelnog redizajna): reticle/highlight-box uglovi (direktna
  // referenca na sopstveni highlight box koji alat crta oko problema na strani) + checkmark
  // ("prošlo proveru") + signal/broadcast akcenat (stranica emituje signal koji čitaju i
  // pretraživači I AI answer engine-i — SEO+AEO u jednoj slici, bez klišeiziranog "AI sparkle").
  // Namerno originalna kombinacija, ne generički magnifying-glass/shield/bug ikonica koje se
  // koriste u većini SEO/audit alata.
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
  var activeSuccessGroup = 'all'; // 'all' | 'seo' | 'aeo' — filter UNUTAR Success taba
  var activeCategory = 'all'; // naziv kategorije (npr. 'Slike', 'Linkovi'...) ili 'all' — dodatni
                               // filter UNUTAR trenutnog severity filtera (error/warning/info/Sve)
  var activeCategoryOrigin = 'all'; // 'all' | 'shared' | 'solo' — sub-filter UNUTAR izabrane kategorije,
                               // relevantan samo kad ta kategorija sadrži i stavke sa crossRelevant:true
                               // ("AEO + SEO stavke", dele se sa "↔" napomenom u oba taba) i stavke bez
                               // te zastavice ("Samo SEO/AEO stavke", relevantne isključivo za tab u kom
                               // se trenutno gledaju) — npr. "Meta i head tagovi" u SEO tabu meša title/
                               // OG/Twitter (solo) sa canonical/noindex/nosnippet (shared). Vidi
                               // 10.08.2026 SPEC unos.

  // Drag (pomeranje) i resize (visina) stanje za panel — pamti se na modul nivou jer
  // renderPanel() u potpunosti ponovo kreira .panel div pri svakom pozivu (npr. na svaki novi
  // async nalaz, promenu taba ili filtera) — bez ovog pamćenja panel bi "skakao" nazad na
  // podrazumevanu poziciju/visinu pri svakom re-renderu.
  var panelPosition = null; // { top, left } u px, popunjava se čim korisnik prevuče panel
  var panelHeight = null; // px, popunjava se čim korisnik promeni visinu preko resize ručke
  var isDragging = false, dragStartX = 0, dragStartY = 0, dragStartTop = 0, dragStartLeft = 0;
  var isResizing = false, resizeStartY = 0, resizeStartHeight = 0;
  var MIN_PANEL_HEIGHT = 160;

  function setupDragHandlers() {
    if (setupDragHandlers._attached) return;
    setupDragHandlers._attached = true;
    document.addEventListener('mousemove', function (e) {
      var panelEl = shadow && shadow.querySelector('.panel');
      if (!panelEl) return;
      if (isDragging) {
        var dx = e.clientX - dragStartX;
        var dy = e.clientY - dragStartY;
        var newTop = Math.max(0, Math.min(window.innerHeight - 30, dragStartTop + dy));
        var newLeft = Math.max(0, Math.min(window.innerWidth - 30, dragStartLeft + dx));
        panelEl.style.top = newTop + 'px';
        panelEl.style.left = newLeft + 'px';
        panelEl.style.right = 'auto';
        panelPosition = { top: newTop, left: newLeft };
      }
      if (isResizing) {
        var dyResize = e.clientY - resizeStartY;
        var newHeight = Math.max(MIN_PANEL_HEIGHT, resizeStartHeight + dyResize);
        panelEl.style.height = newHeight + 'px';
        panelHeight = newHeight;
      }
    });
    document.addEventListener('mouseup', function () {
      if (isDragging) { isDragging = false; document.body.style.userSelect = ''; }
      if (isResizing) { isResizing = false; document.body.style.userSelect = ''; }
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
      // box-sizing:border-box na SVE elemente unutar panela — bez ovoga padding/border na
      // .item ili .desc mogu gurnuti sadržaj šire od deklarisane širine panela i izazvati
      // horizontalni scroll čak i kad je word-break ispravno podešen.
      '.panel *{box-sizing:border-box;}',
      // --- Vizuelni redizajn (10.08.2026) — korisnik je tražio "moderniji" izgled, dosadašnji
      // je delovao "old school"/neozbiljno. Glavni krivci su bili: pljosnate jednobojne pozadine,
      // pune zasićene boje na severity badge-ovima (klasičan "Windows alert box" izgled), oštra
      // 2px linija za aktivan tab, generički system font, i podrazumevani (nestilizovani)
      // scrollbar/select. Ispravke ispod, redom.
      //
      // 1) Font: Inter (ako je dostupan na sistemu ili preko fallback lanca) umesto generičkog
      // system-ui stacka, plus font-smoothing za čistiji render teksta na svim OS-ima.
      // 2) Panel pozadina: blaga vertikalna gradijent (umesto pljosnatog #111827) + suptilan
      // 1px "inset" obrub + mekša, dublja senka — daje "floating card" osećaj.
      // 3) Gornja akcentna traka (gradijent indigo→amber, isti akcent kao nova SVG ikonica) —
      // sitan detalj koji odmah signalizira da je ovo dizajnirani proizvod, ne brzi prototip.
      '.panel{position:fixed;top:12px;right:12px;width:380px;max-width:calc(100vw - 24px);max-height:90vh;min-height:' + MIN_PANEL_HEIGHT + 'px;display:flex;flex-direction:column;background:linear-gradient(180deg,#171a2e 0%,#0d0f1a 100%);color:#f3f4f6;font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased;font-size:13px;border-radius:16px;box-shadow:0 24px 60px -12px rgba(0,0,0,.6),0 0 0 1px rgba(255,255,255,.06);z-index:2147483647;overflow-x:hidden;overflow-y:hidden;}',
      '.panel::before{content:"";position:absolute;top:0;left:0;right:0;height:3px;background:linear-gradient(90deg,#6366f1,#a855f7 60%,#f59e0b);border-radius:16px 16px 0 0;}',
      '.hdr{position:relative;flex:0 0 auto;padding:13px 10px 13px 14px;background:rgba(255,255,255,.02);border-bottom:1px solid rgba(255,255,255,.06);display:flex;justify-content:space-between;align-items:center;cursor:move;user-select:none;}',
      '.hdr-title{display:flex;align-items:center;gap:8px;}',
      '.hdr-title svg{flex:0 0 auto;display:block;}',
      '.hdr b{font-size:13.5px;font-weight:700;letter-spacing:.01em;}',
      '.hdr button{background:transparent;color:#9ca3af;border:none;cursor:pointer;font-size:15px;width:26px;height:26px;border-radius:8px;display:flex;align-items:center;justify-content:center;transition:background-color .15s ease,color .15s ease;}',
      '.hdr button:hover{background:rgba(255,255,255,.08);color:#f3f4f6;}',
      '.tabs{flex:0 0 auto;display:flex;gap:2px;padding:6px 8px 0;background:transparent;}',
      '.tabbtn{flex:1;padding:8px 6px;background:transparent;border:none;color:#8b93a7;font-size:12px;font-weight:600;cursor:pointer;border-radius:8px 8px 0 0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;transition:background-color .15s ease,color .15s ease;position:relative;}',
      '.tabbtn:hover{color:#e5e7eb;background:rgba(255,255,255,.04);}',
      '.tabbtn.active{color:#f3f4f6;background:rgba(255,255,255,.07);}',
      '.tabbtn.active::after{content:"";position:absolute;left:10px;right:10px;bottom:0;height:2px;border-radius:2px;background:#6366f1;}',
      '.tabbtn.success-tab.active::after{background:#22c55e;}',
      '.summary{flex:0 0 auto;padding:10px 14px;display:flex;flex-wrap:wrap;gap:6px;border-bottom:1px solid rgba(255,255,255,.06);}',
      // Dropdown red za filtriranje po kategoriji (Slike, Linkovi...) — ide ISPOD severity
      // summary reda, iznad liste. Native <select> stilizovan da odgovara tamnoj temi panela,
      // sa custom strelicom (SVG data-uri) umesto podrazumevane (koja izgleda zastarelo).
      '.catrow{flex:0 0 auto;padding:0 14px 10px;border-bottom:1px solid rgba(255,255,255,.06);}',
      '.cat-select{appearance:none;-webkit-appearance:none;width:100%;background:rgba(255,255,255,.05) url(\'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="10" height="6" viewBox="0 0 10 6"><path d="M1 1L5 5L9 1" stroke="%239ca3af" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>\') no-repeat right 10px center;color:#e5e7eb;border:1px solid rgba(255,255,255,.1);border-radius:8px;padding:7px 28px 7px 10px;font-size:12px;font-family:inherit;cursor:pointer;transition:border-color .15s ease,background-color .15s ease;}',
      '.cat-select:hover{border-color:rgba(255,255,255,.22);background-color:rgba(255,255,255,.08);}',
      // 4) Badge-ovi: prelaz sa punih zasićenih pozadina (klasičan "alert box" izgled) na
      // suptilne, providne "tinted pill" boje sa tankim obrubom i malom tačkom iste boje ispred
      // teksta (dodaje se preko ::before, bez izmene JS/DOM strukture) — ovo je najveća pojedinačna
      // izmena koja "smanjuje" old-school utisak, jer su pune zasićene pozadine bile glavni krivac.
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
      // Grupni filter/tagovi UNUTAR Success taba (SEO/AEO klasifikacija uspešnih provera) —
      // namerno drugačije boje od .badge.info (plava) i AEO taba da se vizuelno razlikuju kao
      // "grupa" a ne "ozbiljnost". "Sve" koristi istu zelenu kao generički success badge.
      '.badge.group-all{background:rgba(34,197,94,.12);color:#86efac;border-color:rgba(34,197,94,.3);}',
      '.badge.group-seo{background:rgba(99,102,241,.12);color:#a5b4fc;border-color:rgba(99,102,241,.3);}',
      '.badge.group-aeo{background:rgba(168,85,247,.12);color:#d8b4fe;border-color:rgba(168,85,247,.3);}',
      '.badge.active{border-color:#6366f1;box-shadow:0 0 0 1px rgba(99,102,241,.35);}',
      '.badge.group-all.active{border-color:#22c55e;box-shadow:0 0 0 1px rgba(34,197,94,.35);}',
      '.badge.group-seo.active{border-color:#6366f1;box-shadow:0 0 0 1px rgba(99,102,241,.35);}',
      '.badge.group-aeo.active{border-color:#a855f7;box-shadow:0 0 0 1px rgba(168,85,247,.35);}',
      '.badge.success.active{border-color:#22c55e;box-shadow:0 0 0 1px rgba(34,197,94,.35);}',
      // .list je jedini skrolujući deo panela — flex:1 popunjava sav preostali prostor između
      // fiksnih delova (header/tabovi/summary) i resize ručke na dnu. overflow-x:hidden +
      // overflow-y:auto — dozvoljava vertikalni scroll, ali NIKAD horizontalni.
      '.list{flex:1 1 auto;min-height:0;overflow-y:auto;overflow-x:hidden;}',
      // 5) Custom (tanak, zaobljen) scrollbar umesto podrazumevanog — podrazumevani debeli sivi
      // scrollbar je jedan od najupadljivijih "ovo je neko brzo sklopio" signala u tamnim panelima.
      '.list::-webkit-scrollbar{width:8px;}',
      '.list::-webkit-scrollbar-track{background:transparent;}',
      '.list::-webkit-scrollbar-thumb{background:rgba(255,255,255,.12);border-radius:8px;}',
      '.list::-webkit-scrollbar-thumb:hover{background:rgba(255,255,255,.2);}',
      '.item{padding:11px 14px;border-bottom:1px solid rgba(255,255,255,.05);cursor:pointer;max-width:100%;transition:background-color .15s ease;}',
      '.item:hover{background:rgba(255,255,255,.035);}',
      '.item.success-item{cursor:default;}',
      '.item.success-item:hover{background:transparent;}',
      // word-break/overflow-wrap na SVE tekstualne delove stavke — ovo je ono što realno
      // sprečava horizontalni scroll kad tekst sadrži dugačke URL-ove, kod bez razmaka
      // (npr. <script src="...">) ili duge reči bez prirodnog mesta za prelom. white-space
      // ostaje pre-wrap na .desc (čuva namerne nove redove iz koda), ali overflow-wrap:anywhere
      // i dalje sme da prelomi PREDUGAČKU pojedinačnu "reč" (npr. URL) usred nje ako mora.
      '.item .cat, .item .title, .item .desc{overflow-wrap:anywhere;word-break:break-word;}',
      '.item .cat{color:#8b93a7;font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;font-weight:600;}',
      '.item .title{font-weight:600;margin:4px 0;line-height:1.4;}',
      // NAMERNO bez max-height/overflow:hidden ovde — ranija verzija je sekla duži tekst
      // (npr. "Trenutno/Predloženo" kod skript primera, ili duže "why" objašnjenje) na 60px
      // bez ikakvog načina da se pročita ostatak. Tekst se sad uvek prikazuje u punoj visini;
      // spoljni .list kontejner se brine o skrolovanju cele liste.
      '.item .desc{color:#c3c9d6;white-space:pre-wrap;font-size:12px;line-height:1.5;margin-top:4px;}',
      '.item .global{margin-top:6px;color:#fbbf24;font-size:11px;overflow-wrap:anywhere;word-break:break-word;}',
      '.item .cross{margin-top:6px;color:#c4b5fd;font-size:11px;overflow-wrap:anywhere;word-break:break-word;}',
      '.empty{padding:32px 20px;color:#8b93a7;font-size:13px;text-align:center;line-height:1.5;}',
      '.tag{display:inline-block;margin-right:4px;}',
      // 6) Resize ručka: fina zaobljena "grip" pilula (::after) umesto teksta "•••", isto
      // interakciono ponašanje (prevlačenje menja visinu), samo suptilniji vizuelni jezik.
      '.resize-handle{flex:0 0 auto;height:16px;display:flex;align-items:center;justify-content:center;cursor:ns-resize;background:transparent;border-top:1px solid rgba(255,255,255,.05);user-select:none;}',
      '.resize-handle::after{content:"";width:32px;height:4px;border-radius:4px;background:rgba(255,255,255,.14);transition:background-color .15s ease;}',
      '.resize-handle:hover::after{background:rgba(255,255,255,.28);}'
    ].join('');
    shadow.appendChild(style);

    highlightBox = document.createElement('div');
    highlightBox.style.cssText = 'position:fixed;pointer-events:none;border:3px solid #ef4444;border-radius:4px;z-index:2147483646;box-shadow:0 0 0 4000px rgba(0,0,0,.35);display:none;transition:all .15s ease;';
    document.documentElement.appendChild(highlightBox);

    setupDragHandlers();
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

  // Bira tekst "↔" napomene za crossRelevant nalaz/uspeh u zavisnosti od toga u kom kontekstu
  // (tabu/grupi) se trenutno prikazuje. contextGroup je 'seo' | 'aeo' | 'all' (za Success tab
  // kad je selektovano "Sve" — u tom slučaju nema "gost" konteksta, uvek se prikazuje matična
  // napomena, isto kao ranije). Oba teksta (crossNote i crossNoteReverse) UVEK počinju sa
  // "Relevantno i za SEO i za AEO" (dogovoreno 10.08.2026 — eksplicitno navesti oba, ne
  // implicitno pretpostaviti da je tab u kom se gleda već "ta druga strana") — razlika je samo
  // u KONKRETNOM obrazloženju posle crte: crossNote objašnjava iz SEO-ugla (prikazuje se kad je
  // item u svojoj matičnoj SEO grupi), crossNoteReverse iz AEO-ugla (prikazuje se kao "gost" u
  // AEO tabu/filteru).
  function getCrossText(item, contextGroup) {
    if (!item.crossRelevant) return '';
    var native = item.group === 'aeo' ? 'aeo' : 'seo';
    if (contextGroup && contextGroup !== 'all' && contextGroup !== native) {
      return item.crossNoteReverse || item.crossNote || 'Relevantno i za SEO i za AEO.';
    }
    return item.crossNote || 'Relevantno i za SEO i za AEO.';
  }

  function renderPanel() {
    ensurePanel();
    var old = shadow.querySelector('.panel');
    if (old) old.remove();

    // crossRelevant nalazi/uspesi (native SEO, ali sa dokumentovanim AEO uticajem) se sada
    // prikazuju U OBA taba — jednom sa napomenom "↔ Relevantno i za AEO" (u SEO tabu, njihovom
    // matičnom domu) i jednom sa obrnutom napomenom "↔ Relevantno i za SEO" (u AEO tabu, gde se
    // pojavljuju kao "gost"). Vidi getCrossText() ispod za logiku biranja teksta po kontekstu.
    var seoFindings = findings.filter(function (f) { return f.group !== 'aeo'; });
    var aeoFindings = findings.filter(function (f) { return f.group === 'aeo' || f.crossRelevant; });
    if (activeTab !== 'seo' && activeTab !== 'aeo' && activeTab !== 'success') activeTab = 'seo';
    var current = activeTab === 'aeo' ? aeoFindings : (activeTab === 'success' ? successes : seoFindings);

    var counts = { error: 0, warning: 0, info: 0 };
    if (activeTab !== 'success') {
      current.forEach(function (f) { counts[f.severity] = (counts[f.severity] || 0) + 1; });
    }

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
    var closeBtn = document.createElement('button');
    closeBtn.textContent = '✕';
    closeBtn.onclick = function () { panelHost.remove(); highlightBox.remove(); window.__SeoAuditorRunning = false; };
    hdr.appendChild(closeBtn);
    hdr.addEventListener('mousedown', function (e) {
      if (e.target === closeBtn) return; // ne pokreći drag kad se klikne na X dugme
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
    successTab.textContent = '✓ Uspešno (' + successes.length + ')';
    successTab.onclick = function () { activeTab = 'success'; renderPanel(); };
    tabs.appendChild(seoTab);
    tabs.appendChild(aeoTab);
    tabs.appendChild(successTab);
    panel.appendChild(tabs);

    if (activeSeverity !== 'all' && activeSeverity !== 'error' && activeSeverity !== 'warning' && activeSeverity !== 'info') activeSeverity = 'all';

    var order = { error: 0, warning: 1, info: 2 };
    var sorted;

    if (activeTab === 'success') {
      // Success tab nema severity filter (uspeh nema stepen ozbiljnosti), ALI ima svoj filter
      // po SEO/AEO grupi — isti `group` polje koje findings već koriste za SEO/AEO tabove.
      // Dosta provera je zajedničko za oba (npr. canonical, noindex, CWV, mixed content) —
      // te stavke ostaju u SEO grupi ali dobijaju "↔" napomenu, isto kao kod findings.
      var seoSuccesses = successes.filter(function (s) { return s.group !== 'aeo'; });
      var aeoSuccesses = successes.filter(function (s) { return s.group === 'aeo' || s.crossRelevant; });
      if (activeSuccessGroup !== 'all' && activeSuccessGroup !== 'seo' && activeSuccessGroup !== 'aeo') activeSuccessGroup = 'all';

      var summary = document.createElement('div');
      summary.className = 'summary';
      function makeSuccessGroupBadge(grp, label, count) {
        var span = document.createElement('span');
        span.className = 'badge group-' + grp + (activeSuccessGroup === grp ? ' active' : '');
        span.textContent = label + ' (' + count + ')';
        span.onclick = function () { activeSuccessGroup = grp; renderPanel(); };
        return span;
      }
      summary.appendChild(makeSuccessGroupBadge('all', 'Sve', successes.length));
      summary.appendChild(makeSuccessGroupBadge('seo', 'SEO', seoSuccesses.length));
      summary.appendChild(makeSuccessGroupBadge('aeo', 'AEO', aeoSuccesses.length));
      panel.appendChild(summary);

      sorted = activeSuccessGroup === 'all' ? successes : (activeSuccessGroup === 'aeo' ? aeoSuccesses : seoSuccesses);
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
      summary.appendChild(makeSeverityBadge('all', 'Sve', current.length));
      summary.appendChild(makeSeverityBadge('error', 'error', counts.error));
      summary.appendChild(makeSeverityBadge('warning', 'warning', counts.warning));
      summary.appendChild(makeSeverityBadge('info', 'info', counts.info));
      panel.appendChild(summary);

      var filtered = current.filter(function (f) { return activeSeverity === 'all' || f.severity === activeSeverity; });

      // Dropdown za dodatno filtriranje PO KATEGORIJI (Slike, Linkovi, Meta i head tagovi...)
      // UNUTAR već izabranog severity filtera — npr. "warning" + "Slike" prikazuje samo
      // warning nalaze o slikama. Lista kategorija u dropdown-u se računa iz `filtered` (posle
      // severity filtera), pa se menja u zavisnosti od toga koji je severity trenutno izabran.
      //
      // Neke kategorije sadrže MEŠAVINU: stavke koje su relevantne SAMO za trenutni tab
      // (`crossRelevant` nije postavljen) i stavke koje su relevantne i za SEO i za AEO
      // (`crossRelevant: true` — iste one koje nose "↔" napomenu). Npr. "Meta i head tagovi" u
      // SEO tabu ima i čisto-SEO stavke (title dužina, OG tagovi, Twitter Card...) i deljene
      // stavke (canonical, noindex, nosnippet). Za takve mešovite kategorije, dropdown dobija
      // <optgroup> sa 3 pod-opcije: "Sve (SEO+AEO)", "AEO + SEO stavke" (deljene) i "Samo
      // SEO/AEO stavke" (samo ovaj tab) — kriterijum podele je `crossRelevant` zastavica, NE
      // "native tab vs gost tab" (ta podela bi retko bila mešovita, jer gostujuće kategorije već
      // po imenu skoro nikad ne dele naziv sa native AEO kategorijama, koje su uvek prefiksovane
      // sa "AEO - "). Za kategorije koje NISU mešovite (sve stavke su ili sve deljene ili sve
      // isključivo ovog taba), ostaje jedna flat opcija kao i pre.
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
        // "own"/"shared" pod-filter je smislen SAMO ako je kategorija stvarno mešovita — ako je
        // severity filter promenjen tako da kategorija više nije mešovita, vrati na "Sve".
        var sharedC = categorySharedCounts[activeCategory] || 0;
        var soloC = categoryCounts[activeCategory] - sharedC;
        if (!(sharedC > 0 && soloC > 0)) activeCategoryOrigin = 'all';
      }

      if (categoryNames.length > 0) {
        var catRow = document.createElement('div');
        catRow.className = 'catrow';
        var select = document.createElement('select');
        select.className = 'cat-select';
        var allOpt = document.createElement('option');
        allOpt.value = 'all::all';
        allOpt.textContent = 'Sve kategorije (' + filtered.length + ')';
        select.appendChild(allOpt);
        var soloLabel = activeTab === 'aeo' ? 'AEO' : 'SEO';
        categoryNames.forEach(function (cat) {
          var total = categoryCounts[cat];
          var sharedCount = categorySharedCounts[cat] || 0;
          var soloCount = total - sharedCount;
          if (sharedCount > 0 && soloCount > 0) {
            // Mešovita kategorija — <optgroup> sa 3 pod-opcije.
            var group = document.createElement('optgroup');
            group.label = cat;
            var optAll = document.createElement('option');
            optAll.value = cat + '::all';
            optAll.textContent = 'Sve (SEO+AEO) (' + total + ')';
            group.appendChild(optAll);
            var optShared = document.createElement('option');
            optShared.value = cat + '::shared';
            optShared.textContent = 'AEO + SEO stavke (' + sharedCount + ')';
            group.appendChild(optShared);
            var optSolo = document.createElement('option');
            optSolo.value = cat + '::solo';
            optSolo.textContent = 'Samo ' + soloLabel + ' stavke (' + soloCount + ')';
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
    }

    // .list je jedini skrolujući deo — sprečava da hdr/tabs/summary "skaču" i zamenjuje raniji
    // pristup sa position:sticky offsetima koje je trebalo ručno pogađati.
    var list = document.createElement('div');
    list.className = 'list';

    if (!sorted.length) {
      var empty = document.createElement('div');
      empty.className = 'empty';
      if (activeTab === 'success') {
        empty.textContent = successes.length
          ? 'Nema uspešnih provera za izabranu grupu ("' + activeSuccessGroup + '") u ovom tabu.'
          : 'Još nema evidentiranih uspešnih provera (ili se stranica još analizira).';
      } else if (!current.length) {
        empty.textContent = activeTab === 'aeo' ? 'Nema AEO nalaza na ovoj stranici. 🎉' : 'Nema SEO nalaza na ovoj stranici. 🎉';
      } else if (activeCategory !== 'all') {
        empty.textContent = 'Nema nalaza za filter severity="' + activeSeverity + '" + kategorija="' + activeCategory + '".';
      } else {
        empty.textContent = 'Nema nalaza za izabrani filter ("' + activeSeverity + '") u ovom tabu.';
      }
      list.appendChild(empty);
    }

    if (activeTab === 'success') {
      sorted.forEach(function (s) {
        // Kad je crossRelevant stavka prikazana kao "gost" u drugom tabu (npr. SEO uspeh
        // otvoren dok je izabran AEO filter), bedž prati TRENUTNI kontekst (AEO), a "↔" napomena
        // objašnjava vezu ka matičnoj grupi (SEO) — vidi getCrossText().
        var native = s.group === 'aeo' ? 'aeo' : 'seo';
        var grp = activeSuccessGroup !== 'all' ? activeSuccessGroup : native;
        var item = document.createElement('div');
        item.className = 'item success-item';
        item.innerHTML =
          '<div class="cat">' + s.category + '</div>' +
          '<div class="title"><span class="badge success tag">✓</span><span class="badge group-' + grp + ' tag">' + grp.toUpperCase() + '</span>' + s.title + '</div>' +
          (s.description ? '<div class="desc">' + (s.description || '').replace(/</g, '&lt;') + '</div>' : '') +
          (s.crossRelevant ? '<div class="cross">↔ ' + getCrossText(s, activeSuccessGroup) + '</div>' : '');
        if (s.element) {
          item.style.cursor = 'pointer';
          item.onclick = function () { highlightElement(s.element); };
        }
        list.appendChild(item);
      });
    } else {
      sorted.forEach(function (f) {
        var item = document.createElement('div');
        item.className = 'item';
        item.innerHTML =
          '<div class="cat">' + f.category + '</div>' +
          '<div class="title"><span class="badge ' + f.severity + ' tag">' + f.severity + '</span>' + f.title + '</div>' +
          '<div class="desc">' + (f.description || '').replace(/</g, '&lt;') + '</div>' +
          (f.globalNote ? '<div class="global">🌐 ' + f.globalNote + '</div>' : '') +
          (f.crossRelevant ? '<div class="cross">↔ ' + getCrossText(f, activeTab) + '</div>' : '') +
          (f.why ? '<div class="desc" style="color:#93c5fd;margin-top:4px;"><b>Zašto:</b> ' + f.why + '</div>' : '') +
          (f.fix ? '<div class="desc" style="color:#86efac;margin-top:4px;"><b>Rešenje:</b> ' + f.fix + '</div>' : '');
        item.onclick = function () { highlightElement(f.element); };
        list.appendChild(item);
      });
    }

    panel.appendChild(list);

    var resizeHandle = document.createElement('div');
    resizeHandle.className = 'resize-handle';
    // Vizuelna "grip" pilula se sad crta preko CSS-a (.resize-handle::after), ne teksta —
    // deo redizajna (10.08.2026), textContent namerno prazan.
    resizeHandle.title = 'Prevuci da promeniš visinu panela';
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
  }

  // ---------------------------------------------------------------------
  // Main
  // ---------------------------------------------------------------------

  function run() {
    checkPreliminary();
    checkSlug();
    checkMetaHead();
    checkFavicon();
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
    });
  }

  run();

  window.__SeoAuditorResults = findings;
})();
