// utils/parseACPacket.js

export function parseACPacket(buffer) {
  // For now, just log and return basic metadata
  console.log('🧩 Raw UDP payload:', buffer.toString('hex'));

  // You can add pattern recognition, header parsing, or AC plugin specs here
  return {
    type: 'unknown',
    payload: buffer.toString('utf8'), // or leave as Buffer for more control
  };
}
