/**
 * Mock LLM Service for simulating text responses
 * In production, this would connect to a real LLM API
 */

const axios = require('axios');

class MockLLMService {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
  }

  /**
   * Get a text response from the LLM (mocked)
   * @param {string} prompt - User prompt or meeting context
   * @returns {Promise<string>} LLM text response
   */
  async getResponse(prompt = '') {
    // If a mock URL is configured, use it
    if (this.config.llmMockUrl) {
      try {
        const response = await axios.post(this.config.llmMockUrl, { prompt }, { timeout: 10000 });
        return response.data.text || response.data.response || '';
      } catch (error) {
        this.logger.warn('Mock LLM API failed, using default', { error: error.message });
      }
    }

    // Simple default response
    return "Hello everyone. I'm Clerk AI Bot, here to assist with this meeting.";
  }
}

module.exports = MockLLMService;

