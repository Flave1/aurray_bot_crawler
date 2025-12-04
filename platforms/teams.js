const PlatformController = require('./base');

class TeamsController extends PlatformController {
  static getBrowserArgs() {
    return [];
  }

  static getPermissionsOrigin(meetingUrl) {
    return 'https://teams.microsoft.com';
  }

  async beforeJoin() {
    // Click "Continue on this browser" button as soon as it appears
    this.logger.info('Looking for "Continue on this browser" button');
    const continueButton = await this.clickFirstVisible([
      'button:has-text("Continue on this browser")',
      'button[data-tid="joinOnWeb"]'
    ], { timeout: 30000 });
    
    if (!continueButton) {
      throw new Error('Failed to find "Continue on this browser" button');
    }
    this.logger.info('Clicked "Continue on this browser" button');
    
    // Wait for next page to load completely
    await this.page.waitForLoadState('domcontentloaded');
    await this.page.waitForTimeout(2000);
    this.logger.info('Pre-join page ready');
  }

  async performJoin() {
    // Fill in bot name
    this.logger.info('Filling bot name');
    const nameInput = await this.page.waitForSelector('input[placeholder*="name" i], input[placeholder="Type your name"]', { timeout: 30000 });
    await nameInput.fill(this.config.botName);
    this.logger.info('Bot name filled');
    
    // Click "Join now" button
    this.logger.info('Looking for "Join now" button');
    const joinButton = await this.clickFirstVisible([
      'button:has-text("Join now")',
      'button[data-tid="prejoin-join-button"]'
    ], { timeout: 30000 });
    
    if (!joinButton) {
      throw new Error('Failed to find "Join now" button');
    }
    this.logger.info('Clicked "Join now" button');
  }

  async ensureJoined() {
    await this.page.waitForSelector('button[id="mic-button"], button[id="hangup-button"], button[aria-label*="Leave"]', { timeout: 30000 });
    this.logger.info('Meeting joined - meeting controls visible');
  }

  async afterJoin() {
    // No additional actions
  }

  async hasBotJoined() {
    return true;
  }

  async leaveMeeting() {
    // Not implemented
  }

  async setMicrophone(enable) {
    // Not implemented
  }

  async setCamera(enable) {
    // Not implemented
  }

  getMeetingPresenceSelectors() {
    return [];
  }
}

module.exports = TeamsController;
