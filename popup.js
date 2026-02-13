document.addEventListener('DOMContentLoaded', async () => {
    const fontList = document.getElementById('font-list');
    const fontCountText = document.getElementById('font-count-text');
    const inspectToggle = document.getElementById('inspect-toggle');

    let currentTab = null;
    let isInspectorActive = false;

    init();

    async function init() {
        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            currentTab = tab;

            if (!tab || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) {
                showNoAccessMessage();
                return;
            }

            await loadFontData(tab.id);
        } catch (error) {
            console.error('Error initializing popup:', error);
            showErrorMessage();
        }
    }

    async function loadFontData(tabId) {
        try {
            const results = await chrome.scripting.executeScript({
                target: { tabId: tabId },
                function: detectFontsByElement
            });

            const data = results[0].result;
            displayFonts(data);
        } catch (error) {
            console.error('Error loading font data:', error);
            showErrorMessage();
        }
    }

    function displayFonts(fontGroups) {
        if (!fontGroups || fontGroups.length === 0) {
            fontList.innerHTML = '<div class="no-fonts">No fonts detected on this page</div>';
            fontCountText.textContent = '0 fonts found';
            return;
        }

        fontCountText.textContent = `${fontGroups.length} font${fontGroups.length === 1 ? '' : 's'} found`;

        fontList.innerHTML = fontGroups.map(group => `
            <div class="font-group" data-font="${encodeURIComponent(group.font)}">
                <div class="font-header">
                    <span class="font-name" style="font-family: ${group.font}">${group.displayName}</span>
                    <span class="font-total">${group.totalCount}</span>
                </div>
                <div class="tag-list">
                    ${group.tags.map(tag => `
                        <span class="tag-chip" data-tag="${tag.name}" data-font="${encodeURIComponent(group.font)}">
                            ${tag.name}
                            <span class="tag-count">${tag.count}</span>
                        </span>
                    `).join('')}
                </div>
            </div>
        `).join('');

        // Add click events for tag chips to highlight
        document.querySelectorAll('.tag-chip').forEach(chip => {
            chip.addEventListener('click', async (e) => {
                e.stopPropagation();
                const tag = chip.dataset.tag;
                const font = decodeURIComponent(chip.dataset.font);

                // Toggle active state
                const wasActive = chip.classList.contains('active');
                document.querySelectorAll('.tag-chip').forEach(c => c.classList.remove('active'));

                if (!wasActive) {
                    chip.classList.add('active');
                    await highlightAndScrollTo(font, [tag]);
                } else {
                    highlightElements(font, [tag], false);
                }
            });
        });

        // Add hover events for font groups
        document.querySelectorAll('.font-group').forEach(group => {
            group.addEventListener('mouseenter', () => {
                const font = decodeURIComponent(group.dataset.font);
                const tags = Array.from(group.querySelectorAll('.tag-chip')).map(c => c.dataset.tag);
                highlightElements(font, tags, true);
            });

            group.addEventListener('mouseleave', () => {
                // Only clear if no tag is actively clicked
                if (!document.querySelector('.tag-chip.active')) {
                    const font = decodeURIComponent(group.dataset.font);
                    const tags = Array.from(group.querySelectorAll('.tag-chip')).map(c => c.dataset.tag);
                    highlightElements(font, tags, false);
                }
            });
        });
    }

    async function highlightElements(fontFamily, tags, highlight) {
        try {
            if (!currentTab) return;

            await chrome.scripting.executeScript({
                target: { tabId: currentTab.id },
                function: toggleHighlight,
                args: [fontFamily, tags, highlight]
            });
        } catch (error) {
            console.error('Error highlighting elements:', error);
        }
    }

    async function highlightAndScrollTo(fontFamily, tags) {
        try {
            if (!currentTab) return;

            await chrome.scripting.executeScript({
                target: { tabId: currentTab.id },
                function: highlightAndScroll,
                args: [fontFamily, tags]
            });
        } catch (error) {
            console.error('Error highlighting elements:', error);
        }
    }

    // Inspector toggle
    inspectToggle.addEventListener('click', async () => {
        isInspectorActive = !isInspectorActive;
        inspectToggle.classList.toggle('active', isInspectorActive);

        try {
            if (!currentTab) return;

            if (isInspectorActive) {
                await chrome.scripting.executeScript({
                    target: { tabId: currentTab.id },
                    function: enableInspectorMode
                });
            } else {
                await chrome.scripting.executeScript({
                    target: { tabId: currentTab.id },
                    function: disableInspectorMode
                });
            }
        } catch (error) {
            console.error('Error toggling inspector:', error);
        }
    });

    function showNoAccessMessage() {
        fontList.innerHTML = '<div class="no-fonts">Cannot access this page<br><small>Extension doesn\'t work on Chrome internal pages</small></div>';
        fontCountText.textContent = 'No access';
    }

    function showErrorMessage() {
        fontList.innerHTML = '<div class="no-fonts">Error loading fonts</div>';
        fontCountText.textContent = 'Error';
    }
});

// Content script function: Detects fonts grouped by font family with tag breakdown
function detectFontsByElement() {
    const TAG_PRIORITY = { 'h1': 1, 'h2': 2, 'h3': 3, 'h4': 4, 'h5': 5, 'h6': 6, 'p': 7, 'span': 8, 'a': 9, 'li': 10, 'div': 11 };
    const fontMap = new Map();
    const textElements = document.querySelectorAll('h1, h2, h3, h4, h5, h6, p, span, div, a, li, td, th, label, button');

    textElements.forEach(element => {
        const computedStyle = window.getComputedStyle(element);
        const hasDirectText = Array.from(element.childNodes).some(
            node => node.nodeType === Node.TEXT_NODE && node.textContent.trim().length > 0
        );

        if (hasDirectText && computedStyle.fontFamily) {
            const fontFamily = computedStyle.fontFamily;
            const tagName = element.tagName.toLowerCase();

            if (!fontMap.has(fontFamily)) {
                fontMap.set(fontFamily, {
                    font: fontFamily,
                    displayName: fontFamily.split(',')[0].replace(/['"]/g, '').trim(),
                    tagCounts: new Map(),
                    totalCount: 0
                });
            }

            const entry = fontMap.get(fontFamily);
            entry.tagCounts.set(tagName, (entry.tagCounts.get(tagName) || 0) + 1);
            entry.totalCount++;
        }
    });

    // Convert to array and format
    const groups = Array.from(fontMap.values()).map(group => {
        const tags = Array.from(group.tagCounts.entries())
            .map(([name, count]) => ({ name, count }))
            .sort((a, b) => {
                const aPriority = TAG_PRIORITY[a.name] || 999;
                const bPriority = TAG_PRIORITY[b.name] || 999;
                return aPriority - bPriority;
            });

        return {
            font: group.font,
            displayName: group.displayName,
            tags: tags,
            totalCount: group.totalCount
        };
    });

    // Sort groups: those with headings first, then by total count
    groups.sort((a, b) => {
        const aHasHeading = a.tags.some(t => t.name.match(/^h[1-6]$/));
        const bHasHeading = b.tags.some(t => t.name.match(/^h[1-6]$/));

        if (aHasHeading && !bHasHeading) return -1;
        if (!aHasHeading && bHasHeading) return 1;

        return b.totalCount - a.totalCount;
    });

    return groups;
}

// Content script function: Toggle element highlighting
function toggleHighlight(fontFamily, tags, highlight) {
    const existingHighlights = document.querySelectorAll('.wff-highlight');
    existingHighlights.forEach(el => el.remove());

    if (!highlight) return;

    const selector = tags.join(', ');
    const elements = document.querySelectorAll(selector);

    elements.forEach(element => {
        const computedStyle = window.getComputedStyle(element);
        if (computedStyle.fontFamily !== fontFamily) return;

        const hasDirectText = Array.from(element.childNodes).some(
            node => node.nodeType === Node.TEXT_NODE && node.textContent.trim().length > 0
        );
        if (!hasDirectText) return;

        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return;

        const highlightEl = document.createElement('div');
        highlightEl.className = 'wff-highlight';
        highlightEl.style.cssText = `
            position: fixed;
            top: ${rect.top}px;
            left: ${rect.left}px;
            width: ${rect.width}px;
            height: ${rect.height}px;
            background-color: rgba(0, 122, 204, 0.12);
            border: 2px solid rgba(0, 122, 204, 0.6);
            pointer-events: none;
            z-index: 999999;
            border-radius: 8px;
            box-sizing: border-box;
        `;
        document.body.appendChild(highlightEl);
    });
}

// Content script function: Highlight and scroll to first element
function highlightAndScroll(fontFamily, tags) {
    const existingHighlights = document.querySelectorAll('.wff-highlight');
    existingHighlights.forEach(el => el.remove());

    const selector = tags.join(', ');
    const elements = document.querySelectorAll(selector);
    let firstElement = null;

    elements.forEach(element => {
        const computedStyle = window.getComputedStyle(element);
        if (computedStyle.fontFamily !== fontFamily) return;

        const hasDirectText = Array.from(element.childNodes).some(
            node => node.nodeType === Node.TEXT_NODE && node.textContent.trim().length > 0
        );
        if (!hasDirectText) return;

        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return;

        // Track first visible element for scrolling
        if (!firstElement) {
            firstElement = element;
        }

        const highlightEl = document.createElement('div');
        highlightEl.className = 'wff-highlight';
        highlightEl.style.cssText = `
            position: fixed;
            top: ${rect.top}px;
            left: ${rect.left}px;
            width: ${rect.width}px;
            height: ${rect.height}px;
            background-color: rgba(0, 122, 204, 0.15);
            border: 2px solid rgba(0, 122, 204, 0.7);
            pointer-events: none;
            z-index: 999999;
            border-radius: 6px;
            box-sizing: border-box;
        `;
        document.body.appendChild(highlightEl);
    });

    // Scroll to first element with smooth animation
    if (firstElement) {
        firstElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
}

// Content script function: Enable inspector mode (self-contained with inline handlers)
function enableInspectorMode() {
    if (window.wffInspectorActive) return;

    window.wffInspectorActive = true;
    document.body.style.cursor = 'crosshair';

    // Define handlers inline to avoid reference errors
    function onHover(event) {
        const element = event.target;

        // Remove existing highlights and tooltips
        document.querySelectorAll('.wff-hover-highlight, .wff-hover-tooltip').forEach(el => el.remove());

        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return;

        // Create highlight
        const highlight = document.createElement('div');
        highlight.className = 'wff-hover-highlight';
        highlight.style.cssText = `
            position: fixed;
            top: ${rect.top}px;
            left: ${rect.left}px;
            width: ${rect.width}px;
            height: ${rect.height}px;
            border: 2px solid #007acc;
            background-color: rgba(0, 122, 204, 0.06);
            pointer-events: none;
            z-index: 999998;
            border-radius: 8px;
            box-sizing: border-box;
        `;
        document.body.appendChild(highlight);

        // Create tooltip
        const computedStyle = window.getComputedStyle(element);
        const fontFamily = computedStyle.fontFamily || 'sans-serif';
        const fontSize = computedStyle.fontSize || '16px';
        const fontWeight = computedStyle.fontWeight || 'normal';
        const fontStyle = computedStyle.fontStyle || 'normal';
        const lineHeight = computedStyle.lineHeight || 'normal';
        const color = computedStyle.color || 'black';
        const cleanFontName = fontFamily.split(',')[0].replace(/['"]/g, '').trim();
        const tagName = element.tagName.toLowerCase();

        const tooltip = document.createElement('div');
        tooltip.className = 'wff-hover-tooltip';
        tooltip.style.cssText = `
            position: fixed;
            background: #ffffff;
            border: none;
            border-radius: 12px;
            padding: 14px 16px;
            box-shadow: 0 8px 32px rgba(0,0,0,0.12), 0 2px 8px rgba(0,0,0,0.08);
            z-index: 1000000;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            font-size: 12px;
            line-height: 1.5;
            max-width: 260px;
            pointer-events: none;
            color: #3c3c3c;
        `;

        tooltip.innerHTML = `
            <div style="font-weight: 600; margin-bottom: 8px; color: #007acc; font-size: 13px;">&lt;${tagName}&gt;</div>
            <div style="color: #3c3c3c; margin-bottom: 3px;"><strong style="color: #555;">Font:</strong> ${cleanFontName}</div>
            <div style="color: #3c3c3c; margin-bottom: 3px;"><strong style="color: #555;">Size:</strong> ${fontSize}</div>
            <div style="color: #3c3c3c; margin-bottom: 3px;"><strong style="color: #555;">Weight:</strong> ${fontWeight}</div>
            <div style="color: #3c3c3c; margin-bottom: 3px;"><strong style="color: #555;">Style:</strong> ${fontStyle}</div>
            <div style="color: #3c3c3c; margin-bottom: 3px;"><strong style="color: #555;">Line Height:</strong> ${lineHeight}</div>
            <div style="color: #3c3c3c;"><strong style="color: #555;">Color:</strong> <span style="display: inline-block; width: 12px; height: 12px; background: ${color}; border-radius: 2px; vertical-align: middle; margin-right: 4px; border: 1px solid #ddd;"></span>${color}</div>
        `;

        // Position tooltip
        let top = rect.bottom + 8;
        let left = rect.left;

        if (left + 250 > window.innerWidth) left = window.innerWidth - 260;
        if (left < 10) left = 10;
        if (top + 150 > window.innerHeight) top = rect.top - 158;

        tooltip.style.top = top + 'px';
        tooltip.style.left = left + 'px';

        document.body.appendChild(tooltip);
    }

    function onOut() {
        document.querySelectorAll('.wff-hover-highlight, .wff-hover-tooltip').forEach(el => el.remove());
    }

    function onKeyDown(event) {
        if (event.key === 'Escape') {
            window.wffInspectorActive = false;
            document.body.style.cursor = '';
            document.removeEventListener('mouseover', window.wffInspectorHandlers.mouseover, true);
            document.removeEventListener('mouseout', window.wffInspectorHandlers.mouseout, true);
            document.removeEventListener('keydown', window.wffInspectorHandlers.keydown, true);
            document.querySelectorAll('.wff-hover-highlight, .wff-hover-tooltip').forEach(el => el.remove());
            window.wffInspectorHandlers = null;
        }
    }

    window.wffInspectorHandlers = {
        mouseover: onHover,
        mouseout: onOut,
        keydown: onKeyDown
    };

    document.addEventListener('mouseover', window.wffInspectorHandlers.mouseover, true);
    document.addEventListener('mouseout', window.wffInspectorHandlers.mouseout, true);
    document.addEventListener('keydown', window.wffInspectorHandlers.keydown, true);
}

// Content script function: Disable inspector mode
function disableInspectorMode() {
    if (!window.wffInspectorActive) return;

    window.wffInspectorActive = false;
    document.body.style.cursor = '';

    if (window.wffInspectorHandlers) {
        document.removeEventListener('mouseover', window.wffInspectorHandlers.mouseover, true);
        document.removeEventListener('mouseout', window.wffInspectorHandlers.mouseout, true);
        document.removeEventListener('keydown', window.wffInspectorHandlers.keydown, true);
        window.wffInspectorHandlers = null;
    }

    document.querySelectorAll('.wff-hover-highlight, .wff-hover-tooltip').forEach(el => el.remove());
}
