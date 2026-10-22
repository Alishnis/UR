"""Camera vision for Missions 2.1, 2.2, 3 and 5: AprilTags, the dark line, coloured objects.

Detection is stateless: every function takes one frame (a JPEG from the browser) plus parameters and
returns plain JSON-ready data. All mission state (confirmed tags, checkpoint count, pole order, timers)
lives in the browser. Vision is display-only assistance: nothing here talks to the ESP32.

    frames.py   binary message layout, JPEG decoding, small helpers
    tags.py     tag36h11 detection + optional pose (mode "tags")
    line.py     dark line + white tapes on the pool floor (mode "line")
    colors.py   HSV colour blobs, e.g. the red / yellow / blue poles (mode "colors")
    process.py  process_frame / process_message: dispatch, timing, errors (never raises)

The message format is in docs/PROTOCOL.md ("Vision WebSocket").
"""
