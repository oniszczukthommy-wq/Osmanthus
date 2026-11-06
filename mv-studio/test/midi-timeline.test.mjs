import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getMidiBarLines } from '../public/midi-timeline.js';

const doc = (map=[], signature=[4,4]) => ({timeSignature:signature,timeSignatureMap:map});
const beats = result => result.lines.map(line=>line.beat);

test('constant meter and compound meter use quarter-note beats', () => {
  assert.deepEqual(beats(getMidiBarLines(doc(),13)),[0,4,8,12]);
  assert.deepEqual(beats(getMidiBarLines(doc([], [6,8]),10)),[0,3,6,9]);
  assert.deepEqual(beats(getMidiBarLines(doc([], [1,128]),.1)),[0,.03125,.0625,.09375]);
});

test('meter change at a bar boundary starts new meter without an extra bar', () => {
  const result=getMidiBarLines(doc([{beat:0,numerator:4,denominator:4},{beat:4,numerator:3,denominator:4}]),12);
  assert.deepEqual(beats(result),[0,4,7,10]);
  assert.deepEqual(result.lines.map(x=>x.number),[1,2,3,4]);
  assert.deepEqual(result.lines.map(x=>x.numerator),[4,3,3,3]);
});

test('meter change inside a bar creates a partial bar at the exact event', () => {
  const result=getMidiBarLines(doc([{beat:0,numerator:4,denominator:4},{beat:2.5,numerator:3,denominator:4}]),10);
  assert.deepEqual(beats(result),[0,2.5,5.5,8.5]);
  assert.deepEqual(result.lines.map(x=>x.number),[1,2,3,4]);
});

test('last same-beat meter wins, unchanged events do not invent a bar line', () => {
  const changes=[{beat:0,numerator:2,denominator:4},{beat:0,numerator:4,denominator:4},{beat:2,numerator:4,denominator:4},{beat:4,numerator:5,denominator:4},{beat:4,numerator:3,denominator:4}];
  const result=getMidiBarLines(doc(changes),11);
  assert.deepEqual(beats(result),[0,4,7,10]);
  assert.deepEqual(result.lines.map(x=>x.numerator),[4,3,3,3]);
});

test('events at end are excluded and event order is normalized without mutation', () => {
  const changes=[{beat:4,numerator:3,denominator:4},{beat:0,numerator:4,denominator:4},{beat:8,numerator:2,denominator:4}];
  const before=structuredClone(changes);
  assert.deepEqual(beats(getMidiBarLines(doc(changes),8)),[0,4,7]);
  assert.deepEqual(changes,before);
  assert.deepEqual(getMidiBarLines(doc(),0),{lines:[],truncated:false});
});

test('very dense meters have bounded rendering and report truncation', () => {
  const result=getMidiBarLines(doc([], [1,128]),200,{limit:16});
  assert.equal(result.lines.length,16);
  assert.equal(result.truncated,true);
  assert.deepEqual(getMidiBarLines(doc(),4,{limit:1}),{lines:[{beat:0,number:1,numerator:4,denominator:4}],truncated:false});
  assert.throws(()=>getMidiBarLines(doc([{beat:1,numerator:3,denominator:3}]),20),/拍号/);
  assert.throws(()=>getMidiBarLines(doc(),20,{limit:0}),/数量/);
});
