// Clicking the toolbar button (or Alt+Shift+M) on a tab starts sending that
// tab's audio to Miteng; clicking it again on the same tab stops. Capture runs
// in an offscreen document because a service worker has no media APIs.

const OFFSCREEN_URL = 'offscreen.html';

const BADGE = {
  waiting: { text: '…', color: '#B7791F', title: 'Waiting for Miteng to open. The tab is captured and will be sent once Miteng is running.' },
  connected: { text: 'REC', color: '#C53030', title: "This tab's audio is going to Miteng. Click to stop." },
  error: { text: '!', color: '#718096', title: '' },
};

async function capturedTabId() {
  const { tabId } = await chrome.storage.session.get('tabId');
  return tabId ?? null;
}

async function showState(tabId, state, message) {
  if (tabId == null) return;
  const badge = BADGE[state];
  try {
    if (!badge) {
      await chrome.action.setBadgeText({ tabId, text: '' });
      await chrome.action.setTitle({ tabId, title: "Send this tab's audio to Miteng" });
      return;
    }
    await chrome.action.setBadgeBackgroundColor({ tabId, color: badge.color });
    await chrome.action.setBadgeText({ tabId, text: badge.text });
    await chrome.action.setTitle({ tabId, title: message || badge.title });
  } catch {
    // The tab is gone.
  }
}

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['USER_MEDIA'],
    justification: "Capture the chosen tab's audio and send it to the Miteng recorder.",
  });
}

async function stopCapture() {
  const tabId = await capturedTabId();
  await chrome.storage.session.remove('tabId');
  await showState(tabId, null);
  if (await chrome.offscreen.hasDocument()) {
    await chrome.runtime.sendMessage({ target: 'offscreen', type: 'stop' });
  }
}

chrome.action.onClicked.addListener(async (tab) => {
  const current = await capturedTabId();
  if (current === tab.id) {
    await stopCapture();
    return;
  }
  if (current != null) await stopCapture();

  let streamId;
  try {
    streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
  } catch (error) {
    await showState(tab.id, 'error', `Miteng can't capture this tab: ${error.message}`);
    return;
  }
  await ensureOffscreen();
  await chrome.storage.session.set({ tabId: tab.id });
  await showState(tab.id, 'waiting');
  await chrome.runtime.sendMessage({ target: 'offscreen', type: 'start', streamId, title: tab.title ?? '', url: tab.url ?? '' });
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.target !== 'background' || message.type !== 'status') return;
  (async () => {
    const tabId = await capturedTabId();
    if (message.state === 'stopped' || message.state === 'error') {
      await chrome.storage.session.remove('tabId');
      await showState(tabId, message.state === 'error' ? 'error' : null, message.message);
    } else {
      await showState(tabId, message.state);
    }
  })();
});
