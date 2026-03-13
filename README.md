# 🫖 Purptea

**Unified Chat Viewer for Streamers**

View Twitch, TikTok, and YouTube live chat in one window. Built with Electron.

![Platform](https://img.shields.io/badge/platforms-Windows%20%7C%20macOS%20%7C%20Linux-blue)
![License](https://img.shields.io/badge/license-MIT-green)

---

## Features

| Feature | Details |
|---|---|
| **Multi-Platform Chat** | Twitch · TikTok · YouTube in a single unified feed |
| **Guest Streams** | Add unlimited guest channels from any platform |
| **Pop-Out Overlay** | Always-on-top transparent chat overlay for OBS or gaming |
| **Twitch Moderation** | Delete messages, timeout, and ban directly from the app |
| **Clip Creation** | One-click clips for main channel and all guests ("Master Clip") |
| **Twitch PubSub** | Channel point redemptions appear in chat |
| **Twitch Emotes** | Full emote rendering in chat messages |
| **TikTok Events** | Follows, shares, likes, gifts, and viewer count |
| **YouTube Emoji** | Native YouTube emoji rendering in chat |
| **Notification Sounds** | Configurable alert chime with volume and cooldown controls |
| **Auto-Reconnect** | TikTok connections automatically recover from drops (exponential backoff) |
| **Secure Architecture** | `contextIsolation` enabled — no `nodeIntegration` in renderers |
| **Auto-Updates** | Receives updates automatically via GitHub Releases |

---

## Download

Grab the latest release for your platform:

**[→ Download from GitHub Releases](https://github.com/MonstrPenguwu/Purptea/releases/latest)**

| Platform | File |
|---|---|
| Windows (Installer) | `Purptea-Setup-1.1.0.exe` |
| Windows (Portable) | `Purptea-1.1.0.exe` |
| macOS | `Purptea-1.1.0.dmg` |
| Linux | `Purptea-1.1.0.AppImage` or `.deb` |

---

## Getting Started

1. **Launch Purptea**
2. Enter a **Twitch channel name**, **TikTok username**, or **YouTube video ID/URL**
3. Click **Connect to Chat**
4. Optionally add guest streams via the **+ Add Guest** button

### Twitch Login (optional)

Click **🔑 Login with Twitch** to enable:
- Clip creation
- Message moderation (delete / timeout / ban)
- Channel point redemption alerts
- **Send Twitch messages** — type in the **Send Twitch Message** panel and choose to send to your main channel, a specific Twitch guest's channel, or all connected Twitch channels at once

### TikTok Sign API Key (optional)

For more reliable TikTok connections, get an API key from [Eulerstream](https://www.eulerstream.com/pricing) and paste it into the TikTok API Key field.

---

## Building from Source

### Prerequisites
- [Node.js](https://nodejs.org/) 18+
- [Git](https://git-scm.com/)

### Steps

```bash
git clone https://github.com/MonstrPenguwu/Purptea.git
cd Purptea
npm install
npm start          # Run in dev mode
npm run dev        # Run with DevTools
npm run build      # Package for your platform
```

---

## Architecture

```
main.js              Electron main process — window creation, IPC, OAuth server
chat-manager.js      Chat connections (tmi.js, tiktok-live-connector, masterchat)
preload.js           contextBridge API for main window
overlay-preload.js   contextBridge API for overlay window
renderer.js          UI logic, Twitch API calls, PubSub, DOM
overlay-renderer.js  Pop-out overlay logic
```

Chat libraries run in the **main process** and forward messages to the renderer via IPC. The renderer has `nodeIntegration: false` and `contextIsolation: true` — it can only access the controlled API surface exposed through `window.purptea`.

---

## License

MIT © [Monstr Penguwu](https://github.com/MonstrPenguwu)
