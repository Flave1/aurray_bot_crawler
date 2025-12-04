const PlatformController = require("./base");

class GoogleMeetController extends PlatformController {
  static getBrowserArgs() {
    return [];
  }

  static getPermissionsOrigin(meetingUrl) {
    return "https://meet.google.com";
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
      const buttonText = await joinButton.textContent().catch(() => "");
      this.logger.info("Clicked join button", { buttonText });
      // Store if we clicked "Ask to join" to detect waiting state later
      this.clickedAskToJoin = buttonText.toLowerCase().includes("ask to join");
    } else {
      return false;
      // throw new Error('Join button not found');
    }
  }

  async ensureJoined() {
    // Check if we're waiting for admission - only send if isOrganizer config is set
    // (This means there's an organizer who needs to admit the bot)
    if (this.clickedAskToJoin && this.config.sendStatusUpdate) {
      // Look for waiting/admission indicators in Google Meet
      const waitingSelectors = [
        'text="Waiting to be let in"',
        'text="Waiting for the host to let you in"',
        '[aria-label*="waiting"]',
        '[aria-label*="Waiting"]',
      ];

      // Check if we're in waiting state
      let isWaiting = false;
      for (const selector of waitingSelectors) {
        try {
          const waitingElement = await this.page.locator(selector).first();
          if (
            await waitingElement.isVisible({ timeout: 3000 }).catch(() => false)
          ) {
            isWaiting = true;
            this.logger.info("Detected waiting for admission state");
            break;
          }
        } catch (e) {
          // Continue checking other selectors
        }
      }

      // Send status if waiting state detected
      if (isWaiting) {
        await this.config.sendStatusUpdate(
          "waiting_for_host",
          "Waiting to be admitted into the meeting",
          { platform: this.config.platform }
        );
      }
    }

    await this.page.waitForSelector('button[aria-label*="Leave call"]', {
      timeout: 30000,
    });
    this.logger.info("Meeting joined - Leave call button visible");
  }

  async afterJoin() {

    // Check if bot is organizer and has status update capability
    const isOrganizer = this.config.isOrganizer === true || this.config.isOrganizer === "true";
    if (isOrganizer && this.config.sendStatusUpdate) {
      this.logger.info("Bot is organizer - setting up auto-admit functionality");

      const peopleButton = await this.page.locator('button[aria-label^="People -"][aria-label*="joined"]').first();
      if (await peopleButton.isVisible({ timeout: 3000 }).catch(() => false)) {
        const isExpanded = await peopleButton.getAttribute('aria-expanded');
        this.logger.info('People button state', { ariaExpanded: isExpanded });
        
        let panelIsOpen = false;
        
        // Check if panel is already open
        if (isExpanded === 'true') {
          this.logger.info('People panel is already open, starting admit polling');
          panelIsOpen = true;
        } else {
          // Open panel if not already open
          await peopleButton.click();
          this.logger.info('Clicked "People" button to open participants panel');
          // Wait for panel to fully open
          await this.page.waitForTimeout(1500);
          // Verify it opened
          const expandedAfter = await peopleButton.getAttribute('aria-expanded');
          if (expandedAfter === 'true') {
            this.logger.info('People panel opened successfully, starting admit polling');
            panelIsOpen = true;
          } else {
            this.logger.warn('People panel may not have opened, aria-expanded:', expandedAfter);
          }
        }
        
        // Only start polling if panel is confirmed open
        if (panelIsOpen) {
          this.logger.info('Starting polling for "Admit all" button');
          this._startAdmitAllPolling();
        } else {
          this.logger.warn('Cannot start admit polling - People panel is not open');
        }
      } else {
        this.logger.warn('"People" button not found or not visible');
      }
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

  _startAdmitAllPolling() {
    // Poll every 5 seconds for "Admit all" button and click it when found
    this.logger.info('_startAdmitAllPolling: Starting interval for polling "Admit all" button');
    this._admitAllPollCount = 0;
    this._admitAllPollingActive = true;
    
    // Poll immediately first
    const pollOnce = async () => {
        // Check if polling should stop (cleanup was called)
        if (!this._admitAllPollingActive) {
          this.logger.info('Polling stopped - cleanup was called');
          throw new Error('Polling stopped - cleanup was called');
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
                    if (this.config.sendStatusUpdate) {
                      await this.config.sendStatusUpdate(
                        "waiting_to_admit",
                        "I have admitted you into the meeting",
                        { platform: this.config.platform }
                      );
                    }
                    await this.page.waitForTimeout(1000);
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
    };
    
    // Poll immediately, then set up interval
    pollOnce().catch(err => {
      this.logger.warn('Error in initial poll', { error: err.message });
    });
    
    this._admitAllInterval = setInterval(pollOnce, 5000);
    this.logger.info('_startAdmitAllPolling: Interval set up, will poll every 5 seconds');
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
    // Stop the admit all polling interval if it's running
    this.logger.info('Stopping admit all polling');
    this._admitAllPollingActive = false;
    
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
