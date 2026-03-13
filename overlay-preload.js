const { contextBridge, ipcRenderer } = require('electron');

/**
 * Preload script for the Purptea overlay window.
 * Minimal API surface — only what the overlay needs.
 */
contextBridge.exposeInMainWorld('purptea', {
    // Overlay controls
    closeOverlay: () => ipcRenderer.send('close-overlay'),
    toggleClickThrough: (isUltra) => ipcRenderer.send('toggle-click-through', isUltra),
    createClipFromOverlay: () => ipcRenderer.send('create-clip-from-overlay'),
    moderateUser: (data) => ipcRenderer.send('moderate-user', data),

    // Listen for chat messages forwarded from main window
    on: (channel, callback) => {
        const validChannels = ['new-chat-message'];
        if (validChannels.includes(channel)) {
            const handler = (_event, ...args) => callback(...args);
            ipcRenderer.on(channel, handler);
            return () => ipcRenderer.removeListener(channel, handler);
        }
    }
});
