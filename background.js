// Font Snatcher Background Script (Service Worker)

chrome.runtime.onInstalled.addListener(() => {
    console.log('Font Snatcher extension installed');
});

// Clean up when popup closes (port disconnects)
chrome.runtime.onConnect.addListener((port) => {
    if (port.name === 'popup') {
        port.onDisconnect.addListener(async () => {
            try {
                const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
                if (tab && tab.url && !tab.url.startsWith('chrome://')) {
                    await chrome.scripting.executeScript({
                        target: { tabId: tab.id },
                        function: cleanupAll
                    });
                }
            } catch (e) {
                // Ignore errors for pages we can't access
            }
        });
    }
});

// Handle tab updates to clean up any active inspector mode
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === 'complete' && tab.url) {
        chrome.scripting.executeScript({
            target: { tabId: tabId },
            function: cleanupAll
        }).catch(() => {});
    }
});

// Full cleanup function to be injected
function cleanupAll() {
    // Remove highlights, tooltips, toasts
    document.querySelectorAll('.wff-highlight, .wff-hover-highlight, .wff-hover-tooltip, .wff-copy-toast')
        .forEach(el => el.remove());

    // Remove anchor names
    document.querySelectorAll('.wff-anchored').forEach(el => {
        el.style.anchorName = '';
        el.classList.remove('wff-anchored');
    });

    // Disable inspector mode
    window.wffInspectorActive = false;
    document.body.style.cursor = '';
    if (window.wffInspectorAbort) {
        window.wffInspectorAbort.abort();
        window.wffInspectorAbort = null;
    }
}
