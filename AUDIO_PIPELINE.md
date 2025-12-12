# Audio Pipeline Documentation

## Overview
The bot captures audio from meetings, sends it to OpenAI Realtime API, and injects AI responses back into the meeting.

## Audio Input (Meeting → OpenAI)

**Flow:**
1. **Capture**: CDP WebRTC hooks capture audio from meeting at **48kHz**
2. **Resample**: Downsample from 48kHz → **24kHz** (OpenAI requirement)
3. **Encode**: Convert Float32 → PCM16 → Base64
4. **Send**: JSON message `{ type: "input_audio_buffer.append", audio: base64 }`

**Key Functions:**
- `handleAudioFrame(frame)` - Processes captured audio frames
- `resampleAudio(samples, fromRate, toRate)` - Linear interpolation resampling
- `float32ToPCM16(float32Array)` - Converts to 16-bit PCM

## Audio Output (OpenAI → Meeting)

**Flow:**
1. **Receive**: Base64 audio chunks from OpenAI at **24kHz**
2. **Decode**: Base64 → PCM16 → Float32
3. **Resample**: Upsample from 24kHz → **48kHz** (meeting requirement)
4. **Inject**: Use `aurrayInjectAudio48k()` to inject into virtual microphone

**Key Functions:**
- `handleAudioChunk(buffer)` - Processes OpenAI audio chunks
- `pcm16ToFloat32(pcm16Array)` - Converts from 16-bit PCM
- `playAudioToMeeting(samples)` - Injects audio via virtual mic

## Virtual Microphone Setup

**Purpose**: Inject AI audio into meeting as if it's coming from a microphone.

**Implementation:**
1. Create AudioContext at 48kHz
2. Create MediaStreamDestination
3. Use ScriptProcessorNode to read from buffer
4. Intercept `getUserMedia()` to return virtual stream
5. `aurrayInjectAudio48k(samples)` writes to buffer

**Key Points:**
- Must be initialized on the meeting page (not login page)
- Buffer is read by ScriptProcessorNode's `onaudioprocess` event
- Falls back to silent tone if buffer is empty

## Sample Rates

- **Meeting**: 48kHz (standard for video conferencing)
- **OpenAI**: 24kHz (Realtime API requirement)
- **Conversion**: Linear interpolation for resampling

## Message Protocol

**To OpenAI:**
```json
{
  "type": "input_audio_buffer.append",
  "audio": "base64_encoded_pcm16_audio"
}
```

**From OpenAI:**
```json
{
  "type": "response.audio.delta",
  "delta": "base64_encoded_pcm16_audio"
}
```

## VAD & Interruption

- **Server-side VAD**: OpenAI detects speech automatically
- **Interruption**: OpenAI automatically stops when user speaks
- **Events**: `input_audio_buffer.speech_started`, `input_audio_buffer.speech_stopped`

## Critical Implementation Notes

1. **Buffer Management**: Virtual mic uses array buffer, read index tracks consumption
2. **Timing**: Audio must be injected continuously to avoid gaps
3. **Error Handling**: Falls back to silent tone if buffer underruns
4. **Re-initialization**: Virtual mic must be re-setup after page navigation

