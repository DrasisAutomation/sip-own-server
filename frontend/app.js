const socket = io();
let device;
let sendTransport;
let recvTransport;
let remoteVideo = document.getElementById('remote-video');
let currentCall = null;

// UI Elements
const statusOverlay = document.getElementById('status-overlay');
const statusText = document.getElementById('status-text');
const btnAccept = document.getElementById('btn-accept');
const btnReject = document.getElementById('btn-reject');
const inCallControls = document.getElementById('incall-controls');
const btnUnlock = document.getElementById('btn-unlock');
const btnMute = document.getElementById('btn-mute');
const btnHangup = document.getElementById('btn-hangup');
const muteIcon = document.getElementById('mute-icon');

let localStream = null;

// 1. Initialize Mediasoup Device
socket.on('connect', async () => {
  console.log('Connected to signaling server');
  
  socket.emit('getRouterRtpCapabilities', async (routerRtpCapabilities) => {
    try {
      device = new mediasoupClient.Device();
      await device.load({ routerRtpCapabilities });
      console.log('Mediasoup device loaded');
    } catch (error) {
      console.error('Failed to load mediasoup device', error);
    }
  });
});

// Incoming Call Event
socket.on('call:incoming', (data) => {
  console.log('Incoming call', data);
  currentCall = data;
  
  statusText.innerText = "Incoming Call...";
  statusOverlay.classList.add('active');
  
  btnAccept.classList.remove('hidden');
  btnReject.classList.remove('hidden');
  inCallControls.classList.add('hidden');
});

// Call Ended Remotely Event
socket.on('call:ended', () => {
  console.log('Call ended remotely');
  resetCallUI();
});

// Accept Button Clicked
btnAccept.addEventListener('click', async () => {
  btnAccept.classList.add('hidden');
  btnReject.classList.add('hidden');
  statusText.innerText = "Connecting...";
  
  socket.emit('acceptCall', async (response) => {
    if(response.error) {
       console.error("Error accepting call:", response.error);
       resetCallUI();
       return;
    }
    
    await setupTransports(response);
    
    statusOverlay.classList.remove('active');
    inCallControls.classList.remove('hidden');
  });
});

// Reject Button Clicked
btnReject.addEventListener('click', () => {
  socket.emit('rejectCall');
  resetCallUI();
});

// Hangup Button Clicked (In-Call)
btnHangup.addEventListener('click', () => {
  socket.emit('endCall');
  resetCallUI();
});

// Unlock Feature
btnUnlock.addEventListener('click', async () => {
  try {
    const res = await fetch('/unlock', { method: 'POST' });
    const data = await res.json();
    if(data.success) {
      console.log('Door unlocked successfully');
      btnUnlock.classList.add('success');
      setTimeout(() => btnUnlock.classList.remove('success'), 2000);
    } else {
      console.error('Failed to unlock:', data.message);
    }
  } catch (err) {
    console.error('Failed to unlock door', err);
  }
});

// Mute Toggle (Start Muted by Default)
let isMuted = true;
btnMute.addEventListener('click', () => {
  isMuted = !isMuted;
  if (localStream && localStream.getAudioTracks().length > 0) {
    localStream.getAudioTracks()[0].enabled = !isMuted;
  }
  muteIcon.innerText = isMuted ? "mic_off" : "mic";
  btnMute.classList.toggle('danger', isMuted);
});

// Setup Transports and Load Media
async function setupTransports({ sendTransportParams, recvTransportParams, producerIds }) {
  // Create Receiving Transport (from Intercom)
  recvTransport = device.createRecvTransport(recvTransportParams);
  
  recvTransport.on('connect', ({ dtlsParameters }, callback, errback) => {
    socket.emit('connectWebRtcTransport', { transportId: recvTransport.id, dtlsParameters }, (err) => {
      if (err) errback(err); else callback();
    });
  });

  // Create Sending Transport (Local Mic to Intercom)
  sendTransport = device.createSendTransport(sendTransportParams);
  
  sendTransport.on('connect', ({ dtlsParameters }, callback, errback) => {
    socket.emit('connectWebRtcTransport', { transportId: sendTransport.id, dtlsParameters }, (err) => {
      if (err) errback(err); else callback();
    });
  });
  
  sendTransport.on('produce', async (parameters, callback, errback) => {
    socket.emit('produce', {
      transportId: sendTransport.id,
      kind: parameters.kind,
      rtpParameters: parameters.rtpParameters,
      appData: parameters.appData
    }, (res) => {
      if (res.error) errback(res.error); else callback({ id: res.id });
    });
  });

  // Start consuming remote video/audio tracks
  const stream = new MediaStream();
  for (const producerId of producerIds) {
    try {
      const consumerParams = await new Promise((resolve, reject) => {
        socket.emit('consume', { 
          transportId: recvTransport.id, 
          producerId, 
          rtpCapabilities: device.rtpCapabilities 
        }, (res) => {
          if (res.error) reject(new Error(res.error));
          else resolve(res);
        });
      });

      const consumer = await recvTransport.consume(consumerParams);
      stream.addTrack(consumer.track);
      socket.emit('resumeConsumer', { consumerId: consumer.id });
    } catch (err) {
      console.error('Consume failed', err);
    }
  }
  
  remoteVideo.srcObject = stream;
  remoteVideo.play();

  // Try to acquire and produce local microphone audio
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    localStream.getAudioTracks()[0].enabled = !isMuted; // Start muted
    
    muteIcon.innerText = isMuted ? "mic_off" : "mic";
    btnMute.classList.toggle('danger', isMuted);
    btnMute.classList.remove('hidden');
    
    const audioTrack = localStream.getAudioTracks()[0];
    await sendTransport.produce({ track: audioTrack });
  } catch (err) {
    console.error('Failed to get mic access', err);
    // Continue without mic
  }
}

// Helper to reset the call UI
function resetCallUI() {
  currentCall = null;
  statusText.innerText = "Standing By...";
  statusOverlay.classList.add('active');
  btnAccept.classList.add('hidden');
  btnReject.classList.add('hidden');
  inCallControls.classList.add('hidden');
  btnMute.classList.add('hidden');
  
  if (remoteVideo.srcObject) {
    remoteVideo.srcObject.getTracks().forEach(t => t.stop());
    remoteVideo.srcObject = null;
  }
  
  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }
  
  if (sendTransport) { sendTransport.close(); sendTransport = null; }
  if (recvTransport) { recvTransport.close(); recvTransport = null; }
}
