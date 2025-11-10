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

module.exports = {
  createPlatformController,
  PLATFORM_REGISTRY
};
