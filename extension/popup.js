(function() {
  const elements = {
    loginForm: document.getElementById('loginForm'),
    username: document.getElementById('username'),
    password: document.getElementById('password'),
    loginBtn: document.getElementById('loginBtn'),
    authError: document.getElementById('authError'),
    apiKeyInput: document.getElementById('apiKeyInput'),
    apiKeyBtn: document.getElementById('apiKeyBtn'),
    authSection: document.getElementById('authSection'),
    clipSection: document.getElementById('clipSection'),
    settingsSection: document.getElementById('settingsSection'),
    userDisplay: document.getElementById('userDisplay'),
    loggedInBanner: document.getElementById('loggedInBanner'),
    userFromCookie: document.getElementById('userFromCookie'),
    pageInfo: document.getElementById('pageInfo'),
    extractionStatus: document.getElementById('extractionStatus'),
    statusText: document.getElementById('statusText'),
    parentSelect: document.getElementById('parentPage'),
    clipBtn: document.getElementById('clipBtn'),
    clipError: document.getElementById('clipError'),
    clipSuccess: document.getElementById('clipSuccess'),
    successText: document.getElementById('successText'),
    settingsBtn: document.getElementById('settingsBtn'),
    logoutBtn: document.getElementById('logoutBtn'),
    closeSettingsBtn: document.getElementById('closeSettingsBtn'),
    showApiKeyBtn: document.getElementById('showApiKeyBtn'),
    apiKeyDisplay: document.getElementById('apiKeyDisplay'),
    apiKeyText: document.getElementById('apiKeyText'),
    copyApiKeyBtn: document.getElementById('copyApiKeyBtn'),
    serverUrl: document.getElementById('serverUrl'),
    openWorkspace: document.getElementById('openWorkspace')
  };

  let currentPageInfo = null;
  let extractedContent = null;
  let serverUrl = 'https://notionless.pythonanywhere.com';

  async function init() {
    try {
      const { serverUrl: url } = await sendMessage({ action: 'getServerUrl' });
      serverUrl = url;
      elements.serverUrl.value = serverUrl;

      const creds = await sendMessage({ action: 'getCredentials' });
      const keyPart = creds.apiKey ? creds.apiKey.substring(0, 15) : 'none';
      elements.authError.textContent = 'key: ' + keyPart;

      if (creds.apiKey) {
        const session = await sendMessage({ action: 'checkSession' });
        elements.authError.textContent += ' | resp: ' + JSON.stringify(session);
        if (session.authenticated) {
          showClipSection(session.username, false);
          loadCurrentPage();
          return;
        }
      }

      showAuthSection();
    } catch (e) {
      elements.authError.textContent = 'Error: ' + e.message;
      showAuthSection();
    }
    setupEventListeners();
  }

  function sendMessage(message) {
    return new Promise((resolve) => {
      browser.runtime.sendMessage(message, (response) => {
        resolve(response || {});
      });
    });
  }

  function showAuthSection() {
    elements.authSection.classList.remove('hidden');
    elements.clipSection.classList.add('hidden');
    elements.settingsSection.classList.add('hidden');
  }

  function showClipSection(username, fromCookie = false) {
    elements.authSection.classList.add('hidden');
    elements.clipSection.classList.remove('hidden');
    elements.settingsSection.classList.add('hidden');
    elements.userDisplay.textContent = username;

    if (fromCookie) {
      elements.loggedInBanner.classList.remove('hidden');
      elements.userFromCookie.textContent = username;
    } else {
      elements.loggedInBanner.classList.add('hidden');
    }
  }

  function showSettingsSection() {
    elements.settingsSection.classList.remove('hidden');
    elements.clipSection.classList.add('hidden');
  }

  async function loadCurrentPage() {
    elements.pageInfo.innerHTML = '<div class="page-preview"><div class="spinner"></div><span>Analyzing page...</span></div>';
    updateStatus('Analyzing page...', '⏳');
    elements.clipBtn.disabled = true;

    try {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (!tab) {
        showPageError('No active tab found');
        setupEventListeners();
        return;
      }

      elements.pageInfo.innerHTML = `
        <div class="page-preview">
          <div>
            <div class="page-title">${escapeHtml(tab.title)}</div>
            <div class="page-url">${escapeHtml(tab.url)}</div>
          </div>
        </div>
      `;

      currentPageInfo = {
        url: tab.url,
        title: tab.title
      };

      const content = await browser.tabs.executeScript(tab.id, {
        code: `(${extractContent.toString()})()`
      });

      if (content && content[0]) {
        extractedContent = content[0];
        updateStatus('Ready to clip', '✅');
        elements.clipBtn.disabled = false;
      } else {
        updateStatus('Could not extract content - will save URL only', '⚠️');
        extractedContent = { title: tab.title, content: '', html: '' };
        elements.clipBtn.disabled = false;
      }
    } catch (e) {
      console.error('Failed to load page:', e);
      showPageError('Unable to access this page');
    }

    setupEventListeners();
  }

  function extractContent() {
    if (window.__notionlessContent) {
      return window.__notionlessContent.extract();
    }
    return null;
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function showPageError(msg) {
    elements.pageInfo.innerHTML = `
      <div class="page-preview">
        <span class="status-icon">⚠️</span>
        <span>${escapeHtml(msg)}</span>
      </div>
    `;
    updateStatus('Cannot clip this page', '❌');
  }

  function updateStatus(text, icon) {
    elements.statusText.textContent = text;
    elements.extractionStatus.querySelector('.status-icon').textContent = icon;
  }

  async function handleLogin(e) {
    e.preventDefault();
    elements.authError.textContent = '';
    elements.loginBtn.disabled = true;
    elements.loginBtn.innerHTML = '<span class="spinner-sm"></span> Signing in...';

    try {
      const response = await sendMessage({
        action: 'login',
        username: elements.username.value.trim(),
        password: elements.password.value
      });

      if (response.error) {
        elements.authError.textContent = response.error;
        elements.loginBtn.disabled = false;
        elements.loginBtn.textContent = 'Sign In';
      } else if (response.success) {
        const creds = await sendMessage({ action: 'getCredentials' });
        elements.authError.textContent = 'After login - apiKey: ' + (creds.apiKey ? 'saved' : 'NOT saved');
        elements.authError.style.color = creds.apiKey ? 'green' : 'red';
        if (creds.apiKey) {
          showClipSection(response.username, false);
          loadCurrentPage();
        } else {
          elements.loginBtn.disabled = false;
          elements.loginBtn.textContent = 'Sign In';
        }
      }
    } catch (e) {
      elements.authError.textContent = 'Error: ' + e.message;
      elements.loginBtn.disabled = false;
      elements.loginBtn.textContent = 'Sign In';
    }
  }

  async function handleApiKeyAuth() {
    const apiKey = elements.apiKeyInput.value.trim();
    if (!apiKey) return;

    elements.authError.textContent = '';
    elements.apiKeyBtn.disabled = true;
    elements.apiKeyBtn.textContent = 'Verifying...';

    try {
      const response = await sendMessage({
        action: 'loginWithApiKey',
        apiKey: apiKey,
        username: 'API User'
      });

      if (response.error) {
        elements.authError.textContent = response.error;
      } else if (response.success) {
        showClipSection(response.username, false);
        loadCurrentPage();
      }
    } catch (e) {
      elements.authError.textContent = 'Invalid API key';
    } finally {
      elements.apiKeyBtn.disabled = false;
      elements.apiKeyBtn.textContent = 'Use Key';
    }
  }

  async function handleClip() {
    if (!extractedContent) {
      elements.clipError.textContent = 'No content extracted';
      return;
    }

    elements.clipBtn.disabled = true;
    elements.clipBtn.querySelector('.btn-text').classList.add('hidden');
    elements.clipBtn.querySelector('.btn-loading').classList.remove('hidden');
    elements.clipError.textContent = '';
    elements.clipSuccess.classList.add('hidden');

    try {
      const response = await sendMessage({
        action: 'saveClip',
        data: {
          url: currentPageInfo.url,
          title: extractedContent.title || currentPageInfo.title,
          content: JSON.stringify({
            text: extractedContent.content,
            excerpt: extractedContent.excerpt || '',
            byline: extractedContent.byline || ''
          }),
          html_snapshot: extractedContent.html || '',
          parent_id: elements.parentSelect.value
        }
      });

      if (response.error) {
        elements.clipError.textContent = response.error;
        elements.clipBtn.disabled = false;
      } else if (response.success) {
        elements.clipSuccess.classList.remove('hidden');
        elements.successText.textContent = `Page clipped! ID: ${response.pageId}`;
        updateStatus('Clipped successfully!', '✅');

        setTimeout(() => {
          elements.clipSuccess.classList.add('hidden');
        }, 3000);
      }
    } catch (e) {
      elements.clipError.textContent = 'Failed to save clip';
      elements.clipBtn.disabled = false;
    } finally {
      elements.clipBtn.querySelector('.btn-text').classList.remove('hidden');
      elements.clipBtn.querySelector('.btn-loading').classList.add('hidden');
    }
  }

  async function handleLogout() {
    await sendMessage({ action: 'logout' });
    showAuthSection();
    elements.username.value = '';
    elements.password.value = '';
    elements.apiKeyInput.value = '';
  }

  async function handleShowApiKey() {
    const creds = await sendMessage({ action: 'getCredentials' });
    if (creds.apiKey) {
      elements.apiKeyText.textContent = creds.apiKey;
      elements.apiKeyDisplay.classList.remove('hidden');
      elements.showApiKeyBtn.textContent = 'Hide';
    }
  }

  async function handleCopyApiKey() {
    const creds = await sendMessage({ action: 'getCredentials' });
    if (creds.apiKey) {
      await navigator.clipboard.writeText(creds.apiKey);
      elements.copyApiKeyBtn.textContent = 'Copied!';
      setTimeout(() => {
        elements.copyApiKeyBtn.textContent = 'Copy';
      }, 1500);
    }
  }

  async function loadParentPages() {
    try {
      const response = await sendMessage({ action: 'getPages' });
      if (response.success && response.pages) {
        elements.parentSelect.innerHTML = '<option value="root">Root (New Page)</option>';
        response.pages.forEach(page => {
          const option = document.createElement('option');
          option.value = page.id;
          option.textContent = page.title || 'Untitled';
          elements.parentSelect.appendChild(option);
        });
        elements.parentSelect.classList.remove('hidden');
      }
    } catch (e) {
      console.warn('Could not load pages:', e);
    }
  }

  function setupEventListeners() {
    elements.loginForm.removeEventListener('submit', handleLogin);
    elements.apiKeyBtn.removeEventListener('click', handleApiKeyAuth);
    elements.clipBtn.removeEventListener('click', handleClip);
    elements.settingsBtn.removeEventListener('click', showSettingsSection);
    elements.logoutBtn.removeEventListener('click', handleLogout);
    elements.closeSettingsBtn.removeEventListener('click', () => {
      elements.settingsSection.classList.add('hidden');
      elements.clipSection.classList.remove('hidden');
    });
    elements.showApiKeyBtn.removeEventListener('click', handleShowApiKey);
    elements.copyApiKeyBtn.removeEventListener('click', handleCopyApiKey);

    elements.loginForm.addEventListener('submit', handleLogin);
    elements.apiKeyBtn.addEventListener('click', handleApiKeyAuth);
    elements.clipBtn.addEventListener('click', handleClip);
    elements.settingsBtn.addEventListener('click', showSettingsSection);
    elements.logoutBtn.addEventListener('click', handleLogout);
    elements.closeSettingsBtn.addEventListener('click', () => {
      elements.settingsSection.classList.add('hidden');
      elements.clipSection.classList.remove('hidden');
    });
    elements.showApiKeyBtn.addEventListener('click', handleShowApiKey);
    elements.copyApiKeyBtn.addEventListener('click', handleCopyApiKey);

    elements.openWorkspace.removeEventListener('click', handleOpenWorkspace);
    elements.openWorkspace.addEventListener('click', handleOpenWorkspace);

    loadParentPages();
  }

  async function handleOpenWorkspace(e) {
    e.preventDefault();
    const cleanUrl = serverUrl.replace(/\/$/, '');
    await browser.tabs.create({ url: `${cleanUrl}/app` });
    window.close();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
