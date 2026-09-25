// Chrome native messaging framing: each message is a 4-byte little-endian length, then UTF-8 JSON.

/** One message → the bytes Chrome expects. */
export function encode(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  return Buffer.concat([head, body]);
}

/**
 * Pulls complete messages off the front of a buffer.
 * Returns the parsed messages and whatever bytes are left over (a partial message).
 */
export function decode(buffer) {
  const messages = [];
  let rest = buffer;
  while (rest.length >= 4) {
    const len = rest.readUInt32LE(0);
    if (rest.length < 4 + len) break;
    messages.push(JSON.parse(rest.subarray(4, 4 + len).toString('utf8')));
    rest = rest.subarray(4 + len);
  }
  return { messages, rest };
}
