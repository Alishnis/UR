"""Hold-to-run keyboard control for the esc_test firmware (../esc_test).

    .venv/bin/python -m tools.esc_keys [--port /dev/cu.usbmodemXXXX]

A small window opens; keep it focused.
  1 2 3   select motor (GPIO 1 / 42 / 40)
  W / S   hold = selected motor forward / backward, release = stop
  + -     raise / lower power by 10 us
  Space   stop everything

While W or S is held, 'w' / 's' is sent every 50 ms. The firmware stops the motor
if nothing arrives for 250 ms, so a crash, closed window or unplugged cable also stops it.
Close the bridge and the PlatformIO monitor first.
"""
import argparse
import glob
import time
import tkinter as tk

import serial

SEND_MS = 50
RELEASE_DEBOUNCE_MS = 60  # key auto-repeat can fire release+press pairs

# Physical keys work on the Russian layout too.
KEYS = {"w": "w", "ц": "w", "s": "s", "ы": "s",
        "1": "1", "2": "2", "3": "3",
        "plus": "+", "equal": "+", "minus": "-", "space": " "}


def find_port():
    ports = glob.glob("/dev/cu.usbmodem*") + glob.glob("/dev/cu.usbserial*")
    if not ports:
        raise SystemExit("ESP32 not found (no /dev/cu.usbmodem*). Check the cable.")
    return ports[0]


class App:
    def __init__(self, port):
        self.ser = serial.Serial(port, 115200, timeout=0)
        self.held = set()
        self.last_press = {}

        self.root = tk.Tk()
        self.root.title("ESC keys")
        self.status = tk.Label(self.root, font=("Menlo", 16), width=40, pady=8)
        self.status.pack()
        tk.Label(self.root, text="1 2 3 motor · hold W/S · + - power · Space stop",
                 font=("Menlo", 12)).pack()
        self.log = tk.Text(self.root, height=14, width=60, font=("Menlo", 11))
        self.log.pack(padx=8, pady=8)
        self.add_log(f"opened {port}; ESP32 may reboot and arm for ~4 s\n")

        self.root.bind("<KeyPress>", self.on_press)
        self.root.bind("<KeyRelease>", self.on_release)
        self.root.bind("<FocusOut>", lambda e: self.stop_all())
        self.root.protocol("WM_DELETE_WINDOW", self.close)
        self.tick()

    def add_log(self, text):
        self.log.insert("end", text)
        self.log.see("end")

    def send(self, ch):
        self.ser.write(ch.encode())

    def on_press(self, e):
        key = KEYS.get(e.keysym.lower())
        if key in ("w", "s"):
            self.held.add(key)
            self.last_press[key] = time.monotonic()
        elif key:
            if key == " ":
                self.stop_all()
            else:
                self.send(key)

    def on_release(self, e):
        key = KEYS.get(e.keysym.lower())
        if key not in ("w", "s"):
            return
        released_at = time.monotonic()

        def confirm():
            # A press after the release means auto-repeat, not a real release.
            if self.last_press.get(key, 0) <= released_at:
                self.held.discard(key)
                if not self.held:
                    self.send("0")

        self.root.after(RELEASE_DEBOUNCE_MS, confirm)

    def stop_all(self):
        self.held.clear()
        self.send("0")

    def tick(self):
        if self.held == {"w"}:
            self.send("w")
        elif self.held == {"s"}:
            self.send("s")
        elif self.held:  # both held: refuse, stop
            self.send("0")
        self.status.config(text={frozenset({"w"}): "FORWARD", frozenset({"s"}): "BACKWARD"}
                           .get(frozenset(self.held), "stopped"),
                           fg="red" if self.held else "gray")
        data = self.ser.read(1024)
        if data:
            self.add_log(data.decode(errors="replace"))
        self.root.after(SEND_MS, self.tick)

    def close(self):
        try:
            self.send("0")
            self.ser.close()
        finally:
            self.root.destroy()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port")
    args = ap.parse_args()
    App(args.port or find_port()).root.mainloop()


if __name__ == "__main__":
    main()
