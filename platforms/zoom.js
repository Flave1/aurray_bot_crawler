const PlatformController = require('./base');

const SELECTORS = {
  termsAgree: [
    'button:has-text("I Agree")',
    'button[aria-label="I Agree"]'
  ],
  mediaPromptUseMicCam: [
    'button:has-text("Use microphone and camera")',
    'button:has-text("Join with computer audio")',
    'button:has-text("Turn on microphone and camera")'
  ],
  mediaPromptContinueWithout: [
    'button:has-text("Continue without microphone and camera")',
    'button:has-text("Continue without audio")',
    'button:has-text("Join without audio")'
  ],
  nameInputs: [
    'input#input-for-name',
    'input.preview-meeting-info-field-input',
    'input[placeholder="Your Name"]',
    'input[aria-label="Your Name"]',
    'input[name="username"]'
  ],
  passcodeInputs: [
    'input[placeholder*="passcode" i]',
    'input[name="password"]',
    'input[id*="passcode"]'
  ],
  waitingMessage: [
    'text=/Waiting for the host to start this meeting/i',
    'text=/Please wait for the host to start/i'
  ],
  joinButtons: [
    'button[type="submit"]:has-text("Join")',
    '[data-testid="join-button"]',
    'button:has-text("Join Meeting")'
  ],
  meetingIndicators: [
    '.meeting-client',
    '.wm-meeting-client',
    '.meeting-client-inner',
    '[data-testid*="meeting"]'
  ],
  micToggle: [
    'button[aria-label*="Unmute"]',
    'button[aria-label*="Mute"]',
    '[data-testid*="audio"]'
  ],
  cameraToggle: [
    'button[aria-label*="Start Video"]',
    'button[aria-label*="Stop Video"]',
    '[data-testid*="video"]'
  ],
  leaveButtons: [
    'button:has-text("Leave")',
    '[data-testid*="leave"]'
  ]
};

class ZoomController extends PlatformController {
  constructor(page, config, logger) {
    super(page, config, logger);
    this.domTarget = null;
    this.cachedJoinSelector = null;
  }

  async beforeNavigate() {
    await this.grantPermissions();
  }

  async beforeJoin() {
    await this.page.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {});
    
    // Handle dialogs on the main page
    await this.handleMainPageDialogs();
    
    await this.ensureDomTarget();

    await this.fillParticipantName();
    await this.fillPasscodeIfNeeded();
  }
  
  async handleMainPageDialogs() {
    // Wait for iframe to be ready
    await this.page.waitForTimeout(800);
    
    const iframe = this.page.locator('iframe#webclient');
    try {
      // Check if iframe exists
      if (await iframe.isVisible({ timeout: 1000 }).catch(() => false)) {
        const frameElement = await iframe.elementHandle();
        const frame = await frameElement.contentFrame();
        
        if (frame) {
          // Try to find and click Accept Cookies inside iframe
          const acceptCookies = frame.locator('button:has-text("Accept Cookies")');
          if (await acceptCookies.isVisible({ timeout: 2000 }).catch(() => false)) {
            await acceptCookies.click();
            this.logger.info('Zoom: clicked Accept Cookies in iframe');
            await this.page.waitForTimeout(300); // Wait for cookie dialog to close
          }
          
          // Wait a moment for Terms dialog to appear
          await this.page.waitForTimeout(300);
          
          // Try multiple selectors for I Agree button
          const agreeSelectors = [
            '#wc_agree1', // Based on HTML inspection
            'button#wc_agree1',
            'button:has-text("I Agree")',
            'button.btn-primary:has-text("I Agree")',
            '#wc_agree2',
            'button#wc_agree2'
          ];
          
          for (const selector of agreeSelectors) {
            try {
              const agreeButton = frame.locator(selector).first();
              if (await agreeButton.isVisible({ timeout: 2000 }).catch(() => false)) {
                await agreeButton.click({ force: true });
                this.logger.info('Zoom: clicked I Agree button', { selector });
                await this.page.waitForTimeout(300);
                break;
              }
            } catch (error) {
              this.logger.debug('Zoom: could not click agree button', { selector, error: error.message });
            }
          }
        }
      }
    } catch (error) {
      this.logger.debug('Zoom: error handling dialogs', { error: error.message });
    }
  }

  async performJoin() {
    // Wait a moment for the join button to be enabled after name is filled
    await this.page.waitForTimeout(500);
    
    // Try to find and click the join button across ALL frames
    let clicked = false;
    
    // Get all frames
    const frames = this.page.frames();
    
    for (const frame of frames) {
      try {
        const result = await frame.evaluate(() => {
          // Find all interactive elements that could be a join button
          const allClickables = document.querySelectorAll('button, [role="button"], div[tabindex], a[tabindex]');
          let bestMatch = null;
          let bestMatchText = '';
          
          for (const el of allClickables) {
            if (!el.offsetParent) continue; // Must be visible
            
            const text = el.textContent.trim().toLowerCase();
            const classes = el.className?.toLowerCase() || '';
            
            // Check if this looks like a join button
            if (text.includes('join') && !text.includes('audio') && !text.includes('phone')) {
              if (el.disabled === false) {
                bestMatch = el;
                bestMatchText = el.textContent.trim();
                break; // Found it!
              }
            }
            
            // Also check for large prominent buttons
            if (classes.includes('btn-primary') || classes.includes('join-btn') || 
                (el.tagName === 'BUTTON' && el.offsetHeight > 40)) {
              if (!el.disabled) {
                if (!bestMatch) {
                  bestMatch = el;
                  bestMatchText = el.textContent.trim();
                }
              }
            }
          }
          
          if (bestMatch) {
            bestMatch.focus();
            bestMatch.scrollIntoView({ behavior: 'smooth', block: 'center' });
            bestMatch.click();
            return { success: true, text: bestMatchText };
          }
          
          return { success: false, error: 'Join button not found', 
                   totalClickables: allClickables.length };
        });
        
        if (result && result.success) {
          this.logger.info('Zoom: clicked join button via JavaScript', { 
            frame: frame.url(),
            buttonText: result.text 
          });
          clicked = true;
          break;
        }
      } catch (error) {
        this.logger.debug('Zoom: error checking frame for join button', { 
          frame: frame.url(), 
          error: error.message 
        });
      }
    }
    
    if (!clicked) {
      this.logger.warn('Zoom: could not click join button in any frame');
      throw new Error('Zoom: join button not found');
    }
    
    await this.page.waitForTimeout(1000);
  }

  async ensureJoined() {
    const dom = this.getDomTarget();
    const waitingLocator = dom.locator(SELECTORS.waitingMessage.join(','));
    if (await waitingLocator.isVisible({ timeout: 4000 }).catch(() => false)) {
      this.logger.info('Zoom: waiting for host admission');
      while (await waitingLocator.isVisible().catch(() => false)) {
        this.enforceJoinDeadline();
        await this.page.waitForTimeout(2000);
      }
    }

    await this.waitForAny(SELECTORS.meetingIndicators, { timeout: 25000, state: 'attached' });
    this.logger.info('Zoom: meeting UI detected');
  }

  async afterJoin() {
    await this.setCamera(true).catch((error) => this.logger.warn('Zoom: camera enable failed', { error: error.message }));
    await this.setMicrophone(true).catch((error) => this.logger.warn('Zoom: microphone enable failed', { error: error.message }));
  }

  getMeetingPresenceSelectors() {
    // Comprehensive selectors that indicate the meeting UI is still active
    // If any of these are visible, the meeting is still ongoing
    return [
      // Meeting client containers
      ...SELECTORS.meetingIndicators,
      // Meeting controls (mic, camera, leave buttons)
      ...SELECTORS.micToggle,
      ...SELECTORS.cameraToggle,
      ...SELECTORS.leaveButtons,
      // Additional Zoom-specific indicators
      'button[aria-label*="Unmute"]',
      'button[aria-label*="Mute"]',
      'button[aria-label*="Start Video"]',
      'button[aria-label*="Stop Video"]',
      'button[aria-label*="Leave"]',
      // Meeting toolbar/controls
      '.meeting-control-bar',
      '.meeting-controls',
      '[data-testid*="meeting-control"]',
      // Participant area
      '.participant-list',
      '.participant-container',
      // Video grid
      '.video-container',
      '.video-grid',
      '.meeting-video-grid'
    ];
  }

  async leaveMeeting() {
    const leave = await this.clickFirstVisible(SELECTORS.leaveButtons, { timeout: 4000 });
    if (!leave) {
      throw new Error('Zoom: unable to locate leave button');
    }
    this.logger.info('Zoom: leave button clicked');
  }

  async setMicrophone(enable) {
    await this.ensureToggleState({ selectors: SELECTORS.micToggle, desiredState: enable, allowUnknown: true });
    this.logger.info(`Zoom: microphone ${enable ? 'enabled' : 'muted'}`);
  }

  async setCamera(enable) {
    await this.ensureToggleState({ selectors: SELECTORS.cameraToggle, desiredState: enable, allowUnknown: true });
    this.logger.info(`Zoom: camera ${enable ? 'enabled' : 'disabled'}`);
  }

  getDomTarget() {
    return this.domTarget || this.page;
  }

  async ensureDomTarget(timeoutMs = 10000) {
    if (this.domTarget && !this.domTarget.isDetached?.()) {
      return;
    }
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const frame = this.page.frames().find((f) => f.url().includes('/wc/') && f.url().includes('/join'));
      if (frame) {
        this.domTarget = frame;
        await this.domTarget.waitForLoadState('domcontentloaded').catch(() => {});
        this.logger.debug('Zoom: using PWA iframe as DOM target', { url: frame.url() });
        return;
      }
      await this.page.waitForTimeout(200);
    }
    this.logger.warn('Zoom: PWA iframe not found, falling back to top-level page');
    this.domTarget = this.page;
  }






  async fillParticipantName() {
    // Wait for the join UI to appear (wait for name input to be visible)
    this.logger.info('Zoom: waiting for join UI to appear');
    
    // Wait up to 30 seconds for the UI to load
    const maxWait = 30;
    let framesWithInputs = 0;
    
    for (let i = 0; i < maxWait; i++) {
      const frames = this.page.frames();
      for (const frame of frames) {
        try {
          const hasInput = await frame.evaluate(() => {
            const inputs = document.querySelectorAll('input[type="text"]');
            return inputs.length > 0 && Array.from(inputs).some(inp => inp.offsetParent !== null);
          });
          if (hasInput) {
            framesWithInputs++;
            break;
          }
        } catch (e) {}
      }
      if (framesWithInputs > 0) break;
      await this.page.waitForTimeout(1000);
    }
    
    if (framesWithInputs === 0) {
      this.logger.warn('Zoom: no inputs found after waiting');
      return;
    }
    
    // Get all frames
    const frames = this.page.frames();
    let filled = false;
    
    for (const frame of frames) {
      try {
        // Debug what's on this frame
        const debugInfo = await frame.evaluate(() => {
          const result = { inputs: [], buttons: [], url: window.location.href };
          
          const allInputs = document.querySelectorAll('input');
          for (const input of allInputs) {
            if (input.offsetParent !== null) {
              result.inputs.push({
                id: input.id,
                type: input.type,
                value: input.value,
                placeholder: input.placeholder
              });
            }
          }
          
          const allButtons = document.querySelectorAll('button');
          for (const btn of allButtons) {
            if (btn.offsetParent !== null) {
              result.buttons.push({
                id: btn.id,
                text: btn.textContent.trim().substring(0, 30)
              });
            }
          }
          
          return result;
        });
        
        this.logger.info('Zoom: checking frame', { 
          frame: frame.url(), 
          inputs: debugInfo.inputs.length,
          buttons: debugInfo.buttons.length
        });
        
        if (debugInfo.inputs.length > 0) {
          this.logger.info('Zoom: found inputs in frame', { inputs: debugInfo.inputs, buttons: debugInfo.buttons });
          
          // Try to fill the name
          const result = await frame.evaluate((botName) => {
            const allInputs = document.querySelectorAll('input[type="text"], input[type="email"]');
            for (const input of allInputs) {
              if (input.offsetParent !== null) {
                // Focus and clear
                input.focus();
                
                // Clear any existing value
                const currentValue = input.value;
                input.value = '';
                
                // Dispatch events for clearing
                for (let i = 0; i < currentValue.length; i++) {
                  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', keyCode: 8, bubbles: true }));
                  input.dispatchEvent(new InputEvent('input', { inputType: 'deleteContentBackward', bubbles: true }));
                  input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Backspace', keyCode: 8, bubbles: true }));
                }
                
                // Set the value and trigger all necessary events
                input.value = botName;
                
                // Trigger comprehensive events for React to recognize the change
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
                input.dispatchEvent(new Event('blur', { bubbles: true }));
                input.dispatchEvent(new Event('focus', { bubbles: true }));
                
                return { success: true, value: input.value };
              }
            }
            return { success: false };
          }, this.config.botName);
          
          if (result && result.success) {
            this.logger.info('Zoom: filled name field', { frame: frame.url(), value: result.value });
            filled = true;
            
            // Wait for React to process the change and update
            await this.page.waitForTimeout(1500);
            
            const buttonState = await frame.evaluate(() => {
              const allButtons = document.querySelectorAll('button, [role="button"], div[tabindex]');
              for (const btn of allButtons) {
                const text = btn.textContent.trim().toLowerCase();
                if (text.includes('join') && !text.includes('audio') && !text.includes('phone')) {
                  const wasDisabled = btn.disabled || btn.getAttribute('aria-disabled') === 'true';
                  
                  // If button is disabled, try to enable it
                  if (wasDisabled) {
                    btn.removeAttribute('disabled');
                    btn.setAttribute('aria-disabled', 'false');
                    // Trigger change event in case it's listening
                    btn.dispatchEvent(new Event('change', { bubbles: true }));
                  }
                  
                  return { found: true, text: btn.textContent.trim(), wasDisabled, nowEnabled: !btn.disabled };
                }
              }
              return { found: false };
            });
            
            if (buttonState && buttonState.found) {
              this.logger.info('Zoom: Join button state', { 
                wasDisabled: buttonState.wasDisabled,
                nowEnabled: buttonState.nowEnabled,
                text: buttonState.text
              });
            }
            
            break;
          }
        }
      } catch (error) {
        this.logger.debug('Zoom: error checking frame', { frame: frame.url(), error: error.message });
      }
    }
    
    if (!filled) {
      this.logger.warn('Zoom: could not fill name field in any frame');
    }
  }

  async fillPasscodeIfNeeded() {
    if (!this.config.meetingPasscode) {
      return;
    }
    const match = await this.waitForVisibleSelector(SELECTORS.passcodeInputs, 8000);
    if (!match) {
      this.logger.warn('Zoom: passcode input not found');
      return;
    }
    await match.locator.fill(this.config.meetingPasscode);
    this.logger.info('Zoom: filled meeting passcode', { selector: match.selector });
  }

  async ensureJoinButtonEnabled() {
    const match = await this.waitForVisibleSelector(SELECTORS.joinButtons, 15000);
    if (!match) {
      this.logger.warn('Zoom: join button never appeared');
      return;
    }
    const enabled = await this.waitUntilEnabled(match.locator);
    if (!enabled) {
      this.logger.warn('Zoom: join button stayed disabled', { selector: match.selector });
      return;
    }
    this.cachedJoinSelector = match.selector;
  }

  async waitUntilEnabled(locator, timeoutMs = 8000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const disabled = await locator.isDisabled().catch(() => true);
      if (!disabled) {
        return true;
      }
      await this.page.waitForTimeout(250);
    }
    return false;
  }

  async waitForVisibleSelector(selectors, timeoutMs = 12000) {
    const dom = this.getDomTarget();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      for (const selector of selectors) {
        const locator = dom.locator(selector).first();
        try {
          await locator.waitFor({ state: 'visible', timeout: 500 });
          return { locator, selector };
        } catch (error) {
          // swallow and continue
        }
      }
      await this.page.waitForTimeout(250);
    }
    return null;
  }

}

module.exports = ZoomController;
