// @ts-nocheck

/**
 * Lightweight HTTP control server for starting the browser bot with
 * the Teams configuration provided in scripts/start_teams.sh.
 */

const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

/**
 * @typedef {Record<string, string>} EnvMap
 */

const DEFAULT_ENV = /** @type {EnvMap} */ ({
  RT_GATEWAY_URL: 'ws://localhost:8000',
  API_BASE_URL: 'http://localhost:8000',
  SESSION_ID: '2be1ad3b-1d8a-4132-8770-4e201a62dc9d',
  MEETING_URL: 'https://teams.live.com/meet/9318960718018?p=J453ke6nEPHvg5kJGq',
  PLATFORM: 'teams',
  BOT_NAME: 'Aurray Bot',
  MEETING_ID: '2be1ad3b-1d8a-4132-8770-4e201a62dc9d',
  LOG_LEVEL: 'info',
  HEADLESS: 'false',
  ENABLE_TTS_PLAYBACK: 'true',
  ENABLE_AUDIO_CAPTURE: 'true'
});

const LOG_PATH = '/tmp/bot.log';
const SERVER_PORT = parseInt(process.env.BROWSER_BOT_CONTROL_PORT || '7070', 10);

class BotControlError extends Error {
  /**
   * @param {string} message
   * @param {string} code
   */
  constructor(message, code) {
    super(message);
    this.name = 'BotControlError';
    /** @type {string} */
    this.code = code;
  }
}

/** @type {import('child_process').ChildProcess | null} */
let activeBotProcess = null;
/** @type {EnvMap | null} */
let activeBotEnv = null;

function normalizeEnvValue(value) {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === 'string') {
    return value;
  }
  return String(value);
}

/**
 * @param {Record<string, unknown>} overrides
 * @returns {EnvMap}
 */
function mergeEnv(overrides = {}) {
  /** @type {EnvMap} */
  const normalizedOverrides = Object.entries(overrides).reduce((acc, [key, value]) => {
    const normalized = normalizeEnvValue(value);
    if (normalized !== undefined) {
      acc[key] = normalized;
    }
    return acc;
  }, {});

  /** @type {EnvMap} */
  const merged = { ...DEFAULT_ENV, ...normalizedOverrides };

  const env = { ...process.env };
  Object.entries(merged).forEach(([key, value]) => {
    if (value !== undefined) {
      env[key] = value;
    }
  });

  return /** @type {EnvMap} */ (env);
}

function pipeBotLogs(childProcess) {
  const logStream = fs.createWriteStream(LOG_PATH, { flags: 'w' });

  childProcess.stdout.pipe(logStream, { end: false });
  childProcess.stderr.pipe(logStream, { end: false });

  childProcess.stdout.on('data', (chunk) => process.stdout.write(chunk));
  childProcess.stderr.on('data', (chunk) => process.stderr.write(chunk));

  const closeStream = () => {
    childProcess.stdout.unpipe(logStream);
    childProcess.stderr.unpipe(logStream);
    logStream.end();
  };

  childProcess.on('exit', closeStream);
  childProcess.on('error', closeStream);
}

function startTeamsBot(overrides = {}) {
  if (activeBotProcess && !activeBotProcess.killed) {
    throw new BotControlError('A browser bot process is already running', 'BOT_ALREADY_RUNNING');
  }

  const env = mergeEnv(overrides);
  const botPath = path.join(__dirname, 'bot_entry.js');

  const child = spawn(process.execPath, [botPath], {
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  pipeBotLogs(child);

  child.on('exit', (code, signal) => {
    console.log('[INFO] Browser bot process exited', { code, signal });
    activeBotProcess = null;
    activeBotEnv = null;
  });

  child.on('error', (error) => {
    console.error('[ERROR] Failed to start browser bot process', error);
  });

  activeBotProcess = child;
  activeBotEnv = env;

  return {
    pid: child.pid,
    sessionId: env.SESSION_ID,
    meetingId: env.MEETING_ID
  };
}

function getBotStatus() {
  if (!activeBotProcess) {
    return { running: false };
  }

  const isRunning = activeBotProcess.exitCode === null && !activeBotProcess.killed;

  return {
    running: isRunning,
    pid: activeBotProcess.pid,
    sessionId: activeBotEnv?.SESSION_ID,
    meetingId: activeBotEnv?.MEETING_ID,
    exitCode: activeBotProcess.exitCode,
    signal: activeBotProcess.signalCode
  };
}

function stopBot() {
  if (!activeBotProcess || activeBotProcess.killed) {
    throw new BotControlError('No active browser bot process to stop', 'BOT_NOT_RUNNING');
  }

  activeBotProcess.kill('SIGTERM');
  return { stopping: true };
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let rawBody = '';

    req.on('data', (chunk) => {
      rawBody += chunk.toString();
      if (rawBody.length > 1_000_000) {
        reject(new Error('Payload too large'));
        req.destroy();
      }
    });

    req.on('end', () => {
      if (!rawBody.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(rawBody));
      } catch (error) {
        reject(new Error('Invalid JSON payload'));
      }
    });

    req.on('error', reject);
  });
}

async function handleRequest(req, res) {
  const { method, url } = req;

  if (method === 'POST' && url === '/start-meeting') {
    try {
      const body = await parseJsonBody(req);

      const bodyObj = body && typeof body === 'object' && !Array.isArray(body)
        ? /** @type {Record<string, unknown>} */ (body)
        : {};

      const envOverridesValue = bodyObj.env;
      const envOverrides = envOverridesValue && typeof envOverridesValue === 'object' && !Array.isArray(envOverridesValue)
        ? /** @type {Record<string, unknown>} */ (envOverridesValue)
        : undefined;

      const overridesSource = envOverrides || bodyObj;
      const overrides = Object.keys(overridesSource).reduce((acc, key) => {
        acc[key] = normalizeEnvValue(overridesSource[key]);
        return acc;
      }, {});

      const result = startTeamsBot(overrides);

      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'starting',
        pid: result.pid,
        sessionId: result.sessionId,
        meetingId: result.meetingId,
        logFile: LOG_PATH
      }));
    } catch (error) {
      if (error.code === 'BOT_ALREADY_RUNNING') {
        res.writeHead(409, { 'Content-Type': 'application/json' });
      } else if (error.message === 'Invalid JSON payload' || error.message === 'Payload too large') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
      } else {
        res.writeHead(500, { 'Content-Type': 'application/json' });
      }

      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (method === 'POST' && url === '/stop-bot') {
    try {
      const result = stopBot();
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'stopping', ...result }));
    } catch (error) {
      if (error.code === 'BOT_NOT_RUNNING') {
        res.writeHead(409, { 'Content-Type': 'application/json' });
      } else {
        res.writeHead(500, { 'Content-Type': 'application/json' });
      }
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (method === 'GET' && url === '/status') {
    const status = getBotStatus();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(status));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
}

function startServer() {
  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((error) => {
      console.error('[ERROR] Failed to handle request', error);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    });
  });

  server.listen(SERVER_PORT, () => {
    console.log(`[INFO] Browser bot control server listening on port ${SERVER_PORT}`);
  });

  return server;
}

if (require.main === module) {
  startServer();
}

module.exports = {
  startServer,
  startTeamsBot,
  getBotStatus,
  stopBot
};

