const { contextBridge, ipcRenderer } = require('electron');

/**
 * Preload script for the main Purptea window.
 * Exposes a safe, controlled API to the renderer via contextBridge.
 * This prevents the renderer from accessing Node.js or Electron internals directly.
 */
contextBridge.exposeInMainWorld('purptea', {
    // ===== Platform Connections =====
    connectTwitch: (channel) => ipcRenderer.invoke('chat:connect-twitch', channel),
    disconnectTwitch: () => ipcRenderer.invoke('chat:disconnect-twitch'),
    connectTiktok: (username, apiKey) => ipcRenderer.invoke('chat:connect-tiktok', username, apiKey),
    disconnectTiktok: () => ipcRenderer.invoke('chat:disconnect-tiktok'),
    connectYoutube: (videoId) => ipcRenderer.invoke('chat:connect-youtube', videoId),
    disconnectYoutube: () => ipcRenderer.invoke('chat:disconnect-youtube'),
    resolveYoutubeLive: (source) => ipcRenderer.invoke('youtube:resolve-live', source),

    // ===== Guest Management =====
    addGuest: (platform, username, apiKey) => ipcRenderer.invoke('guest:add', platform, username, apiKey),
    removeGuest: (guestId) => ipcRenderer.invoke('guest:remove', guestId),

    // ===== System Utilities =====
    openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),
    writeClipboard: (text) => ipcRenderer.invoke('clipboard:write', text),

    // ===== Chat Send =====
    sendTwitchMessage: (channel, message, token, username) => ipcRenderer.invoke('chat:send-twitch', channel, message, token, username),
    sendTwitchGuestMessage: (guestId, channel, message, token, username) => ipcRenderer.invoke('chat:send-twitch-guest', guestId, channel, message, token, username),

    // ===== Overlay =====
    openOverlay: () => ipcRenderer.send('open-overlay'),
    closeOverlay: () => ipcRenderer.send('close-overlay'),
    sendToOverlay: (data) => ipcRenderer.send('send-to-overlay', data),

    // ===== Event Listeners (main → renderer) =====
    on: (channel, callback) => {
        const validChannels = [
            'chat:message',          // Incoming chat messages from all platforms
            'chat:status',           // Connection status updates
            'chat:viewer-update',    // Viewer count changes (TikTok roomUser)
            'guest:status',          // Guest connection status updates
            'overlay-ready',         // Overlay window loaded and ready
            'overlay-closed',        // Overlay window was closed
            'create-clip-request',   // Overlay requested a clip
            'moderate-user-request', // Overlay requested moderation action
            'update-available',      // Auto-updater: update found
            'update-downloaded'      // Auto-updater: update ready to install
        ];
        if (validChannels.includes(channel)) {
            const handler = (_event, ...args) => callback(...args);
            ipcRenderer.on(channel, handler);
            // Return unsubscribe function
            return () => ipcRenderer.removeListener(channel, handler);
        }
    },

    once: (channel, callback) => {
        const validChannels = [
            'chat:message', 'chat:status', 'chat:viewer-update',
            'guest:status', 'overlay-ready', 'overlay-closed', 'create-clip-request',
            'moderate-user-request', 'update-available', 'update-downloaded'
        ];
        if (validChannels.includes(channel)) {
            ipcRenderer.once(channel, (_event, ...args) => callback(...args));
        }
    },

    removeAllListeners: (channel) => {
        const validChannels = [
            'chat:message', 'chat:status', 'chat:viewer-update',
            'guest:status', 'overlay-ready', 'overlay-closed', 'create-clip-request',
            'moderate-user-request', 'update-available', 'update-downloaded'
        ];
        if (validChannels.includes(channel)) {
            ipcRenderer.removeAllListeners(channel);
        }
    },

    // ===== Auto-Update =====
    installUpdate: () => ipcRenderer.send('install-update')
});
