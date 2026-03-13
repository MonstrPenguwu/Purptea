const { app, BrowserWindow, ipcMain, shell, clipboard } = require('electron');
const path = require('path');
const http = require('http');
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

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
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
