const DEFAULT_API_BASE = 'https://notionless.pythonanywhere.com/api';

let cachedApiKey = null;
let cachedUsername = null;

async function getServerUrl() {
  const result = await browser.storage.local.get(['serverUrl']);
  return result.serverUrl || DEFAULT_API_BASE;
}

async function getApiBase() {
  const serverUrl = await getServerUrl();
  return `${serverUrl}/api`.replace(/\/api\/api/, '/api');
}

async function getStoredCredentials() {
  const result = await browser.storage.local.get(['apiKey', 'username']);
  return {
    apiKey: result.apiKey || null,
    username: result.username || null
  };
}

async function setStoredCredentials(apiKey, username) {
  await browser.storage.local.set({ apiKey, username });
  cachedApiKey = apiKey;
  cachedUsername = username;
}

async function getSessionFromCookies(serverUrl) {
  try {
    const url = new URL(serverUrl);
    const cookie = await browser.cookies.get({
      url: serverUrl,
      name: 'session'
    });

    if (cookie && cookie.value) {
      const response = await fetch(`${serverUrl}/api/extension/whoami`, {
        method: 'GET',
        headers: {
          'Cookie': `session=${cookie.value}`
        }
      });

      if (response.ok) {
        const data = await response.json();
        if (data.authenticated) {
          return { authenticated: true, username: data.username };
        }
      }
    }

    const clipperCookie = await browser.cookies.get({
      url: serverUrl,
      name: 'notionless_clipper_user'
    });

    if (clipperCookie && clipperCookie.value) {
      return { authenticated: true, username: clipperCookie.value };
    }
  } catch (e) {
    console.error('Cookie session check failed:', e);
  }
  return { authenticated: false };
}

async function loginWithCredentials(username, password) {
  const apiBase = await getApiBase();
  try {
    const response = await fetch(`${apiBase}/extension/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error || 'Login failed');
    }
    const data = await response.json();
    await setStoredCredentials(data.api_key, data.username);
    return data;
  } catch (e) {
    console.error('Login error:', e);
    throw e;
  }
}

async function verifyApiKey(apiKey) {
  const apiBase = await getApiBase();
  try {
    const response = await fetch(`${apiBase}/extension/auth/verify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': apiKey
      },
      body: JSON.stringify({ api_key: apiKey })
    });
    if (!response.ok) return null;
    const data = await response.json();
    return data.valid ? data.username : null;
  } catch (e) {
    console.error('API verify error:', e);
    return null;
  }
}

async function saveClip(clipData) {
  const creds = await getStoredCredentials();
  if (!creds.apiKey) {
    throw new Error('Not authenticated. Please login first.');
  }

  const apiBase = await getApiBase();
  const response = await fetch(`${apiBase}/extension/save`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': creds.apiKey
    },
    body: JSON.stringify(clipData)
  });

  if (!response.ok) {
    if (response.status === 401) {
      await browser.storage.local.remove(['apiKey', 'username']);
      cachedApiKey = null;
      cachedUsername = null;
      throw new Error('Session expired. Please login again.');
    }
    const err = await response.json();
    throw new Error(err.error || 'Failed to save clip');
  }

  return response.json();
}

async function getPageList() {
  const creds = await getStoredCredentials();
  if (!creds.apiKey) {
    throw new Error('Not authenticated');
  }

  const apiBase = await getApiBase();
  const response = await fetch(`${apiBase}/extension/pages`, {
    headers: { 'X-API-Key': creds.apiKey }
  });

  if (!response.ok) throw new Error('Failed to fetch pages');
  return response.json();
}

async function checkPageAccessibility(url) {
  const creds = await getStoredCredentials();
  if (!creds.apiKey) return { accessible: false, reason: 'not_authenticated' };

  const apiBase = await getApiBase();
  try {
    const response = await fetch(`${apiBase}/extension/clip_metadata`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': creds.apiKey
      },
      body: JSON.stringify({ url })
    });
    return response.json();
  } catch (e) {
    return { accessible: false, reason: 'network_error' };
  }
}

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      const serverUrl = await getServerUrl();
      switch (message.action) {
        case 'getCredentials':
          sendResponse(await getStoredCredentials());
          break;

        case 'checkSession':
          sendResponse(await getSessionFromCookies(serverUrl));
          break;

        case 'login':
          const loginResult = await loginWithCredentials(message.username, message.password);
          sendResponse({ success: true, username: loginResult.username });
          break;

        case 'loginWithApiKey':
          await setStoredCredentials(message.apiKey, message.username);
          sendResponse({ success: true, username: message.username });
          break;

        case 'logout':
          await browser.storage.local.remove(['apiKey', 'username']);
          cachedApiKey = null;
          cachedUsername = null;
          sendResponse({ success: true });
          break;

        case 'saveClip':
          const saveResult = await saveClip(message.data);
          sendResponse({ success: true, pageId: saveResult.page_id });
          break;

        case 'getPages':
          const pages = await getPageList();
          sendResponse({ success: true, pages });
          break;

        case 'checkAccessibility':
          sendResponse(await checkPageAccessibility(message.url));
          break;

        case 'getActiveTabContent':
          const tabs = await browser.tabs.query({ active: true, currentWindow: true });
          if (tabs[0]) {
            try {
              const results = await browser.tabs.executeScript(tabs[0].id, {
                code: 'window.__notionlessContent'
              });
              sendResponse({ success: true, content: results?.[0] });
            } catch (e) {
              sendResponse({ success: false, error: e.message });
            }
          } else {
            sendResponse({ success: false, error: 'No active tab' });
          }
          break;

        case 'getServerUrl':
          sendResponse({ serverUrl });
          break;

        default:
          sendResponse({ error: 'Unknown action' });
      }
    } catch (e) {
      sendResponse({ error: e.message });
    }
  })();
  return true;
});
