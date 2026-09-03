(function() {
  const CONTENT_EXTRACTION_METHODS = {
    readability: null,
    mozillaReadability: null,
    textContent: false,
    innerText: false,
    screenshot: false,
    metadataOnly: false
  };

  let extractedContent = null;
  let extractionMethod = null;

  function initReadability() {
    if (typeof Readability === 'undefined') {
      const script = document.createElement('script');
      script.src = 'https://unpkg.com/@mozilla/readability@0.5.0/Readability.js';
      document.head.appendChild(script);
      return new Promise((resolve) => {
        script.onload = () => {
          CONTENT_EXTRACTION_METHODS.readability = typeof Readability !== 'undefined';
          resolve(CONTENT_EXTRACTION_METHODS.readability);
        };
        script.onerror = () => {
          CONTENT_EXTRACTION_METHODS.readability = false;
          resolve(false);
        };
      });
    }
    CONTENT_EXTRACTION_METHODS.readability = true;
    return Promise.resolve(true);
  }

  function extractWithReadability() {
    if (!CONTENT_EXTRACTION_METHODS.readability) return null;
    try {
      const documentClone = document.cloneNode(true);
      const reader = new Readability(documentClone);
      const article = reader.parse();
      if (article && article.content) {
        return {
          title: article.title || document.title,
          content: article.textContent || '',
          html: article.content,
          excerpt: article.excerpt || '',
          byline: article.byline || ''
        };
      }
    } catch (e) {
      console.warn('Readability extraction failed:', e);
    }
    return null;
  }

  function extractWithTextContent() {
    try {
      const body = document.body;
      if (!body) return null;

      const clone = body.cloneNode(true);

      const scripts = clone.querySelectorAll('script, style, noscript, iframe, svg, canvas, video, audio, img, picture, figure, figcaption, nav, header, footer, aside, form, button, input, select, textarea, [role="navigation"], [role="banner"], [role="complementary"], [role="search"]');
      scripts.forEach(el => el.remove());

      const elements = clone.querySelectorAll('[class*="cookie"], [id*="cookie"], [class*="banner"], [class*="popup"], [class*="modal"], [class*="overlay"], [class*="sidebar"], [class*="comment"], [class*="social"]');
      elements.forEach(el => el.remove());

      const text = clone.textContent || clone.innerText || '';
      const cleaned = text.replace(/\s+/g, ' ').trim();

      if (cleaned.length < 100) return null;

      return {
        title: document.title,
        content: cleaned,
        html: '',
        excerpt: cleaned.substring(0, 200) + '...'
      };
    } catch (e) {
      console.warn('TextContent extraction failed:', e);
      return null;
    }
  }

  function extractWithInnerText() {
    try {
      const body = document.body;
      if (!body) return null;

      const text = body.innerText || '';
      if (text.trim().length < 100) return null;

      return {
        title: document.title,
        content: text.replace(/\s+/g, ' ').trim(),
        html: '',
        excerpt: ''
      };
    } catch (e) {
      return null;
    }
  }

  function captureScreenshot() {
    return new Promise((resolve) => {
      try {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');

        const img = new Image();
        img.crossOrigin = 'anonymous';

        html2canvas(document.body, {
          canvas: canvas,
          useCORS: true,
          allowTaint: false,
          logging: false,
          backgroundColor: '#ffffff'
        }).then(canvas => {
          resolve({
            title: document.title,
            content: '',
            html: '',
            excerpt: '',
            screenshot: canvas.toDataURL('image/png', 0.8)
          });
        }).catch(e => {
          console.warn('Screenshot failed:', e);
          resolve(null);
        });
      } catch (e) {
        resolve(null);
      }
    });
  }

  function extractMetadata() {
    const meta = {
      title: document.title,
      url: window.location.href,
      description: '',
      ogImage: '',
      author: '',
      publishedTime: '',
      content: ''
    };

    const metaTags = [
      ['description', 'name'],
      ['og:description', 'property'],
      ['author', 'name'],
      ['article:author', 'property'],
      ['article:published_time', 'property'],
      ['og:image', 'property']
    ];

    metaTags.forEach(([name, type]) => {
      const el = document.querySelector(`meta[${type}="${name}"]`);
      if (el) {
        const key = name.replace('og:', '').replace('article:', '');
        meta[key] = el.getAttribute('content') || '';
      }
    });

    const h1 = document.querySelector('h1');
    if (h1) {
      meta.title = h1.textContent.trim() || meta.title;
    }

    return meta;
  }

  async function extractContent() {
    await initReadability();

    const methods = [
      { name: 'readability', fn: extractWithReadability },
      { name: 'textContent', fn: extractWithTextContent },
      { name: 'innerText', fn: extractWithInnerText }
    ];

    for (const method of methods) {
      try {
        const result = await Promise.resolve(method.fn());
        if (result && result.content && result.content.length > 100) {
          extractedContent = result;
          extractionMethod = method.name;
          console.log(`NotionLess: Content extracted using ${method.name}`);
          return result;
        }
      } catch (e) {
        console.warn(`NotionLess: ${method.name} failed:`, e);
      }
    }

    return extractMetadata();
  }

  function isSiteBlocking() {
    const blockingIndicators = [
      document.body.innerText.length < 100,
      document.querySelector('meta[name="robots"][content*="noindex"]'),
      window.location.protocol === 'about:',
      window.location.protocol === 'chrome:',
      window.location.hostname === 'chrome.google.com',
      window.location.hostname.endsWith('.pdf')
    ];

    return blockingIndicators.some(Boolean);
  }

  async function performExtraction() {
    if (isSiteBlocking()) {
      return extractMetadata();
    }
    return extractContent();
  }

  function getPageInfo() {
    return {
      url: window.location.href,
      title: document.title,
      hostname: window.location.hostname,
      extractedAt: Date.now(),
      extractionMethod: extractionMethod,
      contentLength: extractedContent?.content?.length || 0
    };
  }

  window.__notionlessContent = {
    extract: performExtraction,
    getPageInfo: getPageInfo,
    getExtractedContent: () => extractedContent
  };

  if (document.readyState === 'complete') {
    performExtraction();
  } else {
    window.addEventListener('load', () => {
      setTimeout(performExtraction, 1000);
    });
  }
})();
