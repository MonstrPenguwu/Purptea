const { app, BrowserWindow, ipcMain, shell, clipboard } = require('electron');
const path = require('path');
const http = require('http');
const https = require('https');
const fs = require('fs');
const ChatManager = require('./chat-manager');

// Auto-updater (safe require — only works in packaged builds)
let autoUpdater = null;
try {
    autoUpdater = require('electron-updater').autoUpdater;
} catch (e) {
    console.log('electron-updater not available (dev mode) — auto-updates disabled');
}

let mainWindow;
let overlayWindow = null;
const chatManager = new ChatManager();

// Create simple HTTP server for OAuth callback
const server = http.createServer((req, res) => {
    if (req.url.startsWith('/auth/twitch/callback')) {
        const callbackPath = path.join(__dirname, 'auth-callback.html');
        fs.readFile(callbackPath, (err, data) => {
            if (err) {
                res.writeHead(500);
                res.end('Error loading callback page');
                return;
            }
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(data);
        });
    } else {
        res.writeHead(404);
        res.end('Not found');
    }
});

function parseYoutubeVideoIdFromString(value) {
  if (!value) return null;

  const directIdMatch = value.match(/^[\w-]{11}$/);
  if (directIdMatch) return directIdMatch[0];

  const urlStyleMatch = value.match(/(?:youtu\.be\/|youtube\.com(?:\/embed\/|\/v\/|\/watch\?v=|\/watch\?.+&v=))([\w-]{11})/);
  if (urlStyleMatch) return urlStyleMatch[1];

  return null;
}

function fetchTextWithRedirects(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 6) {
      reject(new Error('Too many redirects while resolving YouTube live URL'));
      return;
    }

    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
      }
    }, (res) => {
      const status = res.statusCode || 0;
      const location = res.headers.location;

      if (status >= 300 && status < 400 && location) {
        const nextUrl = new URL(location, url).toString();
        res.resume();
        fetchTextWithRedirects(nextUrl, redirects + 1).then(resolve).catch(reject);
        return;
      }

      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
        if (body.length > 2_000_000) {
          req.destroy(new Error('YouTube response too large while resolving live URL'));
        }
      });
      res.on('end', () => resolve({ finalUrl: url, body, status }));
    });

    req.on('error', reject);
    req.setTimeout(12000, () => req.destroy(new Error('Timeout resolving YouTube live URL')));
  });
}

function buildYoutubeLiveLookupUrl(source) {
  const raw = (source || '').trim();
  if (!raw) throw new Error('Please enter a YouTube video ID, channel URL, or @handle');

  if (raw.startsWith('@')) {
    return `https://www.youtube.com/${raw}/live`;
  }

  const normalized = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;

  let parsed;
  try {
    parsed = new URL(normalized);
  } catch (err) {
    throw new Error('Invalid YouTube input. Use a video ID, channel URL, or @handle.');
  }

  const host = parsed.hostname.replace(/^www\./i, '').toLowerCase();

  if (host === 'youtu.be') {
    return normalized;
  }

  if (!host.endsWith('youtube.com')) {
    throw new Error('Please enter a valid YouTube URL or @handle');
  }

  const segments = parsed.pathname.split('/').filter(Boolean);
  if (segments.length === 0) {
    throw new Error('Please enter a YouTube channel URL or @handle');
  }

  if (segments[0].startsWith('@')) {
    return `https://www.youtube.com/${segments[0]}/live`;
  }

  if (segments[0] === 'channel' || segments[0] === 'c' || segments[0] === 'user') {
    if (!segments[1]) throw new Error('Incomplete YouTube channel URL');
    return `https://www.youtube.com/${segments[0]}/${segments[1]}/live`;
  }

  return normalized;
}

async function resolveYoutubeLiveVideoId(source) {
  const raw = (source || '').trim();
  const directVideoId = parseYoutubeVideoIdFromString(raw);
  if (directVideoId) {
    return { videoId: directVideoId, resolvedFrom: raw };
  }

  const lookupUrl = buildYoutubeLiveLookupUrl(raw);
  const { finalUrl, body } = await fetchTextWithRedirects(lookupUrl);

  const redirectedId = parseYoutubeVideoIdFromString(finalUrl);
  if (redirectedId) {
    return { videoId: redirectedId, resolvedFrom: finalUrl };
  }

  const canonicalMatch = body.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/watch\?v=([\w-]{11})"/i);
  if (canonicalMatch) {
    return { videoId: canonicalMatch[1], resolvedFrom: lookupUrl };
  }

  const liveNowMatch = body.match(/"videoId":"([\w-]{11})"[^\n\r]{0,220}?"isLiveNow":true/);
  if (liveNowMatch) {
    return { videoId: liveNowMatch[1], resolvedFrom: lookupUrl };
  }

  throw new Error('Could not find an active live stream for this YouTube source right now.');
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 1100,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      preload: path.join(__dirname, 'preload.js')
    },
    icon: path.join(__dirname, 'assets/icon.png')
  });

  mainWindow.loadFile('index.html');

  // Open DevTools only in development mode
  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on('closed', function () {
    chatManager.destroy();
    mainWindow = null;
  });

  // Give the ChatManager a reference to mainWindow
  chatManager.setMainWindow(mainWindow);

  // Start OAuth callback server with error handling
  const PORT = 3000;
  server.listen(PORT, () => {
    console.log(`OAuth callback server running on http://localhost:${PORT}`);
  }).on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${PORT} is already in use. OAuth login may not work.`);
      const ALT_PORT = 3001;
      server.listen(ALT_PORT, () => {
        console.log(`OAuth callback server running on http://localhost:${ALT_PORT} (alternate port)`);
      }).on('error', (altErr) => {
        console.error('Failed to start OAuth server on alternate port:', altErr);
      });
    } else {
      console.error('Server error:', err);
    }
  });

  // Check for updates after window is ready (packaged builds only)
  if (autoUpdater) {
    mainWindow.webContents.once('did-finish-load', () => {
      autoUpdater.checkForUpdatesAndNotify();
    });
  }
}

// ══════════════════════════════════════════════════════════════════════════════
//  Auto-updater events
// ══════════════════════════════════════════════════════════════════════════════
if (autoUpdater) {
    autoUpdater.on('update-available', () => {
        if (mainWindow) mainWindow.webContents.send('update-available');
    });
    autoUpdater.on('update-downloaded', () => {
        if (mainWindow) mainWindow.webContents.send('update-downloaded');
    });
}

ipcMain.on('install-update', () => {
    if (autoUpdater) autoUpdater.quitAndInstall();
});

// ══════════════════════════════════════════════════════════════════════════════
//  App lifecycle
// ══════════════════════════════════════════════════════════════════════════════
app.on('ready', createWindow);

app.on('window-all-closed', function () {
  server.close();
  chatManager.destroy();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', function () {
  if (mainWindow === null) {
    createWindow();
  }
});

// ══════════════════════════════════════════════════════════════════════════════
//  Chat connection IPC (handled by ChatManager)
// ══════════════════════════════════════════════════════════════════════════════
ipcMain.handle('chat:connect-twitch', async (_event, channel) => {
    return chatManager.connectTwitch(channel);
});
ipcMain.handle('chat:disconnect-twitch', async () => {
    return chatManager.disconnectTwitch();
});
ipcMain.handle('chat:connect-tiktok', async (_event, username, apiKey) => {
    return chatManager.connectTiktok(username, apiKey);
});
ipcMain.handle('chat:disconnect-tiktok', async () => {
    return chatManager.disconnectTiktok();
});
ipcMain.handle('chat:connect-youtube', async (_event, videoId) => {
    return chatManager.connectYoutube(videoId);
});
ipcMain.handle('chat:disconnect-youtube', async () => {
    return chatManager.disconnectYoutube();
});
ipcMain.handle('youtube:resolve-live', async (_event, source) => {
    try {
      const result = await resolveYoutubeLiveVideoId(source);
      return { success: true, videoId: result.videoId, resolvedFrom: result.resolvedFrom };
    } catch (err) {
      return { success: false, error: err.message || 'Failed to resolve YouTube live source' };
    }
});
ipcMain.handle('chat:send-twitch', async (_event, channel, message, token, username) => {
    return chatManager.sendTwitchMessage(channel, message, token, username);
});
ipcMain.handle('chat:send-twitch-guest', async (_event, guestId, channel, message, token, username) => {
    return chatManager.sendTwitchMessage(channel, message, token, username);
});

// ── Guest IPC ────────────────────────────────────────────────────────────────
ipcMain.handle('guest:add', async (_event, platform, username, apiKey) => {
    return chatManager.addGuest(platform, username, apiKey);
});
ipcMain.handle('guest:remove', async (_event, guestId) => {
    return chatManager.removeGuest(guestId);
});

// ══════════════════════════════════════════════════════════════════════════════
//  System utilities IPC
// ══════════════════════════════════════════════════════════════════════════════
ipcMain.handle('shell:open-external', async (_event, url) => {
    if (typeof url === 'string' && (url.startsWith('https://') || url.startsWith('http://'))) {
        await shell.openExternal(url);
    }
});
ipcMain.handle('clipboard:write', async (_event, text) => {
    if (typeof text === 'string') {
        clipboard.writeText(text);
    }
});

// ══════════════════════════════════════════════════════════════════════════════
//  Overlay IPC
// ══════════════════════════════════════════════════════════════════════════════
ipcMain.on('open-overlay', () => {
  if (overlayWindow) {
    overlayWindow.focus();
    return;
  }

  overlayWindow = new BrowserWindow({
    width: 400,
    height: 600,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: true,
    skipTaskbar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      preload: path.join(__dirname, 'overlay-preload.js')
    },
    icon: path.join(__dirname, 'assets/icon.png')
  });

  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  overlayWindow.loadFile('chat-overlay.html');

  overlayWindow.on('closed', () => {
    overlayWindow = null;
    if (mainWindow) {
      mainWindow.webContents.send('overlay-closed');
    }
  });
});

ipcMain.on('close-overlay', () => {
  if (overlayWindow) {
    overlayWindow.close();
  }
});

ipcMain.on('send-to-overlay', (_event, messageData) => {
  if (overlayWindow) {
    overlayWindow.webContents.send('new-chat-message', messageData);
  }
});

ipcMain.on('toggle-click-through', (_event, isUltraTransparent) => {
  if (overlayWindow) {
    overlayWindow.setIgnoreMouseEvents(false);
  }
});

ipcMain.on('overlay-ready', () => {
  if (mainWindow) {
    mainWindow.webContents.send('overlay-ready');
  }
});

ipcMain.on('create-clip-from-overlay', () => {
  if (mainWindow) {
    mainWindow.webContents.send('create-clip-request');
  }
});

ipcMain.on('moderate-user', (_event, moderationData) => {
  if (mainWindow) {
    mainWindow.webContents.send('moderate-user-request', moderationData);
  }
});
