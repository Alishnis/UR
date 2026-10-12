// Text lines to / from the ESP32. The full contract is in docs/PROTOCOL.md.

const ascii = (text, max = 64) => String(text || "")
  .replace(/[\r\n]+/g, " ")        // no newlines on the wire
  .replace(/[^\x20-\x7E]/g, "")    // ASCII-printable only
  .trim()
  .slice(0, max);                  // firmware buffer bound

export const Protocol = {
  // Browser -> ESP
  encodeDrive(left, right, vert) {
    return `D ${left.toFixed(3)} ${right.toFixed(3)} ${vert.toFixed(3)}`;
  },
  encodeStop() { return "S"; },
  encodePing() { return "P"; },
  encodeWifi(ssid, password) { return `M ${ascii(ssid, 32).replace(/ /g, "")} ${ascii(password)}`; },
  encodeUrl(url) { return `U ${ascii(url, 120)}`; },
  encodeGet() { return "G"; },

  // ESP -> Browser
  parseLine(line) {
    const text = line.trim();
    const parts = text.split(/\s+/);
    switch (parts[0]) {
      case "T":
        if (parts.length < 4) return { type: "unknown", raw: line };
        return { type: "telemetry", us: parts.slice(1, 4).map(Number) };
      case "N": return { type: "network", text: text.slice(2) };
      case "W": return { type: "warning", text: text.slice(2) };
      case "PONG": return { type: "pong" };
      case "ACK": return { type: "ack", text: text.slice(4) };
      default: return { type: "unknown", raw: line };
    }
  },
};
