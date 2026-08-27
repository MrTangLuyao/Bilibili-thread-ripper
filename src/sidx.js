(function installSidx(root) {
  "use strict";

  function readUint64(view, offset) {
    const value = view.getUint32(offset) * (2 ** 32) + view.getUint32(offset + 4);
    return Number.isSafeInteger(value) ? value : null;
  }

  function readType(bytes, offset) {
    return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
  }

  function parseSidx(buffer, absoluteStart = 0) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let boxOffset = 0;

    while (boxOffset + 8 <= bytes.byteLength) {
      let boxSize = view.getUint32(boxOffset);
      const type = readType(bytes, boxOffset + 4);
      let headerSize = 8;
      if (boxSize === 1) {
        if (boxOffset + 16 > bytes.byteLength) return null;
        boxSize = readUint64(view, boxOffset + 8);
        headerSize = 16;
      } else if (boxSize === 0) {
        boxSize = bytes.byteLength - boxOffset;
      }
      if (!boxSize || boxSize < headerSize || boxOffset + boxSize > bytes.byteLength) return null;

      if (type === "sidx") {
        let cursor = boxOffset + headerSize;
        if (cursor + 12 > boxOffset + boxSize) return null;
        const version = view.getUint8(cursor);
        cursor += 4;
        cursor += 4;
        const timescale = view.getUint32(cursor);
        cursor += 4;
        if (!timescale) return null;

        let earliestPresentationTime;
        let firstOffset;
        if (version === 0) {
          if (cursor + 8 > boxOffset + boxSize) return null;
          earliestPresentationTime = view.getUint32(cursor);
          firstOffset = view.getUint32(cursor + 4);
          cursor += 8;
        } else if (version === 1) {
          if (cursor + 16 > boxOffset + boxSize) return null;
          earliestPresentationTime = readUint64(view, cursor);
          firstOffset = readUint64(view, cursor + 8);
          cursor += 16;
          if (earliestPresentationTime === null || firstOffset === null) return null;
        } else {
          return null;
        }

        cursor += 2;
        if (cursor + 2 > boxOffset + boxSize) return null;
        const referenceCount = view.getUint16(cursor);
        cursor += 2;
        if (referenceCount < 1 || referenceCount > 10000 || cursor + referenceCount * 12 > boxOffset + boxSize) return null;

        let byteCursor = absoluteStart + boxOffset + boxSize + firstOffset;
        let timeCursor = earliestPresentationTime;
        const segments = [];
        for (let index = 0; index < referenceCount; index += 1) {
          const reference = view.getUint32(cursor);
          const referenceType = reference >>> 31;
          const referencedSize = reference & 0x7fffffff;
          const duration = view.getUint32(cursor + 4);
          cursor += 12;
          if (!referencedSize) return null;
          if (referenceType === 0) {
            segments.push({
              index: segments.length,
              start: byteCursor,
              end: byteCursor + referencedSize - 1,
              length: referencedSize,
              time: timeCursor,
              duration,
              startTime: timeCursor / timescale,
              endTime: (timeCursor + duration) / timescale,
              durationSeconds: duration / timescale
            });
          }
          byteCursor += referencedSize;
          timeCursor += duration;
        }
        if (!segments.length) return null;
        return { earliestPresentationTime, firstOffset, segments, timescale };
      }
      boxOffset += boxSize;
    }
    return null;
  }

  function segmentIndexAt(segments, seconds) {
    if (!Array.isArray(segments) || !segments.length) return -1;
    const target = Math.max(0, Number(seconds) || 0);
    let low = 0;
    let high = segments.length - 1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const segment = segments[middle];
      if (target < segment.startTime) high = middle - 1;
      else if (target >= segment.endTime) low = middle + 1;
      else return middle;
    }
    return Math.max(0, Math.min(segments.length - 1, low));
  }

  root.__BILI_SIDX__ = Object.freeze({ parseSidx, segmentIndexAt });
})(globalThis);
