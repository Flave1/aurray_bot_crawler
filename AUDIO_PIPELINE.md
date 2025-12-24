# Audio Pipeline Documentation

## Overview
The bot captures audio from meetings, sends it to OpenAI Realtime API, and injects AI responses back into the meeting. The system handles bidirectional audio at different sample rates with proper resampling, buffering, and platform-specific optimizations.

---

## Audio Input (Meeting → OpenAI)

### Flow
1. **Capture**: CDP WebRTC hooks capture audio from meeting at **48kHz**
2. **Resample**: Downsample from 48kHz → **24kHz** (OpenAI requirement)
3. **Encode**: Convert Float32 → PCM16 → Base64
4. **Send**: JSON message `{ type: "input_audio_buffer.append", audio: base64 }`

### Implementation Details

#### Audio Capture Setup (`setupAudioCapture`)
- Uses Chrome DevTools Protocol (CDP) to hook into WebRTC connections
- Creates AudioWorklet processor for capturing remote audio tracks
- Monitors RTCPeerConnection events to attach to new audio tracks
- Exposes `aurrayEmitAudioFrame` binding to receive audio frames from browser

**Key Components:**
- **AudioWorklet**: Processes audio in dedicated thread (`audio-worklet.js`)
- **CDP WebRTC Hooks**: Intercepts RTCPeerConnection to capture remote tracks
- **Track Attachment**: Automatically attaches to live audio tracks from meeting participants

#### Audio Frame Processing (`handleAudioFrame`)
1. Receives Float32Array samples at 48kHz from meeting
2. Resamples to 24kHz using linear interpolation (`resampleAudio`)
3. Converts Float32 → PCM16 Int16Array (`float32ToPCM16`)
4. Encodes to Base64 string
5. Sends via WebSocket: `{ type: "input_audio_buffer.append", audio: base64 }`

**Backpressure Handling:**
- Monitors `bufferedAmount` on WebSocket
- Adaptive throttling based on buffer level:
  - **> 512KB**: Stop sending completely
  - **> 384KB**: Drop 2 out of 3 frames (66% throttle)
  - **> 256KB**: Drop every other frame (50% throttle)
  - **> 128KB**: Drop 1 out of 3 frames (33% throttle)
  - **< 128KB**: Normal operation

**Key Functions:**
- `handleAudioFrame(frame)` - Processes captured audio frames
- `resampleAudio(samples, fromRate, toRate)` - Linear interpolation resampling
- `float32ToPCM16(float32Array)` - Converts to 16-bit PCM
- `arrayBufferToBase64(buffer)` - Encodes for transmission

---

## Audio Output (OpenAI → Meeting)

### Flow
1. **Receive**: Base64 audio chunks from OpenAI at **24kHz**
2. **Decode**: Base64 → ArrayBuffer → PCM16 Int16Array → Float32Array
3. **Resample**: Upsample from 24kHz → **48kHz** (meeting requirement)
4. **Queue**: Add to playback queue for sequential processing
5. **Inject**: Use `aurrayInjectAudio48k()` to inject into virtual microphone buffer

### Implementation Details

#### Message Handling (`handleOpenAIMessage`)
- Listens for `response.audio.delta` or `response.output_audio.delta` events
- Decodes base64 audio data to ArrayBuffer
- Calls `handleAudioChunk(buffer)` for processing

#### Audio Chunk Processing (`handleAudioChunk`)
1. Converts ArrayBuffer → PCM16 Int16Array → Float32Array (24kHz)
2. Resamples from 24kHz → 48kHz using linear interpolation
3. Converts Float32Array to regular Array for `page.evaluate()` serialization
4. Adds to `playbackQueue` instead of playing immediately
5. Triggers `playAudioQueue()` to process queue

**Queue Management:**
- `playbackQueue`: Array of audio chunks (Float32 samples at 48kHz)
- `MAX_QUEUE_SIZE`: Maximum queue size (prevents memory overflow)
- `shouldAcceptNewChunks`: Flag to prevent adding chunks after `response.audio.done`
- Queue overflow protection: Drops oldest chunks if queue is full

#### Playback Queue System (`playAudioQueue`)
**Purpose**: Ensures smooth playback by processing chunks sequentially, preventing jitter.

**How it works:**
1. Processes queue sequentially - one chunk at a time
2. Each chunk is injected via `playAudioToMeeting()` and awaited
3. Continues until queue is empty, even if `shouldAcceptNewChunks` is false
4. Prevents concurrent processing with `isPlayingQueue` flag
5. Clears queue on interruption (user speaks)

**State Management:**
- `isPlayingQueue`: Prevents concurrent queue processing
- `shouldAcceptNewChunks`: Controls whether new chunks are accepted
- `voiceState`: Tracks AI speaking state ("idle", "speaking", "recording")

**Interruption Handling:**
- When `response.interrupted` received: Clears queue immediately, stops accepting chunks
- When `response.audio.done` received: Stops accepting new chunks, lets queue finish

#### Audio Injection (`playAudioToMeeting`)
1. Calls `page.evaluate()` to inject samples into browser context
2. Executes `window.aurrayInjectAudio48k(samples)` in browser
3. Samples are added to virtual microphone buffer
4. Handles page-closed errors gracefully (silent return)

**Key Functions:**
- `handleAudioChunk(buffer)` - Processes OpenAI audio chunks
- `pcm16ToFloat32(pcm16Array)` - Converts from 16-bit PCM
- `playAudioToMeeting(samples)` - Injects audio via virtual mic
- `playAudioQueue()` - Processes playback queue sequentially

---

## Virtual Microphone Setup

### Purpose
Inject AI audio into meeting as if it's coming from a microphone. The virtual mic appears as a valid audio input device to the meeting platform.

### Implementation (`setupVirtualMic`)

#### Core Components
1. **AudioContext**: Created at 48kHz sample rate
2. **ScriptProcessorNode**: Processes audio in 1024-sample chunks
3. **MediaStreamDestination**: Creates MediaStream from AudioContext
4. **Buffer**: Array-based buffer for audio samples
5. **getUserMedia Override**: Intercepts `navigator.mediaDevices.getUserMedia()` to return virtual stream

#### Audio Processing Loop
**ScriptProcessorNode `onaudioprocess` event:**
- Fires every ~21ms (1024 samples at 48kHz)
- Reads samples from buffer using `readIndex`
- Outputs samples to MediaStreamDestination
- Falls back to silent tone (20Hz, 0.0001 amplitude) if buffer is empty
- Performs buffer cleanup when `readIndex > CLEANUP_THRESHOLD` (5 seconds)

**Buffer Management:**
- `buffer`: Array of Float32 samples
- `readIndex`: Tracks consumption position
- `MAX_BUFFER_SIZE`: 480,000 samples (10 seconds max)
- `CLEANUP_THRESHOLD`: 240,000 samples (5 seconds)
- Overflow protection: Drops oldest samples if buffer exceeds max size

#### Injection Function (`aurrayInjectAudio48k`)
- Receives Float32Array samples at 48kHz
- Checks AudioContext state (resumes if suspended)
- Prevents buffer overflow (drops oldest samples if needed)
- Pushes samples to buffer array

#### Platform-Specific Optimizations

**Windows-Specific Fixes:**
1. **Hidden Stream Consumer**: Creates silent AudioContext that consumes MediaStreamDestination stream
   - Ensures ScriptProcessorNode processes on Windows
   - On Windows, if stream isn't actively consumed, `onaudioprocess` may not fire
   - Consumer is silent (gain = 0) and only keeps stream active

2. **AudioContext State Monitoring**: 
   - Auto-resumes if suspended (Windows autoplay policies)
   - `onstatechange` listener monitors state changes
   - Immediate resume check in injection function

3. **Buffer Reuse**: 
   - Detects if virtual mic was created inline (in `getUserMedia`)
   - Reuses existing buffer instead of creating duplicate
   - Prevents buffer mismatch between injection and consumption

**Teams-Specific Configuration:**
- Overrides `getSettings()` to return device info Teams expects
- Overrides `getCapabilities()` to return proper capabilities
- Sets `deviceId: 'default'` for compatibility

#### Inline Initialization
**When**: If `getUserMedia()` is called before `setupVirtualMic()` runs (Windows timing issue)

**How it works:**
1. `getUserMedia` hook detects missing virtual stream
2. Creates AudioContext, ScriptProcessorNode, and MediaStreamDestination inline
3. Stores buffer reference in `window.__aurrayInlineBuffer`
4. When `setupVirtualMic()` runs later, detects existing buffer and reuses it
5. Updates `window.aurrayInjectAudio48k` to use existing buffer

**Key Variables:**
- `window.__aurrayInlineBuffer`: Reference to inline buffer
- `window.__aurrayInlineReadIndex`: Read index for inline buffer
- `window.__aurrayInlineTotalSamplesInjected`: Injection counter

#### getUserMedia Override
- Intercepts `navigator.mediaDevices.getUserMedia()` calls
- Returns virtual stream when audio is requested
- Handles video-only requests (returns real video + virtual audio)
- Platform detection (Teams vs Google Meet)

---

## Sample Rates

- **Meeting**: 48kHz (standard for video conferencing)
- **OpenAI**: 24kHz (Realtime API requirement)
- **Conversion**: Linear interpolation for resampling

**Resampling Algorithm:**
- Linear interpolation between samples
- Handles both upsampling (24kHz → 48kHz) and downsampling (48kHz → 24kHz)
- Maintains audio quality with minimal artifacts

---

## Message Protocol

### To OpenAI
```json
{
  "type": "input_audio_buffer.append",
  "audio": "base64_encoded_pcm16_audio"
}
```

### From OpenAI
```json
{
  "type": "response.audio.delta",
  "delta": "base64_encoded_pcm16_audio"
}
```

**Response Events:**
- `response.audio.delta`: Audio chunk (24kHz PCM16)
- `response.audio.done`: Audio response complete
- `response.interrupted`: User started speaking, AI interrupted
- `response.created`: New response started
- `response.output_audio.delta`: Alternative audio chunk event
- `response.output_audio.done`: Alternative done event

---

## VAD & Interruption

- **Server-side VAD**: OpenAI detects speech automatically
- **Interruption**: OpenAI automatically stops when user speaks
- **Events**: 
  - `input_audio_buffer.speech_started`: User started speaking
  - `input_audio_buffer.speech_stopped`: User stopped speaking
  - `response.interrupted`: AI response was interrupted

**Interruption Handling:**
- When `response.interrupted` received:
  - Clears playback queue immediately
  - Stops accepting new chunks
  - Sets `voiceState` to "recording"
  - Resets `isPlayingQueue` flag

---

## Audio Jitter Fixes

### Problem
Audio jitter (stuttering/choppy playback) was occurring due to:
1. No buffering/smoothing: Chunks were injected immediately without queueing
2. Timing desynchronization: ScriptProcessorNode reads at fixed intervals while injection is async
3. Buffer underruns: Delays in chunk arrival could empty buffer, causing silence/tone
4. No rate limiting: Multiple chunks could be injected rapidly without coordination
5. `page.evaluate()` overhead: Each injection requires round-trip to browser context

### Solution: Playback Queue System (IMPLEMENTED)

**Status**: ✅ Currently implemented and working

**Implementation:**
- Added `playbackQueue` array to buffer audio chunks
- Added `isPlayingQueue` flag to prevent concurrent processing
- Added `shouldAcceptNewChunks` flag to prevent cut-off issues
- Modified `handleAudioChunk()` to add chunks to queue instead of playing immediately
- Created `playAudioQueue()` function that processes queue sequentially
- Each chunk is injected and awaited before processing the next

**How it works:**
1. Audio chunks arrive → added to `playbackQueue`
2. `playAudioQueue()` processes queue sequentially
3. Each chunk is injected and awaited before next chunk
4. When `response.audio.done` arrives, stops accepting new chunks but lets queue finish
5. When `response.interrupted` arrives, clears queue immediately

**Expected Result**: Smooth playback even if chunks arrive at irregular intervals

**Comparison with Voice Agent:**
- **Voice Agent (Smooth)**: Uses queue-based playback, sequential processing with `await source.onended`, direct AudioContext
- **Browser Bot (Before Fix)**: No queue, asynchronous injection, buffer-based with ScriptProcessorNode
- **Browser Bot (After Fix)**: Queue-based playback (similar to voice agent), sequential processing with await, still uses ScriptProcessorNode but with queue smoothing

### Additional Optimizations

**Buffer Overflow Protection:**
- Maximum buffer size: 10 seconds (480,000 samples at 48kHz)
- Drops oldest samples if buffer exceeds max size
- Prevents memory leaks in long meetings

**Queue Overflow Protection:**
- Maximum queue size: `MAX_QUEUE_SIZE`
- Drops oldest chunks if queue is full
- Prevents memory overflow from rapid chunk arrival

**Efficient Buffer Cleanup:**
- Only cleans up when significant data consumed (5 seconds)
- Uses `splice()` to remove consumed samples
- Prevents memory growth over time

---

## Critical Implementation Notes

1. **Buffer Management**: Virtual mic uses array buffer, read index tracks consumption
2. **Timing**: Audio must be injected continuously to avoid gaps
3. **Error Handling**: Falls back to silent tone if buffer underruns
4. **Re-initialization**: Virtual mic must be re-setup after page navigation
5. **Platform Differences**: Windows requires hidden stream consumer and AudioContext state monitoring
6. **Timing Issues**: Inline initialization handles cases where `getUserMedia` is called before `setupVirtualMic`
7. **Queue System**: Ensures smooth playback by processing chunks sequentially
8. **Interruption**: Queue is cleared immediately when user speaks
9. **Backpressure**: Adaptive throttling prevents WebSocket buffer overflow
10. **Serialization**: Float32Array must be converted to regular Array for `page.evaluate()`

---

## File Structure

**Key Files:**
- `bot_entry_v2.js`: Main bot implementation
  - `setupAudioCapture()`: Audio input setup
  - `handleAudioFrame()`: Processes captured audio
  - `setupVirtualMic()`: Virtual microphone setup
  - `handleAudioChunk()`: Processes OpenAI audio
  - `playAudioQueue()`: Playback queue processing
  - `playAudioToMeeting()`: Audio injection
- `audio-worklet.js`: AudioWorklet processor for capture

**Key Functions:**
- `resampleAudio()`: Linear interpolation resampling
- `float32ToPCM16()`: Float32 to PCM16 conversion
- `pcm16ToFloat32()`: PCM16 to Float32 conversion
- `arrayBufferToBase64()`: Base64 encoding
- `base64ToArrayBuffer()`: Base64 decoding

---

## Platform-Specific Behavior

### Windows
- Requires hidden stream consumer to keep MediaStreamDestination active
- AudioContext can become suspended due to autoplay policies (auto-resumed)
- Inline initialization may occur before `setupVirtualMic()` runs
- Buffer reuse ensures correct buffer is used for injection

### Mac
- Virtual mic typically initialized before `getUserMedia()` is called
- Less aggressive autoplay policies
- No hidden stream consumer needed

### Teams
- Requires track configuration overrides (`getSettings`, `getCapabilities`)
- Uses data URL for AudioWorklet (CSP compliance)
- Device ID must be set to 'default'

### Google Meet
- Standard virtual mic setup
- Uses blob URL for AudioWorklet
- Less strict device requirements

---

## Troubleshooting

**Audio not playing:**
- Check AudioContext state (should be "running")
- Verify MediaStreamDestination is being consumed (Windows)
- Check if buffer has samples (`buffer.length > 0`)
- Verify `window.aurrayInjectAudio48k` function exists
- Check if virtual stream is returned by `getUserMedia`

**Audio jitter:**
- Check playback queue size
- Verify chunks are being processed sequentially
- Check for buffer underruns (buffer empty when `onaudioprocess` fires)
- Monitor WebSocket backpressure

**Audio not capturing:**
- Verify CDP WebRTC hooks are enabled
- Check if AudioWorklet is loaded
- Verify remote tracks are being attached
- Check for CSP issues (Teams requires data URL)
