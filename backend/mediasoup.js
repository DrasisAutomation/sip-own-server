const mediasoup = require('mediasoup');

let worker;
let router;

// Global state or transport map could be used here, but we'll return transport instances back to our caller
const mediaCodecs = [
  {
    kind: 'audio',
    mimeType: 'audio/PCMU',
    clockRate: 8000,
    channels: 1
  },
  {
    kind: 'audio',
    mimeType: 'audio/PCMA',
    clockRate: 8000,
    channels: 1
  },
  {
    kind: 'video',
    mimeType: 'video/H264',
    clockRate: 90000,
    parameters: {
      'packetization-mode': 1,
      'profile-level-id': '42e01f',
      'level-asymmetry-allowed': 1
    }
  }
];

async function initializeMediasoup() {
  console.log('Initializing Mediasoup Worker...');
  worker = await mediasoup.createWorker({
    logLevel: 'debug',
    logTags: ['info', 'rtp', 'rtcp', 'message'],
    rtcMinPort: parseInt(process.env.MEDIASOUP_MIN_PORT || '10000', 10),
    rtcMaxPort: parseInt(process.env.MEDIASOUP_MAX_PORT || '10100', 10),
  });

  worker.on('died', () => {
    console.error('Mediasoup Worker died, exiting...');
    process.exit(1);
  });

  router = await worker.createRouter({ mediaCodecs });
  console.log('Mediasoup Router created');
  return { worker, router };
}

function getRouterRtpCapabilities() {
  return router.rtpCapabilities;
}

// 1. Plain Transport (Handles raw UDP RTP from SIP doorphone)
async function createPlainTransport() {
  const listenIp = process.env.MEDIASOUP_LISTEN_IP || '127.0.0.1';
  const transport = await router.createPlainTransport({
    listenIp: { ip: '0.0.0.0', announcedIp: listenIp },
    rtcpMux: false,
    comedia: true
  });
  return transport;
}

// 2. WebRTC Transport (Handles secure DTLS/SRTP to browser)
async function createWebRtcTransport() {
  const listenIps = [{ ip: '0.0.0.0', announcedIp: process.env.MEDIASOUP_ANNOUNCED_IP || '127.0.0.1' }];
  
  const transport = await router.createWebRtcTransport({
    listenIps,
    enableUdp: true,
    enableTcp: true,
    preferUdp: true,
  });

  return transport;
}

// Helper: Connect Transport DTLS
async function connectTransport(transport, dtlsParameters) {
  await transport.connect({ dtlsParameters });
}

// Helper: Create a Producer (Ingest streaming data into mediasoup)
async function createProducer(transport, kind, rtpParameters) {
  const producer = await transport.produce({ kind, rtpParameters });
  return producer;
}

// Helper: Create a Consumer (Extract stream data out of mediasoup to a target)
async function createConsumer(transport, producerId, rtpCapabilities) {
  if (!router.canConsume({ producerId, rtpCapabilities })) {
    throw new Error(`cannot consume producer ${producerId}`);
  }
  const consumer = await transport.consume({
    producerId,
    rtpCapabilities,
    paused: true // Consumer must start paused and resume after client confirms receipt
  });
  
  return consumer;
}

module.exports = {
  initializeMediasoup,
  getRouterRtpCapabilities,
  createPlainTransport,
  createWebRtcTransport,
  connectTransport,
  createProducer,
  createConsumer,
  getRouter: () => router
};
