/**
 * Browser bot entry point.
 * Minimal browser setup with login functionality.
 */

const { chromium } = require("playwright");
const WebSocket = require("ws");
const fs = require("fs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const https = require("https");
const http = require("http");
const { URL } = require("url");

const {
  getPlatformBrowserArgs,
  getPlatformPermissionsOrigin,
  createPlatformController,
} = require("./platforms");

function parseBoolean(value, defaultValue) {
  if (value === undefined || value === null || value === "") {
    return defaultValue;
  }
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

const config = {
  meetingUrl: process.env.MEETING_URL,
  botName: process.env.BOT_NAME || "Aurray Bot",
  platform: process.env.PLATFORM || "google_meet",
  headless: parseBoolean(process.env.HEADLESS, true),
  browserEngine: (process.env.BROWSER_ENGINE || "chromium").toLowerCase(),
  browserLocale: process.env.BROWSER_LOCALE || "en-US",
  browserArgs: process.env.BROWSER_ARGS
    ? process.env.BROWSER_ARGS.split(",")
        .map((arg) => arg.trim())
        .filter(Boolean)
    : [],
  navigationTimeoutMs: parseInt(
    process.env.NAVIGATION_TIMEOUT_MS || "45000",
    10
  ),
  logLevel: (process.env.LOG_LEVEL || "info").toLowerCase(),
  rtGatewayUrl: process.env.RT_GATEWAY_URL || "ws://localhost:8000",
  sessionId: process.env.SESSION_ID || uuidv4(),
  apiBaseUrl: process.env.API_BASE_URL || "http://localhost:8000",
  isOrganizer: parseBoolean(process.env.IS_ORGANIZER, false),
  openaiApiKey: process.env.OPENAI_API_KEY,
  openaiRealtimeApiUrl: process.env.OPENAI_REALTIME_API_URL || "https://api.openai.com/v1/realtime",
  openaiRealtimeWsUrl: process.env.OPENAI_REALTIME_WS_URL, // WebSocket URL with token (will be overridden by local proxy if available)
  voice: process.env.VOICE || "alloy",
  instructions: process.env.INSTRUCTIONS || "You are a helpful meeting assistant. Keep responses concise and professional.",
};

// OpenAI Realtime API constants
const OPENAI_TARGET_SAMPLE_RATE = 24000; // OpenAI requires 24kHz
const MEETING_SAMPLE_RATE = 48000; // Meeting platforms use 48kHz

// Helper functions for base64 encoding/decoding
function arrayBufferToBase64(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  return bytes.toString('base64');
}

function base64ToArrayBuffer(base64) {
  const binary = Buffer.from(base64, 'base64');
  return binary.buffer.slice(binary.byteOffset, binary.byteOffset + binary.byteLength);
}

// Resample audio from source to target sample rate using linear interpolation
function resampleAudio(inputData, inputSampleRate, outputSampleRate) {
  const ratio = inputSampleRate / outputSampleRate;
  const outputLength = Math.floor(inputData.length / ratio);
  const output = new Float32Array(outputLength);
  
  for (let i = 0; i < outputLength; i++) {
    const inputIndex = i * ratio;
    const lowerIndex = Math.floor(inputIndex);
    const upperIndex = Math.min(lowerIndex + 1, inputData.length - 1);
    const fraction = inputIndex - lowerIndex;
    
    const interpolated = inputData[lowerIndex] * (1 - fraction) + inputData[upperIndex] * fraction;
    output[i] = interpolated;
  }
  
  return output;
}

// Convert Float32Array to Int16Array PCM16
function float32ToPCM16(float32Array) {
  const pcm16 = new Int16Array(float32Array.length);
  for (let i = 0; i < float32Array.length; i++) {
    const clamped = Math.max(-1, Math.min(1, float32Array[i]));
    pcm16[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  }
  return pcm16;
}

// Convert Int16Array PCM16 to Float32Array
function pcm16ToFloat32(pcm16Array) {
  const float32 = new Float32Array(pcm16Array.length);
  for (let i = 0; i < pcm16Array.length; i++) {
    float32[i] = pcm16Array[i] / 32768.0;
  }
  return float32;
}

const fakeWavPath = path.resolve(__dirname, 'fake.wav');
const fakeY4mPath = path.resolve(__dirname, 'sound_wave.png');
const DEFAULT_BROWSER_ARGS = [
   "--disable-blink-features=AutomationControlled",
  "--autoplay-policy=no-user-gesture-required",
  "--use-fake-ui-for-media-stream",
  "--use-fake-device-for-media-stream",
  `--use-file-for-fake-audio-capture=${fakeWavPath}`,
  `--use-file-for-fake-video-capture=${fakeY4mPath}`,
];

class StructuredLogger {
  constructor(level = "info", context = {}) {
    this.level = level;
    this.context = context;
  }

  child(extra = {}) {
    return new StructuredLogger(this.level, { ...this.context, ...extra });
  }

  info(message, meta = {}) {
    console.log(`[INFO] ${message}`, Object.keys(meta).length ? meta : "");
  }

  warn(message, meta = {}) {
    console.warn(`[WARN] ${message}`, Object.keys(meta).length ? meta : "");
  }

  error(message, meta = {}) {
    console.error(`[ERROR] ${message}`, Object.keys(meta).length ? meta : "");
  }

  debug(message, meta = {}) {
    if (config.logLevel === "debug") {
      console.log(`[DEBUG] ${message}`, Object.keys(meta).length ? meta : "");
    }
  }
}

class BrowserBot {
  constructor(botConfig) {
    this.config = botConfig;
    this.logger = new StructuredLogger(botConfig.logLevel, {
      platform: botConfig.platform,
    });

    this.browser = null;
    this.context = null;
    this.page = null;
    this.platform = null;
    this.shouldStop = false;
    this.signalHandler = this.handleProcessSignal.bind(this);
    
    // OpenAI Realtime API connection
    this.openaiWs = null;
    this.openaiConnected = false;
    this.connectionState = "disconnected"; // disconnected, connecting, connected
    this.voiceState = "idle"; // idle, recording, speaking, processing
    
    // Reconnection state
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 6; // Maximum 6 reconnection attempts
    this.reconnectDelay = 1000; // Start with 1 second
    this.maxReconnectDelay = 30000; // Max 30 seconds
    this.reconnectTimeout = null;
    this.isReconnecting = false;
    this.shouldReconnect = true; // Can be set to false to stop reconnecting
    
    // Legacy gateway references (for backward compatibility if needed)
    this.gateway = null;
    this.gatewayConnected = false;
    
    this.audioFrameCount = 0;
    this.audioBytesSent = 0;
    this.lastAudioLogTime = Date.now();
    this.speechChunksReceived = 0;
    this.speechBytesReceived = 0;
    this.lastSpeechLogTime = Date.now();
    this.cdpClient = null;
    this.audioSearchInterval = null; // Store interval ID for cleanup
    
    // Audio diagnostics
    this.audioInputFramesSent = 0;
    this.audioOutputChunksReceived = 0;
    this.lastAudioDiagnosticLog = Date.now();
  }

  sendStatusUpdate(stage, message, metadata = {}) {
    /**
     * Send automation status update to backend API.
     * This updates the frontend via WebSocket through the backend.
     * Fire-and-forget: non-blocking, never throws errors, never awaits.
     * 
     * IMPORTANT: This function is NOT async and does NOT return a promise.
     * It's completely fire-and-forget to avoid blocking the event loop.
     */
    if (!this.config.sessionId) {
      this.logger.warn("Cannot send status update: sessionId not available");
      return;
    }

    // Fire and forget - use process.nextTick to ensure it runs after current execution
    // but don't await anything - completely non-blocking
    // NOTE: Status updates go to the main backend (apiBaseUrl, default port 8000),
    // NOT to the OpenAI Realtime proxy server (port 5001)
    process.nextTick(() => {
      try {
        const apiUrl = new URL("/api/demo/status", this.config.apiBaseUrl);
        const payload = JSON.stringify({
          sessionId: this.config.sessionId,
          stage: stage,
          message: message,
          metadata: metadata,
        });

        const requestModule = apiUrl.protocol === "https:" ? https : http;

          const req = requestModule.request(
            {
              hostname: apiUrl.hostname,
              port: apiUrl.port || (apiUrl.protocol === "https:" ? 443 : 80),
              path: apiUrl.pathname,
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(payload),
              },
            timeout: 2000, // Reduced timeout to fail faster
            },
            (res) => {
            // Drain response to prevent memory leaks, but don't wait for it
            res.on("data", () => {});
              res.on("end", () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                  this.logger.debug("Status update sent successfully", {
                    stage,
                    statusCode: res.statusCode,
                  });
                } else {
                this.logger.debug("Status update failed", {
                    stage,
                    statusCode: res.statusCode,
                  });
                }
              });
            }
          );

          req.on("error", (error) => {
          // Silently ignore errors - status updates are non-critical
          this.logger.debug("Status update error (ignored)", {
              stage,
              error: error.message,
            });
          });

          req.on("timeout", () => {
            req.destroy();
          // Silently ignore timeouts
          });

          req.write(payload);
          req.end();
      } catch (error) {
        // Silently ignore all errors - status updates are non-critical
        this.logger.debug("Status update exception (ignored)", {
          stage,
          error: error.message,
        });
      }
    });
  }

  async start() {
    if (!this.config.meetingUrl) {
      throw new Error("MEETING_URL environment variable is required");
    }

    this.logger.info("Browser bot starting", {
      meetingUrl: this.config.meetingUrl,
      headless: this.config.headless,
    });

    try {

      // Send initial status (fire-and-forget, no await)
      this.sendStatusUpdate(
        "initializing",
        "Bot is initializing...",
        { meetingUrl: this.config.meetingUrl, platform: this.config.platform }
      );

      this.registerSignalHandlers();
      
      // Launch browser
      await this.launchBrowser();
      

      
      await this.navigateToMeeting();
      
    
      await this.joinMeeting();
      
      

      // Connect audio streaming WebSocket - this is critical, so throw if it fails
      await this.connectWebSocket();

      // Call afterJoin after WebSocket connection to ensure meeting is fully joined
      if (this.platform && typeof this.platform.afterJoin === 'function') {
        this.logger.info("Calling platform.afterJoin()");
        try {
          await this.platform.afterJoin();
          this.logger.info("platform.afterJoin() completed successfully");
        } catch (error) {
          this.logger.warn("afterJoin failed, continuing anyway", {
            error: error.message,
            stack: error.stack,
          });
          // Don't throw - continue with bot operation
        }
      } else {
        this.logger.debug("afterJoin not available on platform", {
          hasPlatform: !!this.platform,
          hasAfterJoin: this.platform && typeof this.platform.afterJoin === 'function'
        });
      }

      // Start main loop (continues regardless of WebSocket status)
      // The bot will continue operating even if WebSocket never connects
      await this.runLoop();
    } catch (error) {
      this.logger.error("Bot error", { error: error.message, stack: error.stack });
      this.sendStatusUpdate(
        "error",
        `Error: ${error.message}`,
        { error: error.message, stack: error.stack }
      );
      throw error;
    } finally {
      this.unregisterSignalHandlers();
      await this.cleanup();
    }
  }

  registerSignalHandlers() {
    ["SIGINT", "SIGTERM"].forEach((signal) => {
      process.on(signal, this.signalHandler);
    });
  }

  unregisterSignalHandlers() {
    ["SIGINT", "SIGTERM"].forEach((signal) => {
      process.off(signal, this.signalHandler);
    });
  }

  async handleProcessSignal(signal) {
    this.logger.warn("Received termination signal, stopping bot", { signal });
    this.shouldStop = true;
  }

  async runLoop() {
    this.logger.info("Browser running continuously - press Ctrl+C to stop");
    let statusCheckCount = 0;

    while (!this.shouldStop) {
      try {
        if (this.page && !this.page.isClosed()) {
          const url = this.page.url();
          const title = await this.page.title().catch(() => "unknown");

          this.logger.debug("Browser is active", { url, title });

          statusCheckCount++;
          if (statusCheckCount % 6 === 0) {
            const audioStatus = await this.page
              .evaluate(() => {
                const state = window.__aurrayAudioCaptureState;
                if (!state) return { initialized: false };

                return {
                  initialized: true,
                  active: state.active,
                  sourcesCount: state.sources.size,
                  connectionsCount: state.connections.size,
                  contextState: state.context ? state.context.state : null,
                  sourceIds: Array.from(state.sources.keys()),
                };
              })
              .catch(() => ({ initialized: false }));

            // Audio capture status - logging removed (too verbose)
          }
        } else {
          this.logger.warn("Page closed - browser may have crashed");
          break;
        }

        if (this.browser && !this.browser.isConnected()) {
          this.logger.warn("Browser disconnected");
          break;
        }

        await new Promise((resolve) => setTimeout(resolve, 5000));
      } catch (error) {
        this.logger.error("Error in run loop", { error: error.message });
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }

    this.logger.info("Run loop ended");
  }

  async launchBrowser() {

    const browserName =
      this.config.browserEngine === "chrome" ? "Chrome" : "Chromium";
    this.logger.info(`Launching ${browserName}`, {
      headless: this.config.headless,
      platform: process.platform,
      engine: this.config.browserEngine,
    });

    const platformArgs = getPlatformBrowserArgs(this.config.platform);
    const envArgs = this.config.browserArgs || [];
    let args = [...envArgs, ...platformArgs, ...DEFAULT_BROWSER_ARGS];

    const launchOptions = {
      headless: this.config.headless,
      args,
    };

    if (!this.config.headless && process.platform === "darwin") {
      launchOptions.args = launchOptions.args.filter(
        (a) => !a.includes("headless")
      );
    }

    if (this.config.browserEngine === "chrome") {
      if (process.platform === "darwin") {
        launchOptions.executablePath =
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
      } else if (process.platform === "linux") {
        launchOptions.executablePath = "/usr/bin/google-chrome";
      } else if (process.platform === "win32") {
        launchOptions.executablePath =
          "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
      }
    }

    this.browser = await chromium.launch(launchOptions);
    
    this.logger.info("Browser launched", {
      headless: this.config.headless,
      engine: this.config.browserEngine,
    });

    this.sendStatusUpdate(
      "browser_launched",
      "Browser launched successfully",
      { headless: this.config.headless }
    );

    const contextOptions = {
      viewport: { width: 1280, height: 720 },
      ignoreHTTPSErrors: true,
      locale: this.config.browserLocale,
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    };

    this.logger.info("Checking for Google Meet auth state (before) " + this.config.platform);
    if (this.config.platform === "google_meet") {
      this.logger.info("Inside Google Meet auth state block (in)");
      const authStatePath = path.resolve(__dirname, "google_auth_state.json");
      if (fs.existsSync(authStatePath)) {
        contextOptions.storageState = authStatePath;
        this.logger.info("Using Google auth storageState", { authStatePath });
      }
    }
    this.logger.info("Finished Google Meet auth state check (after)");

    this.context = await this.browser.newContext(contextOptions);

    const origin = getPlatformPermissionsOrigin(
      this.config.platform,
      this.config.meetingUrl
    );
    if (origin) {
      await this.context
        .grantPermissions(["microphone", "camera"], { origin })
        .catch((err) => {
          this.logger.warn("Failed to grant permissions", {
            error: err.message,
          });
        });
      this.logger.debug("Granted permissions", {
        origin,
        platform: this.config.platform,
      });
    }

    this.page = await this.context.newPage();
    
    // Set realistic User-Agent header for better compatibility
    await this.page.setExtraHTTPHeaders({
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    });

    await this.page.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });

      const originalQuery = window.navigator.permissions.query.bind(
        window.navigator.permissions
      );
      window.navigator.permissions.query = function (params) {
        if (params?.name === "notifications") {
          return Promise.resolve({ state: Notification.permission });
        }
        return originalQuery(params);
      };

      Object.defineProperty(navigator, "plugins", {
        get: () => [1, 2, 3, 4],
      });

      Object.defineProperty(navigator, "languages", {
        get: () => ["en-US", "en"],
      });

      const originalGetUserMedia = navigator.mediaDevices.getUserMedia.bind(
        navigator.mediaDevices
      );
      navigator.mediaDevices.getUserMedia = async function (constraints) {
        const c = constraints || {};
        const wantsAudio =
          !!c.audio &&
          (typeof c.audio === "boolean" || typeof c.audio === "object");
        const wantsVideo =
          !!c.video &&
          (typeof c.video === "boolean" || typeof c.video === "object");

        const contextInfo = {
          url: window.location.href,
          origin: window.location.origin,
          frameName: window.name || 'main',
          isTopFrame: window === window.top,
          hasVirtualStream: !!window.aurrayVirtualMicStream,
          hasInjectFunction: typeof window.aurrayInjectAudio48k === 'function',
          hasAudioContext: !!window.__aurrayMasterAudioContext,
          audioContextState: window.__aurrayMasterAudioContext?.state || 'N/A'
        };
        
        console.log("[AURRAY] getUserMedia called", {
          wantsAudio,
          wantsVideo,
          ...contextInfo,
          constraints: JSON.stringify(c).substring(0, 200)
        });

        if (!wantsAudio) {
          return originalGetUserMedia.call(this, constraints);
        }

        let virtualStream = window.aurrayVirtualMicStream;
        
        // If virtual stream is missing, try to create it inline (for Teams or Google Meet)
        const isTeams = window.location.href.includes('teams.microsoft.com') && window.location.href.includes('light-meetings');
        const isGoogleMeet = window.location.href.includes('meet.google.com');
        
        if (!virtualStream && (isTeams || isGoogleMeet)) {
          const platformName = isTeams ? 'Teams' : 'Google Meet';
          console.log(`[AURRAY] ${platformName}: Virtual stream missing, attempting inline initialization`);
          try {
            const AudioContextClass = window.AudioContext || window.webkitAudioContext;
            if (AudioContextClass) {
              const ctx = new AudioContextClass({ sampleRate: 48000 });
              window.__aurrayMasterAudioContext = ctx;
              
              const buffer = [];
              let readIndex = 0;
              let totalSamplesInjected = 0;
              let totalSamplesRead = 0;
              const processor = ctx.createScriptProcessor(1024, 1, 1);
              
              let tonePhase = 0;
              const TONE_FREQ = 20;
              const TONE_AMPLITUDE = 0.0001;
              
              processor.onaudioprocess = (event) => {
                const output = event.outputBuffer.getChannelData(0);
                const len = output.length;
                const sampleRate = event.outputBuffer.sampleRate;
                let samplesFromBuffer = 0;
                let samplesFromTone = 0;
                
                for (let i = 0; i < len; i++) {
                  if (readIndex < buffer.length) {
                    output[i] = buffer[readIndex++];
                    samplesFromBuffer++;
                    totalSamplesRead++;
                  } else {
                    tonePhase += (TONE_FREQ / sampleRate) * 2 * Math.PI;
                    if (tonePhase > 2 * Math.PI) tonePhase -= 2 * Math.PI;
                    output[i] = Math.sin(tonePhase) * TONE_AMPLITUDE;
                    samplesFromTone++;
                  }
                }
                
                // Buffer stats logging removed - too verbose
                
                if (readIndex > 48000 * 5) {
                  buffer.splice(0, readIndex);
                  readIndex = 0;
                }
              };
              
              const gain = ctx.createGain();
              gain.gain.value = 0.0;
              processor.connect(gain);
              gain.connect(ctx.destination);
              
              const dest = ctx.createMediaStreamDestination();
              processor.connect(dest);
              
              // Teams-specific: Configure track to appear as a valid device
              const audioTrack = dest.stream.getAudioTracks()[0];
              if (audioTrack && isTeams) {
                // Override getSettings to return device info that Teams expects
                const originalGetSettings = audioTrack.getSettings.bind(audioTrack);
                audioTrack.getSettings = function() {
                  const settings = originalGetSettings();
                  // Return settings that Teams will accept
                  return {
                    ...settings,
                    deviceId: 'default', // Use 'default' which Teams should recognize
                    groupId: '',
                    autoGainControl: true,
                    echoCancellation: true,
                    noiseSuppression: true
                  };
                };
                
                // Override getCapabilities to return proper capabilities
                const originalGetCapabilities = audioTrack.getCapabilities ? audioTrack.getCapabilities.bind(audioTrack) : null;
                if (originalGetCapabilities) {
                  audioTrack.getCapabilities = function() {
                    const caps = originalGetCapabilities();
                    return {
                      ...caps,
                      autoGainControl: { ideal: true },
                      echoCancellation: { ideal: true },
                      noiseSuppression: { ideal: true }
                    };
                  };
                }
              }
              
              window.aurrayVirtualMicStream = dest.stream;
              window.aurrayInjectAudio48k = (samples) => {
                if (!samples || !samples.length) {
                  return;
                }
                for (let i = 0; i < samples.length; i++) {
                  buffer.push(samples[i]);
                }
                totalSamplesInjected += samples.length;
              };
              
              virtualStream = dest.stream;
              console.log(`[AURRAY] ${platformName}: Virtual stream created inline`, {
                streamId: dest.stream.id,
                trackCount: dest.stream.getAudioTracks().length,
                trackId: audioTrack?.id,
                hasGetSettings: typeof audioTrack?.getSettings === 'function'
              });
            }
          } catch (error) {
            console.error(`[AURRAY] ${platformName}: Failed to create virtual stream inline`, error);
          }
        }
        
        if (!virtualStream) {
          console.warn("[AURRAY] Virtual stream not available, falling back to real mic", contextInfo);
          return originalGetUserMedia.call(this, constraints);
        }
        
        const trackInfo = {
          trackCount: virtualStream.getAudioTracks().length,
          trackIds: virtualStream.getAudioTracks().map(t => t.id),
          trackStates: virtualStream.getAudioTracks().map(t => t.readyState),
          trackEnabled: virtualStream.getAudioTracks().map(t => t.enabled)
        };
        console.log("[AURRAY] Virtual stream available, returning it", {
          ...contextInfo,
          ...trackInfo
        });

        if (!wantsVideo) {
          const ms = new MediaStream();
          virtualStream.getAudioTracks().forEach((t) => {
            ms.addTrack(t);
          });
          return ms;
        }

        const realStream = await originalGetUserMedia.call(this, {
          ...c,
          audio: false,
        });

        const combined = new MediaStream();
        virtualStream.getAudioTracks().forEach((t) => combined.addTrack(t));
        realStream.getVideoTracks().forEach((t) => combined.addTrack(t));
        return combined;
      };
    });

    if (!this.config.headless && process.platform === "darwin") {
      try {
        await this.page.waitForTimeout(500);
        const { execSync } = require("child_process");
        const processName =
          this.config.browserEngine === "chrome" ? "Google Chrome" : "Chromium";
        execSync(
          `osascript -e 'tell application "System Events" to set frontmost of first process whose name contains "${processName}" to true'`,
          { stdio: "ignore" }
        );
      } catch {}
    }

    this.page.on("console", (msg) => {
      const text = msg.text();
      const type = msg.type();

      if (text.includes("[AURRAY]")) {
        if (type === "error") {
          this.logger.error("Browser console [AURRAY]", { text });
        } else {
          this.logger.info("Browser console [AURRAY]", { text });
        }
      } else if (type === "error") {
        if (
          !text.includes("Failed to load resource: the server responded with")
        ) {
          this.logger.error("Browser console error", { text });
        }
      }
    });

    this.page.on("pageerror", (err) => {
      this.logger.error("Page error", { err: err.message });
    });

    this.page.on("close", () => {
      this.logger.warn("Page closed");
      if (!this.shouldStop) {
        this.shouldStop = true;
      }
    });

    this.browser.on("disconnected", () => {
      this.logger.warn("Browser disconnected");
      if (!this.shouldStop) {
        this.shouldStop = true;
      }
    });
  }

  async navigateToMeeting() {
    this.logger.info("Navigating to meeting URL");
    // Navigate to meeting
    this.sendStatusUpdate(
      "navigating",
      "Navigating to meeting URL...",
      { meetingUrl: this.config.meetingUrl }
    );
    try {
      await this.page.goto(this.config.meetingUrl, {
        waitUntil: "networkidle",
        timeout: this.config.navigationTimeoutMs,
      });
    } catch {
      await this.page.goto(this.config.meetingUrl, {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });
    }

    this.logger.info("Navigation complete", { url: this.page.url() });

    if (this.config.platform === "google_meet") {
      const currentUrl = this.page.url();
      if (
        currentUrl.includes("accounts.google.com") ||
        currentUrl.includes("signin")
      ) {
        this.logger.info(
          "Google login required - please complete login in browser"
        );
        this.logger.info(
          "After login, the auth state will be saved automatically"
        );

        await this.page
          .waitForURL(
            (url) =>
              !url.includes("accounts.google.com") && !url.includes("signin"),
            { timeout: 300000 }
          )
          .catch(() => {
            this.logger.warn("Login timeout - please check browser");
          });

        await this.saveAuthState();
      }
    }
  }

  async joinMeeting() {
    try {
      // Add isOrganizer and status update callback to config for platform controllers
      const platformConfig = {
        ...this.config,
        isOrganizer: this.config.isOrganizer,
        sendStatusUpdate: this.sendStatusUpdate.bind(this),
      };

      this.platform = createPlatformController(
        this.config.platform,
        this.page,
        platformConfig,
        this.logger.child({ subsystem: "platform" })
      );

      if (this.platform.beforeNavigate) {
        await this.platform.beforeNavigate();
      }

      // Set up virtual microphone BEFORE joining so it's ready when getUserMedia is called
      await this.setupVirtualMic();
      
      // For Teams: Store initial URL to detect navigation
      let initialUrl = null;
      if (this.config.platform === 'teams') {
        initialUrl = this.page.url();
      }
        // Join meeting
      this.sendStatusUpdate(
          "joining_meeting",
          "Joining the meeting...",
          { platform: this.config.platform }
      );
      await this.platform.joinMeeting();
      
      const currentUrl = this.page.url();
      
      // For Teams: Re-initialize if navigated from launcher to meeting page
      if (this.config.platform === 'teams') {
        const isMeetingPage = currentUrl.includes('light-meetings/launch');
        const wasLauncherPage = initialUrl && initialUrl.includes('dl/launcher');
        
        if (isMeetingPage && wasLauncherPage) {
          this.logger.info('Teams: Detected navigation to meeting page, re-initializing virtual mic');
          await this.setupVirtualMic();
        }
      }
      
      else if (this.config.platform === 'google_meet' && currentUrl.includes('meet.google.com')) {
        const virtualMicStatus = await this.page.evaluate(() => {
          return {
            hasVirtualStream: !!window.aurrayVirtualMicStream,
            hasInjectFunction: typeof window.aurrayInjectAudio48k === 'function',
            hasAudioContext: !!window.__aurrayMasterAudioContext,
            streamId: window.aurrayVirtualMicStream?.id,
            trackCount: window.aurrayVirtualMicStream?.getAudioTracks().length || 0,
            trackStates: window.aurrayVirtualMicStream?.getAudioTracks().map(t => t.readyState) || [],
          };
        });
        
        this.logger.info('Google Meet: Virtual mic status check', virtualMicStatus);
        
        if (!virtualMicStatus.hasVirtualStream || !virtualMicStatus.hasInjectFunction) {
          this.logger.info('🔧 Re-initializing virtual mic');
          await this.setupVirtualMic();
        }
        // If stream exists, use it silently
      }
      
      await this.setupAudioCapture();
    } catch (error) {
      this.logger.error("Failed to join meeting", {
        error: error.message,
        stack: error.stack,
      });
      throw error;
    }
  }

  async connectWebSocket() {
    
   
    // Prevent multiple simultaneous connection attempts
    if (this.connectionState === "connected" || this.connectionState === "connecting") {
      this.logger.warn("OpenAI WebSocket already connecting or connected");
      return;
    }

    // Prevent reconnection if explicitly disabled
    if (this.isReconnecting && !this.shouldReconnect) {
      this.logger.info("Reconnection disabled, not attempting to connect");
      return;
    }

    this.connectionState = "connecting";
    this.logger.info("Connecting to OpenAI Realtime API", {
      attempt: this.reconnectAttempts + 1,
      delay: this.reconnectAttempts > 0 ? `${this.reconnectDelay}ms` : "immediate",
    });
    this.sendStatusUpdate(
      "general_message",
      "I am setting up my microphone...",
      { platform: this.config.platform }
    );

    try {
      // Get WebSocket URL from Python backend (port 8000)
      const wsUrl = this.config.openaiRealtimeWsUrl;
      if (!wsUrl) {
        throw new Error("OpenAI WebSocket URL not set. Check OPENAI_REALTIME_WS_URL environment variable is configured.");
      }
      
      // Log which proxy we're using
      if (wsUrl.includes(":8000")) {
        this.logger.info("✅ Using Python backend proxy server (port 8000)");
      } else if (wsUrl.includes(":5001")) {
        this.logger.info("✅ Using local Node.js proxy server (port 5001)");
      } else {
        this.logger.info("✅ Using OpenAI Realtime API proxy", { url: wsUrl.substring(0, 50) + "..." });
      }

      // Clean up the URL: trim whitespace and quotes, then ensure proper protocol
      // Use host.docker.internal in Docker to connect to host machine
      let finalWsUrl = String(wsUrl).trim();
      
      // Remove surrounding quotes if present
      if ((finalWsUrl.startsWith("'") && finalWsUrl.endsWith("'")) || 
          (finalWsUrl.startsWith('"') && finalWsUrl.endsWith('"'))) {
        finalWsUrl = finalWsUrl.slice(1, -1);
      }
      
      // Detect if running in Docker and use host.docker.internal to connect to host machine
      // Otherwise use 127.0.0.1 for local connections
      const isDocker = fs.existsSync('/.dockerenv') || fs.existsSync('/app/.dockerenv');
      const hostReplacement = isDocker ? "host.docker.internal" : "127.0.0.1";
      
      // Replace localhost with appropriate host (do this before protocol check)
      // This allows Docker containers to connect to services on the host machine
      finalWsUrl = finalWsUrl.replace(/localhost/g, hostReplacement);
      
      // Ensure the URL uses ws/wss protocol
      if (finalWsUrl.startsWith("http://")) {
        finalWsUrl = finalWsUrl.replace("http://", "ws://");
      } else if (finalWsUrl.startsWith("https://")) {
        finalWsUrl = finalWsUrl.replace("https://", "wss://");
      } else if (!finalWsUrl.startsWith("ws://") && !finalWsUrl.startsWith("wss://")) {
        // If no protocol, assume ws://
        finalWsUrl = `ws://${finalWsUrl}`;
      }

      this.logger.info("Connecting to OpenAI Realtime API", { url: finalWsUrl.substring(0, 50) + "..." });

      return new Promise((resolve, reject) => {
        const ws = new WebSocket(finalWsUrl);
        let isConnected = false;
        let connectionResolved = false;

      const connectionTimeout = setTimeout(() => {
        if (!isConnected && ws.readyState !== WebSocket.OPEN) {
          this.sendStatusUpdate(
            "general_message",
            "I Could not connect to the microphone. attepting to reconnect...",
            { platform: this.config.platform }
          );
            this.logger.error("OpenAI WebSocket connection timeout");
          try {
            ws.close();
          } catch (e) {
            // Ignore errors when closing
          }
            this.openaiWs = null;
            this.openaiConnected = false;
            this.connectionState = "disconnected";
            
            if (!connectionResolved) {
              connectionResolved = true;
              this.scheduleReconnect();
              reject(new Error("OpenAI WebSocket connection timeout after 15 seconds"));
            }
          }
        }, 15000);

      ws.on("open", () => {
        clearTimeout(connectionTimeout);
        isConnected = true;
          
          // Reset reconnection state on successful connection
          this.reconnectAttempts = 0;
          this.reconnectDelay = 1000;
          this.isReconnecting = false;
          
          this.logger.info("✅ OpenAI Realtime API connected successfully", {
            attempt: this.reconnectAttempts + 1,
          });
          this.sendStatusUpdate(
            "done_status",
            "I am connected to the microphone.",
            { platform: this.config.platform }
          );

          if (!this.config.isOrganizer) {
            this.sendStatusUpdate(
              "done_status",
              "You can say hello to me now!",
                { platform: this.config.platform }
            );
          }
          this.openaiWs = ws;
          this.openaiConnected = true;
          this.connectionState = "connected";
          this.voiceState = "idle";

          // Send session configuration
          try {
            const sessionConfig = {
              type: "session.update",
              session: {
                instructions: this.config.instructions,
                voice: this.config.voice,
                input_audio_format: "pcm16",
                output_audio_format: "pcm16",
                input_audio_transcription: {
                  model: "whisper-1",
                },
                turn_detection: {
                  type: "server_vad",
                  threshold: 0.5,
                  prefix_padding_ms: 300,
                  silence_duration_ms: 500,
                },
              },
            };
            ws.send(JSON.stringify(sessionConfig));
            // Session config sent - no need to log details
        } catch (error) {
            this.logger.error("❌ Failed to send session configuration", {
            error: error.message,
          });
          }

          if (!connectionResolved) {
            connectionResolved = true;
        resolve();
          }
      });

      ws.on("message", (data) => {
        try {
            // OpenAI Realtime API sends JSON messages
            // In Node.js 'ws' library, messages can come as Buffer or string
            let messageStr;
          if (typeof data === 'string') {
              messageStr = data;
            } else if (Buffer.isBuffer(data)) {
              messageStr = data.toString('utf8');
            } else if (data instanceof ArrayBuffer) {
              messageStr = Buffer.from(data).toString('utf8');
            } else {
              this.logger.warn("⚠️ Received unknown message type from OpenAI", {
                type: typeof data,
                constructor: data?.constructor?.name,
                length: data?.length,
              });
              return;
            }
            
            const message = JSON.parse(messageStr);
            this.handleOpenAIMessage(message);
                } catch (error) {
            this.logger.error("❌ Error parsing OpenAI message", {
                    error: error.message,
              dataType: typeof data,
              dataLength: data?.length,
            });
          }
        });

        ws.on("error", (error) => {
          clearTimeout(connectionTimeout);
          if (!isConnected) {
            this.logger.error("OpenAI WebSocket connection error", {
              error: error.message,
              attempt: this.reconnectAttempts + 1,
            });
            this.openaiWs = null;
            this.openaiConnected = false;
            this.connectionState = "disconnected";
            
            if (!connectionResolved) {
              connectionResolved = true;
              this.scheduleReconnect();
              reject(new Error(`Failed to connect to OpenAI: ${error.message}`));
            }
          } else {
            // Error after connection - log but don't reject (close handler will handle reconnection)
            this.logger.warn("OpenAI WebSocket error after connection", {
              error: error.message,
            });
          }
        });

        ws.on("close", (code, reason) => {
          clearTimeout(connectionTimeout);
          
          // Don't reconnect for certain close codes
          const shouldReconnectOnClose = code !== 1008 && code !== 1003; // 1008 = policy violation, 1003 = invalid data
          
          if (this.openaiConnected) {
            // Log detailed disconnect info to diagnose timing issues
            const disconnectInfo = {
              code,
              reason: reason?.toString(),
              willReconnect: shouldReconnectOnClose && this.shouldReconnect,
              audioFramesSent: this.audioInputFramesSent,
              audioBytesSent: this.audioBytesSent,
              audioOutputChunksReceived: this.audioOutputChunksReceived,
              voiceState: this.voiceState,
              timeSinceLastAudioLog: Date.now() - this.lastAudioLogTime,
            };
            this.logger.warn("OpenAI WebSocket closed", disconnectInfo);
            this.sendStatusUpdate(
              "error",
              "I could not connect to the microphone. ",
              { platform: this.config.platform }
            );
          }
          
          if (this.openaiWs === ws) {
            this.openaiWs = null;
          }
          this.openaiConnected = false;
          this.connectionState = "disconnected";
          this.voiceState = "idle";
          
          // Attempt to reconnect if appropriate
          if (shouldReconnectOnClose && this.shouldReconnect && !this.shouldStop) {
            this.scheduleReconnect();
          }
        });
      });
    } catch (err) {
      this.connectionState = "disconnected";
      this.logger.error("Failed to connect to OpenAI Realtime API", {
        error: err.message,
        stack: err.stack,
        attempt: this.reconnectAttempts + 1,
      });
      
      // Schedule reconnection attempt
      this.scheduleReconnect();
      throw err;
    }
  }

  scheduleReconnect() {
    // Prevent multiple reconnection schedules
    if (this.isReconnecting || !this.shouldReconnect || this.shouldStop) {
      return;
    }

    // Check if we've exceeded max attempts
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.logger.error("Max reconnection attempts reached, giving up", {
        attempts: this.reconnectAttempts,
      });
      this.sendStatusUpdate(
        "error",
        "I could not connect. You can try me out again later.",
        { platform: this.config.platform }
      );
      // Stop the bot and trigger cleanup
      this.shouldStop = true;
      this.shouldReconnect = false;
      // Trigger cleanup asynchronously (don't await to avoid blocking)



      this.cleanup().catch((error) => {
        this.logger.error("Error during cleanup after max reconnection attempts", {
          error: error.message,
        });
      });
      return;
    }

    this.sendStatusUpdate(
      "general_message",
      "Reconnecting....",
      { platform: this.config.platform }
    );

    this.isReconnecting = true;
    this.reconnectAttempts++;

    // Calculate exponential backoff delay (with jitter)
    const baseDelay = Math.min(this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1), this.maxReconnectDelay);
    const jitter = Math.random() * 1000; // Add up to 1 second of random jitter
    const delay = Math.floor(baseDelay + jitter);

    this.logger.info("Scheduling reconnection attempt", {
      attempt: this.reconnectAttempts,
      delay: `${delay}ms`,
      maxAttempts: this.maxReconnectAttempts === Infinity ? "unlimited" : this.maxReconnectAttempts,
    });

    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null;
      this.isReconnecting = false;
      
      // Only reconnect if we're not stopping and should still reconnect
      if (this.shouldReconnect && !this.shouldStop) {
        this.connectWebSocket().catch((err) => {
          this.logger.warn("Reconnection attempt failed, will retry", {
            error: err.message,
            attempt: this.reconnectAttempts,
          });
          // scheduleReconnect will be called again from connectWebSocket error handler
        });
      }
    }, delay);
  }

  handleOpenAIMessage(message) {
    try {
      switch (message.type) {
        case "session.created":
        case "session.updated":
          this.logger.info("✅ OpenAI session ready", { type: message.type });
          break;

        case "input_audio_buffer.speech_started":
          this.voiceState = "recording";
          this.logger.info("🎤 Speech detected (VAD)", {
            inputFrames: this.audioInputFramesSent,
          });
          break;

        case "input_audio_buffer.speech_stopped":
          this.voiceState = "processing";
          // Speech ended - processing will start, no need to log
          break;
          
        case "response.created":
          // Response created - no need to log, will log when speaking starts
          break;
          
        case "response.text.done":
          // Text response - transcript is logged separately
          break;

        case "response.audio.delta":
        case "response.output_audio.delta":
          if (this.voiceState !== "speaking") {
            this.voiceState = "speaking";
            this.logger.info("🔊 AI speaking");
          }
          if (message.delta) {
            // Decode base64 audio and play to meeting
            const audioData = base64ToArrayBuffer(message.delta);
            this.handleAudioChunk(audioData);
          }
          break;

        case "response.audio.done":
        case "response.output_audio.done":
          this.voiceState = "idle";
          // AI response completed - transcript will be logged separately
          break;

        case "response.interrupted":
          // OpenAI automatically interrupted because user started speaking
          this.voiceState = "recording";
          this.logger.info("⚠️  AI interrupted (user speaking)");
          break;


        case "conversation.item.input_audio_transcription.completed":
          if (message.transcript) {
            this.logger.info("💬 User", { text: message.transcript });
          }
          break;

        case "response.audio_transcript.done":
        case "response.output_audio_transcript.done":
          if (message.transcript) {
            this.logger.info("💬 AI", { text: message.transcript });
          }
          break;

        case "error":
          const errorMsg = message.error?.message || "An error occurred";
          this.logger.error("❌ OpenAI error", {
            message: errorMsg,
            code: message.error?.code,
            type: message.error?.type,
            param: message.error?.param,
          });
          this.voiceState = "idle";
          break;

        default:
          // Silently ignore unhandled message types (most are informational)
          break;
      }
    } catch (error) {
      this.logger.warn("Error processing OpenAI message", {
        error: error.message,
        messageType: message?.type,
      });
    }
  }

  async setupAudioCapture() {
    try {
      const client = await this.page.context().newCDPSession(this.page);
      this.logger.info("CDP session created for audio capture");

      await client.send("Runtime.enable");
      await client.send("Target.setDiscoverTargets", { discover: true });
      this.logger.info("CDP Target domain enabled for iframe discovery");

      try {
        await client.send("WebRTC.enable");
        this.logger.info("WebRTC domain enabled via CDP");

        client.on("WebRTC.eventSourceStateChanged", (event) => {
          this.logger.info("WebRTC event source state changed", {
            peerConnectionId: event.peerConnectionId,
            eventSource: event.eventSource,
            state: event.state,
          });
        });
      } catch (e) {
        this.logger.warn("WebRTC.enable not available, continuing without it", {
          error: e.message,
        });
      }

      await this.page.exposeBinding(
        "aurrayEmitAudioFrame",
        async (_source, payload) => {
          this.handleAudioFrame(payload);
        }
      );

      const workletPath = path.resolve(__dirname, "audio-worklet.js");
      const workletCode = fs.readFileSync(workletPath, "utf8");
      
      // For Teams: Use data URL to avoid CSP issues with blob URLs
      const isTeams = this.config.platform === 'teams';
      const workletUrlForTeams = isTeams 
        ? `data:application/javascript;base64,${Buffer.from(workletCode).toString('base64')}`
        : null;

      const audioCaptureScript = `
        (async function() {
          const contextInfo = {
            url: window.location.href,
            origin: window.location.origin,
            frameName: window.name || 'main',
            isTopFrame: window === window.top,
            isTeams: ${isTeams ? 'true' : 'false'}
          };
          console.log('[AURRAY] Audio capture script starting', contextInfo);
          
          const AudioContextClass = window.AudioContext || window.webkitAudioContext;
          if (!AudioContextClass) {
            console.warn('[AURRAY] AudioContext not available', contextInfo);
            return;
          }

          let context = null;
          let workletNode = null;
          const sources = new Map();
          const connections = new Set();

          const workletCode = ${JSON.stringify(workletCode)};
          
          // Teams: Use data URL, others: Use blob URL
          let workletUrl;
          if (${isTeams ? 'true' : 'false'}) {
            workletUrl = ${workletUrlForTeams ? JSON.stringify(workletUrlForTeams) : 'null'};
            console.log('[AURRAY] Teams: Using data URL for worklet', {
              ...contextInfo,
              workletUrl: workletUrl ? workletUrl.substring(0, 100) + '...' : 'null'
            });
          } else {
            console.log('[AURRAY] Creating worklet blob', {
              ...contextInfo,
              workletCodeLength: workletCode.length
            });
            const workletBlob = new Blob([workletCode], { type: 'application/javascript' });
            workletUrl = URL.createObjectURL(workletBlob);
            console.log('[AURRAY] Worklet blob URL created', {
              ...contextInfo,
              workletUrl: workletUrl.substring(0, 100) + '...',
              blobSize: workletBlob.size
            });
          }

          const attachRemoteTrack = async (track, forceAttach = false) => {
            if (!track || track.kind !== 'audio' || sources.has(track.id)) {
              return false;
            }

            // If forceAttach is true (e.g., from audio element), skip deviceId check
            if (!forceAttach) {
              const trackSettings = track.getSettings ? track.getSettings() : {};
              const hasDeviceId = !!trackSettings.deviceId;
              if (hasDeviceId) {
                console.log('[AURRAY] Skipping local track:', track.id);
                return false;
              }
            }

            try {
              await initAudioContext();
              
              const stream = new MediaStream([track]);
              const sourceNode = context.createMediaStreamSource(stream);
              sourceNode.connect(workletNode);
              
              sources.set(track.id, { stream, sourceNode, track });
              console.log('[AURRAY] Attached remote audio track via CDP WebRTC:', track.id);
              return true;
            } catch (error) {
              console.error('[AURRAY] Failed to attach track:', error, track.id);
              return false;
            }
          };

          const initAudioContext = async () => {
            if (context) {
              console.log('[AURRAY] AudioContext already initialized', {
                ...contextInfo,
                state: context.state,
                sampleRate: context.sampleRate
              });
              return context;
            }
            
            console.log('[AURRAY] Creating new AudioContext', contextInfo);
            context = new AudioContextClass({ sampleRate: 48000 });
            console.log('[AURRAY] AudioContext created', {
              ...contextInfo,
              state: context.state,
              sampleRate: context.sampleRate
            });
            
            try {
              if (!workletUrl) {
                throw new Error('Worklet URL not available');
              }
              
              console.log('[AURRAY] Adding AudioWorklet module', {
                ...contextInfo,
                workletUrl: workletUrl.substring(0, 100) + '...',
                audioWorkletAvailable: !!context.audioWorklet,
                isDataUrl: workletUrl.startsWith('data:')
              });
              await context.audioWorklet.addModule(workletUrl);
              console.log('[AURRAY] AudioWorklet module added successfully', contextInfo);
              
              console.log('[AURRAY] Creating AudioWorkletNode', contextInfo);
              workletNode = new AudioWorkletNode(context, 'audio-capture-processor');
              console.log('[AURRAY] AudioWorkletNode created', {
                ...contextInfo,
                nodeState: workletNode ? 'created' : 'failed'
              });
              
              workletNode.port.onmessage = (event) => {
                try {
                  const data = event.data;
                  if (data.samples && data.samples.length > 0 && typeof window.aurrayEmitAudioFrame === 'function') {
                    window.aurrayEmitAudioFrame({
                      samples: data.samples,
                      rms: data.rms || 0,
                      sampleCount: data.sampleCount || data.samples.length
                    });
                  }
                } catch (e) {
                  console.error('[AURRAY] Error in worklet onmessage:', e);
                }
              };
              
              const gain = context.createGain();
              gain.gain.value = 0;
              workletNode.connect(gain);
              gain.connect(context.destination);
              
              console.log('[AURRAY] AudioWorklet initialized via CDP WebRTC', {
                ...contextInfo,
                contextState: context.state
              });
            } catch (error) {
              console.error('[AURRAY] Failed to initialize AudioWorklet', {
                ...contextInfo,
                error: error.message,
                errorName: error.name,
                errorStack: error.stack?.substring(0, 500),
                workletUrl: workletUrl ? workletUrl.substring(0, 100) + '...' : 'null',
                isDataUrl: workletUrl ? workletUrl.startsWith('data:') : false,
                audioWorkletAvailable: !!context.audioWorklet
              });
              throw error;
            }
            
            return context;
          };

          const hookRTCPeerConnection = (pc) => {
            if (connections.has(pc)) return;
            connections.add(pc);
            
            console.log('[AURRAY] Hooking RTCPeerConnection via CDP WebRTC, receivers:', pc.getReceivers().length);
            
            pc.addEventListener('track', async (event) => {
              if (event.track && event.track.kind === 'audio') {
                console.log('[AURRAY] Track event received via CDP WebRTC:', event.track.id);
                if (event.track.readyState === 'live') {
                  await attachRemoteTrack(event.track);
                } else {
                  event.track.addEventListener('started', async () => {
                    console.log('[AURRAY] Track started via CDP WebRTC:', event.track.id);
                    await attachRemoteTrack(event.track);
                  });
                }
              }
            });

            const checkReceivers = async () => {
              try {
                const receivers = pc.getReceivers();
                for (const receiver of receivers) {
                  if (receiver.track && receiver.track.kind === 'audio' && receiver.track.readyState === 'live') {
                    await attachRemoteTrack(receiver.track);
                  }
                }
              } catch (e) {
                console.warn('[AURRAY] Error checking receivers:', e);
              }
            };

            checkReceivers();
            
            pc.addEventListener('connectionstatechange', () => {
              if (pc.connectionState === 'closed' || pc.connectionState === 'failed') {
                connections.delete(pc);
              } else if (pc.connectionState === 'connected' || pc.connectionState === 'connecting') {
                setTimeout(() => {
                  try {
                    checkReceivers();
                  } catch (e) {
                    console.warn('[AURRAY] Error checking receivers on state change:', e);
                  }
                }, 1000);
              }
            });
          };

          window.aurrayHookConnection = (pc) => {
            if (pc instanceof RTCPeerConnection) {
              hookRTCPeerConnection(pc);
              return true;
            }
            return false;
          };

          // Expose attachRemoteTrack globally so it can be called from audio element capture
          window.aurrayAttachRemoteTrack = attachRemoteTrack;

          window.__aurrayAudioCaptureState = { context: null, workletNode: null, sources, connections };
          window.aurrayStartAudioCapture = async () => {
            await initAudioContext();
            if (context.state === 'suspended') {
              await context.resume();
            }
            console.log('[AURRAY] Audio capture started via CDP WebRTC, context state:', context.state, 'sources:', sources.size, 'connections:', connections.size);
            return true;
          };

          await window.aurrayStartAudioCapture();
        })();
      `;

      // Inject script via CDP Runtime.evaluate to execute immediately on current page
      // This is better than addInitScript which only runs on new page loads
      try {
        // Injecting audio capture script
        await client.send("Runtime.evaluate", {
          expression: audioCaptureScript,
          awaitPromise: true,
        });
        // Audio capture script injected
      } catch (e) {
        this.logger.error("Failed to inject audio capture script via CDP", {
          error: e.message,
          stack: e.stack,
        });
        throw e;
      }

      // Verify the script is ready
      const isReady = await this.page
        .evaluate(() => {
          return typeof window.aurrayStartAudioCapture === "function";
        })
        .catch(() => false);

      if (isReady) {
        // Audio capture ready
      } else {
        this.logger.warn("Audio capture script may not be fully initialized");
      }

      const searchInContext = async (cdpClient, contextName) => {
        try {
          const result = await cdpClient.send("Runtime.evaluate", {
            expression: `
              (function() {
                const connections = [];
                let found = 0;
                
                try {
                  if (window.RTCPeerConnection) {
                    const keys = Object.keys(window);
                    for (let i = 0; i < keys.length && i < 1000; i++) {
                      try {
                        const key = keys[i];
              const value = window[key];
                        if (value instanceof RTCPeerConnection) {
                          connections.push(key);
                          found++;
              }
            } catch (e) {}
          }
                  }
                } catch (e) {
                  console.warn('[AURRAY] Error searching window:', e);
                }
                
                return { found, connections, windowKeys: Object.keys(window).length };
              })()
            `,
            returnByValue: true,
          });

          if (result.result && result.result.value) {
            const data = result.result.value;
            if (data.found > 0) {
              this.logger.info(
                `CDP Runtime.evaluate found RTCPeerConnections in ${contextName}`,
                {
                  found: data.found,
                  connectionKeys: data.connections,
                  totalWindowKeys: data.windowKeys,
                }
              );

              // Inject hooking function into this context if not already there
              await cdpClient
                .send("Runtime.evaluate", {
                  expression: audioCaptureScript,
                  awaitPromise: true,
                })
                .catch(() => {
                  // Script might already be injected, that's okay
                });

              for (const key of data.connections) {
                try {
                  const hookResult = await cdpClient.send("Runtime.evaluate", {
                    expression: `
                      (function() {
                        const pc = window['${key}'];
                        if (pc instanceof RTCPeerConnection && window.aurrayHookConnection) {
                          window.aurrayHookConnection(pc);
                          return true;
                        }
                        return false;
                      })()
                    `,
                    returnByValue: true,
                  });
                  // Connection hooked - no need to log
                } catch (e) {
                  this.logger.warn(
                    `Error hooking connection in ${contextName}`,
                    { key, error: e.message }
                  );
                }
              }

              return data.found;
            }
          }
          return 0;
        } catch (e) {
          this.logger.warn(`Error searching ${contextName}`, {
            error: e.message,
          });
          return 0;
        }
      };

      const searchForAudioElements = async () => {
        try {
          // this.logger.info("Audio Element: Searching for <audio> elements");

          // Search for audio elements in main page and all frames
          const allFrames = [this.page.mainFrame(), ...this.page.frames()];
          let audioElementsFound = 0;

          for (const frame of allFrames) {
            try {
              const audioInfo = await frame.evaluate(() => {
                const audioElements = Array.from(
                  document.querySelectorAll("audio")
                );
                return audioElements.map((audio, index) => {
                  const hasSrc = !!audio.src;
                  const hasSrcObject = !!audio.srcObject;
                  const isPlaying =
                    !audio.paused && audio.currentTime > 0 && !audio.ended;
                  const volume = audio.volume;
                  const muted = audio.muted;

                  return {
                    index,
                    hasSrc,
                    hasSrcObject,
                    isPlaying,
                    volume,
                    muted,
                    src: audio.src || "",
                    id: audio.id || "",
                    className: audio.className || "",
                  };
                });
              });

              if (audioInfo && audioInfo.length > 0) {
                // this.logger.info(`Audio Element: Found ${audioInfo.length} <audio> elements in ${frame === this.page.mainFrame() ? 'main frame' : 'iframe'}`, {
                //   frameUrl: frame.url(),
                //   audioElements: audioInfo
                // });

                // Try to capture audio from these elements
                for (const audioEl of audioInfo) {
                  try {
                    // Inject audio capture for this audio element
                    // First ensure the audio capture script is injected in this frame
                    if (frame !== this.page.mainFrame()) {
                      await frame.evaluate(audioCaptureScript).catch(() => {
                        // Script might already be injected
                      });
                      // Wait a bit for script to initialize
                      await frame
                        .waitForFunction(
                          () =>
                            typeof window.aurrayAttachRemoteTrack ===
                            "function",
                          { timeout: 3000 }
                        )
                        .catch(() => {});
                    }

                    const captured = await frame.evaluate(
                      async (audioIndex) => {
                        const audioElements = Array.from(
                          document.querySelectorAll("audio")
                        );
                        const audio = audioElements[audioIndex];

                        if (!audio) return false;

                        // Check if we already have a capture for this audio element
                        if (audio.__aurrayAudioCapture) return true;

                        try {
                          // Instead of createMediaElementSource (which fails if already connected),
                          // capture directly from the srcObject MediaStream
                          if (
                            audio.srcObject &&
                            audio.srcObject instanceof MediaStream
                          ) {
                            const stream = audio.srcObject;
                            const audioTracks = stream.getAudioTracks();

                            if (
                              audioTracks.length > 0 &&
                              window.aurrayAttachRemoteTrack
                            ) {
                              // Try to attach each audio track
                              // Force attach since these are from audio elements (definitely remote)
                              for (const track of audioTracks) {
                                const attached =
                                  await window.aurrayAttachRemoteTrack(
                                    track,
                                    true
                                  );
                                if (attached) {
                                  audio.__aurrayAudioCapture = {
                                    stream,
                                    track,
                                  };
                                  console.log(
                                    "[AURRAY] Capturing audio from <audio> element srcObject:",
                                    audioIndex,
                                    track.id
                                  );
                                  return true;
                                }
                              }
                            }
                          }
                        } catch (e) {
                          console.error(
                            "[AURRAY] Error capturing audio from element:",
                            e
                          );
                          return false;
                        }

                        return false;
                      },
                      audioEl.index
                    );

                    if (captured) {
                      // this.logger.info('Audio Element: Successfully captured audio from element', { audioIndex: audioEl.index });
                    }

                    audioElementsFound++;
                  } catch (e) {
                    this.logger.warn("Error capturing audio from element", {
                      audioIndex: audioEl.index,
                      error: e.message,
                    });
                  }
                }
              }
            } catch (e) {
              this.logger.warn("Error searching for audio elements in frame", {
                frameUrl: frame.url(),
                error: e.message,
              });
            }
          }

          // this.logger.info('Audio Element: Search complete', { audioElementsFound });
          return audioElementsFound;
        } catch (e) {
          this.logger.warn("Error in audio element search", {
            error: e.message,
            stack: e.stack,
          });
          return 0;
        }
      };

      const searchForConnections = async () => {
        try {
          // this.logger.info(
          //   "CDP Target: Starting connection search in all contexts"
          // );

          // Search main window
          const mainFound = await searchInContext(client, "main window");

          // Get all targets (including iframes)
          const targetsResult = await client.send("Target.getTargets");
          const targets = targetsResult.targetInfos || [];

          // this.logger.info("CDP Target: Found targets", {
          //   count: targets.length,
          // });

          let totalFound = mainFound;

          // Also search for audio elements
          const audioFound = await searchForAudioElements();

          // Search each iframe target using Target.attachToTarget
          const iframeSessions = new Map();

          for (const target of targets) {
            if (target.type === "iframe" && target.targetId) {
              try {
                const attachResult = await client.send(
                  "Target.attachToTarget",
                  {
                    targetId: target.targetId,
                    flatten: true,
                  }
                );

                if (attachResult.sessionId) {
                  // Store session ID for potential future use
                  iframeSessions.set(target.targetId, attachResult.sessionId);
                  // Note: Playwright's CDP client doesn't directly support creating sessions from session IDs
                  // So we'll use the main client but with the attached session context
                }
              } catch (e) {
                this.logger.warn("Error attaching to iframe target", {
                  targetId: target.targetId,
                  error: e.message,
                });
              }
            }
          }

          // Also try searching iframes using Playwright's page.frames()
          try {
            const frames = this.page.frames();
            // this.logger.info("Playwright: Found frames", {
            //   count: frames.length,
            // });

            for (let i = 0; i < frames.length; i++) {
              const frame = frames[i];
              if (frame !== this.page.mainFrame() && frame.url()) {
                try {
                  // this.logger.info('Playwright: Searching iframe via frame.evaluate', { frameUrl: frame.url(), frameIndex: i });

                  const frameResult = await frame.evaluate(() => {
                    const connections = [];
                    let found = 0;

                    try {
                      if (window.RTCPeerConnection) {
                        const keys = Object.keys(window);
                        for (let i = 0; i < keys.length && i < 1000; i++) {
                          try {
                            const key = keys[i];
                            const value = window[key];
                            if (value instanceof RTCPeerConnection) {
                              connections.push(key);
                              found++;
                            }
                          } catch (e) {}
                        }
                      }
                    } catch (e) {
                      console.warn(
                        "[AURRAY] Error searching iframe window:",
                        e
                      );
                    }

                    return {
                      found,
                      connections,
                      windowKeys: Object.keys(window).length,
                    };
                  });

                  if (frameResult && frameResult.found > 0) {
                    this.logger.info(
                      "Playwright: Found RTCPeerConnections in iframe",
                      {
                        frameUrl: frame.url(),
                        found: frameResult.found,
                        connectionKeys: frameResult.connections,
                      }
                    );

                    // Inject hooking script into iframe
                    await frame.evaluate(audioCaptureScript).catch((e) => {
                      this.logger.warn("Error injecting script into iframe", {
                        frameUrl: frame.url(),
                        error: e.message,
                      });
                    });

                    // Hook connections in iframe
                    for (const key of frameResult.connections) {
                      try {
                        const hooked = await frame.evaluate((connKey) => {
                          const pc = window[connKey];
                          if (
                            pc instanceof RTCPeerConnection &&
                            window.aurrayHookConnection
                          ) {
                            window.aurrayHookConnection(pc);
                            return true;
                          }
                          return false;
                        }, key);

                        if (hooked) {
                          this.logger.info(
                            "Playwright: Hooked connection in iframe",
                            { frameUrl: frame.url(), key }
                          );
                          totalFound++;
                        }
                      } catch (e) {
                        this.logger.warn("Error hooking connection in iframe", {
                          frameUrl: frame.url(),
                          key,
                          error: e.message,
                        });
                      }
                    }
                  }
                } catch (e) {
                  this.logger.warn("Error searching iframe via Playwright", {
                    frameUrl: frame.url(),
                    error: e.message,
                  });
                }
              }
            }
          } catch (e) {
            this.logger.warn("Error getting frames from Playwright", {
              error: e.message,
            });
          }

          // this.logger.info('CDP Target: Connection search complete', { totalFound, audioElementsFound: audioFound });
        } catch (e) {
          this.logger.warn("Error in CDP Target search", {
            error: e.message,
            stack: e.stack,
          });
        }
      };

      setTimeout(async () => {
        await searchForConnections();
        this.audioSearchInterval = setInterval(async () => {
          try {
            await searchForConnections();
          } catch (e) {
            this.logger.warn("Error in CDP connection search", {
              error: e.message,
            });
            if (this.audioSearchInterval) {
              clearInterval(this.audioSearchInterval);
              this.audioSearchInterval = null;
            }
          }
        }, 10000);
      }, 3000);

      // Audio capture initialized
      this.cdpClient = client;
    } catch (error) {
      this.logger.error("Failed to setup CDP WebRTC audio capture", {
        error: error.message,
        stack: error.stack,
      });
      throw error;
    }
  }

  handleAudioFrame(frame) {
    if (!frame || !Array.isArray(frame.samples) || frame.samples.length === 0) {
      return;
    }

    this.audioFrameCount++;
    const frameRMS = frame.rms || 0;
    const sampleCount = frame.sampleCount || frame.samples.length;

    if (this.audioFrameCount === 1) {
      this.logger.info("🎵 Audio pipeline active", {
        meeting: `${sampleCount} samples @ 48kHz`,
        openai: "24kHz",
        connected: this.openaiConnected,
      });
    }

    // Convert Float32Array samples from meeting (48kHz)
    const inputSamples = new Float32Array(frame.samples);
    
    // Resample from 48kHz (meeting) to 24kHz (OpenAI) using proper interpolation
    const resampledSamples = resampleAudio(
      inputSamples,
      MEETING_SAMPLE_RATE,
      OPENAI_TARGET_SAMPLE_RATE
    );

    // Convert to PCM16 Int16Array
    const pcm16 = float32ToPCM16(resampledSamples);
    
    // Encode as base64
    const base64Audio = arrayBufferToBase64(pcm16.buffer);

    const now = Date.now();
    const timeSinceLastLog = now - this.lastAudioLogTime;

    // Check if OpenAI WebSocket is ready and connected
    const isWsReady = 
      this.openaiWs && 
      this.openaiWs.readyState === WebSocket.OPEN && 
      this.openaiConnected;

    if (isWsReady) {
      try {
        // Track send timing to diagnose blocking issues
        const sendStartTime = Date.now();
        
        // Send as JSON message to OpenAI Realtime API
        const message = {
          type: "input_audio_buffer.append",
          audio: base64Audio,
        };
        this.openaiWs.send(JSON.stringify(message));
        
        const sendDuration = Date.now() - sendStartTime;
        
        this.audioBytesSent += pcm16.length * 2; // 2 bytes per Int16 sample
        this.audioInputFramesSent++;
        
        // Log if send takes too long (might indicate blocking)
        if (sendDuration > 100) {
          this.logger.warn("⚠️ Slow WebSocket send detected", {
            duration_ms: sendDuration,
            frame: this.audioInputFramesSent,
            audioSize_bytes: base64Audio.length,
          });
        }

        // Periodic logging every 30 seconds (reduced frequency)
        if (timeSinceLastLog >= 30000) {
          const bytesPerSecond =
            (this.audioBytesSent / timeSinceLastLog) * 1000;
          this.logger.info("📤 Audio Input", {
            frames: this.audioInputFramesSent,
            rate: `${Math.round(bytesPerSecond / 1000)}KB/s`,
            wsReadyState: this.openaiWs?.readyState,
            connectionState: this.connectionState,
          });
          this.lastAudioLogTime = now;
        }
      } catch (error) {
        // WebSocket error - mark as disconnected but don't break flow
        this.logger.warn("Failed to send audio to OpenAI, marking as disconnected", { 
          error: error.message,
          frame: this.audioInputFramesSent,
          wsReadyState: this.openaiWs?.readyState,
        });
        this.openaiConnected = false;
        this.openaiWs = null;
        this.connectionState = "disconnected";
        // Schedule reconnection (non-blocking, with backoff)
        this.scheduleReconnect();
      }
    } else {
      // WebSocket not ready - log occasionally but don't spam
      if (timeSinceLastLog >= 5000 || this.audioFrameCount <= 10) {
        this.logger.debug("Audio frames received but OpenAI WebSocket not ready", {
          frames: this.audioFrameCount,
          wsReady: this.openaiWs?.readyState === WebSocket.OPEN,
          wsConnected: this.openaiConnected,
          wsState: this.openaiWs?.readyState,
          connectionState: this.connectionState,
        });
        this.lastAudioLogTime = now;
      }
    }
  }

  handleAudioChunk(buffer) {
    // Buffer is already decoded from base64 in handleOpenAIMessage
    // It's an ArrayBuffer containing PCM16 Int16 samples at 24kHz
    const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    
    // Convert PCM16 Int16Array to Float32Array
    const pcm16Array = new Int16Array(buf.buffer, buf.byteOffset, buf.length / 2);
    const samples24k = pcm16ToFloat32(pcm16Array);

    if (samples24k.length === 0) {
      this.logger.warn("⚠️ Received empty audio chunk from OpenAI");
      return;
    }

    this.audioOutputChunksReceived++;
    const now = Date.now();
    const timeSinceLastLog = now - this.lastSpeechLogTime;


    // Resample from 24kHz (OpenAI) to 48kHz (meeting) using proper interpolation
    const samples48k = resampleAudio(
      samples24k,
      OPENAI_TARGET_SAMPLE_RATE,
      MEETING_SAMPLE_RATE
    );

    // Convert Float32Array to regular array for page.evaluate
    const samples48kArray = Array.from(samples48k);

    // Periodic logging every 30 seconds (reduced frequency)
    if (timeSinceLastLog >= 30000) {
      this.logger.info("📥 Audio Output", {
        chunks: this.audioOutputChunksReceived,
      });
      this.lastSpeechLogTime = now;
    }

    // Only attempt to play audio if we have a valid connection and page
    if (!this.openaiConnected || !this.page || this.page.isClosed()) {
      return; // Silently skip if connection/page is invalid
    }
    
    this.playAudioToMeeting(samples48kArray).catch((error) => {
      // Only log if it's not a page-closed error (those are expected during cleanup)
      if (!error.message.includes("closed") && !error.message.includes("Target page")) {
      this.logger.error("❌ Failed to play audio to meeting", {
        error: error.message,
          samples: samples48kArray.length,
      });
      }
      // Don't throw - prevent error loops
    });
  }

  async playAudioToMeeting(audioData) {
    // Early return if page is closed or connection is invalid
    if (!this.page || this.page.isClosed() || !this.openaiConnected) {
      return;
    }
    
    try {
      await this.page.evaluate((samples) => {
        if (typeof window.aurrayInjectAudio48k === "function") {
          window.aurrayInjectAudio48k(samples);
        } else {
          throw new Error("aurrayInjectAudio48k not found");
        }
      }, audioData);
      
      // Audio injected successfully - no need to log every injection
    } catch (error) {
      // Check if it's a page-closed error (expected during cleanup)
      if (error.message.includes("closed") || error.message.includes("Target page")) {
        return; // Silently return, don't log or throw
      }
      
      // For other errors, log but don't throw to prevent error loops
      this.logger.error("❌ Error playing audio to meeting", {
        error: error.message,
        samples: audioData.length,
      });
      // Don't throw - let the error handler in handleAudioChunk deal with it
    }
  }

  async setupVirtualMic() {
    this.logger.info("Setting up virtual microphone");
    
    const pageUrl = this.page.url();
    const frameInfo = await this.page.evaluate(() => {
      return {
        url: window.location.href,
        origin: window.location.origin,
        frameName: window.name || 'main',
        isTopFrame: window === window.top,
        frameCount: window.frames.length
      };
    }).catch(() => ({ error: 'Could not get frame info' }));
    
    // Virtual mic setup - context logging removed (too verbose)

    await this.page.evaluate(() => {
      const AudioContextClass =
        window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) {
        throw new Error("AudioContext not available");
      }

      const contextInfo = {
        url: window.location.href,
        origin: window.location.origin,
        frameName: window.name || 'main',
        isTopFrame: window === window.top
      };
      console.log("[AURRAY] Creating AudioContext for virtual mic", contextInfo);

      const ctx = new AudioContextClass({ sampleRate: 48000 });
      window.__aurrayMasterAudioContext = ctx;
      console.log("[AURRAY] AudioContext created", {
        ...contextInfo,
        state: ctx.state,
        sampleRate: ctx.sampleRate
      });

      const buffer = [];
      let readIndex = 0;
      const processor = ctx.createScriptProcessor(1024, 1, 1);

      let tonePhase = 0;
      const TONE_FREQ = 20;
      const TONE_AMPLITUDE = 0.0001;

      processor.onaudioprocess = (event) => {
        const output = event.outputBuffer.getChannelData(0);
        const len = output.length;
        const sampleRate = event.outputBuffer.sampleRate;

        for (let i = 0; i < len; i++) {
          if (readIndex < buffer.length) {
            output[i] = buffer[readIndex++];
          } else {
            tonePhase += (TONE_FREQ / sampleRate) * 2 * Math.PI;
            if (tonePhase > 2 * Math.PI) tonePhase -= 2 * Math.PI;
            output[i] = Math.sin(tonePhase) * TONE_AMPLITUDE;
          }
        }

        if (readIndex > 48000 * 5) {
          buffer.splice(0, readIndex);
          readIndex = 0;
        }
      };

      const gain = ctx.createGain();
      gain.gain.value = 0.0;
      processor.connect(gain);
      gain.connect(ctx.destination);

      const dest = ctx.createMediaStreamDestination();
      processor.connect(dest);

      // Teams-specific: Configure track to appear as a valid device
      const audioTrack = dest.stream.getAudioTracks()[0];
      const isTeams = window.location.href.includes('teams.microsoft.com');
      if (audioTrack && isTeams) {
        // Override getSettings to return device info that Teams expects
        const originalGetSettings = audioTrack.getSettings.bind(audioTrack);
        audioTrack.getSettings = function() {
          const settings = originalGetSettings();
          // Return settings that Teams will accept
          return {
            ...settings,
            deviceId: 'default', // Use 'default' which Teams should recognize
            groupId: '',
            autoGainControl: true,
            echoCancellation: true,
            noiseSuppression: true
          };
        };
        
        // Override getCapabilities to return proper capabilities
        const originalGetCapabilities = audioTrack.getCapabilities ? audioTrack.getCapabilities.bind(audioTrack) : null;
        if (originalGetCapabilities) {
          audioTrack.getCapabilities = function() {
            const caps = originalGetCapabilities();
            return {
              ...caps,
              autoGainControl: { ideal: true },
              echoCancellation: { ideal: true },
              noiseSuppression: { ideal: true }
            };
          };
        }
      }

      window.aurrayVirtualMicStream = dest.stream;
      let totalSamplesInjected = 0; // Declare the variable
      window.aurrayInjectAudio48k = (samples) => {
        if (!samples || !samples.length) {
          return;
        }
        for (let i = 0; i < samples.length; i++) {
          buffer.push(samples[i]);
        }
        totalSamplesInjected += samples.length;
      };
      
      const finalContextInfo = {
        url: window.location.href,
        origin: window.location.origin,
        frameName: window.name || 'main',
        isTopFrame: window === window.top,
        streamId: dest.stream.id,
        trackCount: dest.stream.getAudioTracks().length,
        trackIds: dest.stream.getAudioTracks().map(t => t.id),
        trackStates: dest.stream.getAudioTracks().map(t => t.readyState),
        audioContextState: ctx.state,
        hasInjectFunction: typeof window.aurrayInjectAudio48k === 'function',
        isTeams: isTeams,
        trackConfigured: isTeams && audioTrack ? typeof audioTrack.getSettings === 'function' : false
      };
      // Virtual microphone initialized - console log removed (too verbose)
    });

    await this.page.waitForFunction(() => !!window.aurrayVirtualMicStream, {
      timeout: 10000,
    });
    
    // Verify virtual mic is available and log details
    const virtualMicStatus = await this.page.evaluate(() => {
      return {
        url: window.location.href,
        origin: window.location.origin,
        frameName: window.name || 'main',
        isTopFrame: window === window.top,
        hasVirtualStream: !!window.aurrayVirtualMicStream,
        streamId: window.aurrayVirtualMicStream?.id || 'N/A',
        trackCount: window.aurrayVirtualMicStream?.getAudioTracks().length || 0,
        hasInjectFunction: typeof window.aurrayInjectAudio48k === 'function',
        hasAudioContext: !!window.__aurrayMasterAudioContext,
        audioContextState: window.__aurrayMasterAudioContext?.state || 'N/A'
      };
    }).catch(() => ({ error: 'Could not evaluate virtual mic status' }));
    
    this.logger.info("Virtual microphone ready", virtualMicStatus);
  }

  async saveAuthState() {
    if (this.config.platform === "google_meet") {
      try {
        const authStatePath = path.resolve(__dirname, "google_auth_state.json");
        await this.context.storageState({ path: authStatePath });
        this.logger.info("Auth state saved", { path: authStatePath });
      } catch (error) {
        this.logger.warn("Failed to save auth state", { error: error.message });
      }
    }
  }

  async cleanup() {
    this.logger.info("Cleaning up browser bot resources");

    // Send status update before closing connections (fire-and-forget)
    try {
      this.sendStatusUpdate(
        "cleaning_up",
        "Bot is shutting down and cleaning up resources",
        { platform: this.config.platform }
      );
    } catch (error) {
      this.logger.warn("Failed to send cleanup status update", {
        error: error.message,
      });
    }

    // Clear reconnection timeout
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    // Cleanup platform-specific resources (e.g., polling intervals)
    if (this.platform && typeof this.platform.cleanup === 'function') {
      try {
        await this.platform.cleanup();
      } catch (error) {
        this.logger.warn("Error cleaning up platform resources", {
          error: error.message,
        });
      }
    }

    // Clear audio search interval
    if (this.audioSearchInterval) {
      clearInterval(this.audioSearchInterval);
      this.audioSearchInterval = null;
    }

    // Close CDP client if it exists
    if (this.cdpClient) {
      try {
        await this.cdpClient.close();
        this.cdpClient = null;
      } catch (error) {
        this.logger.warn("Error closing CDP client", { error: error.message });
      }
    }

    // Close OpenAI WebSocket gracefully
    if (this.openaiWs) {
      try {
        // Check if WebSocket is in a state that can be closed
        if (
          this.openaiWs.readyState === WebSocket.OPEN ||
          this.openaiWs.readyState === WebSocket.CONNECTING
        ) {
          this.openaiWs.close();
        }
      } catch (error) {
        this.logger.warn("Error closing OpenAI WebSocket", { error: error.message });
      }
    }
    this.openaiWs = null;
    this.openaiConnected = false;
    this.connectionState = "disconnected";
    this.voiceState = "idle";
    
    // Legacy gateway cleanup (for backward compatibility)
    if (this.gateway) {
      try {
        if (
          this.gateway.readyState === WebSocket.OPEN ||
          this.gateway.readyState === WebSocket.CONNECTING
        ) {
          this.gateway.close();
        }
      } catch (error) {
        this.logger.warn("Error closing legacy gateway WebSocket", { error: error.message });
      }
    }
    this.gateway = null;
    this.gatewayConnected = false;

    if (this.page && !this.page.isClosed()) {
      try {
        await this.page.close({ runBeforeUnload: false });
      } catch (error) {
        this.logger.warn("Error closing page", { error: error.message });
      }
    }

    if (this.context) {
      try {
        await this.context.close();
      } catch (error) {
        this.logger.warn("Error closing browser context", {
          error: error.message,
        });
      }
    }

    if (this.browser) {
      try {
        await this.browser.close();
      } catch (error) {
        this.logger.warn("Error closing browser", { error: error.message });
      }
    }
  }
}

async function main() {
  // Bot uses Python backend (port 8000) for OpenAI Realtime API proxy
  // OPENAI_REALTIME_WS_URL is provided by the backend via environment variable
  
  if (!config.openaiRealtimeWsUrl) {
    console.error("[ERROR] OPENAI_REALTIME_WS_URL is required. Bot cannot connect to OpenAI without it.");
    throw new Error("OPENAI_REALTIME_WS_URL environment variable is required");
  }
  
  console.log(`[INFO] ✅ Using Python backend proxy for OpenAI Realtime API`);
  console.log(`[INFO] ✅ OpenAI WebSocket URL: ${config.openaiRealtimeWsUrl.substring(0, 60)}...`);

  const bot = new BrowserBot(config);
  await bot.start();
}

if (require.main === module) {
  main().catch(async (error) => {
    console.error("[ERROR] Browser bot terminated with error", error);
    process.exit(1);
  });
}

module.exports = {
  main,
  config,
};
