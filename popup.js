document.addEventListener('DOMContentLoaded', async () => {
    const fontList = document.getElementById('font-list');
    const fontCountText = document.getElementById('font-count-text');
    const inspectToggle = document.getElementById('inspect-toggle');

    let currentTab = null;
    let isInspectorActive = false;

    // Background detects popup close via port disconnect and runs cleanup
    chrome.runtime.connect({ name: 'popup' });

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

        // Add click events for tag chips to highlight + show copy bar
        document.querySelectorAll('.tag-chip').forEach(chip => {
            chip.addEventListener('click', async (e) => {
                e.stopPropagation();
                const tag = chip.dataset.tag;
                const font = decodeURIComponent(chip.dataset.font);

                // Toggle active state
                const wasActive = chip.classList.contains('active');
                document.querySelectorAll('.tag-chip').forEach(c => c.classList.remove('active'));
                document.querySelectorAll('.copy-bar').forEach(el => el.remove());

                if (!wasActive) {
                    chip.classList.add('active');
                    await highlightAndScrollTo(font, [tag]);

                    // Fetch computed styles from the page
                    const styles = await fetchElementStyles(font, tag);
                    if (styles) {
                        const cssText = formatCssText(styles);
                        const fontGroup = chip.closest('.font-group');
                        const copyBar = document.createElement('div');
                        copyBar.className = 'copy-bar';
                        const letterSpacingMetric = styles.letterSpacing !== 'normal'
                            ? `<div class="metric"><span class="metric-label">Spacing</span><span class="metric-value">${styles.letterSpacing}</span></div>` : '';

                        copyBar.innerHTML = `
                            <div class="style-metrics">
                                <div class="metric"><span class="metric-label">Size</span><span class="metric-value">${styles.fontSize}</span></div>
                                <div class="metric"><span class="metric-label">Weight</span><span class="metric-value">${styles.fontWeight}</span></div>
                                <div class="metric"><span class="metric-label">Line Height</span><span class="metric-value">${styles.lineHeight}</span></div>
                                <div class="metric"><span class="metric-label">Color</span><span class="metric-value"><span class="color-swatch" style="background:${styles.color}"></span>${styles.color}</span></div>
                                ${styles.fontStyle !== 'normal' ? `<div class="metric"><span class="metric-label">Style</span><span class="metric-value">${styles.fontStyle}</span></div>` : ''}
                                ${letterSpacingMetric}
                            </div>
                            <button class="copy-css-btn">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                                Copy CSS
                            </button>
                        `;
                        fontGroup.appendChild(copyBar);

                        copyBar.querySelector('.copy-css-btn').addEventListener('click', async (ce) => {
                            ce.stopPropagation();
                            await navigator.clipboard.writeText(cssText);
                            const btn = copyBar.querySelector('.copy-css-btn');
                            btn.classList.add('copied');
                            btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg> Copied!';
                            setTimeout(() => {
                                btn.classList.remove('copied');
                                btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg> Copy CSS';
                            }, 1500);
                        });
                    }
                } else {
                    highlightElements(font, [tag], false);
                }
            });
        });

        // Add hover events for font groups
        document.querySelectorAll('.font-group').forEach(group => {
            group.addEventListener('mouseenter', () => {
                if (group.querySelector('.tag-chip.active')) return;
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

    async function fetchElementStyles(fontFamily, tag) {
        try {
            if (!currentTab) return null;
            const results = await chrome.scripting.executeScript({
                target: { tabId: currentTab.id },
                function: getComputedFontStyles,
                args: [fontFamily, tag]
            });
            return results[0].result;
        } catch (error) {
            console.error('Error fetching styles:', error);
            return null;
        }
    }

    function formatCssText(styles) {
        const lines = [
            `font-family: ${styles.fontFamily};`,
            `font-size: ${styles.fontSize};`,
            `font-weight: ${styles.fontWeight};`,
            `font-style: ${styles.fontStyle};`,
            `line-height: ${styles.lineHeight};`,
            `color: ${styles.color};`
        ];
        if (styles.letterSpacing !== 'normal') {
            lines.push(`letter-spacing: ${styles.letterSpacing};`);
        }
        return lines.join('\n');
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

// Content script function: Get computed font styles for first matching element
function getComputedFontStyles(fontFamily, tag) {
    const elements = document.querySelectorAll(tag);
    for (const element of elements) {
        const computedStyle = window.getComputedStyle(element);
        if (computedStyle.fontFamily !== fontFamily) continue;
        const hasDirectText = Array.from(element.childNodes).some(
            node => node.nodeType === Node.TEXT_NODE && node.textContent.trim().length > 0
        );
        if (!hasDirectText) continue;
        return {
            fontFamily: computedStyle.fontFamily,
            fontSize: computedStyle.fontSize,
            fontWeight: computedStyle.fontWeight,
            fontStyle: computedStyle.fontStyle,
            lineHeight: computedStyle.lineHeight,
            letterSpacing: computedStyle.letterSpacing,
            color: computedStyle.color
        };
    }
    return null;
}

// Content script function: Toggle element highlighting
function toggleHighlight(fontFamily, tags, highlight) {
    document.querySelectorAll('.wff-highlight').forEach(el => el.remove());
    document.querySelectorAll('.wff-anchored').forEach(el => {
        el.style.anchorName = '';
        el.classList.remove('wff-anchored');
    });

    if (!highlight) return;

    const selector = tags.join(', ');
    const elements = document.querySelectorAll(selector);
    let i = 0;

    elements.forEach(element => {
        const computedStyle = window.getComputedStyle(element);
        if (computedStyle.fontFamily !== fontFamily) return;

        const hasDirectText = Array.from(element.childNodes).some(
            node => node.nodeType === Node.TEXT_NODE && node.textContent.trim().length > 0
        );
        if (!hasDirectText) return;

        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return;

        const anchor = `--wff-a-${i++}`;
        element.style.anchorName = anchor;
        element.classList.add('wff-anchored');

        const highlightEl = document.createElement('div');
        highlightEl.className = 'wff-highlight';
        highlightEl.style.cssText = `
            position: absolute;
            position-anchor: ${anchor};
            top: anchor(top);
            left: anchor(left);
            width: anchor-size(width);
            height: anchor-size(height);
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
    document.querySelectorAll('.wff-highlight').forEach(el => el.remove());
    document.querySelectorAll('.wff-anchored').forEach(el => {
        el.style.anchorName = '';
        el.classList.remove('wff-anchored');
    });

    const selector = tags.join(', ');
    const elements = document.querySelectorAll(selector);
    let firstElement = null;
    let i = 0;

    elements.forEach(element => {
        const computedStyle = window.getComputedStyle(element);
        if (computedStyle.fontFamily !== fontFamily) return;

        const hasDirectText = Array.from(element.childNodes).some(
            node => node.nodeType === Node.TEXT_NODE && node.textContent.trim().length > 0
        );
        if (!hasDirectText) return;

        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return;

        if (!firstElement) {
            firstElement = element;
        }

        const anchor = `--wff-a-${i++}`;
        element.style.anchorName = anchor;
        element.classList.add('wff-anchored');

        const highlightEl = document.createElement('div');
        highlightEl.className = 'wff-highlight';
        highlightEl.style.cssText = `
            position: absolute;
            position-anchor: ${anchor};
            top: anchor(top);
            left: anchor(left);
            width: anchor-size(width);
            height: anchor-size(height);
            background-color: rgba(0, 122, 204, 0.15);
            border: 2px solid rgba(0, 122, 204, 0.7);
            pointer-events: none;
            z-index: 999999;
            border-radius: 6px;
            box-sizing: border-box;
        `;
        document.body.appendChild(highlightEl);
    });

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
            <div style="color: #3c3c3c; margin-bottom: 0;"><strong style="color: #555;">Color:</strong> <span style="display: inline-block; width: 12px; height: 12px; background: ${color}; border-radius: 2px; vertical-align: middle; margin-right: 4px; border: 1px solid #ddd;"></span>${color}</div>
            <div style="margin-top: 8px; padding-top: 6px; border-top: 1px solid #f0f0f0; font-size: 10px; color: #aaa; text-align: center;">Click to copy CSS</div>
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

    function onClick(event) {
        event.preventDefault();
        event.stopPropagation();

        const element = event.target;
        const computedStyle = window.getComputedStyle(element);

        const css = [
            `font-family: ${computedStyle.fontFamily};`,
            `font-size: ${computedStyle.fontSize};`,
            `font-weight: ${computedStyle.fontWeight};`,
            `font-style: ${computedStyle.fontStyle};`,
            `line-height: ${computedStyle.lineHeight};`,
            `color: ${computedStyle.color};`
        ];

        if (computedStyle.letterSpacing !== 'normal') {
            css.push(`letter-spacing: ${computedStyle.letterSpacing};`);
        }

        navigator.clipboard.writeText(css.join('\n'));

        // Show toast feedback
        document.querySelectorAll('.wff-copy-toast').forEach(el => el.remove());
        const toast = document.createElement('div');
        toast.className = 'wff-copy-toast';
        toast.textContent = 'CSS copied!';
        toast.style.cssText = `
            position: fixed;
            bottom: 24px;
            left: 50%;
            transform: translateX(-50%);
            background: #1a1a1a;
            color: white;
            padding: 10px 20px;
            border-radius: 10px;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            font-size: 13px;
            font-weight: 500;
            z-index: 1000001;
            box-shadow: 0 8px 32px rgba(0,0,0,0.2);
            pointer-events: none;
            opacity: 1;
            transition: opacity 0.3s ease;
        `;
        document.body.appendChild(toast);
        setTimeout(() => { toast.style.opacity = '0'; }, 1200);
        setTimeout(() => toast.remove(), 1500);
    }

    function onKeyDown(event) {
        if (event.key === 'Escape') {
            window.wffInspectorActive = false;
            document.body.style.cursor = '';
            document.removeEventListener('mouseover', window.wffInspectorHandlers.mouseover, true);
            document.removeEventListener('mouseout', window.wffInspectorHandlers.mouseout, true);
            document.removeEventListener('click', window.wffInspectorHandlers.click, true);
            document.removeEventListener('keydown', window.wffInspectorHandlers.keydown, true);
            document.querySelectorAll('.wff-hover-highlight, .wff-hover-tooltip, .wff-copy-toast').forEach(el => el.remove());
            window.wffInspectorHandlers = null;
        }
    }

    window.wffInspectorHandlers = {
        mouseover: onHover,
        mouseout: onOut,
        click: onClick,
        keydown: onKeyDown
    };

    document.addEventListener('mouseover', window.wffInspectorHandlers.mouseover, true);
    document.addEventListener('mouseout', window.wffInspectorHandlers.mouseout, true);
    document.addEventListener('click', window.wffInspectorHandlers.click, true);
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
        document.removeEventListener('click', window.wffInspectorHandlers.click, true);
        document.removeEventListener('keydown', window.wffInspectorHandlers.keydown, true);
        window.wffInspectorHandlers = null;
    }

    document.querySelectorAll('.wff-hover-highlight, .wff-hover-tooltip, .wff-copy-toast').forEach(el => el.remove());
}
