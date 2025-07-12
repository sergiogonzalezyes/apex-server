// utils/parseACPacket.js
export function parseACPacket(buffer) {
  try {
    const packetId = buffer.readInt32LE(0);       // 0–3
    const speedKmh = buffer.readFloatLE(4);        // 4–7
    const rpm = buffer.readFloatLE(8);             // 8–11
    const gear = buffer.readInt32LE(12);           // 12–15

    return {
      packetId,
      speedKmh,
      rpm,
      gear
    };
  } catch (err) {
    console.error('❌ Failed to decode telemetry packet:', err.message);
    return null;
  }
}
