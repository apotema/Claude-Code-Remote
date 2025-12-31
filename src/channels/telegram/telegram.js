/**
 * Telegram Notification Channel
 * Sends notifications via Telegram Bot API with command support
 */

const NotificationChannel = require('../base/channel');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const TmuxMonitor = require('../../utils/tmux-monitor');
const { execSync } = require('child_process');

class TelegramChannel extends NotificationChannel {
    constructor(config = {}) {
        super('telegram', config);
        this.sessionsDir = path.join(__dirname, '../../data/sessions');
        this.tmuxMonitor = new TmuxMonitor();
        this.apiBaseUrl = 'https://api.telegram.org';
        this.botUsername = null; // Cache for bot username
        this.activeChatId = null; // Current active chat ID (may change on errors)

        this._ensureDirectories();
        this._validateConfig();
    }

    _ensureDirectories() {
        if (!fs.existsSync(this.sessionsDir)) {
            fs.mkdirSync(this.sessionsDir, { recursive: true });
        }
    }

    _validateConfig() {
        if (!this.config.botToken) {
            this.logger.warn('Telegram Bot Token not found');
            return false;
        }
        if (!this.config.chatId && !this.config.groupId) {
            this.logger.warn('Telegram Chat ID or Group ID must be configured');
            return false;
        }
        return true;
    }

    /**
     * Generate network options for axios requests
     * @returns {Object} Network options object
     */
    _getNetworkOptions() {
        const options = {};
        if (this.config.forceIPv4) {
            options.family = 4;
        }
        return options;
    }

    _generateToken() {
        // Generate short Token (uppercase letters + numbers, 8 digits)
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
        let token = '';
        for (let i = 0; i < 8; i++) {
            token += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return token;
    }

    _getCurrentTmuxSession() {
        try {
            // Try to get current tmux session
            const tmuxSession = execSync('tmux display-message -p "#S"', { 
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'ignore']
            }).trim();
            
            return tmuxSession || null;
        } catch (error) {
            // Not in a tmux session or tmux not available
            return null;
        }
    }

    async _getBotUsername() {
        if (this.botUsername) {
            return this.botUsername;
        }

        try {
            const response = await axios.get(
                `${this.apiBaseUrl}/bot${this.config.botToken}/getMe`,
                this._getNetworkOptions()
            );
            
            if (response.data.ok && response.data.result.username) {
                this.botUsername = response.data.result.username;
                return this.botUsername;
            }
        } catch (error) {
            this.logger.error('Failed to get bot username:', error.message);
        }
        
        // Fallback to configured username or default
        return this.config.botUsername || 'claude_remote_bot';
    }

    async _sendImpl(notification) {
        if (!this._validateConfig()) {
            throw new Error('Telegram channel not properly configured');
        }

        // Generate session ID and Token
        const sessionId = uuidv4();
        const token = this._generateToken();

        // Get current tmux session and conversation content
        const tmuxSession = this._getCurrentTmuxSession();
        if (tmuxSession && !notification.metadata) {
            const conversation = this.tmuxMonitor.getRecentConversation(tmuxSession);
            notification.metadata = {
                userQuestion: conversation.userQuestion || notification.message,
                claudeResponse: conversation.claudeResponse || notification.message,
                tmuxSession: tmuxSession
            };
        }

        // Create session record
        await this._createSession(sessionId, notification, token);

        // Generate Telegram message
        const messageText = this._generateTelegramMessage(notification, sessionId, token);

        // Determine recipient (chat or group) - use active chat ID if available
        const chatId = this.activeChatId || this.config.groupId || this.config.chatId;

        // Create buttons using callback_data instead of inline query
        // This avoids the automatic @bot_name addition
        const buttons = [
            [
                {
                    text: '📝 Personal Chat',
                    callback_data: `personal:${token}`
                },
                {
                    text: '👥 Group Chat',
                    callback_data: `group:${token}`
                }
            ]
        ];

        const requestData = {
            chat_id: chatId,
            text: messageText,
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: buttons
            }
        };

        try {
            const response = await axios.post(
                `${this.apiBaseUrl}/bot${this.config.botToken}/sendMessage`,
                requestData,
                this._getNetworkOptions()
            );

            this.logger.info(`Telegram message sent successfully, Session: ${sessionId}`);
            return true;
        } catch (error) {
            // Check if error is due to invalid chat ID
            const isInvalidChatError = this._isInvalidChatError(error);

            if (isInvalidChatError) {
                this.logger.warn(`Chat ID ${chatId} is invalid, attempting recovery...`);

                // Try to find and use an alternative valid chat ID
                const newChatId = await this._recoverChatId(chatId, messageText, buttons);

                if (newChatId) {
                    this.logger.info(`Recovered to new chat ID: ${newChatId}`);
                    return true;
                }
            }

            this.logger.error('Failed to send Telegram message:', error.response?.data || error.message);
            // Clean up failed session
            await this._removeSession(sessionId);
            return false;
        }
    }

    /**
     * Check if error is due to invalid/blocked chat ID
     */
    _isInvalidChatError(error) {
        const errorData = error.response?.data;
        if (!errorData) return false;

        const description = errorData.description || '';
        const errorCode = errorData.error_code;

        // Common Telegram errors for invalid chats
        const invalidChatErrors = [
            'chat not found',
            'bot was blocked by the user',
            'user is deactivated',
            'bot was kicked from the group chat',
            'bot is not a member of the group chat',
            'chat_id is empty',
            'CHAT_ID_INVALID'
        ];

        return errorCode === 400 || errorCode === 403 ||
            invalidChatErrors.some(err => description.toLowerCase().includes(err.toLowerCase()));
    }

    /**
     * Try to recover by finding a valid chat ID from whitelist
     */
    async _recoverChatId(failedChatId, messageText, buttons) {
        // Get all possible chat IDs to try
        const candidates = this._getChatIdCandidates(failedChatId);

        if (candidates.length === 0) {
            this.logger.warn('No alternative chat IDs available for recovery');
            return null;
        }

        for (const candidateId of candidates) {
            this.logger.debug(`Trying alternative chat ID: ${candidateId}`);

            try {
                const requestData = {
                    chat_id: candidateId,
                    text: messageText,
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: buttons
                    }
                };

                await axios.post(
                    `${this.apiBaseUrl}/bot${this.config.botToken}/sendMessage`,
                    requestData,
                    this._getNetworkOptions()
                );

                // Success! Update active chat ID
                this.activeChatId = candidateId;
                this.logger.info(`Chat ID recovered: ${failedChatId} -> ${candidateId}`);

                return candidateId;
            } catch (candidateError) {
                this.logger.debug(`Chat ID ${candidateId} also failed:`, candidateError.response?.data?.description || candidateError.message);
                continue;
            }
        }

        this.logger.error('All chat ID recovery attempts failed');
        return null;
    }

    /**
     * Get list of candidate chat IDs to try (excluding the failed one)
     */
    _getChatIdCandidates(failedChatId) {
        const candidates = [];
        const failedStr = String(failedChatId);

        // Add from whitelist
        const whitelist = this.config.whitelist || [];
        for (const id of whitelist) {
            if (String(id) !== failedStr && !candidates.includes(String(id))) {
                candidates.push(String(id));
            }
        }

        // Add configured chat IDs if not already tried
        if (this.config.chatId && String(this.config.chatId) !== failedStr) {
            if (!candidates.includes(String(this.config.chatId))) {
                candidates.push(String(this.config.chatId));
            }
        }

        if (this.config.groupId && String(this.config.groupId) !== failedStr) {
            if (!candidates.includes(String(this.config.groupId))) {
                candidates.push(String(this.config.groupId));
            }
        }

        return candidates;
    }

    _generateTelegramMessage(notification, sessionId, token) {
        const type = notification.type;
        const emoji = type === 'completed' ? '✅' : '⏳';
        const status = type === 'completed' ? 'Completed' : 'Waiting for Input';
        
        let messageText = `${emoji} *Claude Task ${status}*\n`;
        messageText += `*Project:* ${notification.project}\n`;
        messageText += `*Session Token:* \`${token}\`\n\n`;
        
        if (notification.metadata) {
            if (notification.metadata.userQuestion) {
                messageText += `📝 *Your Question:*\n${notification.metadata.userQuestion.substring(0, 200)}`;
                if (notification.metadata.userQuestion.length > 200) {
                    messageText += '...';
                }
                messageText += '\n\n';
            }
            
            if (notification.metadata.claudeResponse) {
                messageText += `🤖 *Claude Response:*\n${notification.metadata.claudeResponse.substring(0, 300)}`;
                if (notification.metadata.claudeResponse.length > 300) {
                    messageText += '...';
                }
                messageText += '\n\n';
            }
        }
        
        messageText += `💬 *To send a command:*\n`;
        messageText += `Just type your message directly or send a voice message 🎤`;

        return messageText;
    }

    async _createSession(sessionId, notification, token) {
        const session = {
            id: sessionId,
            token: token,
            type: 'telegram',
            created: new Date().toISOString(),
            expires: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), // Expires after 24 hours
            createdAt: Math.floor(Date.now() / 1000),
            expiresAt: Math.floor((Date.now() + 24 * 60 * 60 * 1000) / 1000),
            tmuxSession: notification.metadata?.tmuxSession || 'default',
            project: notification.project,
            notification: notification
        };

        const sessionFile = path.join(this.sessionsDir, `${sessionId}.json`);
        fs.writeFileSync(sessionFile, JSON.stringify(session, null, 2));
        
        this.logger.debug(`Session created: ${sessionId}`);
    }

    async _removeSession(sessionId) {
        const sessionFile = path.join(this.sessionsDir, `${sessionId}.json`);
        if (fs.existsSync(sessionFile)) {
            fs.unlinkSync(sessionFile);
            this.logger.debug(`Session removed: ${sessionId}`);
        }
    }

    supportsRelay() {
        return true;
    }

    validateConfig() {
        return this._validateConfig();
    }
}

module.exports = TelegramChannel;
