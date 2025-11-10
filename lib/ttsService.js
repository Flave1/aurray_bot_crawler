/**
 * TTS Service for converting text to speech
 * Supports OpenAI TTS API and ElevenLabs streaming API
 */

const axios = require('axios');
const { Readable } = require('stream');

class TTSService {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.provider = config.ttsProvider;
    this.apiKey = config.ttsApiKey;
    this.voice = config.ttsVoice;
    this.speed = config.ttsSpeed;
    this.pitch = config.ttsPitch;
    this.gain = config.ttsGain;
  }

  /**
   * Strip formatting annotations from text like [sarcastically], [whispers], etc.
   */
  stripAnnotations(text) {
    return text.replace(/\[.*?\]/g, '').trim();
  }

  /**
   * Convert text to speech and return encoded audio payload
   * @param {string} text - Text to convert to speech
   * @returns {Promise<{type: string, data: ArrayBuffer | Buffer, provider: string}>}
   */
  async textToSpeechStream(text) {
    const cleanText = this.stripAnnotations(text);
    this.logger.info('Converting text to speech', { provider: this.provider, length: cleanText.length });

    if (this.provider === 'openai') {
      return this.textToSpeechOpenAI(cleanText);
    } else if (this.provider === 'elevenlabs') {
      return this.textToSpeechElevenLabs(cleanText);
    } else {
      throw new Error(`Unsupported TTS provider: ${this.provider}`);
    }
  }

  /**
   * Convert text to speech using OpenAI TTS API
   */
  async textToSpeechOpenAI(text) {
    if (!this.apiKey) {
      throw new Error('OpenAI API key not configured');
    }

    try {
      const response = await axios.post(
        'https://api.openai.com/v1/audio/speech',
        {
          model: 'tts-1',
          voice: this.voice, // alloy, echo, fable, onyx, nova, shimmer
          input: text,
          speed: this.speed
        },
        {
          headers: {
            'Authorization': `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json'
          },
          responseType: 'arraybuffer',
          timeout: 30000
        }
      );

      const byteLength = response.data.byteLength ?? response.data.length ?? null;
      this.logger.info('OpenAI TTS API call completed', { mp3Size: byteLength });

      // Return the MP3 buffer - decoding happens in browser
      return {
        provider: 'openai',
        type: 'mp3',
        data: response.data
      };
    } catch (error) {
      this.logger.error('OpenAI TTS failed', { error: error.message });
      throw error;
    }
  }

  /**
   * Convert text to speech using ElevenLabs streaming API
   */
  async textToSpeechElevenLabs(text) {
    if (!this.apiKey) {
      throw new Error('ElevenLabs API key not configured');
    }

    try {
      const response = await axios.post(
        `https://api.elevenlabs.io/v1/text-to-speech/${this.voice}`,
        {
          text: text,
          model_id: 'eleven_monolingual_v1',
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75,
            speed: this.speed
          }
        },
        {
          headers: {
            'xi-api-key': this.apiKey,
            'Content-Type': 'application/json'
          },
          responseType: 'arraybuffer',
          timeout: 30000
        }
      );

      const byteLength = response.data.byteLength ?? response.data.length ?? null;
      this.logger.info('ElevenLabs TTS completed', { mp3Size: byteLength });

      // Return the MP3 buffer - decoding happens in browser (same path as OpenAI)
      return {
        provider: 'elevenlabs',
        type: 'mp3',
        data: response.data
      };
    } catch (error) {
      this.logger.error('ElevenLabs TTS failed', { error: error.message });
      throw error;
    }
  }

  /**
   * Decode audio buffer (MP3/WAV) to PCM float32 samples
   * Note: Actual decoding happens in the browser using Web Audio API
   * This is a placeholder that should not be called
   */
  async decodeAudioBuffer(buffer) {
    throw new Error('decodeAudioBuffer should not be called - decoding happens in browser');
  }
}

module.exports = TTSService;
