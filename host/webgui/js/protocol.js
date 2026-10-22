// Parsing of lines coming from the ESP32 / bridge (see docs/PROTOCOL.md). Pure, unit-tested.

// -> {kind, ...}
//   T      {us:[a,b,c]}
//   PONG   {}
//   W / N  {text}
//   B      {text}               bridge status line
//   R      {text, dry, outputs:[{name, io, rb, state:'ok'|'mismatch'|'nosignal'|'stuck'|'measuring', text}]}
//   banner {text}               "ROV ..." boot lines; {mode:'LIVE'|'DRY RUN'} on the mode line, {ready:true}, {boot:true},
//                               {resetReason, resetBad} on the reset reason line (resetBad: crash or power problem)
//   other  {text}
export function parseLine(line) {
  const text = String(line).trim();
  if (text === 'PONG') return { kind: 'PONG' };

  let m = /^T (\d+) (\d+) (\d+)$/.exec(text);
  if (m) return { kind: 'T', us: [Number(m[1]), Number(m[2]), Number(m[3])] };

  if (text.startsWith('W ')) return { kind: 'W', text: text.slice(2) };
  if (text.startsWith('N ')) return { kind: 'N', text: text.slice(2) };
  if (text.startsWith('B ')) return { kind: 'B', text: text.slice(2) };
  if (text.startsWith('R ')) return parseReport(text);

  if (text.startsWith('ROV ')) {
    const out = { kind: 'banner', text };
    if (text.startsWith('ROV firmware ')) out.boot = true;
    m = /^ROV mode: (LIVE|DRY RUN)/.exec(text);
    if (m) out.mode = m[1];
    m = /^ROV reset reason: (.+)$/.exec(text);
    if (m) {
      out.resetReason = m[1];
      out.resetBad = /CRASH|BROWNOUT|GLITCH/.test(m[1]);
    }
    if (text === 'ROV ready, accepting commands') out.ready = true;
    return out;
  }
  return { kind: 'other', text };
}

function parseReport(text) {
  let body = text.slice(2);
  const dry = body.startsWith('[DRY RUN] ');
  if (dry) body = body.slice('[DRY RUN] '.length);
  const outputs = body.split(' | ').map((seg) => {
    const m = /^(\S+) io(\d+)->io(\d+): (.*)$/.exec(seg);
    if (!m) return { name: '?', io: null, rb: null, state: 'measuring', text: seg };
    const rest = m[4];
    let state = 'measuring';
    if (rest.startsWith('no signal')) state = 'nosignal';
    else if (rest.startsWith('stuck HIGH')) state = 'stuck';
    else if (rest.endsWith(' MISMATCH')) state = 'mismatch';
    else if (rest.endsWith(' ok')) state = 'ok';
    return { name: m[1], io: Number(m[2]), rb: Number(m[3]), state, text: rest };
  });
  return { kind: 'R', text: body, dry, outputs };
}
