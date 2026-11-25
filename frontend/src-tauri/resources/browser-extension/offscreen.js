// Captures one tab's audio, keeps it playing through the speakers (Chrome
// mutes a captured tab otherwise), and streams it to Miteng over a local
// WebSocket. While Miteng is not running it retries every 2 seconds.
//
// Protocol: a JSON text "hello" {sampleRate, title, url}; Miteng answers
// {"type":"ready"} or closes. Then binary frames of little-endian Float32 mono
// samples. Miteng sends {"type":"stop"} when another tab takes over.

const MITENG_URL = 'ws://127.0.0.1:47920/tab';
const SAMPLE_RATE = 48000;
const MAX_BUFFERED_BYTES = 1 << 20;

let capture = null;

function report(state, message) {
  chrome.runtime.sendMessage({ target: 'background', type: 'status', state, message });
}

function stop(state, message) {
  const current = capture;
  if (!current) return;
  capture = null;
  clearTimeout(current.retry);
  if (current.socket) {
    current.socket.onclose = null;
    current.socket.close();
  }
  current.media.getTracks().forEach((track) => track.stop());
  current.context.close();
  if (state) report(state, message);
}

function connect(current) {
  if (capture !== current) return;
  const socket = new WebSocket(MITENG_URL);
  socket.binaryType = 'arraybuffer';
  current.socket = socket;
  socket.onopen = () => {
    socket.send(JSON.stringify({ type: 'hello', sampleRate: current.context.sampleRate, title: current.title, url: current.url }));
  };
  socket.onmessage = (event) => {
    if (typeof event.data !== 'string') return;
    const message = JSON.parse(event.data);
    if (message.type === 'ready') {
      current.ready = true;
      report('connected');
    } else if (message.type === 'stop') {
      stop('stopped');
    }
  };
  socket.onclose = () => {
    if (capture !== current) return;
    current.socket = null;
    current.ready = false;
    report('waiting');
    current.retry = setTimeout(() => connect(current), 2000);
  };
}

async function start({ streamId, title, url }) {
  stop(null);
  let media;
  try {
    media = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
      video: false,
    });
  } catch (error) {
    report('error', `Could not capture the tab: ${error.message}`);
    return;
  }

  const context = new AudioContext({ sampleRate: SAMPLE_RATE });
  await context.audioWorklet.addModule('pcm-worklet.js');
  const source = context.createMediaStreamSource(media);
  source.connect(context.destination);
  const pcm = new AudioWorkletNode(context, 'miteng-pcm', {
    channelCount: 1,
    channelCountMode: 'explicit',
    channelInterpretation: 'speakers',
  });
  source.connect(pcm);
  // The worklet writes no output; connecting it keeps the graph pulling it.
  pcm.connect(context.destination);

  const current = { media, context, socket: null, ready: false, retry: null, title, url };
  capture = current;
  pcm.port.onmessage = (event) => {
    const socket = current.socket;
    if (current.ready && socket && socket.readyState === WebSocket.OPEN && socket.bufferedAmount < MAX_BUFFERED_BYTES) {
      socket.send(event.data);
    }
  };
  media.getAudioTracks()[0].addEventListener('ended', () => {
    if (capture === current) stop('stopped');
  });
  connect(current);
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.target !== 'offscreen') return;
  if (message.type === 'start') start(message);
  else if (message.type === 'stop') stop(null);
});
