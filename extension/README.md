# NotionLess Clipper - Firefox Extension

Save entire webpages as native NotionLess pages directly from Firefox.

## Features

- **Auto-detect session**: If you're logged into NotionLess in your browser, the extension automatically detects your account
- **One-click clipping**: Save any webpage to your NotionLess account
- **Multiple extraction methods**: Intelligent content extraction with fallbacks
- **API Key auth**: Secure authentication without browser password storage (for manual auth)
- **Multi-user support**: Each user accesses their own clips
- **Parent page selection**: Save clips as subpages

## Installation

### Temporary Installation (for development)

1. Open Firefox and navigate to `about:debugging`
2. Click "This Firefox" in the left sidebar
3. Click "Load Temporary Add-on..."
4. Navigate to the `extension/` folder and select `manifest.json`

### Permanent Installation

1. Zip the extension folder contents (not the folder itself):
   ```bash
   cd extension && zip -r ../notionless-clipper.xpi *
   ```
2. Sign the XPI at [Firefox Add-on Developer Hub](https://addons.mozilla.org/developers/)
3. Install the signed extension

## Configuration

### Server URL

The extension connects to `https://notionless.pythonanywhere.com` by default. To change:

1. Click the gear icon in the extension popup
2. Update the Server URL field
3. Click outside to save

### For PythonAnywhere Deployment

Update the Server URL to your PythonAnywhere domain:
```
https://yourusername.pythonanywhere.com
```

## Authentication

The extension uses a smart authentication system that checks multiple sources in order:

### Automatic (Recommended)
If you're already logged into NotionLess in your browser, the extension will:
1. Check for a valid session cookie from the web app
2. Automatically detect your username
3. Show "Logged in as [username] via session" in the popup

### Manual Login
If no session is detected, you can:
1. Enter your NotionLess username and password
2. Click "Sign In"
3. An API key is generated and stored securely

### API Key
1. Get your API key from the NotionLess workspace settings (gear icon)
2. Click the gear icon → Settings
3. Enter your API key and click "Use Key"

## Content Extraction

The extension uses a multi-layered approach to extract page content:

### Primary Methods (in order)
1. **Readability** - Mozilla's Readability library for clean article extraction
2. **Text Content** - DOM-based extraction with cleanup of scripts/styles
3. **Inner Text** - Fallback to raw text content

### Fallback for Blocked Sites

When a page cannot be extracted (e.g., paywalled sites, PDFs, Chrome internal pages):

1. **Metadata only** - Saves URL, title, and any available meta tags
2. **Manual copy** - User can manually copy content and use the web interface

### Sites That May Not Work

- Pages with `noindex` robots meta tag
- PDF documents
- Chrome internal pages (`chrome://`, `about:`)
- Paywalled content requiring login
- Sites with aggressive anti-bot measures

## API Endpoints

The extension uses these backend endpoints:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/extension/auth/login` | POST | Login with username/password, returns API key |
| `/api/extension/auth/verify` | POST | Verify API key validity |
| `/api/extension/save` | POST | Save a new clip |
| `/api/extension/pages` | GET | List user's pages |

## Development

### File Structure

```
extension/
├── manifest.json      # Extension manifest
├── background.js      # Background script (API communication)
├── content.js         # Content script (page extraction)
├── popup.html         # Popup UI
├── popup.js          # Popup logic
├── popup.css         # Popup styles
└── icons/            # Extension icons
```

### Testing

1. Start the NotionLess server:
   ```bash
   cd notion-less_online
   python app.py
   ```

2. Load the extension temporarily in Firefox

3. Open any webpage and click the extension icon

## Security

- API keys are stored in Firefox's local storage (not synced)
- Each user has isolated database access via per-user SQLite files
- API keys are hashed before storage
- Session verification on each action

## Troubleshooting

### "Cannot access this page"
- The site may block content scripts
- Try a different page

### "Connection failed"
- Ensure NotionLess server is running
- Check the Server URL in settings

### "Session expired"
- Re-authenticate with your credentials

### Content extraction poor quality
- Some sites intentionally block automated extraction
- Use the web interface for manual saving
