/**
 * HTTP server for managing browser bot meetings.
 * Uses direct module import instead of subprocesses for better performance and reliability.
 */

const express = require("express");
const path = require("path");
const { BrowserBot } = require("./bot_entry_v2.js");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3001;
const activeMeetings = new Map(); // meetingId -> { bot, startTime, envVars, logs }

// Helper function to parse boolean from string
function parseBoolean(value, defaultValue) {
  if (value === undefined || value === null || value === "") {
    return defaultValue;
  }
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

// Helper function to convert env vars to bot config
function envVarsToConfig(envVars) {
  return {
    meetingUrl: envVars.MEETING_URL,
    botName: envVars.BOT_NAME || "Aurray Bot",
    platform: envVars.PLATFORM || "google_meet",
    headless: parseBoolean(envVars.HEADLESS, true),
    shouldSendStatus: parseBoolean(envVars.SHOULD_SEND_STATUS, false),
    browserEngine: (envVars.BROWSER_ENGINE || "chromium").toLowerCase(),
    browserLocale: envVars.BROWSER_LOCALE || "en-US",
    browserArgs: envVars.BROWSER_ARGS
      ? envVars.BROWSER_ARGS.split(",")
          .map((arg) => arg.trim())
          .filter(Boolean)
      : [],
    navigationTimeoutMs: parseInt(envVars.NAVIGATION_TIMEOUT_MS || "45000", 10),
    logLevel: (envVars.LOG_LEVEL || "info").toLowerCase(),
    sessionId: envVars.SESSION_ID || envVars.MEETING_ID,
    apiBaseUrl: envVars.API_BASE_URL,
    isOrganizer: parseBoolean(envVars.IS_ORGANIZER, false),
    openaiApiKey: envVars.OPENAI_API_KEY,
    openaiRealtimeWsUrl: envVars.OPENAI_REALTIME_WS_URL,
    voice: envVars.VOICE || "alloy",
    instructions: envVars.INSTRUCTIONS || "You are a helpful meeting assistant. Keep responses concise and professional.",
  };
}

/**
 * Health check endpoint
 */
app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    activeMeetings: activeMeetings.size,
    timestamp: new Date().toISOString(),
  });
});

/**
 * Start a new meeting bot
 * POST /start-meeting
 * Body: { meetingId, meetingUrl, platform, botName, sessionId, ...envVars }
 */
app.post("/start-meeting", async (req, res) => {
  try {
    const {
      meetingId,
      meetingUrl,
      platform,
      botName,
      sessionId,
      ...additionalEnvVars
    } = req.body;

    // Validate required fields
    if (!meetingId) {
      return res.status(400).json({ error: "meetingId is required" });
    }
    if (!meetingUrl) {
      return res.status(400).json({ error: "meetingUrl is required" });
    }

    // Check if meeting is already active
    if (activeMeetings.has(meetingId)) {
      return res.status(409).json({
        error: "Meeting already active",
        meetingId,
      });
    }

    // Prepare environment variables for bot config
    const envVars = {
      ...process.env, // Inherit parent process env
      MEETING_ID: meetingId,
      MEETING_URL: meetingUrl,
      PLATFORM: platform || "google_meet",
      BOT_NAME: botName || "Aurray Bot",
      SESSION_ID: sessionId || meetingId,
      ...additionalEnvVars, // Allow additional env vars from request
    };

    // Convert env vars to bot config
    const botConfig = envVarsToConfig(envVars);

    // Create log capture system
    const logs = [];
    const maxLogLines = 1000; // Keep last 1000 lines per meeting

    const logLine = (source, message, meta = {}) => {
      const timestamp = new Date().toISOString();
      const metaStr = Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : "";
      const logEntry = `[${timestamp}] [${meetingId}] [${source}] ${message}${metaStr}`;
      console.log(logEntry);
      logs.push(logEntry);
      // Keep only last maxLogLines
      if (logs.length > maxLogLines) {
        logs.shift();
      }
    };

    // Create bot instance
    const bot = new BrowserBot(botConfig);

    // Override bot's logger to capture logs
    const originalLogger = bot.logger;
    
    // Create a wrapper logger that captures all logs
    class LogCaptureLogger {
      constructor(original, logCaptureFn) {
        this.original = original;
        this.logCaptureFn = logCaptureFn;
        this.level = original.level;
        this.context = original.context;
      }

      child(extra = {}) {
        return new LogCaptureLogger(this.original.child(extra), this.logCaptureFn);
      }

      info(message, meta = {}) {
        this.original.info(message, meta);
        this.logCaptureFn("INFO", message, meta);
      }

      warn(message, meta = {}) {
        this.original.warn(message, meta);
        this.logCaptureFn("WARN", message, meta);
      }

      error(message, meta = {}) {
        this.original.error(message, meta);
        this.logCaptureFn("ERROR", message, meta);
      }

      debug(message, meta = {}) {
        this.original.debug(message, meta);
        this.logCaptureFn("DEBUG", message, meta);
      }
    }

    bot.logger = new LogCaptureLogger(originalLogger, logLine);

    // Start bot asynchronously (don't await to return response immediately)
    bot.start().catch((error) => {
      const errorLog = `[${new Date().toISOString()}] [${meetingId}] [ERROR] Bot failed: ${error.message}`;
      console.error(errorLog);
      logs.push(errorLog);
      logs.push(`[${new Date().toISOString()}] [${meetingId}] [ERROR] Stack: ${error.stack}`);
      
      // Remove from active meetings on error
      activeMeetings.delete(meetingId);
      
      // Attempt cleanup
      bot.cleanup().catch((cleanupError) => {
        console.error(`[ERROR] Cleanup failed for meeting ${meetingId}:`, cleanupError);
      });
    });

    // Store meeting info
    activeMeetings.set(meetingId, {
      bot: bot,
      startTime: new Date(),
      envVars: envVars,
      logs: logs,
    });

    console.log(`[INFO] Started meeting bot for meetingId: ${meetingId} (direct import)`);

    res.json({
      ok: true,
      meetingId,
      message: "Meeting bot started",
    });
  } catch (error) {
    console.error("[ERROR] Failed to start meeting:", error);
    res.status(500).json({
      error: "Failed to start meeting",
      message: error.message,
    });
  }
});

/**
 * Stop an active meeting bot
 * DELETE /stop-meeting/:meetingId
 */
app.delete("/stop-meeting/:meetingId", async (req, res) => {
  try {
    const meetingId = req.params.meetingId;

    const meetingInfo = activeMeetings.get(meetingId);
    if (!meetingInfo) {
      return res.status(404).json({
        error: "Meeting not found",
        meetingId,
      });
    }

    const { bot } = meetingInfo;

    // Set stop flag and trigger cleanup
    bot.shouldStop = true;
    bot.shouldReconnect = false;

    // Cleanup bot resources
    try {
      await bot.cleanup();
      console.log(`[INFO] Stopped meeting bot for meetingId: ${meetingId}`);
    } catch (cleanupError) {
      console.error(`[ERROR] Error during bot cleanup for ${meetingId}:`, cleanupError);
    }

    // Remove from active meetings
    activeMeetings.delete(meetingId);

    res.json({
      ok: true,
      meetingId,
      message: "Meeting bot stopped",
    });
  } catch (error) {
    console.error("[ERROR] Failed to stop meeting:", error);
    res.status(500).json({
      error: "Failed to stop meeting",
      message: error.message,
    });
  }
});

/**
 * Get list of active meetings
 * GET /meetings
 */
app.get("/meetings", (req, res) => {
  const meetings = Array.from(activeMeetings.entries()).map(
    ([meetingId, info]) => ({
      meetingId,
      startTime: info.startTime.toISOString(),
      uptime: Math.floor((Date.now() - info.startTime.getTime()) / 1000), // seconds
      platform: info.envVars.PLATFORM,
      meetingUrl: info.envVars.MEETING_URL,
    })
  );

  res.json({
    active: meetings,
    count: meetings.length,
  });
});

/**
 * Get logs for a specific meeting
 * GET /meetings/:meetingId/logs
 */
app.get("/meetings/:meetingId/logs", (req, res) => {
  const meetingId = req.params.meetingId;
  const meetingInfo = activeMeetings.get(meetingId);

  if (!meetingInfo) {
    return res.status(404).json({
      error: "Meeting not found",
      meetingId,
    });
  }

  res.json({
    meetingId,
    logs: meetingInfo.logs,
    lineCount: meetingInfo.logs.length,
  });
});

/**
 * Get status of a specific meeting
 * GET /meetings/:meetingId
 */
app.get("/meetings/:meetingId", (req, res) => {
  const meetingId = req.params.meetingId;
  const meetingInfo = activeMeetings.get(meetingId);

  if (!meetingInfo) {
    return res.status(404).json({
      error: "Meeting not found",
      meetingId,
    });
  }

  const { bot } = meetingInfo;
  const isRunning = !bot.shouldStop && bot.connectionState !== "disconnected";

  res.json({
    meetingId,
    startTime: meetingInfo.startTime.toISOString(),
    uptime: Math.floor((Date.now() - meetingInfo.startTime.getTime()) / 1000),
    platform: meetingInfo.envVars.PLATFORM,
    meetingUrl: meetingInfo.envVars.MEETING_URL,
    isRunning: isRunning,
    connectionState: bot.connectionState,
    voiceState: bot.voiceState,
  });
});

// Start server
app.listen(PORT, "0.0.0.0", () => {
  console.log(`[INFO] Browser bot server listening on port ${PORT}`);
  console.log(`[INFO] Health check: http://localhost:${PORT}/health`);
});

// Graceful shutdown
process.on("SIGTERM", async () => {
  console.log("[INFO] Received SIGTERM, shutting down gracefully...");
  
  // Stop all active meetings
  const cleanupPromises = [];
  for (const [meetingId, meetingInfo] of activeMeetings.entries()) {
    console.log(`[INFO] Stopping meeting: ${meetingId}`);
    const { bot } = meetingInfo;
    bot.shouldStop = true;
    bot.shouldReconnect = false;
    cleanupPromises.push(
      bot.cleanup().catch((error) => {
        console.error(`[ERROR] Cleanup failed for meeting ${meetingId}:`, error);
      })
    );
  }

  // Wait for all cleanups to complete
  try {
    await Promise.all(cleanupPromises);
    console.log("[INFO] All meetings stopped, exiting...");
    process.exit(0);
  } catch (error) {
    console.error("[ERROR] Error during shutdown:", error);
    process.exit(1);
  }
});

process.on("SIGINT", async () => {
  console.log("[INFO] Received SIGINT, shutting down gracefully...");
  
  // Stop all active meetings
  const cleanupPromises = [];
  for (const [meetingId, meetingInfo] of activeMeetings.entries()) {
    console.log(`[INFO] Stopping meeting: ${meetingId}`);
    const { bot } = meetingInfo;
    bot.shouldStop = true;
    bot.shouldReconnect = false;
    cleanupPromises.push(
      bot.cleanup().catch((error) => {
        console.error(`[ERROR] Cleanup failed for meeting ${meetingId}:`, error);
      })
    );
  }

  // Wait for all cleanups to complete (with timeout)
  try {
    await Promise.race([
      Promise.all(cleanupPromises),
      new Promise((resolve) => setTimeout(resolve, 5000)), // 5 second timeout
    ]);
    console.log("[INFO] Shutdown complete, exiting...");
    process.exit(0);
  } catch (error) {
    console.error("[ERROR] Error during shutdown:", error);
    process.exit(1);
  }
});

module.exports = app;

