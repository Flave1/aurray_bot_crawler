#!/bin/bash
set -e

# Start Xvfb if DISPLAY is set and Xvfb is not already running
if [ -n "$DISPLAY" ] && ! pgrep -x "Xvfb" > /dev/null; then
    echo "Starting Xvfb on $DISPLAY..."
    Xvfb $DISPLAY -screen 0 1280x720x24 -ac +extension GLX +render -noreset &
    XVFB_PID=$!
    sleep 2  # Give Xvfb time to start
    
    # Cleanup function to kill Xvfb on exit
    trap "kill $XVFB_PID 2>/dev/null || true" EXIT
fi

# Execute the main command
exec "$@"

