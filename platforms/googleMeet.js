const PlatformController = require('./base');

const PRE_JOIN_SELECTORS = {
  nameInputs: [
    'input[aria-label="Your name"]',
    'input[aria-label="Your name (required)"]',
    'input[name="name"]',
    'input[placeholder*="name" i]',
    'input[aria-label*="name" i]',
    'input[type="text"][data-initial-value]',
    'input[type="text"]:not([autocomplete="off"])'
  ],
  joinButtons: [
    'button[jsname="LgbsSe"][data-mdc-dialog-action=""]',
    'button[jsname="LgbsSe"][aria-label*="Ask to join"]',
    'button[jsname="LgbsSe"][aria-label*="Join now"]',
    'div[role="button"][jsname="LgbsSe"]',
    'button:has-text("Join now")',
    'button:has-text("Ask to join")',
    'button:has-text("Join meeting")'
  ],
  continueButtons: [
    'button:has-text("Continue")',
    'button:has-text("Continue without checking")',
    'button:has-text("Try again")',
    'button:has-text("Join meeting")',
    'button[jsname="M2UYVd"]',
    'button[jsname="Qx7uuf"]'
  ]
};

// Keep selectors minimal; we only need Join buttons for this simplified flow

class GoogleMeetController extends PlatformController {
  async beforeNavigate() {
    await this.grantPermissions();
  }

  async beforeJoin() {
    await this.page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
    // Attempt join immediately after DOM is ready
    // (no additional delay to avoid losing the window during navigation)
  }

  async performJoin() {
    this.logger.info('Google Meet: performJoin() - immediate join');
    // If a pre-join prompt is present, click it fast
    try {
      const prompt = await this.waitForVisibleSelector(PRE_JOIN_SELECTORS.continueButtons, 800);
      if (prompt) {
        try { await prompt.locator.click(); this.logger.info('Google Meet: clicked continue prompt', { selector: prompt.selector }); } catch (_) {}
      }
    } catch (_) {}
    const quickSelectors = [
      ...PRE_JOIN_SELECTORS.joinButtons,
      'button[aria-label*="join" i]',
      'div[role="button"][aria-label*="join" i]',
      'button:has-text("Join now")',
      'button:has-text("Ask to join")',
      'div[role="button"]:has-text("Join")'
    ];
    for (let attempt = 0; attempt < 40; attempt++) {
      if (this.page.isClosed()) {
        this.logger.warn('Google Meet: page closed while attempting join');
        return;
      }
      const quick = await this.waitForVisibleSelector(quickSelectors, 300);
      if (quick) {
        try {
          // Prefer an enabled button if available
          const enabledLocator = this.page.locator(`${quick.selector}:not([disabled]):not([aria-disabled="true"])`).first();
          const enabledVisible = await enabledLocator.isVisible({ timeout: 300 }).catch(() => false);
          if (enabledVisible) {
            await enabledLocator.click({ trial: false });
          } else {
            await quick.locator.click({ trial: false });
          }
          // Verify that we moved into a join state (in-meeting UI or waiting room text)
          const joined = await this.page.locator('[data-call-started="true"], div[aria-label="Call controls"], div[aria-label="Meeting details"]').first()
            .isVisible({ timeout: 3000 }).catch(() => false);
          const waiting = await this.page.getByText(/You'll join the meeting|Someone in the meeting should let you in soon/i)
            .isVisible({ timeout: 1000 }).catch(() => false);
          if (joined || waiting) {
            this.logger.info('Google Meet: clicked join (confirmed state)', { selector: quick.selector, joined, waiting });
            return;
          }
          this.logger.warn('Google Meet: join click did not change state yet, retrying', { selector: quick.selector, attempt });
        } catch (_) {
          try {
            await this.page.evaluate((sel) => {
              const el = document.querySelector(sel);
              if (el && !el.hasAttribute('disabled') && el.getAttribute('aria-disabled') !== 'true') el.click();
            }, quick.selector);
            const joined = await this.page.locator('[data-call-started="true"], div[aria-label="Call controls"], div[aria-label="Meeting details"]').first()
              .isVisible({ timeout: 3000 }).catch(() => false);
            const waiting = await this.page.getByText(/You'll join the meeting|Someone in the meeting should let you in soon/i)
              .isVisible({ timeout: 1000 }).catch(() => false);
            if (joined || waiting) {
              this.logger.info('Google Meet: clicked join via JS (confirmed state)', { selector: quick.selector, joined, waiting });
              return;
            }
            this.logger.warn('Google Meet: JS join click did not change state yet, retrying', { selector: quick.selector, attempt });
          } catch (_) {}
        }
      }
      try { if (!this.page.isClosed()) await this.page.waitForTimeout(150); } catch (_) {}
    }
  }

  /**
   * Find and click an enabled Join/Ask to join button.
   * Returns true if a click was performed.
   */
  async clickEnabledJoinButton(seedSelector) {
    const candidateSelectors = [
      ...(seedSelector ? [seedSelector] : []),
      ...PRE_JOIN_SELECTORS.joinButtons,
      'button[aria-label*="join" i]'
    ];
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      for (const selector of candidateSelectors) {
        const enabled = this.page.locator(`${selector}:not([disabled]):not([aria-disabled="true"])`).first();
        try {
          await enabled.waitFor({ state: 'visible', timeout: 400 });
          await enabled.click();
          this.logger.info('Google Meet: clicked enabled join button', { selector });
          return true;
        } catch (_) {
          // keep scanning
        }
      }
      try { await this.page.waitForTimeout(250); } catch (_) {}
    }
    this.logger.debug('Google Meet: no enabled join button detected');
    return false;
  }

  async handleConsentPages() {
    // No-op in simplified flow
  }

  async ensureJoined() {
    // No-op in simplified flow
  }

  async afterJoin() {}

  async hasBotJoined() {
    if (this.page.isClosed()) {
      return false;
    }

    try {
      // Check for in-meeting UI elements:
      // 1. Call controls or meeting controls
      const controlsVisible = await Promise.race([
        this.page.locator('[data-call-started="true"]').isVisible({ timeout: 1000 }).catch(() => false),
        this.page.locator('div[aria-label="Call controls"]').isVisible({ timeout: 1000 }).catch(() => false),
        this.page.locator('div[aria-label="Meeting details"]').isVisible({ timeout: 1000 }).catch(() => false)
      ]);

      // 2. Participant tiles or grid
      const participantsVisible = await Promise.race([
        this.page.locator('div[data-self-name]').isVisible({ timeout: 1000 }).catch(() => false),
        this.page.locator('div[jsname="hxYeFb"]').isVisible({ timeout: 1000 }).catch(() => false),
        this.page.locator('div[data-participant-id]').isVisible({ timeout: 1000 }).catch(() => false)
      ]);

      // 3. Meeting toolbar/buttons
      const toolbarVisible = await Promise.race([
        this.page.locator('button[aria-label*="Turn off camera"]').isVisible({ timeout: 1000 }).catch(() => false),
        this.page.locator('button[aria-label*="Turn off microphone"]').isVisible({ timeout: 1000 }).catch(() => false),
        this.page.locator('button[aria-label*="Leave call"]').isVisible({ timeout: 1000 }).catch(() => false),
        this.page.locator('button[data-mdc-dialog-action="close"]').isVisible({ timeout: 1000 }).catch(() => false)
      ]);

      // 4. Check if we're NOT on pre-join screen (absence of join buttons)
      const notOnPrejoin = !(await Promise.race([
        this.page.locator('button:has-text("Join now")').isVisible({ timeout: 500 }).catch(() => false),
        this.page.locator('button:has-text("Ask to join")').isVisible({ timeout: 500 }).catch(() => false)
      ]));

      // Consider joined if we see meeting controls OR participants OR toolbar, AND not on pre-join
      const isJoined = notOnPrejoin && (controlsVisible || participantsVisible || toolbarVisible);

      if (isJoined) {
        this.logger.info('Google Meet: bot has joined meeting', {
          controlsVisible,
          participantsVisible,
          toolbarVisible,
          notOnPrejoin
        });
      }

      return isJoined;
    } catch (error) {
      this.logger.debug('Google Meet: error checking if bot joined', { error: error.message });
      return false;
    }
  }

  getMeetingPresenceSelectors() {
    // Selectors that indicate the meeting UI is still active
    // If any of these are visible, the meeting is still ongoing
    return [
      '[data-call-started="true"]',
      'div[aria-label="Call controls"]',
      'div[aria-label="Meeting details"]',
      'button[aria-label*="Turn off camera"]',
      'button[aria-label*="Turn off microphone"]',
      'button[aria-label*="Leave call"]',
      'div[data-self-name]',
      'div[jsname="hxYeFb"]',
      'div[data-participant-id]',
      // Meeting toolbar/controls
      'div[role="toolbar"]',
      // Video grid/stage
      'div[data-self-name]',
      // Check that we're NOT on pre-join screen (absence means we're in meeting)
      // But we check for presence of meeting controls instead
    ];
  }

  async leaveMeeting() {
    const selectors = [
      'button[aria-label*="Leave call"]',
      'div[role="button"][aria-label*="Leave call"]',
      'button:has-text("Leave call")'
    ];
    const locator = await this.clickFirstVisible(selectors, { timeout: 4000 });
    if (!locator) {
      throw new Error('Google Meet: unable to locate leave button');
    }
    this.logger.info('Google Meet: leave button clicked');
  }

  async setMicrophone(enable) {
    const locator = await this.ensureToggleState({
      selectors: MIC_TOGGLE_SELECTORS,
      desiredState: enable,
      allowUnknown: true
    }).catch(() => null);
    if (locator) {
      this.logger.info(`Google Meet: microphone set to ${enable ? 'on' : 'off'}`);
    }
  }

  async setCamera(enable) {
    const locator = await this.ensureToggleState({
      selectors: CAMERA_TOGGLE_SELECTORS,
      desiredState: enable,
      allowUnknown: true
    }).catch(() => null);
    if (locator) {
      this.logger.info(`Google Meet: camera set to ${enable ? 'on' : 'off'}`);
    }
  }

  async ensureNameField() {
    // Wait for the page to fully load
    await this.page.waitForTimeout(2000);
    
    // Debug: check what inputs are actually visible
    const debugInfo = await this.page.evaluate(() => {
      const collect = (root) => Array.from(root.querySelectorAll('input')).map(inp => ({
        type: inp.type,
        name: inp.name,
        placeholder: inp.placeholder,
        ariaLabel: inp.getAttribute('aria-label'),
        visible: inp.offsetParent !== null,
        value: inp.value
      }));
      const base = collect(document);
      const byFrame = [];
      for (const f of Array.from(document.querySelectorAll('iframe'))) {
        try { if (f.contentDocument) byFrame.push(...collect(f.contentDocument)); } catch (_) {}
      }
      return [...base, ...byFrame];
    });
    this.logger.debug('Google Meet: visible inputs on page', { inputs: debugInfo });
    
    // Try simpler selectors first
    const simpleSelectors = [
      'input[aria-label="Your name"]',
      'input[placeholder="Your name"]',
      'input[type="text"]'
    ];
    
    let match = null;
    for (const selector of simpleSelectors) {
      try {
        const locator = this.page.locator(selector).first();
        await locator.waitFor({ state: 'visible', timeout: 3000 });
        match = { locator, selector };
        break;
      } catch (e) {
        // Continue
      }
    }
    
    if (!match) {
      match = await this.waitForVisibleSelector(PRE_JOIN_SELECTORS.nameInputs, 15000);
    }
    
    // If still not found, search inside iframes explicitly
    if (!match) {
      for (const frame of this.page.frames()) {
        for (const selector of [...simpleSelectors, ...PRE_JOIN_SELECTORS.nameInputs]) {
          try {
            const locator = frame.locator(selector).first();
            await locator.waitFor({ state: 'visible', timeout: 800 });
            match = { locator, selector };
            break;
          } catch (_) {}
        }
        if (match) break;
      }
    }
    
    // As a last resort, focus a likely text input and type the name
    if (!match) {
      const focused = await this.page.evaluate(() => {
        const tryFocus = (root) => {
          const el = root.querySelector('input[type="text"], input[aria-label*="name" i], input[placeholder*="name" i]');
          if (el) { el.focus(); return true; }
          return false;
        };
        if (tryFocus(document)) return true;
        for (const f of Array.from(document.querySelectorAll('iframe'))) {
          try { if (f.contentDocument && tryFocus(f.contentDocument)) return true; } catch (_) {}
        }
        return false;
      });
      if (focused) {
        await this.page.keyboard.type(this.config.botName, { delay: 20 });
        this.logger.info('Google Meet: filled guest name via focused input');
        return;
      }
    }
    
    if (!match) {
      this.logger.warn('Google Meet: name field not found; meeting may reject guest');
      return;
    }
    await match.locator.fill(this.config.botName);
    this.logger.info('Google Meet: filled guest name', { selector: match.selector });
  }

  async handleContinuePrompts() {
    const prompt = await this.waitForVisibleSelector(PRE_JOIN_SELECTORS.continueButtons, 4000);
    if (prompt) {
      await prompt.locator.click();
      this.logger.info('Google Meet: clicked continue/join prompt', { selector: prompt.selector });
    }
  }

  async waitForVisibleSelector(selectors, timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.page.isClosed()) {
        return null;
      }
      for (const selector of selectors) {
        const locator = this.page.locator(selector).first();
        try {
          await locator.waitFor({ state: 'visible', timeout: 500 });
          this.logger.debug('Google Meet: found visible element', { selector });
          return { locator, selector };
        } catch (error) {
          // If page closed or context gone, stop trying gracefully
          if (/Target page, context or browser has been closed/i.test(error.message || '')) {
            return null;
          }
          // keep scanning
        }
      }
      try { if (!this.page.isClosed()) await this.page.waitForTimeout(250); } catch (_) { return null; }
    }
    this.logger.debug('Google Meet: no visible selector found', { selectors, timeoutMs });
    return null;
  }

  async handleBlockedScreens() {
    const text = await this.page.textContent('body').catch(() => '');
    if (!text) {
      return;
    }
    
    this.logger.debug('Google Meet: page content preview', { 
      textPreview: text.substring(0, 200),
      pageUrl: this.page.url()
    });
    
    // Check for browser compatibility message
    if (/doesn't work on your browser/i.test(text) || /download chrome/i.test(text) || /doesn.t work/i.test(text)) {
      this.logger.error('Google Meet: browser compatibility issue - Meet detected automated browser');
      throw new Error('Google Meet: browser is blocked by Meet (automation detected). Try using a different meeting link or wait for meeting host approval.');
    }
    
    // Check for "can't join" message - but allow join flow to proceed (might have "Ask to join" button)
    if (/you can't join/i.test(text) || /can.t join this video/i.test(text)) {
      // Check if there's any join button available (Ask to join, Join now, etc.)
      const anyJoinButton = await this.waitForVisibleSelector(PRE_JOIN_SELECTORS.joinButtons, 3000);
      if (anyJoinButton) {
        this.logger.warn('Google Meet: meeting may require admission, but join button found - will attempt join and wait for host approval if needed');
        // Don't throw - let the join flow proceed and wait for admission in ensureJoined()
      } else {
        this.logger.warn('Google Meet: "can\'t join" message detected but no join button found - will attempt to continue anyway');
        // Still don't throw - let the join flow try and fail gracefully later if needed
      }
    }
    
    if (/meeting code|enter a code/i.test(text) && !/Join now/i.test(text)) {
      this.logger.warn('Google Meet: meeting code prompt detected; link may be invalid');
    }
    if (/you can try again/i.test(text)) {
      this.logger.warn('Google Meet: meeting unavailable (Try again later screen)');
    }
  }

}

module.exports = GoogleMeetController;
