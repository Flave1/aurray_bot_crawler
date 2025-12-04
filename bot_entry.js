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
};

const fakeWavPath = path.resolve(__dirname, 'fake.wav');
const fakeY4mPath = path.resolve(__dirname, 'fake.y4m');
const DEFAULT_BROWSER_ARGS = [
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
    this.gateway = null;
    this.gatewayConnected = false;
    this.audioFrameCount = 0;
    this.audioBytesSent = 0;
    this.lastAudioLogTime = Date.now();
    this.speechChunksReceived = 0;
    this.speechBytesReceived = 0;
    this.lastSpeechLogTime = Date.now();
    this.cdpClient = null;
  }

  async sendStatusUpdate(stage, message, metadata = {}) {
    /**
     * Send automation status update to backend API.
     * This updates the frontend via WebSocket through the backend.
     * Fire-and-forget: non-blocking, never throws errors.
     */
    if (!this.config.sessionId) {
      this.logger.warn("Cannot send status update: sessionId not available");
      return;
    }

    // Fire and forget - don't block the flow
    setImmediate(async () => {
      try {
        const apiUrl = new URL("/api/demo/status", this.config.apiBaseUrl);
        const payload = JSON.stringify({
          sessionId: this.config.sessionId,
          stage: stage,
          message: message,
          metadata: metadata,
        });

        const requestModule = apiUrl.protocol === "https:" ? https : http;

        return new Promise((resolve, reject) => {
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
              timeout: 5000,
            },
            (res) => {
              let data = "";
              res.on("data", (chunk) => {
                data += chunk;
              });
              res.on("end", () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                  this.logger.debug("Status update sent successfully", {
                    stage,
                    statusCode: res.statusCode,
                  });
                  resolve();
                } else {
                  this.logger.warn("Status update failed", {
                    stage,
                    statusCode: res.statusCode,
                    response: data,
                  });
                  resolve(); // Don't reject - just resolve silently
                }
              });
            }
          );

          req.on("error", (error) => {
            this.logger.warn("Failed to send status update", {
              stage,
              error: error.message,
              apiBaseUrl: this.config.apiBaseUrl,
            });
            resolve(); // Don't reject - just resolve silently
          });

          req.on("timeout", () => {
            req.destroy();
            this.logger.warn("Status update request timeout", { stage });
            resolve(); // Don't reject - just resolve silently
          });

          req.write(payload);
          req.end();
        });
      } catch (error) {
        this.logger.warn("Error sending status update", {
          stage,
          error: error.message,
        });
        // Don't throw - status updates are non-critical
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
      // Send initial status
      await this.sendStatusUpdate(
        "initializing",
        "Bot is initializing...",
        { meetingUrl: this.config.meetingUrl, platform: this.config.platform }
      );

      this.registerSignalHandlers();
      
      // Launch browser
      await this.launchBrowser();
      await this.sendStatusUpdate(
        "browser_launched",
        "Browser launched successfully",
        { headless: this.config.headless }
      );

      // Navigate to meeting
      await this.sendStatusUpdate(
        "navigating",
        "Navigating to meeting URL...",
        { meetingUrl: this.config.meetingUrl }
      );
      await this.navigateToMeeting();
      
      // Join meeting
      await this.sendStatusUpdate(
        "joining_meeting",
        "Joining the meeting...",
        { platform: this.config.platform }
      );
      await this.joinMeeting();
      
      // Send status that we're in the meeting
      await this.sendStatusUpdate(
        "in_meeting",
        "Successfully joined the meeting",
        { platform: this.config.platform, botName: this.config.botName }
      );
      await this.sendStatusUpdate(
        "waiting_to_admit",
        "Waiting to admit users into the meeting",
        { platform: this.config.platform, botName: this.config.botName }
      );

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
      await this.sendStatusUpdate(
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

            this.logger.info("Audio capture status", audioStatus);
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

    const contextOptions = {
      viewport: { width: 1280, height: 720 },
      ignoreHTTPSErrors: true,
      locale: this.config.browserLocale,
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
    };

    if (this.config.platform === "google_meet") {
      const authStatePath = path.resolve(__dirname, "google_auth_state.json");
      if (fs.existsSync(authStatePath)) {
        contextOptions.storageState = authStatePath;
        this.logger.info("Using Google auth storageState", { authStatePath });
      }
    }

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
        
        // Teams-specific: If virtual stream is missing, try to create it inline
        if (!virtualStream && window.location.href.includes('teams.microsoft.com') && window.location.href.includes('light-meetings')) {
          console.log("[AURRAY] Teams: Virtual stream missing, attempting inline initialization");
          try {
            const AudioContextClass = window.AudioContext || window.webkitAudioContext;
            if (AudioContextClass) {
              const ctx = new AudioContextClass({ sampleRate: 48000 });
              window.__aurrayMasterAudioContext = ctx;
              
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
              if (audioTrack) {
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
              };
              
              virtualStream = dest.stream;
              console.log("[AURRAY] Teams: Virtual stream created inline", {
                streamId: dest.stream.id,
                trackCount: dest.stream.getAudioTracks().length,
                trackId: audioTrack?.id,
                hasGetSettings: typeof audioTrack?.getSettings === 'function'
              });
            }
          } catch (error) {
            console.error("[AURRAY] Teams: Failed to create virtual stream inline", error);
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
      
      await this.platform.joinMeeting();
      
      // For Teams: Re-initialize virtual mic if page navigated to meeting page
      if (this.config.platform === 'teams') {
        const currentUrl = this.page.url();
        const isMeetingPage = currentUrl.includes('light-meetings/launch');
        const wasLauncherPage = initialUrl && initialUrl.includes('dl/launcher');
        
        if (isMeetingPage && wasLauncherPage) {
          this.logger.info('Teams: Detected navigation to meeting page, re-initializing virtual mic');
          await this.setupVirtualMic();
        }
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
    return new Promise((resolve, reject) => {
      const gatewayUrl = new URL(this.config.rtGatewayUrl);
      const baseUrl = `${gatewayUrl.protocol}//${gatewayUrl.host}`;
      const wsUrl = `${baseUrl}/ws/bot/${this.config.sessionId}`;

      this.logger.info("Connecting to audio streaming WebSocket", { url: wsUrl });

      const ws = new WebSocket(wsUrl);
      ws.binaryType = "arraybuffer";

      let isConnected = false; // Track connection state
      
      // Set connection timeout - this WebSocket is critical for audio streaming
      const connectionTimeout = setTimeout(() => {
        if (!isConnected && ws.readyState !== WebSocket.OPEN) {
          this.logger.error("Audio WebSocket connection timeout - this is critical for audio streaming");
          try {
            ws.close();
          } catch (e) {
            // Ignore errors when closing
          }
          this.gateway = null;
          this.gatewayConnected = false;
          reject(new Error(`Audio WebSocket connection timeout after 15 seconds - cannot stream audio without this connection`));
        }
      }, 15000); // 15 second timeout for critical audio WebSocket

      ws.on("open", () => {
        clearTimeout(connectionTimeout);
        isConnected = true;
        this.logger.info("Audio WebSocket connected successfully");
        this.gateway = ws;
        this.gatewayConnected = true;

        try {
          ws.send(
            JSON.stringify({
              type: "register",
              sessionId: this.config.sessionId,
            })
          );
        } catch (error) {
          this.logger.warn("Failed to send WebSocket registration", {
            error: error.message,
          });
          // Continue anyway
        }

        this.logger.info("WebSocket ready for audio", {
          audioFramesReceived: this.audioFrameCount,
          audioBytesSent: this.audioBytesSent,
        });

        resolve();
      });

      ws.on("message", (data) => {
        try {
          if (data instanceof ArrayBuffer || Buffer.isBuffer(data)) {
            // Log backend speech response
            const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
            this.speechChunksReceived++;
            this.speechBytesReceived += buf.length;

            const timeSinceLastLog = Date.now() - this.lastSpeechLogTime;
            if (timeSinceLastLog >= 5000) {
              this.logger.info("Backend speech stats", {
                chunksReceived: this.speechChunksReceived,
                totalBytesReceived: this.speechBytesReceived,
                avgChunkSize:
                  this.speechBytesReceived / this.speechChunksReceived,
                bytesPerSecond:
                  (this.speechBytesReceived / timeSinceLastLog) * 1000,
              });
              this.lastSpeechLogTime = Date.now();
            }

            if (this.speechChunksReceived === 1) {
              this.logger.info("First speech chunk received from backend", {
                bytes: buf.length,
              });
            }

            this.handleAudioChunk(data);
          } else {
            this.logger.debug("Received non-audio message from backend", {
              type: typeof data,
              dataLength: data?.length,
            });
          }
        } catch (error) {
          this.logger.warn("Error handling WebSocket message", {
            error: error.message,
          });
          // Continue - don't break on message handling errors
        }
      });

      ws.on("error", (error) => {
        clearTimeout(connectionTimeout);
        if (!isConnected) {
          this.logger.error("Audio WebSocket connection error - this is critical", { 
            error: error.message,
            url: wsUrl
          });
          this.gateway = null;
          this.gatewayConnected = false;
          // Reject - audio WebSocket is critical, bot cannot function without it
          reject(new Error(`Failed to connect audio WebSocket: ${error.message}`));
        } else {
          // Connection was established but now has an error - log but don't reject
          this.logger.warn("Audio WebSocket error after connection", { 
            error: error.message 
          });
        }
      });

      ws.on("close", (code, reason) => {
        clearTimeout(connectionTimeout);
        
        // Only log warning if connection was already established
        // If it closes before opening, error handler will have already rejected
        if (this.gatewayConnected) {
          this.logger.warn("Audio WebSocket closed after connection", { 
            code, 
            reason: reason?.toString() 
          });
        }
        
        if (this.gateway === ws) {
          this.gateway = null;
        }
        this.gatewayConnected = false;
        // Don't reject on close after connection - it's normal lifecycle
      });

      // Store reference only after setting up all handlers
      // Don't set this.gateway yet - wait for 'open' event
    });
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
        this.logger.info(
          "Injecting audio capture script via CDP Runtime.evaluate"
        );
        await client.send("Runtime.evaluate", {
          expression: audioCaptureScript,
          awaitPromise: true,
        });
        this.logger.info(
          "Audio capture script injected and initialized via CDP"
        );
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
        this.logger.info("Audio capture script verified and ready");
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
                  this.logger.info(
                    `CDP Runtime.evaluate: Hooked connection in ${contextName}`,
                    { key, success: hookResult.result?.value }
                  );
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
                this.logger.info("CDP Target: Attaching to iframe", {
                  targetId: target.targetId,
                  url: target.url,
                });

                const attachResult = await client.send(
                  "Target.attachToTarget",
                  {
                    targetId: target.targetId,
                    flatten: true,
                  }
                );

                if (attachResult.sessionId) {
                  // Create a new CDP client for this iframe session
                  // Note: Playwright's CDP client doesn't directly support creating sessions from session IDs
                  // So we'll use the main client but with the attached session context
                  // For now, let's try using Runtime.evaluate with the session
                  this.logger.info("CDP Target: Attached to iframe", {
                    targetId: target.targetId,
                    sessionId: attachResult.sessionId,
                  });

                  // Store session ID for potential future use
                  iframeSessions.set(target.targetId, attachResult.sessionId);

                  // Try to search in this iframe using the main client
                  // We'll need to use a different approach since we can't easily create a new CDP client
                  // Let's use Playwright's page.frames() instead
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
        this.logger.info(
          "CDP Runtime.evaluate: Starting initial connection search"
        );
        await searchForConnections();
        this.logger.info(
          "CDP Runtime.evaluate: Setting up periodic search (every 10s)"
        );
        const searchInterval = setInterval(async () => {
          try {
            await searchForConnections();
          } catch (e) {
            this.logger.warn("Error in CDP connection search interval", {
              error: e.message,
            });
            clearInterval(searchInterval);
          }
        }, 10000);
      }, 3000);

      this.logger.info("CDP Runtime.evaluate-based audio capture initialized");
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
      this.logger.info("First audio frame received", {
        rms: frameRMS.toFixed(4),
        samples: sampleCount,
        wsReady: this.gateway?.readyState === WebSocket.OPEN,
        wsConnected: this.gatewayConnected,
      });
    }

    const sourceSampleRate = 48000;
    const targetSampleRate = 16000;
    const resampleFactor = sourceSampleRate / targetSampleRate;

    const resampledLength = Math.floor(frame.samples.length / resampleFactor);
    const resampledSamples = new Array(resampledLength);
    for (let i = 0; i < resampledLength; i++) {
      const sourceIndex = Math.floor(i * resampleFactor);
      resampledSamples[i] = frame.samples[sourceIndex] || 0;
    }

    const pcmBuffer = Buffer.alloc(resampledSamples.length * 2);
    for (let i = 0; i < resampledSamples.length; i++) {
      const value = Math.max(-1, Math.min(1, resampledSamples[i] || 0));
      const int16 = value < 0 ? value * 0x8000 : value * 0x7fff;
      pcmBuffer.writeInt16LE(int16, i * 2);
    }

    const now = Date.now();
    const timeSinceLastLog = now - this.lastAudioLogTime;

    // Check if WebSocket is ready and connected
    const isWsReady = 
      this.gateway && 
      this.gateway.readyState === WebSocket.OPEN && 
      this.gatewayConnected;

    if (isWsReady) {
      try {
        this.gateway.send(pcmBuffer);
        this.audioBytesSent += pcmBuffer.length;

        if (timeSinceLastLog >= 5000) {
          const avgFrameSize = this.audioBytesSent / this.audioFrameCount;
          const bytesPerSecond =
            (this.audioBytesSent / timeSinceLastLog) * 1000;
          // this.logger.info("Audio capture stats", {
          //   frames: this.audioFrameCount,
          //   totalBytes: this.audioBytesSent,
          //   avgFrameSize: Math.round(avgFrameSize),
          //   bytesPerSecond: Math.round(bytesPerSecond),
          //   lastFrameRMS: frameRMS.toFixed(4),
          //   lastFrameSamples: sampleCount,
          // });
          this.lastAudioLogTime = now;
        }
      } catch (error) {
        // WebSocket error - mark as disconnected but don't break flow
        this.logger.warn("Failed to send audio, marking WebSocket as disconnected", { 
          error: error.message 
        });
        this.gatewayConnected = false;
        this.gateway = null;
        // Try to reconnect in background (non-blocking)
        this.connectWebSocket().catch(() => {
          // Reconnection failed, continue anyway
        });
      }
    } else {
      // WebSocket not ready - log occasionally but don't spam
      if (timeSinceLastLog >= 5000 || this.audioFrameCount <= 10) {
        this.logger.debug("Audio frames received but WebSocket not ready", {
          frames: this.audioFrameCount,
          wsReady: this.gateway?.readyState === WebSocket.OPEN,
          wsConnected: this.gatewayConnected,
          wsState: this.gateway?.readyState,
        });
        this.lastAudioLogTime = now;
      }
    }
  }

  handleAudioChunk(buffer) {
    const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    const samples16k = [];
    for (let i = 0; i < buf.length; i += 2) {
      if (i + 2 <= buf.length) {
        const int16Sample = buf.readInt16LE(i);
        const floatSample = int16Sample / 32768.0;
        samples16k.push(floatSample);
      }
    }

    if (samples16k.length === 0) {
      this.logger.warn("⚠️ Received empty audio chunk from backend");
      return;
    }

    // Convert 16kHz to 48kHz by tripling each sample
    const samples48k = new Array(samples16k.length * 3);
    for (let i = 0; i < samples16k.length; i++) {
      const s = samples16k[i];
      const idx = i * 3;
      samples48k[idx] = s;
      samples48k[idx + 1] = s;
      samples48k[idx + 2] = s;
    }

    this.logger.debug("Playing audio chunk to meeting", {
      samples16k: samples16k.length,
      samples48k: samples48k.length,
    });

    this.playAudioToMeeting(samples48k).catch((error) => {
      this.logger.error("❌ Failed to play audio to meeting", {
        error: error.message,
        errorStack: error.stack,
        samples: samples48k.length,
      });
    });
  }

  async playAudioToMeeting(audioData) {
    try {
      const contextInfo = await this.page.evaluate((samples) => {
        const info = {
          url: window.location.href,
          origin: window.location.origin,
          frameName: window.name || 'main',
          isTopFrame: window === window.top,
          hasInjectFunction: typeof window.aurrayInjectAudio48k === 'function',
          hasVirtualStream: !!window.aurrayVirtualMicStream,
          hasAudioContext: !!window.__aurrayMasterAudioContext,
          audioContextState: window.__aurrayMasterAudioContext?.state || 'N/A'
        };
        
        if (typeof window.aurrayInjectAudio48k === "function") {
          window.aurrayInjectAudio48k(samples);
          console.log("[AURRAY] Injected audio samples", {
            ...info,
            sampleCount: samples.length
          });
        } else {
          console.warn("[AURRAY] aurrayInjectAudio48k not available", info);
          throw new Error("aurrayInjectAudio48k not found");
        }
        return info;
      }, audioData);
      
      this.logger.debug("Audio injected successfully", contextInfo);
    } catch (error) {
      this.logger.error("❌ Error playing audio to meeting", {
        error: error.message,
        errorStack: error.stack,
        samples: audioData.length,
      });
      throw error;
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
    
    this.logger.info("Virtual mic setup context", {
      pageUrl,
      frameInfo
    });

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
      window.aurrayInjectAudio48k = (samples) => {
        if (!samples || !samples.length) {
          return;
        }
        for (let i = 0; i < samples.length; i++) {
          buffer.push(samples[i]);
        }
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
      console.log("[AURRAY] Virtual microphone initialized", finalContextInfo);
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

    // Close WebSocket gracefully
    if (this.gateway) {
      try {
        // Check if WebSocket is in a state that can be closed
        if (
          this.gateway.readyState === WebSocket.OPEN ||
          this.gateway.readyState === WebSocket.CONNECTING
        ) {
          this.gateway.close();
        }
      } catch (error) {
        this.logger.warn("Error closing WebSocket", { error: error.message });
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
