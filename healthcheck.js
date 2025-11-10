/**
 * Health check script for browser bot container
 */

const axios = require('axios');

const config = {
  apiBaseUrl: process.env.API_BASE_URL,
  meetingId: process.env.MEETING_ID || 'test-meeting',
  sessionId: process.env.SESSION_ID || 'test-session'
};

async function healthCheck() {
  try {
    // Check if the bot can reach the API
    const response = await axios.get(`${config.apiBaseUrl}/health`, { timeout: 5000 });
    
    if (response.status === 200) {
      console.log('Health check passed');
      process.exit(0);
    } else {
      console.log('Health check failed: API returned non-200 status');
      process.exit(1);
    }
  } catch (error) {
    console.log('Health check failed:', error.message);
    process.exit(1);
  }
}

// Run health check
healthCheck();
