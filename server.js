// server.js
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { pool } from './db.js';
import chokidar from 'chokidar';
import fs from 'fs';
import path from 'path';
import dgram from 'dgram';
import { parseSessions } from './utils/sessionParser.js';
import { parseACPacket } from './utils/parseACPacket.js';


const fastify = Fastify({ logger: true });

await fastify.register(cors, {
  origin: 'https://apex-client-beta.vercel.app',
  credentials: true
});

const AC_UDP_PORT = 12000;
const udpServer = dgram.createSocket('udp4');

udpServer.on('message', (msg, rinfo) => {
  console.log(`📡 Received ${msg.length} bytes from ${rinfo.address}:${rinfo.port}`);
  console.log(msg);
});

udpServer.on('listening', () => {
  const address = udpServer.address();
  console.log(`🚀 Listening for raw telemetry on port ${address.port}`);
});

udpServer.bind(AC_UDP_PORT);

fastify.post('/api/laps', async (req, reply) => {
  const parsedSessions = parseSessions(req.body);

  const conn = await pool.getConnection();
  try {
    for (const session of parsedSessions) {
      const { car, track, username, laps } = session;

      let [[userRow]] = await conn.query('SELECT id FROM users WHERE username = ?', [username]);
      if (!userRow) {
        const [userInsert] = await conn.query('INSERT INTO users (username) VALUES (?)', [username]);
        userRow = { id: userInsert.insertId };
      }

      let [[trackRow]] = await conn.query('SELECT id FROM tracks WHERE name = ?', [track]);
      if (!trackRow) {
        const [trackInsert] = await conn.query('INSERT INTO tracks (name) VALUES (?)', [track]);
        trackRow = { id: trackInsert.insertId };
      }

      let [[carRow]] = await conn.query('SELECT id FROM cars WHERE name = ?', [car]);
      if (!carRow) {
        const [carInsert] = await conn.query('INSERT INTO cars (name) VALUES (?)', [car]);
        carRow = { id: carInsert.insertId };
      }

      let [[comboRow]] = await conn.query(
        'SELECT id FROM combos WHERE car_id = ? AND track_id = ?',
        [carRow.id, trackRow.id]
      );
      if (!comboRow) {
        const [comboInsert] = await conn.query(
          'INSERT INTO combos (car_id, track_id) VALUES (?, ?)',
          [carRow.id, trackRow.id]
        );
        comboRow = { id: comboInsert.insertId };
      }

      for (const lap of laps) {
        await conn.query(
          `INSERT INTO laps (user_id, combo_id, lap_time, valid, sectors)
           VALUES (?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE
             user_id = VALUES(user_id),
             lap_time = VALUES(lap_time),
             valid = VALUES(valid),
             sectors = VALUES(sectors)`,
          [userRow.id, comboRow.id, lap.time, lap.valid, JSON.stringify(lap.sectors)]
        );
      }

      console.log(`✅ Uploaded ${laps.length} lap(s) for ${car} on ${track} by ${username}`);
    }

    reply.send({ success: true });
  } catch (err) {
    console.error('❌ DB Error:', err);
    reply.status(500).send({ error: 'Internal Server Error' });
  } finally {
    conn.release();
  }
});

// Additional API routes (best-laps, lap-summary) remain unchanged here for brevity

let watcher = null;
let watchPath = null;

function startWatchingFolder(folderPath) {
  if (!fs.existsSync(folderPath)) {
    console.error('Invalid folder path for watcher:', folderPath);
    return;
  }

  if (watcher) {
    watcher.close();
  }

  watcher = chokidar.watch(folderPath, { ignoreInitial: true });
  watcher.on('add', async (filePath) => {
    if (!filePath.endsWith('.json')) return;
    try {
      const raw = await fs.promises.readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw);

      const response = await fastify.inject({
        method: 'POST',
        url: '/api/laps',
        payload: parsed
      });

      const { statusCode } = response;
      if (statusCode === 200) {
        console.log(`✅ Uploaded: ${path.basename(filePath)}`);
      } else {
        console.warn(`⚠️ Upload failed: ${filePath}`);
      }
    } catch (err) {
      console.error(`❌ Error processing file ${filePath}:`, err.message);
    }
  });
}

const configPath = './config.json';

function loadConfig() {
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const cfg = JSON.parse(raw);
    if (cfg.watchPath && fs.existsSync(cfg.watchPath)) {
      watchPath = cfg.watchPath;
      startWatchingFolder(watchPath);
    }
  } catch (e) {
    console.warn('⚠️ Could not load config.json:', e.message);
  }
}

function saveConfig(pathToWatch) {
  fs.writeFileSync(configPath, JSON.stringify({ watchPath: pathToWatch }, null, 2));
}

fastify.post('/api/set-watch-path', async (request, reply) => {
  const { folderPath } = request.body;

  if (!fs.existsSync(folderPath)) {
    return reply.status(400).send({ error: 'Folder does not exist' });
  }

  watchPath = folderPath;
  startWatchingFolder(folderPath);
  saveConfig(folderPath);

  reply.send({ success: true, message: `Now watching: ${folderPath}` });
});



fastify.post('/api/live-telemetry', async (req, reply) => {
  try {
    const { relayId, payload } = req.body;
    if (!payload || !relayId) {
      return reply.status(400).send({ error: 'Missing payload or relayId' });
    }

    const rawBuffer = Buffer.from(payload, 'hex');
    console.log('🧩 Raw UDP payload:', payload);

    const telemetry = parseACPacket(rawBuffer);

    if (!telemetry) {
      return reply.status(422).send({ error: 'Invalid telemetry packet' });
    }

    console.log(`📡 Parsed telemetry from ${relayId}:`, telemetry);

    // (Optional) Save, broadcast, or respond with processed data
    reply.send({ success: true });
  } catch (err) {
    console.error('❌ Live telemetry error:', err.message);
    reply.status(500).send({ error: 'Internal Server Error' });
  }
});




loadConfig();

process.on('SIGINT', async () => {
  console.log('🔴 Gracefully shutting down...');
  try {
    udpServer.close();
    await fastify.close();
    process.exit(0);
  } catch (err) {
    console.error('Shutdown error:', err);
    process.exit(1);
  }
});

fastify.listen({ port: 3000, host: '0.0.0.0' }, (err, address) => {
  if (err) {
    console.error(err);
    try { udpServer.close(); } catch {}
    process.exit(1);
  }
  console.log(`🚀 Server listening at ${address}`);
});
