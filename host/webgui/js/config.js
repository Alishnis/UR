// GUI settings. Hardware values marked MEASURE are guesses until checked on the real ROV.

// The bridge passes its ports in the page address when they are not the defaults (python -m bridge --ws-port ...)
const query = typeof location === "undefined" ? new URLSearchParams() : new URLSearchParams(location.search);

export const Config = {
    // Bridge (python -m bridge, run from host/)
    wsUrl: `ws://localhost:${query.get("ws") || 8765}`,          // control: lines to / from the ESP32
    visionUrl: `ws://localhost:${query.get("vision") || 8766}`,  // AprilTag service

    // Control (docs/PROTOCOL.md). Commands go out continuously: the firmware watchdog stops the thrusters
    // if nothing arrives for 500 ms.
    commandRateHz: 20,
    maxThrottle: 0.3,        // start value of the MAX slider, fraction of the full ESC range (0.3 = +-150 us)
    maxThrottleLimit: 0.6,   // the slider cannot go above this
    rampPerSec: 1.5,         // how fast a command may change (never jump to high throttle)
    magnitudeStart: 0.5,     // J / K throttle within MAX

    // Which firmware output each thruster is plugged into: slot 0 = GPIO 4, 1 = GPIO 5, 2 = GPIO 6 (the order of
    // the D line and of ESC_PINS in src/main.cpp). MEASURE with the THRUSTER TEST buttons: if "L +" spins the
    // right motor, swap the numbers here - no rewiring, no reflashing.
    outputSlot: { left: 0, right: 1, vert: 2 },
    slotPins: [4, 5, 6],  // labels only, must match ESC_PINS in the firmware

    // Per thruster: invert if it pushes the wrong way, gain to balance left/right, deadBand = smallest command
    // that actually spins the motor (MEASURE with the test sketch: e.g. starts at 1550 us -> 50/500 = 0.1).
    thrusters: {
        left:  { invert: false, gain: 1.0, deadBand: 0.0 },
        right: { invert: false, gain: 1.0, deadBand: 0.0 },
        vert:  { invert: false, gain: 1.0, deadBand: 0.0 },  // + = up
    },

    // Camera (the ROV camera is 720p)
    cameraWidth: 1280,
    cameraHeight: 720,

    // AprilTag: frames sent to the bridge (one at a time, never queued)
    detectionHz: 8,
    detectionWidth: 1280,
    jpegQuality: 0.85,
};
