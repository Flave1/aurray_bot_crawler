/**
 * HTTP server for managing browser bot meetings.
 * Uses direct module import instead of subprocesses for better performance and reliability.
 */

const express = require("express");
const path = require("path");
const fs = require("fs");
const { BrowserBot } = require("./bot_entry_v2.js");

const app = express();

// Enable CORS for all routes - using manual headers for better control
app.use((req, res, next) => {
  // Set CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  
  // Handle preflight requests
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }
  
  // Set request timeout (30 seconds)
  req.setTimeout(30000, () => {
    if (!res.headersSent) {
      res.status(408).json({ error: "Request timeout" });
    }
  });
  
  // Handle connection close gracefully
  req.on('close', () => {
    if (!res.headersSent && !res.finished) {
      // Request was aborted - this is normal, just log at debug level
      // Don't try to send response as connection is already closed
    }
  });
  
  next();
});

// Configure JSON body parser with limits and error handling
app.use(express.json({
  limit: '10mb', // Limit request body size
  verify: (req, res, buf, encoding) => {
    // Verify request body if needed
  }
}));

// Error handler for aborted requests and body parsing errors
app.use((error, req, res, next) => {
  // Handle request aborted errors gracefully
  if (error.type === 'entity.parse.failed' || 
      error.message === 'request aborted' ||
      error.message?.includes('aborted') ||
      error.name === 'BadRequestError') {
    // Client disconnected or request was aborted - log but don't crash
    console.warn(`[WARN] Request aborted: ${req.method} ${req.path}`, {
      error: error.message,
      type: error.type || error.name
    });
    // Only send response if headers haven't been sent and connection is still open
    if (!res.headersSent && !req.aborted) {
      return res.status(400).json({
        error: "Request aborted or invalid JSON",
        message: "The request was cancelled or contained invalid data"
      });
    }
    return; // Connection already closed, don't try to send response
  }
  
  // Handle other errors
  if (!res.headersSent && !req.aborted) {
    console.error("[ERROR] Unhandled error:", error);
    res.status(500).json({
      error: "Internal server error",
      message: error.message
    });
  }
});

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
  // Handle request abort gracefully
  req.on('close', () => {
    if (!res.headersSent) {
      console.warn(`[WARN] Request aborted: POST /start-meeting`);
    }
  });

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
    // Don't send response if request was aborted
    if (req.aborted || res.headersSent) {
      console.warn("[WARN] Request aborted during start-meeting, skipping response");
      return;
    }
    
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
  // Handle request abort gracefully
  req.on('close', () => {
    if (!res.headersSent) {
      console.warn(`[WARN] Request aborted: DELETE /stop-meeting/${req.params.meetingId}`);
    }
  });

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
    // Don't send response if request was aborted
    if (req.aborted || res.headersSent) {
      console.warn("[WARN] Request aborted during stop-meeting, skipping response");
      return;
    }
    
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

/**
 * Get list of screenshot images for a meeting
 * GET /meetings/:meetingId/screenshots
 */
app.get("/meetings/:meetingId/screenshots", (req, res) => {
  try {
    const meetingId = req.params.meetingId;
    const screenshotsDir = path.join(__dirname, "logs", "screenshots");
    
    // Ensure directory exists
    if (!fs.existsSync(screenshotsDir)) {
      return res.json({
        meetingId,
        screenshots: [],
        count: 0,
      });
    }

    // Read directory and filter for image files
    const files = fs.readdirSync(screenshotsDir);
    const imageExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];
    
    // Show all screenshots (no filtering by meetingId)
    const screenshots = files
      .filter(file => {
        const ext = path.extname(file).toLowerCase();
        return imageExtensions.includes(ext);
      })
      .map(file => {
        const filePath = path.join(screenshotsDir, file);
        const stats = fs.statSync(filePath);
        return {
          filename: file,
          url: `/meetings/${meetingId}/screenshots/${file}`,
          size: stats.size,
          createdAt: stats.birthtime.toISOString(),
          modifiedAt: stats.mtime.toISOString(),
        };
      })
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()); // Sort by newest first

    res.json({
      meetingId,
      screenshots,
      count: screenshots.length,
    });
  } catch (error) {
    console.error("[ERROR] Failed to list screenshots:", error);
    res.status(500).json({
      error: "Failed to list screenshots",
      message: error.message,
    });
  }
});

/**
 * Serve screenshot image file
 * GET /meetings/:meetingId/screenshots/:filename
 */
app.get("/meetings/:meetingId/screenshots/:filename", (req, res) => {
  try {
    const meetingId = req.params.meetingId;
    const filename = req.params.filename;
    
    // Security: prevent directory traversal
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
      return res.status(400).json({ error: "Invalid filename" });
    }

    const screenshotsDir = path.join(__dirname, "logs", "screenshots");
    const filePath = path.join(screenshotsDir, filename);

    // Check if file exists
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: "Screenshot not found" });
    }

    // Verify file is an image
    const ext = path.extname(filename).toLowerCase();
    const imageExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];
    if (!imageExtensions.includes(ext)) {
      return res.status(400).json({ error: "Invalid file type" });
    }

    // Set appropriate content type
    const contentTypeMap = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
    };
    res.setHeader('Content-Type', contentTypeMap[ext] || 'application/octet-stream');
    
    // Stream the file with error handling for aborted requests
    const fileStream = fs.createReadStream(filePath);
    
    // Handle client disconnect during streaming
    req.on('close', () => {
      if (!res.headersSent) {
        fileStream.destroy();
      }
    });
    
    fileStream.on('error', (error) => {
      if (!res.headersSent) {
        console.error("[ERROR] File stream error:", error);
        res.status(500).json({
          error: "Failed to read screenshot",
          message: error.message,
        });
      }
      fileStream.destroy();
    });
    
    res.on('close', () => {
      if (!fileStream.destroyed) {
        fileStream.destroy();
      }
    });
    
    fileStream.pipe(res);
  } catch (error) {
    // Don't send response if request was aborted
    if (req.aborted || res.headersSent) {
      console.warn("[WARN] Request aborted during screenshot serve, skipping response");
      return;
    }
    
    console.error("[ERROR] Failed to serve screenshot:", error);
    res.status(500).json({
      error: "Failed to serve screenshot",
      message: error.message,
    });
  }
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

