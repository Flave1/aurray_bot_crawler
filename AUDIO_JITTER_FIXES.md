# Audio Jitter Fix Options

This document outlines all potential solutions for fixing audio jitter in the browser bot's audio playback system.

## Problem
The browser bot experiences audio jitter (stuttering/choppy playback) while speaking, unlike the voice agent client which plays audio smoothly.

## Root Causes Identified
1. **No buffering/smoothing**: Chunks are injected immediately without queueing
2. **Timing desynchronization**: ScriptProcessorNode reads at fixed intervals while injection is async
3. **Buffer underruns**: Delays in chunk arrival can empty buffer, causing silence/tone
4. **No rate limiting**: Multiple chunks can be injected rapidly without coordination
5. **`page.evaluate()` overhead**: Each injection requires round-trip to browser context

---

## Solution Options

### ✅ Priority 1: Playback Queue System (IMPLEMENTED - Testing)
**Status**: Currently implemented and being tested

**Implementation**:
- Added `playbackQueue` array to buffer audio chunks
- Added `isPlayingQueue` flag to prevent concurrent processing
- Added `shouldAcceptNewChunks` flag to prevent cut-off issues
- Modified `handleAudioChunk()` to add chunks to queue instead of playing immediately
- Created `playAudioQueue()` function that processes queue sequentially
- Each chunk is injected and awaited before processing the next

**How it works**:
1. Audio chunks arrive → added to `playbackQueue`
2. `playAudioQueue()` processes queue sequentially
3. Each chunk is injected and awaited before next chunk
4. When `response.audio.done` arrives, stops accepting new chunks but lets queue finish

**Expected Result**: Smooth playback even if chunks arrive at irregular intervals

**Files Modified**:
- `browser_bot/bot_entry_v2.js`

---

### Priority 2: Minimum Buffer Threshold
**Status**: Pending

**Implementation**:
- Before starting playback, ensure buffer has minimum samples (e.g., 4800 samples = 100ms at 48kHz)
- Only start reading from buffer once threshold is met
- This prevents initial underruns and provides smoother startup

**Expected Result**: Prevents initial jitter and provides smoother startup

**Files to Modify**:
- `browser_bot/bot_entry_v2.js` (virtual mic setup)

---

### Priority 3: Synchronize Injection with ScriptProcessorNode Timing
**Status**: Pending

**Implementation**:
- Instead of injecting immediately, batch chunks and inject them in sync with ScriptProcessorNode intervals (every ~21ms for 1024 samples)
- Calculate optimal injection timing based on buffer consumption rate
- Align injection with the fixed-interval consumption pattern

**Expected Result**: Reduces timing mismatch between injection and consumption

**Files to Modify**:
- `browser_bot/bot_entry_v2.js` (playAudioToMeeting and virtual mic setup)

---

### Priority 4: Rate Limiting/Throttling for Chunk Injection
**Status**: Pending

**Implementation**:
- Limit how frequently chunks can be injected (e.g., max 1 injection per 10ms)
- Queue chunks if they arrive too fast
- Maintain steady injection rate to prevent overwhelming the buffer

**Expected Result**: Prevents overwhelming buffer and maintains steady injection rate

**Files to Modify**:
- `browser_bot/bot_entry_v2.js` (handleAudioChunk and playAudioToMeeting)

---

### Priority 5: Buffer Monitoring and Adaptive Timing
**Status**: Pending

**Implementation**:
- Monitor buffer fill level in ScriptProcessorNode
- If buffer gets too low (< 1000 samples): slow down consumption
- If buffer gets too high (> 10000 samples): speed up consumption
- Adapt to network timing variations dynamically

**Expected Result**: Adapts to network timing variations and prevents underruns/overruns

**Files to Modify**:
- `browser_bot/bot_entry_v2.js` (virtual mic setup - ScriptProcessorNode)

---

### Priority 6: Replace ScriptProcessorNode with AudioWorklet
**Status**: Pending

**Implementation**:
- Migrate from deprecated ScriptProcessorNode to AudioWorklet
- Create AudioWorklet processor module
- Update virtual mic setup to use AudioWorklet instead
- More reliable, lower-latency audio processing

**Expected Result**: More reliable, lower-latency audio processing

**Files to Modify**:
- `browser_bot/bot_entry_v2.js` (virtual mic setup)
- Create new `browser_bot/audio-worklet-processor.js` file

---

## Testing Strategy

1. **Test Priority 1** (Current)
   - If it fixes jitter completely → Stop
   - If it partially fixes but still has issues → Remove and test Priority 2
   - If it doesn't help → Remove and test Priority 2

2. **Test Priority 2** (If Priority 1 doesn't fully fix)
   - If it fixes jitter → Stop
   - If not → Remove and test Priority 3

3. Continue with remaining priorities in order until jitter is resolved

---

## Notes

- Priority 1 is currently implemented and being tested
- Each solution can be tested independently
- Solutions can potentially be combined if needed
- ScriptProcessorNode is deprecated but still functional - Priority 6 would modernize the approach

---

## Comparison with Voice Agent

**Voice Agent (Smooth)**:
- Uses queue-based playback (`playbackQueueRef`)
- Sequential playback with `await source.onended`
- Direct AudioContext (no ScriptProcessorNode)
- No async overhead from `page.evaluate()`

**Browser Bot (Jittery - Before Priority 1)**:
- No queue - direct injection
- Asynchronous injection via `page.evaluate()`
- Buffer-based with ScriptProcessorNode
- Timing mismatch between injection and consumption

**Browser Bot (After Priority 1)**:
- Queue-based playback (similar to voice agent)
- Sequential processing with await
- Still uses ScriptProcessorNode (but with queue smoothing)
- Still has `page.evaluate()` overhead (but mitigated by queue)

