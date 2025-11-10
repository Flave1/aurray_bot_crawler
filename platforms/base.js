const DEFAULT_WAIT_FOR_SELECTOR_TIMEOUT = 15000;

/**
 * Base class for platform-specific meeting automation helpers.
 * Concrete controllers should override the abstract methods to implement
 * deterministic join/leave flows and media controls per platform.
 */
class PlatformController {
  /**
   * @param {import('playwright').Page} page
   * @param {object} config
   * @param {object} logger
   */
  constructor(page, config, logger) {
    this.page = page;
    this.config = config;
    this.logger = logger;
    this.joinDeadline = Date.now() + (config.joinTimeoutSec || 60) * 1000;
  }

  /**
   * Ensure Playwright context has media permissions granted for this origin.
   */
  async grantPermissions() {
    try {
      const origin = new URL(this.config.meetingUrl).origin;
      await this.page.context().grantPermissions(['microphone', 'camera'], { origin });
      this.logger.debug?.('Granted media permissions', { origin });
    } catch (error) {
      this.logger.warn?.('Unable to grant media permissions automatically', { error: error.message });
    }
  }

  /**
   * Optional hook executed before navigation completes.
   */
  // eslint-disable-next-line class-methods-use-this
  async beforeNavigate() {}

  /**
   * Optional hook executed after navigation completes.
   */
  // eslint-disable-next-line class-methods-use-this
  async afterNavigate() {}

  /**
   * Execute the full join sequence: pre-join preparation, submitting the join
   * action, waiting for in-meeting confirmation, then running post-join tasks.
   */
  async joinMeeting() {
    await this.beforeJoin();
    await this.performJoin();
    await this.ensureJoined();
    await this.afterJoin();
  }

  /**
   * Ensure we are ready to join (fill forms, accept dialogs).
   * Concrete implementations must override.
   */
  async beforeJoin() {
    throw new Error('beforeJoin() must be implemented by concrete controller');
  }

  /**
   * Submit the actual join action (click the join button).
   * Concrete implementations must override.
   */
  async performJoin() {
    throw new Error('performJoin() must be implemented by concrete controller');
  }

  /**
   * Wait for confirmation that we are in the meeting.
   * Concrete implementations must override.
   */
  async ensureJoined() {
    throw new Error('ensureJoined() must be implemented by concrete controller');
  }

  /**
   * Optional hook executed after the join succeeds.
   */
  // eslint-disable-next-line class-methods-use-this
  async afterJoin() {}

  /**
   * Check if the bot has actually joined the meeting (in-meeting UI is visible).
   * Concrete implementations must override.
   * @returns {Promise<boolean>} true if bot is confirmed to be in the meeting
   */
  async hasBotJoined() {
    throw new Error('hasBotJoined() must be implemented by concrete controller');
  }

  /**
   * Leave the meeting for this platform. Concrete implementations must override.
   */
  async leaveMeeting() {
    throw new Error('leaveMeeting() must be implemented by concrete controller');
  }

  /**
   * Toggle microphone to desired state.
   * @param {boolean} enable
   */
  async setMicrophone(enable) { // eslint-disable-line no-unused-vars
    throw new Error('setMicrophone() must be implemented by concrete controller');
  }

  /**
   * Toggle camera to desired state.
   * @param {boolean} enable
   */
  async setCamera(enable) { // eslint-disable-line no-unused-vars
    throw new Error('setCamera() must be implemented by concrete controller');
  }

  /**
   * Meeting presence selectors used to detect if we are still inside the call.
   */
  getMeetingPresenceSelectors() {
    return [];
  }

  /**
   * Determine whether the meeting UI is still active.
   */
  async isMeetingActive() {
    if (this.page.isClosed()) {
      return false;
    }
    const selectors = this.getMeetingPresenceSelectors();
    if (!selectors.length) {
      return true;
    }
    const context = this.getDomTarget();
    for (const selector of selectors) {
      try {
        const locator = context.locator(selector).first();
        if (await locator.isVisible({ timeout: 2000 })) {
          return true;
        }
      } catch (error) {
        this.logger.debug?.('Meeting presence selector not visible', { selector, error: error.message });
      }
    }
    return false;
  }

  /**
   * Utility: click the first visible element matching any of the selectors
   * provided, returning the locator that succeeded.
   */
  async clickFirstVisible(selectors, options = {}) {
    const context = this.getDomTarget();
    for (const selector of selectors) {
      try {
        const locator = context.locator(selector).first();
        if (await locator.waitFor({ state: 'visible', timeout: options.timeout || 2000 })) {
          await locator.click({ delay: options.clickDelay || 0 });
          return locator;
        }
      } catch (error) {
        this.logger.debug?.(`Selector not clickable: ${selector}`, { error: error.message });
      }
    }
    return null;
  }

  /**
   * Utility: wait for one of the provided selectors to appear.
   */
  async waitForAny(selectors, { timeout = DEFAULT_WAIT_FOR_SELECTOR_TIMEOUT, state = 'visible' } = {}) {
    const context = this.getDomTarget();
    let lastError;
    for (const selector of selectors) {
      try {
        const locator = context.locator(selector).first();
        await locator.waitFor({ state, timeout });
        return locator;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }

  /**
   * Override to point DOM operations (locators, clicks) at a specific frame.
   */
  getDomTarget() {
    return this.page;
  }

  /**
   * Utility: determine boolean state from button attributes/labels.
   */
  async extractToggleState(locator) {
    const ariaPressed = await locator.getAttribute('aria-pressed');
    if (ariaPressed === 'true') return true;
    if (ariaPressed === 'false') return false;

    const ariaLabel = (await locator.getAttribute('aria-label')) || '';
    if (/turn off/i.test(ariaLabel)) return true;
    if (/turn on/i.test(ariaLabel)) return false;

    const dataIsMuted = await locator.getAttribute('data-is-muted');
    if (dataIsMuted === 'true') return false;
    if (dataIsMuted === 'false') return true;

    return null;
  }

  /**
   * Utility: ensure a toggle button matches desired boolean state.
   */
  async ensureToggleState({ selectors, desiredState, allowUnknown = false }) {
    const locator = await this.waitForAny(selectors, { timeout: 6000 }).catch(() => null);
    if (!locator) {
      throw new Error(`Unable to locate toggle control for selectors: ${selectors.join(', ')}`);
    }

    const currentState = await this.extractToggleState(locator);
    if (currentState === null) {
      if (!allowUnknown) {
        this.logger.warn?.('Toggle state unknown, clicking once to attempt desired state');
        await locator.click();
      }
      return locator;
    }

    if (currentState !== desiredState) {
      await locator.click();
    }
    return locator;
  }

  /**
   * Utility: ensure we don't exceed overall join timeout.
   */
  enforceJoinDeadline() {
    if (Date.now() > this.joinDeadline) {
      throw new Error('Timed out while attempting to join meeting');
    }
  }
}

module.exports = PlatformController;
