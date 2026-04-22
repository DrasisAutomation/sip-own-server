require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const socketIo = require('socket.io');

const mediasoup = require('./mediasoup');
const sip = require('./sip');
const unlockRoute = require('./routes/unlock');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: "*" } });

app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend')));
app.use('/unlock', unlockRoute);

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

// Keep track of transports and consumers for the socket
const activeTransports = new Map();
const activeConsumers = new Map();

io.on('connection', (socket) => {
  console.log(`Frontend client connected: ${socket.id}`);

  socket.on('getRouterRtpCapabilities', (callback) => {
    callback(mediasoup.getRouterRtpCapabilities());
  });

  socket.on('acceptCall', async (callback) => {
    try {
      // 1. Tell SIP to answer the phone and give us the Mediasoup Producers
      const producers = await sip.acceptPendingCall();

      // 2. Create WebRTC Transports for the Frontend
      const recvWebRtcTransport = await mediasoup.createWebRtcTransport();
      const sendWebRtcTransport = await mediasoup.createWebRtcTransport();

      activeTransports.set(recvWebRtcTransport.id, recvWebRtcTransport);
      activeTransports.set(sendWebRtcTransport.id, sendWebRtcTransport);

      // 3. Create Consumers on the WebRTC Recv Transport for each Producer
      const consumersParams = [];

      // Assume frontend will send its rtpCapabilities when it calls consume
      // Actually we need the router's rtpCapabilities OR the client's. We ask for client's later, 
      // but mediasoup client needs the consumer configs, and the client creates consumer instances.
      // Wait, we need the client's rtpCapabilities to create consumers safely.
      // Let's defer consuming until a split `consume` event, or if we pass 'socket.rtpCapabilities' we can do it now.

      // Since we need client rtpCapabilities, let's ask the frontend to call `consume` separately.
      // BUT, in app.js I expected consumers array on response!
      // Let's modify: we will return transports, and let frontend emit `consume` requests.

      callback({
        recvTransportParams: {
          id: recvWebRtcTransport.id,
          iceParameters: recvWebRtcTransport.iceParameters,
          iceCandidates: recvWebRtcTransport.iceCandidates,
          dtlsParameters: recvWebRtcTransport.dtlsParameters
        },
        sendTransportParams: {
          id: sendWebRtcTransport.id,
          iceParameters: sendWebRtcTransport.iceParameters,
          iceCandidates: sendWebRtcTransport.iceCandidates,
          dtlsParameters: sendWebRtcTransport.dtlsParameters
        },
        producerIds: producers.map(p => p.id) // Send IDs to let client ask to consume
      });

    } catch (err) {
      console.error(err);
      callback({ error: err.message });
    }
  });

  socket.on('connectWebRtcTransport', async ({ transportId, dtlsParameters }, callback) => {
    try {
      const transport = activeTransports.get(transportId);
      if (!transport) throw new Error(`Transport ${transportId} not found`);
      await mediasoup.connectTransport(transport, dtlsParameters);
      callback();
    } catch (err) {
      callback(err.message);
    }
  });

  socket.on('consume', async ({ transportId, producerId, rtpCapabilities }, callback) => {
    try {
      const transport = activeTransports.get(transportId);
      if (!transport) throw new Error('Transport not found');

      const consumer = await mediasoup.createConsumer(transport, producerId, rtpCapabilities);
      activeConsumers.set(consumer.id, consumer);

      socket.on('disconnect', () => {
        consumer.close();
        activeConsumers.delete(consumer.id);
      });

      callback({
        id: consumer.id,
        producerId: consumer.producerId,
        kind: consumer.kind,
        rtpParameters: consumer.rtpParameters
      });
    } catch (err) {
      callback({ error: err.message });
    }
  });

  socket.on('produce', async ({ transportId, kind, rtpParameters, appData }, callback) => {
    try {
      const transport = activeTransports.get(transportId);
      if (!transport) throw new Error('Transport not found');

      const producer = await mediasoup.createProducer(transport, kind, rtpParameters);

      // If this is audio and we have an active SIP call, forward to SIP phone
      if (kind === 'audio' && sip.getCurrentDialog()) {
        const plainTransport = sip.getPlainTransport();
        if (plainTransport) {
          const consumer = await plainTransport.consume({
            producerId: producer.id,
            rtpCapabilities: mediasoup.getRouter().rtpCapabilities,
            paused: false
          });
          console.log('Forwarding WebRTC audio to SIP phone');
        }
      }

      callback({ id: producer.id });
    } catch (err) {
      callback({ error: err.message });
    }
  });
  socket.on('resumeConsumer', async ({ consumerId }) => {
    try {
      const consumer = activeConsumers.get(consumerId);
      if (consumer) {
        await consumer.resume();
        console.log(`Resumed consumer ${consumerId}`);
      }
    } catch (err) {
      console.error('Failed to resume consumer', err);
    }
  });

  socket.on('rejectCall', () => sip.rejectPendingCall());
  socket.on('endCall', () => sip.endCall());

  socket.on('disconnect', () => {
    console.log(`Frontend client disconnected: ${socket.id}`);
  });
});

async function start() {
  try {
    await mediasoup.initializeMediasoup();
    sip.initSip(io);
    const port = process.env.WEB_PORT || 3000;
    server.listen(port, () => console.log(`Server running on http://localhost:${port}`));
  } catch (err) {
    console.error('Failed to start server:', err);
  }
}

start();
