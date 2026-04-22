// sip.js - Pure Node.js version using 'sip' package
const sip = require('sip');
const mediasoup = require('./mediasoup');
const sdpTransform = require('sdp-transform');

let currentDialog = null;
let pendingCall = null;
let ioInstance = null;
let activePlainTransports = null; // Store for 2-way audio

function initSip(io) {
  ioInstance = io;
  const port = parseInt(process.env.SIP_PORT || '5060', 10);
  console.log(`Starting native SIP Server on UDP ${port}...`);

  try {
    sip.start({ port: port }, handleSipRequest);
    console.log('SIP Server running');
  } catch (err) {
    console.error('Failed to start SIP Server:', err);
  }
}

async function handleSipRequest(req) {
  try {
    console.log(`Received ${req.method} from ${req.headers.from.uri}`);

    if (req.method === 'REGISTER') {
      const res = sip.makeResponse(req, 200, 'OK');
      if (req.headers.contact) {
        res.headers.contact = req.headers.contact;
      }
      res.headers.expires = 3600;
      sip.send(res);
      return;
    }

    if (req.method === 'INVITE') {
      if (pendingCall || currentDialog) {
        console.log('Already in a call, sending 486 Busy Here');
        sip.send(sip.makeResponse(req, 486, 'Busy Here'));
        return;
      }
      await handleIncomingCall(req);
      return;
    }

    if (req.method === 'BYE' || req.method === 'CANCEL') {
      console.log(`Call terminated by remote SIP peer (${req.method})`);
      sip.send(sip.makeResponse(req, 200, 'OK'));
      cleanupCall();
      if (ioInstance) ioInstance.emit('call:ended');
      return;
    }

    if (req.method === 'ACK') {
      console.log('Received ACK');
      return;
    }

  } catch (err) {
    console.error('Error handling SIP Request:', err);
    sip.send(sip.makeResponse(req, 500, 'Internal Server Error'));
  }
}

async function handleIncomingCall(req) {
  try {
    const sdpString = req.content;
    const parsedSdp = sdpTransform.parse(sdpString);
    const audioMedia = parsedSdp.media.find(m => m.type === 'audio');
    const videoMedia = parsedSdp.media.find(m => m.type === 'video');

    let audioTransport = null;
    let videoTransport = null;
    let audioProducer = null;
    let videoProducer = null;

    // Create PlainTransport for audio
    if (audioMedia) {
      audioTransport = await mediasoup.createPlainTransport();
      console.log(`Created audio plain transport on port ${audioTransport.tuple.localPort}`);

      // Find the codec (PCMU or PCMA)
      let mimeType = 'audio/PCMU';
      let payloadType = 0;

      if (audioMedia.rtp) {
        const pcmaRtp = audioMedia.rtp.find(r => r.codec.toUpperCase() === 'PCMA');
        const pcmuRtp = audioMedia.rtp.find(r => r.codec.toUpperCase() === 'PCMU');

        if (pcmaRtp) {
          mimeType = 'audio/PCMA';
          payloadType = parseInt(pcmaRtp.payload);
        } else if (pcmuRtp) {
          mimeType = 'audio/PCMU';
          payloadType = parseInt(pcmuRtp.payload);
        }
      }

      // Create producer for incoming audio
      audioProducer = await audioTransport.produce({
        kind: 'audio',
        rtpParameters: {
          mid: '0',
          codecs: [{
            mimeType: mimeType,
            payloadType: payloadType,
            clockRate: 8000,
            channels: 1
          }],
          encodings: [{}]
        },
        paused: false
      });
    }

    // Create PlainTransport for video if present
    if (videoMedia) {
      videoTransport = await mediasoup.createPlainTransport();
      console.log(`Created video plain transport on port ${videoTransport.tuple.localPort}`);

      videoProducer = await videoTransport.produce({
        kind: 'video',
        rtpParameters: {
          mid: '1',
          codecs: [{
            mimeType: 'video/H264',
            payloadType: 102,
            clockRate: 90000,
            parameters: {
              'packetization-mode': 1,
              'profile-level-id': '42e01f',
              'level-asymmetry-allowed': 1
            }
          }],
          encodings: [{}]
        },
        paused: false
      });
    }

    const dialogTag = 'ringing-' + Math.floor(Math.random() * 10000);

    // Store call context
    pendingCall = {
      req,
      dialogTag,
      parsedSdp,
      audioTransport, videoTransport,
      audioProducer, videoProducer,
      audioMedia, videoMedia,
      cleanup: () => {
        if (audioProducer) audioProducer.close();
        if (videoProducer) videoProducer.close();
        if (audioTransport) audioTransport.close();
        if (videoTransport) videoTransport.close();
      }
    };

    // Send ringing
    const res = sip.makeResponse(req, 180, 'Ringing');
    if (!res.headers.to.params) res.headers.to.params = {};
    res.headers.to.params.tag = dialogTag;
    sip.send(res);

    // Notify frontend
    ioInstance.emit('call:incoming', {
      from: req.headers.from.uri,
      hasVideo: !!videoProducer,
      hasAudio: !!audioProducer
    });

  } catch (err) {
    console.error('Error handling INVITE:', err);
    sip.send(sip.makeResponse(req, 500, 'Server Error'));
  }
}

async function acceptPendingCall() {
  if (!pendingCall) throw new Error('No pending call to accept');

  const { req, parsedSdp, audioTransport, videoTransport, audioProducer, videoProducer, audioMedia, videoMedia } = pendingCall;

  // Generate answer SDP with correct ports
  const answerSdp = generateAnswerSdp(parsedSdp, audioTransport, videoTransport, audioMedia, videoMedia);

  // Create 200 OK response
  const res = sip.makeResponse(req, 200, 'OK');
  if (!res.headers.to.params) res.headers.to.params = {};
  res.headers.to.params.tag = pendingCall.dialogTag;
  res.headers.contact = [{ uri: `sip:server@${process.env.SIP_HOST || '192.168.2.203'}:${process.env.SIP_PORT || '5060'}` }];
  res.headers['content-type'] = 'application/sdp';
  res.content = answerSdp;

  // Send 200 OK
  sip.send(res);

  // Store dialog for sending INFO or BYE
  const dialog = {
    callId: req.headers['call-id'],
    to: res.headers.to,
    from: res.headers.from,
    reqUri: (req.headers.contact && req.headers.contact.length > 0) ? req.headers.contact[0].uri : req.headers.from.uri,
    cseq: req.headers.cseq.seq
  };

  currentDialog = dialog;
  activePlainTransports = { audioTransport, videoTransport };

  const producers = [];
  if (audioProducer) producers.push(audioProducer);
  if (videoProducer) producers.push(videoProducer);

  pendingCall = null;
  return producers;
}

function generateAnswerSdp(offerSdp, audioTransport, videoTransport, audioMedia, videoMedia) {
  const answer = JSON.parse(JSON.stringify(offerSdp));
  const announcedIp = process.env.MEDIASOUP_ANNOUNCED_IP || '127.0.0.1';

  answer.origin.address = announcedIp;
  answer.connection = {
    ip: announcedIp,
    version: 4
  };

  // Set session info
  answer.name = "Mediasoup Answer";

  answer.media.forEach((media) => {
    if (media.type === 'audio' && audioTransport && audioMedia) {
      media.port = audioTransport.tuple.localPort;
      media.connection = { ip: announcedIp, version: 4 };
      media.direction = 'sendrecv';

      // Update RTP info
      if (media.rtp && audioMedia.rtp) {
        media.rtp = audioMedia.rtp;
      }
    }
    else if (media.type === 'video' && videoTransport && videoMedia) {
      media.port = videoTransport.tuple.localPort;
      media.connection = { ip: announcedIp, version: 4 };
      media.direction = 'sendrecv';

      if (media.rtp && videoMedia.rtp) {
        media.rtp = videoMedia.rtp;
      }
    }
    else {
      media.port = 0;
      media.direction = 'inactive';
    }
  });

  return sdpTransform.write(answer);
}

function rejectPendingCall() {
  if (!pendingCall) return;
  const res = sip.makeResponse(pendingCall.req, 486, 'Busy Here');
  sip.send(res);
  pendingCall.cleanup();
  pendingCall = null;
}

function endCall() {
  if (currentDialog) {
    // Send BYE
    const method = 'BYE';
    currentDialog.cseq++;
    const request = {
      method: method,
      uri: currentDialog.reqUri,
      headers: {
        to: currentDialog.from,  // Reversed
        from: currentDialog.to,  // Reversed
        'call-id': currentDialog.callId,
        cseq: { method: method, seq: currentDialog.cseq }
      }
    };
    try { sip.send(request); } catch (e) { console.error('BYE err:', e); }
  } else if (pendingCall) {
    rejectPendingCall();
  }
  cleanupCall();
}

function cleanupCall() {
  if (pendingCall) {
    pendingCall.cleanup();
    pendingCall = null;
  }
  if (activePlainTransports) {
    if (activePlainTransports.audioTransport) activePlainTransports.audioTransport.close();
    if (activePlainTransports.videoTransport) activePlainTransports.videoTransport.close();
    activePlainTransports = null;
  }
  currentDialog = null;
}

function sendDtmf() {
  if (currentDialog) {
    console.log('Sending Door Unlock DTMF via INFO');
    currentDialog.cseq++;
    const request = {
      method: 'INFO',
      uri: currentDialog.reqUri,
      headers: {
        to: currentDialog.from,
        from: currentDialog.to,
        'call-id': currentDialog.callId,
        cseq: { method: 'INFO', seq: currentDialog.cseq },
        'content-type': 'application/dtmf-relay'
      },
      content: `Signal=${process.env.DOOR_UNLOCK_DTMF || '1'}\r\nDuration=250\r\n`
    };
    try {
      sip.send(request);
      console.log('DTMF sent successfully');
      return true;
    } catch (err) {
      console.error('Failed to send DTMF:', err);
    }
  }
  return false;
}

function getCurrentDialog() {
  return currentDialog;
}

function getPlainTransport() {
  if (activePlainTransports) {
    return activePlainTransports.audioTransport;
  }
  return null;
}

module.exports = {
  initSip,
  acceptPendingCall,
  rejectPendingCall,
  endCall,
  sendDtmf,
  getCurrentDialog,
  getPlainTransport
};