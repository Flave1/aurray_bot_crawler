const GoogleMeetController = require('./googleMeet');
const ZoomController = require('./zoom');
const TeamsController = require('./teams');

const PLATFORM_REGISTRY = {
  google_meet: GoogleMeetController,
  zoom: ZoomController,
  teams: TeamsController
};

function createPlatformController(platform, page, config, logger) {
  const normalized = (platform || '').toLowerCase();
  const Controller = PLATFORM_REGISTRY[normalized];
  if (!Controller) {
    const supported = Object.keys(PLATFORM_REGISTRY).join(', ');
    throw new Error(`Unsupported meeting platform "${platform}". Supported platforms: ${supported}`);
  }
  return new Controller(page, config, logger);
}

/**
 * Get browser arguments for a specific platform
 * @param {string} platform - Platform name
 * @returns {string[]} Array of browser command-line arguments
 */
function getPlatformBrowserArgs(platform) {
  const normalized = (platform || '').toLowerCase();
  const Controller = PLATFORM_REGISTRY[normalized];
  if (!Controller) {
    return [];
  }
  return Controller.getBrowserArgs ? Controller.getBrowserArgs() : [];
}

/**
 * Get permissions origin for a specific platform
 * @param {string} platform - Platform name
 * @param {string} meetingUrl - Meeting URL
 * @returns {string} Origin URL for permissions
 */
function getPlatformPermissionsOrigin(platform, meetingUrl) {
  const normalized = (platform || '').toLowerCase();
  const Controller = PLATFORM_REGISTRY[normalized];
  if (!Controller) {
    return '';
  }
  return Controller.getPermissionsOrigin ? Controller.getPermissionsOrigin(meetingUrl) : '';
}

module.exports = {
  createPlatformController,
  getPlatformBrowserArgs,
  getPlatformPermissionsOrigin,
  PLATFORM_REGISTRY
};
