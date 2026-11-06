// A MIDI beat is one quarter note. A meter change inside a bar closes the
// partial bar and starts a new one at the event, rather than inventing a
// preceding bar line or shifting the actual event.
const EPSILON = 1e-9;
const MAX_LINES = 4096;
const validMeter = (numerator, denominator) => Number.isInteger(numerator) && numerator >= 1 && numerator <= 255 && Number.isInteger(denominator) && denominator >= 1 && denominator <= 128 && (denominator & (denominator - 1)) === 0;

/**
 * Return visible bar lines for a half-open beat interval [0, endBeat).
 * Repeated meter events at the same beat use the last one in file order.
 * A changed meter mid-bar begins a new bar at that exact beat. Repeated
 * identical meters do not create a spurious short bar.
 */
export function getMidiBarLines(doc, endBeat, { limit = MAX_LINES } = {}) {
  if (!doc || !Number.isFinite(endBeat) || endBeat < 0 || endBeat > 1_000_000) throw new Error('MIDI 标尺范围无效');
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LINES) throw new Error('MIDI 标尺数量限制无效');
  if (!Array.isArray(doc.timeSignature) || !validMeter(doc.timeSignature[0], doc.timeSignature[1])) throw new Error('MIDI 拍号无效');
  if (doc.timeSignatureMap !== undefined && !Array.isArray(doc.timeSignatureMap)) throw new Error('MIDI 拍号变化数据无效');
  if (!endBeat) return {lines:[], truncated:false};
  const sorted=(doc.timeSignatureMap || []).map((entry,index)=>{
    if (!entry || !Number.isFinite(entry.beat) || entry.beat < 0 || entry.beat > 1_000_000 || !validMeter(entry.numerator,entry.denominator)) throw new Error('MIDI 拍号变化数据无效');
    return {beat:entry.beat,numerator:entry.numerator,denominator:entry.denominator,index};
  }).sort((a,b)=>a.beat-b.beat || a.index-b.index);
  const changes=[];
  for (const event of sorted) {
    // MIDI event times represent exact ticks; only truly equal beat values
    // are collapsed, not neighbouring changes in a high-resolution file.
    if (changes.length && changes[changes.length-1].beat===event.beat) changes[changes.length-1]=event;
    else changes.push(event);
  }
  let numerator=doc.timeSignature[0], denominator=doc.timeSignature[1], index=0;
  if (changes[0]?.beat===0) { numerator=changes[0].numerator; denominator=changes[0].denominator; index=1; }
  const lines=[{beat:0,number:1,numerator,denominator}];
  let beat=0, number=1, truncated=false;
  while (true) {
    const event=changes[index], nextBar=beat+numerator*4/denominator;
    const beforeBar=event && event.beat < nextBar-EPSILON;
    if (beforeBar && event.beat < endBeat-EPSILON) {
      index++;
      if (event.numerator===numerator && event.denominator===denominator) continue;
      beat=event.beat; numerator=event.numerator; denominator=event.denominator;
    } else {
      if (nextBar>=endBeat-EPSILON) break;
      beat=nextBar;
      if (event && Math.abs(event.beat-beat)<=EPSILON) { beat=event.beat; numerator=event.numerator; denominator=event.denominator; index++; }
    }
    if (lines.length>=limit) { truncated=true; break; }
    lines.push({beat,number:++number,numerator,denominator});
  }
  return {lines,truncated};
}
