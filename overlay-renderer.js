// Overlay Renderer — uses window.purptea API from overlay-preload.js
// No require() calls — fully sandboxed.

let overlayChat;
let overlayReady = false;

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    overlayChat = document.getElementById('overlay-chat');
    const closeBtn = document.getElementById('close-overlay');
    const toggleBtn = document.getElementById('toggle-transparency');
    const clipBtn = document.getElementById('clip-button');
    
    if (closeBtn) {
        closeBtn.addEventListener('click', () => {
            window.purptea.closeOverlay();
        });
    }
    
    // Toggle ultra-transparent mode
    if (toggleBtn) {
        toggleBtn.addEventListener('click', () => {
            document.body.classList.toggle('ultra-transparent');
            
            // Notify main process to toggle click-through
            const isUltraTransparent = document.body.classList.contains('ultra-transparent');
            window.purptea.toggleClickThrough(isUltraTransparent);
            
            // Change button icon
            toggleBtn.textContent = isUltraTransparent ? '👁️‍🗨️' : '👁️';
        });
    }
    
    // Clip button
    if (clipBtn) {
        clipBtn.addEventListener('click', () => {
            window.purptea.createClipFromOverlay();
        });
    }
    
    // Context menu for moderation
    const contextMenu = document.getElementById('mod-context-menu');
    let currentTargetMessage = null;
    
    // Use mousedown to detect right-clicks
    document.addEventListener('mousedown', (e) => {
        if (e.button === 2) { // Right-click
            const messageElement = e.target.closest('.chat-message.twitch');
            
            if (messageElement && messageElement.dataset.messageId) {
                e.preventDefault();
                e.stopPropagation();
                
                currentTargetMessage = messageElement;
                
                // Position context menu at cursor
                if (contextMenu) {
                    // Show menu first to get its dimensions
                    contextMenu.style.display = 'block';
                    contextMenu.style.left = e.pageX + 'px';
                    contextMenu.style.top = e.pageY + 'px';
                    
                    // Check if menu goes off-screen and adjust
                    const menuRect = contextMenu.getBoundingClientRect();
                    const windowHeight = window.innerHeight;
                    const windowWidth = window.innerWidth;
                    
                    // Adjust vertical position if menu goes off bottom
                    if (menuRect.bottom > windowHeight) {
                        contextMenu.style.top = (e.pageY - menuRect.height) + 'px';
                    }
                    
                    // Adjust horizontal position if menu goes off right edge
                    if (menuRect.right > windowWidth) {
                        contextMenu.style.left = (e.pageX - menuRect.width) + 'px';
                    }
                }
            }
        }
    }, true);
    
    // Prevent default context menu on Twitch messages
    document.addEventListener('contextmenu', (e) => {
        const messageElement = e.target.closest('.chat-message.twitch');
        if (messageElement && messageElement.dataset.messageId) {
            e.preventDefault();
            e.stopPropagation();
            return false;
        }
    }, true);
    
    // Click outside to close context menu
    document.addEventListener('click', (e) => {
        if (contextMenu && !e.target.closest('.mod-context-menu')) {
            contextMenu.style.display = 'none';
        }
    });
    
    // Handle context menu actions
    if (contextMenu) {
        contextMenu.addEventListener('click', async (e) => {
            const menuItem = e.target.closest('.mod-menu-item');
            if (!menuItem || !currentTargetMessage) return;
            
            const action = menuItem.dataset.action;
            const messageId = currentTargetMessage.dataset.messageId;
            const userId = currentTargetMessage.dataset.userId;
            const username = currentTargetMessage.dataset.username;
            
            // Hide context menu
            contextMenu.style.display = 'none';
            
            // Send moderation action to main window
            window.purptea.moderateUser({
                action,
                messageId,
                userId,
                username
            });
            
            currentTargetMessage = null;
        });
    }

    // Signal to the main window that we're loaded and ready to receive messages
    overlayReady = true;
    window.purptea.overlayReady();
});

// Listen for chat messages from main window
window.purptea.on('new-chat-message', (messageData) => {
    if (!overlayChat) return;

    if (messageData?.type === 'sync-history') {
        overlayChat.innerHTML = messageData.html && messageData.html.trim()
            ? messageData.html
            : `
                <div class="overlay-welcome">
                    <p>Chat overlay active</p>
                    <p class="small">Waiting for messages...</p>
                </div>
            `;
        overlayChat.scrollTop = overlayChat.scrollHeight;
        return;
    }

    if (messageData?.type === 'append-message' && messageData.html) {
        removeWelcomeMessage();
        overlayChat.insertAdjacentHTML('beforeend', messageData.html);
        overlayChat.scrollTop = overlayChat.scrollHeight;

        const messages = overlayChat.querySelectorAll('.chat-message');
        if (messages.length > 50) {
            messages[0].remove();
        }
        return;
    }

    removeWelcomeMessage();
    addChatMessageToOverlay(messageData);
});

function removeWelcomeMessage() {
    const welcome = overlayChat.querySelector('.overlay-welcome, .welcome-message');
    if (welcome) {
        welcome.remove();
    }
}

function addChatMessageToOverlay(data) {
    const messageDiv = document.createElement('div');
    messageDiv.className = `chat-message ${data.platform}`;
    
    // Store message ID and user ID for moderation (Twitch only)
    if (data.platform === 'twitch' && data.messageId) {
        messageDiv.dataset.messageId = data.messageId;
    }
    if (data.platform === 'twitch' && data.userId) {
        messageDiv.dataset.userId = data.userId;
        messageDiv.dataset.username = data.username;
    }
    
    if (data.guestColor) {
        messageDiv.style.borderLeftColor = data.guestColor;
    }
    
    const badge = document.createElement('span');
    badge.className = 'platform-badge';
    badge.textContent = data.platform;
    
    // Add guest badge if present
    if (data.guestName) {
        const guestBadge = document.createElement('span');
        guestBadge.className = 'guest-badge';
        guestBadge.textContent = data.guestName;
        guestBadge.style.backgroundColor = data.guestColor;
        messageDiv.appendChild(badge);
        messageDiv.appendChild(guestBadge);
    } else {
        messageDiv.appendChild(badge);
    }
    
    const usernameSpan = document.createElement('span');
    usernameSpan.className = 'username';
    usernameSpan.textContent = data.username;
    if (data.username.includes('System')) {
        usernameSpan.classList.add('system-username');
    }
    if (data.color) {
        usernameSpan.style.color = data.color;
    }
    
    const messageSpan = document.createElement('span');
    messageSpan.className = 'message-text';
    messageSpan.innerHTML = data.message; // Use innerHTML to support emotes
    
    const colonSpan = document.createElement('span');
    colonSpan.className = 'message-colon';
    colonSpan.textContent = ': ';
    
    messageDiv.appendChild(usernameSpan);
    messageDiv.appendChild(colonSpan);
    messageDiv.appendChild(messageSpan);
    
    overlayChat.appendChild(messageDiv);
    
    // Auto-scroll to bottom
    overlayChat.scrollTop = overlayChat.scrollHeight;
    
    // Keep only last 50 messages for performance
    const messages = overlayChat.querySelectorAll('.chat-message');
    if (messages.length > 50) {
        messages[0].remove();
    }
}
