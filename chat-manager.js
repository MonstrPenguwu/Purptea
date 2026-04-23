/**
 * ChatManager — Main process module that owns all chat library connections.
 *
 * tmi.js (Twitch), tiktok-live-connector (TikTok), and masterchat (YouTube)
 * all run here. Messages & status updates are forwarded to the renderer
 * via webContents.send().
 */

const tmi = require('tmi.js');
const { TikTokLiveConnection } = require('tiktok-live-connector');
const { Masterchat } = require('masterchat');

// ── Constants ────────────────────────────────────────────────────────────────
const TIKTOK_RECONNECT_MAX_ATTEMPTS = 10;
const TIKTOK_RECONNECT_BASE_DELAY = 3000;   // 3 seconds
const TIKTOK_RECONNECT_MAX_DELAY = 60000;   // 60 seconds cap
const TIKTOK_LIKE_COOLDOWN = 5 * 60 * 1000; // 5 min per user

// ── Helper ───────────────────────────────────────────────────────────────────
function reconnectDelay(attempts) {
    return Math.min(TIKTOK_RECONNECT_BASE_DELAY * Math.pow(2, attempts), TIKTOK_RECONNECT_MAX_DELAY);
}

/** Extract display name from raw protobuf or legacy simplified TikTok data */
function tiktokDisplayName(data) {
    return data.user?.nickname || data.user?.uniqueId || data.nickname || data.uniqueId || 'Unknown';
}

/** Extract uid from raw protobuf or legacy simplified TikTok data */
function tiktokUid(data) {
    return data.user?.uniqueId || data.user?.userId || data.uniqueId || data.userId;
}

/** Extract comment text from various TikTok protobuf structures */
function tiktokComment(data) {
    return data.comment || data.data?.comment || data.text || data.message || data.content || '';
}

/** Normalize TikTok emotes from raw protobuf to renderer-friendly format */
function normalizeTiktokEmotes(emotes) {
    if (!Array.isArray(emotes) || emotes.length === 0) return null;
    return emotes.map(e => ({
        emoteId: e.emote?.emoteId || e.emoteId || '',
        image: { imageUrl: e.emote?.image?.imageUrl || e.emoteImageUrl || '' },
        position: e.placeInComment || 0
    }));
}

// Guest color palette
const GUEST_COLORS = [
    '#9146ff', '#e91916', '#1e90ff', '#ff6b6b', '#4ecdc4',
    '#45b7d1', '#f9ca24', '#6c5ce7', '#fd79a8', '#00b894',
    '#e17055', '#0984e3', '#fdcb6e', '#d63031', '#00cec9'
];

class ChatManager {
    constructor() {
        /** @type {Electron.BrowserWindow | null} */
        this.mainWindow = null;

        // ── Main connections ─────────────────────────────────
        this.twitchClient = null;
        this.tiktokConnection = null;
        this.youtubeChat = null;

        // ── TikTok reconnect state ──────────────────────────
        this.tiktokReconnectTimer = null;
        this.tiktokReconnectAttempts = 0;
        this.tiktokManualDisconnect = false;
        this.tiktokUsername = null;
        this.tiktokApiKey = null;

        // ── TikTok like cooldown ────────────────────────────
        this.tiktokLikeTracker = new Map();

        // ── Guest management ────────────────────────────────
        this.guests = [];
        this.nextGuestId = 1;
    }

    // ──────────────────────────────────────────────────────────────────────────
    //  Window binding
    // ──────────────────────────────────────────────────────────────────────────
    setMainWindow(win) {
        this.mainWindow = win;
    }

    /** Safely send IPC to renderer */
    send(channel, data) {
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
            this.mainWindow.webContents.send(channel, data);
        }
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  TWITCH
    // ══════════════════════════════════════════════════════════════════════════

    async connectTwitch(channel) {
        // Disconnect existing client first
        if (this.twitchClient) {
            try { this.twitchClient.disconnect(); } catch (e) { /* ignore */ }
            this.twitchClient = null;
        }

        this.twitchClient = new tmi.Client({ channels: [channel] });

        this._attachTwitchHandlers(this.twitchClient, null);

        try {
            await this.twitchClient.connect();
            this.send('chat:status', { platform: 'twitch', status: 'connected', message: `Connected to ${channel}`, guestId: null });
            this.send('chat:message', { platform: 'twitch', username: 'System', message: `Connected to ${channel}'s chat`, guestId: null, guestName: null, guestColor: null, color: null, emotes: null, messageId: null, userId: null });
            return { success: true };
        } catch (err) {
            this.twitchClient = null;
            this.send('chat:status', { platform: 'twitch', status: 'error', message: 'Connection Failed', guestId: null });
            return { success: false, error: err.message };
        }
    }

    async disconnectTwitch() {
        if (this.twitchClient) {
            try { this.twitchClient.disconnect(); } catch (e) { /* ignore */ }
            this.twitchClient = null;
        }
        this.send('chat:status', { platform: 'twitch', status: 'disconnected', message: 'Disconnected', guestId: null });
        this.send('chat:message', { platform: 'twitch', username: 'System', message: 'Disconnected from Twitch chat', guestId: null, guestName: null, guestColor: null, color: null, emotes: null, messageId: null, userId: null });
        return { success: true };
    }

    /** Attach all Twitch event handlers */
    _attachTwitchHandlers(client, guestId, guestName = null, guestColor = null) {
        client.on('message', (_channel, tags, message, self) => {
            if (self) return;
            this.send('chat:message', {
                platform: 'twitch',
                username: tags['display-name'] || tags.username,
                message,
                color: tags.color || null,
                emotes: tags.emotes || null,
                messageId: tags['id'] || null,
                userId: tags['user-id'] || null,
                guestId,
                guestName,
                guestColor
            });
        });

        client.on('subscription', (_ch, username, method) => {
            const tier = method.plan === 'Prime' ? 'Prime' : `Tier ${method.plan.charAt(0)}`;
            this.send('chat:message', {
                platform: 'twitch', username: '⭐ System',
                message: `${username} subscribed with ${tier}!`,
                color: '#9146ff', emotes: null, messageId: null, userId: null,
                guestId, guestName, guestColor
            });
        });

        client.on('resub', (_ch, username, months, _msg, _us, methods) => {
            const tier = methods.plan === 'Prime' ? 'Prime' : `Tier ${methods.plan.charAt(0)}`;
            this.send('chat:message', {
                platform: 'twitch', username: '⭐ System',
                message: `${username} resubscribed for ${months} months (${tier})!`,
                color: '#9146ff', emotes: null, messageId: null, userId: null,
                guestId, guestName, guestColor
            });
        });

        client.on('subgift', (_ch, username, _streak, recipient, methods) => {
            const tier = methods.plan === 'Prime' ? 'Prime' : `Tier ${methods.plan.charAt(0)}`;
            this.send('chat:message', {
                platform: 'twitch', username: '🎁 System',
                message: `${username} gifted a ${tier} sub to ${recipient}!`,
                color: '#9146ff', emotes: null, messageId: null, userId: null,
                guestId, guestName, guestColor
            });
        });

        client.on('submysterygift', (_ch, username, numbOfSubs, methods) => {
            const tier = methods.plan === 'Prime' ? 'Prime' : `Tier ${methods.plan.charAt(0)}`;
            this.send('chat:message', {
                platform: 'twitch', username: '🎁 System',
                message: `${username} is gifting ${numbOfSubs} ${tier} subs to the community!`,
                color: '#9146ff', emotes: null, messageId: null, userId: null,
                guestId, guestName, guestColor
            });
        });

        client.on('cheer', (_ch, userstate, message) => {
            const username = userstate['display-name'] || userstate.username;
            const bits = userstate.bits;
            this.send('chat:message', {
                platform: 'twitch', username: '💎 System',
                message: `${username} cheered ${bits} bits!`,
                color: '#9146ff', emotes: null, messageId: null, userId: null,
                guestId, guestName, guestColor
            });
        });

        client.on('raided', (_ch, username, viewers) => {
            this.send('chat:message', {
                platform: 'twitch', username: '🚀 System',
                message: `${username} raided with ${viewers} viewers!`,
                color: '#9146ff', emotes: null, messageId: null, userId: null,
                guestId, guestName, guestColor
            });
        });

        client.on('disconnected', () => {
            this.send('chat:status', {
                platform: 'twitch',
                status: 'disconnected',
                message: 'Twitch: Disconnected',
                guestId
            });
        });
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  TIKTOK
    // ══════════════════════════════════════════════════════════════════════════

    async connectTiktok(username, apiKey) {
        // Clean up existing
        if (this.tiktokConnection) {
            try { this.tiktokConnection.disconnect(); } catch (e) { /* ignore */ }
            this.tiktokConnection = null;
        }

        this.tiktokManualDisconnect = false;
        this.tiktokReconnectAttempts = 0;
        this._clearTiktokReconnect();
        this.tiktokLikeTracker.clear();
        this.tiktokUsername = username;
        this.tiktokApiKey = apiKey || null;

        const opts = {
            processInitialData: false,
            enableExtendedGiftInfo: true,
            requestPollingIntervalMs: 1000
        };
        if (this.tiktokApiKey) opts.signApiKey = this.tiktokApiKey;

        this.tiktokConnection = new TikTokLiveConnection(username, opts);
        this._attachTiktokHandlers(this.tiktokConnection, username, null, null, null);

        try {
            const state = await this.tiktokConnection.connect();
            console.log('TikTok connection successful:', state);
            this.send('chat:status', { platform: 'tiktok', status: 'connected', message: `Connected to @${username}`, guestId: null });
            this.send('chat:message', { platform: 'tiktok', username: 'System', message: `Connected to @${username}'s live stream`, guestId: null, guestName: null, guestColor: null, color: null, emotes: null, messageId: null, userId: null });
            return { success: true };
        } catch (err) {
            console.error('TikTok connection error:', err);
            this.tiktokConnection = null;
            this.send('chat:status', { platform: 'tiktok', status: 'error', message: 'Connection Failed', guestId: null });
            return { success: false, error: err.message };
        }
    }

    async disconnectTiktok() {
        this.tiktokManualDisconnect = true;
        this._clearTiktokReconnect();
        if (this.tiktokConnection) {
            try { this.tiktokConnection.disconnect(); } catch (e) { /* ignore */ }
            this.tiktokConnection = null;
        }
        this.tiktokLikeTracker.clear();
        this.send('chat:status', { platform: 'tiktok', status: 'disconnected', message: 'Disconnected', guestId: null });
        this.send('chat:message', { platform: 'tiktok', username: 'System', message: 'Disconnected from TikTok chat', guestId: null, guestName: null, guestColor: null, color: null, emotes: null, messageId: null, userId: null });
        return { success: true };
    }

    /** Attach TikTok event handlers (works for main or guest connections) */
    _attachTiktokHandlers(connection, username, guestId, guestName, guestColor) {
        connection.on('chat', (data) => {
            try {
                const displayName = tiktokDisplayName(data);
                const comment = tiktokComment(data);
                if (!comment && comment !== '') {
                    console.warn('TikTok chat: empty comment from', displayName, '— raw keys:', Object.keys(data).join(', '));
                }
                this.send('chat:message', {
                    platform: 'tiktok',
                    username: displayName,
                    message: comment,
                    color: null,
                    emotes: normalizeTiktokEmotes(data.emotes),
                    messageId: null,
                    userId: null,
                    guestId,
                    guestName,
                    guestColor
                });
            } catch (err) {
                console.error('TikTok chat handler error:', err, 'data keys:', data ? Object.keys(data).join(', ') : 'null');
            }
        });

        // Handle emote chat messages (separate protobuf type from regular chat)
        connection.on('emote', (data) => {
            try {
                const displayName = tiktokDisplayName(data);
                const comment = tiktokComment(data) || data.emote?.emoteId || '[emote]';
                this.send('chat:message', {
                    platform: 'tiktok',
                    username: displayName,
                    message: comment,
                    color: null,
                    emotes: normalizeTiktokEmotes(data.emotes),
                    messageId: null,
                    userId: null,
                    guestId,
                    guestName,
                    guestColor
                });
            } catch (err) {
                console.error('TikTok emote handler error:', err);
            }
        });

        connection.on('member', (data) => {
            const displayName = tiktokDisplayName(data);
            this.send('chat:message', {
                platform: 'tiktok', username: '👋 System',
                message: `${displayName} joined the live!`,
                color: '#000000', emotes: null, messageId: null, userId: null,
                guestId, guestName, guestColor
            });
        });

        connection.on('follow', (data) => {
            const displayName = tiktokDisplayName(data);
            this.send('chat:message', {
                platform: 'tiktok', username: '❤️ System',
                message: `${displayName} followed!`,
                color: '#000000', emotes: null, messageId: null, userId: null,
                guestId, guestName, guestColor
            });
        });

        connection.on('share', (data) => {
            const displayName = tiktokDisplayName(data);
            this.send('chat:message', {
                platform: 'tiktok', username: '📤 System',
                message: `${displayName} shared the stream!`,
                color: '#000000', emotes: null, messageId: null, userId: null,
                guestId, guestName, guestColor
            });
        });

        connection.on('like', (data) => {
            const uid = tiktokUid(data);
            const displayName = tiktokDisplayName(data);
            const now = Date.now();
            const last = this.tiktokLikeTracker.get(uid) || 0;
            if (now - last >= TIKTOK_LIKE_COOLDOWN) {
                this.tiktokLikeTracker.set(uid, now);
                this.send('chat:message', {
                    platform: 'tiktok', username: '👍 System',
                    message: `${displayName} liked the live!`,
                    color: '#000000', emotes: null, messageId: null, userId: null,
                    guestId, guestName, guestColor
                });
            }
        });

        connection.on('gift', (data) => {
            const displayName = tiktokDisplayName(data);
            const giftType = data.giftType ?? data.giftDetails?.giftType ?? data.gift?.gift_type;
            const repeatEnd = data.repeatEnd ?? false;
            if (giftType !== 1 || repeatEnd) {
                const giftName = data.giftName || data.giftDetails?.giftName || data.extendedGiftInfo?.name || 'a gift';
                const repeatCount = data.repeatCount ?? data.gift?.repeat_count ?? 1;
                const giftInfo = repeatCount > 1 ? `${giftName} x${repeatCount}` : giftName;
                this.send('chat:message', {
                    platform: 'tiktok', username: '🎁 System',
                    message: `${displayName} sent ${giftInfo}!`,
                    color: '#000000', emotes: null, messageId: null, userId: null,
                    guestId, guestName, guestColor
                });
            }
        });

        connection.on('roomUser', (data) => {
            if (data.viewerCount) {
                this.send('chat:viewer-update', {
                    platform: 'tiktok',
                    count: data.viewerCount,
                    guestId
                });
            }
        });

        connection.on('streamEnd', () => {
            console.log(`TikTok stream ended for @${username}`);
            // Stream ended intentionally — do NOT auto-reconnect
            if (guestId !== null) {
                const guest = this.guests.find(g => g.id === guestId);
                if (guest) guest.manualDisconnect = true;
                this.send('guest:status', { guestId, status: 'stream-ended', message: 'Stream Ended' });
            } else {
                this.tiktokManualDisconnect = true;
                this._clearTiktokReconnect();
                this.tiktokConnection = null;
            }
            this.send('chat:status', { platform: 'tiktok', status: 'stream-ended', message: 'Stream Ended', guestId });
            this.send('chat:message', {
                platform: 'tiktok', username: '📺 System',
                message: `@${username}'s stream has ended.`,
                color: null, emotes: null, messageId: null, userId: null,
                guestId, guestName, guestColor
            });
        });

        connection.on('error', (err) => {
            console.error(`TikTok error (${guestId ? 'guest ' + guestId : 'main'}):`, err?.info || err?.exception || err);
        });

        // Safety net: log any message decoding issues to help diagnose missing messages
        connection.on('decodedData', (type, data) => {
            if (type === 'WebcastChatMessage') {
                const comment = data?.comment || data?.data?.comment || data?.text || data?.message || data?.content;
                const name = data?.user?.nickname || data?.user?.uniqueId || 'unknown';
                if (!comment) {
                    console.warn('TikTok decodedData: WebcastChatMessage with no comment from', name, '— keys:', data ? Object.keys(data).join(', ') : 'null');
                }
            }
        });

        // Catch-all: log protobuf message types we might be missing
        connection.on('rawData', (msgType, binary) => {
            // Log unexpected message types for diagnosis (not all types are chat)
            const knownTypes = [
                'WebcastChatMessage', 'WebcastMemberMessage', 'WebcastGiftMessage',
                'WebcastSocialMessage', 'WebcastLikeMessage', 'WebcastRoomUserSeqMessage',
                'WebcastControlMessage', 'WebcastLinkMicBattle', 'WebcastLinkMicArmies',
                'WebcastSubNotifyMessage', 'WebcastEmoteChatMessage'
            ];
            if (!knownTypes.includes(msgType)) {
                console.log(`TikTok rawData: unhandled type "${msgType}" (${binary?.length || 0} bytes)`);
            }
        });

        connection.on('disconnected', () => {
            console.log(`TikTok disconnected (${guestId ? 'guest ' + guestId : 'main'})`);
            if (guestId !== null) {
                const guest = this.guests.find(g => g.id === guestId);
                if (guest && !guest.manualDisconnect) {
                    this._attemptGuestTiktokReconnect(guest, username);
                } else {
                    this.send('guest:status', { guestId, status: 'disconnected', message: 'Disconnected' });
                }
            } else {
                if (!this.tiktokManualDisconnect && this.tiktokConnection) {
                    this._attemptTiktokReconnect(username);
                } else {
                    this.send('chat:status', { platform: 'tiktok', status: 'disconnected', message: 'Disconnected', guestId: null });
                }
            }
        });
    }

    // ── TikTok auto-reconnect (main) ────────────────────────────────────────

    _clearTiktokReconnect() {
        if (this.tiktokReconnectTimer) {
            clearTimeout(this.tiktokReconnectTimer);
            this.tiktokReconnectTimer = null;
        }
        this.tiktokReconnectAttempts = 0;
    }

    _attemptTiktokReconnect(username) {
        if (this.tiktokManualDisconnect) return;
        if (this.tiktokReconnectAttempts >= TIKTOK_RECONNECT_MAX_ATTEMPTS) {
            this.send('chat:message', {
                platform: 'tiktok', username: '⚠️ System',
                message: `Auto-reconnect failed after ${TIKTOK_RECONNECT_MAX_ATTEMPTS} attempts. Please reconnect manually.`,
                color: null, emotes: null, messageId: null, userId: null,
                guestId: null, guestName: null, guestColor: null
            });
            this.send('chat:status', { platform: 'tiktok', status: 'error', message: 'Reconnect Failed', guestId: null });
            this.tiktokConnection = null;
            this._clearTiktokReconnect();
            return;
        }

        const delay = reconnectDelay(this.tiktokReconnectAttempts);
        const attemptNum = this.tiktokReconnectAttempts + 1;
        const delaySec = Math.round(delay / 1000);

        this.send('chat:status', { platform: 'tiktok', status: 'reconnecting', message: `Reconnecting (${attemptNum}/${TIKTOK_RECONNECT_MAX_ATTEMPTS}) in ${delaySec}s...`, guestId: null });
        this.send('chat:message', {
            platform: 'tiktok', username: '🔄 System',
            message: `Connection lost. Reconnecting in ${delaySec}s... (attempt ${attemptNum}/${TIKTOK_RECONNECT_MAX_ATTEMPTS})`,
            color: null, emotes: null, messageId: null, userId: null,
            guestId: null, guestName: null, guestColor: null
        });

        this.tiktokReconnectTimer = setTimeout(() => {
            if (this.tiktokManualDisconnect) return;
            this.tiktokReconnectAttempts++;

            const opts = {
                processInitialData: false,
                enableExtendedGiftInfo: true,
                requestPollingIntervalMs: 1000
            };
            if (this.tiktokApiKey) opts.signApiKey = this.tiktokApiKey;

            // Clean up old connection
            if (this.tiktokConnection) {
                try { this.tiktokConnection.disconnect(); } catch (e) { /* ignore */ }
            }

            this.tiktokConnection = new TikTokLiveConnection(username, opts);
            this._attachTiktokHandlers(this.tiktokConnection, username, null, null, null);

            this.tiktokConnection.connect().then(() => {
                this.tiktokReconnectAttempts = 0;
                this.send('chat:status', { platform: 'tiktok', status: 'connected', message: `Connected to @${username}`, guestId: null });
                this.send('chat:message', {
                    platform: 'tiktok', username: '✅ System',
                    message: `Reconnected to @${username}'s live stream`,
                    color: null, emotes: null, messageId: null, userId: null,
                    guestId: null, guestName: null, guestColor: null
                });
            }).catch(() => {
                this._attemptTiktokReconnect(username);
            });
        }, delay);
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  YOUTUBE
    // ══════════════════════════════════════════════════════════════════════════

    async connectYoutube(videoId) {
        if (this.youtubeChat) {
            try { this.youtubeChat.stop(); } catch (e) { /* ignore */ }
            this.youtubeChat = null;
        }

        try {
            this.youtubeChat = await Masterchat.init(videoId);

            const channelName = this.youtubeChat.metadata?.channelName || this.youtubeChat.channelName || 'YouTube Channel';
            const videoTitle = this.youtubeChat.metadata?.title || this.youtubeChat.title || 'Live Stream';

            this._attachYoutubeHandlers(this.youtubeChat, null, null, null);

            this.send('chat:status', { platform: 'youtube', status: 'connected', message: `Connected to ${channelName}`, guestId: null, channelName, videoTitle });
            this.send('chat:message', {
                platform: 'youtube', username: 'System',
                message: `Connected to ${channelName} - ${videoTitle}`,
                color: null, emotes: null, messageId: null, userId: null,
                guestId: null, guestName: null, guestColor: null
            });

            this.youtubeChat.listen();
            return { success: true, channelName, videoTitle };
        } catch (err) {
            console.error('YouTube connection error:', err);
            this.youtubeChat = null;
            this.send('chat:status', { platform: 'youtube', status: 'error', message: 'Connection Failed', guestId: null });
            return { success: false, error: err.message };
        }
    }

    async disconnectYoutube() {
        if (this.youtubeChat) {
            try { this.youtubeChat.stop(); } catch (e) { /* ignore */ }
            this.youtubeChat = null;
        }
        this.send('chat:status', { platform: 'youtube', status: 'disconnected', message: 'Disconnected', guestId: null });
        this.send('chat:message', {
            platform: 'youtube', username: 'System',
            message: 'Disconnected from YouTube chat',
            color: null, emotes: null, messageId: null, userId: null,
            guestId: null, guestName: null, guestColor: null
        });
        return { success: true };
    }

    /** Attach YouTube chat event handlers */
    _attachYoutubeHandlers(ytChat, guestId, guestName, guestColor) {
        ytChat.on('chat', (chat) => {
            // Build message from parts — send raw parts so renderer can construct HTML
            let message = '';
            let youtubeMessageParts = null;

            if (Array.isArray(chat.message)) {
                youtubeMessageParts = chat.message; // send raw for renderer to parse
                message = chat.message.map(part => {
                    if (part.text) return part.text;
                    if (part.emojiText) return part.emojiText;
                    return '';
                }).join('');
            } else if (typeof chat.message === 'string') {
                message = chat.message;
            } else if (chat.message && chat.message.text) {
                message = chat.message.text;
            } else {
                message = String(chat.message);
            }

            this.send('chat:message', {
                platform: 'youtube',
                username: chat.authorName || 'Unknown',
                message,
                youtubeMessageParts, // raw array for emoji rendering
                color: null,
                emotes: null,
                messageId: null,
                userId: null,
                guestId,
                guestName,
                guestColor
            });
        });

        ytChat.on('superchat', (sc) => {
            this.send('chat:message', {
                platform: 'youtube', username: '💰 System',
                message: `${sc.authorName || 'Someone'} sent a Super Chat ${sc.amount || ''}!`,
                color: '#ff0000', emotes: null, messageId: null, userId: null,
                guestId, guestName, guestColor
            });
        });

        ytChat.on('membership', (m) => {
            this.send('chat:message', {
                platform: 'youtube', username: '🌟 System',
                message: `${m.authorName || 'Someone'} became a member!`,
                color: '#ff0000', emotes: null, messageId: null, userId: null,
                guestId, guestName, guestColor
            });
        });

        ytChat.on('milestone', (ms) => {
            this.send('chat:message', {
                platform: 'youtube', username: '🎉 System',
                message: `${ms.authorName || 'Someone'} reached ${ms.level || 'milestone'} membership milestone!`,
                color: '#ff0000', emotes: null, messageId: null, userId: null,
                guestId, guestName, guestColor
            });
        });

        ytChat.on('error', (err) => {
            console.error(`YouTube chat error (${guestId ? 'guest ' + guestId : 'main'}):`, err);
            this.send('chat:status', { platform: 'youtube', status: 'error', message: 'YouTube: Connection Error', guestId });
        });

        ytChat.on('end', () => {
            console.log(`YouTube chat ended (${guestId ? 'guest ' + guestId : 'main'})`);
            if (guestId !== null) {
                this.send('guest:status', { guestId, status: 'disconnected', message: 'Disconnected' });
            }
            this.send('chat:status', { platform: 'youtube', status: 'disconnected', message: 'YouTube: Disconnected', guestId });
        });
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  GUEST MANAGEMENT
    // ══════════════════════════════════════════════════════════════════════════

    async addGuest(platform, username, apiKey) {
        const guestId = this.nextGuestId++;
        const color = GUEST_COLORS[Math.floor(Math.random() * GUEST_COLORS.length)];
        const cleanUsername = platform === 'youtube' ? username.trim() : username.toLowerCase().replace('@', '');
        const name = platform === 'youtube' ? 'YouTube Guest' : cleanUsername.substring(0, 15);

        const guest = {
            id: guestId,
            platform,
            username: cleanUsername,
            name,
            color,
            connected: false,
            client: null,      // tmi.js
            connection: null,  // tiktok-live-connector or masterchat
            manualDisconnect: false,
            reconnectAttempts: 0,
            reconnectTimer: null
        };

        this.guests.push(guest);

        // Kick off the connection asynchronously
        this._connectGuest(guest, apiKey);

        return { guestId, name, color };
    }

    async removeGuest(guestId) {
        const guest = this.guests.find(g => g.id === guestId);
        if (!guest) return { success: false };

        // Disconnect
        guest.manualDisconnect = true;
        if (guest.reconnectTimer) {
            clearTimeout(guest.reconnectTimer);
            guest.reconnectTimer = null;
        }
        if (guest.client) {
            try { guest.client.disconnect(); } catch (e) { /* ignore */ }
        }
        if (guest.connection) {
            try {
                if (guest.platform === 'youtube' && guest.connection.stop) {
                    guest.connection.stop();
                } else if (guest.connection.disconnect) {
                    guest.connection.disconnect();
                }
            } catch (e) { /* ignore */ }
        }

        this.guests = this.guests.filter(g => g.id !== guestId);
        return { success: true };
    }

    /** Internal: start a guest connection based on platform */
    async _connectGuest(guest, apiKey) {
        if (guest.platform === 'twitch') {
            await this._connectTwitchGuest(guest);
        } else if (guest.platform === 'tiktok') {
            await this._connectTiktokGuest(guest, apiKey);
        } else if (guest.platform === 'youtube') {
            await this._connectYoutubeGuest(guest);
        }
    }

    // ── Guest: Twitch ────────────────────────────────────────────────────────
    async _connectTwitchGuest(guest) {
        this.send('guest:status', { guestId: guest.id, status: 'connecting', message: `Connecting to ${guest.username}...` });

        guest.client = new tmi.Client({ channels: [guest.username] });
        this._attachTwitchHandlers(guest.client, guest.id, guest.name, guest.color);

        try {
            await guest.client.connect();
            guest.connected = true;
            this.send('guest:status', { guestId: guest.id, status: 'connected', message: `Connected to ${guest.username}` });
            this.send('chat:message', {
                platform: 'twitch', username: 'System',
                message: `Connected to ${guest.username}'s chat`,
                color: null, emotes: null, messageId: null, userId: null,
                guestId: guest.id, guestName: guest.name, guestColor: guest.color
            });
        } catch (err) {
            console.error('Twitch guest connection error:', err);
            this.send('guest:status', { guestId: guest.id, status: 'error', message: 'Connection failed' });
        }
    }

    // ── Guest: TikTok ────────────────────────────────────────────────────────
    async _connectTiktokGuest(guest, apiKey) {
        this.send('guest:status', { guestId: guest.id, status: 'connecting', message: `Connecting to @${guest.username}...` });

        const opts = {
            processInitialData: false,
            enableExtendedGiftInfo: true,
            requestPollingIntervalMs: 1000
        };
        if (apiKey) opts.signApiKey = apiKey;

        guest.connection = new TikTokLiveConnection(guest.username, opts);
        this._attachTiktokHandlers(guest.connection, guest.username, guest.id, guest.name, guest.color);

        try {
            await guest.connection.connect();
            guest.connected = true;
            this.send('guest:status', { guestId: guest.id, status: 'connected', message: `Connected to @${guest.username}` });
            this.send('chat:message', {
                platform: 'tiktok', username: 'System',
                message: `Connected to @${guest.username}'s live stream`,
                color: null, emotes: null, messageId: null, userId: null,
                guestId: guest.id, guestName: guest.name, guestColor: guest.color
            });
        } catch (err) {
            console.error('TikTok guest connection error:', err);
            this.send('guest:status', { guestId: guest.id, status: 'error', message: 'Connection failed' });
        }
    }

    // ── Guest: TikTok auto-reconnect ─────────────────────────────────────────
    _attemptGuestTiktokReconnect(guest, username) {
        if (guest.manualDisconnect) return;
        if (!guest.reconnectAttempts) guest.reconnectAttempts = 0;

        if (guest.reconnectAttempts >= TIKTOK_RECONNECT_MAX_ATTEMPTS) {
            this.send('chat:message', {
                platform: 'tiktok', username: '⚠️ System',
                message: `Auto-reconnect for @${username} failed after ${TIKTOK_RECONNECT_MAX_ATTEMPTS} attempts.`,
                color: null, emotes: null, messageId: null, userId: null,
                guestId: guest.id, guestName: guest.name, guestColor: guest.color
            });
            this.send('guest:status', { guestId: guest.id, status: 'error', message: 'Reconnect Failed' });
            guest.reconnectAttempts = 0;
            return;
        }

        const delay = reconnectDelay(guest.reconnectAttempts);
        const attemptNum = guest.reconnectAttempts + 1;
        const delaySec = Math.round(delay / 1000);

        this.send('guest:status', { guestId: guest.id, status: 'reconnecting', message: `Reconnecting (${attemptNum}/${TIKTOK_RECONNECT_MAX_ATTEMPTS})...` });
        this.send('chat:message', {
            platform: 'tiktok', username: '🔄 System',
            message: `Guest @${username} lost connection. Reconnecting in ${delaySec}s... (${attemptNum}/${TIKTOK_RECONNECT_MAX_ATTEMPTS})`,
            color: null, emotes: null, messageId: null, userId: null,
            guestId: guest.id, guestName: guest.name, guestColor: guest.color
        });

        guest.reconnectTimer = setTimeout(() => {
            if (guest.manualDisconnect) return;
            guest.reconnectAttempts++;

            if (guest.connection) {
                try { guest.connection.disconnect(); } catch (e) { /* ignore */ }
            }

            const opts = {
                processInitialData: false,
                enableExtendedGiftInfo: true,
                requestPollingIntervalMs: 1000
            };
            if (this.tiktokApiKey) opts.signApiKey = this.tiktokApiKey;

            guest.connection = new TikTokLiveConnection(username, opts);
            this._attachTiktokHandlers(guest.connection, username, guest.id, guest.name, guest.color);

            guest.connection.connect().then(() => {
                guest.reconnectAttempts = 0;
                guest.connected = true;
                this.send('guest:status', { guestId: guest.id, status: 'connected', message: `Connected to @${username}` });
                this.send('chat:message', {
                    platform: 'tiktok', username: '✅ System',
                    message: `Reconnected to @${username}'s live stream`,
                    color: null, emotes: null, messageId: null, userId: null,
                    guestId: guest.id, guestName: guest.name, guestColor: guest.color
                });
            }).catch(() => {
                this._attemptGuestTiktokReconnect(guest, username);
            });
        }, delay);
    }

    // ── Guest: YouTube ───────────────────────────────────────────────────────
    async _connectYoutubeGuest(guest) {
        this.send('guest:status', { guestId: guest.id, status: 'connecting', message: 'Connecting to YouTube...' });

        // Extract video ID from URL if needed
        let cleanVideoId = guest.username;
        if (guest.username.includes('youtube.com') || guest.username.includes('youtu.be')) {
            const urlMatch = guest.username.match(/(?:youtu\.be\/|youtube\.com(?:\/embed\/|\/v\/|\/watch\?v=|\/watch\?.+&v=))([\w-]{11})/);
            if (urlMatch) {
                cleanVideoId = urlMatch[1];
            }
        }

        try {
            guest.connection = await Masterchat.init(cleanVideoId);

            const channelName = guest.connection.metadata?.channelName || guest.connection.channelName || 'YouTube Channel';
            const videoTitle = guest.connection.metadata?.title || guest.connection.title || 'Live Stream';

            // Update guest name with actual channel name
            guest.name = channelName.substring(0, 20);

            this._attachYoutubeHandlers(guest.connection, guest.id, guest.name, guest.color);

            guest.connected = true;
            this.send('guest:status', { guestId: guest.id, status: 'connected', message: `Connected to ${channelName}`, channelName });
            this.send('chat:message', {
                platform: 'youtube', username: 'System',
                message: `Connected to ${channelName} - ${videoTitle}`,
                color: null, emotes: null, messageId: null, userId: null,
                guestId: guest.id, guestName: guest.name, guestColor: guest.color
            });

            guest.connection.listen();
        } catch (err) {
            console.error('YouTube guest connection error:', err);
            this.send('guest:status', { guestId: guest.id, status: 'error', message: 'Connection failed' });
        }
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  CLEANUP
    // ══════════════════════════════════════════════════════════════════════════

    /**
     * Send a message to a Twitch channel using an authenticated client.
     * Creates a temporary auth client if needed.
     */
    async sendTwitchMessage(channel, message, token, username) {
        if (!channel || !message || !token || !username) {
            return { success: false, error: 'Missing credentials. Please log in to Twitch.' };
        }
        try {
            // Create a temporary authenticated client to send the message
            const authClient = new tmi.Client({
                options: { debug: false },
                identity: {
                    username: username,
                    password: `oauth:${token}`
                },
                channels: [channel]
            });
            await authClient.connect();
            await authClient.say(channel, message);
            authClient.disconnect();
            return { success: true };
        } catch (err) {
            return { success: false, error: err.message || 'Failed to send message' };
        }
    }

    destroy() {
        // Disconnect all
        if (this.twitchClient) {
            try { this.twitchClient.disconnect(); } catch (e) { /* ignore */ }
        }
        this.tiktokManualDisconnect = true;
        this._clearTiktokReconnect();
        if (this.tiktokConnection) {
            try { this.tiktokConnection.disconnect(); } catch (e) { /* ignore */ }
        }
        if (this.youtubeChat) {
            try { this.youtubeChat.stop(); } catch (e) { /* ignore */ }
        }

        // Disconnect all guests
        for (const guest of this.guests) {
            guest.manualDisconnect = true;
            if (guest.reconnectTimer) clearTimeout(guest.reconnectTimer);
            if (guest.client) try { guest.client.disconnect(); } catch (e) { /* ignore */ }
            if (guest.connection) {
                try {
                    if (guest.platform === 'youtube' && guest.connection.stop) guest.connection.stop();
                    else if (guest.connection.disconnect) guest.connection.disconnect();
                } catch (e) { /* ignore */ }
            }
        }
        this.guests = [];
    }
}

module.exports = ChatManager;
