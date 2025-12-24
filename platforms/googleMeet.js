const PlatformController = require("./base");
const fs = require("fs");
const path = require("path");

class GoogleMeetController extends PlatformController {
  static getBrowserArgs() {
    return [];
  }

  static getPermissionsOrigin(meetingUrl) {
    return "https://meet.google.com";
  }

  /**
   * Take a screenshot for debugging purposes
   * @param {string} reason - Reason for the screenshot (e.g., "join_button_not_found")
   */
  async takeScreenshot(reason) {
    try {
      // Use mounted volume path for Docker containers, fallback to local logs for subprocess
      // In Docker, screenshots are mounted at /app/logs/screenshots
      // For subprocess, use process.cwd()/logs/screenshots
      const isDocker = fs.existsSync('/app/logs/screenshots');
      const screenshotsDir = isDocker 
        ? '/app/logs/screenshots'
        : path.join(process.cwd(), "logs", "screenshots");
      
      if (!fs.existsSync(screenshotsDir)) {
        fs.mkdirSync(screenshotsDir, { recursive: true });
      }

      // Generate filename with timestamp, meeting ID, session ID, and reason
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const meetingId = this.config.meetingId || "unknown";
      const sessionId = (this.config.sessionId || "unknown").substring(0, 8);
      const filename = `screenshot-${timestamp}-${meetingId}-${sessionId}-${reason}.png`;
      const filepath = path.join(screenshotsDir, filename);

      // Take screenshot
      await this.page.screenshot({
        path: filepath,
        fullPage: true, // Capture full page, not just viewport
      });

      this.logger.warn("Screenshot captured", {
        reason,
        filepath,
        url: this.page.url(),
      });
    } catch (error) {
      this.logger.error("Failed to take screenshot", {
        reason,
        error: error.message,
      });
    }
  }

  async beforeJoin() {
    await this.page.waitForLoadState("domcontentloaded");
    await this.page.waitForTimeout(2000);
    this.logger.info("Page ready");
  }

  async performJoin() {
    this.logger.info("Looking for join button");

    const joinButton = await this.clickFirstVisible(
      [
        'button:has-text("Ask to join")',
        'button:has-text("Join now")',
        'button:has-text("Switch here")',
      ],
      { timeout: 5000 }
    ); // 5 seconds

    if (joinButton) {

      // Send status that we're in the meeting
      await this.config.sendStatusUpdate(
        "in_meeting",
        "Successfully joined the meeting",
        { platform: this.config.platform, botName: this.config.botName }
      );
      await this.config.sendStatusUpdate(
        "waiting_to_admit",
        "Waiting to admit users into the meeting",
        { platform: this.config.platform, botName: this.config.botName }
      );

      const buttonText = await joinButton.textContent().catch(() => "");
      this.logger.info("Clicked join button", { buttonText });
      // Store if we clicked "Ask to join" to detect waiting state later

      this.clickedAskToJoin = true;
      return true;
    } else {
      this.clickedAskToJoin = false;
      this.logger.info("Join button not found");
      
      // Take screenshot for debugging
      await this.takeScreenshot("join_button_not_found");
      
      return false;
    }
  }

  async ensureJoined() {
    // Check if bot is organizer - if so, it should join directly without waiting
    const isOrganizer = this.config.isOrganizer === true || this.config.isOrganizer === "true";
    
    // If bot clicked "Ask to join", it might need to wait for admission
    if (this.clickedAskToJoin && !isOrganizer) {
      this.logger.info("Bot clicked 'Ask to join' - checking if waiting for admission");
      
      // Look for waiting/admission indicators in Google Meet
      const waitingSelectors = [
        'text="Waiting to be let in"',
        'text="Waiting for the host to let you in"',
        'text="You\'re waiting to join"',
        '[aria-label*="waiting"]',
        '[aria-label*="Waiting"]',
        '[data-message*="waiting" i]',
      ];

      // Check if we're in waiting state
      let isWaiting = false;
      for (const selector of waitingSelectors) {
        try {
          const waitingElement = await this.page.locator(selector).first();
          if (
            await waitingElement.isVisible({ timeout: 5000 }).catch(() => false)
          ) {
            isWaiting = true;
            this.logger.info("Detected waiting for admission state", { selector });
            break;
          }
        } catch (e) {
          // Continue checking other selectors
        }
      }

      // If waiting for admission, send status and wait longer for admission
      if (isWaiting && this.config.sendStatusUpdate) {
        await this.config.sendStatusUpdate(
          "waiting_for_host",
          "Waiting to be admitted into the meeting",
          { platform: this.config.platform }
        );
        
        // Wait up to 2 minutes for admission (host needs time to admit)
        this.logger.info("Waiting for host to admit bot (up to 2 minutes)");
        try {
          await this.page.waitForSelector('button[aria-label*="Leave call"]', {
            timeout: 120000, // 2 minutes for admission
          });
          this.logger.info("Bot was admitted - Leave call button visible");
          return; // Successfully joined
        } catch (e) {
          this.logger.warn("Timeout waiting for admission - bot may not have been admitted", {
            error: e.message
          });
          // Continue to check if we're actually in the meeting anyway
        }
      }
    }

    // Try to find "Leave call" button with multiple selectors
    const leaveButtonSelectors = [
      'button[aria-label*="Leave call"]',
      'button[aria-label*="leave call"]',
      'button[aria-label*="Leave"]',
      'button:has-text("Leave")',
      '[data-mdc-dialog-action="close"]', // Sometimes shown as close button
    ];

    let foundLeaveButton = false;
    for (const selector of leaveButtonSelectors) {
      try {
        await this.page.waitForSelector(selector, {
          timeout: 30000,
        });
        this.logger.info("Meeting joined - Leave call button visible", { selector });
        foundLeaveButton = true;
        break;
      } catch (e) {
        // Try next selector
        continue;
      }
    }

    if (!foundLeaveButton) {
      // Last resort: check if we're actually in the meeting by looking for meeting UI elements
      const meetingIndicators = [
        '[data-self-name]', // Self name indicator
        'button[aria-label*="Turn off microphone"]',
        'button[aria-label*="Turn on microphone"]',
        'button[aria-label*="Turn off camera"]',
        'button[aria-label*="Turn on camera"]',
      ];

      let foundIndicator = false;
      for (const indicator of meetingIndicators) {
        try {
          const element = await this.page.locator(indicator).first();
          if (await element.isVisible({ timeout: 5000 }).catch(() => false)) {
            this.logger.info("Meeting indicator found - assuming joined", { indicator });
            foundIndicator = true;
            break;
          }
        } catch (e) {
          continue;
        }
      }

      if (!foundIndicator) {
        throw new Error('Could not confirm meeting join - Leave call button and meeting indicators not found');
      }
    }
  }

  async afterJoin() {
    // Check if bot is organizer and has status update capability
    const isOrganizer = this.config.isOrganizer === true || this.config.isOrganizer === "true";
    if (isOrganizer && this.config.sendStatusUpdate) {
      this.logger.info("Bot is organizer - setting up auto-admit functionality");

      // Open People panel in background (non-blocking)
      this._openPeoplePanel().catch(err => {
        this.logger.warn('Error opening People panel', { error: err.message });
      });

      // Start polling 2 seconds after joining (regardless of panel state)
      // The polling function will handle retrying if panel isn't open yet
      setTimeout(() => {
        this.logger.info('Starting admit polling 2 seconds after join');
        this._startAdmitAllPolling();
      }, 2000);
    } else {
      this.logger.info(
        "afterJoin skipped - bot is not organizer or status updates not available",
        {
          isOrganizer,
          hasSendStatusUpdate: !!this.config.sendStatusUpdate,
        }
      );
    }
  }

  async _openPeoplePanel() {
    try {
      const peopleButton = await this.page.locator('button[aria-label^="People -"][aria-label*="joined"]').first();
      if (await peopleButton.isVisible({ timeout: 3000 }).catch(() => false)) {
        const isExpanded = await peopleButton.getAttribute('aria-expanded');
        this.logger.info('People button state', { ariaExpanded: isExpanded });
        
        // Check if panel is already open
        if (isExpanded === 'true') {
          this.logger.info('People panel is already open');
          return true;
        } else {
          // Open panel if not already open
          await peopleButton.click();
          this.logger.info('Clicked "People" button to open participants panel');
          // Wait for panel to fully open
          await this.page.waitForTimeout(1500);
          // Verify it opened
          const expandedAfter = await peopleButton.getAttribute('aria-expanded');
          if (expandedAfter === 'true') {
            this.logger.info('People panel opened successfully');
            return true;
          } else {
            this.logger.warn('People panel may not have opened, aria-expanded:', expandedAfter);
            return false;
          }
        }
      } else {
        this.logger.warn('"People" button not found or not visible');
        return false;
      }
    } catch (error) {
      this.logger.warn('Error opening People panel', { error: error.message });
      return false;
    }
  }

  _startAdmitAllPolling() {
    // Non-blocking polling using recursive setTimeout to ensure sequential execution
    // Stops automatically after successfully admitting a user
    this.logger.info('_startAdmitAllPolling: Starting polling for "Admit all" button');
    this._admitAllPollCount = 0;
    this._admitAllPollingActive = true;
    this._admitAllTimeout = null; // Store timeout ID for cleanup
    this._userAdmitted = false; // Track if a user has been admitted
    
    // Use recursive setTimeout instead of setInterval to ensure sequential execution
    // and prevent overlapping async operations
    const pollOnce = async () => {
      // Check if polling should stop (cleanup was called or user admitted)
      if (!this._admitAllPollingActive || this._userAdmitted) {
        if (this._userAdmitted) {
          this.logger.info('Polling stopped - user has been admitted');
        } else {
          this.logger.info('Polling stopped - cleanup was called');
        }
        return;
      }
      
      // Check if page is closed
      if (this.page && this.page.isClosed()) {
        this.logger.info('Polling stopped - page is closed');
        this._admitAllPollingActive = false;
        return;
      }
      
      this._admitAllPollCount++;
      this.logger.info(`Polling for "Admit all" button (attempt ${this._admitAllPollCount})`);
      
      try {
        // Try multiple selectors for the "Admit all" button
        const admitSelectors = [
          'button:has-text("Admit")',
          'button[aria-label*="Admit"]',
          'button:has-text("Admit all")',
        ];
        
        let foundButton = null;
        for (const selector of admitSelectors) {
          try {
            const button = await this.page.locator(selector).first();
            if (await button.isVisible({ timeout: 1000 }).catch(() => false)) {
              foundButton = button;
              this.logger.info(`Found "Admit" button using selector: ${selector}`);
              break;
            }
          } catch (e) {
            // Try next selector
            continue;
          }
        }
        
        if (foundButton) {
          this.logger.info('Clicking "Admit" button');
          await foundButton.click();
          
          // Wait a moment for the confirmation modal/dialog to appear
          await this.page.waitForTimeout(500);
          
          // Wait for the confirmation modal/dialog to appear
          // Look for the dialog element first, then the button
          try {
            // Wait for dialog to appear (MDC dialog)
            await this.page.waitForSelector('[data-mdc-dialog-action="ok"]', { 
              timeout: 3000 
            }).catch(() => null);
            
            // Look for the confirmation button in the modal with multiple selectors
            const confirmSelectors = [
              'button[data-mdc-dialog-action="ok"]',
              'button.mUIrbf-LgbsSe[data-mdc-dialog-action="ok"]',
              'button:has([jsname="V67aGc"]:has-text("Admit all"))',
              'button:has-text("Admit all")[data-mdc-dialog-action="ok"]',
            ];
            
            let confirmed = false;
            for (const selector of confirmSelectors) {
              try {
                const confirmButton = await this.page.locator(selector).first();
                if (await confirmButton.isVisible({ timeout: 1500 }).catch(() => false)) {
                  this.logger.info('Found confirmation modal button - clicking to confirm');
                  await confirmButton.click();
                  confirmed = true;
                  
                  // Wait a bit after confirmation for modal to close
                  await this.page.waitForTimeout(1000);
                  
                  // Check if the "Admit" button is gone (indicating successful admission)
                  // This confirms that a user was actually admitted
                  const buttonStillExists = await this.page.locator(admitSelectors[0]).first()
                    .isVisible({ timeout: 1000 })
                    .catch(() => false);
                  
                  if (!buttonStillExists) {
                    this.logger.info('✅ "Admit" button disappeared - user has been admitted successfully');
                    this._userAdmitted = true;
                    
                    if (this.config.sendStatusUpdate) {
                      await this.config.sendStatusUpdate(
                        "done_status",
                        "I have admitted you into the meeting",
                        { platform: this.config.platform }
                      );
                      await this.config.sendStatusUpdate(
                        "done_status",
                        "You can say hello to me now!",
                        { platform: this.config.platform }
                      );
                    }
                    
                    // Stop polling - user has been admitted
                    this._admitAllPollingActive = false;
                    if (this._admitAllTimeout) {
                      clearTimeout(this._admitAllTimeout);
                      this._admitAllTimeout = null;
                    }
                    return; // Exit polling loop
                  } else {
                    this.logger.info('"Admit" button still visible - may need to admit more users');
                  }
                  
                  break;
                }
              } catch (e) {
                // Try next selector
                continue;
              }
            }
            
            if (!confirmed) {
              this.logger.info('Confirmation modal button not found - modal may have auto-closed or not appeared');
            }
          } catch (e) {
            this.logger.info('Error waiting for/clicking confirmation modal', {
              error: e.message
            });
          }
        } else {
          this.logger.info('"Admit" button not found yet - will retry in 5 seconds');
        }
      } catch (e) {
        this.logger.warn('Error checking/clicking "Admit all" button', {
          error: e.message,
          stack: e.stack,
        });
      }
      
      // Schedule next poll only if polling is still active and user hasn't been admitted
      if (this._admitAllPollingActive && !this._userAdmitted) {
        this._admitAllTimeout = setTimeout(pollOnce, 5000);
      }
    };
    
    // Start polling immediately (non-blocking - don't await)
    // Use setTimeout with 0 delay to ensure it runs after current execution completes
    setTimeout(() => {
      pollOnce().catch(err => {
        this.logger.warn('Error in polling', { error: err.message });
        // Schedule next poll even if there was an error (unless polling was stopped)
        if (this._admitAllPollingActive && !this._userAdmitted) {
          this._admitAllTimeout = setTimeout(pollOnce, 5000);
        }
      });
    }, 0);
    
    this.logger.info('_startAdmitAllPolling: Polling started (non-blocking), will poll every 5 seconds until user is admitted');
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

  async cleanup() {
    // Stop the admit all polling if it's running
    this.logger.info('Stopping admit all polling');
    this._admitAllPollingActive = false;
    
    // Clear timeout (using setTimeout instead of setInterval)
    if (this._admitAllTimeout) {
      clearTimeout(this._admitAllTimeout);
      this._admitAllTimeout = null;
    }
    
    // Legacy: Clear interval if it exists (for backward compatibility)
    if (this._admitAllInterval) {
      clearInterval(this._admitAllInterval);
      this._admitAllInterval = null;
    }
    
    // Check if page is closed
    if (this.page && this.page.isClosed()) {
      this.logger.info('Polling stopped - page is closed');
    }
  }
}

module.exports = GoogleMeetController;
