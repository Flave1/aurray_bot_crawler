const DEFAULT_WAIT_FOR_SELECTOR_TIMEOUT = 15000;

/**
 * Base class for platform-specific meeting automation controllers.
 * Concrete implementations must provide deterministic join/leave flows
 * and media control logic for each supported platform.
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
    this.joinDeadline =
      Date.now() + (config.joinTimeoutSec || 60) * 1000;
  }

  /* -------------------------------------------------------------------------- */
  /*                                PERMISSIONS                                 */
  /* -------------------------------------------------------------------------- */

  /**
   * Get origin from meeting URL.
   * @returns {string}
   */
  static getPermissionsOrigin(meetingUrl) {
    try {
      return new URL(meetingUrl).origin;
    } catch {
      return '';
    }
  }

  /**
   * Grant mic/camera permissions for the meeting origin.
   */
  async grantPermissions() {
    try {
      const origin = this.constructor.getPermissionsOrigin(
        this.config.meetingUrl
      );
      if (!origin) {
        this.logger.warn?.('Permissions origin unavailable');
        return;
      }

      await this.page.context().grantPermissions(
        ['microphone', 'camera'],
        { origin }
      );

      this.logger.debug?.('Media permissions granted', { origin });
    } catch (error) {
      this.logger.warn?.('Failed to grant media permissions', {
        error: error.message,
      });
    }
  }

  /* -------------------------------------------------------------------------- */
  /*                              JOIN SEQUENCE                                 */
  /* -------------------------------------------------------------------------- */

  async joinMeeting() {
    await this.beforeJoin();
    await this.performJoin();
    await this.ensureJoined();
    await this.afterJoin();
  }

  // Abstract steps — must be overridden
  async beforeJoin() {
    throw new Error('beforeJoin() must be implemented');
  }
  async performJoin() {
    throw new Error('performJoin() must be implemented');
  }
  async ensureJoined() {
    throw new Error('ensureJoined() must be implemented');
  }
  async hasBotJoined() {
    throw new Error('hasBotJoined() must be implemented');
  }
  async leaveMeeting() {
    throw new Error('leaveMeeting() must be implemented');
  }
  async setMicrophone(_) {
    throw new Error('setMicrophone() must be implemented');
  }
  async setCamera(_) {
    throw new Error('setCamera() must be implemented');
  }

  // Optional hooks
  async beforeNavigate() {}
  async afterNavigate() {}
  async afterJoin() {}
  async cleanup() {}

  /* -------------------------------------------------------------------------- */
  /*                               MEETING STATE                                */
  /* -------------------------------------------------------------------------- */

  getMeetingPresenceSelectors() {
    return [];
  }

  async isMeetingActive() {
    if (this.page.isClosed()) return false;

    const selectors = this.getMeetingPresenceSelectors();
    if (!selectors.length) return true;

    const context = this.getDomTarget();

    for (const selector of selectors) {
      try {
        const locator = context.locator(selector).first();
        if (await locator.isVisible({ timeout: 2000 })) return true;
      } catch (_) {}
    }

    return false;
  }

  /* -------------------------------------------------------------------------- */
  /*                               DOM UTILITIES                                */
  /* -------------------------------------------------------------------------- */

  getDomTarget() {
    return this.page;
  }

  async clickFirstVisible(selectors, options = {}) {
    const { timeout = 2000, clickDelay = 0 } = options;
    const context = this.getDomTarget();

    for (const selector of selectors) {
      try {
        const locator = context.locator(selector).first();
        await locator.waitFor({ state: 'visible', timeout });
        await locator.click({ delay: clickDelay });
        return locator;
      } catch (_) {}
    }
    return null;
  }

  async waitForAny(
    selectors,
    { timeout = DEFAULT_WAIT_FOR_SELECTOR_TIMEOUT, state = 'visible' } = {}
  ) {
    const context = this.getDomTarget();
    let lastError;

    for (const selector of selectors) {
      try {
        const locator = context.locator(selector).first();
        await locator.waitFor({ state, timeout });
        return locator;
      } catch (err) {
        lastError = err;
      }
    }

    throw lastError;
  }

  /* -------------------------------------------------------------------------- */
  /*                                  TOGGLES                                   */
  /* -------------------------------------------------------------------------- */

  async extractToggleState(locator) {
    const ariaPressed = await locator.getAttribute('aria-pressed');
    if (ariaPressed === 'true') return true;
    if (ariaPressed === 'false') return false;

    const label = (await locator.getAttribute('aria-label')) || '';
    if (/turn off/i.test(label)) return true;
    if (/turn on/i.test(label)) return false;

    const muted = await locator.getAttribute('data-is-muted');
    if (muted === 'true') return false;
    if (muted === 'false') return true;

    return null;
  }

  async ensureToggleState({ selectors, desiredState, allowUnknown = false }) {
    const locator = await this.waitForAny(selectors, {
      timeout: 6000,
    }).catch(() => null);

    if (!locator) {
      throw new Error(
        `Toggle control not found: ${selectors.join(', ')}`
      );
    }

    const current = await this.extractToggleState(locator);

    if (current === null) {
      if (!allowUnknown) await locator.click();
      return locator;
    }

    if (current !== desiredState) await locator.click();
    return locator;
  }

  /* -------------------------------------------------------------------------- */
  /*                             JOIN DEADLINE CHECK                             */
  /* -------------------------------------------------------------------------- */

  enforceJoinDeadline() {
    if (Date.now() > this.joinDeadline) {
      throw new Error('Join meeting timed out');
    }
  }

  /* -------------------------------------------------------------------------- */
  /*                            BROWSER ARGS OVERRIDE                            */
  /* -------------------------------------------------------------------------- */

  static getBrowserArgs() {
    return [];
  }
}

module.exports = PlatformController;
