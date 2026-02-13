// Font Snatcher Background Script (Service Worker)

chrome.runtime.onInstalled.addListener(() => {
    console.log('Font Snatcher extension installed');
});

// Handle tab updates to clean up any active inspector mode
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === 'complete' && tab.url) {
        // Clean up any active inspector mode when page loads
        chrome.scripting.executeScript({
            target: { tabId: tabId },
            function: cleanupInspectorMode
        }).catch(() => {
            // Ignore errors for pages we can't access
        });
    }
});

// Cleanup function to be injected
function cleanupInspectorMode() {
    if (window.wffInspectorActive) {
        window.wffInspectorActive = false;
        document.body.style.cursor = '';

        if (window.wffInspectorHandlers) {
            document.removeEventListener('mouseover', window.wffInspectorHandlers.mouseover, true);
            document.removeEventListener('mouseout', window.wffInspectorHandlers.mouseout, true);
            document.removeEventListener('keydown', window.wffInspectorHandlers.keydown, true);
            window.wffInspectorHandlers = null;
        }
    }

    // Remove any highlights or tooltips
    const elements = document.querySelectorAll('.wff-highlight, .wff-hover-highlight, .wff-hover-tooltip');
    elements.forEach(el => el.remove());
}
