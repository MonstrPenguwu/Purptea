/**
 * Purptea Renderer
 *
 * Runs in a sandboxed BrowserWindow with contextIsolation: true.
 * All Node.js / Electron APIs are accessed through the `window.purptea`
 * bridge exposed by preload.js.
 *
 * Chat libraries (tmi.js, tiktok-live-connector, masterchat) run in the
 * main process via ChatManager. Messages arrive here via IPC events.
 *
 * Things that STAY in the renderer (safe Web APIs):
 *   - fetch() for Twitch/Euler/DecAPI HTTP calls
 *   - WebSocket for PubSub
 *   - localStorage
 *   - DOM, Audio, Notifications
 *   - OAuth popup flow (window.open + postMessage)
 */

// Twitch OAuth configuration
const TWITCH_CLIENT_ID = 'yk91iuckpvpmwhuqwhrzis0343stke';
const TWITCH_REDIRECT_URI = 'http://localhost:3000/auth/twitch/callback';
const TWITCH_SCOPES = 'chat:read chat:edit clips:edit user:read:email channel:read:redemptions moderator:manage:banned_users moderator:manage:chat_messages';

// ── Connection state (tracked via IPC status events) ──────────────────────
let twitchConnected = false;
let tiktokConnected = false;
let youtubeConnected = false;

// ── Twitch auth state ─────────────────────────────────────────────────────
let twitchPubSub = null;
let twitchAccessToken = null;
let twitchUsername = null;
let twitchUserId = null;
let twitchBroadcasterId = null;
let tiktokApiKey = null;

// ── Guest tracking (UI + metadata only; connections live in main process) ──
let guests = [];

// ── Viewer tracking ───────────────────────────────────────────────────────
let twitchViewerCount = 0;
let tiktokViewerCount = 0;
let youtubeViewerCount = 0;
let viewersVisible = true;

// ── Notification system ───────────────────────────────────────────────────
let lastNotificationTime = 0;
let notificationEnabled = true;
let notificationCooldown = 30000;
let notificationVolume = 0.3;
let notificationSound = null;

// ── Overlay ───────────────────────────────────────────────────────────────
let overlayActive = false;

// ── DOM elements (initialized in initializeApp) ──────────────────────────
let chatContainer, twitchChannelInput, tiktokUsernameInput, youtubeVideoInput;
let connectTwitchBtn, connectTiktokBtn, connectYoutubeBtn;
let twitchStatus, tiktokStatus, youtubeStatus;
let guestsContainer, addGuestBtn;
let activityContainer, tickerTrack;

// ── Activity filter state ─────────────────────────────────────────────────
let activeFilters = { all: true, gifts: true, follows: true, subs: true, misc: true };


// ══════════════════════════════════════════════════════════════════════════════
//  NOTIFICATION SOUND
// ══════════════════════════════════════════════════════════════════════════════

function createNotificationSound() {
    const audioContext = new (window.AudioContext || window.webkitAudioContext)();
    return function playSound() {
        const oscillator = audioContext.createOscillator();
        const gainNode = audioContext.createGain();
        oscillator.connect(gainNode);
        gainNode.connect(audioContext.destination);
        oscillator.frequency.value = 800;
        gainNode.gain.setValueAtTime(notificationVolume, audioContext.currentTime);
        gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.1);
        oscillator.start(audioContext.currentTime);
        oscillator.stop(audioContext.currentTime + 0.1);
        setTimeout(() => {
            const oscillator2 = audioContext.createOscillator();
            const gainNode2 = audioContext.createGain();
            oscillator2.connect(gainNode2);
            gainNode2.connect(audioContext.destination);
            oscillator2.frequency.value = 1000;
            gainNode2.gain.setValueAtTime(notificationVolume, audioContext.currentTime);
            gainNode2.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.1);
            oscillator2.start(audioContext.currentTime);
            oscillator2.stop(audioContext.currentTime + 0.1);
        }, 100);
    };
}

function playNotificationIfReady() {
    if (!notificationEnabled) return;
    const now = Date.now();
    if (now - lastNotificationTime >= notificationCooldown) {
        if (notificationSound) notificationSound();
        lastNotificationTime = now;
    }
}


// ══════════════════════════════════════════════════════════════════════════════
//  EMOTE PARSING (unchanged — pure DOM logic)
// ══════════════════════════════════════════════════════════════════════════════

function removeWelcomeMessage() {
    const welcomeMsg = chatContainer.querySelector('.welcome-message');
    if (welcomeMsg) welcomeMsg.remove();
}

function parseTwitchEmotes(message, emotes) {
    if (!emotes) {
        const fragment = document.createDocumentFragment();
        fragment.appendChild(document.createTextNode(message));
        return fragment;
    }
    const emoteReplacements = [];
    for (const emoteId in emotes) {
        emotes[emoteId].forEach(position => {
            const [start, end] = position.split('-').map(Number);
            emoteReplacements.push({ start, end, id: emoteId, text: message.substring(start, end + 1) });
        });
    }
    emoteReplacements.sort((a, b) => a.start - b.start);
    const fragment = document.createDocumentFragment();
    let currentIndex = 0;
    emoteReplacements.forEach(emote => {
        if (currentIndex < emote.start) {
            fragment.appendChild(document.createTextNode(message.substring(currentIndex, emote.start)));
        }
        const img = document.createElement('img');
        img.src = `https://static-cdn.jtvnw.net/emoticons/v2/${emote.id}/default/dark/1.0`;
        img.alt = emote.text;
        img.className = 'emote';
        img.title = emote.text;
        fragment.appendChild(img);
        currentIndex = emote.end + 1;
    });
    if (currentIndex < message.length) {
        fragment.appendChild(document.createTextNode(message.substring(currentIndex)));
    }
    return fragment;
}

function parseTiktokMessage(message, emotes) {
    const fragment = document.createDocumentFragment();
    if (!emotes || emotes.length === 0) {
        fragment.appendChild(document.createTextNode(message));
        return fragment;
    }
    const sortedEmotes = [...emotes].sort((a, b) => (a.position || 0) - (b.position || 0));
    let lastIndex = 0;
    sortedEmotes.forEach(emote => {
        if (emote.position > lastIndex) {
            fragment.appendChild(document.createTextNode(message.substring(lastIndex, emote.position)));
        }
        if (emote.image && emote.image.imageUrl) {
            const img = document.createElement('img');
            img.src = emote.image.imageUrl;
            img.alt = emote.emoteId || '';
            img.className = 'emote';
            img.title = emote.emoteId || '';
            fragment.appendChild(img);
            lastIndex = emote.position + (emote.emoteId ? emote.emoteId.length : 0);
        }
    });
    if (lastIndex < message.length) {
        fragment.appendChild(document.createTextNode(message.substring(lastIndex)));
    }
    return fragment;
}

/** Build YouTube message HTML from raw message parts sent by main process */
function buildYoutubeMessageHtml(parts) {
    if (!Array.isArray(parts)) return '';
    return parts.map(part => {
        if (part.text) return part.text;
        if (part.emojiText) {
            const emojiUrl = part.thumbnail?.thumbnails?.[0]?.url || part.thumbnails?.[0]?.url;
            if (emojiUrl) {
                return `<img src="${emojiUrl}" alt="${part.emojiText}" class="emote" title="${part.emojiText}">`;
            }
            return part.emojiText;
        }
        if (part.emoji) {
            const emojiUrl = part.emoji.image?.thumbnails?.[0]?.url;
            if (emojiUrl) {
                return `<img src="${emojiUrl}" alt="${part.emoji.emojiId}" class="emote" title="${part.emoji.emojiId}">`;
            }
            return part.emoji.emojiId || '';
        }
        return '';
    }).join('');
}


// ══════════════════════════════════════════════════════════════════════════════
//  ADD CHAT MESSAGE — the core display function
// ══════════════════════════════════════════════════════════════════════════════

function addChatMessage(platform, username, message, guestName = null, guestColor = null, color = null, emotes = null, messageId = null, userId = null, youtubeMessageParts = null) {
    removeWelcomeMessage();

    const messageDiv = document.createElement('div');
    messageDiv.className = `chat-message ${platform}`;
    if (guestColor) messageDiv.style.borderLeftColor = guestColor;

    const badge = document.createElement('span');
    badge.className = 'platform-badge';
    badge.textContent = platform;

    if (guestName) {
        const guestBadge = document.createElement('span');
        guestBadge.className = 'guest-badge';
        guestBadge.textContent = guestName;
        guestBadge.style.backgroundColor = guestColor;
        messageDiv.appendChild(badge);
        messageDiv.appendChild(guestBadge);
    } else {
        messageDiv.appendChild(badge);
    }

    const usernameSpan = document.createElement('span');
    usernameSpan.className = 'username';
    usernameSpan.textContent = username;
    if (color) usernameSpan.style.color = color;

    const messageSpan = document.createElement('span');
    messageSpan.className = 'message-text';

    if (platform === 'twitch' && emotes) {
        messageSpan.appendChild(parseTwitchEmotes(message, emotes));
    } else if (platform === 'tiktok') {
        messageSpan.appendChild(parseTiktokMessage(message, emotes));
    } else if (platform === 'youtube' && youtubeMessageParts) {
        messageSpan.innerHTML = buildYoutubeMessageHtml(youtubeMessageParts);
    } else if (platform === 'youtube' && typeof message === 'string' && message.includes('<img')) {
        messageSpan.innerHTML = message;
    } else {
        messageSpan.textContent = message;
    }

    messageDiv.appendChild(usernameSpan);
    messageDiv.appendChild(document.createTextNode(': '));
    messageDiv.appendChild(messageSpan);

    // Store Twitch IDs for moderation
    if (platform === 'twitch' && messageId) messageDiv.dataset.messageId = messageId;
    if (platform === 'twitch' && userId) {
        messageDiv.dataset.userId = userId;
        messageDiv.dataset.username = username;
    }

    chatContainer.appendChild(messageDiv);
    chatContainer.scrollTop = chatContainer.scrollHeight;

    // Forward to overlay
    if (overlayActive) {
        window.purptea.sendToOverlay({
            platform, username,
            message: messageSpan.innerHTML,
            guestName, guestColor, color,
            messageId, userId
        });
    }

    if (username !== 'System' && !username.includes('System')) {
        playNotificationIfReady();
    }
}

// ══════════════════════════════════════════════════════════════════════════════
//  SYSTEM MESSAGE ROUTING — classify → activity panel or ticker
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Classify system messages by emoji prefix.
 * Returns { category, cssClass } or null for genuine chat.
 */
function classifySystemMessage(username) {
    if (!username || !username.includes('System')) return null;
    if (username.includes('🎁')) return { category: 'gifts',  cssClass: 'gift' };
    if (username.includes('❤️')) return { category: 'follows', cssClass: 'follow' };
    if (username.includes('⭐')) return { category: 'subs',    cssClass: 'sub' };
    if (username.includes('✂️')) return { category: 'misc',    cssClass: 'misc' };
    if (username.includes('🗑️') || username.includes('⏱️') || username.includes('🔨') || username.includes('❌'))
        return { category: 'misc', cssClass: 'misc' };
    if (username.includes('🔄') || username.includes('✅'))
        return { category: 'misc', cssClass: 'misc' };
    if (username.includes('👋')) return { category: 'joins', cssClass: 'follow' };
    // Generic system
    return { category: 'misc', cssClass: 'misc' };
}

/**
 * Route a message: system → activity panel, member join → ticker, else → chat.
 */
function routeMessage(platform, username, message, guestName, guestColor, color, emotes, messageId, userId, youtubeMessageParts) {
    const classification = classifySystemMessage(username);

    if (classification) {
        // Join events → ticker
        if (classification.category === 'joins') {
            addTickerItem(platform, message);
            return;
        }
        // All other system messages → activity feed
        addActivityItem(platform, username, message, classification, guestName, guestColor, color);
        return;
    }

    // Regular chat message
    addChatMessage(platform, username, message, guestName, guestColor, color, emotes, messageId, userId, youtubeMessageParts);
}

/**
 * Add an item to the Activity feed panel.
 */
function addActivityItem(platform, username, message, classification, guestName, guestColor, color) {
    if (!activityContainer) return;

    // Remove empty state
    const emptyState = activityContainer.querySelector('.empty-state');
    if (emptyState) emptyState.remove();

    const item = document.createElement('div');
    item.className = `activity-item ${classification.cssClass}`;
    item.dataset.category = classification.category;

    // Check filter visibility
    if (!activeFilters.all && !activeFilters[classification.category]) {
        item.style.display = 'none';
    }

    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    const platformSpan = document.createElement('span');
    platformSpan.className = `activity-platform ${platform}`;
    platformSpan.textContent = platform;

    const timeSpan = document.createElement('span');
    timeSpan.className = 'activity-time';
    timeSpan.textContent = time;

    const textSpan = document.createElement('span');
    textSpan.className = 'activity-text';
    textSpan.textContent = message;

    item.appendChild(timeSpan);
    item.appendChild(platformSpan);
    if (guestName) {
        const guestBadge = document.createElement('span');
        guestBadge.className = 'guest-badge';
        guestBadge.textContent = guestName;
        guestBadge.style.backgroundColor = guestColor;
        item.appendChild(guestBadge);
    }
    item.appendChild(document.createTextNode(' '));
    item.appendChild(textSpan);

    activityContainer.appendChild(item);
    activityContainer.scrollTop = activityContainer.scrollHeight;
}

/**
 * Add a join event to the ticker bar.
 */
function addTickerItem(platform, message) {
    if (!tickerTrack) return;

    // Remove placeholder
    const placeholder = tickerTrack.querySelector('.ticker-placeholder');
    if (placeholder) placeholder.remove();

    const item = document.createElement('span');
    item.className = 'ticker-item';

    const badge = document.createElement('span');
    badge.className = `ticker-platform ${platform}`;
    badge.textContent = platform.charAt(0).toUpperCase();

    const name = document.createElement('span');
    name.className = 'ticker-name';
    // Extract the user name from the message (format: "username joined the stream!")
    name.textContent = message;

    item.appendChild(badge);
    item.appendChild(name);
    tickerTrack.appendChild(item);

    // Remove after animation completes
    item.addEventListener('animationend', () => item.remove());

    // Keep ticker tidy — limit to 20 items
    while (tickerTrack.children.length > 20) {
        tickerTrack.removeChild(tickerTrack.firstChild);
    }
}


// ══════════════════════════════════════════════════════════════════════════════
//  IPC EVENT LISTENERS — Messages & status from ChatManager
// ══════════════════════════════════════════════════════════════════════════════

function setupIpcListeners() {
    // ── Incoming chat messages from main process ─────────────────────────
    window.purptea.on('chat:message', (data) => {
        routeMessage(
            data.platform,
            data.username,
            data.message,
            data.guestName || null,
            data.guestColor || null,
            data.color || null,
            data.emotes || null,
            data.messageId || null,
            data.userId || null,
            data.youtubeMessageParts || null
        );
    });

    // ── Connection status changes ────────────────────────────────────────
    window.purptea.on('chat:status', (data) => {
        const { platform, status, message, guestId } = data;

        // If this is a guest status, handle separately
        if (guestId !== null && guestId !== undefined) return;

        if (platform === 'twitch') {
            twitchStatus.textContent = message;
            if (status === 'connected') {
                twitchConnected = true;
                twitchStatus.className = 'status connected';
                connectTwitchBtn.textContent = 'Disconnect from Chat';
                if (window._updateChatInputState) window._updateChatInputState();
            } else if (status === 'disconnected' || status === 'error' || status === 'stream-ended') {
                twitchConnected = false;
                twitchStatus.className = 'status disconnected';
                connectTwitchBtn.textContent = 'Connect to Chat';
                if (window._updateChatInputState) window._updateChatInputState();
                if (status === 'disconnected') {
                    stopTwitchViewerPolling();
                    updateViewerDisplay('twitch', null);
                }
            }
        } else if (platform === 'tiktok') {
            tiktokStatus.textContent = message;
            if (status === 'connected') {
                tiktokConnected = true;
                tiktokStatus.className = 'status connected';
                connectTiktokBtn.textContent = 'Disconnect from Chat';
            } else if (status === 'disconnected' || status === 'error' || status === 'stream-ended') {
                tiktokConnected = false;
                tiktokStatus.className = 'status disconnected';
                connectTiktokBtn.textContent = 'Connect to Chat';
                updateViewerDisplay('tiktok', null);
            } else if (status === 'reconnecting') {
                tiktokStatus.className = 'status';
            }
        } else if (platform === 'youtube') {
            youtubeStatus.textContent = message;
            if (status === 'connected') {
                youtubeConnected = true;
                youtubeStatus.className = 'status connected';
                connectYoutubeBtn.textContent = 'Disconnect from Chat';
            } else if (status === 'disconnected' || status === 'error') {
                youtubeConnected = false;
                youtubeStatus.className = 'status disconnected';
                connectYoutubeBtn.textContent = 'Connect to Chat';
            }
        }
    });

    // ── Viewer count updates (TikTok roomUser) ──────────────────────────
    window.purptea.on('chat:viewer-update', (data) => {
        if (data.platform === 'tiktok' && !data.guestId) {
            tiktokViewerCount = data.count;
            updateViewerDisplay('tiktok', data.count);
        }
    });

    // ── Guest status updates ─────────────────────────────────────────────
    window.purptea.on('guest:status', (data) => {
        const { guestId, status, message, channelName } = data;
        const guest = guests.find(g => g.id === guestId);
        if (!guest || !guest.statusElement) return;

        guest.statusElement.textContent = message;

        if (status === 'connected') {
            guest.connected = true;
            guest.statusElement.className = 'guest-status connected';
            if (window._updateChatInputState) window._updateChatInputState();
            // If YouTube returned a channel name, update the card
            if (channelName && guest.cardElement) {
                guest.name = channelName.substring(0, 20);
                const nameEl = guest.cardElement.querySelector('.guest-name');
                if (nameEl) nameEl.textContent = guest.name;
            }
        } else if (status === 'connecting' || status === 'reconnecting') {
            guest.statusElement.className = 'guest-status connecting';
        } else if (status === 'error') {
            guest.statusElement.className = 'guest-status error';
        } else {
            guest.connected = false;
            guest.statusElement.className = 'guest-status disconnected';
            if (window._updateChatInputState) window._updateChatInputState();
        }
    });

    // ── Overlay closed ───────────────────────────────────────────────────
    window.purptea.on('overlay-closed', () => {
        overlayActive = false;
        const popOutBtn = document.getElementById('pop-out-btn');
        if (popOutBtn) {
            popOutBtn.classList.remove('active');
            popOutBtn.textContent = '⤴';
            popOutBtn.title = 'Pop Out Chat';
        }
        chatContainer.classList.remove('hidden');
        const chatPanel = document.getElementById('panel-chat');
        if (chatPanel) chatPanel.classList.remove('collapsed');
        const configPanel = document.getElementById('panel-config');
        if (configPanel) configPanel.classList.remove('collapsed');
    });

    // ── Clip request from overlay ────────────────────────────────────────
    window.purptea.on('create-clip-request', () => {
        createClip();
    });

    // ── Moderation request from overlay ──────────────────────────────────
    window.purptea.on('moderate-user-request', async (data) => {
        const { action, messageId, userId, username } = data;
        let success = false;
        switch (action) {
            case 'delete':
                success = await deleteTwitchMessage(messageId);
                if (success) routeMessage('twitch', '🗑️ System', `Message from ${username} deleted`, null, null, '#888888');
                break;
            case 'timeout-1m':
                success = await timeoutTwitchUser(userId, 60);
                if (success) routeMessage('twitch', '⏱️ System', `${username} timed out for 1 minute`, null, null, '#ff9900');
                break;
            case 'timeout-10m':
                success = await timeoutTwitchUser(userId, 600);
                if (success) routeMessage('twitch', '⏱️ System', `${username} timed out for 10 minutes`, null, null, '#ff9900');
                break;
            case 'timeout-1h':
                success = await timeoutTwitchUser(userId, 3600);
                if (success) routeMessage('twitch', '⏱️ System', `${username} timed out for 1 hour`, null, null, '#ff9900');
                break;
            case 'timeout-24h':
                success = await timeoutTwitchUser(userId, 86400);
                if (success) routeMessage('twitch', '⏱️ System', `${username} timed out for 24 hours`, null, null, '#ff9900');
                break;
            case 'ban':
                success = await banTwitchUser(userId);
                if (success) routeMessage('twitch', '🔨 System', `${username} has been banned`, null, null, '#ff4444');
                break;
        }
        if (!success && action) {
            routeMessage('twitch', '❌ System', `Failed to ${action} - make sure you are a mod for this channel`, null, null, '#ff4444');
        }
    });

    // ── Auto-update events ───────────────────────────────────────────────
    window.purptea.on('update-available', () => {
        routeMessage('twitch', '🔄 System', 'A new update is being downloaded…', null, null, '#9146ff');
    });
    window.purptea.on('update-downloaded', () => {
        routeMessage('twitch', '✅ System', 'Update ready! Restart the app to install.', null, null, '#4caf50');
    });
}


// ══════════════════════════════════════════════════════════════════════════════
//  CONNECTION HANDLERS (use IPC instead of library constructors)
// ══════════════════════════════════════════════════════════════════════════════

async function handleTwitchConnect() {
    if (twitchConnected) {
        await window.purptea.disconnectTwitch();
        twitchConnected = false;
        stopTwitchViewerPolling();
        updateViewerDisplay('twitch', null);
        if (window._updateChatInputState) window._updateChatInputState();
        return;
    }

    const channel = twitchChannelInput.value.trim().toLowerCase();
    if (!channel) { alert('Please enter a Twitch channel name'); return; }

    twitchStatus.textContent = `Twitch: Connecting to ${channel}...`;
    twitchStatus.className = 'status';

    // Validate channel
    try {
        const response = await fetch(`https://decapi.me/twitch/id/${channel}`);
        const result = await response.text();
        if (result.includes('User not found') || result.includes('Invalid') || result.trim() === '') {
            twitchStatus.textContent = 'Twitch: Channel Not Found';
            twitchStatus.className = 'status disconnected';
            alert(`Channel "${channel}" does not exist. Please check the spelling.`);
            return;
        }
    } catch (err) {
        console.warn('Could not validate channel existence:', err);
    }

    const result = await window.purptea.connectTwitch(channel);

    if (result.success) {
        // Get broadcaster ID for moderation
        twitchBroadcasterId = await getBroadcasterId(channel);
        if (twitchBroadcasterId) {
            localStorage.setItem('twitch_broadcaster_id', twitchBroadcasterId);
            startTwitchViewerPolling(channel);
        }
        localStorage.setItem('twitchChannel', channel);
    } else {
        twitchStatus.textContent = 'Connection Failed';
        twitchStatus.className = 'status disconnected';
        alert('Failed to connect to Twitch. Please check the channel name and try again.');
    }
}

function handleTiktokConnect() {
    if (tiktokConnected) {
        window.purptea.disconnectTiktok();
        tiktokConnected = false;
        updateViewerDisplay('tiktok', null);
        return;
    }

    let username = tiktokUsernameInput.value.trim();
    if (!username) { alert('Please enter a TikTok username'); return; }
    username = username.replace('@', '');

    tiktokStatus.textContent = `Connecting to @${username}...`;
    tiktokStatus.className = 'status';

    window.purptea.connectTiktok(username, tiktokApiKey || null).then(result => {
        if (result.success) {
            localStorage.setItem('tiktokUsername', username);
        } else {
            let errorMsg = 'Failed to connect to TikTok.\n\n';
            if (result.error && result.error.includes('LIVE has ended')) {
                errorMsg += 'The stream appears to have ended or is not accessible yet.';
            } else if (result.error && result.error.includes('Unable to retrieve')) {
                errorMsg += 'Unable to find this user or stream. Possible reasons:\n';
                errorMsg += '- Username spelling\n';
                errorMsg += '- Stream just started (wait 30-60 seconds)\n';
                errorMsg += '- TikTok Live app streams may have limited API access\n';
                errorMsg += '- Account may be private or restricted';
            } else {
                errorMsg += `Error: ${result.error || 'Unknown error'}\n\n`;
                errorMsg += 'Tips:\n';
                errorMsg += '- Verify username spelling\n';
                errorMsg += '- Wait 30-60 seconds after going live\n';
                errorMsg += '- Try streaming from TikTok desktop instead of mobile app';
            }
            alert(errorMsg);
        }
    });
}

async function handleYoutubeConnect() {
    if (youtubeConnected) {
        await window.purptea.disconnectYoutube();
        youtubeConnected = false;
        return;
    }

    const videoId = youtubeVideoInput.value.trim();
    if (!videoId) { alert('Please enter a YouTube video ID or URL'); return; }

    let cleanVideoId = videoId;
    if (videoId.includes('youtube.com') || videoId.includes('youtu.be')) {
        const urlMatch = videoId.match(/(?:youtu\.be\/|youtube\.com(?:\/embed\/|\/v\/|\/watch\?v=|\/watch\?.+&v=))([\w-]{11})/);
        if (urlMatch) {
            cleanVideoId = urlMatch[1];
        } else {
            alert('Could not extract video ID from URL. Please use format: youtube.com/watch?v=VIDEO_ID');
            return;
        }
    }

    youtubeStatus.textContent = 'Connecting to video...';
    youtubeStatus.className = 'status';

    const result = await window.purptea.connectYoutube(cleanVideoId);

    if (result.success) {
        localStorage.setItem('youtubeVideo', cleanVideoId);
    } else {
        youtubeStatus.textContent = 'Connection Failed';
        youtubeStatus.className = 'status disconnected';

        let errorMsg = `Failed to connect to YouTube.\n\nError: ${result.error}\n\nVideo ID tried: ${cleanVideoId}\n\n`;
        if (result.error && result.error.includes('not found')) {
            errorMsg += 'The video was not found or is not currently live.\n\n';
            errorMsg += 'Please verify:\n1. The video is CURRENTLY STREAMING (not scheduled)\n2. The video ID is correct\n3. The stream has live chat enabled\n';
        } else {
            errorMsg += 'Common issues:\n- Video is not currently live\n- Live chat is disabled\n- Network/firewall blocking connection\n';
        }
        alert(errorMsg);
    }
}


// ══════════════════════════════════════════════════════════════════════════════
//  GUEST UI (cards, modal — connections are in main process)
// ══════════════════════════════════════════════════════════════════════════════

function removeEmptyState() {
    const emptyState = guestsContainer.querySelector('.empty-state');
    if (emptyState) emptyState.remove();
}

function updateGuestsDisplay() {
    if (guests.length === 0) {
        guestsContainer.innerHTML = `
            <div class="empty-state">
                <p>No additional guests</p>
                <p class="small-text">Click "+" to add more streams</p>
            </div>
        `;
    }
}

function createGuestCard(guest) {
    const card = document.createElement('div');
    card.className = 'guest-card';
    card.id = `guest-${guest.id}`;
    card.style.borderLeftColor = guest.color;

    const platformIcon = guest.platform === 'twitch' ? '🟣 Twitch' : guest.platform === 'tiktok' ? '⚫ TikTok' : '🔴 YouTube';

    card.innerHTML = `
        <div class="guest-card-header">
            <div class="guest-info">
                <span class="guest-name" style="color: ${guest.color}">${guest.name}</span>
                <span class="guest-platform">${platformIcon}</span>
            </div>
            <div class="guest-actions">
                <button class="guest-clip-btn" data-guest-id="${guest.id}" title="Create Clip" ${guest.platform !== 'twitch' || !twitchAccessToken ? 'disabled' : ''}>✂️</button>
                <button class="remove-guest-btn" data-guest-id="${guest.id}" title="Remove Guest">×</button>
            </div>
        </div>
        <div class="guest-username">${guest.username}</div>
        <div class="guest-status connecting">Setting up...</div>
    `;

    guest.statusElement = card.querySelector('.guest-status');
    guest.cardElement = card;

    card.querySelector('.guest-clip-btn').addEventListener('click', () => { createGuestClip(guest.id); });
    card.querySelector('.remove-guest-btn').addEventListener('click', () => { removeGuest(guest.id); });

    return card;
}

async function removeGuest(guestId) {
    const guest = guests.find(g => g.id === guestId);
    if (!guest) return;

    // Tell main process to disconnect
    await window.purptea.removeGuest(guestId);

    // Remove from DOM
    if (guest.cardElement) guest.cardElement.remove();
    guests = guests.filter(g => g.id !== guestId);
    updateGuestsDisplay();
    if (window._updateChatInputState) window._updateChatInputState();
}

// ── Guest modal ──────────────────────────────────────────────────────────
let selectedPlatform = null;

function showAddGuestDialog() {
    const modal = document.getElementById('guest-modal');
    const step1 = document.getElementById('modal-step-1');
    const step2 = document.getElementById('modal-step-2');
    selectedPlatform = null;
    step1.style.display = 'block';
    step2.style.display = 'none';
    document.getElementById('modal-username-input').value = '';
    modal.style.display = 'flex';
}

function hideGuestModal() {
    document.getElementById('guest-modal').style.display = 'none';
}

async function addGuestFromModal() {
    const username = document.getElementById('modal-username-input').value.trim();
    if (!username) { alert('Please enter a username'); return; }

    const cleanUsername = selectedPlatform === 'youtube' ? username.trim() : username.toLowerCase();

    // Ask main process to create & connect guest
    const { guestId, name, color } = await window.purptea.addGuest(selectedPlatform, cleanUsername, tiktokApiKey || null);

    const guest = {
        id: guestId,
        platform: selectedPlatform,
        username: cleanUsername,
        name,
        color,
        connected: false,
        statusElement: null,
        cardElement: null
    };
    guests.push(guest);
    removeEmptyState();

    const card = createGuestCard(guest);
    guestsContainer.appendChild(card);

    hideGuestModal();
}


// ══════════════════════════════════════════════════════════════════════════════
//  TWITCH OAUTH (window.open + postMessage — safe Web APIs)
// ══════════════════════════════════════════════════════════════════════════════

function startTwitchAuth() {
    const authUrl = `https://id.twitch.tv/oauth2/authorize?client_id=${TWITCH_CLIENT_ID}&redirect_uri=${encodeURIComponent(TWITCH_REDIRECT_URI)}&response_type=token&scope=${encodeURIComponent(TWITCH_SCOPES)}`;
    window.open(authUrl, 'TwitchAuth', 'width=500,height=700');
    const messageHandler = (event) => {
        if (event.data && event.data.type === 'twitch-auth' && event.data.token) {
            handleTwitchAuthSuccess(event.data.token);
            window.removeEventListener('message', messageHandler);
        }
    };
    window.addEventListener('message', messageHandler);
}

async function handleTwitchAuthSuccess(accessToken) {
    twitchAccessToken = accessToken;
    localStorage.setItem('twitch_access_token', accessToken);

    try {
        const response = await fetch('https://api.twitch.tv/helix/users', {
            headers: { 'Authorization': `Bearer ${accessToken}`, 'Client-Id': TWITCH_CLIENT_ID }
        });
        const data = await response.json();
        if (data.data && data.data[0]) {
            twitchUsername = data.data[0].login;
            twitchUserId = data.data[0].id;
            localStorage.setItem('twitch_username', twitchUsername);
            localStorage.setItem('twitch_user_id', twitchUserId);
            updateTwitchAuthUI(true);
            connectTwitchPubSub(twitchUserId, accessToken);
        }
    } catch (error) {
        console.error('Error fetching Twitch user info:', error);
        alert('Failed to get user information. Please try logging in again.');
    }
}

function connectTwitchPubSub(userId, accessToken) {
    if (twitchPubSub) twitchPubSub.close();

    twitchPubSub = new WebSocket('wss://pubsub-edge.twitch.tv');

    twitchPubSub.onopen = () => {
        console.log('Connected to Twitch PubSub');
        twitchPubSub.send(JSON.stringify({
            type: 'LISTEN',
            data: { topics: [`channel-points-channel-v1.${userId}`], auth_token: accessToken }
        }));
        setInterval(() => {
            if (twitchPubSub && twitchPubSub.readyState === WebSocket.OPEN) {
                twitchPubSub.send(JSON.stringify({ type: 'PING' }));
            }
        }, 240000);
    };

    twitchPubSub.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === 'PONG' || msg.type === 'RESPONSE') return;
        if (msg.type === 'MESSAGE') {
            const data = JSON.parse(msg.data.message);
            if (data.type === 'reward-redeemed') {
                const redemption = data.data.redemption;
                const user = redemption.user.display_name;
                const reward = redemption.reward.title;
                const userInput = redemption.user_input || '';
                let redeemMessage = `${user} redeemed: ${reward}`;
                if (userInput) redeemMessage += ` - "${userInput}"`;
                routeMessage('twitch', '⭐ System', redeemMessage, null, null, '#9146ff');
            }
        }
    };

    twitchPubSub.onerror = (error) => console.error('PubSub error:', error);
    twitchPubSub.onclose = () => console.log('PubSub connection closed');
}

function updateTwitchAuthUI(isLoggedIn) {
    const loginBtn = document.getElementById('twitch-login-btn');
    const authInfo = document.getElementById('twitch-auth-info');
    const usernameDisplay = document.getElementById('twitch-username-display');
    const clipBtn = document.getElementById('create-clip-btn');

    if (isLoggedIn && twitchUsername) {
        if (loginBtn) {
            loginBtn.textContent = `✓ Logged in as @${twitchUsername}`;
            loginBtn.style.background = 'linear-gradient(135deg, #4caf50 0%, #388e3c 100%)';
            loginBtn.disabled = true;
            loginBtn.style.cursor = 'default';
        }
        if (authInfo) {
            authInfo.style.display = 'flex';
            usernameDisplay.textContent = `@${twitchUsername}`;
        }
        if (clipBtn) { clipBtn.disabled = false; clipBtn.title = 'Create clip of last 30 seconds'; }

        const masterClipBtn = document.getElementById('master-clip-btn');
        if (masterClipBtn) { masterClipBtn.disabled = false; masterClipBtn.title = 'Create clips for main channel and all Twitch guests'; }

        document.querySelectorAll('.guest-clip-btn').forEach(btn => {
            const guestId = parseInt(btn.getAttribute('data-guest-id'));
            const guest = guests.find(g => g.id === guestId);
            if (guest && guest.platform === 'twitch') btn.disabled = false;
        });
    } else {
        if (loginBtn) {
            loginBtn.textContent = '🔑 Login with Twitch';
            loginBtn.style.background = 'linear-gradient(135deg, #9146ff 0%, #772ce8 100%)';
            loginBtn.disabled = false;
            loginBtn.style.cursor = 'pointer';
        }
        if (authInfo) authInfo.style.display = 'none';
        if (clipBtn) { clipBtn.disabled = true; clipBtn.title = 'Login required'; }

        const masterClipBtn = document.getElementById('master-clip-btn');
        if (masterClipBtn) { masterClipBtn.disabled = true; masterClipBtn.title = 'Login required'; }

        document.querySelectorAll('.guest-clip-btn').forEach(btn => { btn.disabled = true; });
    }

    // Update chat input state when auth changes
    if (window._updateChatInputState) window._updateChatInputState();
}

function logoutTwitch() {
    twitchAccessToken = null;
    twitchUsername = null;
    twitchUserId = null;
    twitchBroadcasterId = null;
    localStorage.removeItem('twitch_access_token');
    localStorage.removeItem('twitch_username');
    localStorage.removeItem('twitch_user_id');
    localStorage.removeItem('twitch_broadcaster_id');

    if (twitchConnected) window.purptea.disconnectTwitch();
    if (twitchPubSub) { twitchPubSub.close(); twitchPubSub = null; }

    updateTwitchAuthUI(false);
    alert('Logged out successfully');
}


// ══════════════════════════════════════════════════════════════════════════════
//  TWITCH MODERATION (fetch — safe Web API)
// ══════════════════════════════════════════════════════════════════════════════

async function deleteTwitchMessage(messageId) {
    if (!twitchAccessToken || !twitchBroadcasterId) return false;
    try {
        const response = await fetch(`https://api.twitch.tv/helix/moderation/chat?broadcaster_id=${twitchBroadcasterId}&moderator_id=${twitchUserId}&message_id=${messageId}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${twitchAccessToken}`, 'Client-Id': TWITCH_CLIENT_ID }
        });
        return response.ok;
    } catch (error) {
        console.error('Error deleting message:', error);
        return false;
    }
}

async function timeoutTwitchUser(userId, duration) {
    if (!twitchAccessToken || !twitchBroadcasterId) return false;
    try {
        const response = await fetch(`https://api.twitch.tv/helix/moderation/bans?broadcaster_id=${twitchBroadcasterId}&moderator_id=${twitchUserId}`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${twitchAccessToken}`, 'Client-Id': TWITCH_CLIENT_ID, 'Content-Type': 'application/json' },
            body: JSON.stringify({ data: { user_id: userId, duration } })
        });
        return response.ok;
    } catch (error) {
        console.error('Error timing out user:', error);
        return false;
    }
}

async function banTwitchUser(userId) {
    if (!twitchAccessToken || !twitchBroadcasterId) return false;
    try {
        const response = await fetch(`https://api.twitch.tv/helix/moderation/bans?broadcaster_id=${twitchBroadcasterId}&moderator_id=${twitchUserId}`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${twitchAccessToken}`, 'Client-Id': TWITCH_CLIENT_ID, 'Content-Type': 'application/json' },
            body: JSON.stringify({ data: { user_id: userId } })
        });
        return response.ok;
    } catch (error) {
        console.error('Error banning user:', error);
        return false;
    }
}


// ══════════════════════════════════════════════════════════════════════════════
//  VIEWER COUNT (fetch — safe Web API)
// ══════════════════════════════════════════════════════════════════════════════

let twitchViewerInterval = null;

function updateViewerDisplay(platform, count) {
    const statElement = document.getElementById(`${platform}-viewer-stat`);
    const countElement = document.getElementById(`${platform}-viewer-count`);
    const emptyState = document.getElementById('viewer-empty-state');

    if (count === null || count === undefined) {
        if (statElement) statElement.style.display = 'none';
        const anyVisible = document.querySelector('.viewer-stat[style*="display: flex"]') ||
                          document.querySelector('.viewer-stat:not([style*="display: none"])');
        if (emptyState) emptyState.style.display = anyVisible ? 'none' : 'block';
    } else {
        if (statElement) statElement.style.display = 'flex';
        if (countElement) countElement.textContent = count.toLocaleString();
        if (emptyState) emptyState.style.display = 'none';
    }
}

function startTwitchViewerPolling(channel) {
    stopTwitchViewerPolling();
    twitchViewerInterval = setInterval(async () => {
        try {
            const response = await fetch(`https://decapi.me/twitch/viewercount/${channel}`);
            const count = await response.text();
            const viewerCount = parseInt(count);
            if (!isNaN(viewerCount)) {
                twitchViewerCount = viewerCount;
                updateViewerDisplay('twitch', viewerCount);
            }
        } catch (error) {
            console.error('Error fetching Twitch viewer count:', error);
        }
    }, 10000);

    // Initial fetch
    fetch(`https://decapi.me/twitch/viewercount/${channel}`)
        .then(r => r.text())
        .then(count => {
            const v = parseInt(count);
            if (!isNaN(v)) { twitchViewerCount = v; updateViewerDisplay('twitch', v); }
        })
        .catch(e => console.error('Error fetching initial Twitch viewer count:', e));
}

function stopTwitchViewerPolling() {
    if (twitchViewerInterval) { clearInterval(twitchViewerInterval); twitchViewerInterval = null; }
}

async function getBroadcasterId(channelName) {
    if (!twitchAccessToken) return null;
    try {
        const response = await fetch(`https://api.twitch.tv/helix/users?login=${channelName}`, {
            headers: { 'Authorization': `Bearer ${twitchAccessToken}`, 'Client-Id': TWITCH_CLIENT_ID }
        });
        const data = await response.json();
        if (data.data && data.data[0]) return data.data[0].id;
    } catch (error) {
        console.error('Error fetching broadcaster ID:', error);
    }
    return null;
}


// ══════════════════════════════════════════════════════════════════════════════
//  CLIPS (fetch + clipboard via IPC)
// ══════════════════════════════════════════════════════════════════════════════

async function createClip() {
    if (!twitchAccessToken) { alert('Please login with Twitch first'); return; }
    const channel = twitchChannelInput.value.trim().toLowerCase();
    if (!channel) { alert('Please enter a channel name'); return; }

    try {
        const userResponse = await fetch(`https://api.twitch.tv/helix/users?login=${channel}`, {
            headers: { 'Authorization': `Bearer ${twitchAccessToken}`, 'Client-Id': TWITCH_CLIENT_ID }
        });
        const userData = await userResponse.json();
        if (!userData.data || !userData.data[0]) { alert('Channel not found'); return; }

        const broadcasterId = userData.data[0].id;
        const clipResponse = await fetch(`https://api.twitch.tv/helix/clips?broadcaster_id=${broadcasterId}`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${twitchAccessToken}`, 'Client-Id': TWITCH_CLIENT_ID }
        });
        const clipData = await clipResponse.json();

        if (clipData.data && clipData.data[0]) {
            const clipUrl = `https://clips.twitch.tv/${clipData.data[0].id}`;
            try {
                await window.purptea.writeClipboard(clipUrl);
                routeMessage('twitch', '✂️ System', `Clip created and copied! ${clipUrl}`, null, null, '#9146ff');
            } catch (e) {
                routeMessage('twitch', '✂️ System', `Clip created! ${clipUrl} (Click to copy)`, null, null, '#9146ff');
            }
        } else {
            throw new Error('Failed to create clip');
        }
    } catch (error) {
        console.error('Error creating clip:', error);
        alert('Failed to create clip. Make sure the stream is live and you have permission.');
    }
}

async function createGuestClip(guestId) {
    if (!twitchAccessToken) { alert('Please login with Twitch first'); return; }
    const guest = guests.find(g => g.id === guestId);
    if (!guest) { alert('Guest not found'); return; }
    if (guest.platform !== 'twitch') { alert('Clipping is only available for Twitch guests'); return; }

    const channel = guest.username.trim().toLowerCase();
    try {
        const userResponse = await fetch(`https://api.twitch.tv/helix/users?login=${channel}`, {
            headers: { 'Authorization': `Bearer ${twitchAccessToken}`, 'Client-Id': TWITCH_CLIENT_ID }
        });
        const userData = await userResponse.json();
        if (!userData.data || !userData.data[0]) { alert('Channel not found'); return; }

        const clipResponse = await fetch(`https://api.twitch.tv/helix/clips?broadcaster_id=${userData.data[0].id}`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${twitchAccessToken}`, 'Client-Id': TWITCH_CLIENT_ID }
        });
        const clipData = await clipResponse.json();

        if (clipData.data && clipData.data[0]) {
            const clipUrl = `https://clips.twitch.tv/${clipData.data[0].id}`;
            try {
                await window.purptea.writeClipboard(clipUrl);
                routeMessage('twitch', '✂️ System', `Clip of ${guest.name} created and copied! ${clipUrl}`, null, null, guest.color);
            } catch (e) {
                routeMessage('twitch', '✂️ System', `Clip of ${guest.name} created! ${clipUrl}`, null, null, guest.color);
            }
        } else {
            throw new Error('Failed to create clip');
        }
    } catch (error) {
        console.error('Error creating clip:', error);
        alert('Failed to create clip. Make sure the stream is live and you have permission.');
    }
}

async function createMasterClip() {
    if (!twitchAccessToken) { alert('Please login with Twitch first'); return; }
    const mainChannel = twitchChannelInput.value.trim().toLowerCase();
    if (!mainChannel) { alert('Please enter a main Twitch channel name'); return; }

    const twitchGuests = guests.filter(g => g.platform === 'twitch' && g.connected);
    let mainClipUrl = '';
    let clipsCreated = 0;
    let clipsFailed = 0;

    routeMessage('twitch', '✂️ System', `Creating master clip for ${mainChannel} + ${twitchGuests.length} guest(s)...`, null, null, '#9146ff');

    try {
        const result = await createClipForChannel(mainChannel);
        if (result) { mainClipUrl = result; clipsCreated++; } else { clipsFailed++; }

        for (const guest of twitchGuests) {
            try {
                const guestResult = await createClipForChannel(guest.username);
                if (guestResult) clipsCreated++; else clipsFailed++;
                await new Promise(resolve => setTimeout(resolve, 500));
            } catch (err) {
                console.error(`Failed to clip guest ${guest.username}:`, err);
                clipsFailed++;
            }
        }

        if (mainClipUrl) {
            await window.purptea.writeClipboard(mainClipUrl);
            routeMessage('twitch', '✂️ System', `Master clip complete! ${clipsCreated} created, ${clipsFailed} failed. Main clip copied: ${mainClipUrl}`, null, null, '#9146ff');
        } else {
            routeMessage('twitch', '✂️ System', `Master clip complete with errors: ${clipsCreated} created, ${clipsFailed} failed.`, null, null, '#ff6b6b');
        }
    } catch (error) {
        console.error('Error creating master clip:', error);
        routeMessage('twitch', '✂️ System', 'Master clip failed. Check console for details.', null, null, '#ff6b6b');
    }
}

async function createClipForChannel(channel) {
    try {
        const userResponse = await fetch(`https://api.twitch.tv/helix/users?login=${channel}`, {
            headers: { 'Authorization': `Bearer ${twitchAccessToken}`, 'Client-Id': TWITCH_CLIENT_ID }
        });
        const userData = await userResponse.json();
        if (!userData.data || !userData.data[0]) return null;

        const clipResponse = await fetch(`https://api.twitch.tv/helix/clips?broadcaster_id=${userData.data[0].id}`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${twitchAccessToken}`, 'Client-Id': TWITCH_CLIENT_ID }
        });
        const clipData = await clipResponse.json();
        if (clipData.data && clipData.data[0]) {
            return `https://clips.twitch.tv/${clipData.data[0].id}`;
        }
        return null;
    } catch (error) {
        console.error(`Error clipping ${channel}:`, error);
        return null;
    }
}


// ══════════════════════════════════════════════════════════════════════════════
//  PANEL SYSTEM — Drag-and-Drop, Collapse, Layout Persistence
// ══════════════════════════════════════════════════════════════════════════════

const LAYOUT_STORAGE_KEY = 'purptea_panel_order';
const DEFAULT_ORDER = ['config', 'guests', 'viewers', 'chat', 'chatinput', 'activity'];

/**
 * Reorder panel DOM elements to match an ordered array of panel IDs.
 */
function applyOrder(order) {
    const workspace = document.getElementById('panel-workspace');
    if (!workspace) return;
    order.forEach(id => {
        const panel = document.getElementById(`panel-${id}`);
        if (panel) workspace.appendChild(panel);
    });
}

/**
 * Save current DOM order to localStorage.
 */
function saveLayout() {
    const workspace = document.getElementById('panel-workspace');
    if (!workspace) return;
    const order = [...workspace.querySelectorAll('.panel[data-panel]')].map(p => p.dataset.panel);
    localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(order));
}

/**
 * Restore order from localStorage, or use defaults.
 */
function restoreLayout() {
    const saved = localStorage.getItem(LAYOUT_STORAGE_KEY);
    if (saved) {
        try {
            const order = JSON.parse(saved);
            if (Array.isArray(order) && order.length === DEFAULT_ORDER.length &&
                DEFAULT_ORDER.every(id => order.includes(id))) {
                applyOrder(order);
                return;
            }
        } catch (e) {
            console.warn('Invalid saved layout, using defaults');
        }
    }
    applyOrder(DEFAULT_ORDER);
}

/**
 * Reset to default order.
 */
function resetLayout() {
    applyOrder(DEFAULT_ORDER);
    localStorage.removeItem(LAYOUT_STORAGE_KEY);
    // Uncollapse all panels
    document.querySelectorAll('.panel.collapsed').forEach(p => p.classList.remove('collapsed'));
}

/**
 * Set up collapse toggle on all panels.
 */
function setupPanelCollapse() {
    document.querySelectorAll('.panel-collapse-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const panel = btn.closest('.panel');
            if (panel) panel.classList.toggle('collapsed');
        });
    });
}

/**
 * Set up drag-and-drop to reorder panels vertically.
 * Drag a panel by its header and drop it before/after another panel.
 */
function setupPanelDragDrop() {
    const workspace = document.getElementById('panel-workspace');
    if (!workspace) return;
    let draggedPanel = null;
    let placeholder = null;

    function getOrCreatePlaceholder() {
        if (!placeholder) {
            placeholder = document.createElement('div');
            placeholder.className = 'drop-placeholder';
        }
        return placeholder;
    }

    function removePlaceholder() {
        if (placeholder && placeholder.parentNode) placeholder.parentNode.removeChild(placeholder);
        placeholder = null;
    }

    /**
     * Given a Y coordinate, find the closest gap between panels
     * and insert the placeholder there. Works from workspace level
     * so it doesn't depend on hovering exactly over a panel.
     */
    function updatePlaceholderPosition(clientY) {
        if (!draggedPanel) return;
        const ph = getOrCreatePlaceholder();
        const panels = [...workspace.querySelectorAll('.panel[data-panel]:not(.dragging)')];
        if (panels.length === 0) {
            workspace.appendChild(ph);
            return;
        }

        // Find which panel the cursor is closest to, and whether above or below midpoint
        let insertRef = null; // insert before this element; null = append at end
        for (const p of panels) {
            const rect = p.getBoundingClientRect();
            const midY = rect.top + rect.height / 2;
            if (clientY < midY) {
                insertRef = p;
                break;
            }
        }

        if (insertRef) {
            if (ph.nextSibling !== insertRef) {
                workspace.insertBefore(ph, insertRef);
            }
        } else {
            // Past all panels → append at end
            if (ph !== workspace.lastElementChild) {
                workspace.appendChild(ph);
            }
        }
    }

    // -- Per-panel: only dragstart needs to be on each panel --
    workspace.querySelectorAll('.panel[data-panel]').forEach(panel => {
        panel.setAttribute('draggable', 'true');

        panel.addEventListener('dragstart', (e) => {
            if (!e.target.closest('[data-drag-handle]') && e.target !== panel) {
                e.preventDefault();
                return;
            }
            draggedPanel = panel;
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', panel.dataset.panel);
            // After browser captures the drag image, collapse the panel
            // so it doesn't block hit-testing on other panels
            requestAnimationFrame(() => {
                panel.classList.add('dragging');
            });
        });

        panel.addEventListener('dragend', () => {
            panel.classList.remove('dragging');
            removePlaceholder();
            draggedPanel = null;
        });
    });

    // -- All positioning & dropping handled at workspace level --
    workspace.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        if (!draggedPanel) return;
        updatePlaceholderPosition(e.clientY);
    });

    workspace.addEventListener('drop', (e) => {
        e.preventDefault();
        if (!draggedPanel) return;
        // Insert the dragged panel where the placeholder is
        if (placeholder && placeholder.parentNode) {
            workspace.insertBefore(draggedPanel, placeholder);
        } else {
            workspace.appendChild(draggedPanel);
        }
        draggedPanel.classList.remove('dragging');
        removePlaceholder();
        draggedPanel = null;
        saveLayout();
    });

    // If drag leaves the workspace entirely, clean up
    workspace.addEventListener('dragleave', (e) => {
        if (!workspace.contains(e.relatedTarget)) {
            removePlaceholder();
        }
    });
}

/**
 * Set up activity filter buttons.
 */
function setupActivityFilters() {
    const filterBtns = document.querySelectorAll('.filter-btn[data-filter]');
    filterBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            const filter = btn.dataset.filter;

            if (filter === 'all') {
                // Toggle all
                const newState = !activeFilters.all;
                activeFilters.all = newState;
                activeFilters.gifts = newState;
                activeFilters.follows = newState;
                activeFilters.subs = newState;
                activeFilters.misc = newState;
                filterBtns.forEach(b => b.classList.toggle('active', newState));
            } else {
                activeFilters[filter] = !activeFilters[filter];
                btn.classList.toggle('active', activeFilters[filter]);

                // Update "All" btn state
                const allActive = activeFilters.gifts && activeFilters.follows && activeFilters.subs && activeFilters.misc;
                activeFilters.all = allActive;
                const allBtn = document.querySelector('.filter-btn[data-filter="all"]');
                if (allBtn) allBtn.classList.toggle('active', allActive);
            }

            // Apply visibility to activity items
            if (activityContainer) {
                activityContainer.querySelectorAll('.activity-item').forEach(item => {
                    const cat = item.dataset.category;
                    item.style.display = (activeFilters.all || activeFilters[cat]) ? '' : 'none';
                });
            }
        });
    });
}


// ══════════════════════════════════════════════════════════════════════════════
//  INITIALIZE APP
// ══════════════════════════════════════════════════════════════════════════════

function initializeApp() {
    // Get DOM elements
    chatContainer = document.getElementById('chat-container');
    activityContainer = document.getElementById('activity-container');
    tickerTrack = document.getElementById('ticker-track');
    twitchChannelInput = document.getElementById('twitch-channel');
    tiktokUsernameInput = document.getElementById('tiktok-username');
    const tiktokApiKeyInput = document.getElementById('tiktok-api-key');
    youtubeVideoInput = document.getElementById('youtube-video');
    connectTwitchBtn = document.getElementById('connect-twitch');
    connectTiktokBtn = document.getElementById('connect-tiktok');
    connectYoutubeBtn = document.getElementById('connect-youtube');
    twitchStatus = document.getElementById('twitch-status');
    tiktokStatus = document.getElementById('tiktok-status');
    youtubeStatus = document.getElementById('youtube-status');
    guestsContainer = document.getElementById('guests-container');
    addGuestBtn = document.getElementById('add-guest-btn');

    // ── Panel system setup ───────────────────────────────────────────────
    restoreLayout();
    setupPanelCollapse();
    setupPanelDragDrop();
    setupActivityFilters();

    const resetLayoutBtn = document.getElementById('reset-layout-btn');
    if (resetLayoutBtn) resetLayoutBtn.addEventListener('click', resetLayout);

    // ── Load saved values from localStorage ──────────────────────────────
    const savedTwitchChannel = localStorage.getItem('twitchChannel');
    const savedTiktokUsername = localStorage.getItem('tiktokUsername');
    const savedTiktokApiKey = localStorage.getItem('tiktokApiKey');
    const savedYoutubeVideo = localStorage.getItem('youtubeVideo');

    if (savedTwitchChannel && twitchChannelInput) twitchChannelInput.value = savedTwitchChannel;
    if (savedTiktokUsername && tiktokUsernameInput) tiktokUsernameInput.value = savedTiktokUsername;
    if (savedTiktokApiKey && tiktokApiKeyInput) {
        tiktokApiKeyInput.value = savedTiktokApiKey;
        tiktokApiKey = savedTiktokApiKey;
    }

    // ── TikTok API key handlers ──────────────────────────────────────────
    const tiktokApiStatusEl = document.getElementById('tiktok-api-status');
    if (tiktokApiKeyInput) {
        tiktokApiKeyInput.addEventListener('input', () => {
            tiktokApiKey = tiktokApiKeyInput.value.trim();
            if (tiktokApiKey) {
                localStorage.setItem('tiktokApiKey', tiktokApiKey);
            } else {
                localStorage.removeItem('tiktokApiKey');
            }
            tiktokApiKeyInput.classList.remove('api-key-valid', 'api-key-invalid', 'api-key-testing');
            if (tiktokApiStatusEl) { tiktokApiStatusEl.textContent = ''; tiktokApiStatusEl.className = 'api-status'; }
        });
    }

    // Toggle API key visibility
    const tiktokApiToggleBtn = document.getElementById('tiktok-api-toggle');
    if (tiktokApiToggleBtn && tiktokApiKeyInput) {
        tiktokApiToggleBtn.addEventListener('click', () => {
            if (tiktokApiKeyInput.type === 'password') {
                tiktokApiKeyInput.type = 'text';
                tiktokApiToggleBtn.textContent = '🙈';
                tiktokApiToggleBtn.classList.add('showing');
            } else {
                tiktokApiKeyInput.type = 'password';
                tiktokApiToggleBtn.textContent = '👁️';
                tiktokApiToggleBtn.classList.remove('showing');
            }
        });
    }

    // Test API key button
    const tiktokApiTestBtn = document.getElementById('tiktok-api-test');
    if (tiktokApiTestBtn) {
        tiktokApiTestBtn.addEventListener('click', async () => {
            const key = tiktokApiKeyInput ? tiktokApiKeyInput.value.trim() : '';
            if (!key) {
                tiktokApiKeyInput.classList.remove('api-key-valid', 'api-key-testing');
                tiktokApiKeyInput.classList.add('api-key-invalid');
                if (tiktokApiStatusEl) { tiktokApiStatusEl.textContent = '✗ No API key entered'; tiktokApiStatusEl.className = 'api-status invalid'; }
                return;
            }

            tiktokApiTestBtn.disabled = true;
            tiktokApiTestBtn.textContent = '...';
            tiktokApiKeyInput.classList.remove('api-key-valid', 'api-key-invalid');
            tiktokApiKeyInput.classList.add('api-key-testing');
            if (tiktokApiStatusEl) { tiktokApiStatusEl.textContent = 'Testing...'; tiktokApiStatusEl.className = 'api-status testing'; }

            try {
                const response = await fetch(`https://tiktok.eulerstream.com/webcast/rate_limits?apiKey=${encodeURIComponent(key)}`);
                const data = await response.json();

                if (response.ok && data.day) {
                    tiktokApiKeyInput.classList.remove('api-key-testing', 'api-key-invalid');
                    tiktokApiKeyInput.classList.add('api-key-valid');
                    const remaining = `${data.day.remaining}/${data.day.max} daily`;
                    if (tiktokApiStatusEl) { tiktokApiStatusEl.textContent = `✓ Key accepted — ${remaining} requests remaining`; tiktokApiStatusEl.className = 'api-status valid'; }
                } else if (!response.ok) {
                    tiktokApiKeyInput.classList.remove('api-key-testing', 'api-key-valid');
                    tiktokApiKeyInput.classList.add('api-key-invalid');
                    if (tiktokApiStatusEl) { tiktokApiStatusEl.textContent = `✗ Invalid key: ${data.message || 'Rejected by server'}`; tiktokApiStatusEl.className = 'api-status invalid'; }
                } else {
                    tiktokApiKeyInput.classList.remove('api-key-testing', 'api-key-valid');
                    tiktokApiKeyInput.classList.add('api-key-invalid');
                    if (tiktokApiStatusEl) { tiktokApiStatusEl.textContent = '✗ Unexpected response from Euler API'; tiktokApiStatusEl.className = 'api-status invalid'; }
                }
            } catch (err) {
                tiktokApiKeyInput.classList.remove('api-key-testing', 'api-key-valid');
                tiktokApiKeyInput.classList.add('api-key-invalid');
                if (tiktokApiStatusEl) { tiktokApiStatusEl.textContent = `✗ Could not reach Euler API: ${err.message}`; tiktokApiStatusEl.className = 'api-status invalid'; }
            } finally {
                tiktokApiTestBtn.disabled = false;
                tiktokApiTestBtn.textContent = 'Test';
            }
        });
    }

    // Help button → opens Eulerstream pricing page
    const tiktokApiHelpBtn = document.getElementById('tiktok-api-help');
    if (tiktokApiHelpBtn) {
        tiktokApiHelpBtn.addEventListener('click', () => {
            window.purptea.openExternal('https://www.eulerstream.com/pricing');
        });
    }

    if (savedYoutubeVideo && youtubeVideoInput) youtubeVideoInput.value = savedYoutubeVideo;

    // ── Notification system ──────────────────────────────────────────────
    notificationSound = createNotificationSound();
    const notificationCheckbox = document.getElementById('notification-enabled');
    const cooldownInput = document.getElementById('notification-cooldown');
    const volumeSlider = document.getElementById('notification-volume');

    if (notificationCheckbox) {
        notificationEnabled = notificationCheckbox.checked;
        notificationCheckbox.addEventListener('change', (e) => { notificationEnabled = e.target.checked; });
    }
    if (cooldownInput) {
        notificationCooldown = parseInt(cooldownInput.value) * 1000;
        cooldownInput.addEventListener('change', (e) => { notificationCooldown = parseInt(e.target.value) * 1000; });
    }
    if (volumeSlider) {
        const volumeDisplay = document.getElementById('volume-display');
        volumeSlider.value = notificationVolume * 100;
        volumeSlider.addEventListener('input', (e) => {
            notificationVolume = parseInt(e.target.value) / 100;
            if (volumeDisplay) volumeDisplay.textContent = `${e.target.value}%`;
        });
    }

    // ── Pop-out overlay button ───────────────────────────────────────────
    const popOutBtn = document.getElementById('pop-out-btn');
    if (popOutBtn) {
        popOutBtn.addEventListener('click', () => {
            if (!overlayActive) {
                window.purptea.openOverlay();
                overlayActive = true;
                popOutBtn.classList.add('active');
                popOutBtn.textContent = '✓';
                popOutBtn.title = 'Close Pop Out';
                chatContainer.classList.add('hidden');
                const chatPanel = document.getElementById('panel-chat');
                if (chatPanel) chatPanel.classList.add('collapsed');
                const configPanel = document.getElementById('panel-config');
                if (configPanel) configPanel.classList.add('collapsed');
            } else {
                window.purptea.closeOverlay();
                overlayActive = false;
                popOutBtn.classList.remove('active');
                popOutBtn.textContent = '⤴';
                popOutBtn.title = 'Pop Out Chat';
                chatContainer.classList.remove('hidden');
                const chatPanel = document.getElementById('panel-chat');
                if (chatPanel) chatPanel.classList.remove('collapsed');
                const configPanel = document.getElementById('panel-config');
                if (configPanel) configPanel.classList.remove('collapsed');
            }
        });
    }

    // ── Set up all IPC event listeners ───────────────────────────────────
    setupIpcListeners();

    // ── Chat Input Panel ─────────────────────────────────────────────────
    const chatInputField = document.getElementById('chat-input-field');
    const chatSendBtn = document.getElementById('chat-send-btn');
    const chatInputStatus = document.getElementById('chat-input-status');
    const chatChannelSelect = document.getElementById('chat-channel-select');

    /**
     * Rebuild the channel dropdown based on current connections.
     * Options: main Twitch channel, each connected Twitch guest, "All Channels".
     */
    function rebuildChannelDropdown() {
        if (!chatChannelSelect) return;
        const token = localStorage.getItem('twitch_access_token');
        const username = localStorage.getItem('twitch_username');
        const mainChannel = twitchChannelInput ? twitchChannelInput.value.trim() : '';

        chatChannelSelect.innerHTML = '';

        // Collect available channels
        const channels = [];

        if (token && username && mainChannel && twitchConnected) {
            channels.push({ value: `main:${mainChannel}`, label: `#${mainChannel} (main)` });
        }

        // Add connected Twitch guests
        guests.forEach(g => {
            if (g.platform === 'twitch' && g.connected) {
                channels.push({ value: `guest:${g.id}:${g.username}`, label: `#${g.username} (${g.name})` });
            }
        });

        if (channels.length === 0) {
            const opt = document.createElement('option');
            opt.value = '';
            opt.disabled = true;
            opt.selected = true;
            opt.textContent = token ? 'Connect to a Twitch channel first' : 'Log in & connect to Twitch';
            chatChannelSelect.appendChild(opt);
            chatChannelSelect.disabled = true;
            if (chatInputField) chatInputField.disabled = true;
            if (chatSendBtn) chatSendBtn.disabled = true;
            if (chatInputStatus) {
                chatInputStatus.textContent = token ? 'Connect to a Twitch channel first' : 'Log in to Twitch to send messages';
                chatInputStatus.className = 'chat-input-status';
            }
            return;
        }

        // Add "All Channels" if more than one
        if (channels.length > 1) {
            const allOpt = document.createElement('option');
            allOpt.value = 'all';
            allOpt.textContent = `📢 All Channels (${channels.length})`;
            chatChannelSelect.appendChild(allOpt);
        }

        // Add individual channels
        channels.forEach(ch => {
            const opt = document.createElement('option');
            opt.value = ch.value;
            opt.textContent = ch.label;
            chatChannelSelect.appendChild(opt);
        });

        // Select first option (All if multiple, or the single channel)
        chatChannelSelect.selectedIndex = 0;
        chatChannelSelect.disabled = false;
        if (chatInputField) chatInputField.disabled = false;
        if (chatSendBtn) chatSendBtn.disabled = false;

        updateChatInputStatusText();
    }

    function updateChatInputStatusText() {
        if (!chatInputStatus || !chatChannelSelect) return;
        const username = localStorage.getItem('twitch_username');
        const selected = chatChannelSelect.value;
        if (!selected || !username) return;

        if (selected === 'all') {
            chatInputStatus.textContent = `Sending as ${username} to all channels`;
            chatInputStatus.className = 'chat-input-status success';
        } else {
            const channelName = selected.includes(':') ? selected.split(':').pop() : selected;
            chatInputStatus.textContent = `Sending as ${username} to #${channelName}`;
            chatInputStatus.className = 'chat-input-status success';
        }
    }

    if (chatChannelSelect) {
        chatChannelSelect.addEventListener('change', updateChatInputStatusText);
    }

    function updateChatInputState() {
        rebuildChannelDropdown();
    }

    async function sendChatMessage() {
        if (!chatInputField || !chatInputField.value.trim()) return;
        if (!chatChannelSelect || chatChannelSelect.disabled) return;

        const message = chatInputField.value.trim();
        const token = localStorage.getItem('twitch_access_token');
        const username = localStorage.getItem('twitch_username');
        const selected = chatChannelSelect.value;

        if (!token || !username || !selected) {
            if (chatInputStatus) {
                chatInputStatus.textContent = 'Not connected — log in and connect to Twitch first';
                chatInputStatus.className = 'chat-input-status error';
            }
            return;
        }

        chatInputField.disabled = true;
        chatSendBtn.disabled = true;

        try {
            // Build list of channels to send to
            const targets = [];
            if (selected === 'all') {
                // Send to all channels in the dropdown
                Array.from(chatChannelSelect.options).forEach(opt => {
                    if (opt.value && opt.value !== 'all' && !opt.disabled) {
                        targets.push(opt.value);
                    }
                });
            } else {
                targets.push(selected);
            }

            const results = await Promise.allSettled(targets.map(target => {
                const channel = target.split(':').pop();
                return window.purptea.sendTwitchMessage(channel, message, token, username);
            }));

            const failures = results.filter(r => r.status === 'rejected' || (r.status === 'fulfilled' && !r.value.success));

            if (failures.length === 0) {
                chatInputField.value = '';
                updateChatInputStatusText();
            } else if (failures.length < targets.length) {
                chatInputField.value = '';
                if (chatInputStatus) {
                    chatInputStatus.textContent = `Sent to ${targets.length - failures.length}/${targets.length} channels`;
                    chatInputStatus.className = 'chat-input-status';
                }
            } else {
                const errMsg = failures[0].status === 'fulfilled' ? failures[0].value.error : failures[0].reason;
                if (chatInputStatus) {
                    chatInputStatus.textContent = errMsg || 'Failed to send';
                    chatInputStatus.className = 'chat-input-status error';
                }
            }
        } catch (err) {
            if (chatInputStatus) {
                chatInputStatus.textContent = err.message || 'Failed to send';
                chatInputStatus.className = 'chat-input-status error';
            }
        }

        chatInputField.disabled = false;
        chatSendBtn.disabled = false;
        chatInputField.focus();
    }

    if (chatSendBtn) chatSendBtn.addEventListener('click', sendChatMessage);
    if (chatInputField) {
        chatInputField.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendChatMessage();
            }
        });
    }

    // Update chat input state when connections change
    window._updateChatInputState = updateChatInputState;
    updateChatInputState();

    // ── Connect buttons ──────────────────────────────────────────────────
    if (connectTwitchBtn) connectTwitchBtn.addEventListener('click', handleTwitchConnect);
    if (connectTiktokBtn) connectTiktokBtn.addEventListener('click', handleTiktokConnect);
    if (connectYoutubeBtn) connectYoutubeBtn.addEventListener('click', handleYoutubeConnect);

    // ── Twitch auth buttons ──────────────────────────────────────────────
    const twitchLoginBtn = document.getElementById('twitch-login-btn');
    const twitchLogoutBtn = document.getElementById('twitch-logout-btn');
    const createClipBtn = document.getElementById('create-clip-btn');
    if (twitchLoginBtn) twitchLoginBtn.addEventListener('click', startTwitchAuth);
    if (twitchLogoutBtn) twitchLogoutBtn.addEventListener('click', logoutTwitch);
    if (createClipBtn) createClipBtn.addEventListener('click', createClip);

    const masterClipBtn = document.getElementById('master-clip-btn');
    if (masterClipBtn) masterClipBtn.addEventListener('click', createMasterClip);

    // ── Restore Twitch auth from localStorage ────────────────────────────
    const savedToken = localStorage.getItem('twitch_access_token');
    const savedUsername = localStorage.getItem('twitch_username');
    const savedUserId = localStorage.getItem('twitch_user_id');
    const savedBroadcasterId = localStorage.getItem('twitch_broadcaster_id');

    if (savedToken && savedUsername) {
        twitchAccessToken = savedToken;
        twitchUsername = savedUsername;
        twitchUserId = savedUserId;
        twitchBroadcasterId = savedBroadcasterId;
        if (savedUserId) connectTwitchPubSub(savedUserId, savedToken);
        setTimeout(() => { updateTwitchAuthUI(true); }, 100);
    }

    // ── Add guest button ─────────────────────────────────────────────────
    if (addGuestBtn) addGuestBtn.addEventListener('click', showAddGuestDialog);

    // ── Guest modal ──────────────────────────────────────────────────────
    const modalClose = document.querySelector('.modal-close');
    const modalBackBtn = document.getElementById('modal-back');
    const modalAddBtn = document.getElementById('modal-add');
    const modal = document.getElementById('guest-modal');

    if (modalClose) modalClose.addEventListener('click', hideGuestModal);
    modal.addEventListener('click', (e) => { if (e.target === modal) hideGuestModal(); });

    const platformBtns = document.querySelectorAll('.modal-btn[data-platform]');
    platformBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            selectedPlatform = btn.getAttribute('data-platform');
            const label = document.getElementById('modal-platform-label');
            const inputPlaceholder = document.getElementById('modal-username-input');
            if (selectedPlatform === 'twitch') { label.textContent = 'Enter Twitch channel:'; inputPlaceholder.placeholder = 'Channel name'; }
            else if (selectedPlatform === 'tiktok') { label.textContent = 'Enter TikTok username:'; inputPlaceholder.placeholder = 'Username'; }
            else if (selectedPlatform === 'youtube') { label.textContent = 'Enter YouTube video ID or URL:'; inputPlaceholder.placeholder = 'Video ID or URL'; }
            document.getElementById('modal-step-1').style.display = 'none';
            document.getElementById('modal-step-2').style.display = 'block';
            document.getElementById('modal-username-input').focus();
        });
    });

    if (modalBackBtn) {
        modalBackBtn.addEventListener('click', () => {
            document.getElementById('modal-step-1').style.display = 'block';
            document.getElementById('modal-step-2').style.display = 'none';
        });
    }
    if (modalAddBtn) modalAddBtn.addEventListener('click', addGuestFromModal);

    const usernameInput = document.getElementById('modal-username-input');
    if (usernameInput) {
        usernameInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') addGuestFromModal(); });
    }

    // ── Moderation context menu ──────────────────────────────────────────
    const modContextMenu = document.getElementById('mod-context-menu');
    let currentTargetMessage = null;

    chatContainer.addEventListener('contextmenu', (e) => {
        const messageElement = e.target.closest('.chat-message.twitch');
        if (messageElement && messageElement.dataset.messageId) {
            e.preventDefault();
            if (!twitchAccessToken) return;
            currentTargetMessage = messageElement;
            modContextMenu.style.display = 'block';
            modContextMenu.style.left = e.pageX + 'px';
            modContextMenu.style.top = e.pageY + 'px';
            const menuRect = modContextMenu.getBoundingClientRect();
            if (menuRect.bottom > window.innerHeight) modContextMenu.style.top = (e.pageY - menuRect.height) + 'px';
            if (menuRect.right > window.innerWidth) modContextMenu.style.left = (e.pageX - menuRect.width) + 'px';
        }
    });

    document.addEventListener('click', (e) => {
        if (!e.target.closest('#mod-context-menu')) {
            modContextMenu.style.display = 'none';
            currentTargetMessage = null;
        }
    });

    modContextMenu.addEventListener('click', async (e) => {
        const menuItem = e.target.closest('.mod-menu-item');
        if (!menuItem || !currentTargetMessage) return;

        const action = menuItem.dataset.action;
        const messageId = currentTargetMessage.dataset.messageId;
        const userId = currentTargetMessage.dataset.userId;
        const username = currentTargetMessage.dataset.username;
        modContextMenu.style.display = 'none';

        let success = false;
        switch (action) {
            case 'delete':
                success = await deleteTwitchMessage(messageId);
                if (success) {
                    currentTargetMessage.style.opacity = '0.3';
                    currentTargetMessage.style.textDecoration = 'line-through';
                    routeMessage('twitch', '🗑️ System', `Message from ${username} deleted`, null, null, '#ff9900');
                }
                break;
            case 'timeout-1m':
                success = await timeoutTwitchUser(userId, 60);
                if (success) routeMessage('twitch', '⏱️ System', `${username} timed out for 1 minute`, null, null, '#ff9900');
                break;
            case 'timeout-10m':
                success = await timeoutTwitchUser(userId, 600);
                if (success) routeMessage('twitch', '⏱️ System', `${username} timed out for 10 minutes`, null, null, '#ff9900');
                break;
            case 'timeout-1h':
                success = await timeoutTwitchUser(userId, 3600);
                if (success) routeMessage('twitch', '⏱️ System', `${username} timed out for 1 hour`, null, null, '#ff9900');
                break;
            case 'timeout-24h':
                success = await timeoutTwitchUser(userId, 86400);
                if (success) routeMessage('twitch', '⏱️ System', `${username} timed out for 24 hours`, null, null, '#ff9900');
                break;
            case 'ban':
                if (confirm(`Are you sure you want to permanently ban ${username}?`)) {
                    success = await banTwitchUser(userId);
                    if (success) routeMessage('twitch', '🔨 System', `${username} has been banned`, null, null, '#ff4444');
                } else {
                    routeMessage('twitch', 'System', 'Ban cancelled', null, null, '#888888');
                    success = true;
                }
                break;
        }

        if (!success && action) {
            routeMessage('twitch', '❌ System', `Failed to ${action} - make sure you are a mod for this channel`, null, null, '#ff4444');
        }
        currentTargetMessage = null;
    });
}

// ── DOM ready ────────────────────────────────────────────────────────────
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeApp);
} else {
    initializeApp();
}
