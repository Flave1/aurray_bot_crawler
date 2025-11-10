const PlatformController = require('./base');

const SELECTORS = {
  joinButtons: [
    'button[data-tid="joinOnWeb"]',
    'button[data-tid="prejoin-join-button"]',
    'button[data-tid="join-button"]',
    'button:has-text("Continue on this browser")',
    'button:has-text("Join now")',
    'button:has-text("Join")'
  ],
  nameInput: 'input[data-tid="prejoin-screen-join-button"]',
  lobbyMessage: [
    'text=/Someone in the meeting should let you in soon/i',
    'text=/We\'ll let people in when the meeting starts/i',
    'text=/When the meeting starts, we\'ll let people in/i'
  ],
 
  cameraToggle: [
    'button[data-tid="toggle-camera"]',
    'button[title*="camera"]',
    'button[aria-label*="camera"]'
  ],
  micToggle: [
    'button[data-tid="toggle-mute"]',
    'button[title*="microphone"]',
    'button[aria-label*="microphone"]',
    'button[aria-label*="Mic"]'
  ],
  leaveButton: [
    'button[data-tid="leave-call-button"]',
    'button[aria-label*="Leave"]',
    'button:has-text("Leave")'
  ]
};

class TeamsController extends PlatformController {
  async beforeNavigate() {
    await this.grantPermissions();
  }

  async beforeJoin() {
    await this.page.waitForLoadState('domcontentloaded');
    await this.page.waitForTimeout(2000); // Wait for Teams page to fully load
    
    // Click "Continue on this browser" button if present
    const continueButton = this.page.locator('button[data-tid="joinOnWeb"]').first();
    if (await continueButton.isVisible({ timeout: 3000 }).catch(() => false)) {
      this.logger.info('Teams: found "Continue on this browser" button, clicking...');
      
      // Set up navigation wait BEFORE clicking (to catch the reload)
      const navigationPromise = this.page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => 
        this.page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {})
      );
      
      // Click the button
      await continueButton.click();
      
      // Wait for navigation to complete (prevents page reload causing button to reappear)
      await navigationPromise;
      
      this.logger.info('Teams: clicked "Continue on this browser" and navigation completed');
      
      // Additional wait to ensure page is stable
      await this.page.waitForTimeout(1000);
    }

    // Wait for the pre-join UI to fully load - Teams can be slow
    this.logger.info('Teams: waiting for pre-join UI to load...');
    await this.page.waitForTimeout(5000);
    
    // Wait for the join button to appear (indicates pre-join screen is ready)
    const joinButtonLocator = this.page.locator('button:has-text("Join now")').first();
    try {
      await joinButtonLocator.waitFor({ state: 'visible', timeout: 15000 });
      this.logger.info('Teams: pre-join UI loaded');
    } catch (error) {
      this.logger.warn('Teams: pre-join UI not fully loaded yet', { error: error.message });
    }
    
    // Debug: check what inputs are on the page
    const debugInfo = await this.page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('input[type="text"]'));
      return inputs.map(inp => ({
        placeholder: inp.placeholder || '',
        ariaLabel: inp.getAttribute('aria-label') || '',
        dataTid: inp.getAttribute('data-tid') || '',
        visible: inp.offsetParent !== null
      })).filter(inp => inp.visible);
    });
    this.logger.debug('Teams: visible text inputs', { inputs: debugInfo });
    
    // Try multiple selectors for the name input
    const nameInputSelectors = [
      'input[placeholder*="name" i]',
      'input[placeholder="Type your name"]',
      'input[type="text"]'
    ];
    
    let nameFilled = false;
    for (const selector of nameInputSelectors) {
      try {
        const nameInput = this.page.locator(selector).first();
        if (await nameInput.isVisible({ timeout: 2000 })) {
          await nameInput.fill(this.config.botName);
          this.logger.info('Teams: filled guest name', { selector });
          nameFilled = true;
          break;
        }
      } catch (error) {
        this.logger.debug('Teams: selector failed', { selector, error: error.message });
      }
    }
    
    if (!nameFilled) {
      this.logger.warn('Teams: name input not found with selectors, trying fallback');
      // Fallback: try to find any text input and fill it
      const allInputs = await this.page.$$('input[type="text"]');
      if (allInputs.length > 0) {
        await allInputs[0].fill(this.config.botName);
        this.logger.info('Teams: filled guest name with fallback');
        nameFilled = true;
      }
    }
    
    if (!nameFilled) {
      this.logger.warn('Teams: could not fill name input');
    }

    // Ensure camera is OFF before joining - find and click camera toggle if enabled
    try {
      await this.page.waitForTimeout(1000); // Wait for toggles to render
      
      // Find the camera toggle switch on the pre-join screen
      const result = await this.page.evaluate(() => {
        const toggles = Array.from(document.querySelectorAll('button, [role="button"]'));
        for (const toggle of toggles) {
          const text = toggle.textContent?.toLowerCase() || '';
          const ariaLabel = toggle.getAttribute('aria-label')?.toLowerCase() || '';
          
          // Look for camera-related toggle
          if ((text.includes('camera') || ariaLabel.includes('camera')) && 
              toggle.offsetParent !== null) {
            return {
              found: true,
              tagName: toggle.tagName,
              text: toggle.textContent,
              ariaLabel: toggle.getAttribute('aria-label'),
              ariaPressed: toggle.getAttribute('aria-pressed')
            };
          }
        }
        return { found: false };
      });
      
      if (result.found) {
        this.logger.info('Teams: found camera toggle on pre-join screen', { 
          result,
          isPressed: result.ariaPressed === 'true'
        });
        
        // Click the camera toggle to turn it off if it's currently on
        const cameraToggle = this.page.locator('button, [role="button"]')
          .filter({ hasText: /camera/i })
          .first();
        
        if (await cameraToggle.isVisible({ timeout: 1000 }).catch(() => false)) {
          await cameraToggle.click();
          this.logger.info('Teams: toggled camera off on pre-join screen');
        }
      } else {
        this.logger.debug('Teams: no camera toggle found on pre-join screen');
      }
    } catch (error) {
      this.logger.debug('Teams: camera toggle not found or already off', { error: error.message });
    }
  }

  async performJoin() {
    // Debug: check what buttons are on the page
    const debugInfo = await this.page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
      return buttons.map(btn => ({
        text: btn.textContent?.trim() || '',
        ariaLabel: btn.getAttribute('aria-label') || '',
        dataTid: btn.getAttribute('data-tid') || '',
        visible: btn.offsetParent !== null
      })).filter(btn => btn.visible);
    });
    this.logger.debug('Teams: visible buttons on page', { buttons: debugInfo });
    
    // Wait for the "Join now" button to appear and be clickable
    try {
      const joinButton = await this.page.locator('button:has-text("Join now")').first();
      await joinButton.waitFor({ state: 'visible', timeout: 10000 });
      await joinButton.click();
      this.logger.info('Teams: clicked "Join now" button');
      
      // Trigger TTS immediately after clicking join (workaround for ensureJoined hanging)
      // We'll trigger TTS via the bot's speakLLMResponse method
      setTimeout(async () => {
        try {
          this.logger.info('Teams: triggering TTS after join button click');
          // Access the bot instance to trigger TTS
          if (this.config && this.config.enableTtsPlayback) {
            this.logger.info('Teams: TTS enabled, would trigger here');
            // The TTS will be triggered by the timeout in runLoop
          }
        } catch (error) {
          this.logger.error('Teams: could not trigger TTS', { error: error.message });
        }
      }, 8000); // Wait 8 seconds for Teams to connect
      
    } catch (error) {
      this.logger.error('Teams: could not find or click "Join now" button', { error: error.message });
      throw new Error('Teams: join button not found or not clickable');
    }
  }

  async ensureJoined() {
    this.enforceJoinDeadline();
    const lobbyLocator = this.page.locator(SELECTORS.lobbyMessage.join(','));
    if (await lobbyLocator.isVisible({ timeout: 5000 }).catch(() => false)) {
      this.logger.info('Teams: waiting in lobby for host admission...');
      while (await lobbyLocator.isVisible().catch(() => false)) {
        this.enforceJoinDeadline();
        await this.page.waitForTimeout(2000);
      }
    }

  }

  async afterJoin() {
    // Ensure camera is OFF and microphone is ON in the meeting
    await this.setCamera(false).catch((error) => this.logger.warn('Teams: unable to disable camera in meeting', { error: error.message }));
    await this.setMicrophone(true).catch((error) => this.logger.warn('Teams: unable to enable microphone in meeting', { error: error.message }));
  }

  async hasBotJoined() {
    if (this.page.isClosed()) {
      return false;
    }

    try {
      // Check for in-meeting UI elements:
      // 1. Meeting controls (mic button, hangup button, etc.)
      const controlsVisible = await Promise.race([
        this.page.locator('button[id="mic-button"]').isVisible({ timeout: 1000 }).catch(() => false),
        this.page.locator('button[id="hangup-button"]').isVisible({ timeout: 1000 }).catch(() => false),
        this.page.locator('button[aria-label*="Leave"]').isVisible({ timeout: 1000 }).catch(() => false)
      ]);

      // 2. Stage layout or participant tiles
      const stageVisible = await Promise.race([
        this.page.locator('div[data-tid="stage-layout"]').isVisible({ timeout: 1000 }).catch(() => false),
        this.page.locator('div[data-tid="modern-stage-wrapper"]').isVisible({ timeout: 1000 }).catch(() => false),
        this.page.locator('div[data-testid="stage-segment"]').isVisible({ timeout: 1000 }).catch(() => false)
      ]);

      // 3. Bot's participant tile (if name is visible)
      const botName = this.config.botName || 'CLAKBOT';
      const botTileVisible = await this.page.locator(`div[data-tid="${botName}"]`).isVisible({ timeout: 1000 }).catch(() => false);

      // 4. Meeting toolbar/controls area
      const toolbarVisible = await Promise.race([
        this.page.locator('div[role="toolbar"]').filter({ hasText: /Chat|People|Share/i }).isVisible({ timeout: 1000 }).catch(() => false),
        this.page.locator('button[aria-label*="Chat"]').isVisible({ timeout: 1000 }).catch(() => false),
        this.page.locator('button[aria-label*="People"]').isVisible({ timeout: 1000 }).catch(() => false)
      ]);

      // Consider joined if we see meeting controls OR stage layout OR toolbar
      const isJoined = controlsVisible || stageVisible || toolbarVisible || botTileVisible;

      if (isJoined) {
        this.logger.info('Teams: bot has joined meeting', {
          controlsVisible,
          stageVisible,
          toolbarVisible,
          botTileVisible
        });
      }

      return isJoined;
    } catch (error) {
      this.logger.debug('Teams: error checking if bot joined', { error: error.message });
      return false;
    }
  }

  getMeetingPresenceSelectors() {
    // Selectors that indicate the meeting UI is still active
    // If any of these are visible, the meeting is still ongoing
    return [
      'button[id="mic-button"]',
      'button[id="hangup-button"]',
      'button[aria-label*="Leave"]',
      'div[data-tid="stage-layout"]',
      'div[data-tid="modern-stage-wrapper"]',
      'div[data-testid="stage-segment"]',
      'div[role="toolbar"]',
      'button[aria-label*="Chat"]',
      'button[aria-label*="People"]',
      // Meeting controls area
      'div[data-tid="meeting-controls"]',
      // Participant tiles
      'div[data-tid="participant-tile"]'
    ];
  }

  async leaveMeeting() {
    const locator = await this.clickFirstVisible(SELECTORS.leaveButton, { timeout: 5000 });
    if (!locator) {
      throw new Error('Teams: unable to locate leave button');
    }
    this.logger.info('Teams: leave button clicked');
  }

  async setMicrophone(enable) {
    await this.ensureToggleState({
      selectors: SELECTORS.micToggle,
      desiredState: enable,
      allowUnknown: true
    });
    this.logger.info(`Teams: microphone ${enable ? 'enabled' : 'muted'}`);
  }

  async setCamera(enable) {
    await this.ensureToggleState({
      selectors: SELECTORS.cameraToggle,
      desiredState: enable,
      allowUnknown: true
    });
    this.logger.info(`Teams: camera ${enable ? 'enabled' : 'disabled'}`);
  }
}

module.exports = TeamsController;
