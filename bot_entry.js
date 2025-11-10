/**
 * Browser bot entry point.
 * Coordinates Playwright automation, platform-specific meeting control,
 * and audio/WebSocket plumbing for the Clerk meeting agent.
 */

const { chromium } = require('playwright');
const WebSocket = require('ws');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');

const { createPlatformController } = require('./platforms');
const MockLLMService = require('./lib/mockLLM');

const DEFAULT_BROWSER_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-web-security',
  '--disable-features=IsolateOrigins,site-per-process',
  '--use-fake-ui-for-media-stream',
  '--use-fake-device-for-media-stream',
  '--autoplay-policy=no-user-gesture-required',
  '--allow-running-insecure-content',
  '--ignore-certificate-errors',
  '--enable-features=NetworkService,NetworkServiceLogging',
  '--metrics-recording-only',
  '--force-color-profile=srgb',
  '--password-store=basic',
  '--use-mock-keychain',
  '--disable-blink-features=AutomationControlled',
  '--disable-features=VizDisplayCompositor',
  '--disable-ipc-flooding-protection',
  '--disable-hang-monitor',
  '--disable-popup-blocking',
  '--disable-prompt-on-repost',
  '--disable-sync',
  '--disable-translate',
  '--disable-windows10-custom-titlebar',
  '--disable-client-side-phishing-detection',
  '--disable-component-extensions-with-background-pages',
  '--disable-default-apps',
  '--disable-extensions',
  '--disable-plugins',
  '--disable-plugins-discovery',
  '--disable-preconnect',
  '--disable-print-preview',
  '--hide-scrollbars',
  '--no-default-browser-check',
  '--no-first-run',
  '--no-pings',
  // Prevent protocol handler dialogs (Teams app popup)
  '--disable-protocol-handler-prompt'
];

function parseBoolean(value, defaultValue) {
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

const config = {
  meetingUrl: process.env.MEETING_URL,
  botName: process.env.BOT_NAME || 'Clerk AI Bot',
  platform: process.env.PLATFORM || 'google_meet',
  meetingPasscode: process.env.MEETING_PASSCODE || null,
  rtGatewayUrl: process.env.RT_GATEWAY_URL || 'ws://44.203.236.62:8000',
  apiBaseUrl: process.env.API_BASE_URL || 'http://44.203.236.62:8000',
  joinTimeoutSec: parseInt(process.env.JOIN_TIMEOUT_SEC, 10) || 60,
  navigationTimeoutMs: parseInt(process.env.NAVIGATION_TIMEOUT_MS || '45000', 10),
  audioSampleRate: parseInt(process.env.AUDIO_SAMPLE_RATE, 10) || 16000,
  audioChannels: parseInt(process.env.AUDIO_CHANNELS, 10) || 1,
  enableAudioCapture: parseBoolean(process.env.ENABLE_AUDIO_CAPTURE, true),
  enableTtsPlayback: parseBoolean(process.env.ENABLE_TTS_PLAYBACK, true),
  // TTS Configuration
  ttsProvider: process.env.TTS_PROVIDER || 'openai', // 'openai' or 'elevenlabs'
  ttsApiKey: process.env.TTS_API_KEY || process.env.OPENAI_API_KEY || '',
  ttsVoice: process.env.TTS_VOICE || 'alloy', // OpenAI voice or ElevenLabs voice ID
  ttsSpeed: parseFloat(process.env.TTS_SPEED) || 1.0,
  ttsPitch: parseFloat(process.env.TTS_PITCH) || 1.0,
  ttsGain: parseFloat(process.env.TTS_GAIN) || 0.7,
  llmMockUrl: process.env.LLM_MOCK_URL || '', // Optional: mock API URL for text responses
  headless: parseBoolean(process.env.HEADLESS, true),
  // Optional Playwright storage state path for pre-authenticated sessions
  storageState: process.env.STORAGE_STATE || '',
  browserLocale: process.env.BROWSER_LOCALE || 'en-US',
  browserArgs: (process.env.BROWSER_ARGS ? process.env.BROWSER_ARGS.split(',').map((arg) => arg.trim()).filter(Boolean) : [])
    .concat(DEFAULT_BROWSER_ARGS),
  meetingCheckIntervalMs: parseInt(process.env.MEETING_CHECK_INTERVAL_MS || '4000', 10),
  meetingPresenceGraceMs: parseInt(process.env.MEETING_PRESENCE_GRACE_MS || '20000', 10),
  logLevel: (process.env.LOG_LEVEL || 'info').toLowerCase(),
  meetingId: process.env.MEETING_ID || uuidv4(),
  sessionId: process.env.SESSION_ID || uuidv4(),
  enableBrowserUseAssist: parseBoolean(process.env.BROWSER_USE_ASSIST, false)
};

const LOG_LEVEL_WEIGHT = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3
};

class StructuredLogger {
  constructor(level = 'info', context = {}) {
    this.level = level;
    this.context = context;
  }

  child(extra = {}) {
    return new StructuredLogger(this.level, { ...this.context, ...extra });
  }

  shouldLog(level) {
    const desired = LOG_LEVEL_WEIGHT[level];
    const current = LOG_LEVEL_WEIGHT[this.level] ?? LOG_LEVEL_WEIGHT.info;
    return desired <= current;
  }

  formatContext(additional = {}) {
    const payload = { ...this.context, ...additional };
    return Object.keys(payload).length ? payload : undefined;
  }

  info(message, meta = {}) {
    if (this.shouldLog('info')) {
      console.log(`[INFO] ${message}`, this.formatContext(meta) || '');
    }
  }

  warn(message, meta = {}) {
    if (this.shouldLog('warn')) {
      console.warn(`[WARN] ${message}`, this.formatContext(meta) || '');
    }
  }

  error(message, meta = {}) {
    if (this.shouldLog('error')) {
      console.error(`[ERROR] ${message}`, this.formatContext(meta) || '');
    }
  }

  debug(message, meta = {}) {
    if (this.shouldLog('debug')) {
      console.log(`[DEBUG] ${message}`, this.formatContext(meta) || '');
    }
  }
}

let activeBot = null;

class BrowserBot {
  constructor(botConfig) {
    this.config = botConfig;
    this.logger = new StructuredLogger(botConfig.logLevel, {
      sessionId: botConfig.sessionId,
      platform: botConfig.platform
    });

    this.browser = null;
    this.context = null;
    this.page = null;
    this.gateway = null;
    this.platform = null;
    this.audioCaptureActive = false;
    this.audioFrameSequence = 0;
    this.shouldStop = false;
    this.stopReason = null;
    this.isJoined = false;
    this.hasLeft = false;
    this.initialSpeechTimeout = null;
    this.lastMeetingActiveTs = Date.now();
    this.signalHandler = this.handleProcessSignal.bind(this);
    
    // Initialize LLM service
    this.llmService = null;
    if (this.config.enableTtsPlayback) {
      this.llmService = new MockLLMService(this.config, this.logger);
    }
    
    // Audio streaming from rt_gateway
    this.audioStream = null;
    this.audioStreamBuffer = [];
    this.ttsEnabled = this.config.enableTtsPlayback;
    
    // Audio input stream for STT
    this.audioInputStream = null;
    
    // Reconnection state
    this.reconnectAttempts = 0;
    this.reconnectTimeout = null;
    this.isReconnecting = false;
    
    // Audio input reconnection state
    this.audioInputReconnectAttempts = 0;
    this.audioInputReconnectTimeout = null;
    this.isAudioInputReconnecting = false;
  }

  async start() {
    if (!this.config.meetingUrl) {
      throw new Error('MEETING_URL environment variable is required');
    }

    this.logger.info('Browser bot starting', {
      meetingUrl: this.config.meetingUrl,
      headless: this.config.headless
    });

    try {
      this.registerSignalHandlers();
      await this.connectGateway();
      if (this.config.enableAudioCapture) {
        await this.connectAudioInputGateway(); // Connect to audio input stream for STT
      } else {
        this.logger.info('Audio input stream skipped (ENABLE_AUDIO_CAPTURE=false)');
      }
      await this.launchBrowser();
      await this.joinMeeting();
      await this.initializeMedia();
      await this.runLoop();
    } finally {
      await this.cleanup();
      this.unregisterSignalHandlers();
    }
  }

  registerSignalHandlers() {
    ['SIGINT', 'SIGTERM'].forEach((signal) => {
      process.on(signal, this.signalHandler);
    });
  }

  unregisterSignalHandlers() {
    ['SIGINT', 'SIGTERM'].forEach((signal) => {
      process.off(signal, this.signalHandler);
    });
  }

  async handleProcessSignal(signal) {
    this.logger.warn('Received termination signal, stopping bot', { signal });
    await this.requestStop(`signal:${signal}`);
  }

  async connectGateway() {
    return new Promise((resolve, reject) => {
      this.logger.info('Connecting to RT Gateway', { url: this.config.rtGatewayUrl });
      
      // Parse rt_gateway URL to get base URL
      const gatewayUrl = new URL(this.config.rtGatewayUrl);
      const baseUrl = `${gatewayUrl.protocol}//${gatewayUrl.host}`;
      const sessionId = this.config.sessionId;
      
      // Connect to audio stream endpoint
      this.logger.info('Connecting to bot audio stream', { url: `${baseUrl}/ws/bot_audio_output/${sessionId}` });
      const audioWs = new WebSocket(`${baseUrl}/ws/bot_audio_output/${sessionId}`);

      const self = this; // Capture 'this' reference
      
      // Set a timeout for initial connection (10 seconds)
      const connectionTimeout = setTimeout(() => {
        if (!self.audioStream) {
          self.logger.error('Connection timeout: Failed to connect to RT Gateway within 10 seconds');
          audioWs.close();
          // Don't reject - allow bot to continue and retry
          self.scheduleReconnect(baseUrl, sessionId);
          resolve(); // Continue without connection for now
        }
      }, 10000);

      const cleanup = () => {
        clearTimeout(connectionTimeout);
        audioWs.off('open', handleOpen);
        audioWs.off('error', handleError);
        audioWs.off('message', handleMessage);
        audioWs.off('close', handleClose);
      };
      
      const handleOpen = () => {
        cleanup();
        self.logger.info('✅ Connected to RT Gateway audio stream', { 
          attempt: self.reconnectAttempts + 1,
          sessionId: sessionId,
          url: `${baseUrl}/ws/bot_audio_output/${sessionId}`
        });
        self.audioStream = audioWs;
        self.reconnectAttempts = 0; // Reset on successful connection
        self.isReconnecting = false;
        
        audioWs.on('message', handleMessage);
        audioWs.on('close', handleClose);
        audioWs.on('error', (error) => {
          // Only log errors if not in a closing state
          if (audioWs.readyState !== WebSocket.CLOSING && audioWs.readyState !== WebSocket.CLOSED) {
            self.logger.error('RT Gateway audio stream error', { error: error.message });
          }
        });
        
        resolve();
      };

      const handleMessage = (data) => {
        // Handle binary PCM audio data
        if (Buffer.isBuffer(data)) {
          self.logger.info('Received PCM audio chunk', { bytes: data.length });
          self.handlePCMAudioChunk(data);
        } else {
          try {
            const message = JSON.parse(data.toString());
            if (message.type === 'tts_complete') {
              self.logger.info('TTS audio stream complete');
            }
          } catch (e) {
            // Ignore non-JSON messages
          }
        }
      };

      const handleClose = (code, reason) => {
        cleanup();
        self.logger.warn('RT Gateway audio stream closed', { code, reason: reason?.toString() });
        self.audioStream = null;
        
        // Don't reconnect if bot is stopping
        if (self.shouldStop) {
          self.logger.info('Bot stopping, not reconnecting audio stream');
          return;
        }
        
        // Don't reconnect for intentional close (code 1000 = normal closure)
        if (code === 1000) {
          self.logger.info('Normal WebSocket closure, not reconnecting');
          return;
        }
        
        // Trigger reconnection
        self.scheduleReconnect(baseUrl, sessionId);
      };

      const handleError = (error) => {
        cleanup();
        self.logger.error('❌ Failed to connect to RT Gateway audio stream', { 
          error: error.message, 
          attempt: self.reconnectAttempts + 1,
          url: `${baseUrl}/ws/bot_audio_output/${sessionId}`,
          hint: 'Make sure unified service is running on port 8000'
        });
        self.audioStream = null;
        
        // Don't reconnect if bot is stopping
        if (self.shouldStop) {
          self.logger.info('Bot stopping, not scheduling reconnection');
          resolve(); // Continue without WebSocket connection
          return;
        }
        
        // If this is the initial connection attempt, schedule reconnect
        if (self.reconnectAttempts === 0) {
          self.logger.warn('Will retry connection in background...');
          self.scheduleReconnect(baseUrl, sessionId);
          resolve(); // Continue without WebSocket connection initially
        } else {
          // Already in reconnection mode, will retry
          resolve();
        }
      };

      audioWs.once('open', handleOpen);
      audioWs.once('error', handleError);
      audioWs.once('close', handleClose);
    });
  }

  /**
   * Calculate reconnection delay with exponential backoff
   * Starts at 3 seconds, adds 3 seconds per retry, caps at 30 seconds
   * @param {number} attemptNumber - The current reconnection attempt number (1-based)
   * @returns {number} Delay in milliseconds
   */
  calculateReconnectDelay(attemptNumber) {
    const baseDelay = 3000; // 3 seconds
    const increment = 3000; // Add 3 seconds per attempt
    const maxDelay = 30000; // Cap at 30 seconds
    
    // Calculate: start at 3s, add 3s per attempt (attempt 1 = 3s, attempt 2 = 6s, etc.)
    const delay = baseDelay + (attemptNumber - 1) * increment;
    
    // Cap at max delay
    return Math.min(delay, maxDelay);
  }

  /**
   * Schedule reconnection with exponential backoff
   * Starts at 3 seconds, adds 3 seconds per retry, caps at 30 seconds
   */
  scheduleReconnect(baseUrl, sessionId) {
    // Don't reconnect if already reconnecting or bot is stopping
    if (this.isReconnecting || this.shouldStop) {
      return;
    }
    
    this.isReconnecting = true;
    this.reconnectAttempts++;
    
    const delay = this.calculateReconnectDelay(this.reconnectAttempts);
    
    this.logger.info('Scheduling audio stream reconnection', {
      attempt: this.reconnectAttempts,
      delayMs: delay
    });
    
    this.reconnectTimeout = setTimeout(async () => {
      this.reconnectTimeout = null;
      
      // Don't reconnect if bot is stopping
      if (this.shouldStop) {
        this.logger.info('Bot stopping, cancelling reconnection');
        this.isReconnecting = false;
        return;
      }
      
      try {
        this.logger.info('Attempting to reconnect audio stream', { attempt: this.reconnectAttempts });
        
        // Connect to audio stream endpoint
        const audioWs = new WebSocket(`${baseUrl}/ws/bot_audio_output/${sessionId}`);
        
        const self = this;
        
        audioWs.once('open', () => {
          self.logger.info('Reconnected to RT Gateway audio stream', { attempt: self.reconnectAttempts });
          self.audioStream = audioWs;
          self.reconnectAttempts = 0; // Reset on successful reconnection
          self.isReconnecting = false;
          
          audioWs.on('message', (data) => {
            // Handle binary PCM audio data
            if (Buffer.isBuffer(data)) {
              self.logger.info('Received PCM audio chunk', { bytes: data.length });
              self.handlePCMAudioChunk(data);
            } else {
              try {
                const message = JSON.parse(data.toString());
                if (message.type === 'tts_complete') {
                  self.logger.info('TTS audio stream complete');
                }
              } catch (e) {
                // Ignore non-JSON messages
              }
            }
          });
          
          audioWs.on('close', (code, reason) => {
            self.logger.warn('RT Gateway audio stream closed after reconnection', { code, reason: reason?.toString() });
            self.audioStream = null;
            
            // Don't reconnect if bot is stopping
            if (self.shouldStop) {
              return;
            }
            
            // Don't reconnect for intentional close
            if (code === 1000) {
              return;
            }
            
            // Schedule another reconnection
            self.scheduleReconnect(baseUrl, sessionId);
          });
          
          audioWs.on('error', (error) => {
            if (audioWs.readyState !== WebSocket.CLOSING && audioWs.readyState !== WebSocket.CLOSED) {
              self.logger.error('RT Gateway audio stream error after reconnection', { error: error.message });
            }
          });
        });
        
        audioWs.once('error', (error) => {
          self.logger.warn('Reconnection attempt failed', { error: error.message, attempt: self.reconnectAttempts });
          self.audioStream = null;
          
          // Don't reconnect if bot is stopping
          if (self.shouldStop) {
            self.isReconnecting = false;
            return;
          }
          
          // Schedule another reconnection attempt
          self.scheduleReconnect(baseUrl, sessionId);
        });
        
        audioWs.once('close', (code, reason) => {
          // If connection closes before 'open', trigger reconnection
          if (self.audioStream !== audioWs) {
            self.logger.warn('Reconnection closed before opening', { code, reason: reason?.toString() });
            self.scheduleReconnect(baseUrl, sessionId);
          }
        });
        
      } catch (error) {
        this.logger.error('Error during reconnection attempt', { error: error.message });
        this.isReconnecting = false;
        // Schedule another reconnection attempt
        this.scheduleReconnect(baseUrl, sessionId);
      }
    }, delay);
  }

  /**
   * Handle incoming PCM audio chunk from rt_gateway
   */
  handlePCMAudioChunk(buffer) {
    // Convert buffer to Buffer if it's already a Buffer
    const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    
    // Unpack float32 samples from binary buffer
    const samples = [];
    for (let i = 0; i < buf.length; i += 4) {
      if (i + 4 <= buf.length) {
        const sample = buf.readFloatLE(i);
        samples.push(sample);
      }
    }
    
    this.logger.info('Unpacked PCM samples', { bytes: buf.length, samples: samples.length });
    
    // Filter out silent samples and check if we have audio
    const nonZeroSamples = samples.filter(s => Math.abs(s) > 0.0001);
    
    // Ignore very small chunks (likely residual/noise) - require at least 100 samples
    if (samples.length < 100) {
      this.logger.debug('Received very small PCM chunk, ignoring', { samples: samples.length, nonZero: nonZeroSamples.length });
      return;
    }
    
    if (nonZeroSamples.length > 0 && samples.length > 0) {
      // Inject PCM samples directly into virtual mic
      this.playAudioToMeeting(samples).catch(error => {
        this.logger.error('Failed to inject PCM audio into meeting', { error: error.message });
      });
    } else {
      this.logger.debug('Received silent PCM chunk, skipping');
    }
  }

  registerGateway() {
    if (!this.gateway || this.gateway.readyState !== WebSocket.OPEN) {
      return;
    }
    const registrationMessage = {
      type: 'bot_registration',
      sessionId: this.config.sessionId,
      meetingId: this.config.meetingId,
      botName: this.config.botName,
      platform: this.config.platform,
      audioConfig: {
        sampleRate: this.config.audioSampleRate,
        channels: this.config.audioChannels
      }
    };
    this.gateway.send(JSON.stringify(registrationMessage));
  }

  async launchBrowser() {
    this.logger.info('Launching Chromium with Playwright');

    this.browser = await chromium.launch({
      headless: this.config.headless,
      args: this.config.browserArgs
    });

    const contextOptions = {
      viewport: { width: 1280, height: 720 },
      ignoreHTTPSErrors: true,
      locale: this.config.browserLocale,
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
    };
    
    if (this.config.storageState) {
      const statePath = path.resolve(this.config.storageState);
      if (fs.existsSync(statePath)) {
        this.logger.info('Using Playwright storageState for authenticated session', { storageState: statePath });
        contextOptions.storageState = statePath;
      } else {
        this.logger.warn('Configured STORAGE_STATE not found; continuing without saved auth', { storageState: statePath });
      }
    }
    this.context = await this.browser.newContext(contextOptions);

    this.page = await this.context.newPage();
    
    // Block protocol handler redirects and Teams launcher pages to prevent Teams app popup
    await this.page.route('**/*', (route) => {
      const url = route.request().url();
      // Block msteams:// protocol handler redirects
      if (url.startsWith('msteams://')) {
        this.logger.info('Blocked Teams app protocol handler', { url });
        route.abort();
        return;
      }
      // Block Teams launcher page which triggers the macOS system dialog
      if (url.includes('/dl/launcher/launcher.html') || url.includes('teams.live.com/dl/')) {
        this.logger.info('Blocked Teams launcher page - will use direct meeting URL', { url });
        route.abort();
        return;
      }
      route.continue();
    });
    
    // Handle dialog events (like Teams app popup) - auto-dismiss
    this.page.on('dialog', async (dialog) => {
      const dialogType = dialog.type();
      const dialogMessage = dialog.message();
      this.logger.info('Browser dialog detected', { type: dialogType, message: dialogMessage.substring(0, 100) });
      
      // Auto-dismiss dialogs that might be asking to open Teams app
      if (dialogType === 'beforeunload' || dialogMessage.includes('Teams') || dialogMessage.includes('msteams')) {
        this.logger.info('Auto-dismissing Teams app dialog');
        await dialog.dismiss().catch(() => {});
        return;
      }
      
      // Default: dismiss all dialogs
      await dialog.dismiss().catch(() => {});
    });
    
    // Capture console logs from the page
    this.page.on('console', (msg) => {
      const text = msg.text();
      if (text.includes('[Clerk]')) {
        this.logger.info('Browser console', { message: text });
      }
    });
    
    this.page.on('pageerror', (error) => {
      this.logger.error('Browser page error', { error: error.message });
    });
    // Handle page/browser close events - trigger cleanup and notify backend
    this.page.on('close', async () => {
      this.logger.warn('Browser page closed - triggering cleanup');
      // Stop the bot and clean up when page closes unexpectedly
      if (!this.shouldStop) {
        await this.requestStop('browser_closed');
        // Leave meeting and notify backend
        if (this.isJoined && !this.hasLeft) {
          await this.leaveMeeting('browser_closed');
        }
        // Cleanup will be called when shouldStop is set
        await this.cleanup();
      }
    });
    this.browser.on('disconnected', async () => {
      this.logger.warn('Browser disconnected - triggering cleanup');
      // Stop the bot and clean up when browser disconnects
      if (!this.shouldStop) {
        await this.requestStop('browser_disconnected');
        // Leave meeting and notify backend
        if (this.isJoined && !this.hasLeft) {
          await this.leaveMeeting('browser_disconnected');
        }
        // Cleanup will be called when shouldStop is set
        await this.cleanup();
      }
    });
    
    // Block Teams app protocol handlers and launcher redirects via JavaScript interception (before navigation)
    await this.page.addInitScript(() => {
      // Override window.location to block msteams:// protocol handlers and launcher redirects
      const originalLocationSetter = Object.getOwnPropertyDescriptor(window, 'location').set;
      Object.defineProperty(window, 'location', {
        set: function(value) {
          if (typeof value === 'string') {
            if (value.startsWith('msteams://')) {
              console.log('[Clerk] Blocked Teams app redirect:', value);
              return; // Block the redirect
            }
            // Block redirects to launcher page
            if (value.includes('/dl/launcher/') || value.includes('teams.live.com/dl/')) {
              console.log('[Clerk] Blocked Teams launcher redirect:', value);
              return; // Block the redirect
            }
          }
          return originalLocationSetter.call(window, value);
        },
        get: function() {
          return window.document.location;
        },
        configurable: true
      });
      
      // Also block attempts to open Teams via window.open
      const originalOpen = window.open;
      window.open = function(url, ...args) {
        if (typeof url === 'string') {
          if (url.startsWith('msteams://') || url.includes('/dl/launcher/')) {
            console.log('[Clerk] Blocked Teams app/launcher window.open:', url);
            return null;
          }
        }
        return originalOpen.apply(window, [url, ...args]);
      };
      
      // Block protocol handler links and launcher links
      document.addEventListener('click', (e) => {
        const link = e.target.closest('a');
        if (link && link.href) {
          if (link.href.startsWith('msteams://') || link.href.includes('/dl/launcher/')) {
            console.log('[Clerk] Blocked Teams app/launcher link click');
            e.preventDefault();
            e.stopPropagation();
            return false;
          }
        }
      }, true); // Use capture phase to catch early
      
      // Also intercept form submissions that might trigger launcher
      document.addEventListener('submit', (e) => {
        const form = e.target;
        if (form && form.action && (form.action.includes('/dl/launcher/') || form.action.startsWith('msteams://'))) {
          console.log('[Clerk] Blocked Teams launcher form submission');
          e.preventDefault();
          e.stopPropagation();
          return false;
        }
      }, true);
      
      console.log('[Clerk] Teams protocol handler and launcher blocker installed');
    });
    
    // Inject config into page so Web Speech API can access sessionId and meetingId
    await this.page.addInitScript((config) => {
      window.__clerkConfig = {
        sessionId: config.sessionId,
        meetingId: config.meetingId
      };
      console.log('[Clerk] Config injected into page', window.__clerkConfig);
    }, {
      sessionId: this.config.sessionId,
      meetingId: this.config.meetingId
    });

    // Inject virtual microphone BEFORE navigation
    await this.page.addInitScript(() => {
      // Simple virtual mic setup that injects audio
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (AudioContextClass) {
        // If a virtual mic is already installed by later scripts, do not install another
        if (window.clerkVirtualMic) {
          console.log('[Clerk] Virtual mic already present - skipping early installer');
          return;
        }
        const context = new AudioContextClass({ sampleRate: 48000 });
        const VirtualMic = {
          ctx: context,
          audioBuffer: [],
          readIndex: 0, // Track where we are in the buffer
          lastOutputValue: 0, // Last output sample for smooth transitions
          lastInjectionTime: 0, // Track when audio was last injected
          muteTimeoutId: null, // Timeout to auto-mute after silence
          mediaStreamDestination: context.createMediaStreamDestination(),
          scriptNode: null,
          gainNode: null,
          
          init: function() {
            if (!this.scriptNode) {
              // Create gain node so we can tweak output level if needed
              this.gainNode = context.createGain();
              // Start muted - will be unmuted when audio is injected
              this.gainNode.gain.setValueAtTime(0.0, context.currentTime);
              this.isMuted = true;
              
              this.scriptNode = context.createScriptProcessor(4096, 0, 1);
              
              this.scriptNode.onaudioprocess = (e) => {
                const output = e.outputBuffer.getChannelData(0);
                const buffer = this.audioBuffer;
                const bufferLength = buffer.length;
                const outputLength = output.length;
                
                // Check if buffer has been fully consumed
                if (this.readIndex >= bufferLength) {
                  // Buffer is empty - output COMPLETE silence to prevent clicking
                  // If we were previously outputting audio, fade out smoothly
                  if (Math.abs(this.lastOutputValue) > 0.001) {
                    // Fade out from last value to silence over first 128 samples (~2.7ms at 48kHz)
                    const fadeLength = Math.min(128, outputLength);
                    for (let i = 0; i < outputLength; i++) {
                      if (i < fadeLength) {
                        const fadeProgress = i / fadeLength;
                        output[i] = this.lastOutputValue * (1 - fadeProgress);
                      } else {
                        output[i] = 0; // Complete silence
                      }
                    }
                    this.lastOutputValue = 0;
                  } else {
                    // Already silent - output zeros immediately
                    for (let i = 0; i < outputLength; i++) {
                      output[i] = 0;
                    }
                  }
                  
                  // Clear buffer completely when empty
                  if (bufferLength > 0) {
                    this.audioBuffer.length = 0;
                  }
                  this.readIndex = 0;
                  
                  // Mute gain node immediately when buffer is empty to ensure complete silence
                  // Don't wait - mute right away to prevent any playback from small residual chunks
                  if (!this.isMuted && this.gainNode) {
                    const now = this.ctx.currentTime;
                    // Smoothly mute over 10ms to prevent clicks
                    this.gainNode.gain.cancelScheduledValues(now);
                    this.gainNode.gain.setValueAtTime(this.gainNode.gain.value, now);
                    this.gainNode.gain.linearRampToValueAtTime(0.0, now + 0.01);
                    this.isMuted = true;
                    
                    // Clear any pending mute timeout
                    if (this.muteTimeoutId) {
                      clearTimeout(this.muteTimeoutId);
                      this.muteTimeoutId = null;
                    }
                    
                    console.log('[Clerk] Muted gain node - buffer empty');
                  }
                  return; // Exit early when buffer is empty
                }
                
                // Read samples from buffer starting at readIndex with smooth transitions
                let lastSample = this.lastOutputValue || 0;
                let samplesRead = 0;
                
                for (let i = 0; i < outputLength; i++) {
                  if (this.readIndex < bufferLength) {
                    const sample = buffer[this.readIndex++];
                    // Smooth transition from previous sample to prevent clicks
                    if (samplesRead === 0 && Math.abs(sample - lastSample) > 0.1) {
                      // Apply crossfade for first sample if there's a big jump
                      output[i] = lastSample * 0.3 + sample * 0.7;
                    } else {
                      output[i] = sample;
                    }
                    lastSample = sample;
                    samplesRead++;
                  } else {
                    // Buffer exhausted mid-frame - smooth fade to silence
                    const fadeStart = i;
                    const fadeLength = Math.min(64, outputLength - fadeStart);
                    const fadeProgress = (i - fadeStart) / fadeLength;
                    
                    if (fadeProgress < 1) {
                      output[i] = lastSample * (1 - fadeProgress);
                    } else {
                      output[i] = 0;
                    }
                    lastSample = output[i];
                  }
                }
                
                this.lastOutputValue = lastSample;
                
                // Trim consumed samples periodically to prevent memory growth
                // Only trim when we're well ahead to avoid interrupting playback
                // But don't trim if we're still within reasonable bounds
                if (this.readIndex > 50000 && bufferLength > 20000) {
                  // Only trim if we've consumed a lot and buffer is large
                  const trimAmount = Math.min(20000, this.readIndex - 20000);
                  if (trimAmount > 0 && this.readIndex - trimAmount < bufferLength) {
                    this.audioBuffer.slice(trimAmount);
                    this.readIndex -= trimAmount;
                  }
                }
                
                // Log progress occasionally (only when processing audio)
                if (Math.random() < 0.01) {
                  const remaining = Math.max(0, bufferLength - this.readIndex);
                  console.log('[Clerk] Audio processing:', { readIndex: this.readIndex, total: bufferLength, remaining });
                }
              };
              
              // Note: ScriptProcessorNode with 0 input channels doesn't need input connection
              // The oscillator is NOT needed and might cause noise - removed
              // ScriptProcessorNode will process automatically when connected to destination
              
              // Connect through gain node for amplification
              this.scriptNode.connect(this.gainNode);
              this.gainNode.connect(this.mediaStreamDestination);
              console.log('[Clerk] Virtual mic initialized with gain amplification');
            }
          },
          
          // Note: Audio is continuously processed by ScriptProcessorNode
          
          getStream: function() {
            this.init();
            const stream = this.mediaStreamDestination.stream;
            console.log('[Clerk] getStream called, returning stream with', stream.getAudioTracks().length, 'tracks');
            stream.getAudioTracks().forEach((track, i) => {
              console.log('[Clerk] Track', i, ':', { id: track.id, kind: track.kind, enabled: track.enabled, readyState: track.readyState });
            });
            return stream;
          },
          
          injectAudio: function(samples) {
            this.init();
            if (!Array.isArray(samples) || samples.length === 0) {
              console.warn('[Clerk] injectAudio called with empty samples');
              return;
            }

            // Ignore very small chunks (likely residual/noise) - require at least 300 samples (18.75ms at 16kHz)
            // This prevents tiny chunks from continuously unmuting the gain
            if (samples.length < 300) {
              console.debug('[Clerk] Ignoring very small audio chunk', { samples: samples.length });
              return;
            }

            // Update injection timestamp
            this.lastInjectionTime = Date.now();
            
            // Clear any pending mute timeout since we're injecting new audio
            if (this.muteTimeoutId) {
              clearTimeout(this.muteTimeoutId);
              this.muteTimeoutId = null;
            }
            
            // Unmute gain when injecting substantial audio
            if (this.isMuted && this.gainNode) {
              // Smoothly unmute over 10ms to prevent clicks
              const now = this.ctx.currentTime;
              this.gainNode.gain.setValueAtTime(0.0, now);
              this.gainNode.gain.linearRampToValueAtTime(1.5, now + 0.01); // Unmute to 1.5x gain over 10ms
              this.isMuted = false;
              console.log('[Clerk] Unmuted gain node for audio injection');
            }
            
            // Schedule auto-mute if no more audio is injected for 200ms after buffer is consumed
            // Shorter timeout to prevent continuous sound from leftover buffer data
            if (this.muteTimeoutId) {
              clearTimeout(this.muteTimeoutId);
            }
            const self = this;
            this.muteTimeoutId = setTimeout(() => {
              // Check if buffer is empty or almost empty
              if (self.readIndex >= self.audioBuffer.length) {
                // Buffer consumed - force mute immediately
                if (!self.isMuted && self.gainNode) {
                  const now = self.ctx.currentTime;
                  self.gainNode.gain.cancelScheduledValues(now);
                  self.gainNode.gain.setValueAtTime(self.gainNode.gain.value, now);
                  self.gainNode.gain.linearRampToValueAtTime(0.0, now + 0.01);
                  self.isMuted = true;
                  console.log('[Clerk] Auto-muted gain node after buffer consumed');
                }
              }
              self.muteTimeoutId = null;
            }, 200); // Mute after 200ms of no new audio injections

            // Resample from 16kHz (input) to 48kHz (context sampleRate) and apply gain
            const inRate = 16000;
            const outRate = this.ctx.sampleRate || 48000;
            const gain = 1.0; // Apply gain at the gain node instead
            const ratio = outRate / inRate;
            const outLen = Math.max(1, Math.floor(samples.length * ratio));
            const processed = new Array(outLen);
            
            let nonZeroCount = 0;
            let clippedCount = 0;
            
            for (let i = 0; i < outLen; i++) {
              // Linear interpolation for resampling
              const t = i / ratio;
              const idx = Math.floor(t);
              const frac = t - idx;
              const a = samples[idx] || 0;
              const b = samples[idx + 1] || a;
              let value = (a + (b - a) * frac) * gain;
              
              // Clip to valid range
              if (value > 1) {
                value = 1;
                clippedCount++;
              } else if (value < -1) {
                value = -1;
                clippedCount++;
              }
              
              if (Math.abs(value) > 0.001) {
                nonZeroCount++;
              }
              
              processed[i] = value;
            }

            // Append to buffer (don't clear it!)
            this.audioBuffer.push(...processed);

            const preview = processed.slice(0, 5).map(s => s.toFixed(3));
            console.log('[Clerk] Injected', samples.length, 'samples (resampled to', outLen, '):', {
              bufferLength: this.audioBuffer.length,
              readIndex: this.readIndex,
              nonZeroSamples: nonZeroCount,
              clippedSamples: clippedCount,
              firstSamples: preview,
              hasAudio: nonZeroCount > 0
            });
          },
          
          test: function(count = 3) {
            console.log('[Clerk] Testing with', count, 'beeps');
            const sampleRate = 16000;
            const duration = 0.3;
            const silence = 0.2;
            const freq = 440;
            const vol = 0.7;
            for (let beep = 0; beep < count; beep++) {
              for (let i = 0; i < sampleRate * duration; i++) {
                this.audioBuffer.push(Math.sin(2 * Math.PI * freq * i / sampleRate) * vol);
              }
              for (let i = 0; i < sampleRate * silence; i++) this.audioBuffer.push(0);
            }
            console.log('[Clerk] Injected', count, 'beeps, samples:', this.audioBuffer.length);
          }
        };
        
        window.clerkVirtualMic = VirtualMic;
        console.log('[Clerk] Virtual microphone setup complete');
        
        // Function to decode MP3 audio in the browser
        window.clerkDecodeAudio = async function(mp3ArrayBuffer) {
          console.log('[Clerk] Decoding MP3 audio', { size: mp3ArrayBuffer.byteLength });
          const audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
          
          try {
            const audioBuffer = await audioContext.decodeAudioData(mp3ArrayBuffer);
            const samples = Array.from(audioBuffer.getChannelData(0));
            console.log('[Clerk] Decoded audio successfully', { samples: samples.length, duration: samples.length / audioBuffer.sampleRate });
            return samples;
          } catch (error) {
            console.error('[Clerk] Failed to decode audio', error);
            throw error;
          }
        };
        
        // Intercept getUserMedia
        const originalGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        navigator.mediaDevices.getUserMedia = async function(constraints) {
          console.log('[Clerk] getUserMedia called', constraints);
          if (constraints.audio) {
            console.log('[Clerk] Returning virtual mic');
            const stream = window.clerkVirtualMic.getStream();
            
            // Monitor the stream to ensure it's being used
            stream.getAudioTracks().forEach((track, i) => {
              console.log('[Clerk] Stream track', i, 'state:', {
                enabled: track.enabled,
                muted: track.muted,
                readyState: track.readyState,
                settings: track.getSettings()
              });
              
              // Listen for track events
              track.addEventListener('ended', () => console.log('[Clerk] Track ended'));
              track.addEventListener('mute', () => console.log('[Clerk] Track muted'));
              track.addEventListener('unmute', () => console.log('[Clerk] Track unmuted'));
            });
            
            return stream;
          }
          return originalGetUserMedia(constraints);
        };
      }
    });
    
    this.platform = createPlatformController(this.config.platform, this.page, this.config, this.logger.child({ subsystem: 'platform' }));

    if (typeof this.platform.beforeNavigate === 'function') {
      await this.platform.beforeNavigate();
    }

    this.logger.info('Navigating to meeting URL', { url: this.config.meetingUrl });
    try {
      await this.page.goto(this.config.meetingUrl, {
        waitUntil: 'networkidle',
        timeout: this.config.navigationTimeoutMs
      });
      
      // Wait a moment for any redirects/protocol handlers to be blocked
      await this.page.waitForTimeout(1000);
      
      this.logger.info('Navigation completed', { url: this.page.url(), title: await this.page.title().catch(() => '') });
    } catch (error) {
      this.logger.warn('Navigation failed, trying with domcontentloaded', { error: error.message });
      await this.page.goto(this.config.meetingUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 30000
      });
      
      // Wait a moment for any redirects/protocol handlers to be blocked
      await this.page.waitForTimeout(1000);
      
      this.logger.info('Navigation completed with fallback', { url: this.page.url(), title: await this.page.title().catch(() => '') });
    }

    if (typeof this.platform.afterNavigate === 'function') {
      await this.platform.afterNavigate();
    }
  }

  async joinMeeting() {
    this.logger.info('Starting deterministic join flow');
    
    // Execute the join flow (beforeJoin -> performJoin -> ensureJoined -> afterJoin)
    await this.platform.joinMeeting();
    
    // Notify backend IMMEDIATELY after join action completes
    // The join action (performJoin) has already completed, so we're in the meeting
    this.logger.info('✅ Join action completed - notifying backend immediately');
    this.isJoined = true;
    this.lastMeetingActiveTs = Date.now();
    
    // Notify backend right away - don't wait for UI verification
    await this.notifyLifecycle('meeting_joined', {
      meeting_id: this.config.meetingId,
      session_id: this.config.sessionId,
      platform: this.config.platform,
      bot_name: this.config.botName
    });
    await this.notifyMeetingJoined();
    
    // Verify UI elements in the background (non-blocking)
    // This is just for validation, not for notification
    this.logger.info('Verifying meeting UI elements (non-blocking)');
    setTimeout(async () => {
      try {
        const hasJoined = await this.platform.hasBotJoined();
        if (hasJoined) {
          this.logger.info('✅ Meeting UI verification successful');
        } else {
          this.logger.warn('⚠️ Meeting UI verification failed - bot may still be joining');
        }
      } catch (error) {
        this.logger.debug('Error verifying meeting UI', { error: error.message });
      }
    }, 2000); // Check after 2 seconds

    if (this.config.enableTtsPlayback && this.ttsService) {
      // Speak immediately after joining
      this.logger.info('Scheduling initial speech', { delayMs: 0, enableTts: this.config.enableTtsPlayback, hasTtsService: !!this.ttsService });
      this.scheduleInitialSpeech(0, 'Please introduce yourself');
    } else {
      this.logger.warn('TTS not scheduled', { enableTts: this.config.enableTtsPlayback, hasTtsService: !!this.ttsService });
    }
  }

  async initializeMedia() {
    if (!this.config.enableAudioCapture) {
      this.logger.info('Audio capture disabled by configuration');
      return;
    }

    try {
      await this.startAudioCapture();
      this.logger.info('✅ Audio capture script initialized and active', { 
        audioCaptureActive: this.audioCaptureActive,
        hasAudioInput: !!this.audioInputStream,
        audioInputReadyState: this.audioInputStream?.readyState
      });
    } catch (error) {
      this.logger.warn('Audio capture initialization failed', { error: error.message });
    }
  }

  scheduleInitialSpeech(delayMs, prompt = 'Please introduce yourself') {
    if (!this.config.enableTtsPlayback || !this.ttsService) {
      return;
    }

    const delay = Number.isFinite(delayMs) && delayMs > 0 ? delayMs : 5000;
    if (this.initialSpeechTimeout) {
      return;
    }

    this.initialSpeechTimeout = setTimeout(async () => {
      this.initialSpeechTimeout = null;
      try {
        this.logger.info('Triggering initial TTS playback', { delayMs: delay, prompt });
        await this.speakLLMResponse(prompt);
      } catch (error) {
        this.logger.error('Initial TTS playback failed', { error: error.message });
      }
    }, delay);
  }

  async startAudioCapture() {
    await this.page.exposeBinding('clerkEmitAudioFrame', async (_source, payload) => {
      this.handleAudioFrame(payload);
    });
    
    await this.page.exposeFunction('clerkPlayAudioToMic', async (audioData) => {
      return this.playAudioToMeeting(audioData);
    });

    // Expose binding to send transcripts from Web Speech API

    // Inject script directly into the page (works even if page is already loaded)
    // NOTE: Do NOT overwrite window.clerkVirtualMic - it's already set up in launchBrowser()
    const audioCaptureScript = `
      (function setupClerkAudioCapture() {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextClass) {
          console.error('AudioContext not supported in this browser');
          return;
        }

        const context = new AudioContextClass({ sampleRate: 48000 });
        
        // Try to capture audio from the page's audio output by hooking into the destination
        // Create a MediaStreamDestination to capture all audio
        const captureDestination = context.createMediaStreamDestination();
        
        const processor = context.createScriptProcessor(2048, 1, 1);
        const gain = context.createGain();
        gain.gain.value = 0; // prevent audio feedback while keeping graph alive
        
        // CRITICAL: ScriptProcessorNode MUST be connected to a destination to process audio
        // Connect processor -> gain -> destination to keep the audio graph active
        processor.connect(gain);
        gain.connect(context.destination);
        
        // Also try to capture from the page's master AudioContext if we can find it
        let masterContext = null;
        try {
          // Look for existing AudioContext instances (Teams might have one)
          for (let key in window) {
            try {
              const value = window[key];
              if (value instanceof AudioContext || value instanceof webkitAudioContext) {
                if (!masterContext || value.state === 'running') {
                  masterContext = value;
                }
              }
            } catch (e) {}
          }
        } catch (e) {}
        
        // If we found a master context, try to hook into it
        if (masterContext && masterContext !== context) {
          console.log('[Clerk] Found master AudioContext, attempting to intercept audio');
          
          // Create a script processor on the master context to capture all audio
          const masterProcessor = masterContext.createScriptProcessor(2048, 1, 1);
          
          masterProcessor.onaudioprocess = (event) => {
            if (!captureState.active) return;
            
            const input = event.inputBuffer.getChannelData(0);
            const output = Array.from(input);
            
            const hasAudio = output.some(sample => Math.abs(sample) > 0.001);
            
            if (hasAudio) {
              captureState.sequence = (captureState.sequence + 1) % Number.MAX_SAFE_INTEGER;
              
              if (captureState.sequence <= 5) {
                console.log('[Clerk] Master AudioContext audio captured', {
                  sequence: captureState.sequence,
                  samples: output.length,
                  maxSample: Math.max(...output.map(Math.abs))
                });
              }
              
              window.clerkEmitAudioFrame({
                sequence: captureState.sequence,
                timestamp: performance.now(),
                samples: output
              });
            }
          };
          
          // Try to connect to destination (this might not work due to security, but worth trying)
          try {
            // Create an oscillator to keep the processor active
            const osc = masterContext.createOscillator();
            osc.frequency.setValueAtTime(0.001, masterContext.currentTime);
            osc.connect(masterProcessor);
            osc.start();
            masterProcessor.connect(masterContext.destination);
            
            console.log('[Clerk] Hooked into master AudioContext');
          } catch (error) {
            console.log('[Clerk] Could not hook into master AudioContext:', error.message);
          }
        }

        const captureState = {
          context,
          processor,
          gain,
          active: false,
          sequence: 0,
          sources: new Map(),
          audioQueue: []
        };
        
        // CRITICAL: Do NOT overwrite window.clerkVirtualMic if it already exists!
        // The virtual mic is already set up in launchBrowser() and must be preserved
        if (!window.clerkVirtualMic) {
          console.warn('[Clerk] Virtual mic not found! It should have been set up earlier.');
        } else {
          console.log('[Clerk] Virtual mic already exists, preserving it for audio injection');
        }

        const attachTrack = (track) => {
          if (!track || track.kind !== 'audio' || captureState.sources.has(track.id)) {
            if (track && track.kind === 'audio') {
              console.log('[Clerk] Skipping track (already attached or invalid)', {
                trackId: track.id,
                alreadyAttached: captureState.sources.has(track.id),
                enabled: track.enabled,
                readyState: track.readyState
              });
            }
            return;
          }

          console.log('[Clerk] ✅ Attaching remote audio track', { 
            trackId: track.id, 
            enabled: track.enabled, 
            muted: track.muted,
            readyState: track.readyState,
            label: track.label || 'unknown'
          });
          
          try {
            const stream = new MediaStream([track]);
            const sourceNode = context.createMediaStreamSource(stream);
            
            // CRITICAL FIX: Connect source to processor directly for capture
            // Also connect to gain for output chain (but gain=0 prevents feedback)
            sourceNode.connect(captureState.processor);  // Direct connection for capture
            sourceNode.connect(captureState.gain);      // Output chain (muted)
            
            captureState.sources.set(track.id, { stream, sourceNode, track });
            
            console.log('[Clerk] ✅ Remote track attached and connected to processor', {
              trackId: track.id,
              sourceCount: captureState.sources.size,
              processorConnected: !!processor
            });
            
            // Log track state periodically to monitor
            setInterval(() => {
              if (track.readyState === 'live' && track.enabled) {
                console.log('[Clerk] Track still active', {
                  trackId: track.id,
                  enabled: track.enabled,
                  muted: track.muted,
                  readyState: track.readyState
                });
              }
            }, 10000); // Every 10 seconds
          } catch (error) {
            console.error('[Clerk] ❌ Failed to attach track', {
              trackId: track.id,
              error: error.message
            });
          }
        };

        // Intercept RTCPeerConnection track events to capture remote audio
        const originalAddEventListener = RTCPeerConnection.prototype.addEventListener;
        RTCPeerConnection.prototype.addEventListener = function patchedAddEventListener(type, listener, options) {
          if (type === 'track' && typeof listener === 'function') {
            const wrapped = function wrappedTrackListener(event) {
              console.log('[Clerk] RTCPeerConnection track event intercepted', {
                trackId: event.track?.id,
                kind: event.track?.kind,
                enabled: event.track?.enabled
              });
              try {
                attachTrack(event.track);
              } catch (error) {
                console.error('clerkAttachRemoteTrack error', error);
              }
              return listener.call(this, event);
            };
            return originalAddEventListener.call(this, type, wrapped, options);
          }
          return originalAddEventListener.call(this, type, listener, options);
        };
        
        // Also intercept getReceivers() which Teams might use
        const originalGetReceivers = RTCPeerConnection.prototype.getReceivers;
        if (originalGetReceivers) {
          RTCPeerConnection.prototype.getReceivers = function() {
            const receivers = originalGetReceivers.call(this);
            receivers.forEach(receiver => {
              if (receiver.track && receiver.track.kind === 'audio') {
                console.log('[Clerk] Found audio receiver track', {
                  trackId: receiver.track.id,
                  enabled: receiver.track.enabled
                });
                attachTrack(receiver.track);
              }
            });
            return receivers;
          };
        }
        
        // Intercept addTrack/removeTrack methods
        const originalAddTrack = RTCPeerConnection.prototype.addTrack;
        if (originalAddTrack) {
          RTCPeerConnection.prototype.addTrack = function(track, ...streams) {
            console.log('[Clerk] RTCPeerConnection.addTrack called', {
              trackId: track?.id,
              kind: track?.kind
            });
            if (track && track.kind === 'audio') {
              attachTrack(track);
            }
            return originalAddTrack.call(this, track, ...streams);
          };
        }
        
        // Monitor MediaStreamTrack events directly
        const originalMediaStreamTrackAddEventListener = MediaStreamTrack.prototype.addEventListener;
        MediaStreamTrack.prototype.addEventListener = function(type, listener, options) {
          if (type === 'ended' || type === 'mute' || type === 'unmute') {
            const wrapped = function wrappedEventListener(event) {
              if (this.kind === 'audio' && !captureState.sources.has(this.id)) {
                console.log('[Clerk] MediaStreamTrack event detected', {
                  type: type,
                  trackId: this.id,
                  kind: this.kind,
                  enabled: this.enabled
                });
                attachTrack(this);
              }
              return listener.call(this, event);
            };
            return originalMediaStreamTrackAddEventListener.call(this, type, wrapped, options);
          }
          return originalMediaStreamTrackAddEventListener.call(this, type, listener, options);
        };

        const onTrackDescriptor = Object.getOwnPropertyDescriptor(RTCPeerConnection.prototype, 'ontrack');
        if (onTrackDescriptor && onTrackDescriptor.configurable) {
          Object.defineProperty(RTCPeerConnection.prototype, 'ontrack', {
            set(handler) {
              if (typeof handler !== 'function') {
                return onTrackDescriptor.set?.call(this, handler);
              }
              const wrapped = function wrappedOnTrack(event) {
                try {
                  attachTrack(event.track);
                } catch (error) {
                  console.error('clerkAttachRemoteTrack error', error);
                }
                return handler.call(this, event);
              };
              return onTrackDescriptor.set?.call(this, wrapped);
            },
            get() {
              return onTrackDescriptor.get?.call(this);
            }
          });
        }

        processor.onaudioprocess = (event) => {
          if (!captureState.active) {
            // Log occasionally if capture is inactive
            if (captureState.sequence % 1000 === 0) {
              console.warn('[Clerk] Audio processor received frame but capture is inactive', {
                sequence: captureState.sequence,
                sourceCount: captureState.sources.size
              });
            }
            return;
          }

          const input = event.inputBuffer.getChannelData(0);
          const output = Array.from(input);
          
          // Check if there's actual audio data
          const maxSample = Math.max(...output.map(Math.abs));
          const hasAudio = maxSample > 0.001;
          
          captureState.sequence = (captureState.sequence + 1) % Number.MAX_SAFE_INTEGER;
          
          // Log first few frames and frames with audio to debug
          if (captureState.sequence <= 10 || hasAudio) {
            console.log('[Clerk] Audio processor event', {
              sequence: captureState.sequence,
              samples: output.length,
              hasAudio: hasAudio,
              maxSample: maxSample.toFixed(6),
              sourceCount: captureState.sources.size,
              active: captureState.active
            });
          }
          
          // Log periodically to confirm processor is running
          if (captureState.sequence % 500 === 0) {
            console.log('[Clerk] Audio processor running', {
              sequence: captureState.sequence,
              sourceCount: captureState.sources.size,
              active: captureState.active,
              hasSources: captureState.sources.size > 0
            });
          }
          
          window.clerkEmitAudioFrame({
            sequence: captureState.sequence,
            timestamp: performance.now(),
            samples: output
          });
        };

        window.__clerkAudioCaptureState = captureState;
        window.clerkAttachRemoteTrack = attachTrack;

        // Poll for existing RTCPeerConnections and their tracks
        const pollForAudioTracks = () => {
          try {
            // Find all RTCPeerConnection instances
            const connections = [];
            for (let key in window) {
              try {
                const value = window[key];
                if (value instanceof RTCPeerConnection) {
                  connections.push(value);
                  // Check receivers
                  const receivers = value.getReceivers();
                  receivers.forEach(receiver => {
                    if (receiver.track && receiver.track.kind === 'audio' && receiver.track.readyState === 'live') {
                      console.log('[Clerk] Polling found audio receiver track', {
                        trackId: receiver.track.id,
                        enabled: receiver.track.enabled
                      });
                      attachTrack(receiver.track);
                    }
                  });
                }
              } catch (e) {
                // Ignore access errors
              }
            }
            
            // Also check for any MediaStreamTracks in the document
            if (document.querySelectorAll) {
              // Look for audio/video elements that might have tracks
              const mediaElements = document.querySelectorAll('audio, video');
              mediaElements.forEach(element => {
                if (element.srcObject instanceof MediaStream) {
                  element.srcObject.getAudioTracks().forEach(track => {
                    if (track.readyState === 'live') {
                      console.log('[Clerk] Polling found audio track in media element', {
                        trackId: track.id
                      });
                      attachTrack(track);
                    }
                  });
                }
              });
            }
          } catch (error) {
            console.error('[Clerk] Error polling for audio tracks', error);
          }
        };
        
        // Watch for new audio/video elements being added to the DOM
        const audioObserver = new MutationObserver((mutations) => {
          mutations.forEach((mutation) => {
            mutation.addedNodes.forEach((node) => {
              if (node.nodeType === 1) { // Element node
                // Check if it's an audio/video element
                if (node.tagName === 'AUDIO' || node.tagName === 'VIDEO') {
                  console.log('[Clerk] New audio/video element detected', {
                    tagName: node.tagName,
                    hasSrcObject: !!node.srcObject
                  });
                  
                  if (node.srcObject instanceof MediaStream) {
                    node.srcObject.getAudioTracks().forEach(track => {
                      console.log('[Clerk] Found audio track in new element', {
                        trackId: track.id
                      });
                      attachTrack(track);
                    });
                  }
                  
                  // Watch for srcObject changes
                  const srcObjectDescriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'srcObject');
                  if (srcObjectDescriptor && srcObjectDescriptor.set) {
                    const originalSet = srcObjectDescriptor.set;
                    Object.defineProperty(node, 'srcObject', {
                      set: function(value) {
                        originalSet.call(this, value);
                        if (value instanceof MediaStream) {
                          value.getAudioTracks().forEach(track => {
                            console.log('[Clerk] Audio track set on element', {
                              trackId: track.id
                            });
                            attachTrack(track);
                          });
                        }
                      },
                      get: srcObjectDescriptor.get
                    });
                  }
                }
              }
            });
          });
        });
        
        // Start observing
        audioObserver.observe(document.body || document.documentElement, {
          childList: true,
          subtree: true
        });
        
        console.log('[Clerk] MutationObserver started to watch for audio/video elements');
        
        // Poll immediately and then periodically
        pollForAudioTracks();
        setInterval(pollForAudioTracks, 2000); // Poll every 2 seconds
        
        window.clerkStartAudioCapture = () => {
          captureState.active = true;
          if (context.state === 'suspended') {
            context.resume().catch((error) => console.error('Failed to resume AudioContext', error));
          }
          
          // Immediately poll for tracks
          pollForAudioTracks();
          
          return true;
        };

        window.clerkStopAudioCapture = () => {
          captureState.active = false;
          captureState.sources.forEach(({ sourceNode, stream }) => {
            try {
              sourceNode.disconnect();
            } catch (error) {
              console.error('Failed to disconnect source node', error);
            }
            stream.getTracks().forEach((track) => track.stop());
          });
          captureState.sources.clear();
          
          return true;
        };
      })();
    `;

    // Also add as init script for future navigations
    await this.page.addInitScript(audioCaptureScript);
    
    // Inject script directly into current page (if already loaded)
    await this.page.evaluate(audioCaptureScript);
    
    // Wait for the function to be available (with retry)
    // Note: clerkEmitAudioFrame is an exposed binding, not a function on window
    let attempts = 0;
    const maxAttempts = 10;
    while (attempts < maxAttempts) {
      const isReady = await this.page.evaluate(() => {
        return typeof window.clerkStartAudioCapture === 'function';
      });
      
      if (isReady) {
        break;
      }
      
      attempts++;
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    if (attempts >= maxAttempts) {
      throw new Error('Audio capture script failed to initialize - window.clerkStartAudioCapture not available');
    }
    
    this.logger.info('Audio capture script injected and verified');

    const started = await this.page.evaluate(() => {
      if (typeof window.clerkStartAudioCapture !== 'function') {
        return false;
      }
      return window.clerkStartAudioCapture();
    });
    if (!started) {
      throw new Error('Unable to start remote audio capture pipeline');
    }
    this.audioCaptureActive = true;
  }


  handleAudioFrame(frame) {
    if (!frame || !Array.isArray(frame.samples) || frame.samples.length === 0) {
      // Log occasionally when frames are invalid
      if (!this._invalidFrameCount) this._invalidFrameCount = 0;
      this._invalidFrameCount++;
      if (this._invalidFrameCount % 100 === 0) {
        this.logger.warn('⚠️ Invalid audio frame received', { 
          count: this._invalidFrameCount,
          frame: frame ? Object.keys(frame) : 'null'
        });
      }
      return;
    }

    this.audioFrameSequence += 1;
    
    // Check if frame has actual audio (non-zero samples)
    const maxSample = Math.max(...frame.samples.map(Math.abs));
    const hasAudioContent = maxSample > 0.001;
    
    // Log first few frames and any frames with audio to confirm audio capture is working
    if (this.audioFrameSequence <= 5 || hasAudioContent) {
      this.logger.info('🎤 Audio frame captured', { 
        sequence: this.audioFrameSequence,
        samples: frame.samples.length,
        maxSample: maxSample.toFixed(6),
        hasAudioContent: hasAudioContent,
        hasAudioInput: !!this.audioInputStream,
        audioInputOpen: this.audioInputStream?.readyState === WebSocket.OPEN,
        audioCaptureActive: this.audioCaptureActive
      });
    }

    // The audio from the capture script is at 48kHz (AudioContext sampleRate)
    // But we need to send 16kHz to the backend for STT
    // Resample from 48kHz to 16kHz (downsample by factor of 3)
    const sourceSampleRate = 48000;
    const targetSampleRate = 16000;
    const resampleFactor = sourceSampleRate / targetSampleRate; // 3
    
    // Simple decimation: take every Nth sample
    const resampledLength = Math.floor(frame.samples.length / resampleFactor);
    const resampledSamples = new Array(resampledLength);
    for (let i = 0; i < resampledLength; i += 1) {
      const sourceIndex = Math.floor(i * resampleFactor);
      resampledSamples[i] = frame.samples[sourceIndex] || 0;
    }
    
    // Convert resampled samples to PCM 16-bit
    const pcmBuffer = Buffer.alloc(resampledSamples.length * 2);
    for (let i = 0; i < resampledSamples.length; i += 1) {
      const value = Math.max(-1, Math.min(1, resampledSamples[i] || 0));
      const int16 = value < 0 ? value * 0x8000 : value * 0x7fff;
      pcmBuffer.writeInt16LE(int16, i * 2);
    }

    // Send to audio input WebSocket for STT (server-side OpenAI Whisper)
    if (this.audioInputStream && this.audioInputStream.readyState === WebSocket.OPEN) {
      try {
        this.audioInputStream.send(pcmBuffer);
        
        // Log resampling details occasionally
        if (this.audioFrameSequence % 100 === 0) {
          this.logger.info('🎤 Audio frame resampled', {
            originalSamples: frame.samples.length,
            resampledSamples: resampledSamples.length,
            originalRate: `${sourceSampleRate}Hz`,
            targetRate: `${targetSampleRate}Hz`,
            pcmBytes: pcmBuffer.length
          });
        }
        // Log occasionally to verify audio is being sent
        if (this.audioFrameSequence % 100 === 0) {
          this.logger.info('✅ Sent audio chunk to STT', { 
            bytes: pcmBuffer.length, 
            sequence: this.audioFrameSequence,
            hasAudio: this.audioCaptureActive 
          });
        }
      } catch (error) {
        this.logger.error('Failed to send audio to STT endpoint', { error: error.message });
      }
    } else {
      // Log when audio stream is not available (every 100 frames to avoid spam)
      if (this.audioFrameSequence % 100 === 0) {
        this.logger.warn('⚠️ Audio input stream not connected - audio will not be processed for LLM', { 
          hasStream: !!this.audioInputStream, 
          readyState: this.audioInputStream?.readyState,
          audioCaptureActive: this.audioCaptureActive
        });
      }
    }

    // Also send legacy format to gateway if needed (for backward compatibility)
    if (this.gateway && this.gateway.readyState === WebSocket.OPEN) {
      const message = {
        type: 'audio_stream',
        meetingId: this.config.meetingId,
        sessionId: this.config.sessionId,
        sequence: this.audioFrameSequence,
        frameSequence: frame.sequence,
        timestamp: Date.now(),
        format: 'pcm_s16le',
        sampleRate: this.config.audioSampleRate,
        channels: this.config.audioChannels,
        chunk: pcmBuffer.toString('base64')
      };
      try {
        this.gateway.send(JSON.stringify(message));
      } catch (error) {
        this.logger.error('Failed to send audio to gateway', { error: error.message });
      }
    }
  }

  async connectAudioInputGateway() {
    return new Promise((resolve) => {
      const gatewayUrl = new URL(this.config.rtGatewayUrl);
      const baseUrl = `${gatewayUrl.protocol}//${gatewayUrl.host}`;
      const sessionId = this.config.sessionId;
      
      this.logger.info('Connecting to audio input stream for STT', { url: `${baseUrl}/ws/bot_audio_input/${sessionId}` });
      
      const audioWs = new WebSocket(`${baseUrl}/ws/bot_audio_input/${sessionId}`);

      const self = this;
      
      const handleOpen = () => {
        self.logger.info('✅ Connected to audio input stream - ready to send audio for STT');
        self.audioInputStream = audioWs;
        self.audioInputReconnectAttempts = 0; // Reset on successful connection
        self.isAudioInputReconnecting = false;
        resolve(audioWs);
      };

      const handleMessage = (event) => {
        try {
          // Check if event.data exists and is valid
          if (!event || !event.data) {
            return;
          }
          
          // Only parse string data (ignore binary PCM audio)
          if (typeof event.data !== 'string') {
            return;
          }
          
          const message = JSON.parse(event.data);
          
          if (message.type === 'connected') {
            self.logger.info('✅ Audio input stream confirmed ready', { message: message.message });
          } else if (message.type === 'tts_complete') {
            self.logger.info('✅ TTS complete received');
          }
        } catch (error) {
          if (error.message && !error.message.includes('undefined')) {
            self.logger.error('Failed to parse audio input message', { error: error.message });
          }
        }
      };

      const handleError = (error) => {
        self.logger.error('Audio input stream error', { error: error.message || error });
        if (!self.shouldStop && !self.isAudioInputReconnecting) {
          self.scheduleAudioInputReconnect(baseUrl, sessionId);
        }
      };

      const handleClose = () => {
        self.logger.info('Audio input stream closed');
        self.audioInputStream = null;
        if (!self.shouldStop && !self.isAudioInputReconnecting) {
          self.scheduleAudioInputReconnect(baseUrl, sessionId);
        }
      };

      audioWs.on('open', handleOpen);
      audioWs.on('message', handleMessage);
      audioWs.on('error', handleError);
      audioWs.on('close', handleClose);
    });
  }

  scheduleAudioInputReconnect(baseUrl, sessionId) {
    if (this.shouldStop || this.isAudioInputReconnecting) {
      return;
    }
    
    this.isAudioInputReconnecting = true;
    this.audioInputReconnectAttempts += 1;
    
    const delay = this.calculateReconnectDelay(this.audioInputReconnectAttempts);
    
    this.logger.info(`Scheduling audio input reconnect attempt ${this.audioInputReconnectAttempts} in ${delay}ms`);
    
    this.audioInputReconnectTimeout = setTimeout(async () => {
      try {
        await this.connectAudioInputGateway();
      } catch (error) {
        this.logger.error('Audio input reconnect failed', { error: error.message });
        if (!this.shouldStop) {
          this.scheduleAudioInputReconnect(baseUrl, sessionId);
        }
      }
    }, delay);
  }

  async runLoop() {
    this.logger.info('Entering meeting monitoring loop - will monitor meeting presence and exit when meeting ends');

    let consecutiveInactiveChecks = 0;
    const maxInactiveChecks = Math.ceil(this.config.meetingPresenceGraceMs / this.config.meetingCheckIntervalMs);

    while (!this.shouldStop) {
      try {
        // Check if meeting is still active
        if (this.platform && this.page && !this.page.isClosed()) {
          const isActive = await this.platform.isMeetingActive();
          
          if (isActive) {
            // Meeting is active - reset counter and update timestamp
            consecutiveInactiveChecks = 0;
            this.lastMeetingActiveTs = Date.now();
            this.logger.debug('Meeting is active', {
              sessionId: this.config.sessionId,
              lastActive: new Date(this.lastMeetingActiveTs).toISOString()
            });
          } else {
            // Meeting appears inactive
            consecutiveInactiveChecks++;
            const inactiveDuration = Date.now() - this.lastMeetingActiveTs;
            
            this.logger.debug('Meeting presence check: inactive', {
              sessionId: this.config.sessionId,
              consecutiveChecks: consecutiveInactiveChecks,
              inactiveDurationMs: inactiveDuration,
              gracePeriodMs: this.config.meetingPresenceGraceMs
            });

            // If meeting has been inactive longer than grace period, exit
            if (inactiveDuration >= this.config.meetingPresenceGraceMs) {
              this.logger.info('Meeting has ended - exiting (inactive for longer than grace period)', {
                sessionId: this.config.sessionId,
                inactiveDurationMs: inactiveDuration,
                gracePeriodMs: this.config.meetingPresenceGraceMs
              });
              await this.requestStop('meeting_ended');
              break;
            }
          }
        } else {
          // Page/browser closed - exit
          if (!this.page || this.page.isClosed()) {
            this.logger.warn('Browser page closed - exiting');
            await this.requestStop('page_closed');
            break;
          }
        }
      } catch (error) {
        // Log error but continue monitoring (don't exit on transient errors)
        this.logger.warn('Error checking meeting presence', {
          error: error.message,
          sessionId: this.config.sessionId
        });
      }

      // Wait before next check
      await new Promise((resolve) => setTimeout(resolve, this.config.meetingCheckIntervalMs));
    }
    
    this.logger.info('Exiting meeting monitoring loop', {
      reason: this.stopReason,
      sessionId: this.config.sessionId
    });
  }

  async requestStop(reason = 'requested') {
    if (this.shouldStop) {
      return;
    }
    this.shouldStop = true;
    this.stopReason = reason;
    this.logger.info('Stop requested', { reason });
  }

  async leaveMeeting(reason = 'completed') {
    if (this.hasLeft) {
      return;
    }

    this.hasLeft = true;
    this.isJoined = false;

    try {
      if (this.platform) {
        await this.platform.leaveMeeting();
      }
    } catch (error) {
      this.logger.warn('Failed to execute platform leave command', { error: error.message });
    }

    await this.notifyMeetingLeft(reason);
    await this.notifyLifecycle('meeting_left', {
      meeting_id: this.config.meetingId,
      session_id: this.config.sessionId,
      reason
    });
  }

  async cleanup() {
    this.logger.info('Cleaning up browser bot resources', {
      stopReason: this.stopReason
    });

    if (this.initialSpeechTimeout) {
      clearTimeout(this.initialSpeechTimeout);
      this.initialSpeechTimeout = null;
    }

    // Cancel audio input reconnection
    if (this.audioInputReconnectTimeout) {
      clearTimeout(this.audioInputReconnectTimeout);
      this.audioInputReconnectTimeout = null;
    }
    this.isAudioInputReconnecting = false;
    
    // Close audio input stream
    if (this.audioInputStream && this.audioInputStream.readyState === WebSocket.OPEN) {
      try {
        this.audioInputStream.close();
      } catch (error) {
        this.logger.warn('Error closing audio input stream', { error: error.message });
      }
    }
    this.audioInputStream = null;
    
    if (this.audioCaptureActive) {
      try {
        await this.page.evaluate(() => window.clerkStopAudioCapture());
      } catch (error) {
        this.logger.warn('Failed to stop audio capture', { error: error.message });
      }
      this.audioCaptureActive = false;
    }

    if (this.isJoined && !this.hasLeft) {
      await this.leaveMeeting(this.stopReason || 'cleanup');
    }

    if (this.page && !this.page.isClosed()) {
      try {
        await this.page.close({ runBeforeUnload: false });
      } catch (error) {
        this.logger.warn('Error closing page', { error: error.message });
      }
    }

    if (this.context) {
      try {
        await this.context.close();
      } catch (error) {
        this.logger.warn('Error closing browser context', { error: error.message });
      }
    }

    if (this.browser) {
      try {
        await this.browser.close();
      } catch (error) {
        this.logger.warn('Error closing browser', { error: error.message });
      }
    }

    // Cancel any pending reconnection attempts
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    this.isReconnecting = false;
    
    if (this.audioStream && this.audioStream.readyState === WebSocket.OPEN) {
      this.audioStream.close();
    }
    this.audioStream = null;
  }

  async handleGatewayMessage(payload) {
    let message;
    try {
      message = JSON.parse(payload.toString());
    } catch (error) {
      this.logger.warn('Failed to parse gateway message', { error: error.message });
      return;
    }

    switch (message.type) {
      case 'audio_request':
        this.handleAudioRequest(message);
        break;
      case 'tts_audio':
        if (this.config.enableTtsPlayback) {
          await this.handleTtsAudio(message);
        }
        break;
      case 'meeting_command':
        await this.handleMeetingCommand(message);
        break;
      default:
        this.logger.debug('Ignoring unsupported gateway message type', { type: message.type });
    }
  }

  handleAudioRequest(message) {
    this.logger.debug('Gateway requested audio snapshot', { requestId: message.requestId });
    const response = {
      type: 'audio_response',
      requestId: message.requestId,
      meetingId: this.config.meetingId,
      sessionId: this.config.sessionId,
      active: this.audioCaptureActive,
      timestamp: Date.now()
    };
    this.gateway?.send(JSON.stringify(response));
  }

  async playAudioToMeeting(audioData) {
    try {
      // Inject audio in chunks to avoid stack overflow
      const CHUNK_SIZE = 10000; // Inject 10K samples at a time
      for (let i = 0; i < audioData.length; i += CHUNK_SIZE) {
        const chunk = audioData.slice(i, i + CHUNK_SIZE);
        await this.page.evaluate((samples) => {
          if (window.clerkVirtualMic && window.clerkVirtualMic.injectAudio) {
            window.clerkVirtualMic.injectAudio(samples);
          }
        }, chunk);
      }
      this.logger.info('Audio injected into virtual microphone in chunks', { totalSamples: audioData?.length || 0 });
    } catch (error) {
      this.logger.error('Failed to inject audio into meeting', { error: error.message });
    }
  }

  async handleTtsAudio(message) {
    this.logger.info('Playing TTS audio into meeting', { audioId: message.audioId });

    let samples = [];

    if (typeof message.audioData === 'string') {
      const buffer = Buffer.from(message.audioData, 'base64');
      const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
      const float32 = new Float32Array(buffer.byteLength / 2);
      for (let i = 0; i < float32.length; i += 1) {
        float32[i] = view.getInt16(i * 2, true) / 0x7fff;
      }
      samples = Array.from(float32);
    } else if (Array.isArray(message.audioData)) {
      samples = message.audioData;
    }

    if (!samples.length) {
      this.logger.warn('TTS audio payload missing data');
      return;
    }

    // Inject audio into virtual microphone so meeting can hear it
    await this.playAudioToMeeting(samples).catch(error => {
      this.logger.error('Failed to inject TTS audio into meeting', { error: error.message });
    });
  }

  /**
   * Speak text in the meeting by requesting audio from rt_gateway and injecting into microphone
   */
  async speak(text, prompt = '') {
    if (!this.config.enableTtsPlayback) {
      this.logger.warn('TTS not enabled, cannot speak');
      return;
    }

    if (!this.audioStream || this.audioStream.readyState !== WebSocket.OPEN) {
      this.logger.error('Audio stream not connected, cannot speak');
      return;
    }

    try {
      this.logger.info('Requesting TTS from rt_gateway', { textLength: text.length });
      
      // Send TTS request to rt_gateway
      const ttsRequest = {
        type: 'tts_request',
        text: text,
        voice_id: this.config.ttsVoice || 'default'
      };
      
      this.audioStream.send(JSON.stringify(ttsRequest));
      
      // Audio chunks will be received via handlePCMAudioChunk()
      // and automatically injected into the virtual microphone
      
      this.logger.info('TTS request sent, waiting for audio stream');
    } catch (error) {
      this.logger.error('Failed to speak in meeting', { error: error.message, stack: error.stack });
    }
  }

  /**
   * Get LLM response and speak it in the meeting
   */
  async speakLLMResponse(prompt = '') {
    if (!this.llmService) {
      this.logger.warn('LLM not enabled');
      return;
    }

    try {
      this.logger.info('Fetching LLM response');
      
      // Get text response from LLM
      const text = await this.llmService.getResponse(prompt);
      
      this.logger.info('Got LLM response', { textLength: text.length });
      
      // Speak the response via rt_gateway
      await this.speak(text, prompt);
    } catch (error) {
      this.logger.error('Failed to speak LLM response', { error: error.message });
    }
  }

  async handleMeetingCommand(message) {
    const command = message.command;
    this.logger.info('Handling meeting command', { command });
    try {
      switch (command) {
        case 'mute':
          await this.platform.setMicrophone(false);
          break;
        case 'unmute':
          await this.platform.setMicrophone(true);
          break;
        case 'camera_on':
          await th/meetings/m.setCamera(true);
          break;
        case 'camera_off':
          await this.platform.setCamera(false);
          break;
        case 'leave':
          await this.requestStop('command_leave');
          await this.leaveMeeting('command');
          break;
        default:
          this.logger.warn('Unknown meeting command', { command });
      }
    } catch (error) {
      this.logger.error('Failed to execute meeting command', { command, error: error.message });
    }
  }

  async notifyMeetingJoined() {
    try {
      const response = await axios.post(
        `${this.config.apiBaseUrl}/api/v1/meetings/${this.config.meetingId}/bot-joined`,
        {
          sessionId: this.config.sessionId,
          botName: this.config.botName,
          platform: this.config.platform,
          timestamp: new Date().toISOString(),
          meeting_url: this.config.meetingUrl
        }
      );
      this.logger.info('Reported meeting join to API', { status: response.status });
    } catch (error) {
      this.logger.warn('Failed to notify API of meeting join', { error: error.message });
    }
  }

  async notifyMeetingLeft(reason) {
    try {
      const response = await axios.post(
        `${this.config.apiBaseUrl}/api/v1/meetings/${this.config.meetingId}/bot-left`,
        {
          sessionId: this.config.sessionId,
          timestamp: new Date().toISOString(),
          reason
        }
      );
      this.logger.info('Reported meeting leave to API', { status: response.status });
    } catch (error) {
      this.logger.warn('Failed to notify API of meeting leave', { error: error.message });
    }
  }

  async notifyLifecycle(event, data) {
    try {
      await axios.post(`${this.config.apiBaseUrl}/api/v1/meetings/bot-log`, {
        event,
        data,
        timestamp: new Date().toISOString()
      }, {
        timeout: 5000,
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      this.logger.warn('Failed to log lifecycle event', { event, error: error.message });
    }
  }
}

async function main() {
  activeBot = new BrowserBot(config);
  await activeBot.start();
}

async function cleanup() {
  if (activeBot) {
    await activeBot.cleanup();
  }
}

if (require.main === module) {
  main().catch(async (error) => {
    console.error('[ERROR] Browser bot terminated with error', error);
    await cleanup();
    process.exit(1);
  });
}

module.exports = {
  main,
  cleanup,
  config
};
