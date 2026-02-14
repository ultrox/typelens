// TypeLens Background Script (Service Worker)

chrome.runtime.onInstalled.addListener(() => {
    console.log('TypeLens extension installed');
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
    document.querySelectorAll('.wff-highlight-focus, .wff-hover-highlight, .wff-hover-tooltip, .wff-copy-toast, .wff-jump-tooltip')
        .forEach(el => el.remove());

    // Remove highlight styles and anchor names
    document.querySelectorAll('.wff-anchored').forEach(el => {
        el.style.outline = '';
        el.style.outlineOffset = '';
        el.style.boxShadow = '';
        el.style.borderRadius = '';
        el.style.anchorName = '';
        el.classList.remove('wff-anchored', 'wff-focused');
    });

    // Disable inspector mode
    window.wffInspectorActive = false;
    document.body.style.cursor = '';
    if (window.wffInspectorAbort) {
        window.wffInspectorAbort.abort();
        window.wffInspectorAbort = null;
    }

    // Unfreeze hover state
    if (window.wffFreezeAbort) {
        window.wffFreezeAbort.abort();
        window.wffFreezeAbort = null;
    }
    if (window.wffFrozenElements) {
        window.wffFrozenElements.forEach(({ el, original, classes }) => {
            if (classes !== undefined) el.className = classes;
            else el.classList.remove('wff-frozen');
            if (original) el.setAttribute('style', original);
            else el.removeAttribute('style');
        });
        window.wffFrozenElements = null;
    }
    const freezeStyle = document.getElementById('wff-freeze-style');
    if (freezeStyle) freezeStyle.remove();
}
