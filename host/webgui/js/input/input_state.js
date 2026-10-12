export const InputState = {
  surge: 0,       // -1..1   W / S
  yaw: 0,         // -1..1   A / D (+ = turn right)
  heave: 0,       // -1..1   R / F (+ = up)
  magnitude: 0.5, // 0..1    J / K, a throttle that stays where you leave it
  hold: false,    // Space held: all stop
  test: null,     // THRUSTER TEST button held: { name: "left" | "right" | "vert", sign: 1 | -1 }
  pinTest: null,  // PIN TEST button held: { slot: 0 | 1 | 2, sign: 1 | -1 }  (slot 0 = GPIO 4, 1 = 5, 2 = 6)

  idle() { return this.surge === 0 && this.yaw === 0 && this.heave === 0 && this.test === null
    && this.pinTest === null; },

  reset() {
    this.surge = 0;
    this.yaw = 0;
    this.heave = 0;
    this.hold = false;
    this.test = null;
    this.pinTest = null;
  },
};
