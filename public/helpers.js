// Adapted from https://github.com/mbtaviz/week/blob/gh-pages/main.js

var dist = 1.4;

function closestClockwise(line, lines) {
  var origAngle = angle(line.segment);
  lines = lines || [];
  var result = null;
  var minAngle = Infinity;
  lines.forEach(function (other) {
    if (same(other, line)) { return; }
    var thisAngle = angle(other.segment) + Math.PI;
    var diff = -normalize(thisAngle - origAngle);
    if (diff < minAngle) {
      minAngle = diff;
      result = other;
    }
  });
  return result;
}

function closestCounterClockwise(line, lines) {
  var origAngle = angle(line.segment);
  lines = lines || [];
  var result = null;
  var minAngle = Infinity;
  lines.forEach(function (other) {
    var thisAngle = angle(other.segment);
    var diff = normalize(origAngle - thisAngle);
    var absDiff = Math.abs(diff);
    if (absDiff < 0.2 || Math.abs(absDiff - Math.PI) < 0.2) { return; }
    if (diff < minAngle) {
      minAngle = diff;
      result = other;
    }
  });
  return result;
}

function same(a, b) {
  var sega = JSON.stringify(a.segment);
  var segb = JSON.stringify(b.segment);
  return sega === segb;
}

function normalize(angle) {
  return (Math.PI * 4 + angle) % (Math.PI * 2) - Math.PI;
}

function angle(p1, p2) {
  if (arguments.length === 1) {
    var origP1 = p1;
    p1 = origP1[0];
    p2 = origP1[1];
  }
  return Math.atan2((p2[1] - p1[1]), (p2[0] - p1[0]));
}

function offsetPoints(d) {
  var p1 = d.segment[0];
  var p2 = d.segment[1];
  var lineAngle = angle(p1, p2);
  var angle90 = lineAngle + Math.PI / 2;
  var p3 = [p2[0] + dist * Math.cos(angle90), p2[1] + dist * Math.sin(angle90)];
  var p4 = [p1[0] + dist * Math.cos(angle90), p1[1] + dist * Math.sin(angle90)];

  return [p4, p3];
}

function slope(line) {
  return (line[1][1] - line[0][1]) / (line[1][0] - line[0][0]);
}

function intercept(line) {
  // y = mx + b
  // b = y - mx
  return line[1][1] - slope(line) * line[1][0];
}

function intersect(line1, line2) {
  var m1 = slope(line1);
  var b1 = intercept(line1);
  var m2 = slope(line2);
  var b2 = intercept(line2);

  var m1Infinite = m1 === Infinity || m1 === -Infinity;
  var m2Infinite = m2 === Infinity || m2 === -Infinity;
  var x, y;
  if ((m1Infinite && m2Infinite) || Math.abs(m2 - m1) < 0.01) {
    return null;
  } else if (m1Infinite) {
    x = line1[0][0];
    // y = mx + b
    y = m2 * x + b2;
    return [x, y];
  } else if (m2Infinite) {
    x = line2[0][0];
    y = m1 * x + b1;
    return [x, y];
  } else {
    // x = (b2 - b1) / (m1 - m2)
    x = (b2 - b1) / (m1 - m2);
    y = m1 * x + b1;
    return [x, y];
  }
}

function length (a, b) {
  return Math.sqrt(Math.pow(b[1] - a[1], 2) + Math.pow(b[0] - a[0], 2));
}

