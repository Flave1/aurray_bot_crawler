# Audio Capture Attempts - Summary

This document lists all the options attempted to capture remote participant audio from Google Meet.

## Options Tried (All Failed)

### Option 1: Intercept MediaStreamTrack.prototype.addEventListener
**Status:** ❌ Failed - No remote tracks detected, caused crashes
**Description:** Intercepted when event listeners are added to MediaStreamTrack objects to catch remote audio tracks when Google Meet adds listeners to them.
**Result:** `sourcesCount: 0` - No remote tracks detected. Caused browser crashes.

### Option 2: Intercept AudioContext.prototype.createMediaStreamSource
**Status:** ❌ Failed - Only detected local track
**Description:** Intercepted when Google Meet creates audio sources from MediaStreams to catch remote tracks.
**Result:** Only detected local MacBook microphone track. No remote participant tracks detected.

### Option 3: Intercept MediaStream constructor
**Status:** ❌ Failed - No remote tracks detected
**Description:** Intercepted MediaStream constructor to catch all stream creation, including remote audio streams.
**Result:** `sourcesCount: 0` - No remote tracks detected.

### Option 4: Expand RTCRtpReceiver interception
**Status:** ❌ Failed - No remote tracks detected
**Description:** Intercepted multiple RTCRtpReceiver methods (getSynchronizationSources, getContributingSources, getStats) to detect remote audio.
**Result:** `sourcesCount: 0` - No remote tracks detected.

### Option 5: Intercept EventTarget.prototype.addEventListener globally
**Status:** ❌ Failed - Caused crashes
**Description:** Intercepted EventTarget.prototype.addEventListener globally to catch all track events on RTCPeerConnection and MediaStream.
**Result:** Caused `RESULT_CODE_KILLED_BAD_MESSAGE` browser crashes.

### Option 6: Check iframes - access contentWindow
**Status:** ❌ Failed - Caused crashes
**Description:** Attempted to access contentWindow of all iframes to find RTCPeerConnections that might be in iframe contexts.
**Result:** Caused `RESULT_CODE_KILLED_BAD_MESSAGE` browser crashes (even with extensive error handling).

### Option 7: Intercept MediaStreamTrack.clone() method
**Status:** ❌ Failed - No remote tracks detected
**Description:** Intercepted MediaStreamTrack.clone() to catch when Google Meet clones remote tracks.
**Result:** `sourcesCount: 0` - No remote tracks detected.

### Option 8: More aggressive polling - check window.parent, document.defaultView
**Status:** ❌ Failed - Caused crashes
**Description:** Attempted safer window polling with extensive error handling to find RTCPeerConnections in window object.
**Result:** Caused `RESULT_CODE_KILLED_BAD_MESSAGE` browser crashes.

### Option 9: Intercept MediaStreamTrack.getSettings() and getCapabilities()
**Status:** ❌ Failed - Caused crashes
**Description:** Intercepted getSettings() and getCapabilities() methods to detect remote tracks when Google Meet queries their properties.
**Result:** Caused `RESULT_CODE_KILLED_BAD_MESSAGE` browser crashes.

### Option 10: Use Performance API to detect WebRTC activity
**Status:** ❌ Failed - Caused crashes
**Description:** Used PerformanceObserver and Performance API to detect WebRTC activity and track creation.
**Result:** Caused `RESULT_CODE_KILLED_BAD_MESSAGE` browser crashes.

## Root Cause Analysis

### Why All Options Failed:

1. **RTCPeerConnections are not accessible**
   - Constructor interception fails (not extensible)
   - Window polling causes crashes
   - Iframe access causes crashes
   - Result: `connectionsCount: 0` - We never find any RTCPeerConnections

2. **Remote tracks are not exposed through standard APIs**
   - Option 2 only detected local MacBook mic
   - Remote participant tracks don't appear in intercepted methods
   - Result: `sourcesCount: 0` - No remote tracks detected

3. **Google Meet isolates WebRTC**
   - RTCPeerConnections are likely created in:
     - Different security context (cross-origin iframe)
     - Web Worker
     - Protected scope we can't access
   - This prevents standard interception

### What Works:
- ✅ AudioWorklet initializes successfully
- ✅ Virtual microphone setup works
- ✅ Local track detection works (we see MacBook mic)
- ✅ The hooking function works when given a connection
- ✅ Browser is stable when audio capture is disabled

### What Doesn't Work:
- ❌ Finding RTCPeerConnection instances automatically
- ❌ Intercepting at the right level
- ❌ Accessing remote audio tracks from page context

## CDP-Based Approaches Tried

### Option 11: CDP Runtime.addBinding
**Status:** ❌ Failed - No remote tracks detected
**Description:** Used Playwright CDP Runtime.addBinding to expose functions to the page context for audio capture.
**Result:** No crashes, but still `sourcesCount: 0` - No remote tracks detected.

### Option 12: CDP WebRTC.enable
**Status:** ❌ Failed - Not available
**Description:** Attempted to use CDP WebRTC domain to access WebRTC internals.
**Result:** Protocol error - `'WebRTC.enable' wasn't found` - Not supported in this Chromium version.

### Option 13: CDP Runtime.evaluate to find RTCPeerConnections
**Status:** ❌ Failed - Found 0 connections
**Description:** Used CDP Runtime.evaluate to search window object for RTCPeerConnection instances.
**Result:** `found: 0` - RTCPeerConnections are not stored on window object (likely in closures).

### Option 14: CDP Target domain to access iframe contexts
**Status:** ❌ Failed - Found iframes but 0 connections
**Description:** Used CDP Target.getTargets to find all iframes and searched each iframe context for RTCPeerConnections.
**Result:** Found iframes (including Google feedback proxy), but `found: 0` RTCPeerConnections in all contexts.

## ✅ SOLUTION THAT WORKED

### Option 15: Audio Element Capture - Capture from `<audio>` elements
**Status:** ✅ **SUCCESS** - Working!
**Description:** Instead of trying to intercept WebRTC directly, we capture audio from the HTML5 `<audio>` elements that Google Meet uses to play remote participant audio. These elements have `srcObject` MediaStreams containing the remote audio tracks.

**Implementation:**
1. Search for all `<audio>` elements in the page and all iframes
2. Check if they have `srcObject` (MediaStream) and are playing
3. Extract audio tracks directly from `audio.srcObject.getAudioTracks()`
4. Use `forceAttach: true` to bypass deviceId check (tracks from audio elements are remote even if they have deviceId)
5. Attach tracks to AudioWorklet for capture

**Result:**
- ✅ Successfully capturing 3 audio tracks (one per participant)
- ✅ `sourcesCount: 3` 
- ✅ Audio frames being sent to backend (7,500+ frames, 630KB+ sent)
- ✅ RMS values showing audio activity (0.0001 to 0.0035)
- ✅ No crashes, stable operation

**Key Code Location:**
- `searchForAudioElements()` function in `bot_entry.js`
- Captures from `audio.srcObject` MediaStream directly
- Uses `window.aurrayAttachRemoteTrack(track, true)` with `forceAttach: true`

**Why This Works:**
- Google Meet uses `<audio>` elements to play remote participant audio
- These elements are accessible via standard DOM APIs
- The `srcObject` MediaStream contains the remote audio tracks
- We can extract and capture these tracks without needing to find RTCPeerConnections
