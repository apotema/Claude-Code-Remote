/**
 * Telegram Webhook Handler
 * Handles incoming Telegram messages and commands
 */

const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const Logger = require('../../core/logger');
const ControllerInjector = require('../../utils/controller-injector');

class TelegramWebhookHandler {
    constructor(config = {}) {
        this.config = config;
        this.logger = new Logger('TelegramWebhook');
        this.sessionsDir = path.join(__dirname, '../../data/sessions');
        this.injector = new ControllerInjector();
        this.app = express();
        this.apiBaseUrl = 'https://api.telegram.org';
        this.botUsername = null; // Cache for bot username
        
        this._setupMiddleware();
        this._setupRoutes();
    }

    _setupMiddleware() {
        // Parse JSON for all requests
        this.app.use(express.json());
    }

    _setupRoutes() {
        // Telegram webhook endpoint
        this.app.post('/webhook/telegram', this._handleWebhook.bind(this));

        // Health check endpoint
        this.app.get('/health', (req, res) => {
            res.json({ status: 'ok', service: 'telegram-webhook' });
        });
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

    async _handleWebhook(req, res) {
        try {
            const update = req.body;
            
            // Handle different update types
            if (update.message) {
                await this._handleMessage(update.message);
            } else if (update.callback_query) {
                await this._handleCallbackQuery(update.callback_query);
            }
            
            res.status(200).send('OK');
        } catch (error) {
            this.logger.error('Webhook handling error:', error.message);
            res.status(500).send('Internal Server Error');
        }
    }

    async _handleMessage(message) {
        const chatId = message.chat.id;
        const userId = message.from.id;

        // Handle voice/audio messages
        if (message.voice || message.audio) {
            await this._handleVoiceMessage(message, chatId, userId);
            return;
        }

        const messageText = message.text?.trim();

        if (!messageText) return;

        // Check if user is authorized
        if (!this._isAuthorized(userId, chatId)) {
            this.logger.warn(`Unauthorized user/chat: ${userId}/${chatId}`);
            await this._sendMessage(chatId, '⚠️ You are not authorized to use this bot.');
            return;
        }

        // Handle /start command
        if (messageText === '/start') {
            await this._sendWelcomeMessage(chatId);
            return;
        }

        // Handle /help command
        if (messageText === '/help') {
            await this._sendHelpMessage(chatId);
            return;
        }

        // Try to parse command with different formats (most specific to least specific)

        // Format 1: /cmd <TOKEN> <command>
        const cmdTokenMatch = messageText.match(/^\/cmd\s+([A-Z0-9]{8})\s+(.+)$/is);
        if (cmdTokenMatch) {
            await this._processCommand(chatId, cmdTokenMatch[1].toUpperCase(), cmdTokenMatch[2]);
            return;
        }

        // Format 2: <TOKEN> <command> (token at start)
        const tokenMatch = messageText.match(/^([A-Z0-9]{8})\s+(.+)$/is);
        if (tokenMatch) {
            await this._processCommand(chatId, tokenMatch[1].toUpperCase(), tokenMatch[2]);
            return;
        }

        // Format 3: Just the command (no token, no /cmd) - use most recent active session
        await this._processCommandWithoutToken(chatId, userId, messageText);
    }

    async _handleVoiceMessage(message, chatId, userId) {
        // Check if user is authorized
        if (!this._isAuthorized(userId, chatId)) {
            this.logger.warn(`Unauthorized user/chat: ${userId}/${chatId}`);
            await this._sendMessage(chatId, '⚠️ You are not authorized to use this bot.');
            return;
        }

        const voice = message.voice || message.audio;
        const fileId = voice.file_id;

        try {
            // Notify user that we're processing the audio
            await this._sendMessage(chatId, '🎤 Processing your voice message...');

            // Get file path from Telegram
            const fileResponse = await axios.get(
                `${this.apiBaseUrl}/bot${this.config.botToken}/getFile?file_id=${fileId}`,
                this._getNetworkOptions()
            );

            if (!fileResponse.data.ok) {
                throw new Error('Failed to get file info from Telegram');
            }

            const filePath = fileResponse.data.result.file_path;
            const fileUrl = `${this.apiBaseUrl}/file/bot${this.config.botToken}/${filePath}`;

            // Download the audio file
            const audioResponse = await axios.get(fileUrl, {
                responseType: 'arraybuffer',
                ...this._getNetworkOptions()
            });

            // Transcribe the audio
            const transcribedText = await this._transcribeAudio(audioResponse.data, filePath);

            if (!transcribedText || transcribedText.trim() === '') {
                await this._sendMessage(chatId, '❌ Could not transcribe the audio. Please try again or send a text message.');
                return;
            }

            // Notify user of the transcription
            await this._sendMessage(chatId,
                `📝 *Transcribed:* ${transcribedText}`,
                { parse_mode: 'Markdown' });

            // Process the transcribed text as a command (without token)
            await this._processCommandWithoutToken(chatId, userId, transcribedText);

        } catch (error) {
            this.logger.error('Voice message processing failed:', error.message);
            await this._sendMessage(chatId,
                `❌ Failed to process voice message: ${error.message}`);
        }
    }

    async _transcribeAudio(audioBuffer, filePath) {
        // Check if OpenAI API key is configured for Whisper
        const openaiKey = this.config.openaiApiKey || process.env.OPENAI_API_KEY;

        if (openaiKey) {
            return await this._transcribeWithWhisper(audioBuffer, filePath, openaiKey);
        }

        // Fallback: Try local whisper if available
        return await this._transcribeWithLocalWhisper(audioBuffer, filePath);
    }

    async _transcribeWithWhisper(audioBuffer, filePath, apiKey) {
        const FormData = require('form-data');
        const form = new FormData();

        // Determine file extension
        const ext = path.extname(filePath) || '.ogg';
        const filename = `audio${ext}`;

        form.append('file', Buffer.from(audioBuffer), {
            filename: filename,
            contentType: ext === '.ogg' ? 'audio/ogg' : 'audio/mpeg'
        });
        form.append('model', 'whisper-1');

        try {
            const response = await axios.post(
                'https://api.openai.com/v1/audio/transcriptions',
                form,
                {
                    headers: {
                        'Authorization': `Bearer ${apiKey}`,
                        ...form.getHeaders()
                    },
                    ...this._getNetworkOptions()
                }
            );

            return response.data.text;
        } catch (error) {
            this.logger.error('Whisper API transcription failed:', error.response?.data || error.message);
            throw new Error('Whisper transcription failed');
        }
    }

    async _transcribeWithLocalWhisper(audioBuffer, filePath) {
        const { execSync } = require('child_process');
        const os = require('os');

        // Create temp file
        const tempDir = os.tmpdir();
        const ext = path.extname(filePath) || '.ogg';
        const tempFile = path.join(tempDir, `telegram_voice_${Date.now()}${ext}`);

        try {
            // Write audio buffer to temp file
            fs.writeFileSync(tempFile, Buffer.from(audioBuffer));

            // Try to run local whisper
            const result = execSync(`whisper "${tempFile}" --model base --output_format txt --output_dir "${tempDir}"`, {
                encoding: 'utf8',
                timeout: 60000
            });

            // Read the transcription result
            const txtFile = tempFile.replace(ext, '.txt');
            if (fs.existsSync(txtFile)) {
                const transcription = fs.readFileSync(txtFile, 'utf8').trim();
                fs.unlinkSync(txtFile);
                return transcription;
            }

            throw new Error('Transcription file not found');
        } catch (error) {
            this.logger.warn('Local whisper not available:', error.message);
            throw new Error('No transcription service available. Please configure OPENAI_API_KEY for Whisper.');
        } finally {
            // Cleanup temp file
            if (fs.existsSync(tempFile)) {
                fs.unlinkSync(tempFile);
            }
        }
    }

    async _processCommandWithoutToken(chatId, userId, command) {
        // Find the most recent active session for this user/chat
        const session = await this._findMostRecentSession(chatId, userId);

        if (!session) {
            await this._sendMessage(chatId,
                '❌ No active session found. Please wait for a task notification first.',
                { parse_mode: 'Markdown' });
            return;
        }

        // Check if session is expired
        if (session.expiresAt < Math.floor(Date.now() / 1000)) {
            await this._sendMessage(chatId,
                '❌ Your session has expired. Please wait for a new task notification.',
                { parse_mode: 'Markdown' });
            await this._removeSession(session.id);
            return;
        }

        try {
            // Inject command into tmux session
            const tmuxSession = session.tmuxSession || 'default';
            await this.injector.injectCommand(command, tmuxSession);

            // Send confirmation
            await this._sendMessage(chatId,
                `✅ *Command sent successfully*\n\n📝 *Command:* ${command}\n🖥️ *Session:* ${tmuxSession}\n\nClaude is now processing your request...`,
                { parse_mode: 'Markdown' });

            // Log command execution
            this.logger.info(`Command injected (auto-session) - User: ${chatId}, Session: ${session.id}, Command: ${command}`);

        } catch (error) {
            this.logger.error('Command injection failed:', error.message);
            await this._sendMessage(chatId,
                `❌ *Command execution failed:* ${error.message}`,
                { parse_mode: 'Markdown' });
        }
    }

    async _findMostRecentSession(chatId, userId) {
        const files = fs.readdirSync(this.sessionsDir);
        let mostRecentSession = null;
        let mostRecentTime = 0;

        for (const file of files) {
            if (!file.endsWith('.json')) continue;

            const sessionPath = path.join(this.sessionsDir, file);
            try {
                const session = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));

                // Check if session is still valid (not expired)
                if (session.expiresAt && session.expiresAt > Math.floor(Date.now() / 1000)) {
                    // Check if this session is more recent
                    if (session.createdAt && session.createdAt > mostRecentTime) {
                        mostRecentTime = session.createdAt;
                        mostRecentSession = session;
                    }
                }
            } catch (error) {
                this.logger.error(`Failed to read session file ${file}:`, error.message);
            }
        }

        return mostRecentSession;
    }

    async _processCommand(chatId, token, command) {
        // Find session by token
        const session = await this._findSessionByToken(token);
        if (!session) {
            await this._sendMessage(chatId, 
                '❌ Invalid or expired token. Please wait for a new task notification.',
                { parse_mode: 'Markdown' });
            return;
        }

        // Check if session is expired
        if (session.expiresAt < Math.floor(Date.now() / 1000)) {
            await this._sendMessage(chatId, 
                '❌ Token has expired. Please wait for a new task notification.',
                { parse_mode: 'Markdown' });
            await this._removeSession(session.id);
            return;
        }

        try {
            // Inject command into tmux session
            const tmuxSession = session.tmuxSession || 'default';
            await this.injector.injectCommand(command, tmuxSession);
            
            // Send confirmation
            await this._sendMessage(chatId, 
                `✅ *Command sent successfully*\n\n📝 *Command:* ${command}\n🖥️ *Session:* ${tmuxSession}\n\nClaude is now processing your request...`,
                { parse_mode: 'Markdown' });
            
            // Log command execution
            this.logger.info(`Command injected - User: ${chatId}, Token: ${token}, Command: ${command}`);
            
        } catch (error) {
            this.logger.error('Command injection failed:', error.message);
            await this._sendMessage(chatId, 
                `❌ *Command execution failed:* ${error.message}`,
                { parse_mode: 'Markdown' });
        }
    }

    async _handleCallbackQuery(callbackQuery) {
        const chatId = callbackQuery.message.chat.id;
        const data = callbackQuery.data;
        
        // Answer callback query to remove loading state
        await this._answerCallbackQuery(callbackQuery.id);
        
        if (data.startsWith('personal:')) {
            const token = data.split(':')[1];
            // Send personal chat command format
            await this._sendMessage(chatId,
                `📝 *Personal Chat Command Format:*\n\n\`/cmd ${token} <your command>\`\n\n*Example:*\n\`/cmd ${token} please analyze this code\`\n\n💡 *Copy and paste the format above, then add your command!*`,
                { parse_mode: 'Markdown' });
        } else if (data.startsWith('group:')) {
            const token = data.split(':')[1];
            // Send group chat command format with @bot_name
            const botUsername = await this._getBotUsername();
            await this._sendMessage(chatId,
                `👥 *Group Chat Command Format:*\n\n\`@${botUsername} /cmd ${token} <your command>\`\n\n*Example:*\n\`@${botUsername} /cmd ${token} please analyze this code\`\n\n💡 *Copy and paste the format above, then add your command!*`,
                { parse_mode: 'Markdown' });
        } else if (data.startsWith('session:')) {
            const token = data.split(':')[1];
            // For backward compatibility - send help message for old callback buttons
            await this._sendMessage(chatId,
                `📝 *How to send a command:*\n\nType:\n\`/cmd ${token} <your command>\`\n\nExample:\n\`/cmd ${token} please analyze this code\`\n\n💡 *Tip:* New notifications have a button that auto-fills the command for you!`,
                { parse_mode: 'Markdown' });
        }
    }

    async _sendWelcomeMessage(chatId) {
        const message = `🤖 *Welcome to Claude Code Remote Bot!*\n\n` +
            `I'll notify you when Claude completes tasks or needs input.\n\n` +
            `*How to send commands:*\n` +
            `• Just type your command directly!\n` +
            `• Or send a voice message 🎤\n\n` +
            `Type /help for more information.`;

        await this._sendMessage(chatId, message, { parse_mode: 'Markdown' });
    }

    async _sendHelpMessage(chatId) {
        const message = `📚 *Claude Code Remote Bot Help*\n\n` +
            `*Commands:*\n` +
            `• \`/start\` - Welcome message\n` +
            `• \`/help\` - Show this help\n\n` +
            `*Sending commands to Claude:*\n` +
            `• Just type your command directly\n` +
            `• Or send a voice message 🎤\n` +
            `• Legacy format: \`/cmd <TOKEN> <command>\`\n\n` +
            `*Examples:*\n` +
            `• \`analyze this code\`\n` +
            `• \`fix the bug in the login function\`\n\n` +
            `*Tips:*\n` +
            `• Commands are sent to the most recent active session\n` +
            `• Sessions expire after 24 hours\n` +
            `• Voice messages are transcribed automatically`;

        await this._sendMessage(chatId, message, { parse_mode: 'Markdown' });
    }

    _isAuthorized(userId, chatId) {
        // Check whitelist
        const whitelist = this.config.whitelist || [];
        
        if (whitelist.includes(String(chatId)) || whitelist.includes(String(userId))) {
            return true;
        }
        
        // If no whitelist configured, allow configured chat/user
        if (whitelist.length === 0) {
            const configuredChatId = this.config.chatId || this.config.groupId;
            if (configuredChatId && String(chatId) === String(configuredChatId)) {
                return true;
            }
        }
        
        return false;
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

    async _findSessionByToken(token) {
        const files = fs.readdirSync(this.sessionsDir);
        
        for (const file of files) {
            if (!file.endsWith('.json')) continue;
            
            const sessionPath = path.join(this.sessionsDir, file);
            try {
                const session = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
                if (session.token === token) {
                    return session;
                }
            } catch (error) {
                this.logger.error(`Failed to read session file ${file}:`, error.message);
            }
        }
        
        return null;
    }

    async _removeSession(sessionId) {
        const sessionFile = path.join(this.sessionsDir, `${sessionId}.json`);
        if (fs.existsSync(sessionFile)) {
            fs.unlinkSync(sessionFile);
            this.logger.debug(`Session removed: ${sessionId}`);
        }
    }

    async _sendMessage(chatId, text, options = {}) {
        try {
            await axios.post(
                `${this.apiBaseUrl}/bot${this.config.botToken}/sendMessage`,
                {
                    chat_id: chatId,
                    text: text,
                    ...options
                },
                this._getNetworkOptions()
            );
        } catch (error) {
            this.logger.error('Failed to send message:', error.response?.data || error.message);
        }
    }

    async _answerCallbackQuery(callbackQueryId, text = '') {
        try {
            await axios.post(
                `${this.apiBaseUrl}/bot${this.config.botToken}/answerCallbackQuery`,
                {
                    callback_query_id: callbackQueryId,
                    text: text
                },
                this._getNetworkOptions()
            );
        } catch (error) {
            this.logger.error('Failed to answer callback query:', error.response?.data || error.message);
        }
    }

    async setWebhook(webhookUrl) {
        try {
            const response = await axios.post(
                `${this.apiBaseUrl}/bot${this.config.botToken}/setWebhook`,
                {
                    url: webhookUrl,
                    allowed_updates: ['message', 'callback_query']
                },
                this._getNetworkOptions()
            );

            this.logger.info('Webhook set successfully:', response.data);
            return response.data;
        } catch (error) {
            this.logger.error('Failed to set webhook:', error.response?.data || error.message);
            throw error;
        }
    }

    start(port = 3000) {
        this.app.listen(port, () => {
            this.logger.info(`Telegram webhook server started on port ${port}`);
        });
    }
}

module.exports = TelegramWebhookHandler;
