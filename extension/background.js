const DEFAULT_API_BASE = 'https://notionless.pythonanywhere.com/api';

async function getApiBase() {
  const result = await browser.storage.local.get(['serverUrl']);
  const serverUrl = result.serverUrl || DEFAULT_API_BASE.replace('/api', '');
  return `${serverUrl}/api`.replace(/\/api\/api/, '/api');
}

async function getServerUrl() {
  const result = await browser.storage.local.get(['serverUrl']);
  return result.serverUrl || DEFAULT_API_BASE.replace('/api', '');
}

async function verifyApiKey(apiKey) {
  const apiBase = await getApiBase();
  const verifyUrl = `${apiBase}/extension/auth/verify`;
  console.log('verifyApiKey URL:', verifyUrl);
  console.log('verifyApiKey key:', apiKey ? apiKey.substring(0, 15) + '...' : 'null');
  const response = await fetch(verifyUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: apiKey })
  });
  console.log('verifyApiKey status:', response.status);
  if (!response.ok) {
    console.log('verifyApiKey failed');
    return null;
  }
  const data = await response.json();
  console.log('verifyApiKey data:', data);
  return data.valid ? data.username : null;
}

async function loginWithCredentials(username, password) {
  const apiBase = await getApiBase();
  console.log('Login request to:', apiBase);
  const response = await fetch(`${apiBase}/extension/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  console.log('Login response status:', response.status);
  if (!response.ok) {
    const err = await response.json();
    throw new Error(err.error || 'Login failed');
  }
  const data = await response.json();
  console.log('Login response data:', data);
  if (!data.api_key) {
    throw new Error('No API key returned');
  }
  console.log('Saving to storage...');
  await browser.storage.local.set({ apiKey: data.api_key, username: data.username });
  console.log('Storage save done');
  return data;
}

async function saveClip(clipData) {
  const result = await browser.storage.local.get(['apiKey']);
  const apiKey = result.apiKey;
  if (!apiKey) {
    throw new Error('Not authenticated');
  }

  const apiBase = await getApiBase();
  const response = await fetch(`${apiBase}/extension/save`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': apiKey
    },
    body: JSON.stringify(clipData)
  });

  if (!response.ok) {
    if (response.status === 401) {
      await browser.storage.local.remove(['apiKey', 'username']);
      throw new Error('Session expired');
    }
    const err = await response.json();
    throw new Error(err.error || 'Failed to save');
  }

  return response.json();
}

async function getPageList() {
  const result = await browser.storage.local.get(['apiKey']);
  const apiKey = result.apiKey;
  if (!apiKey) throw new Error('Not authenticated');

  const apiBase = await getApiBase();
  const response = await fetch(`${apiBase}/extension/pages`, {
    headers: { 'X-API-Key': apiKey }
  });

  if (!response.ok) throw new Error('Failed to fetch pages');
  return response.json();
}

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      switch (message.action) {
        case 'getCredentials': {
          const result = await browser.storage.local.get(['apiKey', 'username']);
          sendResponse({ apiKey: result.apiKey, username: result.username });
          break;
        }
        case 'checkSession': {
          const result = await browser.storage.local.get(['apiKey']);
          const keyPart = result.apiKey ? result.apiKey.substring(0, 10) + '...' : 'none';
          console.log('checkSession key:', keyPart);
          if (result.apiKey) {
            const username = await verifyApiKey(result.apiKey);
            console.log('checkSession verify result:', username);
            sendResponse({ authenticated: !!username, username });
          } else {
            sendResponse({ authenticated: false });
          }
          break;
        }
        case 'login': {
          const data = await loginWithCredentials(message.username, message.password);
          sendResponse({ success: true, username: data.username });
          break;
        }
        case 'logout': {
          await browser.storage.local.remove(['apiKey', 'username']);
          sendResponse({ success: true });
          break;
        }
        case 'saveClip': {
          const result = await saveClip(message.data);
          sendResponse({ success: true, pageId: result.page_id });
          break;
        }
        case 'getPages': {
          const pages = await getPageList();
          sendResponse({ success: true, pages });
          break;
        }
        case 'getServerUrl': {
          sendResponse({ serverUrl: await getServerUrl() });
          break;
        }
        default:
          sendResponse({ error: 'Unknown action' });
      }
    } catch (e) {
      sendResponse({ error: e.message });
    }
  })();
  return true;
});
